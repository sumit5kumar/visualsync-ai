export type RenderEstimateInput = {
  durationMs: number;
  imageCount: number;
  zoomEnabled: boolean;
  crossfadeDurationMs: number;
};

export type RenderEstimate = {
  lowerSeconds: number;
  upperSeconds: number;
  expectedSeconds: number;
  outputFrames: number;
};

/**
 * A deliberately approximate local-worker estimate. Smooth subpixel zoom is the costly path
 * because the worker prepares a 30 fps source frame sequence before direct-opacity compositing.
 */
export function estimateNativeRender(input: RenderEstimateInput): RenderEstimate | null {
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || !Number.isInteger(input.imageCount) || input.imageCount <= 0) return null;
  const durationSeconds = input.durationMs / 1000;
  const preparationSeconds = input.zoomEnabled
    ? durationSeconds * 5.6 + input.imageCount * 14
    : durationSeconds * 1.6 + input.imageCount * 3;
  const crossfadeSeconds = (input.crossfadeDurationMs / 1000) * Math.max(0, input.imageCount - 1) * 0.2;
  const expectedSeconds = Math.ceil(45 + preparationSeconds + crossfadeSeconds);
  return {
    expectedSeconds,
    lowerSeconds: Math.ceil(expectedSeconds * 0.75),
    upperSeconds: Math.ceil(expectedSeconds * 1.35),
    outputFrames: Math.ceil(durationSeconds * 30),
  };
}

export function formatRenderDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}
