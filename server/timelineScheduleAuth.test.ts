import { describe, expect, it } from "vitest";
import { signTimelineScheduleTask, taskUidFromSchedulePayload, verifiedTimelineScheduleTask } from "./timelineScheduleAuth";

describe("timeline scheduled callback signatures", () => {
  const secret = "test-only-schedule-secret";
  const taskUid = "mrBDNaTXRY8QA5k6ieLKJV";

  it("accepts a valid server-signed callback only for its exact task UID", () => {
    const signature = signTimelineScheduleTask(taskUid, secret);
    expect(verifiedTimelineScheduleTask({ taskUid, signature }, secret)).toBe(taskUid);
  });

  it("rejects an altered UID, signature, or malformed callback payload", () => {
    const signature = signTimelineScheduleTask(taskUid, secret);
    expect(verifiedTimelineScheduleTask({ taskUid: `${taskUid}x`, signature }, secret)).toBeNull();
    expect(verifiedTimelineScheduleTask({ taskUid, signature: `${signature.slice(0, -1)}0` }, secret)).toBeNull();
    expect(verifiedTimelineScheduleTask({ taskUid }, secret)).toBeNull();
  });

  it("accepts only a high-entropy task UID as the limited post-authentication fallback token", () => {
    expect(taskUidFromSchedulePayload({ taskUid })).toBe(taskUid);
    expect(taskUidFromSchedulePayload({ taskUid: "short" })).toBeNull();
    expect(taskUidFromSchedulePayload({ taskUid: "not valid spaces in task uid" })).toBeNull();
  });
});
