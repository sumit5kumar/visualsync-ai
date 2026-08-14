import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const projectId = 30001;
const outputPath = path.resolve("generated/approved-render-handoff.json");
const connection = await mysql.createConnection(process.env.DATABASE_URL);

try {
  const [projects] = await connection.execute(
    `SELECT p.id, p.audioDurationMs, ta.userId AS approvedByUserId, UNIX_TIMESTAMP(ta.approvedAt) * 1000 AS approvedAtMs
     FROM projects p JOIN timelineApprovals ta ON ta.projectId = p.id
     WHERE p.id = ? AND p.status = 'timeline_ready' AND ta.status = 'approved' AND ta.approvedAt IS NOT NULL`,
    [projectId],
  );
  const project = projects[0];
  if (!project) throw new Error("A valid approved Nothing timeline is required before the handoff can be generated.");

  const [assets] = await connection.execute(
    `SELECT id, assetType, originalFilename, storageKey, mimeType, sequenceNumber, contentHash, perceptualHash
     FROM mediaAssets WHERE projectId = ? AND assetType IN ('narration', 'image') ORDER BY sequenceNumber`,
    [projectId],
  );
  const [segments] = await connection.execute(
    `SELECT imageAssetId, startMs, endMs, narrationText FROM timelineSegments WHERE projectId = ? ORDER BY startMs`,
    [projectId],
  );
  const narration = assets.find(asset => asset.assetType === "narration");
  const images = assets.filter(asset => asset.assetType === "image");
  if (!narration || !segments.length || segments.some(segment => !segment.imageAssetId)) throw new Error("The approved timeline is missing its narration or selected images.");
  if (Number(segments[0].startMs) !== 0 || Number(segments.at(-1).endMs) !== Number(project.audioDurationMs)) throw new Error("The approved timeline does not cover the full narration duration.");
  for (let index = 1; index < segments.length; index += 1) {
    if (Number(segments[index - 1].endMs) !== Number(segments[index].startMs)) throw new Error("The approved timeline has a gap or overlap.");
  }

  const asWorkerAsset = asset => ({ assetId: asset.id, filename: asset.originalFilename, storageKey: asset.storageKey, mimeType: asset.mimeType ?? "application/octet-stream", sequenceNumber: asset.sequenceNumber, contentHash: asset.contentHash, perceptualHash: asset.perceptualHash });
  const handoff = {
    projectId,
    approval: { approvedByUserId: Number(project.approvedByUserId), approvedAtMs: Number(project.approvedAtMs) },
    output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4" },
    narration: asWorkerAsset(narration),
    images: images.map(asWorkerAsset),
    timeline: segments.map(segment => ({ imageAssetId: Number(segment.imageAssetId), startMs: Number(segment.startMs), endMs: Number(segment.endMs), narrationText: segment.narrationText })),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  console.log(`HANDOFF=${outputPath}`);
  console.log(`SEGMENTS=${handoff.timeline.length}`);
  console.log(`DURATION_MS=${handoff.timeline.at(-1).endMs}`);
} finally {
  await connection.end();
}
