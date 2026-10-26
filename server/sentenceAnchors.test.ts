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

  it("uses exact word timestamps inside a merged segment instead of proportional estimates", () => {
    const words = [
      { word: "पहली", start: 14.5, end: 14.9 },
      { word: "बात।", start: 15.1, end: 15.5 },
      { word: "दूसरी", start: 16.0, end: 16.4 },
      { word: "बात", start: 16.6, end: 17.0 },
      { word: "थोड़ी", start: 17.2, end: 17.6 },
      { word: "लंबी", start: 17.8, end: 18.2 },
      { word: "है।", start: 18.5, end: 18.9 },
      { word: "तीसरी", start: 25.0, end: 25.4 },
      { word: "बात।", start: 25.6, end: 26.0 },
      { word: "चौथी", start: 26.4, end: 26.9 },
      { word: "बात", start: 27.1, end: 27.5 },
      { word: "बहुत", start: 27.7, end: 28.1 },
      { word: "ज़्यादा", start: 28.3, end: 28.7 },
      { word: "लंबी", start: 28.9, end: 29.3 },
      { word: "चलती", start: 29.5, end: 29.9 },
      { word: "है।", start: 30.1, end: 30.5 },
    ];
    const lines = splitTranscriptIntoSentenceLines([{ start: 14.46, end: 44.44, text: "पहली बात। दूसरी बात थोड़ी लंबी है। तीसरी बात। चौथी बात बहुत ज़्यादा लंबी चलती है।", words }]);
    expect(lines.map(item => item.start)).toEqual([14.5, 16.0, 25.0, 26.4]);
    expect(lines.map(item => item.end)).toEqual([15.5, 18.9, 26.0, 30.5]);
    expect(lines[0].text).toBe("पहली बात।");
  });

  it("word-count chunks a long punctuation-free word stream at exact word times", () => {
    const words = Array.from({ length: 40 }, (_, index) => ({ word: `w${index}`, start: index * 0.5, end: index * 0.5 + 0.4 }));
    const lines = splitTranscriptIntoSentenceLines([{ start: 0, end: 20, text: words.map(item => item.word).join(" "), words }]);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0].start).toBe(0);
    expect(lines[lines.length - 1].end).toBeCloseTo(19.9, 6);
  });

  it("bridges a Whisper word hole with a placeholder line so anchor timing still advances through dropped speech", () => {
    const words = [
      { word: "पहली", start: 0.5, end: 1.0 },
      { word: "बात", start: 1.2, end: 1.7 },
      { word: "फिर", start: 25.0, end: 25.5 },
      { word: "बात।", start: 25.7, end: 26.2 },
    ];
    const lines = splitTranscriptIntoSentenceLines([{ start: 0.46, end: 44.44, text: "पहली बात। फिर बात।", words }]);
    expect(lines).toEqual([
      { start: 0.5, end: 1.7, text: "पहली बात" },
      { start: 1.7, end: 25.0, text: "…" },
      { start: 25.0, end: 26.2, text: "फिर बात।" },
    ]);
  });

  it("keeps word-exact lines when a trailing word straddles the merged segment boundary", () => {
    const words = [
      { word: "पहली", start: 14.5, end: 14.9 },
      { word: "बात।", start: 15.1, end: 15.5 },
      { word: "दूसरी", start: 16.0, end: 16.4 },
      { word: "बात।", start: 16.6, end: 17.0 },
      { word: "अगला", start: 44.46, end: 46.18 },
    ];
    const lines = splitTranscriptIntoSentenceLines([{ start: 14.46, end: 44.44, text: "पहली बात। दूसरी बात। अगला", words }]);
    expect(lines.map(item => item.start)).toEqual([14.5, 16.0, 17.0, 44.46]);
    expect(lines[0].end).toBe(15.5);
  });

  it("falls back to proportional timestamps when fewer than two usable words remain", () => {
    const words = [{ word: "अगला", start: 44.46, end: 46.18 }];
    const lines = splitTranscriptIntoSentenceLines([{ start: 14.46, end: 44.44, text: "पहली बात। दूसरी बात।", words }]);
    expect(lines[0].start).toBeCloseTo(14.46, 6);
    expect(lines[lines.length - 1].end).toBeCloseTo(44.44, 6);
  });

  it("falls back to proportional timestamps when word timings are incomplete", () => {
    const words = [{ word: "पहली", start: 14.5, end: 14.9 }, { word: "बात।", start: 15.1, end: Number.NaN }];
    const lines = splitTranscriptIntoSentenceLines([{ start: 14.46, end: 44.44, text: "पहली बात। दूसरी बात।", words }]);
    expect(lines[0].start).toBeCloseTo(14.46, 6);
    expect(lines[lines.length - 1].end).toBeCloseTo(44.44, 6);
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

  it("pulls a mid-sequence anchor down to the skip cap when the AI skipped lines", () => {
    const anchors = [0, 1, 10, ...Array.from({ length: 17 }, (_, index) => 11 + index)];
    const guarded = sanitizeFinalAnchorSequence(60_000, minuteLines, anchors);
    expect(guarded[2]).toBe(7);
    for (let index = 3; index < guarded.length; index += 1) expect(guarded[index]).toBe(11 + index - 3);
  });

  it("never pulls the final image anchor even when the previous span is huge", () => {
    const guarded = sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 1, 30, 31]);
    expect(guarded[3]).toBe(31);
    expect(guarded[2]).toBeLessThan(30);
  });

  it("keeps valid anchors untouched", () => {
    expect(sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 10, 20])).toEqual([0, 10, 20]);
    expect(sanitizeFinalAnchorSequence(60_000, minuteLines, [0, 1, 2])).toEqual([0, 1, 2]);
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
