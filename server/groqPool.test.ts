import { describe, expect, it, vi } from "vitest";
import { GroqRequestError } from "./groqClient";
import { executeBoundedGroqRotation, GroqPoolExhaustedError, publicGroqPoolMetadata } from "./groqPool";

describe("Groq pool executor", () => {
  it("surfaces a provider rate limit immediately instead of rotating to bypass the provider limit", async () => {
    const keys = [{ id: 1 }, { id: 2 }, { id: 1 }];
    const reserve = vi.fn(async () => keys.shift()!);
    const onFailure = vi.fn(async () => undefined);

    await expect(executeBoundedGroqRotation({
      reserve,
      onSuccess: async () => undefined,
      onFailure,
      operation: async () => { throw new GroqRequestError("rate limit", "quota_limited"); },
    })).rejects.toMatchObject({ status: "quota_limited" });

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("does not disclose raw failure text or API-key-shaped values when the pool is exhausted", async () => {
    const rawSecret = "gsk_this_must_never_appear_in_pool_errors";
    const keys = [{ id: 1 }, { id: 1 }];

    const failure = executeBoundedGroqRotation({
      reserve: async () => keys.shift()!,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      operation: async () => { throw new GroqRequestError(`upstream failed with ${rawSecret}`, "unavailable"); },
    });

    await expect(failure).rejects.toMatchObject({ message: "Groq could not complete the request with any currently eligible key. Retry shortly; no key was marked invalid." });
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

  it("retries the next eligible key after a transport-level Groq unavailable error", async () => {
    const keys = [{ id: 11 }, { id: 12 }];
    const onSuccess = vi.fn(async () => undefined);
    const onFailure = vi.fn(async () => undefined);

    const result = await executeBoundedGroqRotation({
      reserve: async () => keys.shift()!,
      onSuccess,
      onFailure,
      operation: async key => {
        if (key.id === 11) throw new GroqRequestError("Groq could not be reached for this request.", "unavailable");
        return "processed";
      },
    });

    expect(result).toBe("processed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ id: 11 }, expect.objectContaining({ status: "unavailable" }));
    expect(onSuccess).toHaveBeenCalledWith({ id: 12 });
  });

  it("tries another verified key after a provider-wide server error without suppressing the safe metadata", async () => {
    const keys = [{ id: 51 }, { id: 52 }];
    const reserve = vi.fn(async () => keys.shift()!);
    const onFailure = vi.fn(async () => undefined);
    const result = executeBoundedGroqRotation({
      reserve,
      onSuccess: async () => undefined,
      onFailure,
      operation: async key => {
        if (key.id === 51) throw new GroqRequestError("Groq reported a temporary server error.", "unavailable", { httpStatus: 500, durationMs: 100, category: "server_error" });
        return "processed";
      },
    });

    await expect(result).resolves.toBe("processed");
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed provider result when only non-secret success-audit persistence fails", async () => {
    const onSuccess = vi.fn(async () => { throw new Error("temporary database audit failure"); });
    const result = await executeBoundedGroqRotation({
      reserve: async () => ({ id: 71 }),
      onSuccess,
      onFailure: async () => undefined,
      operation: async () => "transcribed",
    });

    expect(result).toBe("transcribed");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps the real provider classification when only failure-audit persistence fails", async () => {
    const result = executeBoundedGroqRotation({
      reserve: async () => ({ id: 72 }),
      onSuccess: async () => undefined,
      onFailure: async () => { throw new Error("temporary database audit failure"); },
      operation: async () => { throw new GroqRequestError("rate limited", "quota_limited"); },
    });

    await expect(result).rejects.toMatchObject({ status: "quota_limited" });
  });

  it("caps a hosted slice at one eligible key attempt so the next callback can continue round-robin recovery", async () => {
    const reserve = vi.fn(async () => ({ id: 81 }));
    const result = executeBoundedGroqRotation({
      reserve,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      maxAttempts: 1,
      operation: async () => { throw new GroqRequestError("temporary server error", "unavailable", { durationMs: 20_000, category: "server_error" }); },
    });

    await expect(result).rejects.toMatchObject({ metadata: expect.objectContaining({ category: "server_error" }) });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("explains a completed unavailable-key sweep without disclosing the upstream error text", async () => {
    const rawSecret = "gsk_not_for_the_user";
    const keys = [{ id: 31 }, { id: 31 }];
    const result = executeBoundedGroqRotation({
      reserve: async () => keys.shift()!,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      operation: async () => { throw new GroqRequestError(`connection reset ${rawSecret}`, "unavailable"); },
    });

    await expect(result).rejects.toMatchObject({ message: "Groq could not complete the request with any currently eligible key. Retry shortly; no key was marked invalid." });
    await result.catch(error => expect(error.message).not.toContain(rawSecret));
  });
});
