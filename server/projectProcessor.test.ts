import { describe, expect, it } from "vitest";
import { buildPublicManagedStorageUrl } from "./projectProcessor";

describe("public managed narration URLs", () => {
  it("keeps the managed storage path public and safely encodes every storage-key segment", () => {
    expect(buildPublicManagedStorageUrl("https://visualsync.example.test", "projects/360001/33 strategy.mp3")).toBe("https://visualsync.example.test/manus-storage/projects/360001/33%20strategy.mp3");
  });
});
