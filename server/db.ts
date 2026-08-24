import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { geminiApiKeys, groqApiKeys, mediaAssets, projects, timelineApprovals, timelineGenerationJobs, timelineSegments, type InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { canEditValidatedTimeline, planImageSubstitution } from "./timelineEditing";
import { validateTimeline } from "./timelineValidation";
import { buildProjectProcessingProgress } from "./projectProgress";
import { narrationTranscriptionSummary } from "./narrationTranscription";

let database: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!database && process.env.DATABASE_URL) database = drizzle(process.env.DATABASE_URL);
  return database;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  return db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert.");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId, lastSignedIn: new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: new Date() };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

export async function listUserProjects(userId: number) {
  const db = await requireDb();
  const [projectRecords, assets, activeGroqKeys, generationJobs] = await Promise.all([
    db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.updatedAt)),
    db.select({ projectId: mediaAssets.projectId, assetType: mediaAssets.assetType, byteSize: mediaAssets.byteSize, analysisState: mediaAssets.analysisState, analysisJson: mediaAssets.analysisJson }).from(mediaAssets).where(eq(mediaAssets.userId, userId)),
    db.select({ testStatus: groqApiKeys.testStatus, cooldownUntil: groqApiKeys.cooldownUntil, projectVerification: groqApiKeys.projectVerification }).from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.isActive, true))),
    db.select().from(timelineGenerationJobs).where(eq(timelineGenerationJobs.userId, userId)),
  ]);
  const now = new Date();
  const hasEligibleGroqKey = activeGroqKeys.some(key => key.projectVerification !== "unverified" && (key.testStatus === "verified" || ((key.testStatus === "quota_limited" || key.testStatus === "unavailable") && Boolean(key.cooldownUntil && key.cooldownUntil <= now))));
  return projectRecords.map(project => {
    const projectAssets = assets.filter(asset => asset.projectId === project.id);
    const imageAssets = projectAssets.filter(asset => asset.assetType === "image");
    const narrationAsset = projectAssets.find(asset => asset.assetType === "narration");
    const analyzedImageCount = imageAssets.filter(asset => asset.analysisState === "analyzed").length;
    const narrationAnalyzed = narrationAsset?.analysisState === "analyzed";
    const narrationChunks = narrationTranscriptionSummary(narrationAsset?.analysisJson);
    const sourcesAttached = Boolean(project.narrationStorageKey && project.audioDurationMs && narrationAsset && imageAssets.length > 0);
    const semanticAnalysisComplete = sourcesAttached && narrationAnalyzed && analyzedImageCount === imageAssets.length;
    const timelineGenerationJob = generationJobs.find(job => job.projectId === project.id) ?? null;
    const processingProgress = buildProjectProcessingProgress({ status: project.status, processingStage: project.processingStage, processingStartedAt: project.processingStartedAt, processingStageStartedAt: project.processingStageStartedAt, totalImageCount: imageAssets.length, completedImageCount: analyzedImageCount, narrationAnalyzed, audioDurationMs: project.audioDurationMs, narrationChunks, backgroundJob: timelineGenerationJob ? { status: timelineGenerationJob.status, retryAt: timelineGenerationJob.retryAt, leaseExpiresAt: timelineGenerationJob.leaseExpiresAt, lastError: timelineGenerationJob.lastError as { message?: string } | null } : null });
    return {
      ...project,
      sourceImageCount: imageAssets.length,
      sourceImageBytes: imageAssets.reduce((total, asset) => total + (asset.byteSize ?? 0), 0),
      narrationBytes: narrationAsset?.byteSize ?? null,
      sourcesAttached,
      analyzedImageCount,
      narrationAnalyzed,
      semanticAnalysisComplete,
      processingProgress,
      timelineGenerationJob: timelineGenerationJob ? { status: timelineGenerationJob.status, currentStage: timelineGenerationJob.currentStage, retryAt: timelineGenerationJob.retryAt?.getTime() ?? null, lastError: timelineGenerationJob.lastError } : null,
      analysisBlocker: processingProgress ? null : project.status === "timeline_ready"
        ? "A genuine AI-selected timeline is ready and has passed continuous coverage validation."
        : project.status === "failed" || project.workerState === "error"
          ? narrationChunks?.lastError
            ? `${narrationChunks.lastError.message} ${narrationChunks.completedChunks} of ${narrationChunks.totalChunks} narration chunks are saved; retry analysis resumes at chunk ${narrationChunks.activeChunkIndex}.`
            : hasEligibleGroqKey
              ? "The last Groq analysis attempt did not complete, so no timeline was created. Your uploaded narration and images are still attached; retry analysis to continue."
              : "The last Groq analysis attempt did not complete. Check the recorded provider status, then retry analysis; uploaded media remains attached."
        : semanticAnalysisComplete && project.status === "analyzing"
          ? "Narration and all source images are analyzed. Provider timeline selection is waiting for available service capacity."
        : sourcesAttached && project.status === "ready" && project.workerState === "unconfigured"
            ? "Sources are attached. Provider analysis is waiting for available service capacity."
            : null,
    };
  });
}

