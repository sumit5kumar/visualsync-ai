import { and, eq } from "drizzle-orm";
import { groqApiKeys, groqKeyRotationStates } from "../drizzle/schema";
import { decryptSecret } from "./crypto";
import { getDb } from "./db";
import { GroqClient, GroqRequestError } from "./groqClient";
import { chooseRoundRobinKey, nextRotationCursor, rateLimitCooldownMs } from "./groqRotation";

type StoredGroqKey = typeof groqApiKeys.$inferSelect;

export class GroqPoolExhaustedError extends Error {
  constructor(message = "No eligible Groq keys are available. Add a verified key or wait for a rate-limited key cooldown to expire.") { super(message); }
}

function exhaustedPoolMessage(lastStatus?: GroqRequestError["status"]) {
  if (lastStatus === "quota_limited") return "Every eligible Groq key reached a rate or quota limit. Retry after the displayed cooldown.";
  if (lastStatus === "unavailable") return "Groq could not be reached using any currently eligible key. The keys were temporarily cooled down; retry shortly.";
  return "No eligible Groq keys are available. Add a verified key or wait for a rate-limited key cooldown to expire.";
}

export function publicGroqPoolMetadata(key: { id: number; label: string; keyPrefix: string; keySuffix: string }) {
  return { id: key.id, label: key.label, maskedKey: `${key.keyPrefix}••••••••${key.keySuffix}` };
}

export async function executeBoundedGroqRotation<T, Key extends { id: number }>(input: {
  reserve: () => Promise<Key>;
  onSuccess: (key: Key) => Promise<void>;
  onFailure: (key: Key, error: GroqRequestError) => Promise<void>;
  operation: (key: Key) => Promise<T>;
}) {
  const attemptedIds = new Set<number>();
  let lastRetryableStatus: GroqRequestError["status"] | undefined;
  while (true) {
    let key: Key;
    try { key = await input.reserve(); } catch (error) { if (error instanceof GroqPoolExhaustedError) throw new GroqPoolExhaustedError(exhaustedPoolMessage(lastRetryableStatus)); throw error; }
    if (attemptedIds.has(key.id)) throw new GroqPoolExhaustedError(exhaustedPoolMessage(lastRetryableStatus));
    attemptedIds.add(key.id);
    try {
      const result = await input.operation(key);
      await input.onSuccess(key);
      return result;
    } catch (error) {
      if (!(error instanceof GroqRequestError)) throw error;
      await input.onFailure(key, error);
      if (error.status === "invalid" || error.status === "quota_limited" || error.status === "unavailable") {
        lastRetryableStatus = error.status;
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
    const candidates = await transaction.select().from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.isActive, true)));
    const candidate = chooseRoundRobinKey(candidates, state?.nextRotationOrder ?? 0, now);
    if (!candidate) throw new GroqPoolExhaustedError();
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
    await db.update(groqApiKeys).set({ testStatus: "quota_limited", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + rateLimitCooldownMs(consecutiveRateLimits)), consecutiveRateLimits }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
    return;
  }
  if (error.status === "invalid") {
    await db.update(groqApiKeys).set({ testStatus: "invalid", isActive: false, lastFailureAt: now }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
    return;
  }
  await db.update(groqApiKeys).set({ testStatus: "unavailable", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + 120_000) }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, key.id)));
}

export async function executeWithGroqRotation<T>(userId: number, operation: (client: GroqClient, key: { id: number; label: string; maskedKey: string }) => Promise<T>) {
  return executeBoundedGroqRotation({
    reserve: () => reserveNextGroqKey(userId),
    onSuccess: key => recordGroqPoolSuccess(userId, key.id),
    onFailure: (key, error) => recordGroqPoolFailure(userId, key, error),
    operation: async key => {
      const metadata = publicGroqPoolMetadata(key);
      const client = new GroqClient(decryptSecret({ ciphertext: key.encryptedCiphertext, iv: key.encryptionIv, tag: key.encryptionTag }));
      return operation(client, metadata);
    },
  });
}
