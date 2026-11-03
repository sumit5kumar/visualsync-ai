import { describe, expect, it } from "vitest";
import { MAX_ALLOWED_INTERNAL_WORD_GAP_MS, MIN_ADAPTIVE_PCM_WAV_RANGE_CONTENT_MS, mergeChunkTranscripts, narrationTranscriptionSummary, readNarrationTranscriptionState, readPacingTranscriptSegments, shiftSegmentTimestamps, splitRepeatedlyFailingPcmWavRange, transcriptionWordGapQuality, type PersistedNarrationChunk } from "./narrationTranscription";

const baseChunk = (overrides: Partial<PersistedNarrationChunk>): PersistedNarrationChunk => ({ storageKey: "chunk.mp3", startMs: 0, endMs: 10_000, contentStartMs: 0, contentEndMs: 10_000, byteSize: 100, status: "completed", attempts: 1, transcript: { text: "hello world", segments: [] }, ...overrides });
const hindiSentences = [
  { start: 17.42, end: 19.58, text: "ज्यादातर लोग उल्टा करते हैं" },
  { start: 19.58, end: 22.4, text: "पहले खर्च करते हैं, फिर जो बचे, वो बचाते हैं" },
];

describe("transcription word-gap quality", () => {
  it("measures the largest hole between consecutive spoken words", () => {
    const segments = [{ start: 0, end: 30, text: "a", words: [{ word: "a", start: 1, end: 2 }, { word: "b", start: 23.5, end: 24 }, { word: "c", start: 24.2, end: 24.8 }] }];
    const quality = transcriptionWordGapQuality(segments);
    expect(quality.largestGapMs).toBeCloseTo(21_500, 0);
    expect(quality.wordCount).toBe(3);
  });

  it("reports zero gaps and no words for empty or wordless transcripts", () => {
    const empty = { largestGapMs: 0, largestWordDurationMs: 0, outOfRangeMs: 0, wordCount: 0, needsRecovery: false };
    expect(transcriptionWordGapQuality([])).toEqual(empty);
    expect(transcriptionWordGapQuality([{ start: 0, end: 5 }])).toEqual(empty);
  });

  it("sorts unsorted segments before measuring so a later segment cannot hide an earlier hole", () => {
    const segments = [
      { start: 40, end: 45, text: "later", words: [{ word: "z", start: 40.5, end: 41 }] },
      { start: 0, end: 20, text: "earlier", words: [{ word: "a", start: 0.5, end: 1 }, { word: "b", start: 11, end: 11.5 }] },
    ];
    expect(transcriptionWordGapQuality(segments).largestGapMs).toBeCloseTo(29_000, 0);
    expect(MAX_ALLOWED_INTERNAL_WORD_GAP_MS).toBe(10_000);
  });
});

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

