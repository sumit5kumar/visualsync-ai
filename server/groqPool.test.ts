import { describe, expect, it, vi } from "vitest";
import { GroqRequestError } from "./groqClient";
import { executeBoundedGroqRotation, GroqPoolExhaustedError, publicGroqPoolMetadata } from "./groqPool";

describe("Groq pool executor", () => {
  it("stops after each eligible key has been attempted and returns a bounded exhausted-pool error", async () => {
    const keys = [{ id: 1 }, { id: 2 }, { id: 1 }];
    const reserve = vi.fn(async () => keys.shift()!);
    const onFailure = vi.fn(async () => undefined);

    await expect(executeBoundedGroqRotation({
      reserve,
      onSuccess: async () => undefined,
      onFailure,
      operation: async () => { throw new GroqRequestError("rate limit", "quota_limited"); },
    })).rejects.toBeInstanceOf(GroqPoolExhaustedError);

    expect(reserve).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("does not disclose raw failure text or API-key-shaped values when the pool is exhausted", async () => {
    const rawSecret = "gsk_this_must_never_appear_in_pool_errors";
    const keys = [{ id: 1 }, { id: 1 }];

    const failure = executeBoundedGroqRotation({
      reserve: async () => keys.shift()!,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      operation: async () => { throw new GroqRequestError(`upstream failed with ${rawSecret}`, "quota_limited"); },
    });

    await expect(failure).rejects.toMatchObject({ message: "All currently eligible Groq keys were attempted for this request." });
    await failure.catch(error => expect(error.message).not.toContain(rawSecret));
  });

  it("builds public rotation metadata with only a label and masked key, never the encrypted or decrypted secret", () => {
    const rawSecret = "gsk_never_expose_this_secret";
    const metadata = publicGroqPoolMetadata({ id: 7, label: "Rotation key", keyPrefix: "gsk_", keySuffix: "tail" });

    expect(metadata).toEqual({ id: 7, label: "Rotation key", maskedKey: "gsk_••••••••tail" });
    expect(JSON.stringify(metadata)).not.toContain(rawSecret);
    expect(Object.keys(metadata)).toEqual(["id", "label", "maskedKey"]);
  });

  it("keeps raw retry text out of the final surfaced exhausted-pool error", async () => {
    const rawSecret = "gsk_retry_path_must_stay_private";
    const keys = [{ id: 4 }, { id: 4 }];
    const result = executeBoundedGroqRotation({
      reserve: async () => keys.shift()!,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      operation: async () => { throw new GroqRequestError(`retry failure ${rawSecret}`, "unavailable"); },
    });

    await expect(result).rejects.toBeInstanceOf(GroqPoolExhaustedError);
    await result.catch(error => expect(`${error.name}:${error.message}`).not.toContain(rawSecret));
  });
});
