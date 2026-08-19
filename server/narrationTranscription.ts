export type TimestampedNarrationSegment = {
  id?: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
};

export type NarrationChunkStatus = "pending" | "processing" | "completed" | "waiting" | "failed";

export type PersistedNarrationChunk = {
  storageKey: string;
  startMs: number;
  endMs: number;
  contentStartMs: number;
  contentEndMs: number;
  byteSize: number;
  status: NarrationChunkStatus;
  attempts: number;
  lastAttemptAtMs?: number;
  transcript?: { text: string; language?: string; segments: TimestampedNarrationSegment[] };
  provider?: { maskedKey: string; model: string; durationMs: number; httpStatus?: number; category: string };
};

export type NarrationTranscriptionState = {
  version: 2;
  chunkOverlapMs: number;
  chunks: PersistedNarrationChunk[];
  lastError?: { category: string; message: string; retryAfterMs?: number; httpStatus?: number; errorCode?: string; remainingRequests?: string; remainingAudio?: string; resetAudio?: string; requestDurationMs: number; occurredAtMs: number };
};

const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function readNarrationTranscriptionState(value: unknown): NarrationTranscriptionState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).transcriptionState;
  if (!candidate || typeof candidate !== "object") return null;
  const state = candidate as Partial<NarrationTranscriptionState>;
  if (state.version !== 2 || !Array.isArray(state.chunks)) return null;
  const chunks = state.chunks.filter(chunk => chunk && typeof chunk.storageKey === "string" && Number.isFinite(chunk.startMs) && Number.isFinite(chunk.endMs) && Number.isFinite(chunk.contentStartMs) && Number.isFinite(chunk.contentEndMs) && Number.isFinite(chunk.byteSize));
  return chunks.length === state.chunks.length ? { version: 2, chunkOverlapMs: Number(state.chunkOverlapMs) || 0, chunks, ...(state.lastError ? { lastError: state.lastError } : {}) } : null;
}

export function narrationTranscriptionSummary(value: unknown) {
  const state = readNarrationTranscriptionState(value);
  if (!state) return null;
  const completed = state.chunks.filter(chunk => chunk.status === "completed").length;
  const waiting = state.chunks.find(chunk => chunk.status === "waiting");
  return {
    totalChunks: state.chunks.length,
    completedChunks: completed,
    activeChunkIndex: state.chunks.findIndex(chunk => chunk.status === "processing") + 1 || (completed < state.chunks.length ? completed + 1 : state.chunks.length),
    chunkOverlapMs: state.chunkOverlapMs,
    state: waiting ? "waiting" as const : completed === state.chunks.length ? "completed" as const : "processing" as const,
    lastError: state.lastError ?? null,
  };
}

export function mergeChunkTranscripts(chunks: PersistedNarrationChunk[]) {
  const merged: TimestampedNarrationSegment[] = [];
  const ordered = chunks.slice().sort((left, right) => left.startMs - right.startMs);
  for (const chunk of ordered) {
    for (const segment of chunk.transcript?.segments ?? []) {
      const absolute = { ...segment };
      const previous = merged.at(-1);
      if (!previous) {
        merged.push(absolute);
        continue;
      }
      const overlaps = absolute.start * 1000 <= previous.end * 1000 + 250;
      const previousText = normalizeText(previous.text);
      const currentText = normalizeText(absolute.text);
      if (overlaps && (previousText === currentText || previousText.includes(currentText))) {
        previous.end = Math.max(previous.end, absolute.end);
        continue;
      }
      if (overlaps && currentText.includes(previousText)) {
        previous.text = absolute.text;
        previous.end = Math.max(previous.end, absolute.end);
        continue;
      }
      merged.push(absolute);
    }
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function summarizeNarrationText(chunks: PersistedNarrationChunk[]) {
  return chunks.map(chunk => chunk.transcript?.text.trim() ?? "").filter(Boolean).join(" ");
}
