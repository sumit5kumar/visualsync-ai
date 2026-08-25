export function canEditValidatedTimeline(projectStatus: string) {
  return projectStatus === "timeline_ready" || projectStatus === "completed";
}

export const MIN_TIMELINE_CLIP_DURATION_MS = 1_000;

type TimingSegment = { id: number; imageAssetId: number | null; startMs: number; endMs: number };
type TimingEdge = "start" | "end";
export type TimelineVisualPlacement = "swap" | "before" | "after";

export function planTimelineBoundaryAdjustment(segments: TimingSegment[], segmentId: number, edge: TimingEdge, boundaryMs: number) {
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs);
  const index = ordered.findIndex(segment => segment.id === segmentId);
  const target = ordered[index];
  if (!target) throw new Error("Timeline segment not found.");
  if (!Number.isInteger(boundaryMs)) throw new Error("Timeline boundary must be a whole millisecond.");
  const adjacent = edge === "start" ? ordered[index - 1] : ordered[index + 1];
  if (!adjacent) throw new Error(edge === "start" ? "The first clip always starts with the narration." : "The last clip always ends with the narration.");
  const lower = edge === "start" ? adjacent.startMs + MIN_TIMELINE_CLIP_DURATION_MS : target.startMs + MIN_TIMELINE_CLIP_DURATION_MS;
  const upper = edge === "start" ? target.endMs - MIN_TIMELINE_CLIP_DURATION_MS : adjacent.endMs - MIN_TIMELINE_CLIP_DURATION_MS;
  if (boundaryMs < lower || boundaryMs > upper) throw new Error(`Keep both neighboring clips at least ${MIN_TIMELINE_CLIP_DURATION_MS / 1000} second long.`);
  const changedSegments = edge === "start" ? [{ id: adjacent.id, startMs: adjacent.startMs, endMs: boundaryMs }, { id: target.id, startMs: boundaryMs, endMs: target.endMs }] : [{ id: target.id, startMs: target.startMs, endMs: boundaryMs }, { id: adjacent.id, startMs: boundaryMs, endMs: adjacent.endMs }];
  return { segmentId, edge, boundaryMs, changedSegments };
}

export function planTimelineVisualMove(segments: TimingSegment[], sourceSegmentId: number, targetSegmentId: number, placement: TimelineVisualPlacement = "swap") {
  if (sourceSegmentId === targetSegmentId) throw new Error("Choose a different clip position.");
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs);
  const sourceIndex = ordered.findIndex(segment => segment.id === sourceSegmentId);
  const targetIndex = ordered.findIndex(segment => segment.id === targetSegmentId);
  const source = ordered[sourceIndex]; const target = ordered[targetIndex];
  if (!source || !target || !source.imageAssetId || !target.imageAssetId) throw new Error("Both Timeline clips require a selected image.");
  if (placement === "swap") return { sourceSegmentId, targetSegmentId, placement, sourceImageAssetId: source.imageAssetId, targetImageAssetId: target.imageAssetId, assignments: [{ segmentId: source.id, sourceSegmentId: target.id, imageAssetId: target.imageAssetId }, { segmentId: target.id, sourceSegmentId: source.id, imageAssetId: source.imageAssetId }] };
  const visualOrder = [...ordered]; const [moving] = visualOrder.splice(sourceIndex, 1);
  const targetAfterRemoval = visualOrder.findIndex(segment => segment.id === targetSegmentId);
  const insertIndex = placement === "before" ? targetAfterRemoval : targetAfterRemoval + 1;
  visualOrder.splice(insertIndex, 0, moving);
  const assignments = ordered.map((position, index) => ({ segmentId: position.id, sourceSegmentId: visualOrder[index].id, imageAssetId: visualOrder[index].imageAssetId! })).filter(assignment => assignment.sourceSegmentId !== assignment.segmentId);
  if (!assignments.length) throw new Error("That visual is already in this position.");
  return { sourceSegmentId, targetSegmentId, placement, sourceImageAssetId: source.imageAssetId, targetImageAssetId: target.imageAssetId, assignments };
}

export function planImageSubstitution(segments: TimingSegment[], segmentId: number, newImageAssetId: number) {
  const target = segments.find(segment => segment.id === segmentId);
  if (!target) throw new Error("Timeline segment not found.");
  if (target.imageAssetId === newImageAssetId) throw new Error("This image is already selected for the segment.");
  return { segmentId: target.id, imageAssetId: newImageAssetId, startMs: target.startMs, endMs: target.endMs };
}
