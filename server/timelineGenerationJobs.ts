import { and, eq } from "drizzle-orm";
import { timelineGenerationJobs, projects } from "../drizzle/schema";
import { getDb } from "./db";
import { GroqRequestError, type GroqRequestMetadata } from "./groqClient";
import { GroqPoolExhaustedError } from "./groqPool";
import { processProjectTimelineSlice, type TimelineGenerationSliceResult } from "./projectProcessor";

export const TIMELINE_JOB_CRON = "0 */2 * * * *";
export const DEFAULT_TIMELINE_RETRY_MS = 120_000;
export const MAX_TIMELINE_TRANSIENT_FAILURES = 8;
export const TIMELINE_CALLBACK_WORK_BUDGET_MS = 105_000;

type JobStatus = "queued" | "processing" | "waiting_for_retry" | "completed" | "failed";
type JobStage = "queued" | "transcribing" | "analyzing_images" | "building_timeline" | "finalizing" | "completed" | "failed";

function failureMetadata(error: unknown): GroqRequestMetadata | undefined {
  if (error instanceof GroqRequestError || error instanceof GroqPoolExhaustedError) return error.metadata;
  return undefined;
}

export function isRetryableTimelineFailure(error: unknown) {
  const metadata = failureMetadata(error);
  if (metadata?.category === "rate_limited" || metadata?.category === "audio_quota_exhausted" || metadata?.category === "server_error" || metadata?.category === "network_failure" || metadata?.category === "timeout" || metadata?.category === "unknown") return true;
  return error instanceof Error && /fetch failed|econnreset|network|connection reset|timed out|timeout/i.test(error.message);
}

export function resolveTimelineRetryAt(error: unknown, transientFailureCount: number, now = Date.now()) {
  const providerDelay = failureMetadata(error)?.retryAfterMs;
  const delay = providerDelay !== undefined && providerDelay >= 0
    ? providerDelay
    : Math.min(1_800_000, DEFAULT_TIMELINE_RETRY_MS * Math.max(1, 2 ** Math.max(0, transientFailureCount - 1)));
  return new Date(now + delay);
}

function safeJobError(error: unknown) {
  const metadata = failureMetadata(error);
  return {
    message: error instanceof Error ? error.message : "Timeline Generation did not complete.",
    category: metadata?.category ?? "unknown",
    httpStatus: metadata?.httpStatus,
    retryAfterMs: metadata?.retryAfterMs,
    occurredAtMs: Date.now(),
  };
}

function mapStage(result: TimelineGenerationSliceResult["stage"]): JobStage {
  if (result === "completed") return "completed";
  return result;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  return db;
}

export async function queueTimelineGenerationJob(userId: number, projectId: number) {
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project?.audioDurationMs || !project.narrationStorageKey) throw new Error("Upload narration and images before starting Timeline Generation.");
  const now = new Date();
  await db.insert(timelineGenerationJobs).values({ projectId, userId, status: "queued", currentStage: "queued", attemptCount: 0, transientFailureCount: 0, retryAt: null, lastError: null, workState: {} , startedAt: now, completedAt: null, leaseToken: null, leaseExpiresAt: null }).onDuplicateKeyUpdate({ set: { status: "queued", currentStage: "queued", attemptCount: 0, transientFailureCount: 0, retryAt: null, lastError: null, workState: {}, startedAt: now, completedAt: null, leaseToken: null, leaseExpiresAt: null } });
  await db.update(projects).set({ status: "analyzing", workerState: "processing", processingStage: "transcribing", processingStartedAt: now, processingStageStartedAt: now }).where(eq(projects.id, projectId));
  return (await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.projectId, projectId)).limit(1))[0];
}

export async function setTimelineGenerationSchedule(userId: number, projectId: number, taskUid: string) {
  const db = await requireDb();
  await db.update(timelineGenerationJobs).set({ scheduleCronTaskUid: taskUid }).where(and(eq(timelineGenerationJobs.projectId, projectId), eq(timelineGenerationJobs.userId, userId)));
}

