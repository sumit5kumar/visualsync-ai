import { and, eq, isNull, lte, or } from "drizzle-orm";
import { groqApiKeys, timelineGenerationJobs, projects } from "../drizzle/schema";
import { getDb } from "./db";
import { decryptSecret } from "./crypto";
import { GroqClient, GroqRequestError, type GroqRequestMetadata } from "./groqClient";
import { GroqPoolExhaustedError } from "./groqPool";
import { processProjectTimelineSlice, type TimelineGenerationSliceResult } from "./projectProcessor";
import { isProjectVerifiedForAutomaticRotation } from "./groqRotation";

// The handler remains idempotent and retains the two-minute provider retry
// delay. A one-minute heartbeat is the platform minimum and gives overdue
// retry deadlines another chance to be claimed without user interaction.
export const TIMELINE_JOB_CRON = "0 * * * * *";
export const DEFAULT_TIMELINE_RETRY_MS = 120_000;
export const TIMELINE_CALLBACK_WORK_BUDGET_MS = 25_000;
export const TIMELINE_QUEUE_RELEASE_DELAY_MS = 10 * 60_000;

type JobStatus = "queued" | "processing" | "waiting_for_retry" | "completed" | "failed";
type JobStage = "queued" | "transcribing" | "analyzing_images" | "building_timeline" | "finalizing" | "completed" | "failed";
type QueueGateJob = { id: number; projectId: number; status: JobStatus; startedAt: Date | null; createdAt: Date; completedAt: Date | null };

function preflightCategory(status: "verified" | "invalid" | "permission_restricted" | "quota_limited" | "request_too_large" | "prompt_error" | "unavailable") {
  if (status === "invalid") return "invalid_key" as const;
  if (status === "permission_restricted") return "permission_denied" as const;
  if (status === "quota_limited") return "rate_limited" as const;
  if (status === "request_too_large") return "file_too_large" as const;
  if (status === "prompt_error") return "client_request" as const;
  return "unknown" as const;
}

function failureMetadata(error: unknown): GroqRequestMetadata | undefined {
  if (error instanceof GroqRequestError || error instanceof GroqPoolExhaustedError) return error.metadata;
  return undefined;
}

export function isRetryableTimelineFailure(error: unknown) {
  const metadata = failureMetadata(error);
  if (metadata?.category === "rate_limited" || metadata?.category === "audio_quota_exhausted" || metadata?.category === "server_error" || metadata?.category === "network_failure" || metadata?.category === "timeout" || metadata?.category === "unknown") return true;
  return error instanceof Error && /fetch failed|econnreset|network|connection reset|timed out|timeout/i.test(error.message);
}

export function shouldContinueTimelineRecovery(error: unknown) {
  return isRetryableTimelineFailure(error);
}

export function resolveTimelineRetryAt(error: unknown, transientFailureCount: number, now = Date.now()) {
  const metadata = failureMetadata(error);
  const providerDelay = metadata?.retryAfterMs;
  const delay = providerDelay !== undefined && providerDelay >= 0
    ? providerDelay
    : metadata?.category === "rate_limited" || metadata?.category === "audio_quota_exhausted"
      ? Math.min(1_800_000, DEFAULT_TIMELINE_RETRY_MS * Math.max(1, 2 ** Math.max(0, transientFailureCount - 1)))
      : DEFAULT_TIMELINE_RETRY_MS;
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

export function timelineJobAvailability(job: { status: JobStatus; retryAt: Date | null; leaseExpiresAt: Date | null }, nowMs = Date.now()) {
  if (job.status === "completed" || job.status === "failed") return { outcome: "skipped" as const };
  if (job.retryAt && job.retryAt.getTime() > nowMs) return { outcome: "waiting" as const, retryAt: job.retryAt };
  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > nowMs) return { outcome: "leased" as const };
  return { outcome: "claimable" as const };
}

