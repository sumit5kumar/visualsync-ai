import { MIN_READABLE_IMAGE_DURATION_MS, type ReadableHoldMode } from "./readablePacing";
import { MAX_ALLOWED_INTERNAL_WORD_GAP_MS } from "./narrationTranscription";

export type NarrationLine = { start: number; end: number; text: string };
export type NarrationSegmentInput = { start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> };

/** A pacing catalog item may carry the narration point number encoded in the image filename. */
export type PacingBatchItem = { sequence: number | null; point: number | null; scene: string };

/**
 * Extracts the narration point number from an image filename like
 * "11_202608151201.jpeg" -> 11. Only a leading integer followed by a
 * non-digit separator counts, so date-first names like "20260815_x.jpg"
 * are rejected by the 999 ceiling and fall back to content anchoring.
 */
export function parseImagePointNumber(filename: string | null | undefined): number | null {
  if (!filename) return null;
  const match = /^\s*(\d{1,4})\D/.exec(filename);
  if (!match) return null;
  const point = Number(match[1]);
  return Number.isInteger(point) && point >= 1 && point <= 999 ? point : null;
}

/**
 * Enriches the visual catalog with point numbers only when EVERY image
 * filename carries a valid point and the points are strictly ascending in
 * sequence order. Any irregularity (unnumbered, duplicated, or reordered
 * files) returns null so the caller falls back to content-based anchoring.
 */
export function buildPointAnchoredPacingItems(items: Array<{ sequence: number | null; originalFilename: string | null | undefined; scene: string }>): PacingBatchItem[] | null {
  if (!items.length) return null;
  const parsed = items.map(item => ({ sequence: item.sequence, point: parseImagePointNumber(item.originalFilename), scene: item.scene }));
  const points = parsed.map(item => item.point);
  if (points.some(point => point === null)) return null;
  const values = points as number[];
  for (let index = 1; index < values.length; index += 1) if (values[index] <= values[index - 1]) return null;
  return parsed as PacingBatchItem[];
}

/** Points the narration covers but that have no image, e.g. [10, 15] for files 1-9, 11-14, 16-20. */
export function collectMissingPointNumbers(items: PacingBatchItem[]): number[] {
  const points = items.map(item => item.point).filter((point): point is number => point !== null && Number.isInteger(point) && point > 0);
  if (points.length < 2) return [];
  const present = new Set(points);
  const missing: number[] = [];
  for (let point = Math.min(...points) + 1; point < Math.max(...points); point += 1) if (!present.has(point)) missing.push(point);
  return missing;
}

const SENTENCE_SPLIT_MIN_DURATION_MS = 4_500;
const MAX_ANCHOR_PROMPT_NARRATION_CHARACTERS = 12_000;
const MAX_SINGLE_IMAGE_TAIL_STRETCH_MS = 10_000;
const MAX_MID_SEQUENCE_SKIP_MS = 6_000;

const SENTENCE_BREAK_PATTERN = /[^।.!?;]+[।.!?;]*/g;
const COMMA_BREAK_PATTERN = /[^,]+(?:,|$)/g;
const SENTENCE_WORD_END_PATTERN = /[।.!?;]+$/;
const COMMA_WORD_END_PATTERN = /,$/;

function pieceWordCount(text: string) {
  return Math.max(1, text.trim().split(/\s+/).length);
}

function splitPieceByPunctuation(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map(piece => piece.trim()).filter(Boolean);
}

