import { describe, expect, it } from "vitest";
import { VISUALSYNC_RECORDED_MEDIA_BUDGET_BYTES, VISUALSYNC_RECORDED_MEDIA_WARNING_BYTES, summarizeUserMediaStorage } from "./db";

describe("app-recorded project media usage", () => {
  it("uses a 10 GB project-media budget and warns once 8 GB is recorded", () => {
    expect(VISUALSYNC_RECORDED_MEDIA_BUDGET_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(VISUALSYNC_RECORDED_MEDIA_WARNING_BYTES).toBe(8 * 1024 * 1024 * 1024);

    const usage = summarizeUserMediaStorage([VISUALSYNC_RECORDED_MEDIA_WARNING_BYTES - 1, null, -10]);
    expect(usage.isNearLimit).toBe(false);
    expect(usage.recordedBytes).toBe(VISUALSYNC_RECORDED_MEDIA_WARNING_BYTES - 1);
  });

  it("counts only positive persisted asset sizes and never reports negative remaining budget", () => {
    const usage = summarizeUserMediaStorage([VISUALSYNC_RECORDED_MEDIA_WARNING_BYTES, 3 * 1024 * 1024 * 1024, null, undefined, -1]);

    expect(usage.isNearLimit).toBe(true);
    expect(usage.recordedBytes).toBe(11 * 1024 * 1024 * 1024);
    expect(usage.remainingBudgetBytes).toBe(0);
    expect(usage.percentOfBudget).toBe(100);
  });
});
