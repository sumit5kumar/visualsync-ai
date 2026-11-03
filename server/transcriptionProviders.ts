import type { GroqTranscriptSegment, GroqWordTimestamp } from "./groqClient";
import type { TranscriptionProviderId } from "./providerSelection";

/**
 * Transcription adapter contract. Every provider normalizes its answer into the
 * SAME segment/word shape the existing pipeline already consumes (seconds,
 * per-segment words), so sentenceAnchors, chunk merging and pacing stay
 * provider-agnostic. Adding a provider = one adapter, no architecture change.
 */
export type ProviderTranscript = {
  provider: TranscriptionProviderId;
  text: string;
  language?: string;
  segments: GroqTranscriptSegment[];
  /** Audio duration reported by the provider, when available. */
  durationSeconds?: number;
};

export type TranscriptionAudioInput = { bytes: Uint8Array; mimeType: string; filename: string; language?: string; timeoutMs?: number };

export interface TranscriptionProviderAdapter {
  readonly id: TranscriptionProviderId;
  /** Longest audio this adapter should receive in ONE request (null = single-shot long audio). */
  readonly maxSingleRequestMs: number | null;
  transcribe(input: TranscriptionAudioInput): Promise<ProviderTranscript>;
}

export class TranscriptionProviderError extends Error {
  constructor(message: string, readonly provider: TranscriptionProviderId, readonly retryable: boolean, readonly httpStatus?: number) { super(message); }
}

function cleanWords(words: Array<{ word?: string; punctuated_word?: string; start?: number; end?: number }> | undefined): GroqWordTimestamp[] {
  return (words ?? [])
    .map(word => ({ word: String(word.punctuated_word ?? word.word ?? "").trim(), start: Number(word.start), end: Number(word.end) }))
    .filter(word => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
}

// ---------------------------------------------------------------- Deepgram

type DeepgramWord = { word?: string; punctuated_word?: string; start?: number; end?: number };
export type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string; words?: DeepgramWord[]; paragraphs?: { paragraphs?: Array<{ sentences?: Array<{ text?: string; start?: number; end?: number }> }> } }> }>;
    utterances?: Array<{ start?: number; end?: number; transcript?: string; words?: DeepgramWord[] }>;
  };
};

export const DEEPGRAM_LISTEN_ENDPOINT = "https://api.deepgram.com/v1/listen";

export function deepgramListenUrl(language = "hi") {
  const params = new URLSearchParams({ model: "nova-2", language, smart_format: "true", punctuate: "true", utterances: "true", utt_split: "0.8" });
  return `${DEEPGRAM_LISTEN_ENDPOINT}?${params.toString()}`;
}

/** Deepgram utterances → segments with their own word timestamps; falls back to one segment of all words. */
export function normalizeDeepgramResponse(payload: DeepgramResponse): ProviderTranscript {
  const channel = payload.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const utterances = payload.results?.utterances ?? [];
  let segments: GroqTranscriptSegment[] = utterances
    .map((utterance, index) => ({ id: index, start: Number(utterance.start), end: Number(utterance.end), text: String(utterance.transcript ?? "").trim(), words: cleanWords(utterance.words) }))
    .filter(segment => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
  if (!segments.length) {
    const words = cleanWords(alternative?.words);
    if (words.length) segments = [{ id: 0, start: words[0].start, end: words[words.length - 1].end, text: String(alternative?.transcript ?? words.map(word => word.word).join(" ")).trim(), words }];
  }
  return { provider: "DEEPGRAM_NOVA2", text: String(alternative?.transcript ?? segments.map(segment => segment.text).join(" ")).trim(), language: channel?.detected_language, segments, durationSeconds: payload.metadata?.duration };
}

export class DeepgramTranscriptionAdapter implements TranscriptionProviderAdapter {
  readonly id = "DEEPGRAM_NOVA2" as const;
  readonly maxSingleRequestMs = null;
  constructor(private readonly apiKey: string) {}

  async transcribe(input: TranscriptionAudioInput): Promise<ProviderTranscript> {
    let response: Response;
    try {
      response = await fetch(deepgramListenUrl(input.language ?? "hi"), {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": input.mimeType },
        body: new Uint8Array(input.bytes),
        signal: AbortSignal.timeout(input.timeoutMs ?? 300_000),
      });
    } catch {
      throw new TranscriptionProviderError("Deepgram could not be reached for this request.", this.id, true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new TranscriptionProviderError(response.status === 401 || response.status === 403 ? "Deepgram rejected this API key." : `Deepgram transcription failed (${response.status}).`, this.id, retryable, response.status);
    }
    return normalizeDeepgramResponse(await response.json() as DeepgramResponse);
  }
}

// ------------------------------------------------- Local GPU (faster-whisper)

/**
 * Expected JSON from the user's local Python server (faster-whisper with
 * word_timestamps=True), e.g.:
 *   POST {LOCAL_WHISPER_URL}/transcribe  multipart field "file" (+ "language")
 *   -> { "text": "...", "language": "hi", "duration": 288.6,
 *        "segments": [{ "start": 0.0, "end": 4.2, "text": "...",
 *                       "words": [{ "word": "...", "start": 0.0, "end": 0.4 }] }] }
 */
export type FasterWhisperResponse = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ id?: number; start?: number; end?: number; text?: string; words?: Array<{ word?: string; start?: number; end?: number }> }>;
};

