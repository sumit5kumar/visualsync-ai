import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GEMINI_BATCH_IMAGES_PER_REQUEST, buildGeminiBatchImageAnalysisPrompt, buildPublicManagedStorageUrl, isWavNarration, mapWithConcurrency, normalizeTimelineGenerationWorkState, parseGeminiBatchImageAnalysis, parseLineTranslations, prepareOrderedPacingWorkState, recoverLegacyInflatedMp3Preparation } from "./projectProcessor";

describe("public managed narration URLs", () => {
  it("keeps the managed storage path public and safely encodes every storage-key segment", () => {
    expect(buildPublicManagedStorageUrl("https://visualsync.example.test", "projects/360001/33 strategy.mp3")).toBe("https://visualsync.example.test/manus-storage/projects/360001/33%20strategy.mp3");
  });

  it("persists a large chunk plan through a bounded ordered worker pool", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async value => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(maximumActive).toBeLessThanOrEqual(3);
  });

  it("recognizes common WAV uploads so short narration is sent directly instead of entering the MP3-only conversion path", () => {
    expect(isWavNarration({ mimeType: "audio/wav", storageKey: "projects/1/narration.wav" })).toBe(true);
    expect(isWavNarration({ mimeType: "audio/mpeg", storageKey: "projects/1/narration.mp3" })).toBe(false);
  });

  it("retains first-dispatch telemetry when persisted work state is normalized for a later hosted slice", () => {
    expect(normalizeTimelineGenerationWorkState({ firstDispatchAtMs: 1_787_173_659_541, preflightComplete: true, pacingWeights: [1.2], pacingAnchors: [3, 7], nextPacingBatch: 1 })).toMatchObject({
      firstDispatchAtMs: 1_787_173_659_541,
      preflightComplete: true,
      pacingWeights: [1.2],
      pacingAnchors: [3, 7],
      nextPacingBatch: 1,
    });
  });

  it("restarts only old ordered pacing when the word grid changes, preserving analyzed work", () => {
    const saved = normalizeTimelineGenerationWorkState({ preflightComplete: true, firstDispatchAtMs: 1234, pacingAnchors: [0, 1, 5], pacingWeights: [1, 2, 3], nextPacingBatch: 1, pacingQualityRetries: 1, semanticAssignments: [{ sequence: 1, segmentIndex: 2, weight: 1 }] });
    const repaired = prepareOrderedPacingWorkState(saved);
    expect(repaired).toMatchObject({ pacingPlanVersion: 3, pacingAnchors: [], pacingWeights: [], nextPacingBatch: 0, pacingQualityRetries: 0, preflightComplete: true, firstDispatchAtMs: 1234, semanticAssignments: saved.semanticAssignments });
    expect(saved.pacingAnchors).toEqual([0, 1, 5]);
  });

  it("retains current explicit-ID pacing through a persisted callback round-trip", () => {
    const saved = normalizeTimelineGenerationWorkState({ ...prepareOrderedPacingWorkState({}), pacingAnchors: [0, 1, 5], pacingAnchorHints: [null, null, null], nextPacingBatch: 1 });
    expect(prepareOrderedPacingWorkState(saved)).toBe(saved);
    expect(saved.pacingAnchors).toEqual([0, 1, 5]);
    expect(saved.nextPacingBatch).toBe(1);
  });

  it("uses direct sentence-anchor pacing instructions and persists one corrective retry for a crammed plan", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("buildDirectAnchorPacingPrompt");
    expect(source).toContain("parseAndSanitizeAnchors");
    expect(source).toContain("sanitizeFinalAnchorSequence");
    expect(source).toContain("pacingQualityRetries");
    expect(source).toContain("direct sentence-anchor plan");
  });

  it("keeps hosted slice provider work inside the short callback boundary while retaining round-robin recovery for later callbacks", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("timeoutMs: 20_000");
    expect(source).toContain("{ maxAttempts: 1 }");
  });

  it("uses one persisted source-preparation marker instead of a separate WAV byte-only direct-upload branch", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("cached?.sourcePrepared && cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION");
    expect(source).toContain("const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength);");
    expect(source).toContain('fetchNarrationStorageRange(narration.storageKey, "bytes=0-65535")');
    expect(source).not.toContain("if (byteSize <= directLimit)");
  });

  it("versions unstarted WAV preparation plans while retaining any plan that already has completed transcription progress", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("const NARRATION_SOURCE_PREPARATION_VERSION = 8;");
    expect(source).toContain("cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION");
  });

  it("persists frame-aligned MP3 source ranges immediately instead of uploading every prepared child before progress can be saved", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("MP3_PREPARATION_SCAN_BYTES = 256 * 1024");
    expect(source).toContain("MP3_OVERLAP_BYTE_BUDGET = Math.floor(SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES * 0.25)");
    expect(source).toContain("HOSTED_STORAGE_READ_TIMEOUT_MS = 20_000");
    expect(source).toContain("scanMp3FrameRanges");
    expect(source).toContain("fetchNarrationStorageRange(narration.storageKey, `bytes=${preparation.nextByteOffset}-${preparation.nextByteOffset + MP3_PREPARATION_SCAN_BYTES - 1}`)");
    expect(source).not.toContain("transcription-chunks/${narration.id}-part-");
  });

  it("retains only the genuine first completed MP3 coverage when an old high-bitrate plan repeated the same source start", () => {
    const completed = (endMs: number, endByteExclusive: number) => ({ storageKey: "narration.mp3", sourceRange: { kind: "mp3" as const, startByte: 223, endByteExclusive }, startMs: 0, endMs, contentStartMs: 0, contentEndMs: endMs, byteSize: endByteExclusive - 223, status: "completed" as const, attempts: 1, transcript: { text: "saved", segments: [] } });
    const repaired = recoverLegacyInflatedMp3Preparation({ version: 2, chunkOverlapMs: 4_000, sourcePrepared: false, sourcePreparationVersion: 5, chunks: [completed(3264, 130_783), completed(3288, 131_743), { storageKey: "narration.mp3", sourceRange: { kind: "mp3", startByte: 223, endByteExclusive: 132_703 }, startMs: 0, endMs: 3312, contentStartMs: 0, contentEndMs: 3312, byteSize: 132_480, status: "pending", attempts: 0 }] });

    expect(repaired).toMatchObject({ sourcePreparationVersion: 8, sourcePrepared: false, chunks: [completed(3264, 130_783)], mp3Preparation: { nextByteOffset: 130_783, nextTimestampMs: 3264 } });
  });
});