export async function createProjectRecord(userId: number, input: { name: string; narrationOriginalName?: string; imageSourcePath?: string; outputPath?: string }) {
  const db = await requireDb();
  const result = await db.insert(projects).values({ userId, name: input.name, narrationOriginalName: input.narrationOriginalName || null, imageSourcePath: input.imageSourcePath || null, outputPath: input.outputPath || null });
  return { projectId: Number(result[0].insertId) };
}

export function projectSetupUpdateValues(input: { narrationOriginalName?: string; imageSourcePath?: string; outputPath?: string }) {
  const values: { narrationOriginalName?: string | null; imageSourcePath?: string | null; outputPath?: string | null } = {};
  if (input.narrationOriginalName !== undefined) values.narrationOriginalName = input.narrationOriginalName.trim() || null;
  if (input.imageSourcePath !== undefined) values.imageSourcePath = input.imageSourcePath.trim() || null;
  if (input.outputPath !== undefined) values.outputPath = input.outputPath.trim() || null;
  return values;
}

export async function updateProjectSetup(userId: number, projectId: number, input: { narrationOriginalName?: string; imageSourcePath?: string; outputPath?: string }) {
  const db = await requireDb();
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  await db.update(projects).set(projectSetupUpdateValues(input)).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  return { success: true } as const;
}

export async function updateProjectZoomSettings(userId: number, projectId: number, input: { enabled: boolean; amountPercent: 3 | 5 | 8 | 12; direction: "IN" | "OUT" | "AUTO"; crossfadeDurationMs: 0 | 300 | 500 | 800 | 1000 | 1200 }) {
  const db = await requireDb();
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  await db.update(projects).set({ zoomEnabled: input.enabled, zoomAmountPercent: input.amountPercent, zoomDirection: input.direction, crossfadeDurationMs: input.crossfadeDurationMs }).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  return { success: true } as const;
}

export async function prepareProjectMediaImport(userId: number, projectId: number) {
  const db = await requireDb();
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.delete(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ narrationStorageKey: null, narrationOriginalName: null, audioDurationMs: null, status: "draft", workerState: "unconfigured", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
  return { success: true } as const;
}

export async function saveUploadedProjectMedia(input: { userId: number; projectId: number; assetType: "narration" | "image"; originalFilename: string; storageKey: string; mimeType: string; byteSize: number; contentHash: string; sequenceNumber: number | null; audioDurationMs?: number | null }) {
  const db = await requireDb();
  const project = await getUserProject(input.userId, input.projectId);
  if (!project) throw new Error("Project not found.");
  await db.transaction(async transaction => {
    await transaction.insert(mediaAssets).values({ userId: input.userId, projectId: input.projectId, assetType: input.assetType, originalFilename: input.originalFilename, storageKey: input.storageKey, mimeType: input.mimeType, byteSize: input.byteSize, contentHash: input.contentHash, sequenceNumber: input.sequenceNumber, analysisState: "pending" });
    if (input.assetType === "narration") {
      if (!input.audioDurationMs || !Number.isInteger(input.audioDurationMs) || input.audioDurationMs <= 0) throw new Error("The browser could not measure a valid narration duration.");
      await transaction.update(projects).set({ narrationStorageKey: input.storageKey, narrationOriginalName: input.originalFilename, audioDurationMs: input.audioDurationMs, status: "ready", workerState: "unconfigured", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)));
    } else {
      await transaction.update(projects).set({ status: "ready", workerState: "unconfigured" }).where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)));
    }
  });
  return { success: true } as const;
}

