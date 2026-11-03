import { describe, expect, it, vi } from "vitest";
import { GeminiRequestError } from "./geminiClient";
import { GeminiPoolExhaustedError, chooseLeastRecentlyUsedGeminiKey, earliestGeminiCooldownMs, executeBoundedGeminiRotation, geminiRateLimitCooldownMs, isEligibleForGeminiRotation, type GeminiRotationCandidate } from "./geminiPool";

const now = new Date("2026-10-29T12:00:00Z");
const key = (id: number, overrides: Partial<GeminiRotationCandidate> = {}): GeminiRotationCandidate => ({ id, testStatus: "verified", cooldownUntil: null, lastUsedAt: null, ...overrides });

/** In-memory pool that mimics reserve/onSuccess/onFailure persistence for any key count. */
function memoryPool(keys: GeminiRotationCandidate[]) {
  let clock = now.getTime();
  return {
    keys,
    reserve: async (attempted: ReadonlySet<number>) => {
      const selected = chooseLeastRecentlyUsedGeminiKey(keys, new Date(clock), attempted);
      if (!selected) {
        const waitMs = earliestGeminiCooldownMs(keys, new Date(clock));
        throw new GeminiPoolExhaustedError("exhausted", waitMs === null ? undefined : { durationMs: 0, category: "rate_limited", retryAfterMs: waitMs });
      }
      clock += 1;
      selected.lastUsedAt = new Date(clock);
      return selected;
    },
    onSuccess: async () => undefined,
    onFailure: async (failed: GeminiRotationCandidate, error: GeminiRequestError) => {
      if (error.status === "quota_limited") { failed.testStatus = "quota_limited"; failed.cooldownUntil = new Date(clock + geminiRateLimitCooldownMs(1, error.metadata.retryAfterMs)); }
      if (error.status === "invalid") failed.testStatus = "invalid";
    },
  };
}

describe("dynamic Gemini key pool", () => {
  it.each([2, 3, 10])("round-robins evenly across %i keys", async count => {
    const pool = memoryPool(Array.from({ length: count }, (_, index) => key(index + 1)));
    const used: number[] = [];
    for (let call = 0; call < count * 2; call += 1) {
      await executeBoundedGeminiRotation({ ...pool, operation: async selected => { used.push(selected.id); return "ok"; } });
    }
    const ids = Array.from({ length: count }, (_, index) => index + 1);
    expect(used).toEqual([...ids, ...ids]);
  });

  it("puts only the 429 key on cooldown and finishes the same request on the next key", async () => {
    const pool = memoryPool([key(1), key(2), key(3)]);
    const operation = vi.fn(async (selected: GeminiRotationCandidate) => {
      if (selected.id === 1) throw new GeminiRequestError("rate", "quota_limited", { durationMs: 1, category: "rate_limited", httpStatus: 429, retryAfterMs: 30_000 });
      return selected.id;
    });
    await expect(executeBoundedGeminiRotation({ ...pool, operation })).resolves.toBe(2);
    expect(pool.keys[0]).toMatchObject({ testStatus: "quota_limited" });
    expect(pool.keys[0].cooldownUntil!.getTime()).toBeGreaterThan(now.getTime() + 29_000);
    // Next request skips the cooling key.
    await expect(executeBoundedGeminiRotation({ ...pool, operation })).resolves.toBe(3);
  });

  it("raises a retryable pool-exhausted error with the earliest cooldown when every key is rate limited", async () => {
    const pool = memoryPool([key(1), key(2)]);
    const error = await executeBoundedGeminiRotation({ ...pool, operation: async () => { throw new GeminiRequestError("rate", "quota_limited", { durationMs: 1, category: "rate_limited", httpStatus: 429, retryAfterMs: 20_000 }); } }).catch(caught => caught);
    expect(error).toBeInstanceOf(GeminiPoolExhaustedError);
    expect(error.metadata).toMatchObject({ category: "rate_limited" });
    expect(error.metadata.retryAfterMs).toBeGreaterThan(19_000);
  });

  it("cools every key on a model-wide 503 and retries later instead of failing", async () => {
    const pool = memoryPool([key(1), key(2), key(3)]);
    const operation = vi.fn(async () => { throw new GeminiRequestError("busy", "unavailable", { durationMs: 1, category: "server_error", httpStatus: 503 }); });
    const error = await executeBoundedGeminiRotation({ ...pool, operation }).catch(caught => caught);
    // Every key is attempted (rotation across the pool), and none is demoted
    // to a non-verified state — they just go on a short cooldown.
    expect(operation).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(GeminiPoolExhaustedError);
    expect(error.metadata?.category).toBe("server_error");
    expect(pool.keys.every(candidate => candidate.testStatus === "verified")).toBe(true);
  });

  it("skips an invalid key and continues with the remaining pool", async () => {
    const pool = memoryPool([key(1), key(2)]);
    const result = await executeBoundedGeminiRotation({ ...pool, operation: async selected => { if (selected.id === 1) throw new GeminiRequestError("bad", "invalid", { durationMs: 1, category: "invalid_key", httpStatus: 401 }); return selected.id; } });
    expect(result).toBe(2);
    expect(pool.keys[0].testStatus).toBe("invalid");
  });

  it("re-admits a rate-limited key once its cooldown has expired", () => {
    expect(isEligibleForGeminiRotation(key(1, { testStatus: "quota_limited", cooldownUntil: new Date(now.getTime() - 1) }), now)).toBe(true);
    expect(isEligibleForGeminiRotation(key(1, { testStatus: "quota_limited", cooldownUntil: new Date(now.getTime() + 1) }), now)).toBe(false);
    expect(isEligibleForGeminiRotation(key(1, { testStatus: "invalid" }), now)).toBe(false);
    expect(geminiRateLimitCooldownMs(1)).toBe(60_000);
    expect(geminiRateLimitCooldownMs(3, 5_000)).toBe(5_000);
  });
});