describe("pacing transcript cache recovery", () => {
  const completedChunk = () => baseChunk({ endMs: 30_000, contentEndMs: 30_000, transcript: { text: hindiSentences.map(segment => segment.text).join(" "), segments: hindiSentences } });
  const persistedSegments = [{ start: 0, end: 3, text: "Persisted fallback" }];

  it("repairs a stale completed analysis from cached raw chunks without mutating the cache", () => {
    const analysis = {
      segments: [{ ...hindiSentences[0], end: hindiSentences[1].end }],
      transcriptionState: { version: 2, chunkOverlapMs: 4_000, sourcePrepared: true, chunks: [completedChunk()] },
    };
    const before = structuredClone(analysis);
    expect(readPacingTranscriptSegments(analysis)).toEqual(hindiSentences);
    expect(analysis).toEqual(before);
  });

  it("remerges all completed raw chunks with overlap and words intact without modifying them", () => {
    const analysis = {
      segments: persistedSegments,
      transcriptionState: { version: 2, chunkOverlapMs: 4_000, sourcePrepared: true, chunks: [
        baseChunk({ endMs: 8_000, contentEndMs: 8_000, transcript: { text: "Shared", segments: [{ start: 4, end: 8, text: "Shared" }] } }),
        baseChunk({ startMs: 4_000, contentStartMs: 8_000, transcript: { text: "Shared words. Next.", segments: [{ start: 4, end: 8.1, text: "Shared words", words: [{ word: "Shared", start: 4, end: 5 }, { word: "words", start: 5, end: 6 }] }, { start: 8.1, end: 10, text: "Next" }] } }),
      ] },
    };
    const before = structuredClone(analysis);
    expect(readPacingTranscriptSegments(analysis)).toEqual([
      { start: 4, end: 8.1, text: "Shared words", words: [{ word: "Shared", start: 4, end: 5 }, { word: "words", start: 5, end: 6 }] },
      { start: 8.1, end: 10, text: "Next" },
    ]);
    expect(analysis).toEqual(before);
  });

  it.each(["pending", "processing", "waiting", "failed"] as const)("uses persisted analysis when even one chunk is %s", status => {
    const analysis = { segments: persistedSegments, transcriptionState: { version: 2, chunkOverlapMs: 4_000, sourcePrepared: true, chunks: [completedChunk(), completedChunk(), { ...completedChunk(), status }] } };
    expect(readPacingTranscriptSegments(analysis)).toEqual(persistedSegments);
  });

  it.each([
    { sourcePrepared: false, chunks: [completedChunk()] },
    { chunks: [completedChunk()] },
    { sourcePrepared: true, chunks: [] },
    { sourcePrepared: true, chunks: [completedChunk(), baseChunk({})] },
    { sourcePrepared: true, chunks: [completedChunk(), baseChunk({ transcript: undefined })] },
    { sourcePrepared: true, chunks: [completedChunk(), baseChunk({ transcript: { text: "Unusable", segments: [{ start: 0, end: 1, text: " " }, { start: 2, end: 1, text: "Reversed" }] } })] },
    { sourcePrepared: true, chunks: [{ storageKey: "invalid.mp3" }] },
  ])("falls back for unprepared, empty, or unusable raw state: %j", state => {
    const analysis = { segments: persistedSegments, transcriptionState: { version: 2, chunkOverlapMs: 4_000, ...state } };
    const before = structuredClone(analysis);
    expect(readPacingTranscriptSegments(analysis)).toEqual(persistedSegments);
    expect(analysis).toEqual(before);
  });

  it("filters unusable persisted text and timestamps without changing the input", () => {
    const analysis = { segments: [
      ...persistedSegments, null, {}, { start: 0, end: 1, text: "  " }, { start: 0, end: 1, text: 12 },
      { start: "0", end: 1, text: "String start" }, { start: 0, end: "1", text: "String end" },
      { start: NaN, end: 1, text: "NaN" }, { start: 0, end: Infinity, text: "Infinite" },
      { start: -1, end: 1, text: "Negative" }, { start: 2, end: 1, text: "Reversed" }, { start: 1, end: 1, text: "Empty duration" },
    ] };
    const before = structuredClone(analysis);
    expect(readPacingTranscriptSegments(analysis)).toEqual(persistedSegments);
    expect(analysis).toEqual(before);
  });

  it.each([null, undefined, "invalid", {}, { segments: {} }, { transcriptionState: { version: 1, chunks: [] } }])("returns no segments for unusable analysis: %j", value => {
    expect(readPacingTranscriptSegments(value)).toEqual([]);
  });
});