function splitLongTextPieces(text: string, durationMs: number): string[] {
  const sentences = splitPieceByPunctuation(text, SENTENCE_BREAK_PATTERN);
  if (sentences.length > 1) {
    const totalWords = sentences.reduce((sum, sentence) => sum + pieceWordCount(sentence), 0);
    return sentences.flatMap(sentence => splitLongTextPieces(sentence, durationMs * pieceWordCount(sentence) / totalWords));
  }
  if (durationMs <= SENTENCE_SPLIT_MIN_DURATION_MS) return [text.trim()];
  const commaParts = splitPieceByPunctuation(text, COMMA_BREAK_PATTERN);
  if (commaParts.length > 1) {
    const totalWords = commaParts.reduce((sum, part) => sum + pieceWordCount(part), 0);
    return commaParts.flatMap(part => splitLongTextPieces(part, durationMs * pieceWordCount(part) / totalWords));
  }
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 2) return [text.trim()];
  const targetPieces = Math.max(2, Math.ceil(durationMs / SENTENCE_SPLIT_MIN_DURATION_MS));
  const perPiece = Math.ceil(tokens.length / targetPieces);
  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index += perPiece) parts.push(tokens.slice(index, index + perPiece).join(" "));
  return parts;
}

type TimedWord = { word: string; start: number; end: number };

