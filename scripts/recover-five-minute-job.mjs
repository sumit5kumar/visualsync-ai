import { runTimelineGenerationJob } from "../server/timelineGenerationJobs.ts";

const jobId = 150001;
const result = await runTimelineGenerationJob(jobId);
console.log(JSON.stringify({ jobId, result }, null, 2));