export async function getTimelineGenerationJob(userId: number, projectId: number) {
  const db = await requireDb();
  return (await db.select().from(timelineGenerationJobs).where(and(eq(timelineGenerationJobs.projectId, projectId), eq(timelineGenerationJobs.userId, userId))).limit(1))[0] ?? null;
}

export async function runTimelineGenerationJob(jobId: number) {
  const db = await requireDb();
  const [job] = await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.id, jobId)).limit(1);
  if (!job || job.status === "completed" || job.status === "failed") return { outcome: "skipped" as const };
  if (job.retryAt && job.retryAt.getTime() > Date.now()) return { outcome: "waiting" as const, retryAt: job.retryAt };
  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()) return { outcome: "leased" as const };

  const leaseExpiresAt = new Date(Date.now() + 110_000);
  await db.update(timelineGenerationJobs).set({ status: "processing", leaseToken: crypto.randomUUID(), leaseExpiresAt, attemptCount: job.attemptCount + 1 }).where(eq(timelineGenerationJobs.id, job.id));
  try {
    const startedAtMs = Date.now();
    let workState = job.workState;
    let latestStage: TimelineGenerationSliceResult["stage"] = job.currentStage === "queued" ? "transcribing" : job.currentStage as Exclude<JobStage, "queued" | "finalizing" | "failed">;
    let unitsCompleted = 0;
    while (Date.now() - startedAtMs < TIMELINE_CALLBACK_WORK_BUDGET_MS) {
      const result = await processProjectTimelineSlice(job.userId, job.projectId, workState);
      latestStage = result.stage;
      workState = result.workState;
      unitsCompleted += 1;
      const completed = result.stage === "completed";
      await db.update(timelineGenerationJobs).set({ status: completed ? "completed" : "processing", currentStage: mapStage(result.stage), workState, retryAt: null, lastError: null, completedAt: completed ? new Date() : null }).where(eq(timelineGenerationJobs.id, job.id));
      if (completed) {
        await db.update(timelineGenerationJobs).set({ leaseToken: null, leaseExpiresAt: null }).where(eq(timelineGenerationJobs.id, job.id));
        return { outcome: "completed" as const, stage: result.stage, unitsCompleted };
      }
    }
    await db.update(timelineGenerationJobs).set({ status: "queued", currentStage: mapStage(latestStage), workState, leaseToken: null, leaseExpiresAt: null }).where(eq(timelineGenerationJobs.id, job.id));
    return { outcome: "advanced" as const, stage: latestStage, unitsCompleted };
  } catch (error) {
    const transientFailureCount = job.transientFailureCount + 1;
    const retryable = isRetryableTimelineFailure(error) && transientFailureCount <= MAX_TIMELINE_TRANSIENT_FAILURES;
    const retryAt = retryable ? resolveTimelineRetryAt(error, transientFailureCount) : null;
    await db.update(timelineGenerationJobs).set({ status: retryable ? "waiting_for_retry" : "failed", currentStage: retryable ? job.currentStage : "failed", transientFailureCount, retryAt, lastError: safeJobError(error), leaseToken: null, leaseExpiresAt: null }).where(eq(timelineGenerationJobs.id, job.id));
    if (!retryable) await db.update(projects).set({ status: "failed", workerState: "error", processingStage: "failed", processingStageStartedAt: new Date() }).where(eq(projects.id, job.projectId));
    return { outcome: retryable ? "retry_wait" as const : "failed" as const, retryAt, error: safeJobError(error) };
  }
}

export async function runTimelineGenerationJobBySchedule(taskUid: string) {
  const db = await requireDb();
  const [job] = await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.scheduleCronTaskUid, taskUid)).limit(1);
  if (!job) return { outcome: "orphan" as const };
  return runTimelineGenerationJob(job.id);
}