function groupWordsByBoundary(words: TimedWord[], isBoundary: (word: string) => boolean) {
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const item of words) {
    current.push(item);
    if (isBoundary(item.word)) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

function timedWordsToLine(words: TimedWord[]): NarrationLine {
  return { start: words[0].start, end: words[words.length - 1].end, text: words.map(item => item.word).join(" ").trim() };
}

/** Splits a word stream at artifact-sized holes so lines never straddle dropped speech. */
function splitWordsAtGaps(words: TimedWord[], maxGapMs: number): TimedWord[][] {
  const ordered = [...words].sort((left, right) => left.start - right.start);
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of ordered) {
    if (current.length && (word.start - current[current.length - 1].end) * 1000 > maxGapMs) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Mirrors the proportional text splitter, but every piece inherits the real
 * Whisper word timestamps of its first and last word, so lines stay exact
 * even inside 30-second merged transcript segments.
 */
function splitWordGroupIntoLines(words: TimedWord[]): NarrationLine[] {
  const sentenceGroups = groupWordsByBoundary(words, word => SENTENCE_WORD_END_PATTERN.test(word));
  if (sentenceGroups.length > 1) return sentenceGroups.flatMap(group => splitWordGroupIntoLines(group));
  const durationMs = (words[words.length - 1].end - words[0].start) * 1000;
  if (durationMs <= SENTENCE_SPLIT_MIN_DURATION_MS) return [timedWordsToLine(words)];
  const commaGroups = groupWordsByBoundary(words, word => COMMA_WORD_END_PATTERN.test(word));
  if (commaGroups.length > 1) return commaGroups.flatMap(group => splitWordGroupIntoLines(group));
  const targetPieces = Math.max(2, Math.ceil(durationMs / SENTENCE_SPLIT_MIN_DURATION_MS));
  const perPiece = Math.ceil(words.length / targetPieces);
  const parts: NarrationLine[] = [];
  for (let index = 0; index < words.length; index += perPiece) parts.push(timedWordsToLine(words.slice(index, index + perPiece)));
  return parts;
}

/**
 * Turns Whisper segments into a fine sentence-level anchor grid. When Groq
 * supplied word-level timestamps the line boundaries are the exact spoken
 * word times; legacy transcripts without word timings fall back to
 * word-proportional estimates.
 */
export function splitTranscriptIntoSentenceLines(segments: NarrationSegmentInput[]): NarrationLine[] {
  const lines: NarrationLine[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const startMs = Math.round(segment.start * 1000);
    const endMs = Math.round(segment.end * 1000);
    const words = segment.words;
    const completeWords = Array.isArray(words) && words.length > 0 && words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
    // Whisper words belong to a segment by their START time. Merged segments
    // and boundary-straddling words can end slightly outside the measured
    // range, so validate per word start rather than rejecting the whole set
    // because one trailing word overshoots the segment end.
    const segmentWords = completeWords ? words!.filter(word => word.start >= segment.start - 0.5 && word.start <= segment.end + 1.5) : null;
    if (segmentWords && segmentWords.length >= 2) {
      // A nondeterministic Whisper pass can drop a whole stretch of continuous
      // speech inside one segment (word hole). Keep word-exact lines for the
      // spoken stretches and bridge the hole with a placeholder line so anchor
      // timings keep advancing instead of jumping across the dropped range.
      const gapGroups = splitWordsAtGaps(segmentWords, MAX_ALLOWED_INTERNAL_WORD_GAP_MS);
      if (gapGroups.length > 1) {
        for (let groupIndex = 0; groupIndex < gapGroups.length; groupIndex += 1) {
          const group = gapGroups[groupIndex];
          const groupLines = group.length >= 2 ? splitWordGroupIntoLines(group) : [timedWordsToLine(group)];
          for (const line of groupLines) lines.push(line);
          if (groupIndex < gapGroups.length - 1) {
            const gapStart = group[group.length - 1].end;
            const gapEnd = gapGroups[groupIndex + 1][0].start;
            lines.push({ start: gapStart, end: gapEnd, text: "…" });
          }
        }
        continue;
      }
      for (const line of splitWordGroupIntoLines(segmentWords)) lines.push(line);
      continue;
    }
    const durationMs = Math.max(1, endMs - startMs);
    const pieces = splitLongTextPieces(text, durationMs);
    const weights = pieces.map(pieceWordCount);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursorMs = startMs;
    pieces.forEach((piece, index) => {
      const pieceMs = index === pieces.length - 1 ? endMs - cursorMs : Math.max(1, Math.round(durationMs * weights[index] / totalWeight));
      lines.push({ start: cursorMs / 1000, end: (cursorMs + pieceMs) / 1000, text: piece });
      cursorMs += pieceMs;
    });
  }
  return lines;
}

/**
 * Converts monotonic per-image anchor line indices into exact millisecond
 * durations. Every boundary sits on a Whisper line start, so sync error can
 * never accumulate: each image start derives from the transcript alone.
 * Images sharing one line split that line's span proportionally to optional
 * duration hints (equal when hints are absent), and the final group extends
 * to the measured audio end.
 */
export function computeAnchorBoundaries(audioDurationMs: number, lines: NarrationLine[], anchors: number[], hints?: Array<number | null>): number[] {
  if (!Number.isInteger(audioDurationMs) || audioDurationMs <= 0) throw new Error("Anchor boundaries require a positive integer audio duration.");
  if (!lines.length) throw new Error("Anchor boundaries require at least one narration line.");
  if (!anchors.length || anchors.some((anchor, index) => !Number.isInteger(anchor) || anchor < 0 || anchor >= lines.length || (index > 0 && anchor < anchors[index - 1]))) throw new Error("Anchor boundaries require valid monotonic line anchors.");
  const groups: Array<{ anchor: number; members: number[] }> = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const last = groups[groups.length - 1];
    if (last && last.anchor === anchors[index]) last.members.push(index);
    else groups.push({ anchor: anchors[index], members: [index] });
  }
  const lineStartMs = (lineIndex: number) => Math.round(lines[lineIndex].start * 1000);
  const durations = new Array<number>(anchors.length).fill(0);
  let cursorMs = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const memberCount = group.members.length;
    const nextStartMs = groupIndex === groups.length - 1 ? audioDurationMs : lineStartMs(groups[groupIndex + 1].anchor);
    const groupEndMs = Math.max(cursorMs + memberCount, nextStartMs);
    const spanMs = groupEndMs - cursorMs;
    const weights = group.members.map(memberIndex => {
      const hint = hints?.[memberIndex];
      return Number.isFinite(hint) && (hint as number) > 0 ? (hint as number) : 1;
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const reserve = spanMs - memberCount;
    const shares = weights.map(weight => (reserve * weight) / totalWeight);
    const floors = shares.map(share => Math.floor(share));
    let leftover = reserve - floors.reduce((sum, value) => sum + value, 0);
    const byFraction = shares.map((share, index) => ({ index, fraction: share - Math.floor(share) })).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
    for (const item of byFraction) {
      if (leftover <= 0) break;
      floors[item.index] += 1;
      leftover -= 1;
    }
    group.members.forEach((memberIndex, member) => { durations[memberIndex] = 1 + floors[member]; });
    cursorMs = groupEndMs;
  }
  return durations;
}

/** Deterministic no-model fallback: equal pacing snapped to the nearest sentence starts. */
export function fallbackProportionalAnchors(audioDurationMs: number, lines: NarrationLine[], imageCount: number): number[] {
  if (!lines.length || imageCount <= 0) return [];
  const anchors: number[] = [];
  let lastAnchor = 0;
  for (let index = 0; index < imageCount; index += 1) {
    const targetMs = Math.round((index * audioDurationMs) / imageCount);
    let best = lastAnchor;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let lineIndex = lastAnchor; lineIndex < lines.length; lineIndex += 1) {
      const distance = Math.abs(Math.round(lines[lineIndex].start * 1000) - targetMs);
      if (distance < bestDistance) { bestDistance = distance; best = lineIndex; }
    }
    lastAnchor = best;
    anchors.push(best);
  }
  return anchors;
}

/**
 * Post-sanitizes a complete anchor sequence: range clamps, monotonic
 * enforcement, a front guard so image one never swallows a huge opening
 * stretch, a mid-sequence guard that caps how far a single AI anchor mistake
 * can pull the next boundary forward, and a tail guard that spreads trailing
 * images over the remaining narration when the model crammed them onto one
 * early line. When points are enabled a legitimately long skip means a
 * narration point has no image, so the guards scale six times wider instead
 * of fighting the user's own point numbering.
 */
export function sanitizeFinalAnchorSequence(audioDurationMs: number, lines: NarrationLine[], anchors: number[], options?: { pointAware?: boolean }): number[] {
  if (!anchors.length || !lines.length) return anchors;
  const pointAware = options?.pointAware === true;
  const sanitized = anchors.map(anchor => Math.max(0, Math.min(lines.length - 1, Math.round(anchor))));
  for (let index = 1; index < sanitized.length; index += 1) sanitized[index] = Math.max(sanitized[index], sanitized[index - 1]);
  const fairMs = audioDurationMs / sanitized.length;
  const guardCapMs = pointAware ? Math.max(fairMs * 6, 15_000) : fairMs * 2 + 5_000;
  if (sanitized.length >= 2) {
    const capMs = guardCapMs;
    const firstBoundaryMs = Math.round(lines[sanitized[1]].start * 1000);
    if (firstBoundaryMs > capMs) {
      let best = sanitized[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let lineIndex = sanitized[0]; lineIndex < lines.length; lineIndex += 1) {
        const startMs = Math.round(lines[lineIndex].start * 1000);
        if (startMs > capMs) break;
        const distance = capMs - startMs;
        if (distance < bestDistance) { bestDistance = distance; best = lineIndex; }
      }
      sanitized[1] = best;
      for (let index = 2; index < sanitized.length; index += 1) sanitized[index] = Math.max(sanitized[index], sanitized[index - 1]);
    }
  }
  if (sanitized.length >= 3) {
    const skipCapMs = pointAware ? Math.max(fairMs * 6, 15_000) : Math.max(MAX_MID_SEQUENCE_SKIP_MS, fairMs * 1.5);
    for (let index = 1; index < sanitized.length - 1; index += 1) {
      if (sanitized[index] <= sanitized[index - 1] + 1) continue;
      const previousStartMs = Math.round(lines[sanitized[index - 1]].start * 1000);
      const currentStartMs = Math.round(lines[sanitized[index]].start * 1000);
      if (currentStartMs - previousStartMs <= skipCapMs) continue;
      const targetMs = previousStartMs + skipCapMs;
      let best = sanitized[index - 1];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let lineIndex = sanitized[index - 1] + 1; lineIndex <= sanitized[index]; lineIndex += 1) {
        const startMs = Math.round(lines[lineIndex].start * 1000);
        if (startMs > targetMs) break;
        const distance = targetMs - startMs;
        if (distance < bestDistance) { bestDistance = distance; best = lineIndex; }
      }
      sanitized[index] = best;
    }
  }
  const lastAnchor = sanitized[sanitized.length - 1];
  let tailCount = 0;
  for (let index = sanitized.length - 1; index >= 0 && sanitized[index] === lastAnchor; index -= 1) tailCount += 1;
  if (lastAnchor < lines.length - 1 && tailCount > 0) {
    const tailStartMs = Math.round(lines[lastAnchor].start * 1000);
    const spanMs = audioDurationMs - tailStartMs;
    if (spanMs > tailCount * MAX_SINGLE_IMAGE_TAIL_STRETCH_MS) {
      const start = sanitized.length - tailCount;
      const stretched = sanitized.slice(0, start);
      for (let offset = 1; offset <= tailCount; offset += 1) {
        const targetMs = tailStartMs + Math.round(((offset - 1) * spanMs) / tailCount);
        let best = stretched.length ? stretched[stretched.length - 1] : lastAnchor;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let lineIndex = best; lineIndex < lines.length; lineIndex += 1) {
          const distance = Math.abs(Math.round(lines[lineIndex].start * 1000) - targetMs);
          if (distance < bestDistance) { bestDistance = distance; best = lineIndex; }
        }
        stretched.push(best);
      }
      return stretched;
    }
  }
  return sanitized;
}

