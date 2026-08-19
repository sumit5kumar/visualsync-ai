export const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";
export const GROQ_VISION_MODEL = "qwen/qwen3.6-27b";

export type GroqKeyStatus = "verified" | "invalid" | "permission_restricted" | "quota_limited" | "request_too_large" | "prompt_error" | "unavailable";
export type GroqKeyTestResult = { status: GroqKeyStatus; message: string };
export type GroqFailureCategory = "invalid_key" | "permission_denied" | "file_too_large" | "rate_limited" | "audio_quota_exhausted" | "timeout" | "network_failure" | "server_error" | "client_request" | "unknown";
export type GroqRequestMetadata = { httpStatus?: number; errorCode?: string; retryAfterMs?: number; remainingRequests?: string; remainingAudio?: string; resetAudio?: string; durationMs: number; category: GroqFailureCategory };
export type GroqTranscript = { text: string; language?: string; segments?: Array<{ id?: number; start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }>; requestMetadata: GroqRequestMetadata };

export class GroqRequestError extends Error {
  constructor(message: string, readonly status: GroqKeyStatus, readonly metadata: GroqRequestMetadata = { durationMs: 0, category: "unknown" }) { super(safeGroqMessage(message)); }
}

function safeGroqMessage(message: string) {
  return message.replace(/gsk_[A-Za-z0-9_-]+/g, "[redacted key]").replace(/https?:\/\/\S+/gi, "[secure URL]").trim();
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function responseMetadata(response: Response, durationMs: number, category: GroqFailureCategory): GroqRequestMetadata {
  return {
    httpStatus: response.status,
    errorCode: response.headers.get("x-request-id") ?? undefined,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    remainingRequests: response.headers.get("x-ratelimit-remaining-requests") ?? undefined,
    remainingAudio: response.headers.get("x-ratelimit-remaining-audio-seconds") ?? undefined,
    resetAudio: response.headers.get("x-ratelimit-reset-audio-seconds") ?? undefined,
    durationMs,
    category,
  };
}

function classifyGroqError(response: Response, message: string, durationMs: number) {
  const statusCode = response.status;
  if (statusCode === 401) return new GroqRequestError("Groq rejected this API key.", "invalid", responseMetadata(response, durationMs, "invalid_key"));
  if (statusCode === 403) {
    const detail = safeGroqMessage(message);
    return new GroqRequestError(`${detail ? `${detail} ` : ""}Groq denied access to the requested model or endpoint. Check the Groq organization and project model permissions before retrying.`, "permission_restricted", responseMetadata(response, durationMs, "permission_denied"));
  }
  if (/media file too large|file too large|size limit|request too large/i.test(message)) return new GroqRequestError("The narration exceeds Groq’s file-size limit. VisualSync will prepare safe audio chunks before retrying.", "request_too_large", responseMetadata(response, durationMs, "file_too_large"));
  if (/failed to validate json|failed_generation|adjust your prompt/i.test(message)) return new GroqRequestError("Groq rejected the requested JSON response format. Adjust the prompt and retry with the same eligible key pool.", "prompt_error", responseMetadata(response, durationMs, "client_request"));
  if (statusCode === 429) {
    const category: GroqFailureCategory = /audio|asr|whisper/i.test(message) ? "audio_quota_exhausted" : "rate_limited";
    return new GroqRequestError(category === "audio_quota_exhausted" ? "Groq audio quota is currently exhausted." : "Groq rate limit reached.", "quota_limited", responseMetadata(response, durationMs, category));
  }
  if (statusCode === 408 || statusCode === 504) return new GroqRequestError("Groq transcription timed out.", "unavailable", responseMetadata(response, durationMs, "timeout"));
  if (statusCode >= 500) return new GroqRequestError("Groq reported a temporary server error.", "unavailable", responseMetadata(response, durationMs, "server_error"));
  if (statusCode >= 400 && statusCode < 500) return new GroqRequestError(`Groq rejected this request${message ? `: ${safeGroqMessage(message)}` : "."}`, "prompt_error", responseMetadata(response, durationMs, "client_request"));
  return new GroqRequestError(safeGroqMessage(message) || "Groq is currently unavailable.", "unavailable", responseMetadata(response, durationMs, "unknown"));
}

function localError(message: string, status: GroqKeyStatus, category: GroqFailureCategory, durationMs = 0) {
  return new GroqRequestError(message, status, { durationMs, category });
}

function parseGeneratedJsonObject(content: string, malformedMessage: string, durationMs = 0) {
  const objectText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").match(/\{[\s\S]*\}/)?.[0];
  if (!objectText) throw localError(malformedMessage, "prompt_error", "client_request", durationMs);
  try { return JSON.parse(objectText) as unknown; } catch { throw localError(malformedMessage, "prompt_error", "client_request", durationMs); }
}

export class GroqClient {
  constructor(private readonly apiKey: string) {}

  private headers(contentType?: string) {
    return { Authorization: `Bearer ${this.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) };
  }

  private async request(url: string, init: RequestInit, timeoutMs = 60_000) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Groq request timed out.", "TimeoutError")), timeoutMs);
    try {
      return { response: await fetch(url, { ...init, signal: controller.signal }), durationMs: Date.now() - startedAt };
    } catch (error) {
      const category: GroqFailureCategory = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_failure";
      throw localError(category === "timeout" ? "Groq transcription timed out." : "Groq could not be reached for this request.", "unavailable", category, Date.now() - startedAt);
    } finally {
      clearTimeout(timeout);
    }
  }

  async testKey(): Promise<GroqKeyTestResult> {
    try {
      const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/models`, { headers: this.headers("application/json") }, 20_000);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw classifyGroqError(response, payload?.error?.message ?? "", durationMs);
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      if (!payload.data?.some(model => model.id === GROQ_TRANSCRIPTION_MODEL) || !payload.data.some(model => model.id === GROQ_VISION_MODEL)) throw localError("Groq key verified, but this account does not expose the required transcription and vision models.", "unavailable", "unknown", durationMs);
      return { status: "verified", message: `Groq API key verified with ${GROQ_TRANSCRIPTION_MODEL} and ${GROQ_VISION_MODEL}.` };
    } catch (error) {
      if (error instanceof GroqRequestError) return { status: error.status, message: error.message };
      return { status: "unavailable", message: "Groq could not be reached for this key test." };
    }
  }

  async transcribeAudio(input: { bytes?: Uint8Array; filename?: string; mimeType?: string; url?: string; language?: string; prompt?: string; timeoutMs?: number }): Promise<GroqTranscript> {
    const body = new FormData();
    if (input.url) body.append("url", input.url);
    else if (input.bytes && input.filename && input.mimeType) {
      const fileBytes = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
      body.append("file", new Blob([fileBytes], { type: input.mimeType }), input.filename);
    } else throw localError("Provide a secure audio URL or a complete audio attachment for Groq transcription.", "prompt_error", "client_request");
    body.append("model", GROQ_TRANSCRIPTION_MODEL);
    body.append("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "segment");
    if (input.language) body.append("language", input.language);
    if (input.prompt) body.append("prompt", input.prompt);
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/audio/transcriptions`, { method: "POST", headers: this.headers(), body }, input.timeoutMs ?? 90_000);
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response, payload?.error?.message ?? "", durationMs);
    }
    const payload = await response.json() as Omit<GroqTranscript, "requestMetadata">;
    return { ...payload, requestMetadata: responseMetadata(response, durationMs, "unknown") };
  }

  async analyzeImage(input: { imageUrl: string; prompt: string }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 600, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: [{ type: "text", text: `${input.prompt}\nReply with exactly one compact JSON object and no markdown.` }, { type: "image_url", image_url: { url: input.imageUrl, detail: "low" } }] }] }) }, 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable vision content.", "unavailable", "unknown", durationMs);
    return parseGeneratedJsonObject(content, "Groq returned malformed vision JSON.", durationMs);
  }

  async completeText(input: { prompt: string }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, messages: [{ role: "user", content: input.prompt }] }) }, 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable timeline-selection content.", "unavailable", "unknown", durationMs);
    return content;
  }

  async completeJson(input: { prompt: string }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", response_format: { type: "json_object" }, messages: [{ role: "user", content: input.prompt }] }) }, 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable structured timeline content.", "unavailable", "unknown", durationMs);
    try { return JSON.parse(content) as unknown; } catch { throw localError("Groq returned malformed timeline-selection JSON.", "prompt_error", "client_request", durationMs); }
  }

  async completePacingPlan(input: { prompt: string }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: input.prompt }] }) }, 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable pacing content.", "unavailable", "unknown", durationMs);
    return parseGeneratedJsonObject(content, "Groq returned malformed pacing JSON.", durationMs);
  }
}
