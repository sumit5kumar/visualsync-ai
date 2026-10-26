export const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";
export const GROQ_VISION_MODEL = "qwen/qwen3.8-27b";

export type GroqKeyStatus = "verified" | "invalid" | "permission_restricted" | "quota_limited" | "request_too_large" | "prompt_error" | "unavailable";
export type GroqKeyTestResult = { status: GroqKeyStatus; message: string };
export type GroqProjectProbeResult = { status: GroqKeyStatus; message: string; transcription: { ok: boolean; status: GroqKeyStatus; message: string }; generation: { ok: boolean; status: GroqKeyStatus; message: string } };
export type GroqFailureCategory = "invalid_key" | "permission_denied" | "file_too_large" | "rate_limited" | "audio_quota_exhausted" | "timeout" | "network_failure" | "server_error" | "client_request" | "unknown";
export type GroqRequestMetadata = { httpStatus?: number; errorCode?: string; retryAfterMs?: number; remainingRequests?: string; remainingAudio?: string; resetAudio?: string; durationMs: number; category: GroqFailureCategory };
export type GroqTranscript = { text: string; language?: string; segments?: Array<{ id?: number; start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number; words?: Array<{ word: string; start: number; end: number }> }>; requestMetadata: GroqRequestMetadata };
export type GroqTranscriptSegment = NonNullable<GroqTranscript["segments"]>[number];
export type GroqWordTimestamp = { word: string; start: number; end: number };

// Groq returns word-level timestamps as a TOP-LEVEL `words` array in
// verbose_json mode, not inside each segment. Downstream pacing code reads
// per-segment words, so assign every top-level word to the segment that
// contains its start time before returning the transcript.
export function distributeWordTimestamps(segments: GroqTranscriptSegment[] = [], words: GroqWordTimestamp[] = []): GroqTranscriptSegment[] {
  const usable = words.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
  if (usable.length === 0 || segments.length === 0) return segments;
  const ordered = [...segments].sort((left, right) => left.start - right.start);
  const buckets = ordered.map(() => [] as GroqWordTimestamp[]);
  for (const word of usable) {
    let index = ordered.findIndex(segment => word.start >= segment.start - 0.05 && word.start < segment.end + 0.05);
    if (index < 0) index = word.start < ordered[0].start ? 0 : ordered.length - 1;
    buckets[index].push(word);
  }
  return segments.map(segment => {
    if (Array.isArray(segment.words) && segment.words.length > 0) return segment;
    const segmentWords = buckets[ordered.indexOf(segment)] ?? [];
    return segmentWords.length > 0 ? { ...segment, words: segmentWords } : segment;
  });
}

export class GroqRequestError extends Error {
  constructor(message: string, readonly status: GroqKeyStatus, readonly metadata: GroqRequestMetadata = { durationMs: 0, category: "unknown" }) { super(safeGroqMessage(message)); }
}

function safeGroqMessage(message: string) {
  return message.replace(/gsk_[A-Za-z0-9_-]+/g, "[redacted key]").replace(/https?:\/\/\S+/gi, "[secure URL]").trim();
}

function safeProviderDiagnostic(message: string) {
  const cleaned = safeGroqMessage(message).replace(/[\r\n\t]+/g, " ").trim();
  return cleaned.slice(0, 240);
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
  if (statusCode >= 500) {
    const detail = safeProviderDiagnostic(message);
    return new GroqRequestError(`Groq reported a temporary server error${detail ? `: ${detail}` : "."}`, "unavailable", responseMetadata(response, durationMs, "server_error"));
  }
  if (statusCode >= 400 && statusCode < 500) return new GroqRequestError(`Groq rejected this request${message ? `: ${safeGroqMessage(message)}` : "."}`, "prompt_error", responseMetadata(response, durationMs, "client_request"));
  return new GroqRequestError(safeGroqMessage(message) || "Groq is currently unavailable.", "unavailable", responseMetadata(response, durationMs, "unknown"));
}

function localError(message: string, status: GroqKeyStatus, category: GroqFailureCategory, durationMs = 0) {
  return new GroqRequestError(message, status, { durationMs, category });
}

function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return null;
}

