export type ProposedTimelineSegment = { startMs: number; endMs: number; imageAssetId?: number | null; narrationText: string; confidence: number; selectionReason: string; decisionType: "KEEP" | "CHANGE" | "SKIP" | "FALLBACK" };
export type ValidatedTimelineSegment = ProposedTimelineSegment & { durationMs: number };
export type TimelineValidationResult = { valid: boolean; issues: string[]; segments: ValidatedTimelineSegment[] };
const TIMING_TOLERANCE_MS = 0.5;
const sameBoundary = (left: number, right: number) => Math.abs(left - right) <= TIMING_TOLERANCE_MS;

export function validateTimeline(audioDurationMs: number, proposedSegments: ProposedTimelineSegment[]): TimelineValidationResult {
  const issues: string[] = [];
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) issues.push("The audio duration must be a positive measured value.");
  if (proposedSegments.length === 0) issues.push("A narration timeline requires at least one segment.");
  const segments = proposedSegments.map(segment => ({ ...segment, durationMs: segment.endMs - segment.startMs }));
  segments.forEach((segment, index) => { if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) issues.push(`Segment ${index + 1} has a non-finite boundary.`); if (segment.durationMs <= 0) issues.push(`Segment ${index + 1} must have a positive AI-selected duration.`); if (segment.confidence < 0 || segment.confidence > 1) issues.push(`Segment ${index + 1} has a confidence score outside the 0–1 range.`); if (!segment.narrationText.trim() || !segment.selectionReason.trim()) issues.push(`Segment ${index + 1} is missing narration context or its selection reason.`); });
  if (segments.length > 0 && !sameBoundary(segments[0].startMs, 0)) issues.push("The first segment must start at the beginning of the narration (0 ms).");
  for (let index = 1; index < segments.length; index += 1) { const previous = segments[index - 1]; const current = segments[index]; if (current.startMs < previous.startMs) issues.push(`Segment ${index + 1} is not ordered by its narration timestamp.`); if (!sameBoundary(previous.endMs, current.startMs)) issues.push(`There is a ${current.startMs > previous.endMs ? "gap" : "overlap"} between segments ${index} and ${index + 1}.`); }
  if (segments.length > 0 && Number.isFinite(audioDurationMs) && !sameBoundary(segments[segments.length - 1].endMs, audioDurationMs)) issues.push("The final segment must end exactly at the measured narration duration.");
  return { valid: issues.length === 0, issues, segments };
}
