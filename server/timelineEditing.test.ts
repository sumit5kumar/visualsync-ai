import { describe, expect, it } from "vitest";
import { canEditValidatedTimeline, MIN_TIMELINE_CLIP_DURATION_MS, planImageSubstitution, planTimelineBoundaryAdjustment, planTimelineVisualMove } from "./timelineEditing";

const segments = [
  { id: 31, imageAssetId: 7, startMs: 0, endMs: 1360 },
  { id: 32, imageAssetId: 8, startMs: 1360, endMs: 4920 },
];

describe("planImageSubstitution", () => {
  it("preserves the exact variable timing boundaries while changing only the image", () => {
    expect(planImageSubstitution(segments, 32, 24)).toEqual({ segmentId: 32, imageAssetId: 24, startMs: 1360, endMs: 4920 });
  });

  it("rejects the current image but allows a source image already used by another segment", () => {
    expect(() => planImageSubstitution(segments, 32, 8)).toThrow("already selected for the segment");
    expect(planImageSubstitution(segments, 32, 7)).toEqual({ segmentId: 32, imageAssetId: 7, startMs: 1360, endMs: 4920 });
  });
});

describe("canEditValidatedTimeline", () => {
  it("allows a completed project to revise its previously validated edit, but rejects unvalidated states", () => {
    expect(canEditValidatedTimeline("timeline_ready")).toBe(true);
    expect(canEditValidatedTimeline("completed")).toBe(true);
    expect(canEditValidatedTimeline("draft")).toBe(false);
    expect(canEditValidatedTimeline("analyzing")).toBe(false);
  });
});

describe("real Timeline timing edits", () => {
  it("moves only the shared boundary between adjacent clips while keeping both clips readable", () => {
    expect(planTimelineBoundaryAdjustment(segments, 31, "end", 2000)).toEqual({ segmentId: 31, edge: "end", boundaryMs: 2000, changedSegments: [{ id: 31, startMs: 0, endMs: 2000 }, { id: 32, startMs: 2000, endMs: 4920 }] });
  });

  it("rejects first or last outer boundaries and invalid short clip edits", () => {
    expect(() => planTimelineBoundaryAdjustment(segments, 31, "start", 200)).toThrow("first clip");
    expect(() => planTimelineBoundaryAdjustment(segments, 32, "end", 4000)).toThrow("last clip");
    expect(() => planTimelineBoundaryAdjustment(segments, 31, "end", MIN_TIMELINE_CLIP_DURATION_MS - 1)).toThrow("at least");
  });

  it("plans a visual insertion before a target Timeline position without modifying timing", () => {
    const ordered = [...segments, { id: 33, imageAssetId: 9, startMs: 4920, endMs: 7310 }];
    expect(planTimelineVisualMove(ordered, 31, 33, "before").assignments).toEqual([{ segmentId: 31, sourceSegmentId: 32, imageAssetId: 8 }, { segmentId: 32, sourceSegmentId: 31, imageAssetId: 7 }]);
    expect(planTimelineVisualMove(ordered, 31, 33, "before").placement).toBe("before");
  });
});
