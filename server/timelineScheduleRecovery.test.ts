import { describe, expect, it } from "vitest";
import { isAmbiguousHeartbeatUpdateTimeout } from "./timelineScheduleRecovery";

describe("Timeline Heartbeat schedule recovery", () => {
  it("allows immediate durable dispatch after an ambiguous platform schedule-update deadline", () => {
    expect(isAmbiguousHeartbeatUpdateTimeout(new Error('Heartbeat UpdateHeartbeatJob failed (500): {"code":"internal","message":"temporal schedule update: context deadline exceeded"}'))).toBe(true);
  });

  it("does not mask unrelated Heartbeat errors", () => {
    expect(isAmbiguousHeartbeatUpdateTimeout(new Error("Heartbeat UpdateHeartbeatJob failed (403): forbidden"))).toBe(false);
    expect(isAmbiguousHeartbeatUpdateTimeout(new Error("network unavailable"))).toBe(false);
  });
});
