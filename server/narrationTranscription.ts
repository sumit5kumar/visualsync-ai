export type TimestampedNarrationSegment = {
  id?: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  words?: Array<{ word: string; start: number; end: number }>;
};

export type NarrationChunkStatus = "pending" | "processing" | "completed" | "waiting" | "failed";

export type PersistedNarrationChunk = {
  storageKey: string;
  sourceRange?: { startByte: number; endByteExclusive: number; wavFmtBase64?: string; kind?: "mp3" };
  startMs: number;
  endMs: number;
  contentStartMs: number;
  contentEndMs: number;
  byteSize: number;
  status: NarrationChunkStatus;
  attempts: number;
  timingRecoveryVersion?: number;
  lastAttemptAtMs?: number;
  transcript?: { text: string; language?: string; segments: TimestampedNarrationSegment[] };
  provider?: { maskedKey: string; model: string; durationMs: number; httpStatus?: number; category: string };
};

export type Mp3PreparationFrame = { startByte: number; endByteExclusive: number; startMs: number; endMs: number };
export type Mp3PreparationActiveChunk = { startByte: number; endByteExclusive: number; startMs: number; endMs: number; contentStartByte: number; contentStartMs: number; contentEndMs: number };
export type Mp3PreparationState = { nextByteOffset: number; nextTimestampMs: number; sourceByteLength?: number; recentFrames: Mp3PreparationFrame[]; activeChunk?: Mp3PreparationActiveChunk };

export type NarrationTranscriptionState = {
  version: 2;
  chunkOverlapMs: number;
  sourcePrepared?: boolean;
  sourcePreparationVersion?: number;
  mp3Preparation?: Mp3PreparationState;
  chunks: PersistedNarrationChunk[];
  lastError?: { category: string; message: string; retryAfterMs?: number; httpStatus?: number; errorCode?: string; remainingRequests?: string; remainingAudio?: string; resetAudio?: string; requestDurationMs: number; occurredAtMs: number };
};

export const ADAPTIVE_PCM_WAV_RANGE_SPLIT_AFTER_ATTEMPTS = 3;
export const MIN_ADAPTIVE_PCM_WAV_RANGE_CONTENT_MS = 15_000;

function alignToBlock(value: number, blockAlign: number) {
  return Math.max(0, Math.floor(value / blockAlign) * blockAlign);
}

function pcmBlockAlign(wavFmtBase64: string) {
  const fmt = Buffer.from(wavFmtBase64, "base64");
  return fmt.length >= 14 ? fmt.readUInt16LE(12) : 1;
}

export function splitRepeatedlyFailingPcmWavRange(chunk: PersistedNarrationChunk, overlapMs: number, minimumContentMs = MIN_ADAPTIVE_PCM_WAV_RANGE_CONTENT_MS): PersistedNarrationChunk[] | null {
  const sourceRange = chunk.sourceRange;
  if (!sourceRange?.wavFmtBase64) return null;
  const contentDurationMs = chunk.contentEndMs - chunk.contentStartMs;
  if (contentDurationMs <= minimumContentMs) return null;
  const sourceDurationMs = chunk.endMs - chunk.startMs;
  if (sourceDurationMs <= 0 || chunk.byteSize <= 0) return null;
  const blockAlign = pcmBlockAlign(sourceRange.wavFmtBase64);
  // byteSize may include a WAV header; source ranges contain only PCM payload.
  const bytesPerMs = (sourceRange.endByteExclusive - sourceRange.startByte) / sourceDurationMs;
  const midpointContentMs = chunk.contentStartMs + Math.round(contentDurationMs / 2);
  const childRanges = [
    { startMs: chunk.startMs, endMs: midpointContentMs, contentStartMs: chunk.contentStartMs, contentEndMs: midpointContentMs },
    { startMs: Math.max(chunk.startMs, midpointContentMs - overlapMs), endMs: chunk.endMs, contentStartMs: midpointContentMs, contentEndMs: chunk.contentEndMs },
  ];
  const children: PersistedNarrationChunk[] = [];
  for (const range of childRanges) {
    const startByte = sourceRange.startByte + alignToBlock((range.startMs - chunk.startMs) * bytesPerMs, blockAlign);
    const endByteExclusive = range.endMs === chunk.endMs ? sourceRange.endByteExclusive : sourceRange.startByte + alignToBlock((range.endMs - chunk.startMs) * bytesPerMs, blockAlign);
    if (endByteExclusive <= startByte) return null;
    children.push({
      storageKey: chunk.storageKey,
      sourceRange: { startByte, endByteExclusive, wavFmtBase64: sourceRange.wavFmtBase64 },
      startMs: range.startMs,
      endMs: range.endMs,
      contentStartMs: range.contentStartMs,
      contentEndMs: range.contentEndMs,
      byteSize: endByteExclusive - startByte,
      status: "pending" as const,
      attempts: 0,
    });
  }
  return children;
}

