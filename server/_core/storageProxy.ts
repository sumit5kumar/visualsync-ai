import fs from "node:fs";
import type { Express } from "express";
import { MAX_UPLOAD_BYTES } from "../projectMediaRoutes";
import { ensureStorageDir, storageKeyPath, verifyUploadTicket } from "../storage";

export function registerStorageProxy(app: Express) {
  // Serve stored media from local disk. sendFile handles Range requests,
  // which the analysis pipeline uses for bounded reads of large media.
  app.get("/manus-storage/*", (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    let filePath: string;
    try {
      filePath = storageKeyPath(key);
    } catch {
      res.status(400).send("Invalid storage key");
      return;
    }
    res.set("Cache-Control", "no-store");
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(404).send("Storage file not found");
    });
  });

  // Ticket-authorized direct PUT for large client uploads. The ticket is
  // minted by /api/project-media/direct-ticket for an authenticated user and
  // only covers this exact key.
  app.put("/api/storage/put/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key || !verifyUploadTicket(key, req.query.t)) {
      res.status(403).json({ error: "Invalid upload ticket." });
      return;
    }
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "File is too large." });
      return;
    }
    let filePath: string;
    try {
      filePath = storageKeyPath(key);
      await ensureStorageDir(filePath);
    } catch {
      res.status(400).json({ error: "Invalid storage key." });
      return;
    }
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);
    writeStream.on("finish", () => res.status(201).json({ success: true }));
    writeStream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "Upload failed." });
      else res.end();
    });
  });
}
