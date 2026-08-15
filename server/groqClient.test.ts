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

  it("submits image analysis to Groq’s vision model in JSON mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"sceneDescription":"hourglass"}' } }] }), { status: 200 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").analyzeImage({ imageUrl: "https://example.test/image.jpg", prompt: "Describe this scene as JSON." })).resolves.toEqual({ sceneDescription: "hourglass" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ model: GROQ_VISION_MODEL, response_format: { type: "json_object" } });
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

  it("reports prompt-size rejections without classifying the key as quota limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Request too large for model" } }), { status: 429 }));
    global.fetch = fetchMock;

    await expect(new GroqClient("gsk_test").completeText({ prompt: "large" })).rejects.toMatchObject({ status: "request_too_large" });
  });
});
