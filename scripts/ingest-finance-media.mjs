import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { mediaAssets, projects } from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { storagePut } from "../server/storage.ts";

const projectId = 60001;
const userId = 1;
const sourceDir = "/home/ubuntu/webdev-static-assets/visualsync-finance/source";
const narrationFilename = "finance.wav";
const audioDurationMs = 67451;
const hash = data => createHash("sha256").update(data).digest("hex");
const naturalCompare = (left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

const db = await getDb();
if (!db) throw new Error("Database storage is not available.");
const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
if (!project) throw new Error("Finance project was not found for the authenticated owner.");
const existing = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId))).limit(1);
if (existing.length) throw new Error("Finance media is already attached; refusing to duplicate real source assets.");

const entries = await readdir(sourceDir, { withFileTypes: true });
const images = entries.filter(entry => entry.isFile() && /\.jpe?g$/i.test(entry.name)).map(entry => entry.name).sort(naturalCompare);
if (!images.length) throw new Error("No Finance JPEG images were found in the staged source folder.");

const narrationBytes = await readFile(join(sourceDir, narrationFilename));
const narrationUpload = await storagePut(`projects/${projectId}/narration/${narrationFilename}`, narrationBytes, "audio/wav");
const imageRows = [];
for (const [index, filename] of images.entries()) {
  const bytes = await readFile(join(sourceDir, filename));
  const upload = await storagePut(`projects/${projectId}/images/${filename}`, bytes, "image/jpeg");
  imageRows.push({ userId, projectId, assetType: "image", originalFilename: filename, storageKey: upload.key, mimeType: "image/jpeg", byteSize: bytes.length, sequenceNumber: index + 1, contentHash: hash(bytes), analysisState: "pending" });
}

await db.transaction(async transaction => {
  await transaction.insert(mediaAssets).values([
    { userId, projectId, assetType: "narration", originalFilename: narrationFilename, storageKey: narrationUpload.key, mimeType: "audio/wav", byteSize: narrationBytes.length, sequenceNumber: null, contentHash: hash(narrationBytes), analysisState: "pending" },
    ...imageRows,
  ]);
  await transaction.update(projects).set({ narrationOriginalName: narrationFilename, narrationStorageKey: narrationUpload.key, imageSourcePath: "C:\\Users\\sumit\\Downloads\\Finance", outputPath: "C:\\Users\\sumit\\Downloads\\Nothing", audioDurationMs, status: "ready", workerState: "ready" }).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
});

console.log(JSON.stringify({ projectId, narration: narrationFilename, audioDurationMs, imageCount: images.length, status: "ready" }));
process.exit(0);
