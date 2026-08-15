import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({ authenticateRequest: vi.fn(), saveUploadedProjectMedia: vi.fn(), storagePut: vi.fn() }));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticateRequest } }));
vi.mock("./db", () => ({ saveUploadedProjectMedia: mocks.saveUploadedProjectMedia }));
vi.mock("./storage", () => ({ storagePut: mocks.storagePut }));

import { projectMediaBodyParserOptions, validateProjectMediaUpload } from "./projectMediaRoutes";
import { registerProjectMediaRoutes } from "./projectMediaRoutes";

afterEach(() => vi.clearAllMocks());

async function requestUpload(headers: Record<string, string>, bytes: Uint8Array) {
  const app = express();
  registerProjectMediaRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const running = app.listen(0, () => resolve(running)); });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
    return await fetch(`http://127.0.0.1:${address.port}/api/project-media/upload`, { method: "POST", headers, body: bytes });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("project media upload route", () => {
  it("parses browser-selected audio and image MIME uploads as raw file bytes", () => {
    expect(projectMediaBodyParserOptions.type("audio/wav")).toBe(true);
    expect(projectMediaBodyParserOptions.type("audio/mpeg")).toBe(true);
    expect(projectMediaBodyParserOptions.type("image/jpeg")).toBe(true);
    expect(projectMediaBodyParserOptions.type("image/png")).toBe(true);
  });

  it("accepts complete browser narration and image upload metadata", () => {
    const narrationError = validateProjectMediaUpload({ projectId: 1, assetType: "narration", originalFilename: "narration.wav", body: Buffer.from("audio"), sequenceNumber: Number.NaN, audioDurationMs: 12_000 });
    const imageError = validateProjectMediaUpload({ projectId: 1, assetType: "image", originalFilename: "01.jpg", body: Buffer.from("image"), sequenceNumber: 1, audioDurationMs: Number.NaN });
    expect(narrationError).toBeNull();
    expect(imageError).toBeNull();
  });

  it("rejects incomplete browser media metadata with an actionable error", () => {
    expect(validateProjectMediaUpload({ projectId: 1, assetType: "image", originalFilename: "", body: Buffer.from("image"), sequenceNumber: 1, audioDurationMs: Number.NaN })).toBe("The selected project media upload is incomplete.");
  });

  it("persists browser-selected WAV and JPEG requests through the repaired raw upload handler", async () => {
    mocks.authenticateRequest.mockResolvedValue({ id: 7 });
    mocks.storagePut.mockResolvedValue({ key: "projects/1/test", url: "/manus-storage/projects/1/test" });
    mocks.saveUploadedProjectMedia.mockResolvedValue({ success: true });
    const audio = await requestUpload({ "content-type": "audio/wav", "x-project-id": "1", "x-asset-type": "narration", "x-original-filename": "narration.wav", "x-audio-duration-ms": "12000" }, new Uint8Array([1, 2, 3]));
    const image = await requestUpload({ "content-type": "image/jpeg", "x-project-id": "1", "x-asset-type": "image", "x-original-filename": "01.jpg", "x-sequence-number": "1" }, new Uint8Array([4, 5, 6]));
    expect(audio.status).toBe(201);
    expect(image.status).toBe(201);
    expect(mocks.saveUploadedProjectMedia).toHaveBeenCalledWith(expect.objectContaining({ assetType: "narration", originalFilename: "narration.wav", audioDurationMs: 12000 }));
    expect(mocks.saveUploadedProjectMedia).toHaveBeenCalledWith(expect.objectContaining({ assetType: "image", originalFilename: "01.jpg", sequenceNumber: 1 }));
  });
});
