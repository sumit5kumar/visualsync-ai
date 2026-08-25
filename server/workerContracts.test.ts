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
    const handoff = workerPayloadSchemas.renderHandoff.parse({ projectId: 1, projectName: "Finance project", approval: { approvedByUserId: 1, approvedAtMs: 1 }, nativePaths: { sourceDirectory: "C:\\Users\\sumit\\Downloads\\Finance", outputDirectory: "C:\\Users\\sumit\\Downloads\\Nothing" }, output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4", filename: "Finance_project_approved_1920x1080.mp4" }, zoom: { enabled: true, amountPercent: 12, direction: "IN", enabledDirections: ["IN", "OUT"] }, crossfade: { durationMs: 800 }, transition: { type: "RANDOM", enabled: ["CROSSFADE", "WIPE_LEFT"] }, narration: { assetId: 1, filename: "audio.wav", storageKey: "audio.wav", mimeType: "audio/wav", sequenceNumber: null, contentHash: null, perceptualHash: null }, images: [{ assetId: 2, filename: "01.jpg", storageKey: "01.jpg", mimeType: "image/jpeg", sequenceNumber: 1, contentHash: null, perceptualHash: null }], timeline: [{ imageAssetId: 2, startMs: 0, endMs: 1000, narrationText: "Narration" }] });
    expect(handoff.output.filename).toBe("Finance_project_approved_1920x1080.mp4");
    expect(handoff.zoom).toEqual({ enabled: true, amountPercent: 12, direction: "IN", enabledDirections: ["IN", "OUT"] });
    expect(handoff.crossfade).toEqual({ durationMs: 800 });
    expect(handoff.transition).toEqual({ type: "RANDOM", enabled: ["CROSSFADE", "WIPE_LEFT"] });
  });

  it("accepts deterministic pan and Ken Burns effect directions without changing the existing zoom direction contract", () => {
    const handoff = workerPayloadSchemas.renderHandoff.parse({ projectId: 1, projectName: "Finance project", approval: { approvedByUserId: 1, approvedAtMs: 1 }, nativePaths: { sourceDirectory: "C:\\Users\\sumit\\Downloads\\Finance", outputDirectory: "C:\\Users\\sumit\\Downloads\\Nothing" }, output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4", filename: "Finance_project_approved_1920x1080.mp4" }, zoom: { enabled: true, amountPercent: 8, direction: "AUTO", enabledDirections: ["PAN_LEFT", "PAN_RIGHT", "DIAGONAL", "KEN_BURNS"] }, crossfade: { durationMs: 800 }, transition: { type: "CROSSFADE", enabled: ["CROSSFADE"] }, narration: { assetId: 1, filename: "audio.wav", storageKey: "audio.wav", mimeType: "audio/wav", sequenceNumber: null, contentHash: null, perceptualHash: null }, images: [{ assetId: 2, filename: "01.jpg", storageKey: "01.jpg", mimeType: "image/jpeg", sequenceNumber: 1, contentHash: null, perceptualHash: null }], timeline: [{ imageAssetId: 2, startMs: 0, endMs: 1000, narrationText: "Narration" }] });
    expect(handoff.zoom.direction).toBe("AUTO");
    expect(handoff.zoom.enabledDirections).toEqual(["PAN_LEFT", "PAN_RIGHT", "DIAGONAL", "KEN_BURNS"]);
  });

  it("accepts the Fast Render handoff combination of static images and direct cuts", () => {
    const handoff = workerPayloadSchemas.renderHandoff.parse({ projectId: 1, projectName: "Finance project", approval: { approvedByUserId: 1, approvedAtMs: 1 }, nativePaths: { sourceDirectory: "C:\\Users\\sumit\\Downloads\\Finance", outputDirectory: "C:\\Users\\sumit\\Downloads\\Nothing" }, output: { width: 1920, height: 1080, aspectRatio: "16:9", container: "mp4", filename: "Finance_project_approved_1920x1080.mp4" }, zoom: { enabled: false, amountPercent: 8, direction: "IN", enabledDirections: ["IN"] }, crossfade: { durationMs: 0 }, transition: { type: "NONE", enabled: ["CROSSFADE"] }, narration: { assetId: 1, filename: "audio.wav", storageKey: "audio.wav", mimeType: "audio/wav", sequenceNumber: null, contentHash: null, perceptualHash: null }, images: [{ assetId: 2, filename: "01.jpg", storageKey: "01.jpg", mimeType: "image/jpeg", sequenceNumber: 1, contentHash: null, perceptualHash: null }], timeline: [{ imageAssetId: 2, startMs: 0, endMs: 1000, narrationText: "Narration" }] });
    expect(handoff.zoom.enabled).toBe(false);
    expect(handoff.crossfade.durationMs).toBe(0);
  });
});
