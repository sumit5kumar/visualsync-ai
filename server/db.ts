import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { geminiApiKeys, groqApiKeys, mediaAssets, projects, timelineApprovals, timelineSegments, type InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { canEditValidatedTimeline, planImageSubstitution } from "./timelineEditing";
import { validateTimeline } from "./timelineValidation";

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
  const projectRecords = await db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.updatedAt));
  const assets = await db.select({ projectId: mediaAssets.projectId, assetType: mediaAssets.assetType, byteSize: mediaAssets.byteSize, analysisState: mediaAssets.analysisState }).from(mediaAssets).where(eq(mediaAssets.userId, userId));
  return projectRecords.map(project => {
    const projectAssets = assets.filter(asset => asset.projectId === project.id);
    const imageAssets = projectAssets.filter(asset => asset.assetType === "image");
    const narrationAsset = projectAssets.find(asset => asset.assetType === "narration");
    const analyzedImageCount = imageAssets.filter(asset => asset.analysisState === "analyzed").length;
    const narrationAnalyzed = narrationAsset?.analysisState === "analyzed";
    const sourcesAttached = Boolean(project.narrationStorageKey && project.audioDurationMs && narrationAsset && imageAssets.length > 0);
    const semanticAnalysisComplete = sourcesAttached && narrationAnalyzed && analyzedImageCount === imageAssets.length;
    return {
      ...project,
      sourceImageCount: imageAssets.length,
      sourceImageBytes: imageAssets.reduce((total, asset) => total + (asset.byteSize ?? 0), 0),
      narrationBytes: narrationAsset?.byteSize ?? null,
      sourcesAttached,
      analyzedImageCount,
      narrationAnalyzed,
      semanticAnalysisComplete,
      analysisBlocker: project.status === "timeline_ready"
        ? "A genuine Gemini-selected timeline is ready and has passed continuous coverage validation."
        : semanticAnalysisComplete && project.status === "analyzing"
          ? "Narration and all source images are analyzed. Gemini timeline selection is waiting for available service capacity."
          : sourcesAttached && project.status === "ready" && project.workerState === "unconfigured"
            ? "Sources are attached. Gemini analysis is waiting for available service capacity."
            : null,
    };
  });
}

export async function createProjectRecord(userId: number, input: { name: string; narrationOriginalName?: string; imageSourcePath?: string; outputPath?: string }) {
  const db = await requireDb();
  await db.insert(projects).values({ userId, name: input.name, narrationOriginalName: input.narrationOriginalName || null, imageSourcePath: input.imageSourcePath || null, outputPath: input.outputPath || null });
}

export async function updateProjectSetup(userId: number, projectId: number, input: { narrationOriginalName?: string; imageSourcePath?: string; outputPath?: string }) {
  const db = await requireDb();
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  await db.update(projects).set({
    narrationOriginalName: input.narrationOriginalName?.trim() || null,
    imageSourcePath: input.imageSourcePath?.trim() || null,
    outputPath: input.outputPath?.trim() || null,
  }).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
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
  return (await db.select().from(groqApiKeys).where(eq(groqApiKeys.userId, userId))).map(record => ({ id: record.id, label: record.label, maskedKey: `${record.keyPrefix}••••••••${record.keySuffix}`, isActive: record.isActive, testStatus: record.testStatus, lastTestedAt: record.lastTestedAt, createdAt: record.createdAt }));
}

export async function getStoredGroqKey(userId: number, keyId: number) {
  const db = await requireDb();
  return (await db.select().from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId))).limit(1))[0];
}

export async function saveValidatedGroqKey(userId: number, input: { label: string; keyPrefix: string; keySuffix: string; keyFingerprint: string; encryptedCiphertext: string; encryptionIv: string; encryptionTag: string }) {
  const db = await requireDb();
  const duplicate = await db.select({ id: groqApiKeys.id }).from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.keyFingerprint, input.keyFingerprint))).limit(1);
  if (duplicate.length > 0) throw new Error("This Groq API key is already saved in your workspace.");
  const activeKeys = await db.select({ id: groqApiKeys.id }).from(groqApiKeys).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.isActive, true)));
  await db.insert(groqApiKeys).values({ ...input, userId, isActive: activeKeys.length === 0, testStatus: "verified", lastTestedAt: new Date() });
}

export async function recordGroqKeyTest(userId: number, keyId: number, testStatus: "verified" | "invalid" | "quota_limited" | "unavailable") {
  const db = await requireDb();
  await db.update(groqApiKeys).set({ testStatus, lastTestedAt: new Date() }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId)));
}

export async function activateGroqKey(userId: number, keyId: number) {
  const db = await requireDb();
  await db.transaction(async transaction => { await transaction.update(groqApiKeys).set({ isActive: false }).where(eq(groqApiKeys.userId, userId)); await transaction.update(groqApiKeys).set({ isActive: true }).where(and(eq(groqApiKeys.userId, userId), eq(groqApiKeys.id, keyId))); });
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
  const [segments, images] = await Promise.all([
    db.select({ imageAssetId: timelineSegments.imageAssetId }).from(timelineSegments).where(eq(timelineSegments.projectId, projectId)),
    db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed"))).orderBy(mediaAssets.sequenceNumber),
  ]);
  const selectedImageIds = new Set(segments.flatMap(segment => segment.imageAssetId ? [segment.imageAssetId] : []));
  return images
    .filter(image => !selectedImageIds.has(image.id))
    .map(image => ({
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
  const assetById = new Map(imageRecords.map(asset => [asset.id, asset]));
  const approval = (await db.select().from(timelineApprovals).where(eq(timelineApprovals.projectId, projectId)).limit(1))[0] ?? null;
  return {
    project,
    approval: approval ? { status: approval.status, approvedAt: approval.approvedAt, approvedByUserId: approval.userId } : { status: "pending" as const, approvedAt: null, approvedByUserId: null },
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
      selectionReason: `User selected ${candidate.originalFilename} from the analyzed candidate gallery. Original Gemini rationale: ${originalReason}`,
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
  return { projectId, approval: { approvedByUserId: review.approval.approvedByUserId, approvedAtMs: review.approval.approvedAt.getTime() }, output: { width: 1920 as const, height: 1080 as const, aspectRatio: "16:9" as const, container: "mp4" as const }, narration: asWorkerAsset(narration), images: assets.filter(asset => asset.assetType === "image").map(asWorkerAsset), timeline: review.segments.map(segment => ({ imageAssetId: segment.imageAssetId!, startMs: segment.startMs, endMs: segment.endMs, narrationText: segment.narrationText })) };
}
