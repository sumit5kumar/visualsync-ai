import { describe, expect, it } from "vitest";
import { MIN_ADAPTIVE_PCM_WAV_RANGE_CONTENT_MS, mergeChunkTranscripts, narrationTranscriptionSummary, readNarrationTranscriptionState, shiftSegmentTimestamps, splitRepeatedlyFailingPcmWavRange, type PersistedNarrationChunk } from "./narrationTranscription";

const baseChunk = (overrides: Partial<PersistedNarrationChunk>): PersistedNarrationChunk => ({ storageKey: "chunk.mp3", startMs: 0, endMs: 10_000, contentStartMs: 0, contentEndMs: 10_000, byteSize: 100, status: "completed", attempts: 1, transcript: { text: "hello world", segments: [] }, ...overrides });

describe("chunk segment timestamp shifting", () => {
  it("offsets segment and word timestamps onto the narration timeline", () => {
    const shifted = shiftSegmentTimestamps([{ start: 0, end: 11.12, text: "tail", words: [{ word: "a", start: 0.2, end: 0.5 }, { word: "b", start: 10.8, end: 11.12 }] }], 56);
    expect(shifted).toEqual([{ start: 56, end: 67.12, text: "tail", words: [{ word: "a", start: 56.2, end: 56.5 }, { word: "b", start: 66.8, end: 67.12 }] }]);
  });

  it("leaves segments without words and zero offsets untouched", () => {
    expect(shiftSegmentTimestamps([{ start: 1, end: 2, text: "x" }], 0)).toEqual([{ start: 1, end: 2, text: "x" }]);
    expect(shiftSegmentTimestamps([], 12)).toEqual([]);
  });
});

describe("resumable narration transcription", () => {
  it("keeps the source-preparation marker so a duration-validated WAV plan is reused across hosted retries", () => {
    const state = readNarrationTranscriptionState({ transcriptionState: { version: 2, chunkOverlapMs: 4_000, sourcePrepared: true, sourcePreparationVersion: 3, chunks: [baseChunk({})] } });
    expect(state?.sourcePrepared).toBe(true);
    expect(state?.sourcePreparationVersion).toBe(3);
  });

  it("removes duplicate overlap segments while preserving chronological timestamp coverage", () => {
    const merged = mergeChunkTranscripts([
      baseChunk({ transcript: { text: "first boundary", segments: [{ start: 0, end: 4, text: "First boundary" }, { start: 4, end: 8, text: "Shared sentence" }] } }),
      baseChunk({ startMs: 4_000, contentStartMs: 8_000, transcript: { text: "shared next", segments: [{ start: 4, end: 8.1, text: "shared sentence" }, { start: 8, end: 12, text: "Next sentence" }] } }),
    ]);
    expect(merged.map(segment => segment.text)).toEqual(["First boundary", "Shared sentence", "Next sentence"]);
    expect(merged.every((segment, index) => index === 0 || segment.start >= merged[index - 1].start)).toBe(true);
  });

  it("keeps word-level timestamps when merging duplicate and clamped overlap segments", () => {
    const merged = mergeChunkTranscripts([
      baseChunk({ transcript: { text: "first shared", segments: [{ start: 0, end: 4, text: "First boundary", words: [{ word: "First", start: 0.1, end: 0.6 }, { word: "boundary", start: 0.8, end: 1.4 }] }, { start: 4, end: 8, text: "Shared sentence" }] } }),
      baseChunk({ startMs: 4_000, contentStartMs: 8_000, transcript: { text: "shared next", segments: [{ start: 4, end: 8.1, text: "shared sentence", words: [{ word: "Shared", start: 4.1, end: 4.6 }, { word: "sentence", start: 4.8, end: 5.6 }] }, { start: 8, end: 12, text: "Next sentence", words: [{ word: "Next", start: 8.1, end: 8.6 }, { word: "sentence", start: 8.8, end: 9.4 }] }] } }),
    ]);
    expect(merged.map(segment => segment.text)).toEqual(["First boundary", "Shared sentence", "Next sentence"]);
    expect(merged[0].words).toEqual([{ word: "First", start: 0.1, end: 0.6 }, { word: "boundary", start: 0.8, end: 1.4 }]);
    expect(merged[1].words).toEqual([{ word: "Shared", start: 4.1, end: 4.6 }, { word: "sentence", start: 4.8, end: 5.6 }]);
    expect(merged[2].words).toEqual([{ word: "Next", start: 8.1, end: 8.6 }, { word: "sentence", start: 8.8, end: 9.4 }]);
  });

  it("reports resumable completed and waiting chunk counts without exposing provider secrets", () => {
    const summary = narrationTranscriptionSummary({ transcriptionState: { version: 2, chunkOverlapMs: 4_000, chunks: [baseChunk({ status: "completed" }), baseChunk({ status: "waiting", attempts: 2 })], lastError: { category: "rate_limited", message: "Waiting for Groq retry guidance.", retryAfterMs: 18_000, occurredAtMs: 1 } } });
    expect(summary).toMatchObject({ totalChunks: 2, completedChunks: 1, activeChunkIndex: 2, state: "waiting" });
  });

  it("splits only a repeatedly failing long PCM source range into two aligned overlap-aware children", () => {
    const wavFmtBase64 = Buffer.from([1, 0, 1, 0, 0x80, 0xbb, 0, 0, 0, 0x77, 1, 0, 2, 0, 16, 0]).toString("base64");
    const source = baseChunk({ storageKey: "narration.wav", startMs: 336_000, endMs: 396_000, contentStartMs: 340_000, contentEndMs: 396_000, byteSize: 2_880_000, status: "failed", attempts: 3, sourceRange: { startByte: 16_128_044, endByteExclusive: 19_008_044, wavFmtBase64 } });
    const children = splitRepeatedlyFailingPcmWavRange(source, 4_000);
    expect(children).toHaveLength(2);
    expect(children?.map(chunk => [chunk.status, chunk.attempts, chunk.contentStartMs, chunk.contentEndMs])).toEqual([["pending", 0, 340_000, 368_000], ["pending", 0, 368_000, 396_000]]);
    expect(children?.every(chunk => chunk.byteSize < source.byteSize && chunk.sourceRange && chunk.sourceRange.endByteExclusive > chunk.sourceRange.startByte)).toBe(true);
    expect(MIN_ADAPTIVE_PCM_WAV_RANGE_CONTENT_MS).toBe(15_000);
    expect(splitRepeatedlyFailingPcmWavRange(children![0], 4_000)?.map(chunk => [chunk.contentStartMs, chunk.contentEndMs])).toEqual([[340_000, 354_000], [354_000, 368_000]]);
    expect(splitRepeatedlyFailingPcmWavRange(baseChunk({ startMs: 0, endMs: 15_000, contentStartMs: 0, contentEndMs: 15_000, sourceRange: { startByte: 44, endByteExclusive: 720_044, wavFmtBase64 } }), 4_000)).toBeNull();
  });
});
