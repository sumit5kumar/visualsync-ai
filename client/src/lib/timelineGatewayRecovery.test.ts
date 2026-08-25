import { describe, expect, it } from "vitest";
import { hasRecoverableSavedTimelineJob } from "./timelineGatewayRecovery";

describe("Timeline gateway mutation recovery", () => {
  it("accepts only a persisted non-terminal Timeline job after a lost gateway response", () => {
    expect(hasRecoverableSavedTimelineJob({ status: "queued" })).toBe(true);
    expect(hasRecoverableSavedTimelineJob({ status: "processing" })).toBe(true);
    expect(hasRecoverableSavedTimelineJob({ status: "waiting_for_retry" })).toBe(true);
    expect(hasRecoverableSavedTimelineJob({ status: "completed" })).toBe(false);
    expect(hasRecoverableSavedTimelineJob({ status: "failed" })).toBe(false);
    expect(hasRecoverableSavedTimelineJob(null)).toBe(false);
  });
});
