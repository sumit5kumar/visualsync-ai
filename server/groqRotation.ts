export type GroqPoolStatus = "untested" | "verified" | "quota_limited" | "invalid" | "unavailable";

export type RotationCandidate = {
  id: number;
  rotationOrder: number;
  testStatus: GroqPoolStatus;
  cooldownUntil: Date | null;
};

export function isEligibleForGroqRotation(candidate: RotationCandidate, now: Date) {
  return candidate.testStatus === "verified" || (candidate.testStatus === "quota_limited" && Boolean(candidate.cooldownUntil && candidate.cooldownUntil <= now));
}

export function chooseRoundRobinKey(candidates: RotationCandidate[], nextRotationOrder: number, now: Date) {
  const eligible = candidates.filter(candidate => isEligibleForGroqRotation(candidate, now)).sort((left, right) => left.rotationOrder - right.rotationOrder || left.id - right.id);
  if (!eligible.length) return null;
  return eligible.find(candidate => candidate.rotationOrder >= nextRotationOrder) ?? eligible[0];
}

export function nextRotationCursor(candidate: RotationCandidate) {
  return candidate.rotationOrder + 1;
}

export function rateLimitCooldownMs(consecutiveRateLimits: number) {
  const normalized = Math.max(1, consecutiveRateLimits);
  return Math.min(15 * 60_000, 60_000 * 2 ** (normalized - 1));
}
