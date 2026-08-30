import { distributeReadableWeightedDurations, type ReadableHoldMode } from "./readablePacing";

export type SemanticTranscriptSegment = { start: number; end: number; text: string };
export type SemanticAssignment = { sequence: number; segmentIndex: number; weight: number };
export type SemanticImage = { id: number; sequence: number | null; scene: string };

export type SemanticTimelineInput = {
  audioDurationMs: number;
  transcriptSegments: SemanticTranscriptSegment[];
  images: SemanticImage[];
  assignments: SemanticAssignment[];
  holdMode: ReadableHoldMode;
};

export type SemanticTimelineClip = {
  imageAssetId: number;
  sourceSequence: number;
  startMs: number;
  endMs: number;
  transcriptSegmentIndex: number;
  weight: number;
};

function finiteInteger(value: unknown) { return Number.isInteger(value) && Number.isFinite(value); }
function finitePositive(value: unknown) { return Number.isFinite(value) && Number(value) > 0; }

export function validateSemanticAssignments(assignments: SemanticAssignment[], images: SemanticImage[], transcriptSegments: SemanticTranscriptSegment[]) {
  if (assignments.length !== images.length) throw new Error("Semantic weighted sync must assign every uploaded image exactly once.");
  const imageSequences = new Set(images.map(image => image.sequence));
  const seen = new Set<number>();
  for (const assignment of assignments) {
    if (!finiteInteger(assignment.sequence) || !imageSequences.has(assignment.sequence)) throw new Error("Semantic weighted sync returned an unknown image sequence.");
    if (seen.has(assignment.sequence)) throw new Error("Semantic weighted sync assigned one image more than once.");
    if (!finiteInteger(assignment.segmentIndex) || assignment.segmentIndex < 0 || assignment.segmentIndex >= transcriptSegments.length) throw new Error("Semantic weighted sync returned an invalid transcript segment index.");
    if (!finitePositive(assignment.weight)) throw new Error("Semantic weighted sync returned an invalid image weight.");
    seen.add(assignment.sequence);
  }
  if (seen.size !== imageSequences.size) throw new Error("Semantic weighted sync did not cover every uploaded image.");
}

function normalizedTranscriptSegments(segments: SemanticTranscriptSegment[], audioDurationMs: number) {
  return segments.map((segment, index) => ({ index, startMs: Math.max(0, Math.min(audioDurationMs, Math.round(segment.start * 1000))), endMs: Math.max(0, Math.min(audioDurationMs, Math.round(segment.end * 1000))), text: segment.text.trim() })).filter(segment => segment.endMs > segment.startMs);
}

export function buildSemanticWeightedTimeline(input: SemanticTimelineInput): SemanticTimelineClip[] {
  if (!Number.isInteger(input.audioDurationMs) || input.audioDurationMs <= 0) throw new Error("Semantic Timeline requires a positive audio duration.");
  validateSemanticAssignments(input.assignments, input.images, input.transcriptSegments);
  const transcript = normalizedTranscriptSegments(input.transcriptSegments, input.audioDurationMs);
  if (!transcript.length) throw new Error("Semantic Timeline requires timestamped narration segments.");
  const imageBySequence = new Map(input.images.map(image => [image.sequence!, image]));
  const assignmentBySegment = new Map<number, SemanticAssignment[]>();
  for (const assignment of input.assignments) assignmentBySegment.set(assignment.segmentIndex, [...(assignmentBySegment.get(assignment.segmentIndex) ?? []), assignment]);
  const nonEmptySegments = transcript.filter(segment => (assignmentBySegment.get(segment.index)?.length ?? 0) > 0);
  if (!nonEmptySegments.length) throw new Error("Semantic weighted sync returned no usable transcript-to-image assignments.");

  const clips: SemanticTimelineClip[] = [];
  let cursor = 0;
  nonEmptySegments.forEach((segment, bucketIndex) => {
    const bucketAssignments = assignmentBySegment.get(segment.index)!.slice().sort((left, right) => right.weight - left.weight || left.sequence - right.sequence);
    const nextBoundary = bucketIndex + 1 < nonEmptySegments.length ? nonEmptySegments[bucketIndex + 1].startMs : input.audioDurationMs;
    const bucketEnd = Math.min(input.audioDurationMs, Math.max(cursor + bucketAssignments.length, Math.min(input.audioDurationMs, nextBoundary)));
    const bucketDuration = bucketEnd - cursor;
    const preferredMinimum = input.holdMode === "MIN_2_SECONDS" ? 2_200 : 0;
    const minimum = bucketDuration >= bucketAssignments.length * Math.max(1, preferredMinimum) ? preferredMinimum : 0;
    const durations = distributeReadableWeightedDurations(bucketDuration, bucketAssignments.map(assignment => assignment.weight), minimum);
    bucketAssignments.forEach((assignment, assignmentIndex) => {
      const image = imageBySequence.get(assignment.sequence)!;
      const startMs = cursor;
      const endMs = startMs + durations[assignmentIndex];
      clips.push({ imageAssetId: image.id, sourceSequence: image.sequence!, startMs, endMs, transcriptSegmentIndex: segment.index, weight: assignment.weight });
      cursor = endMs;
    });
  });
  if (cursor !== input.audioDurationMs) throw new Error(`Semantic weighted Timeline ended at ${cursor} ms instead of ${input.audioDurationMs} ms.`);
  return clips;
}
