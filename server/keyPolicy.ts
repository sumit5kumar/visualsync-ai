export type PersistedKeyStatus = "untested" | "verified" | "invalid" | "quota_limited" | "unavailable";

export function canActivateGeminiKey(status: PersistedKeyStatus) {
  return status === "verified";
}

export function canRemoveGeminiKey(isActive: boolean, verifiedAlternativeCount: number) {
  return !isActive || verifiedAlternativeCount > 0;
}

export function isDuplicateGeminiKey(existingFingerprints: string[], candidateFingerprint: string) {
  return existingFingerprints.includes(candidateFingerprint);
}