describe("resumable narration transcription", () => {
  it("keeps the source-preparation marker so a duration-validated WAV plan is reused across hosted retries", () => {
    const state = readNarrationTranscriptionState({ transcriptionState: { version: 2, chunkOverlapMs: 4_000, sourcePrepared: true, sourcePreparationVersion: 3, chunks: [baseChunk({})] } });
    expect(state?.sourcePrepared).toBe(true);
    expect(state?.sourcePreparationVersion).toBe(3);
  });

  it("retains adjacent Hindi sentences sharing common words within one raw chunk", () => {
    const merged = mergeChunkTranscripts([baseChunk({ endMs: 30_000, contentEndMs: 30_000, transcript: { text: hindiSentences.map(segment => segment.text).join(" "), segments: hindiSentences } })]);
    expect(merged).toEqual(hindiSentences);
    expect(merged.flatMap(segment => segment.text.split(/\s+/))).toHaveLength(15);
  });

  it.each([1.9, 2, 2.2])("retains true repeated speech within one chunk at %s seconds", start => {
    const segments = [{ start: 1, end: 2, text: "बार बार" }, { start, end: 3, text: "बार बार" }];
    expect(mergeChunkTranscripts([baseChunk({ transcript: { text: "बार बार बार बार", segments } })])).toEqual(segments);
  });

  it("deduplicates a cross-chunk replay but preserves subsequent repetitions in that chunk", () => {
    const merged = mergeChunkTranscripts([
      baseChunk({ endMs: 8_000, contentEndMs: 8_000, transcript: { text: "Say it again", segments: [{ start: 4, end: 8, text: "Say it again" }] } }),
      baseChunk({ startMs: 4_000, contentStartMs: 8_000, transcript: { text: "Say it again. Say it again. Say it again.", segments: [{ start: 4, end: 8.1, text: "Say it again" }, { start: 8, end: 9, text: "Say it again" }, { start: 8.9, end: 10, text: "Say it again" }] } }),
    ]);
    expect(merged).toEqual([
      { start: 4, end: 8.1, text: "Say it again" },
      { start: 8, end: 9, text: "Say it again" },
      { start: 8.9, end: 10, text: "Say it again" },
    ]);
  });

  it("does not compare a later sentence against words newly added by its own chunk's replay", () => {
    const merged = mergeChunkTranscripts([
      baseChunk({ endMs: 8_000, contentEndMs: 8_000, transcript: { text: "Alpha", segments: [{ start: 4, end: 8, text: "Alpha" }] } }),
      baseChunk({ startMs: 4_000, endMs: 11_000, contentStartMs: 8_000, contentEndMs: 11_000, transcript: { text: "Alpha beta. Beta.", segments: [{ start: 4, end: 8.1, text: "Alpha beta" }, { start: 7.8, end: 10.5, text: "Beta" }] } }),
    ]);
    expect(merged.map(segment => segment.text)).toEqual(["Alpha beta", "Beta"]);
  });

  it.each([9, 9.1])("does not treat touching or separated cross-chunk timestamps as replay at %s seconds", start => {
    const merged = mergeChunkTranscripts([
      baseChunk({ transcript: { text: "Repeat", segments: [{ start: 8, end: 9, text: "Repeat" }] } }),
      baseChunk({ startMs: 8_000, endMs: 12_000, contentStartMs: 10_000, contentEndMs: 12_000, transcript: { text: "Repeat", segments: [{ start, end: 11, text: "Repeat" }] } }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({ start, end: 11, text: "Repeat" });
  });

  it("does not deduplicate overlapping timestamps when source chunks have no actual overlap", () => {
    const chunks = [
      baseChunk({ transcript: { text: "Repeat", segments: [{ start: 9, end: 10.1, text: "Repeat" }] } }),
      baseChunk({ startMs: 10_000, endMs: 14_000, contentStartMs: 12_000, contentEndMs: 14_000, transcript: { text: "Repeat", segments: [{ start: 10, end: 13, text: "Repeat" }] } }),
    ];
    expect(mergeChunkTranscripts(chunks)).toHaveLength(2);
  });

  it("preserves Hindi vowel distinctions while clamping a different cross-boundary sentence", () => {
    const words = [{ word: "दीन", start: 9.85, end: 9.95 }, { word: "दीन", start: 10.2, end: 11 }];
    const merged = mergeChunkTranscripts([
      baseChunk({ transcript: { text: "दिन", segments: [{ start: 9, end: 10, text: "दिन" }] } }),
      baseChunk({ startMs: 8_000, endMs: 14_000, contentStartMs: 10_000, contentEndMs: 14_000, transcript: { text: "दीन", segments: [{ start: 9.8, end: 12, text: "दीन", words }] } }),
    ]);
    expect(merged).toEqual([{ start: 9, end: 10, text: "दिन" }, { start: 10, end: 12, text: "दीन", words: [words[1]] }]);
    expect(words).toHaveLength(2);
  });

  it("removes replay of earlier overlap segments as well as the prior chunk tail", () => {
    const merged = mergeChunkTranscripts([
      baseChunk({ transcript: { text: "Earlier. Tail.", segments: [{ start: 6, end: 8, text: "Earlier" }, { start: 8, end: 10, text: "Tail" }] } }),
      baseChunk({ startMs: 6_000, endMs: 14_000, contentStartMs: 10_000, contentEndMs: 14_000, transcript: { text: "Earlier. Tail. Next.", segments: [{ start: 6, end: 8, text: "Earlier" }, { start: 8, end: 10, text: "Tail" }, { start: 10, end: 14, text: "Next" }] } }),
    ]);
    expect(merged.map(segment => segment.text)).toEqual(["Earlier", "Tail", "Next"]);
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
