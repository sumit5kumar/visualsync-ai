import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { runTimelineGenerationJobBySchedule } from "./timelineGenerationJobs";
import { verifiedTimelineScheduleTask } from "./timelineScheduleAuth";

export function registerTimelineGenerationScheduleRoutes(app: Express) {
  app.post("/api/scheduled/timeline-generation", async (req: Request, res: Response) => {
    try {
      let taskUid: string | null = null;
      try {
        const user = await sdk.authenticateRequest(req);
        taskUid = user.isCron && user.taskUid ? user.taskUid : null;
      } catch {
        taskUid = verifiedTimelineScheduleTask(req.body);
      }
      if (!taskUid) return res.status(403).json({ error: "cron-only" });
      const result = await runTimelineGenerationJobBySchedule(taskUid);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Timeline Generation callback failed.", timestamp: new Date().toISOString() });
    }
  });
}