export async function getUserProject(userId: number, projectId: number) {
  const db = await requireDb();
  return (await db.select().from(projects).where(and(eq(projects.userId, userId), eq(projects.id, projectId))).limit(1))[0];
}

export async function listVisibleGeminiKeys(userId: number) {
  const db = await requireDb();
  return (await db.select().from(geminiApiKeys).where(eq(geminiApiKeys.userId, userId))).map(record => ({ id: record.id, label: record.label, maskedKey: `${record.keyPrefix}••••••••${record.keySuffix}`, isActive: record.isActive, testStatus: record.testStatus, lastTestedAt: record.lastTestedAt, createdAt: record.createdAt }));
}

export async function getStoredGeminiKey(userId: number, keyId: number) {
  const db = await requireDb();
  return (await db.select().from(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, keyId))).limit(1))[0];
}

export async function saveValidatedGeminiKey(userId: number, input: { label: string; keyPrefix: string; keySuffix: string; keyFingerprint: string; encryptedCiphertext: string; encryptionIv: string; encryptionTag: string }) {
  const db = await requireDb();
  const duplicate = await db.select({ id: geminiApiKeys.id }).from(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.keyFingerprint, input.keyFingerprint))).limit(1);
  if (duplicate.length > 0) throw new Error("This Gemini API key is already saved in your workspace.");
  const activeKeys = await db.select({ id: geminiApiKeys.id }).from(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.isActive, true)));
  await db.insert(geminiApiKeys).values({ ...input, userId, isActive: activeKeys.length === 0, testStatus: "verified", lastTestedAt: new Date() });
}

export async function recordGeminiKeyTest(userId: number, keyId: number, testStatus: "verified" | "invalid" | "quota_limited" | "unavailable") {
  const db = await requireDb();
  await db.update(geminiApiKeys).set({ testStatus, lastTestedAt: new Date() }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, keyId)));
}

export async function activateGeminiKey(userId: number, keyId: number) {
  const db = await requireDb();
  await db.transaction(async transaction => { await transaction.update(geminiApiKeys).set({ isActive: false }).where(eq(geminiApiKeys.userId, userId)); await transaction.update(geminiApiKeys).set({ isActive: true }).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, keyId))); });
}

export async function removeGeminiKey(userId: number, keyId: number) {
  const db = await requireDb();
  await db.delete(geminiApiKeys).where(and(eq(geminiApiKeys.userId, userId), eq(geminiApiKeys.id, keyId)));
}

export async function listVisibleGroqKeys(userId: number) {
  const db = await requireDb();
  return (await db.select().from(groqApiKeys).where(eq(groqApiKeys.userId, userId)).orderBy(groqApiKeys.rotationOrder, groqApiKeys.id)).map(record => ({ id: record.id, label: record.label, maskedKey: `${record.keyPrefix}••••••••${record.keySuffix}`, isActive: record.isActive, rotationOrder: record.rotationOrder, projectVerification: record.projectVerification, transcriptionProbeAt: record.transcriptionProbeAt, generationProbeAt: record.generationProbeAt, projectVerifiedAt: record.projectVerifiedAt, projectVerificationError: record.projectVerificationError, testStatus: record.testStatus, lastTestedAt: record.lastTestedAt, lastUsedAt: record.lastUsedAt, lastFailureAt: record.lastFailureAt, cooldownUntil: record.cooldownUntil, consecutiveRateLimits: record.consecutiveRateLimits, createdAt: record.createdAt }));
}

export async function getStoredGroqKey(userId: number, keyId: number) {
  const db = await requireDb();
  return (await db.select().from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId))).limit(1))[0];
}

