import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPacingTranscriptSegments } from "./narrationTranscription";
import { buildDirectAnchorPacingPrompt, buildPointAnchoredPacingItems, collectMissingPointNumbers, computeAnchorBoundaries, fallbackProportionalAnchors, formatPacingVisualScene, repairSentenceWordBoundaries, parseAndSanitizeAnchors, parseImagePointNumber, sanitizeFinalAnchorSequence, splitTranscriptIntoSentenceLines } from "./sentenceAnchors";

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

  it("preserves legacy four-argument coercion, rounding, clamping and duration hints", () => {
    const parsed = parseAndSanitizeAnchors({ anchors: ["1.6", 1, 99], durations: ["2", 0] }, 3, lines.length, 0);
    expect(parsed).toEqual({ anchors: [2, 2, 11], hints: [2, null, null], lazy: false });
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
  it("fills only the unfinished tail while preserving prior content anchors", () => {
    const lines = Array.from({ length: 61 }, (_, index) => line(index, index + 1, `line ${index}`));
    const accepted = [0, 3, 19];
    const anchors = fallbackProportionalAnchors(60_000, lines, 5, accepted);
    expect(anchors).toEqual([0, 3, 19, 33, 46]);
    expect(accepted).toEqual([0, 3, 19]);
    const durations = computeAnchorBoundaries(60_000, lines, anchors);
    expect(durations[0]).toBe(3000);
    expect(durations[0] + durations[1]).toBe(19000);
    expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(60000);
  });

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
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, point: null, scene: "chart | Subjects:person" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 2, holdMode: "MIN_2_SECONDS", corrective: false });
    expect(prompt).toContain('"anchors"');
    expect(prompt).toContain("0|0.0-3.0|पहली बात।");
    expect(prompt).toContain("2.2 seconds");
    expect(prompt).toContain("non-decreasing");
    expect(prompt).toContain("ENTIRE reply must be a single JSON object");
  });

  it("requires compact single-line explicit-ID pairs for a full 24-image batch", () => {
    const batch = Array.from({ length: 24 }, (_, index) => ({ sequence: index + 25, point: null, scene: `image ${index + 25}` }));
    const lines = Array.from({ length: 150 }, (_, index) => line(index * 2, (index + 1) * 2, `topic ${index}`));
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 1, batchCount: 4, batch, lines, cursorLine: 24, audioDurationMs: 300_000, imageCount: 75, holdMode: "MIN_2_SECONDS", corrective: false });
    expect(prompt).toContain('Reply with exactly {"anchors":[[IMAGE_SEQUENCE_ID,LINE_INDEX],...]} containing 24 pairs, one per supplied sequence ID');
    expect(prompt).toContain("single-line compact JSON");
    expect(prompt).toContain("no whitespace or indentation, no explanation");
    expect(prompt).toContain("Each pair must be exactly [image ID,line index], two integers in that order, not a positional line-only array");
    expect(prompt).not.toContain('"sequence":IMAGE_SEQUENCE_ID');
    expect(prompt).toContain("every anchor must be greater than or equal to 24");
    expect(prompt).toContain("compare BOTH neighboring images");
    expect(prompt).toContain("Choose the FIRST line introducing that specific idea");
    expect(prompt).toContain("Use only the supplied sequence IDs and line indices");
    expect(prompt).toContain(JSON.stringify(batch.map(({ sequence, scene }) => ({ sequence, scene }))));
  });

  it("explains the cramming rejection on a corrective retry and relaxes hold guidance for no-minimum mode", () => {
    const lines = [line(0, 3, "पहली बात।"), line(3, 6, "दूसरी बात।")];
    const corrective = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, point: null, scene: "chart" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 1, holdMode: "NO_MINIMUM", corrective: true });
    expect(corrective).toContain("crammed");
    expect(corrective).toContain("No minimum hold is required");
  });

  it("names every image point and the missing points when filenames carry point numbers", () => {
    const lines = [line(0, 3, "पहली बात।"), line(3, 6, "दूसरी बात।"), line(6, 9, "तीसरी बात।")];
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, point: 1, scene: "chart" }, { sequence: 2, point: 3, scene: "photo" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 2, holdMode: "MIN_2_SECONDS", corrective: false, missingPoints: [2] });
    expect(prompt).toContain("NOT a spoken sentence number");
    expect(prompt).toContain("Filename labels 2 are absent");
    expect(prompt).toContain("Never count sentences");
    expect(prompt).toContain('{"anchors":[[IMAGE_SEQUENCE_ID,LINE_INDEX],...]}');
    expect(prompt).toContain("sequence|point|scene");
    expect(prompt).toContain('"point":1');
    expect(prompt).toContain('"point":3');
  });

  it("omits point guidance when the batch has no point numbers", () => {
    const lines = [line(0, 3, "पहली बात।")];
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 1, batch: [{ sequence: 1, point: null, scene: "chart" }], lines, cursorLine: 0, audioDurationMs: 10_000, imageCount: 1, holdMode: "MIN_2_SECONDS", corrective: false });
    expect(prompt).not.toContain("narration point");
    expect(prompt).not.toContain("sequence|point|scene");
  });
});

