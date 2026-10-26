import { describe, expect, it } from "vitest";
import { buildDirectAnchorPacingPrompt, computeAnchorBoundaries, fallbackProportionalAnchors, parseAndSanitizeAnchors, sanitizeFinalAnchorSequence, splitTranscriptIntoSentenceLines } from "./sentenceAnchors";

const line = (start: number, end: number, text: string) => ({ start, end, text });

describe("transcript sentence-line splitting", () => {
  it("splits a merged 30-second Hindi segment at sentence punctuation with word-proportional timestamps", () => {
    const lines = splitTranscriptIntoSentenceLines([{ start: 14.46, end: 44.44, text: "पहली बात। दूसरी बात थोड़ी लंबी है। तीसरी बात। चौथी बात बहुत ज़्यादा लंबी चलती है और यहाँ तक आती है।" }]);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0].start).toBeCloseTo(14.46, 6);
    expect(lines[lines.length - 1].end).toBeCloseTo(44.44, 6);
    for (let index = 1; index < lines.length; index += 1) expect(lines[index].start).toBeGreaterThanOrEqual(lines[index - 1].start);
    expect(lines[0].text).toContain("पहली");
  });

  it("keeps a short single-sentence segment as one line", () => {
    const lines = splitTranscriptIntoSentenceLines([{ start: 0, end: 3.2, text: "बाजार में तेजी है।" }]);
    expect(lines).toEqual([{ start: 0, end: 3.2, text: "बाजार में तेजी है।" }]);
  });

  it("word-splits a long punctuation-free segment so anchors still have targets", () => {
    const text = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const lines = splitTranscriptIntoSentenceLines([{ start: 0, end: 30, text }]);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[lines.length - 1].end).toBeCloseTo(30, 6);
  });
});

describe("direct sentence-anchor boundaries", () => {
  const lines = [line(0, 3, "a"), line(3, 6.5, "b"), line(6.5, 9, "c")];

  it("locks every boundary to the exact line start with zero cumulative drift", () => {
    expect(computeAnchorBoundaries(10_000, lines, [0, 1, 2])).toEqual([3000, 3500, 3500]);
  });

  it("splits a shared line proportionally to duration hints and defaults to equal split", () => {
    expect(computeAnchorBoundaries(10_000, lines, [0, 0, 1])).toEqual([1500, 1500, 7000]);
    expect(computeAnchorBoundaries(10_000, lines, [0, 0, 1], [2, 1, null])).toEqual([2000, 1000, 7000]);
  });

  it("extends the final group to the measured audio end", () => {
    expect(computeAnchorBoundaries(10_000, lines, [0, 1])).toEqual([3000, 7000]);
  });

  it("sums exactly to the audio duration for every image", () => {
    const durations = computeAnchorBoundaries(10_000, lines, [0, 0, 1], [1, 3, 2]);
    expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(10_000);
  });
});

describe("anchor sanitization", () => {
  const lines = Array.from({ length: 12 }, (_, index) => line(index, index + 1, `line ${index}`));

  it("clamps out-of-range anchors and enforces monotonic order", () => {
    expect(parseAndSanitizeAnchors({ anchors: [-3, 5, 2, 99] }, 4, lines.length, 0)?.anchors).toEqual([0, 5, 5, 11]);
  });

  it("rejects mismatched anchor counts so the caller can retry", () => {
    expect(parseAndSanitizeAnchors({ anchors: [0, 1] }, 4, lines.length, 0)).toBeNull();
    expect(parseAndSanitizeAnchors({ anchors: [0, "bad", 2, 3] }, 4, lines.length, 0)).toBeNull();
  });

  it("flags a lazy plan that crams a whole batch onto too few lines", () => {
    const lazy = parseAndSanitizeAnchors({ anchors: [2, 2, 2, 2, 2, 2, 2, 2] }, 8, lines.length, 0);
    expect(lazy?.lazy).toBe(true);
    const spread = parseAndSanitizeAnchors({ anchors: [0, 1, 2, 3, 4, 5, 6, 7] }, 8, lines.length, 0);
    expect(spread?.lazy).toBe(false);
  });

  it("keeps batch anchors monotonic across the persisted cursor line", () => {
    const parsed = parseAndSanitizeAnchors({ anchors: [1, 4, 3] }, 3, lines.length, 5);
    expect(parsed?.anchors).toEqual([5, 5, 5]);
  });
});

describe("final anchor sequence guards", () => {
  const minuteLines = Array.from({ length: 61 }, (_, index) => line(index, index + 1, `line ${index}`));

  it("spreads trailing images over remaining narration instead of one giant shared hold", () => {
    const stretched = sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 0, 0]);
    expect(stretched[1]).toBeGreaterThan(stretched[0]);
    expect(stretched[2]).toBeGreaterThan(stretched[1]);
    expect(stretched[2]).toBeLessThanOrEqual(60);
  });

  it("caps an overreaching first boundary so image one cannot swallow the opening", () => {
    const clamped = sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 50, 55]);
    expect(clamped[1]).toBeLessThanOrEqual(45);
    expect(clamped[2]).toBeGreaterThanOrEqual(clamped[1]);
  });

  it("keeps valid anchors untouched", () => {
    expect(sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 10, 20])).toEqual([0, 10, 20]);
  });
});

describe("deterministic fallback anchors", () => {
  it("snaps equal pacing to the nearest sentence starts in monotonic order", () => {
    const lines = Array.from({ length: 61 }, (_, index) => line(index, index + 1, `line ${index}`));
    const anchors = fallbackProportionalAnchors(60_000, lines, 3);
    expect(anchors).toEqual([0, 20, 40]);
    for (let index = 1; index < anchors.length; index += 1) expect(anchors[index]).toBeGreaterThanOrEqual(anchors[index - 1]);
  });
});

describe("direct anchor pacing prompt", () => {
  it("asks for per-image line anchors with hold guidance and absolute line numbers", () => {
    const lines = [line(0, 3, "पहली बात।"), line(3, 6, "दूसरी बात।")];
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, scene: "chart | Subjects:person" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 2, holdMode: "MIN_2_SECONDS", corrective: false });
    expect(prompt).toContain('"anchors"');
    expect(prompt).toContain("0|0.0-3.0|पहली बात।");
    expect(prompt).toContain("2.2 seconds");
    expect(prompt).toContain("non-decreasing");
  });

  it("explains the cramming rejection on a corrective retry and relaxes hold guidance for no-minimum mode", () => {
    const lines = [line(0, 3, "पहली बात।"), line(3, 6, "दूसरी बात।")];
    const corrective = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, scene: "chart" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 1, holdMode: "NO_MINIMUM", corrective: true });
    expect(corrective).toContain("crammed");
    expect(corrective).toContain("No minimum hold is required");
  });
});
