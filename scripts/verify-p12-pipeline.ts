import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeChunkTranscripts, shiftSegmentTimestamps, type PersistedNarrationChunk } from "../server/narrationTranscription";
import { computeAnchorBoundaries, fallbackProportionalAnchors, sanitizeFinalAnchorSequence, splitTranscriptIntoSentenceLines } from "../server/sentenceAnchors";

// Real hosted production data from project 12 ("Nothing") BEFORE the v4 fixes:
// chunk 2 stores RELATIVE word times while its segments are absolute.
const raw = JSON.parse(readFileSync(resolve(process.cwd(), "../visualsync-smarterasp/p12-chunks.json"), "utf8")) as Array<{
  startMs: number; endMs: number; contentStartMs: number; contentEndMs: number;
  segments: Array<{ start: number; end: number; text: string; words: Array<{ word: string; start: number; end: number }> }>;
}>;

const chunks: PersistedNarrationChunk[] = raw.map(chunk => ({
  storageKey: "chunk.wav", startMs: chunk.startMs, endMs: chunk.endMs, contentStartMs: chunk.contentStartMs, contentEndMs: chunk.contentEndMs,
  byteSize: 1, status: "completed", attempts: 1,
  // The persisted state came from the OLD code: segment times were already
  // shifted to absolute, words stayed relative. Reconstruct the raw Groq
  // response (relative times), then apply the v4 shift like production does.
  transcript: {
    text: "x",
    segments: shiftSegmentTimestamps(
      chunk.segments.map(segment => ({ ...segment, start: segment.start - chunk.startMs / 1000, end: segment.end - chunk.startMs / 1000 })),
      chunk.startMs / 1000
    ),
  },
}));

const merged = mergeChunkTranscripts(chunks);
console.log("=== merged segments (v4) ===");
for (const segment of merged) {
  console.log(`[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] words=${segment.words?.length ?? 0}${segment.words?.length ? ` first=${segment.words[0].word}@${segment.words[0].start.toFixed(2)} last=${segment.words.at(-1)!.word}@${segment.words.at(-1)!.end.toFixed(2)}` : ""}`);
}

const lines = splitTranscriptIntoSentenceLines(merged);
console.log(`\n=== sentence lines: ${lines.length} ===`);
lines.forEach((line, index) => console.log(`${index}|${line.start.toFixed(2)}-${line.end.toFixed(2)}|${line.text.slice(0, 60)}`));

const AUDIO_MS = 67_451;
const IMAGES = 18;
const fallback = fallbackProportionalAnchors(AUDIO_MS, lines, IMAGES);
const sanitized = sanitizeFinalAnchorSequence(AUDIO_MS, lines, fallback);
const durations = computeAnchorBoundaries(AUDIO_MS, lines, sanitized);
console.log(`\n=== deterministic fallback timeline (${IMAGES} images) ===`);
let cursor = 0;
durations.forEach((duration, index) => {
  console.log(`image ${index + 1}: [${cursor}-${cursor + duration}] dur=${duration}ms at line start ${lines[sanitized[index]].start.toFixed(2)}s`);
  cursor += duration;
});
console.log(`sum=${cursor}ms vs audio=${AUDIO_MS}ms`);
