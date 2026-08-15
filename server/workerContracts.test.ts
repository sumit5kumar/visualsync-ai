import { describe, expect, it } from "vitest";
import { compareNaturalFilenames, getWorkerCapabilities, workerPayloadSchemas } from "./workerContracts";

describe("VisualSync local-worker contract", () => {
  it("sorts numbered story frames naturally before downstream analysis", () => {
    const files = ["10.jpg", "2.jpg", "001.jpg", "1.jpg"].sort(compareNaturalFilenames);
    expect(files).toEqual(["001.jpg", "1.jpg", "2.jpg", "10.jpg"]);
  });

  it("requires FAISS, variable timeline rendering, and review approval in the capability declaration", () => {
    const capabilities = getWorkerCapabilities();
    expect(capabilities.guarantees.join(" ")).toContain("FAISS");
    expect(capabilities.guarantees.join(" ")).toContain("variable-duration");
    expect(capabilities.guarantees.join(" ")).toContain("approved timeline review");
  });

  it("requires approval metadata before accepting a native FFmpeg handoff", () => {
    expect(() => workerPayloadSchemas.renderHandoff.parse({ projectId: 1, output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4" }, narration: { assetId: 1, filename: "audio.wav", storageKey: "audio.wav", mimeType: "audio/wav", sequenceNumber: null, contentHash: null, perceptualHash: null }, images: [{ assetId: 2, filename: "01.jpg", storageKey: "01.jpg", mimeType: "image/jpeg", sequenceNumber: 1, contentHash: null, perceptualHash: null }], timeline: [{ imageAssetId: 2, startMs: 0, endMs: 1000, narrationText: "Narration" }] })).toThrow();
  });

  it("accepts a project-specific output filename in an approved native handoff", () => {
    const handoff = workerPayloadSchemas.renderHandoff.parse({ projectId: 1, projectName: "Finance project", approval: { approvedByUserId: 1, approvedAtMs: 1 }, output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4", filename: "Finance_project_approved_1920x1080.mp4" }, narration: { assetId: 1, filename: "audio.wav", storageKey: "audio.wav", mimeType: "audio/wav", sequenceNumber: null, contentHash: null, perceptualHash: null }, images: [{ assetId: 2, filename: "01.jpg", storageKey: "01.jpg", mimeType: "image/jpeg", sequenceNumber: 1, contentHash: null, perceptualHash: null }], timeline: [{ imageAssetId: 2, startMs: 0, endMs: 1000, narrationText: "Narration" }] });
    expect(handoff.output.filename).toBe("Finance_project_approved_1920x1080.mp4");
  });
});
