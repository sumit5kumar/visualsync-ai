export const MIN_READABLE_IMAGE_DURATION_MS = 2_200;
export const ABSOLUTE_MIN_IMAGE_DURATION_MS = 750;

export function resolveReadableMinimumDuration(totalDurationMs: number, imageCount: number, preferredMinimumDurationMs = MIN_READABLE_IMAGE_DURATION_MS) {
  if (!Number.isInteger(totalDurationMs) || totalDurationMs <= 0 || !Number.isInteger(imageCount) || imageCount <= 0) throw new Error("Narration duration and image count must be positive integers.");
  if (totalDurationMs < imageCount * ABSOLUTE_MIN_IMAGE_DURATION_MS) throw new Error(`Narration is too short to show every supplied image for the absolute minimum ${ABSOLUTE_MIN_IMAGE_DURATION_MS} ms.`);
  return Math.min(preferredMinimumDurationMs, Math.floor((totalDurationMs / imageCount) * 0.8));
}

export function distributeReadableWeightedDurations(totalDurationMs: number, weights: number[], minimumDurationMs = MIN_READABLE_IMAGE_DURATION_MS) {
  if (!Number.isInteger(totalDurationMs) || totalDurationMs <= 0) throw new Error("Timeline duration must be a positive integer.");
  if (!weights.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error("Every visual pacing weight must be a positive number.");
  if (!Number.isInteger(minimumDurationMs) || minimumDurationMs <= 0 || totalDurationMs < weights.length * minimumDurationMs) throw new Error("The requested readable visual duration cannot fit this narration.");

  const remainingMs = totalDurationMs - weights.length * minimumDurationMs;
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const exactExtras = weights.map(weight => (remainingMs * weight) / totalWeight);
  const extras = exactExtras.map(value => Math.floor(value));
  let undistributedMs = remainingMs - extras.reduce((sum, value) => sum + value, 0);
  const fractionalOrder = exactExtras.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const item of fractionalOrder) {
    if (!undistributedMs) break;
    extras[item.index] += 1;
    undistributedMs -= 1;
  }
  return extras.map(extra => minimumDurationMs + extra);
}

export function buildGlobalReadableImageDurations(totalDurationMs: number, groqWeights: number[]) {
  const minimumDurationMs = resolveReadableMinimumDuration(totalDurationMs, groqWeights.length);
  return { minimumDurationMs, durations: distributeReadableWeightedDurations(totalDurationMs, groqWeights, minimumDurationMs) };
}
