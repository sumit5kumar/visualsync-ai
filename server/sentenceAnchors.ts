import { MIN_READABLE_IMAGE_DURATION_MS, type ReadableHoldMode } from "./readablePacing";

export type NarrationLine = { start: number; end: number; text: string };

const SENTENCE_SPLIT_MIN_DURATION_MS = 4_500;
const MAX_ANCHOR_PROMPT_NARRATION_CHARACTERS = 12_000;
const MAX_SINGLE_IMAGE_TAIL_STRETCH_MS = 10_000;

const SENTENCE_BREAK_PATTERN = /[^।.!?;]+[।.!?;]*/g;
const COMMA_BREAK_PATTERN = /[^,]+(?:,|$)/g;

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

/**
 * Turns coarse Whisper segments into a fine sentence-level anchor grid with
 * word-proportional timestamps, so every image boundary can lock onto a real
 * spoken sentence start instead of a 30-second merged transcript block.
 */
export function splitTranscriptIntoSentenceLines(segments: Array<{ start: number; end: number; text: string }>): NarrationLine[] {
  const lines: NarrationLine[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const startMs = Math.round(segment.start * 1000);
    const endMs = Math.round(segment.end * 1000);
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
 * stretch, and a tail guard that spreads trailing images over the remaining
 * narration when the model crammed them onto one early line.
 */
export function sanitizeFinalAnchorSequence(audioDurationMs: number, lines: NarrationLine[], anchors: number[]): number[] {
  if (!anchors.length || !lines.length) return anchors;
  const sanitized = anchors.map(anchor => Math.max(0, Math.min(lines.length - 1, Math.round(anchor))));
  for (let index = 1; index < sanitized.length; index += 1) sanitized[index] = Math.max(sanitized[index], sanitized[index - 1]);
  if (sanitized.length >= 2) {
    const fairMs = audioDurationMs / sanitized.length;
    const capMs = fairMs * 2 + 5_000;
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
  batch: Array<{ sequence: number | null; scene: string }>;
  lines: NarrationLine[];
  cursorLine: number;
  audioDurationMs: number;
  imageCount: number;
  holdMode: ReadableHoldMode;
  corrective: boolean;
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
  return `Contiguous ordered image batch ${input.batchIndex + 1}/${input.batchCount} for a narration-driven video. Full audio is ${(input.audioDurationMs / 1000).toFixed(1)} seconds with ${input.imageCount} total ordered images and ${input.lines.length} timestamped narration lines. Previous images ended near line ${input.cursorLine}; anchors in this batch must be non-decreasing and every anchor must be greater than or equal to ${input.cursorLine}. For each image in the listed order, return the line index where the visible content of that image should START being shown. An image may cover several lines: anchor it at the FIRST line it covers. Consecutive images may share one line when the narration is dense; they will split that line's time. Spread anchors across the full remaining narration; the final images should reach the final lines. ${holdGuidance}${input.corrective ? " The previous answer was rejected because it crammed the whole batch onto too few lines; anchor each image to its own spoken sentence(s) using the timestamps." : ""} Reply only {"anchors":[...]} with exactly ${input.batch.length} integers and optionally "durations":[...] with ${input.batch.length} positive spoken-seconds hints. Use only the supplied line indices. Timestamped narration lines (index|start-end seconds|text): ${parts.join(" ")}. Image batch in order (sequence|scene): ${JSON.stringify(input.batch)}`;
}
