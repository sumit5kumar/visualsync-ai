import { describe, expect, it } from "vitest";
import { DEFAULT_TIMELINE_RETRY_MS, isRetryableTimelineFailure, resolveTimelineRetryAt, TIMELINE_CALLBACK_WORK_BUDGET_MS, TIMELINE_JOB_CRON } from "./timelineGenerationJobs";
import { GroqRequestError } from "./groqClient";

describe("durable Timeline Generation retry policy", () => {
  it("retries only documented transient provider categories and respects provider retry timing", () => {
    const transient = new GroqRequestError("temporary", "unavailable", { durationMs: 1, category: "server_error", retryAfterMs: 17_000 });
    const permanent = new GroqRequestError("invalid", "invalid", { durationMs: 1, category: "invalid_key" });
    expect(isRetryableTimelineFailure(transient)).toBe(true);
    expect(isRetryableTimelineFailure(permanent)).toBe(false);
    expect(resolveTimelineRetryAt(transient, 1, 1_000).getTime()).toBe(18_000);
    expect(isRetryableTimelineFailure(new Error("fetch failed: ECONNRESET"))).toBe(true);
  });

  it("uses a two-minute fallback and bounded backoff when Groq omits retry guidance", () => {
    const transient = new GroqRequestError("timeout", "unavailable", { durationMs: 1, category: "timeout" });
    expect(resolveTimelineRetryAt(transient, 1, 1_000).getTime()).toBe(1_000 + DEFAULT_TIMELINE_RETRY_MS);
    expect(resolveTimelineRetryAt(transient, 2, 1_000).getTime()).toBe(1_000 + DEFAULT_TIMELINE_RETRY_MS * 2);
  });

  it("does not retry permanent access or malformed-request failures and stays inside the hosted callback deadline", () => {
    const denied = new GroqRequestError("permission", "prompt_error", { durationMs: 1, category: "permission_denied" });
    const malformed = new GroqRequestError("invalid request", "prompt_error", { durationMs: 1, category: "client_request" });
    expect(isRetryableTimelineFailure(denied)).toBe(false);
    expect(isRetryableTimelineFailure(malformed)).toBe(false);
    expect(TIMELINE_CALLBACK_WORK_BUDGET_MS).toBeLessThan(120_000);
    expect(TIMELINE_JOB_CRON.split(" ")).toHaveLength(6);
  });

  it("covers 429, 5xx, timeout, network, invalid-key, and permission-restricted production classifications", () => {
    const rateLimited = new GroqRequestError("429", "quota_limited", { durationMs: 1, category: "rate_limited" });
    const serverError = new GroqRequestError("503", "unavailable", { durationMs: 1, category: "server_error" });
    const timeout = new GroqRequestError("timeout", "unavailable", { durationMs: 1, category: "timeout" });
    const network = new GroqRequestError("network", "unavailable", { durationMs: 1, category: "network_failure" });
    const invalid = new GroqRequestError("invalid", "invalid", { durationMs: 1, category: "invalid_key" });
    const restricted = new GroqRequestError("permission", "permission_restricted", { durationMs: 1, category: "permission_denied" });
    expect([rateLimited, serverError, timeout, network].every(isRetryableTimelineFailure)).toBe(true);
    expect([invalid, restricted].some(isRetryableTimelineFailure)).toBe(false);
  });
});
