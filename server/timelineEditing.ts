export type ImageTimelineSegment = { id: number; imageAssetId: number | null; startMs: number; endMs: number };

export function canEditValidatedTimeline(projectStatus: string) {
  return projectStatus === "timeline_ready" || projectStatus === "completed";
}

export function planImageSubstitution(segments: ImageTimelineSegment[], segmentId: number, newImageAssetId: number) {
  const target = segments.find(segment => segment.id === segmentId);
  if (!target) throw new Error("Timeline segment not found.");
  if (target.imageAssetId === newImageAssetId) throw new Error("This image is already selected for the segment.");
  return { segmentId: target.id, imageAssetId: newImageAssetId, startMs: target.startMs, endMs: target.endMs };
}
