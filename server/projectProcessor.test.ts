import { describe, expect, it } from "vitest";
import { buildPublicManagedStorageUrl, mapWithConcurrency } from "./projectProcessor";

describe("public managed narration URLs", () => {
  it("keeps the managed storage path public and safely encodes every storage-key segment", () => {
    expect(buildPublicManagedStorageUrl("https://visualsync.example.test", "projects/360001/33 strategy.mp3")).toBe("https://visualsync.example.test/manus-storage/projects/360001/33%20strategy.mp3");
  });

  it("persists a large chunk plan through a bounded ordered worker pool", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async value => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(maximumActive).toBeLessThanOrEqual(3);
  });
});
