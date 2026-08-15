import crypto from "crypto";
import express, { type Express } from "express";
import path from "node:path";
import { sdk } from "./_core/sdk";
import { saveRenderedProjectVideo, saveUploadedProjectMedia } from "./db";
import { storagePut } from "./storage";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const safeFilename = (filename: string) => filename.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+/, "").slice(0, 180) || "upload";
export const projectMediaBodyParserOptions = { type: () => true, limit: MAX_UPLOAD_BYTES };

export function validateProjectMediaUpload(input: { projectId: number; assetType: string | null; originalFilename: string; body: unknown; sequenceNumber: number; audioDurationMs: number }) {
  if (!Number.isInteger(input.projectId) || input.projectId <= 0 || (input.assetType !== "narration" && input.assetType !== "image") || !input.originalFilename || !Buffer.isBuffer(input.body) || !input.body.length) return "The selected project media upload is incomplete.";
  if (input.assetType === "image" && (!Number.isInteger(input.sequenceNumber) || input.sequenceNumber < 1)) return "Every selected image needs a positive sequence number.";
  if (input.assetType === "narration" && (!Number.isInteger(input.audioDurationMs) || input.audioDurationMs <= 0)) return "The selected narration needs a measurable duration.";
  return null;
}

export function registerProjectMediaRoutes(app: Express) {
  app.get("/api/project-media/latest-worker", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user) return res.status(401).json({ error: "Sign in before downloading the native worker." });
    return res.download(path.resolve(process.cwd(), "native-worker", "render-approved-handoff.ps1"), "render-approved-handoff.ps1");
  });
  app.post("/api/project-media/upload", express.raw(projectMediaBodyParserOptions), async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) return res.status(401).json({ error: "Sign in before uploading project media." });
      const projectId = Number(req.header("x-project-id"));
      const assetType = req.header("x-asset-type") ?? null;
      const originalFilename = decodeURIComponent(req.header("x-original-filename") ?? "").replace(/[\\/]/g, "").trim().slice(0, 255);
      const storageFilename = safeFilename(originalFilename);
      const requestedSequenceNumber = Number(req.header("x-sequence-number"));
      const requestedAudioDurationMs = Number(req.header("x-audio-duration-ms"));
      const mimeType = req.header("content-type")?.split(";")[0] || "application/octet-stream";
      const validationError = validateProjectMediaUpload({ projectId, assetType, originalFilename, body: req.body, sequenceNumber: requestedSequenceNumber, audioDurationMs: requestedAudioDurationMs });
      if (validationError) return res.status(400).json({ error: validationError });
      if (assetType !== "narration" && assetType !== "image") return res.status(400).json({ error: "The selected project media upload is incomplete." });
      const contentHash = crypto.createHash("sha256").update(req.body).digest("hex");
      const sequenceNumber = assetType === "image" ? requestedSequenceNumber : null;
      const audioDurationMs = assetType === "narration" ? requestedAudioDurationMs : null;
      const stored = await storagePut(`projects/${projectId}/${assetType}/${assetType === "image" ? `${String(requestedSequenceNumber).padStart(4, "0")}_` : ""}${storageFilename}`, req.body, mimeType);
      await saveUploadedProjectMedia({ userId: user.id, projectId, assetType, originalFilename, storageKey: stored.key, mimeType, byteSize: req.body.length, contentHash, sequenceNumber, audioDurationMs });
      return res.status(201).json({ success: true, filename: originalFilename, storageKey: stored.key });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project media could not be uploaded.";
      return res.status(400).json({ error: message });
    }
  });

  app.post("/api/project-media/rendered-video", express.raw({ type: () => true, limit: 500 * 1024 * 1024 }), async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) return res.status(401).json({ error: "Sign in before importing a rendered video." });
      const projectId = Number(req.header("x-project-id"));
      const originalFilename = decodeURIComponent(req.header("x-original-filename") ?? "").replace(/[\\/]/g, "").trim().slice(0, 255);
      const mimeType = req.header("content-type")?.split(";")[0] || "video/mp4";
      if (!Number.isInteger(projectId) || projectId <= 0 || !originalFilename.toLowerCase().endsWith(".mp4") || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Choose a rendered MP4 file to import." });
      const contentHash = crypto.createHash("sha256").update(req.body).digest("hex");
      const stored = await storagePut(`projects/${projectId}/rendered/${safeFilename(originalFilename)}`, req.body, mimeType);
      await saveRenderedProjectVideo({ userId: user.id, projectId, originalFilename, storageKey: stored.key, mimeType, byteSize: req.body.length, contentHash });
      return res.status(201).json({ success: true, filename: originalFilename, storageKey: stored.key });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Rendered video could not be imported." });
    }
  });
}
