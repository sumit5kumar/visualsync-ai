import { and, eq } from "drizzle-orm";
import { geminiApiKeys } from "../drizzle/schema";
import { decryptSecret } from "./crypto";
import { getDb } from "./db";
import { GeminiClient, GeminiRequestError, isTransientGeminiFailure, type GeminiClientOptions, type GeminiRequestMetadata } from "./geminiClient";
import { rateLimitCooldownMs } from "./groqRotation";

/**
 * Dynamic Gemini key pool. Works with any number of keys (1, 2, 3, 10, ...):
 * every active key joins the rotation, the least-recently-used eligible key is
 * reserved per request (round-robin), a 429 puts only that key on cooldown and
 * the request moves to the next key, and an invalid key is deactivated.
 * A 503/overloaded failure is model-wide, so it is NOT rotated across keys
 * (the client already retried with backoff + lite-model fallback); the hosted
 * job retries it later instead.
 */

type StoredGeminiKey = typeof geminiApiKeys.$inferSelect;
export type GeminiPoolStatus = StoredGeminiKey["testStatus"];
export type GeminiRotationCandidate = { id: number; testStatus: GeminiPoolStatus; cooldownUntil: Date | null; lastUsedAt: Date | null };

export class GeminiPoolExhaustedError extends Error {
  constructor(message = "No eligible Gemini keys are available. Add a verified Gemini key or wait for a rate-limited key cooldown to expire.", readonly metadata?: GeminiRequestMetadata) { super(message); }
}

/**
 * How long a Gemini key stays reserved after a successful request, to stay
 * inside the provider's 15-requests-per-minute limit before the pool hands
 * that key to the next caller. 4000 ms guarantees ~15 calls/min/key.
 */
export const GEMINI_COOLDOWN_AFTER_REQUEST_MS = 4_000;

export function isEligibleForGeminiRotation(candidate: GeminiRotationCandidate, now: Date) {
  if (candidate.testStatus === "verified") return !candidate.cooldownUntil || candidate.cooldownUntil <= now;
  return (candidate.testStatus === "quota_limited" || candidate.testStatus === "unavailable") && Boolean(candidate.cooldownUntil && candidate.cooldownUntil <= now);
}

/** Least-recently-used first (never-used keys first), id as a stable tie-breaker = round-robin across the pool. */
export function chooseLeastRecentlyUsedGeminiKey<T extends GeminiRotationCandidate>(candidates: T[], now: Date, excludeIds: ReadonlySet<number> = new Set()): T | null {
  const eligible = candidates.filter(candidate => !excludeIds.has(candidate.id) && isEligibleForGeminiRotation(candidate, now));
  eligible.sort((left, right) => (left.lastUsedAt?.getTime() ?? -1) - (right.lastUsedAt?.getTime() ?? -1) || left.id - right.id);
  return eligible[0] ?? null;
}

/** Cooldown for a 429: honor the provider's RetryInfo/Retry-After, else exponential 1m→15m by consecutive hits. */
export function geminiRateLimitCooldownMs(consecutiveRateLimits: number, retryAfterMs?: number) {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.round(retryAfterMs);
  return rateLimitCooldownMs(consecutiveRateLimits);
}

export function earliestGeminiCooldownMs(candidates: GeminiRotationCandidate[], now: Date) {
  const cooling = candidates.filter(candidate => candidate.testStatus !== "invalid" && candidate.cooldownUntil && candidate.cooldownUntil > now);
  if (!cooling.length) return null;
  return Math.max(0, Math.min(...cooling.map(candidate => candidate.cooldownUntil!.getTime())) - now.getTime());
}

export function publicGeminiPoolMetadata(key: { id: number; label: string; keyPrefix: string; keySuffix: string }) {
  return { id: key.id, label: key.label, maskedKey: `${key.keyPrefix}••••••••${key.keySuffix}` };
}

async function persistBestEffort(action: () => Promise<void>) {
  try { await action(); } catch { console.warn("[Gemini pool] Could not persist key audit state; retaining the provider outcome."); }
}

