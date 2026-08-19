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

  it("requires both a real Whisper transcription probe and an image-analysis/pacing model probe before project verification succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "probe", segments: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    global.fetch = fetchMock;

    const result = await new GroqClient("gsk_project_probe").verifyProjectModels();

    expect(result).toMatchObject({ status: "verified", transcription: { ok: true, status: "verified" }, generation: { ok: true, status: "verified" } });
    const [transcriptionUrl, transcriptionRequest] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(transcriptionUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((transcriptionRequest.body as FormData).get("model")).toBe(GROQ_TRANSCRIPTION_MODEL);
    const [generationUrl, generationRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(generationUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    const generationBody = JSON.parse(String(generationRequest.body));
    expect(generationBody).toMatchObject({ model: GROQ_VISION_MODEL });
    expect(generationBody.messages[0].content[1].image_url.url).toContain("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ");
  });

  it("does not promote a project key when the real Whisper probe is denied and does not spend a generation-model request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "whisper model blocked" } }), { status: 403 }));
    global.fetch = fetchMock;

    const result = await new GroqClient("gsk_project_probe").verifyProjectModels();

    expect(result).toMatchObject({ status: "permission_restricted", transcription: { ok: false, status: "permission_restricted" }, generation: { ok: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected verification image as a probe-asset error rather than a key or permission failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "probe", segments: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Image must have at least 2 pixels in each dimension" } }), { status: 400 }));
    global.fetch = fetchMock;

    const result = await new GroqClient("gsk_project_probe").verifyProjectModels();

    expect(result).toMatchObject({ status: "unavailable", transcription: { ok: true }, generation: { ok: false, status: "unavailable" } });
    expect(result.message).toContain("probe-asset error");
    expect(result.message).toContain("not an API-key or project-permission failure");
  });

  it("keeps a successful Whisper verification intact and labels a vision-probe timeout truthfully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "probe", segments: [] }), { status: 200 }))
      .mockRejectedValueOnce(new DOMException("Groq request timed out.", "TimeoutError"));
    global.fetch = fetchMock;

    const result = await new GroqClient("gsk_project_probe").verifyProjectModels();

    expect(result).toMatchObject({ status: "unavailable", transcription: { ok: true, status: "verified" }, generation: { ok: false, status: "unavailable", message: "Groq image-analysis/pacing verification probe timed out." } });
    expect(result.message).not.toContain("transcription timed out");
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

  it("records Groq retry guidance and audio-limit metadata without exposing secure media URLs", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "audio quota exceeded for https://private.example.test/audio" } }), { status: 429, headers: { "retry-after": "18", "x-ratelimit-remaining-audio-seconds": "0", "x-ratelimit-reset-audio-seconds": "18s" } }));
    const request = new GroqClient("gsk_test").transcribeAudio({ url: "https://storage.example.test/narration.mp3" });

    await expect(request).rejects.toMatchObject({ status: "quota_limited", metadata: { category: "audio_quota_exhausted", retryAfterMs: 18_000, remainingAudio: "0", resetAudio: "18s" } });
    await request.catch(error => expect(error.message).not.toContain("private.example.test"));
  });

  it("keeps a non-auth client rejection out of the retry pool and redacts secure URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid URL https://storage.example.test/private?signature=secret" } }), { status: 400 }));
    global.fetch = fetchMock;

    const request = new GroqClient("gsk_test").transcribeAudio({ url: "https://storage.example.test/narration.mp3" });

    await expect(request).rejects.toMatchObject({ status: "prompt_error", message: "Groq rejected this request: Invalid URL [secure URL]" });
  });

  it("treats a 403 model-permission response as a configuration blocker without invalidating the API key", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "The model whisper-large-v3 is blocked at the project level." } }), { status: 403 }));

    const request = new GroqClient("gsk_test").transcribeAudio({ bytes: new Uint8Array([1, 2, 3]), filename: "narration.wav", mimeType: "audio/wav" });

    await expect(request).rejects.toMatchObject({ status: "permission_restricted", metadata: { httpStatus: 403, category: "permission_denied" } });
  });

  it("classifies temporary 503 provider failures as retryable unavailable errors", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "provider temporarily unavailable" } }), { status: 503 }));
    await expect(new GroqClient("gsk_test").completeText({ prompt: "health" })).rejects.toMatchObject({ status: "unavailable", metadata: { httpStatus: 503, category: "server_error" } });
  });

  it("converts a native transcription fetch failure into a rotation-safe unavailable error without leaking details", async () => {
    const rawTransportDetail = "gsk_transport_failure_must_not_surface";
    global.fetch = vi.fn().mockRejectedValue(new TypeError(`fetch failed: ${rawTransportDetail}`));

    const request = new GroqClient("gsk_test").transcribeAudio({ bytes: new Uint8Array([1, 2, 3]), filename: "narration.mp3", mimeType: "audio/mpeg" });

    await expect(request).rejects.toMatchObject({ status: "unavailable", message: "Groq could not be reached for this request." });
    await request.catch(error => expect(error.message).not.toContain(rawTransportDetail));
  });

  it("enforces the requested transcription deadline when a provider socket stalls", async () => {
    global.fetch = vi.fn((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
    }));

    const request = new GroqClient("gsk_test").transcribeAudio({ bytes: new Uint8Array([1, 2, 3]), filename: "narration.wav", mimeType: "audio/wav", timeoutMs: 20 });

    await expect(request).rejects.toMatchObject({ status: "unavailable", metadata: { category: "timeout" } });
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

  it("allows the server to extend only a long narration transcription deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Narration", segments: [] }), { status: 200 }));
    global.fetch = fetchMock;

    await new GroqClient("gsk_test").transcribeAudio({ bytes: new Uint8Array([1, 2, 3]), filename: "narration.mp3", mimeType: "audio/mpeg", timeoutMs: 180_000 });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
});