const normalizeText = (value: string) => value.trim().toLowerCase().replace(new RegExp("[^\\p{L}\\p{M}\\p{N}\\s]+", "gu"), "").replace(/\s+/g, " ");

function textsOverlapOrMatch(leftRaw: string, rightRaw: string) {
  const left = normalizeText(leftRaw);
  const right = normalizeText(rightRaw);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftWords = left.split(" ").filter(Boolean);
  const rightWords = right.split(" ").filter(Boolean);
  if (leftWords.length >= 2 && rightWords.length >= 2) {
    const shared = rightWords.filter(word => leftWords.includes(word)).length;
    if (shared / Math.min(leftWords.length, rightWords.length) >= 0.6) return true;
  }
  return false;
}

export function readNarrationTranscriptionState(value: unknown): NarrationTranscriptionState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).transcriptionState;
  if (!candidate || typeof candidate !== "object") return null;
  const state = candidate as Partial<NarrationTranscriptionState>;
  if (state.version !== 2 || !Array.isArray(state.chunks)) return null;
  const chunks = state.chunks.filter(chunk => chunk && typeof chunk.storageKey === "string" && (!chunk.sourceRange || (Number.isInteger(chunk.sourceRange.startByte) && Number.isInteger(chunk.sourceRange.endByteExclusive) && chunk.sourceRange.endByteExclusive > chunk.sourceRange.startByte && (typeof chunk.sourceRange.wavFmtBase64 === "string" || chunk.sourceRange.kind === "mp3"))) && Number.isFinite(chunk.startMs) && Number.isFinite(chunk.endMs) && Number.isFinite(chunk.contentStartMs) && Number.isFinite(chunk.contentEndMs) && Number.isFinite(chunk.byteSize));
  const mp3Preparation = state.mp3Preparation && typeof state.mp3Preparation === "object" && Number.isInteger(state.mp3Preparation.nextByteOffset) && Number.isFinite(state.mp3Preparation.nextTimestampMs) && Array.isArray(state.mp3Preparation.recentFrames) ? state.mp3Preparation as Mp3PreparationState : undefined;
  return chunks.length === state.chunks.length ? { version: 2, chunkOverlapMs: Number(state.chunkOverlapMs) || 0, sourcePrepared: state.sourcePrepared === true, sourcePreparationVersion: Number.isFinite(state.sourcePreparationVersion) ? Number(state.sourcePreparationVersion) : undefined, ...(mp3Preparation ? { mp3Preparation } : {}), chunks, ...(state.lastError ? { lastError: state.lastError } : {}) } : null;
}