describe("image point numbers", () => {
  it("parses the leading integer of a numbered filename", () => {
    expect(parseImagePointNumber("11_202608151201.jpeg")).toBe(11);
    expect(parseImagePointNumber("01_202608151201.jpeg")).toBe(1);
    expect(parseImagePointNumber("9.jpg")).toBe(9);
    expect(parseImagePointNumber(" 20 - copy.png")).toBe(20);
  });

  it("rejects unnumbered, date-first, and oversized names", () => {
    expect(parseImagePointNumber("IMG_001.jpg")).toBeNull();
    expect(parseImagePointNumber("202608151201_x.jpg")).toBeNull();
    expect(parseImagePointNumber("finance-chart.png")).toBeNull();
    expect(parseImagePointNumber(null)).toBeNull();
  });

  it("builds point-enriched items only when all points are distinct and ascending", () => {
    const items = (names: string[]) => names.map((name, index) => ({ sequence: index + 1, originalFilename: name, scene: `scene ${index}` }));
    expect(buildPointAnchoredPacingItems(items(["01_a.jpg", "02_a.jpg", "03_a.jpg"]))?.map(item => item.point)).toEqual([1, 2, 3]);
    expect(buildPointAnchoredPacingItems(items(["01_a.jpg", "11_a.jpg", "20_a.jpg"]))?.map(item => item.point)).toEqual([1, 11, 20]);
    expect(buildPointAnchoredPacingItems(items(["01_a.jpg", "photo.jpg", "03_a.jpg"]))).toBeNull();
    expect(buildPointAnchoredPacingItems(items(["02_a.jpg", "01_a.jpg"]))).toBeNull();
    expect(buildPointAnchoredPacingItems(items(["01_a.jpg", "01_b.jpg"]))).toBeNull();
    expect(buildPointAnchoredPacingItems([])).toBeNull();
  });

  it("lists the narration points that have no image", () => {
    const items = (points: number[]) => points.map((point, index) => ({ sequence: index + 1, point, scene: `scene ${index}` }));
    expect(collectMissingPointNumbers(items([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 20]))).toEqual([10, 15]);
    expect(collectMissingPointNumbers(items([1, 2]))).toEqual([]);
  });
});

describe("point-aware final anchor guards", () => {
  const minuteLines = Array.from({ length: 61 }, (_, index) => line(index, index + 1, `line ${index}`));

  it("keeps a legitimate long skip when a narration point has no image", () => {
    const anchors = [0, 1, 15, ...Array.from({ length: 17 }, (_, index) => 16 + index)];
    const guarded = sanitizeFinalAnchorSequence(60_000, minuteLines, anchors, { pointAware: true });
    expect(guarded[2]).toBe(15);
  });

  it("still caps a catastrophic jump in point-aware mode at the relaxed cap", () => {
    const anchors = [0, 1, 30, ...Array.from({ length: 17 }, (_, index) => 31 + index)];
    const guarded = sanitizeFinalAnchorSequence(60_000, minuteLines, anchors, { pointAware: true });
    expect(guarded[2]).toBe(19);
    expect(guarded[3]).toBe(31);
  });
});

