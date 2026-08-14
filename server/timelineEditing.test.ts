import { describe, expect, it } from "vitest";
import { planImageSubstitution } from "./timelineEditing";

const segments = [
  { id: 31, imageAssetId: 7, startMs: 0, endMs: 1360 },
  { id: 32, imageAssetId: 8, startMs: 1360, endMs: 4920 },
];

describe("planImageSubstitution", () => {
  it("preserves the exact variable timing boundaries while changing only the image", () => {
    expect(planImageSubstitution(segments, 32, 24)).toEqual({ segmentId: 32, imageAssetId: 24, startMs: 1360, endMs: 4920 });
  });

  it("rejects selecting the current or another segment's image", () => {
    expect(() => planImageSubstitution(segments, 32, 8)).toThrow("already selected for the segment");
    expect(() => planImageSubstitution(segments, 32, 7)).toThrow("not already used");
  });
});
