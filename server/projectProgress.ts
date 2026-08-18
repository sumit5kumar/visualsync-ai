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
  let estimatedRemainingMs = Math.max(0, initialEstimatedTotalMs - elapsedMs);
  let estimateSource: "initial" | "observed" = "initial";
  let label = "Preparing project analysis";
  let message = "Preparing the verified Groq processing workflow.";

  if (stage === "transcribing") {
    completedPercent = 8;
    label = "Analyzing narration";
    message = "Groq returns narration transcription as one completed result, so partial audio minutes are not fabricated.";
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
    estimatedRemainingMs = Math.max(10_000, Math.ceil(totalImageCount / 24) * 30_000 - stageElapsedMs);
  } else if (stage === "finalizing") {
    completedPercent = 98;
    label = "Validating timeline coverage";
    message = "Checking that every image is ordered and the variable-duration timeline covers the narration continuously.";
    estimatedRemainingMs = Math.max(5_000, 20_000 - stageElapsedMs);
  } else if (stage === "failed") {
    completedPercent = 0;
    label = "Processing needs attention";
    message = "The last processing attempt did not complete. You can retry once the reported issue is resolved.";
    estimatedRemainingMs = 0;
  }

  return {
    stage,
    label,
    message,
    completedPercent: clamp(completedPercent, 0, 100),
    narration: { status: input.narrationAnalyzed ? "completed" as const : stage === "transcribing" ? "processing" as const : "pending" as const, durationMs: input.audioDurationMs },
    images: { completed: completedImageCount, total: totalImageCount },
    elapsedMs,
    startedAtMs: startedAt.getTime(),
    estimatedRemainingMs,
    estimatedRemainingRange: estimateRange(estimatedRemainingMs),
    estimatedAtMs: now.getTime(),
    initialEstimatedTotalMs,
    estimateSource,
  };
}
