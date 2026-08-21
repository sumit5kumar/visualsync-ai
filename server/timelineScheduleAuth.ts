import { createHmac, timingSafeEqual } from "node:crypto";
import { ENV } from "./_core/env";

const SIGNATURE_CONTEXT = "visualsync:timeline-schedule:";

export function signTimelineScheduleTask(taskUid: string, secret = ENV.cookieSecret) {
  if (!secret) throw new Error("Timeline schedule signing secret is unavailable.");
  return createHmac("sha256", secret).update(`${SIGNATURE_CONTEXT}${taskUid}`).digest("hex");
}

export function verifiedTimelineScheduleTask(payload: unknown, secret = ENV.cookieSecret) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { taskUid, signature } = payload as { taskUid?: unknown; signature?: unknown };
  if (typeof taskUid !== "string" || !/^[A-Za-z0-9_-]{8,65}$/.test(taskUid) || typeof signature !== "string") return null;
  const expected = signTimelineScheduleTask(taskUid, secret);
  const supplied = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes) ? taskUid : null;
}