function parseGeneratedJsonObject(content: string, malformedMessage: string, durationMs = 0) {
  const fenced = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const candidates = [extractFirstJsonObject(fenced), fenced.match(/\{[\s\S]*\}/)?.[0]].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; } catch { /* try the next candidate */ }
  }
  throw localError(malformedMessage, "prompt_error", "client_request", durationMs);
}

function minimalProbeWav() {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index); };
  writeText(0, "RIFF"); view.setUint32(4, 36 + sampleCount * 2, true); writeText(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, "data"); view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) view.setInt16(44 + index * 2, Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 1_500), true);
  return bytes;
}

const MINIMAL_PROBE_IMAGE_DATA_URL = "data:image/png;base64,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";
const PROJECT_PROBE_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const PROJECT_PROBE_VISION_TIMEOUT_MS = 60_000;

function projectProbeVisionFailure(error: GroqRequestError) {
  if (error.metadata.category === "timeout") {
    return localError("Groq image-analysis/pacing verification probe timed out.", "unavailable", "timeout", error.metadata.durationMs);
  }
  if (error.status === "prompt_error" && /(image|pixel|png|jpeg|format)/i.test(error.message)) {
    return localError("The dual-verification test image was rejected. This is a probe-asset error, not an API-key or project-permission failure.", "unavailable", "client_request", error.metadata.durationMs);
  }
  return error;
}

export class GroqClient {
  constructor(private readonly apiKey: string) {}

