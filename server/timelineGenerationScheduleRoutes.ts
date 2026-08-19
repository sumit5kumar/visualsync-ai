import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { runTimelineGenerationJobBySchedule } from "./timelineGenerationJobs";

export function registerTimelineGenerationScheduleRoutes(app: Express) {
  app.post("/api/scheduled/timeline-generation", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
      const result = await runTimelineGenerationJobBySchedule(user.taskUid);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Timeline Generation callback failed.", timestamp: new Date().toISOString() });
    }
  });
}
