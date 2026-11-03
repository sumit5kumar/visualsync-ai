import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_RETRY_POLICY,
  GEMINI_FALLBACK_MODEL,
  GEMINI_INTERACTIONS_ENDPOINT,
  GEMINI_MODEL,
  GeminiClient,
  GeminiRequestError,
  buildInteractionRequest,
  classifyGeminiError,
  extractInteractionText,
  geminiBackoffDelayMs,
  isTransientGeminiFailure,
  parseGeminiRetryDelayMs,
} from "./geminiClient";

describe("Gemini Interactions client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the supported Flash-Lite alias and Interactions API endpoint", () => {
    expect(GEMINI_MODEL).toBe("gemini-flash-lite-latest");
    expect(GEMINI_INTERACTIONS_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  });

  it("builds a stateless minimal key-test interaction without exposing the key in a URL", () => {
    const request = buildInteractionRequest(GEMINI_MODEL, "Respond with exactly OK.");
    expect(request).toEqual({
      model: "gemini-flash-lite-latest",
      input: "Respond with exactly OK.",
      store: false,
      generation_config: { max_output_tokens: 1024, thinking_level: "low", thinking_summaries: "none" },
    });
  });

  it("uses typed multimedia content and JSON response formatting for analysis", () => {
    const request = buildInteractionRequest(
      GEMINI_MODEL,
      "Analyze this image.",
      [{ mimeType: "image/jpeg", dataBase64: "abc" }],
      true,
    );
    expect(request.input).toEqual([
      { type: "text", text: "Analyze this image." },
      { type: "image", mime_type: "image/jpeg", data: "abc" },
    ]);
    expect(request.response_format).toMatchObject({ type: "text", mime_type: "application/json" });
  });

  it("reads response text from model_output interaction steps", () => {
    expect(extractInteractionText({ steps: [{ type: "model_output", content: [{ type: "text", text: "OK" }] }] })).toBe("OK");
  });

  it("sends a real key-validation request through the Interactions endpoint with the key in a header only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "OK" }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await new GeminiClient("AIza-test-key").testKey();

    expect(result.status).toBe("verified");
  });

  it("reports an incomplete interaction distinctly when the model exhausts its output budget", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "incomplete" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const result = await new GeminiClient("AIza-test-key").testKey();

    expect(result).toEqual({
      status: "unavailable",
      message: "Gemini did not complete the interaction before its output budget was exhausted. Please retry.",
    });
  });

  it("sends key in header only, not in the URL", async () => {
    const requestSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "OK" }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", requestSpy);

    const result = await new GeminiClient("AIza-test-key").testKey();

    expect(result.status).toBe("verified");
    expect(requestSpy).toHaveBeenCalledWith(GEMINI_INTERACTIONS_ENDPOINT, expect.objectContaining({
      headers: expect.objectContaining({ "x-goog-api-key": "AIza-test-key" }),
    }));
    expect(String(requestSpy.mock.calls[0][0])).not.toContain("AIza-test-key");
  });
});

describe("Gemini 503 stability policy", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = (text = "OK") => new Response(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const fail = (status: number, body: unknown = { error: { message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const requestedModel = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)).model as string;

  it("retries transient 503s before marking a valid key busy on the Test button", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchSpy);
    const client = new GeminiClient("AIza-test-key", GEMINI_MODEL, { sleep: async () => undefined });
    const result = await client.testKey();
    // Two transient 503s then a healthy answer: the key is verified, not busy.
    expect(result.status).toBe("verified");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("reports busy servers without rejecting the key when every test attempt hits a 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => fail(503)));
    const client = new GeminiClient("AIza-test-key", GEMINI_MODEL, { sleep: async () => undefined });
    const result = await client.testKey();
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/NOT rejected/);
  });

  it("surfaces a retryable server_error with Groq-compatible metadata for hosted job backoff", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => fail(503, { error: { message: "high demand", status: "UNAVAILABLE" } }, { "retry-after": "3" })));
    const client = new GeminiClient("AIza-test-key", GEMINI_MODEL, { sleep: async () => undefined, retryPolicy: { fallbackModel: null, maxAttemptsPerModel: 2 } });
    const error = await client.generateJson("x").catch(caught => caught);
    expect(error).toBeInstanceOf(GeminiRequestError);
    expect(error.metadata).toMatchObject({ httpStatus: 503, category: "server_error", retryAfterMs: 3_000 });
    expect(isTransientGeminiFailure(error)).toBe(true);
  });

  it("throws 429 immediately (no in-client retry) with the RetryInfo delay so the pool can cool the key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fail(429, { error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }] } }));
    vi.stubGlobal("fetch", fetchSpy);
    const error = await new GeminiClient("AIza-test-key", GEMINI_MODEL, { sleep: async () => undefined }).generateJson("x").catch(caught => caught);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error.status).toBe("quota_limited");
    expect(error.metadata).toMatchObject({ httpStatus: 429, category: "rate_limited", retryAfterMs: 17_000 });
  });

  it("classifies Gemini's 400 API_KEY_INVALID as an invalid key", () => {
    const error = classifyGeminiError(400, { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, null, 5, GEMINI_MODEL);
    expect(error.status).toBe("invalid");
  });

  it("keeps the primary 503 when the fallback alias is missing (404)", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(fail(404, { error: { message: "model not found", status: "NOT_FOUND" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = new GeminiClient("AIza-test-key", GEMINI_MODEL, { sleep: async () => undefined, retryPolicy: { maxAttemptsPerModel: 1 } });
    const error = await client.generateJson("x").catch(caught => caught);
    expect(error.metadata.category).toBe("server_error");
  });

  it("computes jittered exponential backoff capped by policy and honors provider delays", () => {
    expect(geminiBackoffDelayMs(1, DEFAULT_GEMINI_RETRY_POLICY, undefined, () => 0)).toBe(500);
    expect(geminiBackoffDelayMs(5, DEFAULT_GEMINI_RETRY_POLICY, undefined, () => 1)).toBe(8_000);
    expect(geminiBackoffDelayMs(1, DEFAULT_GEMINI_RETRY_POLICY, 2_500)).toBe(2_500);
    expect(parseGeminiRetryDelayMs("1.5s")).toBe(1_500);
  });
});