export function resolveTimelineQueueGate(jobs: QueueGateJob[], jobId: number, nowMs = Date.now()) {
  const activeJobs = jobs
    .filter(job => job.status !== "completed" && job.status !== "failed")
    .sort((left, right) => (left.startedAt ?? left.createdAt).getTime() - (right.startedAt ?? right.createdAt).getTime() || left.id - right.id);
  const head = activeJobs[0];
  if (!head || head.id !== jobId) return { outcome: "waiting_for_prior_project" as const, priorProjectId: head?.projectId ?? null, retryAt: new Date(nowMs + 60_000) };
  const latestCompletion = jobs
    .filter(job => job.status === "completed" && job.completedAt)
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))[0];
  const releaseAt = latestCompletion?.completedAt ? new Date(latestCompletion.completedAt.getTime() + TIMELINE_QUEUE_RELEASE_DELAY_MS) : null;
  if (releaseAt && releaseAt.getTime() > nowMs) return { outcome: "waiting_for_release_delay" as const, priorProjectId: latestCompletion.projectId, retryAt: releaseAt };
  return { outcome: "ready" as const, priorProjectId: null, retryAt: null };
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
  const [existing] = await db.select().from(timelineGenerationJobs).where(and(eq(timelineGenerationJobs.projectId, projectId), eq(timelineGenerationJobs.userId, userId))).limit(1);
  if (existing?.leaseExpiresAt && existing.leaseExpiresAt.getTime() > now.getTime()) return existing;
  await db.insert(timelineGenerationJobs).values({ projectId, userId, status: "queued", currentStage: "queued", attemptCount: 0, transientFailureCount: 0, retryAt: null, lastError: null, workState: {} , startedAt: now, completedAt: null, leaseToken: null, leaseExpiresAt: null }).onDuplicateKeyUpdate({ set: { status: "queued", transientFailureCount: 0, retryAt: null, lastError: null, startedAt: now, completedAt: null, leaseToken: null, leaseExpiresAt: null } });
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

async function preflightGroqTimelineJob(userId: number) {
  const db = await requireDb();
  const keys = await db.select().from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.isActive, true))).orderBy(groqApiKeys.rotationOrder, groqApiKeys.id);
  if (!keys.length) throw new GroqRequestError("No active Groq key is configured. Add and verify a Groq key before starting Timeline Generation.", "prompt_error", { durationMs: 0, category: "client_request" });
  const projectVerifiedKeys = keys.filter(isProjectVerifiedForAutomaticRotation);
  const eligible = projectVerifiedKeys.filter(key => key.testStatus !== "invalid" && key.testStatus !== "permission_restricted" && (!key.cooldownUntil || key.cooldownUntil <= new Date()));
  if (!eligible.length) {
    if (!projectVerifiedKeys.length) throw new GroqRequestError("No project-verified Groq key is configured for automatic processing. Verify a key’s issuing Groq project before retrying.", "permission_restricted", { durationMs: 0, category: "permission_denied" });
    if (projectVerifiedKeys.every(key => key.testStatus === "permission_restricted")) throw new GroqRequestError("Groq model permission denied for every project-verified key. Correct that Groq project’s model permissions, then use Retry analysis.", "permission_restricted", { durationMs: 0, category: "permission_denied" });
    if (projectVerifiedKeys.every(key => key.testStatus === "invalid")) throw new GroqRequestError("Every project-verified Groq key is invalid or revoked. Add a replacement key, then use Retry analysis.", "invalid", { durationMs: 0, category: "invalid_key" });
    const retryAtMs = Math.min(...projectVerifiedKeys.filter(key => key.cooldownUntil && key.cooldownUntil > new Date()).map(key => key.cooldownUntil!.getTime()));
    if (Number.isFinite(retryAtMs)) throw new GroqRequestError("All configured Groq keys are temporarily rate-limited or unavailable. The Timeline job will retry automatically.", "quota_limited", { durationMs: 0, category: "rate_limited", retryAfterMs: Math.max(0, retryAtMs - Date.now()) });
    throw new GroqRequestError("No project-verified Groq key is currently eligible. Verify the issuing Groq project before using another stored key.", "unavailable", { durationMs: 0, category: "unknown" });
  }
  let lastFailure: GroqRequestError | null = null;
  for (const key of eligible) {
    const client = new GroqClient(decryptSecret({ ciphertext: key.encryptedCiphertext, iv: key.encryptionIv, tag: key.encryptionTag }));
    const result = await client.testKey();
    if (result.status === "verified") return;
    const failure = new GroqRequestError(result.message, result.status, { durationMs: 0, category: preflightCategory(result.status) });
    lastFailure = failure;
    const now = new Date();
    if (result.status === "invalid") await db.update(groqApiKeys).set({ testStatus: "invalid", isActive: false, lastFailureAt: now }).where(eq(groqApiKeys.id, key.id));
    else if (result.status === "permission_restricted") await db.update(groqApiKeys).set({ testStatus: "permission_restricted", lastFailureAt: now, cooldownUntil: null }).where(eq(groqApiKeys.id, key.id));
    else if (result.status === "quota_limited") await db.update(groqApiKeys).set({ testStatus: "quota_limited", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + DEFAULT_TIMELINE_RETRY_MS) }).where(eq(groqApiKeys.id, key.id));
    else await db.update(groqApiKeys).set({ testStatus: "unavailable", lastFailureAt: now, cooldownUntil: new Date(now.getTime() + DEFAULT_TIMELINE_RETRY_MS) }).where(eq(groqApiKeys.id, key.id));
  }
  throw lastFailure ?? new GroqRequestError("Groq preflight could not validate a configured key.", "unavailable", { durationMs: 0, category: "unknown" });
}