  private headers(contentType?: string) {
    return { Authorization: `Bearer ${this.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) }; }  private async request(url: string, init: RequestInit, timeoutMs = 60_000) { const startedAt = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new DOMException("Groq request timed out.", "TimeoutError")), timeoutMs); try { return { response: await fetch(url, { ...init, signal: controller.signal }), durationMs: Date.now() - startedAt }; } catch (error) { const category: GroqFailureCategory = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_failure"; throw localError(category === "timeout" ? "Groq transcription timed out." : "Groq could not be reached for this request.", "unavailable", category, Date.now() - startedAt); } finally { clearTimeout(timeout); } }  async testKey(): Promise<GroqKeyTestResult> { try { const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/models`, { headers: this.headers("application/json") }, 20_000);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw classifyGroqError(response, payload?.error?.message ?? "", durationMs);
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      if (!payload.data?.some(model => model.id === GROQ_TRANSCRIPTION_MODEL) || !payload.data.some(model => model.id === GROQ_VISION_MODEL)) throw localError("Groq key verified, but this account does not expose the required transcription and vision models.", "unavailable", "unknown", durationMs);
      return { status: "verified", message: `Groq API key verified with ${GROQ_TRANSCRIPTION_MODEL} and ${GROQ_VISION_MODEL}.` }; } catch (error) { if (error instanceof GroqRequestError) return { status: error.status, message: error.message }; return { status: "unavailable", message: "Groq could not be reached for this key test." }; } }  async verifyProjectModels(): Promise<GroqProjectProbeResult> { let transcription: GroqProjectProbeResult["transcription"]; try { await this.transcribeAudio({ bytes: minimalProbeWav(), filename: "visualsync-project-probe.wav", mimeType: "audio/wav", timeoutMs: PROJECT_PROBE_TRANSCRIPTION_TIMEOUT_MS }); transcription = { ok: true, status: "verified", message: `${GROQ_TRANSCRIPTION_MODEL} transcription probe succeeded.` };
    } catch (error) {
      const failure = error instanceof GroqRequestError ? error : localError("Groq could not complete the transcription verification probe.", "unavailable", "unknown");
      return { status: failure.status, message: failure.message, transcription: { ok: false, status: failure.status, message: failure.message }, generation: { ok: false, status: "unavailable", message: "Generation-model probe was not run because transcription verification did not succeed." } };
    }

    try {
      const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 32, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly {\"ok\":true}." }, { type: "image_url", image_url: { url: MINIMAL_PROBE_IMAGE_DATA_URL, detail: "low" } }] }] }) }, PROJECT_PROBE_VISION_TIMEOUT_MS);
      if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      if (!payload.choices?.[0]?.message?.content?.trim()) throw localError("Groq returned no usable generation-model verification result.", "unavailable", "unknown", durationMs);
      return { status: "verified", message: `Both ${GROQ_TRANSCRIPTION_MODEL} and${GROQ_VISION_MODEL} project probes succeeded.`, transcription, generation: { ok: true, status: "verified", message: `${GROQ_VISION_MODEL} image-analysis/pacing probe succeeded.` } };
    } catch (error) {
      const originalFailure = error instanceof GroqRequestError ? error : localError("Groq could not complete the generation-model verification probe.", "unavailable", "unknown");
      const failure = projectProbeVisionFailure(originalFailure);
      return { status: failure.status, message: failure.message, transcription, generation: { ok: false, status: failure.status, message: failure.message } };
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
    // Greedy decoding keeps word timestamps deterministic across retries.
    // Without it, Whisper can drop whole stretches of speech in one run
    // (observed: a 21s word hole over continuous audio) and recover them
    // in the next, which shifts every downstream anchor boundary.
    body.append("temperature", "0");
    body.append("timestamp_granularities[]", "segment");
    body.append("timestamp_granularities[]", "word");
    if (input.language) body.append("language", input.language);
    if (input.prompt) body.append("prompt", input.prompt);
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/audio/transcriptions`, { method: "POST", headers: this.headers(), body }, input.timeoutMs ?? 90_000);
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw classifyGroqError(response, payload?.error?.message ?? "", durationMs);
    }
    const payload = await response.json() as Omit<GroqTranscript, "requestMetadata"> & { words?: GroqWordTimestamp[] };
    return { text: payload.text, language: payload.language, segments: distributeWordTimestamps(payload.segments ?? [], payload.words ?? []), requestMetadata: responseMetadata(response, durationMs, "unknown") };
  }

  async analyzeImage(input: { imageUrl: string; prompt: string; timeoutMs?: number }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 1_500, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: [{ type: "text", text: `${input.prompt}\nReply with exactly one compact JSON object and no markdown.` }, { type: "image_url", image_url: { url: input.imageUrl, detail: "low" } }] }] }) }, input.timeoutMs ?? 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable vision content.", "unavailable", "unknown", durationMs);
    return parseGeneratedJsonObject(content, "Groq returned malformed vision JSON.", durationMs);
  }

  async completeText(input: { prompt: string }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, messages: [{ role: "user", content: input.prompt }] }) }, 60_000); if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); } const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const content = payload.choices?.[0]?.message?.content?.trim(); if (!content) throw localError("Groq returned no usable timeline-selection content.", "unavailable", "unknown", durationMs); return content; }  async completeJson(input: { prompt: string }) { const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", response_format: { type: "json_object" }, messages: [{ role: "user", content: input.prompt }] }) }, 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable structured timeline content.", "unavailable", "unknown", durationMs);
    try { return JSON.parse(content) as unknown; } catch { throw localError("Groq returned malformed timeline-selection JSON.", "prompt_error", "client_request", durationMs); }
  }

  async completeSemanticSyncPlan(input: { prompt: string; timeoutMs?: number }) {
    const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 1_500, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: input.prompt }] }) }, input.timeoutMs ?? 90_000); if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); } const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const content = payload.choices?.[0]?.message?.content?.trim(); if (!content) throw localError("Groq returned no usable semantic sync content.", "unavailable", "unknown", durationMs); return { value: parseGeneratedJsonObject(content, "Groq returned malformed semantic sync JSON.", durationMs), requestMetadata: responseMetadata(response, durationMs, "unknown") }; }  async completePacingPlan(input: { prompt: string; timeoutMs?: number }) { const { response, durationMs } = await this.request(`${GROQ_API_BASE_URL}/chat/completions`, { method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ model: GROQ_VISION_MODEL, temperature: 0, max_completion_tokens: 500, reasoning_effort: "none", reasoning_format: "hidden", messages: [{ role: "user", content: input.prompt }] }) }, input.timeoutMs ?? 60_000);
    if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw classifyGroqError(response, payload?.error?.message ?? "", durationMs); }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw localError("Groq returned no usable pacing content.", "unavailable", "unknown", durationMs);
    return parseGeneratedJsonObject(content, "Groq returned malformed pacing JSON.", durationMs);
  }
}

