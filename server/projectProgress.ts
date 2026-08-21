export type ProjectProcessingStage = "idle" | "transcribing" | "analyzing_images" | "building_timeline" | "finalizing" | "failed";

type ProgressInput = {
  status: string;
  processingStage: ProjectProcessingStage;
  processingStartedAt: Date | null;
  processingStageStartedAt: Date | null;
  totalImageCount: number;
  completedImageCount: number;
  narrationAnalyzed: boolean;
  audioDurationMs: number | null;
  narrationChunks?: { totalChunks: number; completedChunks: number; activeChunkIndex: number; chunkOverlapMs: number; state: "processing" | "waiting" | "completed"; lastError: { category: string; message: string; retryAfterMs?: number; httpStatus?: number; requestDurationMs: number } | null } | null;
  backgroundJob?: { status: "queued" | "processing" | "waiting_for_retry" | "completed" | "failed"; retryAt: Date | null; leaseExpiresAt?: Date | null; lastError: { message?: string } | null } | null;
  now?: Date;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function estimateInitialProjectProcessingMs(input: Pick<ProgressInput, "totalImageCount" | "audioDurationMs">) {
  const transcriptionMs = clamp(Math.round((input.audioDurationMs ?? 0) * 0.08) + 20_000, 20_000, 360_000);
  const imageAnalysisMs = Math.max(0, input.totalImageCount) * 3_600;
  const pacingMs = Math.ceil(Math.max(0, input.totalImageCount) / 24) * 30_000;
  return transcriptionMs + imageAnalysisMs + pacingMs;
}

function estimateRange(centerMs: number) {
  return { lowerMs: Math.round(centerMs * 0.72), upperMs: Math.round(centerMs * 1.45) };
}

export function buildProjectProcessingProgress(input: ProgressInput) {
  if (input.status !== "analyzing") return null;
  const now = input.now ?? new Date();
  const startedAt = input.processingStartedAt ?? now;
  const stageStartedAt = input.processingStageStartedAt ?? startedAt;
  const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const stageElapsedMs = Math.max(0, now.getTime() - stageStartedAt.getTime());
  const totalImageCount = Math.max(0, input.totalImageCount);
  const completedImageCount = clamp(input.completedImageCount, 0, totalImageCount);
  const initialEstimatedTotalMs = estimateInitialProjectProcessingMs({ totalImageCount, audioDurationMs: input.audioDurationMs });
  const stage = input.processingStage === "idle" ? "transcribing" : input.processingStage;
  let completedPercent = 0;
  let estimatedRemainingMs: number | null = null;
  let estimateSource: "preparing" | "observed" = "preparing";
  let label = "Preparing project analysis";
  let message = "Preparing the verified Groq processing workflow.";

  if (stage === "transcribing") {
    const chunkProgress = input.narrationChunks;
    const chunkFraction = chunkProgress?.totalChunks ? chunkProgress.completedChunks / chunkProgress.totalChunks : 0;
    completedPercent = 8 + Math.round(chunkFraction * 12);
    label = chunkProgress?.state === "waiting" ? "Groq transcription is waiting" : "Transcribing narration";
    message = chunkProgress
      ? chunkProgress.state === "waiting"
        ? `${chunkProgress.lastError?.message ?? "Groq rate limit reached."}${chunkProgress.lastError?.retryAfterMs ? ` Waiting ${Math.ceil(chunkProgress.lastError.retryAfterMs / 1000)} seconds before you retry chunk ${chunkProgress.activeChunkIndex} of ${chunkProgress.totalChunks}.` : ` Resume from chunk ${chunkProgress.activeChunkIndex} of ${chunkProgress.totalChunks} when the provider is ready.`}`
        : `Transcribing narration — chunk ${chunkProgress.activeChunkIndex} of ${chunkProgress.totalChunks}. Completed chunks are saved and will not be restarted.`
      : "Preparing timestamped Groq narration transcription.";
  } else if (stage === "analyzing_images") {
    completedPercent = totalImageCount ? 12 + Math.round((completedImageCount / totalImageCount) * 78) : 12;
    label = "Analyzing source images";
    message = `${completedImageCount} of ${totalImageCount} ordered images analyzed with the active Groq rotation pool.`;
    if (completedImageCount > 0) {
      const observedPerImageMs = Math.max(500, stageElapsedMs / completedImageCount);
      const pacingEstimateMs = Math.ceil(totalImageCount / 24) * 30_000;
      estimatedRemainingMs = Math.round(Math.max(0, totalImageCount - completedImageCount) * observedPerImageMs + pacingEstimateMs);
      estimateSource = "observed";
    }
  } else if (stage === "building_timeline") {
    completedPercent = 92;
    label = "Building the readable timeline";
    message = "All source images are analyzed. Visual durations are now being aligned to the complete narration.";
  } else if (stage === "finalizing") {
    completedPercent = 98;
    label = "Validating timeline coverage";
    message = "Checking that every image is ordered and the variable-duration timeline covers the narration continuously.";
  } else if (stage === "failed") {
    completedPercent = 0;
    label = "Processing needs attention";
    message = "The last processing attempt did not complete. You can retry once the reported issue is resolved.";
  }

  if (input.backgroundJob?.status === "queued") {
    completedPercent = 0;
    label = "Preparing Timeline Generation";
    message = "The hosted job is registered and starting now. It will continue independently of this browser.";
  } else if (input.backgroundJob?.status === "waiting_for_retry") {
    const retryAtMs = input.backgroundJob.retryAt?.getTime();
    label = "Waiting for Groq — retry scheduled automatically";
    message = `${input.backgroundJob.lastError?.message ?? "Groq temporarily refused the current work unit."}${retryAtMs ? ` The hosted job will retry automatically in about ${Math.max(0, Math.ceil((retryAtMs - now.getTime()) / 1000))} seconds.` : " The hosted job will retry automatically."}`;
  }

  const resumeRecommended = input.backgroundJob?.status === "processing"
    && Boolean(input.backgroundJob.leaseExpiresAt && input.backgroundJob.leaseExpiresAt.getTime() <= now.getTime());
  if (resumeRecommended) {
    label = "Timeline worker needs a safe resume";
    message = "The previous worker lease expired before it could continue. Resume server analysis uses your saved media and progress; it does not upload again.";
  }

  return {
    stage,
    label,
    message,
    completedPercent: clamp(completedPercent, 0, 100),
    narration: { status: input.narrationAnalyzed ? "completed" as const : stage === "transcribing" ? "processing" as const : "pending" as const, durationMs: input.audioDurationMs, chunks: input.narrationChunks ?? null },
    images: { completed: completedImageCount, total: totalImageCount },
    elapsedMs,
    startedAtMs: startedAt.getTime(),
    estimatedRemainingMs,
    estimatedRemainingRange: estimatedRemainingMs === null ? null : estimateRange(estimatedRemainingMs),
    estimatedAtMs: now.getTime(),
    initialEstimatedTotalMs,
    estimateSource,
    resumeRecommended,
  };
}
