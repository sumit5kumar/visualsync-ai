import { boolean, decimal, index, int, json, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  narrationStorageKey: varchar("narrationStorageKey", { length: 512 }),
  narrationOriginalName: varchar("narrationOriginalName", { length: 255 }),
  imageSourcePath: text("imageSourcePath"),
  outputPath: text("outputPath"),
  resolutionWidth: int("resolutionWidth").notNull().default(1920),
  resolutionHeight: int("resolutionHeight").notNull().default(1080),
  aspectRatio: varchar("aspectRatio", { length: 12 }).notNull().default("16:9"),
  zoomEnabled: boolean("zoomEnabled").notNull().default(true),
  zoomAmountPercent: int("zoomAmountPercent").notNull().default(8),
  zoomDirection: mysqlEnum("zoomDirection", ["IN", "OUT", "AUTO"]).notNull().default("IN"),
  zoomRandomMix: boolean("zoomRandomMix").notNull().default(false),
  enabledZoomDirections: varchar("enabledZoomDirections", { length: 100 }).notNull().default("IN,OUT"),
  crossfadeDurationMs: int("crossfadeDurationMs").notNull().default(800),
  transitionType: varchar("transitionType", { length: 24 }).notNull().default("CROSSFADE"),
  enabledTransitions: varchar("enabledTransitions", { length: 200 }).notNull().default("CROSSFADE"),
  status: mysqlEnum("status", ["draft", "ready", "analyzing", "timeline_ready", "rendering", "completed", "failed"]).notNull().default("draft"),
  workerState: mysqlEnum("workerState", ["unconfigured", "ready", "processing", "error"]).notNull().default("unconfigured"),
  processingStage: mysqlEnum("processingStage", ["idle", "transcribing", "analyzing_images", "building_timeline", "finalizing", "failed"]).notNull().default("idle"),
  processingStartedAt: timestamp("processingStartedAt"),
  processingStageStartedAt: timestamp("processingStageStartedAt"),
  audioDurationMs: int("audioDurationMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("projects_user_updated_idx").on(table.userId, table.updatedAt)]);

export const timelineGenerationJobs = mysqlTable("timelineGenerationJobs", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull().unique(),
  userId: int("userId").notNull(),
  status: mysqlEnum("status", ["queued", "processing", "waiting_for_retry", "completed", "failed"]).notNull().default("queued"),
  currentStage: mysqlEnum("currentStage", ["queued", "transcribing", "analyzing_images", "building_timeline", "finalizing", "completed", "failed"]).notNull().default("queued"),
  attemptCount: int("attemptCount").notNull().default(0),
  transientFailureCount: int("transientFailureCount").notNull().default(0),
  retryAt: timestamp("retryAt"),
  lastError: json("lastError"),
  workState: json("workState"),
  scheduleCronTaskUid: varchar("scheduleCronTaskUid", { length: 65 }),
  leaseToken: varchar("leaseToken", { length: 64 }),
  leaseExpiresAt: timestamp("leaseExpiresAt"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("timeline_generation_jobs_user_status_idx").on(table.userId, table.status), index("timeline_generation_jobs_schedule_uid_idx").on(table.scheduleCronTaskUid)]);

export const geminiApiKeys = mysqlTable("geminiApiKeys", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  keyPrefix: varchar("keyPrefix", { length: 8 }).notNull(),
  keySuffix: varchar("keySuffix", { length: 8 }).notNull(),
  keyFingerprint: varchar("keyFingerprint", { length: 64 }).notNull(),
  encryptedCiphertext: text("encryptedCiphertext").notNull(),
  encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
  encryptionTag: varchar("encryptionTag", { length: 32 }).notNull(),
  isActive: boolean("isActive").notNull().default(false),
  testStatus: mysqlEnum("testStatus", ["untested", "verified", "invalid", "quota_limited", "unavailable"]).notNull().default("untested"),
  lastTestedAt: timestamp("lastTestedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("gemini_keys_user_idx").on(table.userId)]);

export const groqApiKeys = mysqlTable("groqApiKeys", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  keyPrefix: varchar("keyPrefix", { length: 8 }).notNull(),
  keySuffix: varchar("keySuffix", { length: 8 }).notNull(),
  keyFingerprint: varchar("keyFingerprint", { length: 64 }).notNull(),
  encryptedCiphertext: text("encryptedCiphertext").notNull(),
  encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
  encryptionTag: varchar("encryptionTag", { length: 32 }).notNull(),
  isActive: boolean("isActive").notNull().default(false),
  rotationOrder: int("rotationOrder").notNull().default(0),
  projectVerification: mysqlEnum("projectVerification", ["unverified", "default_project_verified", "externally_verified"]).notNull().default("unverified"),
  transcriptionProbeAt: timestamp("transcriptionProbeAt"),
  generationProbeAt: timestamp("generationProbeAt"),
  projectVerifiedAt: timestamp("projectVerifiedAt"),
  projectVerificationError: text("projectVerificationError"),
  testStatus: mysqlEnum("testStatus", ["untested", "verified", "invalid", "permission_restricted", "quota_limited", "unavailable"]).notNull().default("untested"),
  lastTestedAt: timestamp("lastTestedAt"),
  lastUsedAt: timestamp("lastUsedAt"),
  lastFailureAt: timestamp("lastFailureAt"),
  cooldownUntil: timestamp("cooldownUntil"),
  consecutiveRateLimits: int("consecutiveRateLimits").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("groq_keys_user_idx").on(table.userId)]);

export const groqKeyRotationStates = mysqlTable("groqKeyRotationStates", {
  userId: int("userId").primaryKey(),
  nextRotationOrder: int("nextRotationOrder").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const mediaAssets = mysqlTable("mediaAssets", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  projectId: int("projectId"),
  assetType: mysqlEnum("assetType", ["narration", "image", "rendered_video"]).notNull(),
  originalFilename: varchar("originalFilename", { length: 255 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  mimeType: varchar("mimeType", { length: 128 }),
  byteSize: int("byteSize"),
  sequenceNumber: int("sequenceNumber"),
  contentHash: varchar("contentHash", { length: 128 }),
  perceptualHash: varchar("perceptualHash", { length: 128 }),
  analysisState: mysqlEnum("analysisState", ["pending", "cached", "analyzed", "failed"]).notNull().default("pending"),
  analysisJson: json("analysisJson"),
  embeddingSourceText: text("embeddingSourceText"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("media_assets_user_hash_idx").on(table.userId, table.contentHash), index("media_assets_project_sequence_idx").on(table.projectId, table.sequenceNumber)]);

export const timelineSegments = mysqlTable("timelineSegments", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  imageAssetId: int("imageAssetId"),
  startMs: int("startMs").notNull(),
  endMs: int("endMs").notNull(),
  narrationText: text("narrationText").notNull(),
  confidence: decimal("confidence", { precision: 5, scale: 4 }).notNull(),
  selectionReason: text("selectionReason").notNull(),
  candidateImagesJson: json("candidateImagesJson"),
  decisionType: mysqlEnum("decisionType", ["KEEP", "CHANGE", "SKIP", "FALLBACK"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("timeline_segments_project_start_idx").on(table.projectId, table.startMs)]);

export const timelineApprovals = mysqlTable("timelineApprovals", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull().unique(),
  userId: int("userId").notNull(),
  status: mysqlEnum("status", ["pending", "approved", "revoked"]).notNull().default("pending"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("timeline_approvals_user_idx").on(table.userId)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type GeminiApiKey = typeof geminiApiKeys.$inferSelect;
export type GroqApiKey = typeof groqApiKeys.$inferSelect;
export type TimelineSegment = typeof timelineSegments.$inferSelect;
export type TimelineApproval = typeof timelineApprovals.$inferSelect;
