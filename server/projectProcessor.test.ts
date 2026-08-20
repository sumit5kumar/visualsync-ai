import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPublicManagedStorageUrl, isWavNarration, mapWithConcurrency, normalizeTimelineGenerationWorkState } from "./projectProcessor";

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
    expect(source).toContain("headers: { Range: \"bytes=0-65535\" }");
    expect(source).not.toContain("if (byteSize <= directLimit)");
  });

  it("versions unstarted WAV preparation plans while retaining any plan that already has completed transcription progress", () => {
    const source = readFileSync(resolve(process.cwd(), "server/projectProcessor.ts"), "utf8");
    expect(source).toContain("const NARRATION_SOURCE_PREPARATION_VERSION = 3;");
    expect(source).toContain("cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || hasCompletedChunk");
  });
});