export async function runTimelineGenerationJob(jobId: number) {
  const db = await requireDb();
  const [job] = await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.id, jobId)).limit(1);
  if (!job) return { outcome: "skipped" as const };
  const availability = timelineJobAvailability(job);
  if (availability.outcome !== "claimable") return availability;

  const claimStartedAtMs = Date.now();
  const userJobs = await db.select({ id: timelineGenerationJobs.id, projectId: timelineGenerationJobs.projectId, status: timelineGenerationJobs.status, startedAt: timelineGenerationJobs.startedAt, createdAt: timelineGenerationJobs.createdAt, completedAt: timelineGenerationJobs.completedAt }).from(timelineGenerationJobs).where(eq(timelineGenerationJobs.userId, job.userId));
  const queueGate = resolveTimelineQueueGate(userJobs, job.id, claimStartedAtMs);
  if (queueGate.outcome !== "ready") {
    const waitMessage = queueGate.outcome === "waiting_for_release_delay"
      ? `Timeline Generation is queued. Project ${queueGate.priorProjectId} reached Timeline Ready; this project will start 10 minutes later.`
      : `Timeline Generation is queued behind active project ${queueGate.priorProjectId}. It will start after that project reaches Timeline Ready, then waits 10 minutes.`;
    await db.update(timelineGenerationJobs).set({ status: "queued", currentStage: "queued", retryAt: queueGate.retryAt, lastError: { category: "queue_wait", message: waitMessage, retryAfterMs: Math.max(0, queueGate.retryAt.getTime() - claimStartedAtMs) }, leaseToken: null, leaseExpiresAt: null }).where(eq(timelineGenerationJobs.id, job.id));
    return { outcome: "queue_wait" as const, queueState: queueGate.outcome, retryAt: queueGate.retryAt, priorProjectId: queueGate.priorProjectId };
  }
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(claimStartedAtMs + 110_000);
  await db.update(timelineGenerationJobs).set({ status: "processing", leaseToken, leaseExpiresAt, attemptCount: job.attemptCount + 1 }).where(and(
    eq(timelineGenerationJobs.id, job.id),
    or(isNull(timelineGenerationJobs.leaseExpiresAt), lte(timelineGenerationJobs.leaseExpiresAt, new Date(claimStartedAtMs))),
    or(isNull(timelineGenerationJobs.retryAt), lte(timelineGenerationJobs.retryAt, new Date(claimStartedAtMs))),
  ));
  const [claimedJob] = await db.select().from(timelineGenerationJobs).where(and(eq(timelineGenerationJobs.id, job.id), eq(timelineGenerationJobs.leaseToken, leaseToken))).limit(1);
  if (!claimedJob) {
    const [latest] = await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.id, job.id)).limit(1);
    if (latest?.retryAt && latest.retryAt.getTime() > claimStartedAtMs) return { outcome: "waiting" as const, retryAt: latest.retryAt };
    return { outcome: "leased" as const };
  }
  try {
    const startedAtMs = Date.now();
    let workState: Record<string, unknown> = { ...((claimedJob.workState as Record<string, unknown> | null) ?? {}), firstDispatchAtMs: Number((claimedJob.workState as Record<string, unknown> | null)?.firstDispatchAtMs) || startedAtMs };
    await db.update(timelineGenerationJobs).set({ workState }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
    if (!workState?.preflightComplete) {
      await preflightGroqTimelineJob(claimedJob.userId);
      workState = { ...(workState ?? {}), preflightComplete: true };
      await db.update(timelineGenerationJobs).set({ workState }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
    }
    let latestStage: TimelineGenerationSliceResult["stage"] = claimedJob.currentStage === "queued" ? "transcribing" : claimedJob.currentStage as Exclude<JobStage, "queued" | "finalizing" | "failed">;
    let unitsCompleted = 0;
    while (Date.now() - startedAtMs < TIMELINE_CALLBACK_WORK_BUDGET_MS) {
      const result = await processProjectTimelineSlice(claimedJob.userId, claimedJob.projectId, workState);
      latestStage = result.stage;
      workState = { ...result.workState };
      unitsCompleted += 1;
      const completed = result.stage === "completed";
      await db.update(timelineGenerationJobs).set({ status: completed ? "completed" : "processing", currentStage: mapStage(result.stage), workState, retryAt: null, lastError: null, transientFailureCount: 0, completedAt: completed ? new Date() : null }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
      if (completed) {
        await db.update(timelineGenerationJobs).set({ leaseToken: null, leaseExpiresAt: null }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
        return { outcome: "completed" as const, stage: result.stage, unitsCompleted };
      }
    }
    await db.update(timelineGenerationJobs).set({ status: "queued", currentStage: mapStage(latestStage), workState, leaseToken: null, leaseExpiresAt: null }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
    return { outcome: "advanced" as const, stage: latestStage, unitsCompleted };
  } catch (error) {
    const transientFailureCount = claimedJob.transientFailureCount + 1;
    const retryable = shouldContinueTimelineRecovery(error);
    const retryAt = retryable ? resolveTimelineRetryAt(error, transientFailureCount) : null;
    await db.update(timelineGenerationJobs).set({ status: retryable ? "waiting_for_retry" : "failed", currentStage: retryable ? claimedJob.currentStage : "failed", transientFailureCount, retryAt, lastError: safeJobError(error), leaseToken: null, leaseExpiresAt: null }).where(and(eq(timelineGenerationJobs.id, claimedJob.id), eq(timelineGenerationJobs.leaseToken, leaseToken)));
    if (!retryable) await db.update(projects).set({ status: "failed", workerState: "error", processingStage: "failed", processingStageStartedAt: new Date() }).where(eq(projects.id, claimedJob.projectId));
    return { outcome: retryable ? "retry_wait" as const : "failed" as const, retryAt, error: safeJobError(error) };
  }
}

export async function runTimelineGenerationJobBySchedule(taskUid: string) {
  const db = await requireDb();
  const [job] = await db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.scheduleCronTaskUid, taskUid)).limit(1);
  if (!job) return { outcome: "orphan" as const };
  return runTimelineGenerationJob(job.id);
}