export async function saveValidatedGroqKey(userId: number, input: { label: string; keyPrefix: string; keySuffix: string; keyFingerprint: string; encryptedCiphertext: string; encryptionIv: string; encryptionTag: string }) {
  const db = await requireDb();
  const duplicate = await db.select({ id: groqApiKeys.id }).from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.keyFingerprint, input.keyFingerprint))).limit(1);
  if (duplicate.length > 0) throw new Error("This Groq API key is already saved in your workspace.");
  const pool = await db.select({ rotationOrder: groqApiKeys.rotationOrder }).from(groqApiKeys).where(eq(groqApiKeys.userId, userId)).orderBy(desc(groqApiKeys.rotationOrder)).limit(1);
  await db.insert(groqApiKeys).values({ ...input, userId, isActive: true, rotationOrder: (pool[0]?.rotationOrder ?? -1) + 1, testStatus: "verified", lastTestedAt: new Date(), cooldownUntil: null, consecutiveRateLimits: 0 });
}

export async function recordGroqKeyTest(userId: number, keyId: number, testStatus: "verified" | "invalid" | "permission_restricted" | "quota_limited" | "unavailable") {
  const db = await requireDb();
  await db.update(groqApiKeys).set({ testStatus, lastTestedAt: new Date(), ...(testStatus === "verified" ? { isActive: true, cooldownUntil: null, consecutiveRateLimits: 0 } : {}) }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
}

export async function recordGroqProjectVerification(userId: number, keyId: number, input: { status: "verified" | "invalid" | "permission_restricted" | "quota_limited" | "unavailable"; transcription: { ok: boolean; status: string; message: string }; generation: { ok: boolean; status: string; message: string } }) {
  const db = await requireDb();
  const key = await getStoredGroqKey(userId, keyId);
  if (!key) throw new Error("Groq key not found.");
  const now = new Date();
  const verified = input.transcription.ok && input.generation.ok;
  const projectVerification = verified ? (key.projectVerification === "default_project_verified" ? "default_project_verified" : "externally_verified") : key.projectVerification === "default_project_verified" ? "default_project_verified" : "unverified";
  const safeError = verified ? null : JSON.stringify({ transcription: { status: input.transcription.status, message: input.transcription.message }, generation: { status: input.generation.status, message: input.generation.message } });
  await db.update(groqApiKeys).set({
    testStatus: input.status,
    projectVerification,
    transcriptionProbeAt: now,
    generationProbeAt: input.generation.message.startsWith("Generation-model probe was not run") ? null : now,
    projectVerifiedAt: verified ? now : key.projectVerification === "default_project_verified" ? key.projectVerifiedAt : null,
    projectVerificationError: safeError,
    lastTestedAt: now,
    ...(input.status === "verified" ? { isActive: true, cooldownUntil: null, consecutiveRateLimits: 0 } : {}),
  }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
  return { verified, projectVerification } as const;
}

export async function activateGroqKey(userId: number, keyId: number) {
  const db = await requireDb();
  await db.update(groqApiKeys).set({ isActive: true, cooldownUntil: null }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
}

export async function removeGroqKey(userId: number, keyId: number) {
  const db = await requireDb();
  await db.delete(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
}

export async function listProjectTimeline(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  return db.select().from(timelineSegments).where(eq(timelineSegments.projectId, projectId)).orderBy(timelineSegments.startMs);
}

function getSceneDescription(analysisJson: unknown) {
  if (!analysisJson || typeof analysisJson !== "object") return null;
  const sceneDescription = (analysisJson as Record<string, unknown>).sceneDescription;
  return typeof sceneDescription === "string" && sceneDescription.trim() ? sceneDescription.trim() : null;
}

export async function listTimelineCandidates(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  const images = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed"))).orderBy(mediaAssets.sequenceNumber);
  return images.map(image => ({
      id: image.id,
      originalFilename: image.originalFilename,
      sequenceNumber: image.sequenceNumber,
      thumbnailUrl: `/manus-storage/${image.storageKey}`,
      sceneDescription: getSceneDescription(image.analysisJson),
  }));
}

export async function getTimelineReview(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  const segments = await db.select().from(timelineSegments).where(eq(timelineSegments.projectId, projectId)).orderBy(timelineSegments.startMs);
  const imageIds = segments.flatMap(segment => segment.imageAssetId ? [segment.imageAssetId] : []);
  const imageRecords = imageIds.length ? await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), inArray(mediaAssets.id, imageIds))) : [];
  const analyzedImageRecords = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed")));
  const assetById = new Map(imageRecords.map(asset => [asset.id, asset]));
  const approval = (await db.select().from(timelineApprovals).where(eq(timelineApprovals.projectId, projectId)).limit(1))[0] ?? null;
  const firstAudit = segments[0]?.candidateImagesJson as { provider?: unknown; model?: unknown } | null;
  const provider = typeof firstAudit?.provider === "string" ? firstAudit.provider : null;
  const model = typeof firstAudit?.model === "string" ? firstAudit.model : null;
  return {
    project,
    narrationUrl: project.narrationStorageKey ? `/manus-storage/${project.narrationStorageKey}` : null,
    approval: approval ? { status: approval.status, approvedAt: approval.approvedAt, approvedByUserId: approval.userId } : { status: "pending" as const, approvedAt: null, approvedByUserId: null },
    metadata: { provider, model, analyzedImageCount: analyzedImageRecords.length, selectedImageCount: new Set(imageIds).size, candidateImageCount: Math.max(0, analyzedImageRecords.length - new Set(imageIds).size) },
    segments: segments.map(segment => {
      const image = segment.imageAssetId ? assetById.get(segment.imageAssetId) : null;
      const thumbnailUrl = image ? `/manus-storage/${image.storageKey}` : null;
      return { ...segment, imageFilename: image?.originalFilename ?? null, thumbnailUrl };
    }),
  };
}

export async function approveTimeline(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project || project.status !== "timeline_ready") throw new Error("A validated timeline is required before approval.");
  const db = await requireDb();
  const segments = await db.select({ id: timelineSegments.id }).from(timelineSegments).where(eq(timelineSegments.projectId, projectId));
  if (!segments.length) throw new Error("Timeline has no segments to approve.");
  await db.insert(timelineApprovals).values({ projectId, userId, status: "approved", approvedAt: new Date() }).onDuplicateKeyUpdate({ set: { userId, status: "approved", approvedAt: new Date() } });
  return { success: true } as const;
}

