import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { ENV } from "./_core/env";
import { runAllDueTimelineGenerationJobs } from "./timelineGenerationJobs";
import { verifiedTimelineScheduleTask } from "./timelineScheduleAuth";

function hasSchedulerSecret(req: Request): boolean {
  const secret = ENV.schedulerSecret;
  if (!secret) return false;
  const supplied = req.header("x-scheduler-secret");
  if (typeof supplied !== "string" || !supplied) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(secret, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

export function registerTimelineGenerationScheduleRoutes(app: Express) {
  app.post("/api/scheduled/timeline-generation", async (req: Request, res: Response) => {
    try {
      const authorized = hasSchedulerSecret(req) || Boolean(verifiedTimelineScheduleTask(req.body));
      if (!authorized) return res.status(403).json({ error: "scheduler-only" });
      const result = await runAllDueTimelineGenerationJobs();
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Timeline Generation callback failed.", timestamp: new Date().toISOString() });
    }
  });
}