describe("explicit image-to-line matches", () => {
  it("uses sequence IDs rather than JSON array positions for missing filename numbers", () => {
    const parsed = parseAndSanitizeAnchors({ anchors: [{ sequence: 12, line: 14 }, { sequence: 10, line: 11 }, { sequence: 11, line: 13 }] }, 3, 22, 0, [10, 11, 12]);
    expect(parsed?.anchors).toEqual([11, 13, 14]);
  });

  it("reorders compact pairs by multi-digit and large image IDs, not array position or ID magnitude", () => {
    const parsed = parseAndSanitizeAnchors({ anchors: [[100, 207], [999_999, 104], [42, 11]] }, 3, 220, 11, [42, 999_999, 100]);
    expect(parsed).toEqual({ anchors: [11, 104, 207], hints: [null, null, null], lazy: false });
  });

  it("accepts valid pairs alongside legacy named objects, including shared lines", () => {
    const parsed = parseAndSanitizeAnchors({ anchors: [[12, 21], { sequence: 10, line: 3 }, [11, 3]] }, 3, 22, 3, [10, 11, 12]);
    expect(parsed?.anchors).toEqual([3, 3, 21]);
  });

  it("parses a compact 24-image response without changing absolute line indices", () => {
    const sequences = Array.from({ length: 24 }, (_, index) => index + 25);
    const anchors = sequences.map((sequence, index) => [sequence, index + 100]);
    const response = JSON.parse(JSON.stringify({ anchors }));
    expect(parseAndSanitizeAnchors(response, 24, 150, 99, sequences)).toEqual({
      anchors: anchors.map(([, lineIndex]) => lineIndex),
      hints: new Array(24).fill(null),
      lazy: false,
    });
    expect(parseAndSanitizeAnchors({ anchors: sequences.map(sequence => [sequence, 100]) }, 24, 150, 99, sequences)?.lazy).toBe(true);
  });

  it.each([
    [0, 1],
    [{ sequence: 1, line: 0 }, { sequence: 1, line: 1 }],
    [{ sequence: 1, line: 0 }, { sequence: 3, line: 1 }],
    [{ sequence: 1, line: 0 }],
    [{ sequence: 1, line: 5 }, { sequence: 2, line: 4 }],
    [{ sequence: 1, line: 0 }, { sequence: 2, line: 22 }],
    [{ sequence: 1, line: 0 }, { sequence: 2, line: 1.5 }],
    [{ sequence: 1, line: 0 }, { sequence: 2, line: null }],
    [[1, 0], [1, 1]],
    [[1, 0], [3, 1]],
    [[1, 0]],
    [[1, 0], [2, 1], [3, 2]],
    [[2, 4], [1, 5]],
    [[1, -1], [2, 1]],
    [[1, 0], [2, 22]],
    [[1, 0], [2, 1.5]],
    [[1, 0], [2, "1"]],
    [[1, 0], [2, null]],
    [[1, 0], [2, true]],
    [[1, 0], [2, Number.NaN]],
    [[1, 0], [2, Number.POSITIVE_INFINITY]],
    [[1, 0], ["2", 1]],
    [[1, 0], [2.5, 1]],
    [[1, 0], [null, 1]],
    [[1, 0], []],
    [[1, 0], [2]],
    [[1, 0], [2, 1, 3]],
    [[1, 0], [[2], 1]],
    [[1, 0], [2, [1]]],
    [[1, 0], 1],
    [[1, 0], null],
    [[1, 0], { sequence: 2 }],
    [[1, 0], { line: 1 }],
    [[1, 0], { sequence: 2, line: "1" }],
    [[1, 0], { sequence: 1, line: 1 }],
  ])("rejects positional, incomplete, duplicate, unknown or invalid matches: %j", (...anchors) => {
    expect(parseAndSanitizeAnchors({ anchors }, 2, 22, 0, [1, 2])).toBeNull();
  });

  it("rejects invalid supplied ID lists in named-ID mode", () => {
    for (const sequences of [[1], [1, 1], [1, null], [1, 2.5], [1, Number.NaN]]) {
      expect(parseAndSanitizeAnchors({ anchors: [[1, 0], [2, 1]] }, 2, 22, 0, sequences)).toBeNull();
    }
  });

  it("rejects a line before the persisted cursor instead of silently clamping it", () => {
    expect(parseAndSanitizeAnchors({ anchors: [{ sequence: 9, line: 2 }] }, 1, 22, 3, [9])).toBeNull();
    expect(parseAndSanitizeAnchors({ anchors: [[9, 2]] }, 1, 22, 3, [9])).toBeNull();
  });

  it("rejects negative named lines even when the cursor is negative", () => {
    expect(parseAndSanitizeAnchors({ anchors: [[9, -1]] }, 1, 22, -2, [9])).toBeNull();
    expect(parseAndSanitizeAnchors({ anchors: [{ sequence: 9, line: -1 }] }, 1, 22, -2, [9])).toBeNull();
  });
});