export async function substituteTimelineImage(userId: number, input: { projectId: number; segmentId: number; newImageAssetId: number }) {
  const project = await getUserProject(userId, input.projectId);
  if (!project || !project.audioDurationMs || !canEditValidatedTimeline(project.status)) throw new Error("A validated timeline is required before an image can be replaced.");
  const db = await requireDb();
  const [segment] = await db.select().from(timelineSegments).where(and(eq(timelineSegments.id, input.segmentId), eq(timelineSegments.projectId, input.projectId))).limit(1);
  if (!segment) throw new Error("Timeline segment not found.");
  const [candidate] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, input.newImageAssetId), eq(mediaAssets.projectId, input.projectId), eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed"))).limit(1);
  if (!candidate) throw new Error("Choose an analyzed image from this project’s candidate gallery.");
  if (segment.imageAssetId === candidate.id) throw new Error("This image is already selected for the segment.");
  const allSegments = await db.select().from(timelineSegments).where(eq(timelineSegments.projectId, input.projectId));
  const validation = validateTimeline(project.audioDurationMs, allSegments.map(segment => ({ ...segment, confidence: Number(segment.confidence) })));
  if (!validation.valid) throw new Error(`Timeline cannot be edited because its validated coverage is no longer intact: ${validation.issues.join(" ")}`);
  const planned = planImageSubstitution(allSegments, input.segmentId, candidate.id);
  const originalReason = segment.selectionReason;
  await db.transaction(async transaction => {
    await transaction.update(timelineSegments).set({
      imageAssetId: candidate.id,
      decisionType: "CHANGE",
      selectionReason: `User selected ${candidate.originalFilename} from the analyzed candidate gallery. Original analysis rationale: ${originalReason}`,
    }).where(eq(timelineSegments.id, segment.id));
    await transaction.insert(timelineApprovals).values({ projectId: input.projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, input.projectId));
  });
  return { ...planned, approvalStatus: "revoked" as const };
}

