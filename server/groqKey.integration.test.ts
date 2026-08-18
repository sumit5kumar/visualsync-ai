import { describe, expect, it } from "vitest";

describe.runIf(process.env.RUN_LIVE_GROQ_TESTS === "1")("Groq Cloud server credential", () => {
  it("authenticates against the official active-models endpoint without exposing the key", async () => {
    const apiKey = process.env.GROQ_API_KEY;
    expect(apiKey, "GROQ_API_KEY must be available only to server-side tests").toMatch(/^gsk_[A-Za-z0-9_-]{20,}$/);

    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;

    expect(response.ok, "Groq rejected the configured server credential").toBe(true);
    expect(payload?.data?.some(model => model.id === "whisper-large-v3"), "Groq did not return the supported multilingual transcription model").toBe(true);
  }, 30_000);
});
