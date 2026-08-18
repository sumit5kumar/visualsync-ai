import { afterEach, describe, expect, it, vi } from "vitest";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqClient } from "./groqClient";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

describe("GroqClient", () => {
  it("verifies a key through the active-models endpoint with a header-only credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: GROQ_TRANSCRIPTION_MODEL }, { id: GROQ_VISION_MODEL }] }), { status: 200 }));
    global.fetch = fetchMock;

    const result = await new GroqClient("gsk_test_key_that_must_not_be_in_a_url").testKey();

    expect(result.status).toBe("verified");
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect(request.headers).toMatchObject({ Authorization: "Bearer gsk_test_key_that_must_not_be_in_a_url" });
    expect(url).not.toContain("gsk_");
  });

  it("submits image analysis without the rejected JSON response mode and parses generated JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"sceneDescription":"hourglass"}\n```' } }] }), { status: 200 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").analyzeImage({ imageUrl: "https://example.test/image.jpg", prompt: "Describe this scene as JSON." })).resolves.toEqual({ sceneDescription: "hourglass" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ model: GROQ_VISION_MODEL, reasoning_effort: "none", reasoning_format: "hidden" });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("response_format");
  });

  it("returns compact text completion without forcing JSON mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "CHOICE=2;CONFIDENCE=0.92" } }] }), { status: 200 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").completeText({ prompt: "Choose one image." })).resolves.toBe("CHOICE=2;CONFIDENCE=0.92");

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(JSON.parse(String(request.body))).toMatchObject({ model: GROQ_VISION_MODEL });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("response_format");
  });

  it("uses compatibility-safe text completion for a machine-readable pacing plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"weights":[1.2,0.8]}\n```' } }] }), { status: 200 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").completePacingPlan({ prompt: "Return a JSON pacing plan." })).resolves.toEqual({ weights: [1.2, 0.8] });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ model: GROQ_VISION_MODEL, reasoning_effort: "none", reasoning_format: "hidden", max_completion_tokens: 500 });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("response_format");
  });

  it("reports prompt-size rejections without classifying the key as quota limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Request too large for model" } }), { status: 429 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").completeText({ prompt: "large" })).rejects.toMatchObject({ status: "request_too_large" });
  });

  it("keeps a non-auth client rejection out of the retry pool and redacts secure URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid URL https://storage.example.test/private?signature=secret" } }), { status: 400 }));
    global.fetch = fetchMock;

    const request = new GroqClient("gsk_test").transcribeAudio({ url: "https://storage.example.test/narration.mp3" });

    await expect(request).rejects.toMatchObject({ status: "prompt_error", message: "Groq rejected this request: Invalid URL [secure URL]" });
  });

  it("converts a native transcription fetch failure into a rotation-safe unavailable error without leaking details", async () => {
    const rawTransportDetail = "gsk_transport_failure_must_not_surface";
    global.fetch = vi.fn().mockRejectedValue(new TypeError(`fetch failed: ${rawTransportDetail}`));

    const request = new GroqClient("gsk_test").transcribeAudio({ bytes: new Uint8Array([1, 2, 3]), filename: "narration.mp3", mimeType: "audio/mpeg" });

    await expect(request).rejects.toMatchObject({ status: "unavailable", message: "Groq could not be reached for this request." });
    await request.catch(error => expect(error.message).not.toContain(rawTransportDetail));
  });

  it("uses a secure remote audio URL instead of a multipart attachment when one is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Narration", segments: [] }), { status: 200 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").transcribeAudio({ url: "https://storage.example.test/signed-narration.mp3", language: "hi" })).resolves.toMatchObject({ text: "Narration" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = request.body as FormData;
    expect(body.get("url")).toBe("https://storage.example.test/signed-narration.mp3");
    expect(body.get("file")).toBeNull();
    expect(body.get("model")).toBe(GROQ_TRANSCRIPTION_MODEL);
  });
});
