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
  status: mysqlEnum("status", ["draft", "ready", "analyzing", "timeline_ready", "rendering", "completed", "failed"]).notNull().default("draft"),
  workerState: mysqlEnum("workerState", ["unconfigured", "ready", "processing", "error"]).notNull().default("unconfigured"),
  audioDurationMs: int("audioDurationMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("projects_user_updated_idx").on(table.userId, table.updatedAt)]);

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

export const mediaAssets = mysqlTable("mediaAssets", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  projectId: int("projectId"),
  assetType: mysqlEnum("assetType", ["narration", "image"]).notNull(),
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
export type TimelineSegment = typeof timelineSegments.$inferSelect;
export type TimelineApproval = typeof timelineApprovals.$inferSelect;