export function normalizeFasterWhisperResponse(payload: FasterWhisperResponse): ProviderTranscript {
  const segments: GroqTranscriptSegment[] = (payload.segments ?? [])
    .map((segment, index) => ({ id: segment.id ?? index, start: Number(segment.start), end: Number(segment.end), text: String(segment.text ?? "").trim(), words: cleanWords(segment.words) }))
    .filter(segment => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
  return { provider: "LOCAL_FASTER_WHISPER", text: String(payload.text ?? segments.map(segment => segment.text).join(" ")).trim(), language: payload.language, segments, durationSeconds: payload.duration };
}

export class LocalFasterWhisperAdapter implements TranscriptionProviderAdapter {
  readonly id = "LOCAL_FASTER_WHISPER" as const;
  readonly maxSingleRequestMs = null;
  constructor(private readonly baseUrl: string, private readonly authToken?: string) {}

  async transcribe(input: TranscriptionAudioInput): Promise<ProviderTranscript> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);
    form.append("language", input.language ?? "hi");
    form.append("word_timestamps", "true");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/transcribe`, {
        method: "POST",
        headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : undefined,
        body: form,
        signal: AbortSignal.timeout(input.timeoutMs ?? 600_000),
      });
    } catch {
      throw new TranscriptionProviderError("The local Faster-Whisper server could not be reached. Check that it is running and reachable from the hosted site.", this.id, true);
    }
    if (!response.ok) throw new TranscriptionProviderError(`The local Faster-Whisper server returned ${response.status}.`, this.id, response.status >= 500, response.status);
    return normalizeFasterWhisperResponse(await response.json() as FasterWhisperResponse);
  }
}

/** Server env for the local GPU adapter (never exposed to the browser). */
export function localWhisperConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.LOCAL_WHISPER_URL?.trim();
  return url ? { url, token: env.LOCAL_WHISPER_TOKEN?.trim() || undefined } : null;
}

// ---------------------------------------------------------------- Deepgram key test

export type DeepgramTestStatus = "verified" | "invalid" | "quota_limited" | "unavailable";
export type DeepgramKeyTestResult = { status: DeepgramTestStatus; message: string; model?: string };

export async function testDeepgramKey(apiKey: string, timeoutMs = 15_000): Promise<DeepgramKeyTestResult> {
  const startedAtMs = Date.now();
  let response: Response;
  try {
    response = await fetch(deepgramListenUrl(), {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nova-2", smart_format: "true" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "unavailable", message: "Deepgram could not be reached for this key test." };
  }
  const durationMs = Date.now() - startedAtMs;
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", message: `Deepgram rejected this API key${payload?.message ? ` (${payload.message})` : ""}.` };
    }
    if (response.status === 429) {
      return { status: "quota_limited", message: "This Deepgram key has reached a quota or rate limit." };
    }
    return { status: "unavailable", message: payload?.message ? `Deepgram returned ${response.status}: ${payload.message}` : `Deepgram returned ${response.status}.` };
  }
  return { status: "verified", message: `Deepgram key verified with nova-2 in ${Math.round(durationMs)} ms.` };
}