describe("word ownership repair", () => {
  it("moves a sentence prefix out of the preceding bucket without changing timestamps or input", () => {
    const segments = [
      { start: 38, end: 40.32, text: "कर्ज से दूर रहो", words: [{ word: "कर्ज", start: 38, end: 38.8 }, { word: "रहो", start: 40.04, end: 40.26 }, { word: "क्रेडिट", start: 40.32, end: 40.86 }] },
      { start: 40.32, end: 43.1, text: "क्रेडिट कार्ड का सही इस्तेमाल करो", words: [{ word: "कार्ड", start: 40.86, end: 41.14 }, { word: "का", start: 41.14, end: 41.28 }, { word: "सही", start: 41.28, end: 41.54 }] },
    ];
    const original = structuredClone(segments);
    const repaired = repairSentenceWordBoundaries(segments);
    expect(repaired[1].words?.[0]).toEqual({ word: "क्रेडिट", start: 40.32, end: 40.86 });
    expect(repaired[0].words).toHaveLength(2);
    expect(segments).toEqual(original);
    expect(splitTranscriptIntoSentenceLines(segments)[1].start).toBe(40.32);
  });

  it("retains a text-confirmed prefix 800ms earlier than the coarse segment start", () => {
    const segments = [
      { start: 0, end: 2, text: "old sentence", words: [{ word: "old", start: 0, end: 0.5 }, { word: "sentence", start: 0.5, end: 1 }, { word: "new", start: 1.2, end: 1.8 }] },
      { start: 2, end: 4, text: "new topic begins", words: [{ word: "topic", start: 2, end: 2.5 }, { word: "begins", start: 2.5, end: 3 }] },
    ];
    const lines = splitTranscriptIntoSentenceLines(segments);
    expect(lines[1]).toEqual({ start: 1.2, end: 3, text: "new topic begins" });
    expect(lines.map(line => line.text).join(" ")).toBe("old sentence new topic begins");
  });

  it("does not steal the nearer previous repetition when ownership is already correct", () => {
    const segments = [
      { start: 0, end: 2, text: "repeat this phrase", words: [{ word: "repeat", start: 1.7, end: 1.8 }, { word: "this", start: 1.8, end: 1.9 }, { word: "phrase", start: 1.9, end: 2 }] },
      { start: 2, end: 4, text: "repeat this phrase", words: [{ word: "repeat", start: 2.5, end: 2.8 }, { word: "this", start: 2.8, end: 3 }, { word: "phrase", start: 3, end: 4 }] },
    ];
    expect(repairSentenceWordBoundaries(segments)).toEqual(segments);
    expect(splitTranscriptIntoSentenceLines(segments)[1].start).toBe(2.5);
  });

  it("does not move a generic matching token without an exact multi-word prefix", () => {
    const segments = [
      { start: 0, end: 2, text: "keep money", words: [{ word: "keep", start: 0, end: 1 }, { word: "money", start: 1, end: 2 }] },
      { start: 2, end: 4, text: "money grows now", words: [{ word: "grows", start: 2, end: 3 }, { word: "elsewhere", start: 3, end: 4 }] },
    ];
    expect(repairSentenceWordBoundaries(segments)).toEqual(segments);
  });
});

describe("bounded semantic image catalog", () => {
  it("preserves credit-card meaning even after a long decorative scene description", () => {
    const scene = formatPacingVisualScene({ sceneDescription: "Pastel paper texture. ".repeat(100), subjects: [{ label: "Credit card", action: "balancing debt" }], relevance: "Credit card misuse versus responsible use." });
    expect(scene).toContain("Credit card misuse versus responsible use");
    expect(scene).toContain("Credit card: balancing debt");
    expect(scene).not.toContain("[object Object]");
    expect(scene.length).toBeLessThanOrEqual(700);
    expect(formatPacingVisualScene(null)).toBe("Visual scene");
  });
});

