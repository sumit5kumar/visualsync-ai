import { describe, expect, it } from "vitest";
import { buildSemanticWeightedTimeline, validateSemanticAssignments, type SemanticImage, type SemanticTranscriptSegment } from "./semanticTimeline";

const transcript: SemanticTranscriptSegment[] = [
  { start: 0, end: 1, text: "opening" },
  { start: 1, end: 3, text: "middle" },
  { start: 3, end: 6, text: "closing" },
];
const images: SemanticImage[] = [
  { id: 11, sequence: 1, scene: "first uploaded image" },
  { id: 12, sequence: 2, scene: "second uploaded image" },
  { id: 13, sequence: 3, scene: "third uploaded image" },
];

describe("semantic weighted Timeline", () => {
  it("reorders images by assigned narration segment and covers the full audio continuously", () => {
    const clips = buildSemanticWeightedTimeline({
      audioDurationMs: 6_000,
      transcriptSegments: transcript,
      images,
      assignments: [
        { sequence: 1, segmentIndex: 1, weight: 1 },
        { sequence: 2, segmentIndex: 0, weight: 2 },
        { sequence: 3, segmentIndex: 2, weight: 1 },
      ],
      holdMode: "NO_MINIMUM",
    });
    expect(clips.map(clip => clip.imageAssetId)).toEqual([12, 11, 13]);
    expect(clips[0].startMs).toBe(0);
    expect(clips.at(-1)?.endMs).toBe(6_000);
    expect(clips.every((clip, index) => index === 0 || clip.startMs === clips[index - 1].endMs)).toBe(true);
    expect(clips.map(clip => clip.transcriptSegmentIndex)).toEqual([0, 1, 2]);
  });

  it("keeps uploaded sequence order inside a shared segment instead of scrambling by weight", () => {
    const clips = buildSemanticWeightedTimeline({
      audioDurationMs: 6_000,
      transcriptSegments: transcript,
      images: [
        { id: 11, sequence: 1, scene: "first" },
        { id: 12, sequence: 2, scene: "second" },
        { id: 13, sequence: 3, scene: "third" },
      ],
      assignments: [
        { sequence: 1, segmentIndex: 0, weight: 0.5 },
        { sequence: 2, segmentIndex: 0, weight: 3.0 },
        { sequence: 3, segmentIndex: 0, weight: 1.0 },
      ],
      holdMode: "NO_MINIMUM",
    });
    // weight 3.0 on sequence 2 must NOT push it ahead of sequence 1.
    expect(clips.map(clip => clip.sourceSequence)).toEqual([1, 2, 3]);
  });

  it("allows the model to skip images it has no confident match for", () => {
    // A subset of assignments is valid: unassigned images are simply omitted.
    expect(() => validateSemanticAssignments([{ sequence: 1, segmentIndex: 0, weight: 1 }], images, transcript)).not.toThrow();
    const clips = buildSemanticWeightedTimeline({
      audioDurationMs: 6_000,
      transcriptSegments: transcript,
      images,
      assignments: [{ sequence: 2, segmentIndex: 1, weight: 1 }],
      holdMode: "NO_MINIMUM",
    });
    expect(clips.map(clip => clip.imageAssetId)).toEqual([12]);
    expect(clips[0].startMs).toBe(0);
    expect(clips.at(-1)?.endMs).toBe(6_000);
  });

  it("rejects duplicate or unknown image assignments", () => {
    expect(() => validateSemanticAssignments([
      { sequence: 1, segmentIndex: 0, weight: 1 },
      { sequence: 1, segmentIndex: 1, weight: 1 },
      { sequence: 3, segmentIndex: 2, weight: 1 },
    ], images, transcript)).toThrow(/more than once/);
    expect(() => validateSemanticAssignments([
      { sequence: 1, segmentIndex: 0, weight: 1 },
      { sequence: 2, segmentIndex: 1, weight: 1 },
      { sequence: 99, segmentIndex: 2, weight: 1 },
    ], images, transcript)).toThrow(/unknown image/);
  });
});
