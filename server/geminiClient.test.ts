import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_INTERACTIONS_ENDPOINT,
  GEMINI_MODEL,
  GeminiClient,
  buildInteractionRequest,
  extractInteractionText,
} from "./geminiClient";

describe("Gemini Interactions client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the supported Flash alias and Interactions API endpoint", () => {
    expect(GEMINI_MODEL).toBe("gemini-flash-latest");
    expect(GEMINI_INTERACTIONS_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  });

  it("builds a stateless minimal key-test interaction without exposing the key in a URL", () => {
    const request = buildInteractionRequest(GEMINI_MODEL, "Respond with exactly OK.");
    expect(request).toEqual({
      model: "gemini-flash-latest",
      input: "Respond with exactly OK.",
      store: false,
      generation_config: { max_output_tokens: 1024 },
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