export function narrationTranscriptionSummary(value: unknown) {
  const state = readNarrationTranscriptionState(value);
  if (!state) return null;
  // Single-shot transcription (e.g. Deepgram Nova-2) stores no chunks; the UI
  // should treat this as "analyzed" rather than "0 of 0 chunks / 0 saved".
  if (state.chunks.length === 0) return null;
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
  let tailChunk: PersistedNarrationChunk | undefined;
  for (const chunk of ordered) {
    // Only compare against the prior source chunk, never a sentence just added
    // from this chunk. Keep its original coverage even if a replay extends it.
    const previousChunkTail = merged.at(-1);
    const previousChunkTailEnd = previousChunkTail?.end ?? 0;
    const previousChunkTailText = previousChunkTail?.text ?? "";
    const contentBoundarySec = chunk.contentStartMs / 1000;
    const overlapStartSec = Math.max(chunk.startMs, tailChunk?.startMs ?? chunk.startMs) / 1000;
    const overlapEndSec = Math.min(chunk.contentStartMs, tailChunk?.endMs ?? chunk.startMs) / 1000;
    for (const segment of usableTranscriptSegments(chunk.transcript?.segments)) {
      const absolute = { ...segment };
      const previous = merged.at(-1);
      const inPriorChunkOverlap = previous && previous === previousChunkTail
        && overlapEndSec > overlapStartSec
        && absolute.start < overlapEndSec && absolute.end > overlapStartSec
        && absolute.start < previousChunkTailEnd;
      if (inPriorChunkOverlap) {
        const overlapsTail = absolute.end > previous.start;
        if (overlapsTail && textsOverlapOrMatch(previousChunkTailText, absolute.text)) {
          const previousText = normalizeText(previous.text);
          const currentText = normalizeText(absolute.text);
          if (currentText.length > previousText.length && currentText.includes(previousText)) {
            previous.text = absolute.text;
            if (absolute.words) previous.words = absolute.words;
          } else if (!previous.words && absolute.words) {
            previous.words = absolute.words;
          }
          previous.end = Math.max(previous.end, absolute.end);
          tailChunk = chunk;
          continue;
        }
        const midpointSec = (absolute.start + absolute.end) / 2;
        if (absolute.end <= contentBoundarySec + 0.15 || (midpointSec < contentBoundarySec - 0.1 && previous.end >= contentBoundarySec - 0.5)) {
          continue;
        }
        if (absolute.start < previous.end) {
          if (absolute.words) absolute.words = absolute.words.filter(word => word.start >= previous.end - 0.05);
          absolute.start = previous.end;
          if (absolute.end - absolute.start < 0.05) continue;
        }
      }
      merged.push(absolute);
      tailChunk = chunk;
    }
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function usableTranscriptSegments(value: unknown): TimestampedNarrationSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment): TimestampedNarrationSegment[] => {
    if (!segment || typeof segment !== "object" || !Number.isFinite(segment.start) || segment.start < 0 || !Number.isFinite(segment.end) || segment.end <= segment.start) return [];
    const words = Array.isArray(segment.words) ? segment.words.filter((word: NonNullable<TimestampedNarrationSegment["words"]>[number]) => word && typeof word.word === "string" && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start) : undefined;
    // Whisper can provide valid timed speech with blank segment text. Preserve
    // those words instead of silently deleting the entire spoken interval.
    const text = typeof segment.text === "string" && segment.text.trim() ? segment.text : (words ?? []).map((word: { word: string }) => word.word).join(" ").trim();
    return text ? [{ ...segment, text, ...(words ? { words } : {}) }] : [];
  });
}

export function readPacingTranscriptSegments(value: unknown): TimestampedNarrationSegment[] {
  // Repair old merged analyses locally, but never replace them with a partial cache.
  const state = readNarrationTranscriptionState(value);
  if (state?.sourcePrepared && state.chunks.length > 0 && state.chunks.every(chunk => chunk.status === "completed")) {
    const chunks = state.chunks.map(chunk => ({
      ...chunk,
      transcript: { ...chunk.transcript, text: chunk.transcript?.text ?? "", segments: usableTranscriptSegments(chunk.transcript?.segments) },
    }));
    if (chunks.every(chunk => chunk.transcript.segments.length > 0)) return mergeChunkTranscripts(chunks);
  }
  return usableTranscriptSegments(value && typeof value === "object" ? (value as Record<string, unknown>).segments : undefined);
}

export function summarizeNarrationText(chunks: PersistedNarrationChunk[]) {
  return chunks.map(chunk => chunk.transcript?.text.trim() ?? "").filter(Boolean).join(" ");
}

/**
 * A chunk transcript's segments and word timestamps are relative to the
 * chunk's own audio slice. Shift both onto the narration timeline so chunk
 * merges compare like-for-like absolute times.
 */
