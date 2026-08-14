import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { geminiApiKeys, mediaAssets, projects, timelineApprovals, timelineSegments, type InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

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

export async function listProjectTimeline(userId: number, projectId: number) {
  const project = await getUserProject(userId, projectId);
  if (!project) throw new Error("Project not found.");
  const db = await requireDb();
  return db.select().from(timelineSegments).where(eq(timelineSegments.projectId, projectId)).orderBy(timelineSegments.startMs);
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