/** Provider-agnostic rotation loop (unit-testable without a database). */
export async function executeBoundedGeminiRotation<T, Key extends { id: number }>(input: {
  reserve: (attemptedIds: ReadonlySet<number>) => Promise<Key>;
  onSuccess: (key: Key) => Promise<void>;
  onFailure: (key: Key, error: GeminiRequestError) => Promise<void>;
  operation: (key: Key) => Promise<T>;
}) {
  const attemptedIds = new Set<number>();
  let lastRotatableError: GeminiRequestError | undefined;
  while (true) {
    let key: Key;
    try {
      key = await input.reserve(attemptedIds);
    } catch (error) {
      if (error instanceof GeminiPoolExhaustedError && lastRotatableError) {
        throw new GeminiPoolExhaustedError(lastRotatableError.status === "quota_limited" ? "Every eligible Gemini key reached a rate or quota limit. The job will retry after the cooldown." : "No remaining Gemini key accepted this request.", error.metadata ?? lastRotatableError.metadata);
      }
      throw error;
    }
    if (attemptedIds.has(key.id)) throw new GeminiPoolExhaustedError(undefined, lastRotatableError?.metadata);
    attemptedIds.add(key.id);
    try {
      const result = await input.operation(key);
      await persistBestEffort(() => input.onSuccess(key));
      return result;
    } catch (error) {
      if (!(error instanceof GeminiRequestError)) throw error;
      await persistBestEffort(() => input.onFailure(key, error));
      // Key-specific limits and model-wide busy (503/timeout) both cool this
      // key down and rotate to the next key. Only a genuinely bad request
      // (400 with client_request) is non-rotatable and thrown immediately.
      if (isTransientGeminiFailure(error) || error.status === "quota_limited" || error.status === "invalid") {
        lastRotatableError = error;
        continue;
      }
      throw error;
    }
  }
  // All keys exhausted (unreachable — the loop either returns or throws).
  throw new GeminiPoolExhaustedError("All Gemini keys failed this request. The job will retry after the cooldown.", lastRotatableError?.metadata);
}


async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  return db;
}

async function reserveNextGeminiKey(userId: number, attemptedIds: ReadonlySet<number>) {
  const db = await requireDb();
  const now = new Date();
  return db.transaction(async transaction => {
    const candidates = await transaction.select().from(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.isActive, true)));
    const selected = chooseLeastRecentlyUsedGeminiKey(candidates, now, attemptedIds);
    if (!selected) {
      const waitMs = earliestGeminiCooldownMs(candidates, now);
      if (waitMs !== null) throw new GeminiPoolExhaustedError("Every configured Gemini key has hit its provider rate or daily quota limit (e.g. the free tier). The Timeline job will retry automatically once the limit resets.", { durationMs: 0, category: "rate_limited", retryAfterMs: waitMs });
      throw new GeminiPoolExhaustedError();
    }
    await transaction.update(geminiApiKeys).set({ lastUsedAt: now }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, selected.id)));
    return selected;
  });
}

async function recordGeminiPoolSuccess(userId: number, keyId: number) {
  const db = await requireDb();
  const now = new Date();
  // Set a short cooldown after every successful request so this key is the
  // last candidate chosen on the next rotation pass (~15 req/min pacing).
  const cooldownUntil = new Date(now.getTime() + GEMINI_COOLDOWN_AFTER_REQUEST_MS);
  await db.update(geminiApiKeys).set({ testStatus: "verified", cooldownUntil, consecutiveRateLimits: 0, lastUsedAt: now }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, keyId)));
}

async function recordGeminiPoolFailure(userId: number, key: StoredGeminiKey, error: GeminiRequestError) {
  const db = await requireDb();
  const now = new Date();
  if (error.status === "quota_limited") {
    const consecutiveRateLimits = key.consecutiveRateLimits + 1;
    const cooldownMs = geminiRateLimitCooldownMs(consecutiveRateLimits, error.metadata.retryAfterMs);
    await db.update(geminiApiKeys).set({ testStatus: "quota_limited", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + cooldownMs), consecutiveRateLimits }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, key.id)));
    return;
  }
  if (error.status === "invalid") {
    await db.update(geminiApiKeys).set({ testStatus: "invalid", isActive: false, lastFailureAt: now }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, key.id)));
    return;
  }
  // Model-wide 503/timeout or a bad request: record the time, give the key a
  // short cooldown, and clear any stale "unavailable" flag so it stays
  // eligible for rotation on the next pass.
  await db.update(geminiApiKeys).set({ testStatus: "verified", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + GEMINI_COOLDOWN_AFTER_REQUEST_MS) }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, key.id)));
}

export async function executeWithGeminiRotation<T>(userId: number, operation: (client: GeminiClient, key: { id: number; label: string; maskedKey: string }) => Promise<T>, clientOptions?: GeminiClientOptions) {
  return executeBoundedGeminiRotation({
    reserve: attemptedIds => reserveNextGeminiKey(userId, attemptedIds),
    onSuccess: key => recordGeminiPoolSuccess(userId, key.id),
    onFailure: (key, error) => recordGeminiPoolFailure(userId, key, error),
    operation: async key => {
      const client = new GeminiClient(decryptSecret({ ciphertext: key.encryptedCiphertext, iv: key.encryptionIv, tag: key.encryptionTag }), undefined, clientOptions);
      return operation(client, publicGeminiPoolMetadata(key));
    },
  });
}

export async function countEligibleGeminiKeys(userId: number) {
  const db = await requireDb();
  const now = new Date();
  const candidates = await db.select().from(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.isActive, true)));
  return { active: candidates.length, eligibleNow: candidates.filter(candidate => isEligibleForGeminiRotation(candidate, now)).length };
}