export type ParsedAnchors = { anchors: number[]; hints: Array<number | null>; lazy: boolean };

export function parseAndSanitizeAnchors(value: unknown, batchLength: number, lineCount: number, cursorLine: number): ParsedAnchors | null {
  if (lineCount <= 0 || batchLength <= 0) return null;
  const record = value && typeof value === "object" ? value as { anchors?: unknown; durations?: unknown } : {};
  const rawAnchors = Array.isArray(record.anchors) ? record.anchors : [];
  const anchors = rawAnchors.map(item => Number(item)).filter(Number.isFinite);
  if (anchors.length !== batchLength) return null;
  const sanitized: number[] = [];
  let running = Math.max(0, Math.min(lineCount - 1, Math.round(cursorLine)));
  for (const anchor of anchors) {
    running = Math.max(running, Math.min(lineCount - 1, Math.max(0, Math.round(anchor))));
    sanitized.push(running);
  }
  const rawHints = Array.isArray(record.durations) ? record.durations.map(item => Number(item)) : [];
  const hints = rawHints.map(item => (Number.isFinite(item) && item > 0 ? item : null));
  while (hints.length < batchLength) hints.push(null);
  const lazy = batchLength >= 8 && sanitized[sanitized.length - 1] - sanitized[0] < Math.floor(batchLength / 4);
  return { anchors: sanitized, hints: hints.slice(0, batchLength), lazy };
}