export async function getApprovedRenderHandoff(userId: number, projectId: number) {
  const review = await getTimelineReview(userId, projectId);
  if (review.approval.status !== "approved" || !review.approval.approvedAt || !review.approval.approvedByUserId) throw new Error("Timeline approval is required before a native render handoff.");
  const db = await requireDb();
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), inArray(mediaAssets.assetType, ["narration", "image"])));
  const narration = assets.find(asset => asset.assetType === "narration");
  if (!narration || review.segments.some(segment => !segment.imageAssetId)) throw new Error("Render handoff is missing required media assets.");
  const asWorkerAsset = (asset: typeof assets[number]) => ({ assetId: asset.id, filename: asset.originalFilename, storageKey: asset.storageKey, mimeType: asset.mimeType ?? "application/octet-stream", sequenceNumber: asset.sequenceNumber, contentHash: asset.contentHash, perceptualHash: asset.perceptualHash });
  const safeProjectName = review.project.name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || `project_${projectId}`;
  return { projectId, projectName: review.project.name, approval: { approvedByUserId: review.approval.approvedByUserId, approvedAtMs: review.approval.approvedAt.getTime() }, nativePaths: { sourceDirectory: review.project.imageSourcePath, outputDirectory: review.project.outputPath }, output: { width: 1920 as const, height: 1080 as const, aspectRatio: "16:9" as const, container: "mp4" as const, filename: `${safeProjectName}_approved_1920x1080.mp4` }, zoom: { enabled: review.project.zoomEnabled, amountPercent: review.project.zoomAmountPercent as 3 | 5 | 8 | 12, direction: review.project.zoomDirection }, crossfade: { durationMs: review.project.crossfadeDurationMs as 300 | 500 | 800 | 1000 | 1200 }, narration: asWorkerAsset(narration), images: assets.filter(asset => asset.assetType === "image").map(asWorkerAsset), timeline: review.segments.map(segment => ({ imageAssetId: segment.imageAssetId!, startMs: segment.startMs, endMs: segment.endMs, narrationText: segment.narrationText })) };
}

export async function deleteProjectRecord(userId: number, projectId: number) {
  const db = await requireDb();
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  await db.transaction(async transaction => {
    await transaction.delete(timelineGenerationJobs).where(eq(timelineGenerationJobs.projectId, projectId));
    await transaction.delete(timelineApprovals).where(eq(timelineApprovals.projectId, projectId));
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.delete(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
    await transaction.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
  return { success: true } as const;
}

export async function deleteAllProjectRecords(userId: number) {
  const db = await requireDb();
  const records = await db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId));
  const projectIds = records.map(record => record.id);
  if (!projectIds.length) return { success: true as const, deletedCount: 0 };
  await db.transaction(async transaction => {
    await transaction.delete(timelineGenerationJobs).where(inArray(timelineGenerationJobs.projectId, projectIds));
    await transaction.delete(timelineApprovals).where(inArray(timelineApprovals.projectId, projectIds));
    await transaction.delete(timelineSegments).where(inArray(timelineSegments.projectId, projectIds));
    await transaction.delete(mediaAssets).where(and(eq(mediaAssets.userId, userId), inArray(mediaAssets.projectId, projectIds)));
    await transaction.delete(projects).where(eq(projects.userId, userId));
  });
  return { success: true as const, deletedCount: projectIds.length };
}

export async function saveRenderedProjectVideo(input: { userId: number; projectId: number; originalFilename: string; storageKey: string; mimeType: string; byteSize: number; contentHash: string }) {
  const db = await requireDb();
  const project = await getUserProject(input.userId, input.projectId);
  if (!project) throw new Error("Project not found.");
  await db.transaction(async transaction => {
    await transaction.insert(mediaAssets).values({ ...input, assetType: "rendered_video", sequenceNumber: null, analysisState: "cached" });
    await transaction.update(projects).set({ status: "completed", workerState: "ready" }).where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)));
  });
  return { success: true } as const;
}

export async function getRenderedProjectVideo(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  const asset = (await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "rendered_video"))).orderBy(desc(mediaAssets.createdAt)).limit(1))[0] ?? null;
  return asset ? { id: asset.id, originalFilename: asset.originalFilename, url: `/manus-storage/${asset.storageKey}`, uploadedAt: asset.createdAt } : null;
}

export async function listRenderedProjectVideos(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  return (await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "rendered_video"))).orderBy(desc(mediaAssets.createdAt))).map(asset => ({ id: asset.id, originalFilename: asset.originalFilename, url: `/manus-storage/${asset.storageKey}`, uploadedAt: asset.createdAt }));
}