describe("Gemini batch image analysis", () => {
  it("sends 10–12 images per Gemini call to match the 1M-token input budget", () => {
    expect(GEMINI_BATCH_IMAGES_PER_REQUEST).toBeGreaterThanOrEqual(10);
    expect(GEMINI_BATCH_IMAGES_PER_REQUEST).toBeLessThanOrEqual(12);
  });

  it("instructs Gemini to return a JSON object wrapping one object per image in upload order", () => {
    const prompt = buildGeminiBatchImageAnalysisPrompt(12);
    expect(prompt).toContain("12 images");
    expect(prompt).toContain("exactly one object per image");
    expect(prompt).toContain("sceneDescription");
    expect(prompt).toContain("\"images\"");
  });

  it("parses a batch JSON array back into per-image records and rejects a size mismatch", () => {
    const value = [
      { sceneDescription: "a", subjects: "s", setting: "t", mood: "m", relevance: "r" },
      { sceneDescription: "b", subjects: "s", setting: "t", mood: "m", relevance: "r" },
    ];
    expect(parseGeminiBatchImageAnalysis(value, 2)).toHaveLength(2);
    expect(parseGeminiBatchImageAnalysis({ images: value }, 2)).toHaveLength(2);
    expect(parseGeminiBatchImageAnalysis({ analyses: value }, 2)).toHaveLength(2);
    expect(parseGeminiBatchImageAnalysis({ result: value }, 2)).toHaveLength(2);
    expect(() => parseGeminiBatchImageAnalysis(value, 3)).toThrow(/2 image analyses for a 3-image batch/);
    expect(() => parseGeminiBatchImageAnalysis({}, 2)).toThrow(/0 image analyses for a 2-image batch/);
  });
});

describe("parseLineTranslations", () => {
  const lines = [
    { start: 0, end: 2, text: "क्योंकि महंगाई हर साल छह से सात percent" },
    { start: 2, end: 4, text: "Grocery का bill बढ़ता है," },
    { start: 4, end: 6, text: "बच्चों की school fees बढ़ती है." },
  ];

  it("replaces each line's text with its English translation, keeping timing", () => {
    const translated = parseLineTranslations({ translations: [
      { index: 0, text: "Because inflation every year six to seven percent" },
      { index: 1, text: "Grocery bill rises," },
      { index: 2, text: "children's school fees rise." },
    ] }, lines);
    expect(translated.map(line => line.text)).toEqual([
      "Because inflation every year six to seven percent",
      "Grocery bill rises,",
      "children's school fees rise.",
    ]);
    expect(translated.map(line => line.start)).toEqual([0, 2, 4]);
    expect(translated.map(line => line.end)).toEqual([2, 4, 6]);
  });

  it("falls back to the original text for any line the model skipped", () => {
    const translated = parseLineTranslations({ translations: [{ index: 1, text: "Grocery bill rises" }] }, lines);
    expect(translated[0].text).toBe("क्योंकि महंगाई हर साल छह से सात percent");
    expect(translated[1].text).toBe("Grocery bill rises");
    expect(translated[2].text).toBe("बच्चों की school fees बढ़ती है.");
  });

  it("returns the original lines unchanged for a malformed or empty response", () => {
    expect(parseLineTranslations(null, lines).map(line => line.text)).toEqual(lines.map(line => line.text));
    expect(parseLineTranslations({ translations: "nope" }, lines).map(line => line.text)).toEqual(lines.map(line => line.text));
  });
});
