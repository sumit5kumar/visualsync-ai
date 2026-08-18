import { describe, expect, it } from "vitest";
import { buildProjectProcessingProgress, estimateInitialProjectProcessingMs } from "./projectProgress";

describe("project processing progress", () => {
  it("creates an initial bounded estimate for a 30-minute narration with 300 images", () => {
    const estimateMs = estimateInitialProjectProcessingMs({ totalImageCount: 300, audioDurationMs: 30 * 60 * 1000 });

    expect(estimateMs).toBeGreaterThan(20 * 60 * 1000);
    expect(estimateMs).toBeLessThan(45 * 60 * 1000);
  });

  it("reports truthful image counts and uses observed image speed after real completions", () => {
    const now = new Date("2026-08-18T10:10:00.000Z");
    const progress = buildProjectProcessingProgress({ status: "analyzing", processingStage: "analyzing_images", processingStartedAt: new Date("2026-08-18T10:00:00.000Z"), processingStageStartedAt: new Date("2026-08-18T10:05:00.000Z"), totalImageCount: 300, completedImageCount: 75, narrationAnalyzed: true, audioDurationMs: 30 * 60 * 1000, now });

    expect(progress).toMatchObject({ stage: "analyzing_images", completedPercent: 32, narration: { status: "completed" }, images: { completed: 75, total: 300 }, estimateSource: "observed" });
    expect(progress?.estimatedRemainingMs).toBeGreaterThan(0);
  });

  it("reports saved narration chunks and provider wait guidance without inventing completed audio", () => {
    const progress = buildProjectProcessingProgress({ status: "analyzing", processingStage: "transcribing", processingStartedAt: new Date("2026-08-18T10:00:00.000Z"), processingStageStartedAt: new Date("2026-08-18T10:00:00.000Z"), totalImageCount: 298, completedImageCount: 0, narrationAnalyzed: false, audioDurationMs: 31 * 60 * 1000, narrationChunks: { totalChunks: 12, completedChunks: 8, activeChunkIndex: 9, chunkOverlapMs: 4_000, state: "waiting", lastError: { category: "rate_limited", message: "Groq rate limit reached.", retryAfterMs: 18_000, httpStatus: 429, requestDurationMs: 650 } } });

    expect(progress).toMatchObject({ label: "Groq transcription is waiting", narration: { status: "processing", chunks: { completedChunks: 8, activeChunkIndex: 9, state: "waiting" } } });
    expect(progress?.message).toContain("Waiting 18 seconds");
  });

  it("does not invent live progress for projects that are not currently analyzing", () => {
    expect(buildProjectProcessingProgress({ status: "timeline_ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null, totalImageCount: 300, completedImageCount: 300, narrationAnalyzed: true, audioDurationMs: 30 * 60 * 1000 })).toBeNull();
  });
});