export function shiftSegmentTimestamps<T extends { start: number; end: number; words?: Array<{ word: string; start: number; end: number }> }>(segments: T[], offsetSeconds: number): T[] {
  if (!segments.length || offsetSeconds === 0) return segments;
  return segments.map(segment => ({
    ...segment,
    start: segment.start + offsetSeconds,
    end: segment.end + offsetSeconds,
    ...(Array.isArray(segment.words) && segment.words.length > 0 ? { words: segment.words.map(word => ({ ...word, start: word.start + offsetSeconds, end: word.end + offsetSeconds })) } : {}),
  }));
}

// Whisper decoding is nondeterministic without greedy decoding: one pass can
// drop a whole stretch of CONTINUOUS speech (observed: a 21-second word hole
// over audio with no silence at all), while the next pass of the same bytes
// returns a complete word stream. A gap this large between consecutive spoken
// words is an artifact, not a real pause, and is used to trigger one retry
// and, failing that, proportional timing fallbacks so anchors still advance
// through the dropped range.
export const MAX_ALLOWED_INTERNAL_WORD_GAP_MS = 10_000;

export function transcriptionWordGapQuality(segments: Array<{ start: number; end: number; words?: Array<{ word: string; start: number; end: number }> }>, range?: { startMs: number; endMs: number }) {
  const words = segments
    .flatMap(segment => (Array.isArray(segment.words) ? segment.words : []))
    .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start)
    .sort((left, right) => left.start - right.start);
  let largestGapMs = 0;
  let largestWordDurationMs = 0;
  for (const word of words) largestWordDurationMs = Math.max(largestWordDurationMs, (word.end - word.start) * 1000);
  for (let index = 1; index < words.length; index += 1) {
    const gapMs = (words[index].start - words[index - 1].end) * 1000;
    if (Number.isFinite(gapMs) && gapMs > largestGapMs) largestGapMs = gapMs;
  }
  let outOfRangeMs = 0;
  if (range && words.length) {
    const firstMs = words[0].start * 1000;
    const lastMs = Math.max(...words.map(word => word.end * 1000));
    largestGapMs = Math.max(largestGapMs, firstMs - range.startMs, range.endMs - lastMs);
    outOfRangeMs = Math.max(0, range.startMs - firstMs, lastMs - range.endMs);
  }
  // Suspicion triggers bounded audio re-checks, not invented timestamps. A real
  // pause can also trigger this gate; retries/splitting remain strictly bounded.
  const needsRecovery = largestGapMs > MAX_ALLOWED_INTERNAL_WORD_GAP_MS || largestWordDurationMs > 4_000 || outOfRangeMs > 1_500;
  return { largestGapMs, largestWordDurationMs, outOfRangeMs, wordCount: words.length, needsRecovery };
}

/** Re-open only old suspect chunks; preserve healthy cached analysis and progress. */
export function recoverUnreliableNarrationChunks(state: NarrationTranscriptionState): NarrationTranscriptionState {
  let changed = false;
  const chunks = state.chunks.flatMap(chunk => {
    if (chunk.status !== "completed" || !chunk.transcript || chunk.timingRecoveryVersion === 1 || !transcriptionWordGapQuality(chunk.transcript.segments, chunk).needsRecovery) return [chunk];
    changed = true;
    const pending = { ...chunk, status: "pending" as const, attempts: 0, timingRecoveryVersion: 1, transcript: undefined, provider: undefined };
    const splitBounded = (part: PersistedNarrationChunk): PersistedNarrationChunk[] => {
      if (part.endMs - part.startMs <= 30_000) return [part];
      const children = splitRepeatedlyFailingPcmWavRange(part, Math.max(4_000, state.chunkOverlapMs));
      return children ? children.flatMap(child => splitBounded({ ...child, timingRecoveryVersion: 1 })) : [part];
    };
    return splitBounded(pending);
  });
  return changed ? { ...state, chunks, chunkOverlapMs: chunks.length > 1 ? Math.max(4_000, state.chunkOverlapMs) : state.chunkOverlapMs, lastError: undefined } : state;
}

