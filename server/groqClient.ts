export const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";
export const GROQ_VISION_MODEL = "qwen/qwen3.6-27b";

export type GroqKeyStatus = "verified" | "invalid" | "quota_limited" | "request_too_large" | "prompt_error" | "unavailable";
export type GroqKeyTestResult = { status: GroqKeyStatus; message: string };

export class GroqRequestError extends Error {
  constructor(message: string, readonly status: GroqKeyStatus) { super(message); }
}

function classifyGroqError(statusCode: number, message: string) {
  if (statusCode === 401 || statusCode === 403) return new GroqRequestError("Groq rejected this API key.", "invalid");
  if (/request too large|requested \d+|reduce your message size|tokens per minute/i.test(message)) return new GroqRequestError("The Groq request is too large for the selected model limit. Reduce the prompt payload and retry with the same eligible key pool.", "request_too_large");
  if (/failed to validate json|failed_generation|adjust your prompt/i.test(message)) return new GroqRequestError("Groq rejected the requested JSON response format. Adjust the prompt and retry with the same eligible key pool.", "prompt_error");
  if (statusCode === 429) return new GroqRequestError("This Groq API key has reached a quota or rate limit.", "quota_limited");
  return new GroqRequestError(message || "Groq is currently unavailable.", "unavailable");
}

function parseGeneratedJsonObject(content: string, malformedMessage: string) {
  const objectText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").match(/\{[\s\S]*\}/)?.[0];
  if (!objectText) throw new GroqRequestError(malformedMessage, "prompt_error");
  try { return JSON.parse(objectText) as unknown; } catch { throw new GroqRequestError(malformedMessage, "prompt_error"); }
}

export class GroqClient {
  constructor(private readonly apiKey: string) {}

  private headers(contentType?: string) {
    return { Authorization: `Bearer ${this.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) };
  }

  private async request(url: string, init: RequestInit) {
    try {
      return await fetch(url, init);
    } catch {
      // Native fetch failures (for example, a temporary upstream socket reset) do not
      // have an HTTP status. Convert them into the state understood by the rotation
      // pool so it can cool down this key and try the next eligible one.
      throw new GroqRequestError("Groq could not be reached for this request.", "unavailable");
    }
  }

  async testKey(): Promise<GroqKeyTestResult> {
    try {
      const response = await this.request(`${GROQ_API_BASE_URL}/models`, { headers: this.headers("application/json"), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw classifyGroqError(response.status, payload?.error?.message ?? "");
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      if (!payload.data?.some(model => model.id === GROQ_TRANSCRIPTION_MODEL) || !payload.data.some(model => model.id === GROQ_VISION_MODEL)) throw new GroqRequestError("Groq key verified, but this account does not expose the required transcription and vision models.", "unavailable");
      return { status: "verified", message: `Groq API key verified with ${GROQ_TRANSCRIPTION_MODEL} and ${GROQ_VISION_MODEL}.` };
    } catch (error) {
      if (error instanceof GroqRequestError) return { status: error.status, message: error.message };
      return { status: "unavailable", message: "Groq could not be reached for this key test." };
    }
  }

  async transcribeAudio(input: { bytes?: Uint8Array; filename?: string; mimeType?: string; url?: string; language?: string; prompt?: string }) {
    const body = new FormData();
    if (input.url) {
      body.append("url", input.url);
    } else if (input.bytes && input.filename && input.mimeType) {
      const fileBytes = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
      body.append("file", new Blob([fileBytes], { type: input.mimeType }), input.filename);
    } else {
      throw new GroqRequestError("Provide a secure audio URL or a complete audio attachment for Groq transcription.", "unavailable");
    }
    body.append("model", GROQ_TRANSCRIPTION_MODEL);
    body.append("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "segment");
    if (input.language) body.append("language", input.language);
    if (input.prompt) body.append("prompt", input.prompt);
    const response = await this.request(`${GROQ_API_BASE_URL}/audio/transcriptions`, { method: "POST", headers: this.headers(), body, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response.status, payload?.error?.message ?? "");
    }
    return response.json() as Promise<{ text: string; language?: string; segments?: Array<{ id?: number; start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }> }>;
  }

  async analyzeImage(input: { imageUrl: string; prompt: string }) {
    const response = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        temperature: 0,
        max_completion_tokens: 600,
        reasoning_effort: "none",
        reasoning_format: "hidden",
        messages: [{ role: "user", content: [{ type: "text", text: `${input.prompt}\nReply with exactly one compact JSON object and no markdown.` }, { type: "image_url", image_url: { url: input.imageUrl, detail: "low" } }] }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response.status, payload?.error?.message ?? "");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new GroqRequestError("Groq returned no usable vision content.", "unavailable");
    return parseGeneratedJsonObject(content, "Groq returned malformed vision JSON.");
  }

  async completeText(input: { prompt: string }) {
    const response = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, messages: [{ role: "user", content: input.prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response.status, payload?.error?.message ?? "");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new GroqRequestError("Groq returned no usable timeline-selection content.", "unavailable");
    return content;
  }

  async completeJson(input: { prompt: string }) {
    const response = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", response_format: { type: "json_object" }, messages: [{ role: "user", content: input.prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response.status, payload?.error?.message ?? "");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new GroqRequestError("Groq returned no usable structured timeline content.", "unavailable");
    try { return JSON.parse(content) as unknown; } catch { throw new GroqRequestError("Groq returned malformed timeline-selection JSON.", "prompt_error"); }
  }

  async completePacingPlan(input: { prompt: string }) {
    const response = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: input.prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response.status, payload?.error?.message ?? "");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new GroqRequestError("Groq returned no usable pacing content.", "unavailable");
    return parseGeneratedJsonObject(content, "Groq returned malformed pacing JSON.");
  }
}