export function buildDirectAnchorPacingPrompt(input: {
  batchIndex: number;
  batchCount: number;
  batch: PacingBatchItem[];
  lines: NarrationLine[];
  cursorLine: number;
  audioDurationMs: number;
  imageCount: number;
  holdMode: ReadableHoldMode;
  corrective: boolean;
  missingPoints?: number[];
}) {
  const windowStart = Math.max(0, input.cursorLine - 2);
  const coverageSeconds = Math.max(input.batch.length * 2.0, input.batch.length * 4.5 + 8);
  let windowEnd = windowStart;
  let coveredSeconds = 0;
  for (let lineIndex = input.cursorLine; lineIndex < input.lines.length; lineIndex += 1) {
    coveredSeconds += Math.max(0.1, input.lines[lineIndex].end - input.lines[lineIndex].start);
    windowEnd = lineIndex + 1;
    if (coveredSeconds >= coverageSeconds) break;
  }
  windowEnd = Math.max(windowEnd, Math.min(input.lines.length, input.cursorLine + 2));
  const minimumCoverageSeconds = input.batch.length * 1.5;
  const parts: string[] = [];
  let characters = 0;
  let coveredAfterCursor = 0;
  for (let lineIndex = windowStart; lineIndex < windowEnd; lineIndex += 1) {
    const line = input.lines[lineIndex];
    const piece = `${lineIndex}|${line.start.toFixed(1)}-${line.end.toFixed(1)}|${line.text}`;
    if (lineIndex >= input.cursorLine && coveredAfterCursor >= minimumCoverageSeconds && characters + piece.length + 1 > MAX_ANCHOR_PROMPT_NARRATION_CHARACTERS) break;
    parts.push(piece);
    characters += piece.length + 1;
    if (lineIndex >= input.cursorLine) coveredAfterCursor += Math.max(0.1, line.end - line.start);
  }
  const holdGuidance = input.holdMode === "MIN_2_SECONDS"
    ? `Prefer anchors that keep each image on screen for at least ~${(MIN_READABLE_IMAGE_DURATION_MS / 1000).toFixed(1)} seconds. When the narration is denser than that, keep the exact sentence boundary and never skip backward.`
    : "No minimum hold is required; anchor each image precisely at the line where its content starts.";
  const hasPoints = input.batch.every(item => Number.isInteger(item.point) && (item.point as number) > 0);
  const missingPoints = (input.missingPoints ?? []).filter(point => Number.isInteger(point) && point > 0);
  const pointGuidance = hasPoints
    ? ` Every image carries the narration point number it illustrates (point 1 = the first spoken point of the narration; points increase in spoken order). Anchor the image with point p at the FIRST line where point p begins. One point may span two consecutive lines when the transcriber split a single sentence mid-way: keep those lines together under that point and anchor at the first of them.${missingPoints.length ? ` The whole video has NO image for point(s) ${missingPoints.join(", ")}: the previous image stays on screen through those points, so never anchor anything at the lines of those points.` : ""} Never anchor an image at a line that still belongs to an earlier point than the image's own point.`
    : "";
  const batchJson = hasPoints ? input.batch : input.batch.map(({ sequence, scene }) => ({ sequence, scene }));
  return `Contiguous ordered image batch ${input.batchIndex + 1}/${input.batchCount} for a narration-driven video. Full audio is ${(input.audioDurationMs / 1000).toFixed(1)} seconds with ${input.imageCount} total ordered images and ${input.lines.length} timestamped narration lines. Previous images ended near line ${input.cursorLine}; anchors in this batch must be non-decreasing and every anchor must be greater than or equal to ${input.cursorLine}. For each image in the listed order, return the line index where the visible content of that image should START being shown. An image may cover several lines: anchor it at the FIRST line it covers. Consecutive images may share one line when the narration is dense; they will split that line's time. Spread anchors across the full remaining narration; the final images should reach the final lines. ${holdGuidance}${pointGuidance}${input.corrective ? " The previous answer was rejected because it crammed the whole batch onto too few lines; anchor each image to its own spoken sentence(s) using the timestamps." : ""} Your ENTIRE reply must be a single JSON object and nothing else: no explanation, no point-to-line mapping, no markdown, no text before or after the object. Reply with exactly {"anchors":[...]} containing ${input.batch.length} integers, and optionally "durations":[...] with ${input.batch.length} positive spoken-seconds hints. Use only the supplied line indices. Timestamped narration lines (index|start-end seconds|text): ${parts.join(" ")}. Image batch in order (${hasPoints ? "sequence|point|scene" : "sequence|scene"}): ${JSON.stringify(batchJson)}`;
}
