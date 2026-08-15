import { describe, expect, it } from "vitest";
import { chooseRoundRobinKey, isEligibleForGroqRotation, rateLimitCooldownMs } from "./groqRotation";

const now = new Date("2026-08-15T00:00:00.000Z");
const key = (id: number, rotationOrder: number, testStatus: "verified" | "quota_limited" | "invalid" | "unavailable" | "untested" = "verified", cooldownUntil: Date | null = null) => ({ id, rotationOrder, testStatus, cooldownUntil });

describe("Groq rotation policy", () => {
  it("uses the next round-robin key in rotation order instead of retrying the first key", () => {
    const keys = [key(10, 0), key(11, 1), key(12, 2)];
    expect(chooseRoundRobinKey(keys, 0, now)?.id).toBe(10);
    expect(chooseRoundRobinKey(keys, 1, now)?.id).toBe(11);
    expect(chooseRoundRobinKey(keys, 2, now)?.id).toBe(12);
    expect(chooseRoundRobinKey(keys, 3, now)?.id).toBe(10);
  });

  it("skips rate-limited keys until their cooldown has elapsed", () => {
    const cooling = key(10, 0, "quota_limited", new Date(now.getTime() + 60_000));
    const healthy = key(11, 1);
    expect(isEligibleForGroqRotation(cooling, now)).toBe(false);
    expect(chooseRoundRobinKey([cooling, healthy], 0, now)?.id).toBe(11);
  });

  it("returns a recovered quota-limited key to the pool when its cooldown expires", () => {
    const recovered = key(10, 0, "quota_limited", new Date(now.getTime() - 1));
    expect(isEligibleForGroqRotation(recovered, now)).toBe(true);
    expect(chooseRoundRobinKey([recovered], 0, now)?.id).toBe(10);
  });

  it("uses bounded exponential cooldowns for repeated rate limits", () => {
    expect(rateLimitCooldownMs(1)).toBe(60_000);
    expect(rateLimitCooldownMs(2)).toBe(120_000);
    expect(rateLimitCooldownMs(5)).toBe(15 * 60_000);
    expect(rateLimitCooldownMs(12)).toBe(15 * 60_000);
  });
});
