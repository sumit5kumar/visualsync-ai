import { runTimelineGenerationJob } from "../server/timelineGenerationJobs";

const jobId = Number(process.argv[2]);
if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("Pass a positive Timeline job ID.");

const requestedSlices = Number(process.argv[3] ?? "1");
if (!Number.isInteger(requestedSlices) || requestedSlices < 1 || requestedSlices > 12) throw new Error("Pass a bounded slice count from 1 through 12.");

const outcomes = [];
for (let index = 0; index < requestedSlices; index += 1) {
  const outcome = await runTimelineGenerationJob(jobId);
  outcomes.push(outcome);
  if (outcome.outcome === "completed" || outcome.outcome === "failed" || outcome.outcome === "retry_wait") break;
}
console.log(JSON.stringify(outcomes));
