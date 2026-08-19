export type PersistedKeyStatus = "untested" | "verified" | "invalid" | "permission_restricted" | "quota_limited" | "unavailable";

export function canActivateProviderKey(status: PersistedKeyStatus) {
  return status === "verified";
}

export function canRemoveProviderKey(isActive: boolean, verifiedAlternativeCount: number) {
  return !isActive || verifiedAlternativeCount > 0;
}

export function isDuplicateProviderKey(existingFingerprints: string[], candidateFingerprint: string) {
  return existingFingerprints.includes(candidateFingerprint);
}

export const canActivateGeminiKey = canActivateProviderKey;
export const canRemoveGeminiKey = canRemoveProviderKey;
export const isDuplicateGeminiKey = isDuplicateProviderKey;