describe("real 67-second ordered narration regression", () => {
  const fixture = JSON.parse(readFileSync(new URL("./sentenceAnchors.regression.json", import.meta.url), "utf8"));
  const segments = readPacingTranscriptSegments(fixture.analysis);
  const lines = splitTranscriptIntoSentenceLines(segments);
  const expectedAnchors: number[] = fixture.expectedAnchors;

  it("recovers all 207 words and complete sentence prefixes from the stale 197-word cache", () => {
    expect(segments.flatMap(segment => segment.words ?? [])).toHaveLength(207);
    expect(lines).toHaveLength(22);
    expect(lines[6].text).toContain("पहले खर्च करते हैं");
    expect(lines[14]).toMatchObject({ start: 40.32, text: "क्रेडिट कार्ड का सही इस्तमाल करो, गलत नहीं" });
    expect(lines[15].text).toMatch(/^हर महीने/);
  });

  it("keeps the card image until budgeting begins and covers missing images without a one-line offset", () => {
    const guarded = sanitizeFinalAnchorSequence(fixture.audioDurationMs, lines, expectedAnchors, { pointAware: true });
    expect(guarded).toEqual(expectedAnchors);
    const durations = computeAnchorBoundaries(fixture.audioDurationMs, lines, guarded);
    let cursor = 0;
    const timeline = durations.map((duration, index) => {
      const row = { filename: fixture.filenames[index] as string, startMs: cursor, endMs: cursor + duration };
      cursor += duration;
      return row;
    });
    const row = (prefix: string) => timeline.find(item => item.filename.startsWith(prefix));
    expect(row("11_")).toMatchObject({ startMs: 33100, endMs: 38000 });
    expect(row("12_")).toMatchObject({ startMs: 38000, endMs: 40320 });
    expect(row("13_")).toMatchObject({ startMs: 40320, endMs: 42720 });
    expect(row("14_")).toMatchObject({ startMs: 42720, endMs: 49060 });
    expect(row("16_")).toMatchObject({ startMs: 49060, endMs: 52360 });
    expect(row("20_")).toMatchObject({ startMs: 62760, endMs: 67451 });
    expect(cursor).toBe(67451);
    expect(durations.every(duration => duration > 0)).toBe(true);
  });

  it.each([30, 45])("retains absolute timing when the same content appears at minute %s", minute => {
    const offset = minute * 60;
    const shifted = segments.map(segment => ({ ...segment, start: segment.start + offset, end: segment.end + offset, words: segment.words?.map(word => ({ ...word, start: word.start + offset, end: word.end + offset })) }));
    const shiftedLines = splitTranscriptIntoSentenceLines(shifted);
    expect(shiftedLines[14].start).toBeCloseTo(offset + 40.32, 6);
    const durations = computeAnchorBoundaries(offset * 1000 + fixture.audioDurationMs, shiftedLines, expectedAnchors);
    expect(durations.slice(0, 11).reduce((sum, duration) => sum + duration, 0)).toBe(offset * 1000 + 40320);
    expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(offset * 1000 + fixture.audioDurationMs);
  });
});

describe("long narration prompt coverage", () => {
  it.each([30, 45])("scales a batch window to a %s-minute project rather than a fixed 116 seconds", minutes => {
    const lines = Array.from({ length: minutes * 6 }, (_, index) => line(index * 10, (index + 1) * 10, `topic ${index}`));
    const batch = Array.from({ length: 24 }, (_, index) => ({ sequence: index + 1, point: index + 1, scene: `image ${index}` }));
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 0, batchCount: 4, batch, lines, cursorLine: 0, audioDurationMs: minutes * 60_000, imageCount: 96, holdMode: "MIN_2_SECONDS", corrective: false });
    expect(prompt).toContain("topic 50");
    expect(prompt).toContain("More image batches follow");
    expect(prompt).not.toContain("Spread anchors across the full remaining narration");
  });

  it("carries the previous image as context without asking for it again", () => {
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: 1, batchCount: 2, batch: [{ sequence: 25, point: 27, scene: "budget" }], previousImage: { sequence: 24, point: 26, scene: "credit-card use" }, lines: [line(0, 2, "card"), line(2, 4, "budget")], cursorLine: 0, audioDurationMs: 4000, imageCount: 25, holdMode: "NO_MINIMUM", corrective: false });
    expect(prompt).toContain("Previous image (context only, do not return it)");
    expect(prompt).toContain("credit-card use");
    expect(prompt).toContain("final image should start at its matching closing idea");
  });
});
