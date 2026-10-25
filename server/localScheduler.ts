import { runAllDueTimelineGenerationJobs } from "./timelineGenerationJobs";

const TICK_MS = 60_000;
let tickRunning = false;

// In-process fallback for hosts where no external cron can reach the app.
// The DB lease guard keeps this safe even when an external scheduler
// (cron-job.org) pings /api/scheduled/timeline-generation at the same time.
export function startLocalScheduler() {
  if (process.env.DISABLE_LOCAL_SCHEDULER === "1") return;
  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await runAllDueTimelineGenerationJobs();
    } catch (error) {
      console.error("[Scheduler] Timeline Generation tick failed", error);
    } finally {
      tickRunning = false;
    }
  }, TICK_MS);
  console.log("[Scheduler] Local Timeline Generation scheduler started (60s tick).");
}
