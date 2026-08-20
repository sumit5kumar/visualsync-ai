import { and, eq } from "drizzle-orm";
import { groqApiKeys, groqKeyRotationStates } from "../drizzle/schema";
import { decryptSecret } from "./crypto";
import { getDb } from "./db";
import { GroqClient, GroqRequestError, type GroqRequestMetadata } from "./groqClient";
import { chooseRoundRobinKey, isProjectVerifiedForAutomaticRotation, nextRotationCursor, providerRetryDelayMs } from "./groqRotation";

type StoredGroqKey = typeof groqApiKeys.$inferSelect;

export class GroqPoolExhaustedError extends Error {
  constructor(message = "No eligible Groq keys are available. Add a verified key or wait for a rate-limited key cooldown to expire.", readonly metadata?: GroqRequestMetadata) { super(message); }
}

function exhaustedPoolMessage(lastStatus?: GroqRequestError["status"]) {
  if (lastStatus === "quota_limited") return "Every eligible Groq key reached a rate or quota limit. Retry after the displayed cooldown.";
  if (lastStatus === "unavailable") return "Groq could not complete the request with any currently eligible key. Retry shortly; no key was marked invalid.";
  return "No eligible Groq keys are available. Add a verified key or wait for a rate-limited key cooldown to expire.";
}

export function publicGroqPoolMetadata(key: { id: number; label: string; keyPrefix: string; keySuffix: string }) {
  return { id: key.id, label: key.label, maskedKey: `${key.keyPrefix}••••••••${key.keySuffix}` };
}

async function persistPoolAuditBestEffort(action: () => Promise<void>, outcome: "success" | "failure") {
  try {
    await action();
  } catch {
    // A provider result has already been obtained. Do not discard it solely
    // because a non-secret health/audit update had a transient DB failure.
    console.warn(`[Groq pool] Could not persist key ${outcome} audit state; retaining the provider outcome.`);
  }
}

export async function executeBoundedGroqRotation<T, Key extends { id: number }>(input: {
  reserve: () => Promise<Key>;
  onSuccess: (key: Key) => Promise<void>;
  onFailure: (key: Key, error: GroqRequestError) => Promise<void>;
  operation: (key: Key) => Promise<T>;
  maxAttempts?: number;
}) {
  const attemptedIds = new Set<number>();
  let lastRetryableError: GroqRequestError | undefined;
  while (true) {
    if (input.maxAttempts !== undefined && attemptedIds.size >= input.maxAttempts) throw new GroqPoolExhaustedError(exhaustedPoolMessage(lastRetryableError?.status), lastRetryableError?.metadata);
    let key: Key;
    try { key = await input.reserve(); } catch (error) { if (error instanceof GroqPoolExhaustedError) throw new GroqPoolExhaustedError(exhaustedPoolMessage(lastRetryableError?.status), lastRetryableError?.metadata); throw error; }
    if (attemptedIds.has(key.id)) throw new GroqPoolExhaustedError(exhaustedPoolMessage(lastRetryableError?.status), lastRetryableError?.metadata);
    attemptedIds.add(key.id);
    try {
      const result = await input.operation(key);
      await persistPoolAuditBestEffort(() => input.onSuccess(key), "success");
      return result;
    } catch (error) {
      if (!(error instanceof GroqRequestError)) throw error;
      await persistPoolAuditBestEffort(() => input.onFailure(key, error), "failure");
      if (error.status === "invalid" || error.status === "unavailable") {
        lastRetryableError = error;
        continue;
      }
      throw error;
    }
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  return db;
}

async function reserveNextGroqKey(userId: number) {
  const db = await requireDb();
  const now = new Date();
  return db.transaction(async transaction => {
    const [state] = await transaction.select().from(groqKeyRotationStates).where(eq(groqKeyRotationStates.userId, userId)).limit(1);
    const storedCandidates = await transaction.select().from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.isActive, true)));
    const candidates = storedCandidates.filter(isProjectVerifiedForAutomaticRotation);
    const candidate = chooseRoundRobinKey(candidates, state?.nextRotationOrder ?? 0, now);
    if (!candidate) {
      const coolingKeys = candidates.filter(record => (record.testStatus === "quota_limited" || record.testStatus === "unavailable") && record.cooldownUntil && record.cooldownUntil > now);
      if (coolingKeys.length) {
        const retryAtMs = Math.min(...coolingKeys.map(record => record.cooldownUntil!.getTime()));
        throw new GroqPoolExhaustedError("All configured Groq keys are temporarily cooling down. The Timeline job will retry automatically.", { durationMs: 0, category: "rate_limited", retryAfterMs: Math.max(0, retryAtMs - now.getTime()) });
      }
      if (storedCandidates.length) throw new GroqPoolExhaustedError("No project-verified Groq key is eligible for automatic rotation. Verify the issuing Groq project before using another stored key.");
      throw new GroqPoolExhaustedError();
    }
    const selected = candidates.find(record => record.id === candidate.id);
    if (!selected) throw new GroqPoolExhaustedError("The selected Groq key is no longer available in this rotation pool.");
    await transaction.insert(groqKeyRotationStates).values({ userId, nextRotationOrder: nextRotationCursor(candidate) }).onDuplicateKeyUpdate({ set: { nextRotationOrder: nextRotationCursor(candidate) } });
    await transaction.update(groqApiKeys).set({ lastUsedAt: now, testStatus: "verified", cooldownUntil: null }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, selected.id)));
    return selected;
  });
}

async function recordGroqPoolSuccess(userId: number, keyId: number) {
  const db = await requireDb();
  await db.update(groqApiKeys).set({ testStatus: "verified", cooldownUntil: null, consecutiveRateLimits: 0, lastUsedAt: new Date() }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
}

async function recordGroqPoolFailure(userId: number, key: StoredGroqKey, error: GroqRequestError) {
  const db = await requireDb();
  const now = new Date();
  if (error.status === "request_too_large" || error.status === "prompt_error") return;
  if (error.status === "quota_limited") {
    const consecutiveRateLimits = key.consecutiveRateLimits + 1;
    const retryDelayMs = providerRetryDelayMs(error.metadata);
    await db.update(groqApiKeys).set({ testStatus: "quota_limited", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + (retryDelayMs ?? 0)), consecutiveRateLimits }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
    return;
  }
  if (error.status === "invalid") {
    await db.update(groqApiKeys).set({ testStatus: "invalid", isActive: false, lastFailureAt: now }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
    return;
  }
  if (error.status === "permission_restricted") {
    await db.update(groqApiKeys).set({ testStatus: "permission_restricted", lastFailureAt: now, cooldownUntil: null }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
    return;
  }
  await db.update(groqApiKeys).set({ testStatus: "verified", lastFailureAt: now, cooldownUntil: null }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
}

export async function executeWithGroqRotation<T>(userId: number, operation: (client: GroqClient, key: { id: number; label: string; maskedKey: string }) => Promise<T>, options?: { maxAttempts?: number }) {
  return executeBoundedGroqRotation({
    reserve: () => reserveNextGroqKey(userId),
    onSuccess: key => recordGroqPoolSuccess(userId, key.id),
    onFailure: (key, error) => recordGroqPoolFailure(userId, key, error),
    maxAttempts: options?.maxAttempts,
    operation: async key => {
      const metadata = publicGroqPoolMetadata(key);
      const client = new GroqClient(decryptSecret({ ciphertext: key.encryptedCiphertext, iv: key.encryptionIv, tag: key.encryptionTag }));
      return operation(client, metadata);
    },
  });
}
