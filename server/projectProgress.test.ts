import { describe, expect, it } from "vitest";
import { buildProjectProcessingProgress, estimateInitialProjectProcessingMs } from "./projectProgress";

describe("project processing progress", () => {
  it("creates an initial bounded estimate for a 30-minute narration with 300 images", () => {
    const estimateMs = estimateInitialProjectProcessingMs({ totalImageCount: 300, audioDurationMs: 30 * 60 * 1000 });

    expect(estimateMs).toBeGreaterThan(20 * 60 * 1000);
    expect(estimateMs).toBeLessThan(45 * 60 * 1000);
  });

  it("shows preparation without an invented ETA until real work has produced observable timing", () => {
    const progress = buildProjectProcessingProgress({ status: "analyzing", processingStage: "transcribing", processingStartedAt: new Date("2026-08-19T19:00:00.000Z"), processingStageStartedAt: new Date("2026-08-19T19:00:00.000Z"), totalImageCount: 18, completedImageCount: 0, narrationAnalyzed: false, audioDurationMs: 67_451, backgroundJob: { status: "queued", retryAt: null, lastError: null }, now: new Date("2026-08-19T19:00:30.000Z") });

    expect(progress).toMatchObject({ label: "Preparing Timeline Generation", completedPercent: 0, estimateSource: "preparing", estimatedRemainingMs: null, estimatedRemainingRange: null });
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

  it("restores a server-persisted hosted retry state after the browser returns", () => {
    const now = new Date("2026-08-18T10:00:00.000Z");
    const progress = buildProjectProcessingProgress({ status: "analyzing", processingStage: "transcribing", processingStartedAt: new Date("2026-08-18T09:00:00.000Z"), processingStageStartedAt: new Date("2026-08-18T09:30:00.000Z"), totalImageCount: 298, completedImageCount: 0, narrationAnalyzed: false, audioDurationMs: 31 * 60 * 1000, narrationChunks: { totalChunks: 448, completedChunks: 200, activeChunkIndex: 201, chunkOverlapMs: 4_000, state: "waiting", lastError: null }, backgroundJob: { status: "waiting_for_retry", retryAt: new Date("2026-08-18T10:02:00.000Z"), lastError: { message: "Groq audio quota is currently exhausted." } }, now });

    expect(progress?.label).toBe("Waiting for Groq — retry scheduled automatically");
    expect(progress?.message).toContain("retry automatically in about 120 seconds");
    expect(progress?.narration.chunks?.completedChunks).toBe(200);
  });

  it("offers a safe signed-in resume when a worker lease expired before queued narration work could continue", () => {
    const progress = buildProjectProcessingProgress({ status: "analyzing", processingStage: "transcribing", processingStartedAt: new Date("2026-08-21T19:04:00.000Z"), processingStageStartedAt: new Date("2026-08-21T19:04:00.000Z"), totalImageCount: 6, completedImageCount: 0, narrationAnalyzed: false, audioDurationMs: 1_000_512, backgroundJob: { status: "processing", retryAt: null, leaseExpiresAt: new Date("2026-08-21T19:07:03.000Z"), lastError: null }, now: new Date("2026-08-21T19:08:00.000Z") });

    expect(progress).toMatchObject({ label: "Timeline worker needs a safe resume", resumeRecommended: true });
    expect(progress?.message).toContain("does not upload again");
  });

  it("does not invent live progress for projects that are not currently analyzing", () => {
    expect(buildProjectProcessingProgress({ status: "timeline_ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null, totalImageCount: 300, completedImageCount: 300, narrationAnalyzed: true, audioDurationMs: 30 * 60 * 1000 })).toBeNull();
  });
});
