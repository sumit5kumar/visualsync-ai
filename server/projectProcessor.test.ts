import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPublicManagedStorageUrl, isWavNarration, mapWithConcurrency, normalizeTimelineGenerationWorkState, recoverLegacyInflatedMp3Preparation } from "./projectProcessor";

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
    expect(normalizeTimelineGenerationWorkState({ firstDispatchAtMs: 1_787_173_659_541, preflightComplete: true, pacingWeights: [1.2], nextPacingBatch: 1 })).toMatchObject({
      firstDispatchAtMs: 1_787_173_659_541,
      preflightComplete: true,
      pacingWeights: [1.2],
      nextPacingBatch: 1,
    });
  });

  it("keeps hosted slice provider work inside the short callback boundary while retaining round-robin recovery for later callbacks", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("timeoutMs: 20_000");
    expect(source).toContain("{ maxAttempts: 1 }");
  });

  it("uses one persisted source-preparation marker instead of a separate WAV byte-only direct-upload branch", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("cached?.sourcePrepared && (cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || hasCompletedChunk)");
    expect(source).toContain("const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength);");
    expect(source).toContain('fetchNarrationStorageRange(narration.storageKey, "bytes=0-65535")');
    expect(source).not.toContain("if (byteSize <= directLimit)");
  });

  it("versions unstarted WAV preparation plans while retaining any plan that already has completed transcription progress", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("const NARRATION_SOURCE_PREPARATION_VERSION = 6;");
    expect(source).toContain("cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || hasCompletedChunk");
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

    expect(repaired).toMatchObject({ sourcePreparationVersion: 6, sourcePrepared: false, chunks: [completed(3264, 130_783)], mp3Preparation: { nextByteOffset: 130_783, nextTimestampMs: 3264 } });
  });
});
