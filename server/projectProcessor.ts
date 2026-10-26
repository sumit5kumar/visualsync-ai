import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqRequestError } from "./groqClient";
import { getDb } from "./db";
import { executeWithGroqRotation, GroqPoolExhaustedError } from "./groqPool";
import { ABSOLUTE_MIN_IMAGE_DURATION_MS, buildGlobalReadableImageDurations, MIN_READABLE_IMAGE_DURATION_MS, resolveReadableMinimumDuration, type ReadableHoldMode } from "./readablePacing";
import { buildDirectAnchorPacingPrompt, computeAnchorBoundaries, fallbackProportionalAnchors, parseAndSanitizeAnchors, sanitizeFinalAnchorSequence, splitTranscriptIntoSentenceLines } from "./sentenceAnchors";
import { storageGetSignedUrl } from "./storage";
import { validateTimeline } from "./timelineValidation";
import { buildSemanticWeightedTimeline, type SemanticAssignment, type SemanticImage, type SemanticTranscriptSegment } from "./semanticTimeline";
import { makePcmWavChunk, planPcmWavTranscriptionRanges, SAFE_GROQ_DIRECT_WAV_BYTES, SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, scanMp3FrameRanges } from "./audioChunking";
import { mp3ToMonoWav } from "./audioTranscoding";
import { ADAPTIVE_PCM_WAV_RANGE_SPLIT_AFTER_ATTEMPTS, mergeChunkTranscripts, readNarrationTranscriptionState, splitRepeatedlyFailingPcmWavRange, summarizeNarrationText, type Mp3PreparationActiveChunk, type Mp3PreparationFrame, type Mp3PreparationState, type NarrationTranscriptionState, type PersistedNarrationChunk } from "./narrationTranscription";
import sharp from "sharp";

function transcriptForRange(segments: Array<{ start: number; end: number; text: string }>, startMs: number, endMs: number) {
  const text = segments.filter(segment => segment.end * 1000 > startMs && segment.start * 1000 < endMs).map(segment => segment.text.trim()).filter(Boolean).join(" ");
  return text || segments.at(-1)?.text.trim() || "Narration visual sequence";
}

const MAX_PACING_IMAGES_PER_REQUEST = 24;
const MAX_SEMANTIC_IMAGES_PER_REQUEST = 20;
const MAX_PACING_NARRATION_CHARACTERS = 16000;
const NARRATION_SOURCE_PREPARATION_VERSION = 7;
const MP3_PREPARATION_SCAN_BYTES = 256 * 1024;
const MP3_OVERLAP_BYTE_BUDGET = Math.floor(SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES * 0.25);
const MP3_TARGET_CHUNK_DURATION_MS = 60_000;
const MP3_MAX_CHUNK_BYTES = 1_536 * 1024;
const MP3_OVERLAP_DURATION_MS = 4_000;
const HOSTED_STORAGE_READ_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_PACING_QUALITY_RETRIES = 1;
const MAX_VISUAL_CATALOG_SCENE_CHARS = 300;

export function buildBoundedPacingBatches<T>(items: T[], batchSize = MAX_PACING_IMAGES_PER_REQUEST) { const batches: T[][] = []; for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize)); return batches; }

function formatRichVisualScene(analysis: Record<string, unknown> | null | undefined): string {
  if (!analysis || typeof analysis !== "object") return "Visual scene";
  const parts: string[] = [];
  const pushPart = (label: string, val: unknown) => {
    if (!val) return;
    const text = Array.isArray(val)
      ? val.map(item => String(item ?? "").trim()).filter(Boolean).join(", ")
      : typeof val === "object"
        ? JSON.stringify(val)
        : String(val).trim();
    if (text) parts.push(label ? `${label}:${text}` : text);
  };
  pushPart("", analysis.sceneDescription);
  pushPart("Subjects", analysis.subjects);
  pushPart("Setting", analysis.setting);
  pushPart("Mood", analysis.mood);
  pushPart("Context", analysis.relevance);
  return parts.join(" | ").replace(/\s+/g, " ").trim().slice(0, MAX_VISUAL_CATALOG_SCENE_CHARS) || "Visual scene";
}

function tokenizeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(new RegExp("[^\\p{L}\\p{N}\\s]+", "gu"), " ")
    .split(/\s+/)
    .filter(word => word.length >= 3);
}

function scoreSceneAgainstTranscript(sceneText: string, transcriptText: string): number {
  const sceneWords = tokenizeKeywords(sceneText);
  const segWords = new Set(tokenizeKeywords(transcriptText));
  if (!sceneWords.length || !segWords.size) return 0;
  let matches = 0;
  for (const word of sceneWords) {
    if (segWords.has(word)) matches += 1;
  }
  return matches / Math.sqrt(sceneWords.length);
}

/**
 * Legacy weight-based alignment kept only for hosted jobs that were mid-flight
 * when Direct Sentence Anchor shipped. Snap feasibility now uses the absolute
 * 750 ms image minimum instead of the 2.2 s readable floor, so short sentence
 * boundaries can still be locked instead of being silently skipped.
 */
function alignOrderedWeightsToSpeechBoundaries(
  audioDurationMs: number,
  transcriptSegments: Array<{ start: number; end: number; text: string }>,
  visualCatalog: Array<{ sequence: number | null; scene: string }>,
  batches: Array<Array<{ sequence: number | null; scene: string }>>,
  rawWeights: number[],
  holdMode: ReadableHoldMode,
): number[] {
  if (rawWeights.length <= 1) return rawWeights;
  const minHoldMs = holdMode === "NO_MINIMUM"
    ? 1
    : resolveReadableMinimumDuration(audioDurationMs, rawWeights.length);

  // Step 1: Normalize each batch's mean weight to a consistent spoken-seconds scale while allowing dense/fast batches to take naturally less time and slow/detailed batches to take more time.
  const calibratedWeights: number[] = [];
  let offset = 0;
  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b];
    const slice = rawWeights.slice(offset, offset + batch.length).map(w => Math.max(0.1, Number.isFinite(w) ? w : 1));
    const sliceMedian = slice.slice().sort((x, y) => x - y)[Math.floor(slice.length / 2)] || 1;
    for (let i = 0; i < batch.length; i += 1) {
      const globalIdx = offset + i;
      const normalizedWeight = Math.min(4.5, Math.max(0.25, slice[i] / Math.max(0.1, sliceMedian)));
      const approxSegIdx = Math.min(
        transcriptSegments.length - 1,
        Math.floor((globalIdx / Math.max(1, rawWeights.length)) * transcriptSegments.length),
      );
      const localWindowStart = Math.max(0, approxSegIdx - 2);
      const localWindowEnd = Math.min(transcriptSegments.length, approxSegIdx + 3);
      let bestSegDurationSec = Math.max(1.0, (audioDurationMs / 1000) / Math.max(1, rawWeights.length));
      let bestScore = -1;
      for (let s = localWindowStart; s < localWindowEnd; s += 1) {
        const seg = transcriptSegments[s];
        const score = scoreSceneAgainstTranscript(visualCatalog[globalIdx]?.scene ?? "", seg.text);
        if (score > bestScore) {
          bestScore = score;
          bestSegDurationSec = Math.max(0.8, seg.end - seg.start);
        }
      }
      calibratedWeights.push(normalizedWeight * 0.7 + bestSegDurationSec * 0.3);
    }
    offset += batch.length;
  }

  // Step 2: Convert globally calibrated spoken-second weights into initial target boundaries across the full audioDurationMs.
  const basePacing = buildGlobalReadableImageDurations(audioDurationMs, calibratedWeights, holdMode);
  const boundaries: number[] = [0];
  for (const d of basePacing.durations) boundaries.push(boundaries[boundaries.length - 1] + d);

  // Step 3: Collect all Whisper sentence start/end points and natural pause midpoints.
  const rawSpeechPoints: number[] = [];
  for (let i = 0; i < transcriptSegments.length; i += 1) {
    const segStartMs = Math.round(transcriptSegments[i].start * 1000);
    const segEndMs = Math.round(transcriptSegments[i].end * 1000);
    rawSpeechPoints.push(segStartMs, segEndMs);
    if (i + 1 < transcriptSegments.length) {
      const nextStartMs = Math.round(transcriptSegments[i + 1].start * 1000);
      if (nextStartMs > segEndMs) {
        rawSpeechPoints.push(Math.round((segEndMs + nextStartMs) / 2));
      }
    }
  }
  const speechBoundariesMs = Array.from(new Set(rawSpeechPoints.filter(ms => ms > ABSOLUTE_MIN_IMAGE_DURATION_MS && ms < audioDurationMs - ABSOLUTE_MIN_IMAGE_DURATION_MS))).sort((a, b) => a - b);

  // Step 4: Snap every internal boundary to the nearest natural speech boundary.
  if (speechBoundariesMs.length > 0) {
    for (let i = 1; i < boundaries.length - 1; i += 1) {
      const prevBoundary = boundaries[i - 1];
      const nextBoundary = boundaries[i + 1];
      const minAllowed = prevBoundary + ABSOLUTE_MIN_IMAGE_DURATION_MS;
      const maxAllowed = nextBoundary - ABSOLUTE_MIN_IMAGE_DURATION_MS;
      if (minAllowed > maxAllowed) continue;
      const target = boundaries[i];
      const localClipMs = Math.max(minHoldMs, target - prevBoundary);
      const maxSnapToleranceMs = Math.min(4_500, Math.max(700, Math.round(localClipMs * 0.48)));
      let bestSnap = target;
      let bestDist = maxSnapToleranceMs + 1;
      for (const candidate of speechBoundariesMs) {
        if (candidate < minAllowed || candidate > maxAllowed) continue;
        const dist = Math.abs(candidate - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestSnap = candidate;
        }
      }
      boundaries[i] = bestSnap;
    }
  }

  // Step 5: De-bias for distributeReadableWeightedDurations's flat minimumDurationMs floor so final durations match the snapped speech boundaries exactly.
  const targetDurationsMs = boundaries.slice(1).map((endMs, idx) => Math.max(minHoldMs, endMs - boundaries[idx]));
  if (holdMode === "NO_MINIMUM" || audioDurationMs <= rawWeights.length * minHoldMs) {
    return targetDurationsMs.map((d, idx) => Math.max(0.01, d / 1000 + (idx % 3) * 0.001));
  }
  return targetDurationsMs.map((d, idx) => Math.max(0.01, (d - minHoldMs) / 1000 + 0.05 + (idx % 3) * 0.0005));
}

function unwrapSemanticPlanValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value && "requestMetadata" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/**
 * Builds a global any-to-any semantic prompt so any image (even the last image
 * or the first image) can match any timestamp across the entire narration (e.g.,
 * 0:00 or 2:04 or 28:00), while showing which segments are already occupied so
 * images spread cleanly across the story.
 */
function semanticSyncPrompt(
  batch: Array<{ sequence: number | null; scene: string }>,
  transcriptSegments: SemanticTranscriptSegment[],
  audioDurationMs: number,
  priorAssignments: SemanticAssignment[] = [],
) {
  const usedCounts = new Map<number, number>();
  for (const a of priorAssignments) {
    usedCounts.set(a.segmentIndex, (usedCounts.get(a.segmentIndex) ?? 0) + 1);
  }
  const fullTranscript = transcriptSegments.map((segment, index) => ({
    index,
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    used: usedCounts.get(index) ?? 0,
    text: segment.text.trim(),
  }));
  const fullJson = JSON.stringify(fullTranscript);
  let selectedTranscript = fullTranscript;
  if (fullJson.length > MAX_PACING_NARRATION_CHARACTERS) {
    const candidateIndices = new Set<number>();
    // Always include evenly spaced anchor segments across the whole timeline
    const step = Math.max(1, Math.floor(fullTranscript.length / 60));
    for (let i = 0; i < fullTranscript.length; i += step) candidateIndices.add(i);
    // Include top keyword-matching segments from anywhere in the full narration for each image in this batch
    for (const img of batch) {
      const scored = fullTranscript
        .map(seg => ({ index: seg.index, score: scoreSceneAgainstTranscript(img.scene, seg.text) - (seg.used * 0.15) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      for (const item of scored) candidateIndices.add(item.index);
    }
    selectedTranscript = Array.from(candidateIndices)
      .sort((a, b) => a - b)
      .map(idx => fullTranscript[idx])
      .filter(Boolean);
  }
  return `Map every image in this batch to the most semantically relevant timestamped narration segment across the entire narration. Any image can match any timestamped segment from 0 ms to ${audioDurationMs} ms based on its visible meaning, not its filename or numeric order. Prefer segments with used=0 when semantic relevance is similar so images do not pile up on a single sentence. Reply only with JSON {"assignments":[{"imageSequence":number,"transcriptSegmentIndex":number,"weight":number}]}. Return exactly one assignment for every image in the batch, never omit or duplicate an image, use only the supplied transcriptSegmentIndex values, and use positive weights from 0.5 to 3.0. Full narration duration is ${audioDurationMs} ms. Timestamped narration segments: ${JSON.stringify(selectedTranscript)}. Image batch: ${JSON.stringify(batch)}`;
}

function parseSemanticAssignments(
  value: unknown,
  batch?: Array<{ sequence: number | null; scene: string }>,
  transcriptSegments?: SemanticTranscriptSegment[],
  priorAssignments: SemanticAssignment[] = [],
): SemanticAssignment[] {
  const unwrapped = unwrapSemanticPlanValue(value);
  const raw = unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as { assignments?: unknown }).assignments)
    ? (unwrapped as { assignments: unknown[] }).assignments
    : [];
  const parsed = raw.map(item => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      sequence: Number(record.imageSequence ?? record.sequence),
      segmentIndex: Number(record.transcriptSegmentIndex ?? record.segmentIndex),
      weight: Number(record.weight),
    };
  }).filter(assignment => Number.isFinite(assignment.sequence) && Number.isFinite(assignment.segmentIndex) && Number.isFinite(assignment.weight));

  if (!batch || !transcriptSegments || !transcriptSegments.length) return parsed;

  const totalSegments = transcriptSegments.length;
  const usedCounts = new Map<number, number>();
  for (const a of priorAssignments) {
    usedCounts.set(a.segmentIndex, (usedCounts.get(a.segmentIndex) ?? 0) + 1);
  }
  const bySequence = new Map<number, SemanticAssignment>();
  for (const item of parsed) {
    if (!bySequence.has(item.sequence)) {
      const clampedSegment = Math.max(0, Math.min(totalSegments - 1, Math.round(item.segmentIndex)));
      const clampedWeight = Number.isFinite(item.weight) && item.weight > 0 ? Math.min(3.0, Math.max(0.5, item.weight)) : 1.0;
      bySequence.set(item.sequence, { sequence: item.sequence, segmentIndex: clampedSegment, weight: clampedWeight });
      usedCounts.set(clampedSegment, (usedCounts.get(clampedSegment) ?? 0) + 1);
    }
  }

  return batch.map((item, idx) => {
    const seq = item.sequence ?? idx + 1;
    const existing = bySequence.get(seq);
    if (existing) return existing;
    // Global semantic fallback: find the best keyword-matching segment across the entire transcript that isn't overcrowded
    let bestSeg = Math.min(totalSegments - 1, Math.floor((idx / Math.max(1, batch.length)) * totalSegments));
    let bestScore = -1e9;
    for (let s = 0; s < totalSegments; s += 1) {
      const score = scoreSceneAgainstTranscript(item.scene, transcriptSegments[s].text) - ((usedCounts.get(s) ?? 0) * 0.25);
      if (score > bestScore) {
        bestScore = score;
        bestSeg = s;
      }
    }
    usedCounts.set(bestSeg, (usedCounts.get(bestSeg) ?? 0) + 1);
    return { sequence: seq, segmentIndex: bestSeg, weight: 1.0 };
  });
}

function assertSemanticBatchAssignments(assignments: SemanticAssignment[], batch: Array<{ sequence: number | null; scene: string }>, transcriptSegments: SemanticTranscriptSegment[]) {
  const expected = new Set(batch.map(item => item.sequence));
  if (assignments.length !== batch.length || assignments.some(item => !expected.has(item.sequence)) || new Set(assignments.map(item => item.sequence)).size !== batch.length) throw new Error("Groq did not return exactly one semantic assignment for every image batch item.");
  if (assignments.some(item => !Number.isInteger(item.segmentIndex) || item.segmentIndex < 0 || item.segmentIndex >= transcriptSegments.length || !Number.isFinite(item.weight) || item.weight <= 0)) throw new Error("Groq returned an invalid semantic transcript assignment.");
}

async function collectSemanticAssignments(userId: number, visualCatalog: Array<{ sequence: number | null; scene: string }>, transcriptSegments: SemanticTranscriptSegment[], audioDurationMs: number, timeoutMs = 60_000) {
  const batches = buildBoundedPacingBatches(visualCatalog, MAX_SEMANTIC_IMAGES_PER_REQUEST);
  const assignments: SemanticAssignment[] = [];
  let providerKey: { label: string; maskedKey: string } | null = null;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeSemanticSyncPlan({ prompt: semanticSyncPrompt(batch, transcriptSegments, audioDurationMs, assignments), timeoutMs }), key }));
    const batchAssignments = parseSemanticAssignments(run.value, batch, transcriptSegments, assignments);
    assertSemanticBatchAssignments(batchAssignments, batch, transcriptSegments);
    assignments.push(...batchAssignments);
    providerKey = run.key;
  }
  return { assignments, providerKey };
}

function buildSemanticRebuiltSegments(audioDurationMs: number, transcriptSegments: SemanticTranscriptSegment[], images: SemanticImage[], assignments: SemanticAssignment[], holdMode: "MIN_2_SECONDS" | "NO_MINIMUM") {
  const clips = buildSemanticWeightedTimeline({ audioDurationMs, transcriptSegments, images, assignments, holdMode });
  return clips.map(clip => ({ imageAssetId: clip.imageAssetId, startMs: clip.startMs, endMs: clip.endMs, narrationText: transcriptForRange(transcriptSegments, clip.startMs, clip.endMs), confidence: 0, selectionReason: `Semantic weighted sync matched uploaded image ${clip.sourceSequence} to transcript segment${clip.transcriptSegmentIndex} and reordered it by narration relevance.`, decisionType: "KEEP" as const }));
}

export async function mapWithConcurrency<T, Result>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<Result>) {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, worker));
  return results;
}
export function buildPublicManagedStorageUrl(origin: string, storageKey: string) {
  const safePath = storageKey.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return new URL(`/manus-storage/${safePath}`, origin).toString();
}

function mp3PreparationChunk(active: Mp3PreparationActiveChunk, storageKey: string): PersistedNarrationChunk {
  return { storageKey, sourceRange: { kind: "mp3", startByte: active.startByte, endByteExclusive: active.endByteExclusive }, startMs: Math.round(active.startMs), endMs: Math.round(active.endMs), contentStartMs: Math.round(active.contentStartMs), contentEndMs: Math.round(active.contentEndMs), byteSize: active.endByteExclusive - active.startByte, status: "pending", attempts: 0 };
}

function selectMp3OverlapStart(frames: Mp3PreparationFrame[], frame: Mp3PreparationFrame) {
  return frames.find(candidate => frame.startMs - candidate.startMs <= MP3_OVERLAP_DURATION_MS && frame.endByteExclusive - candidate.startByte <= MP3_MAX_CHUNK_BYTES) ?? frame;
}

export function recoverLegacyInflatedMp3Preparation(cached: NarrationTranscriptionState | null) {
  if (!cached || cached.sourcePrepared || (cached.sourcePreparationVersion ?? 0) >= NARRATION_SOURCE_PREPARATION_VERSION) return cached;
  const completed = cached.chunks.filter(chunk => chunk.status === "completed" && chunk.transcript);
  const first = completed[0];
  const firstStartByte = first?.sourceRange?.kind === "mp3" ? first.sourceRange.startByte : null;
  const repeatedStartByte = firstStartByte !== null && completed.slice(1).every(chunk => chunk.sourceRange?.kind === "mp3" && chunk.sourceRange.startByte === firstStartByte);
  if (completed.length < 2 || !repeatedStartByte) return cached;
  const retained = [first];
  const recoveredAtMs = first.endMs;
  const recoveredAtByte = first.sourceRange!.endByteExclusive;
  return { version: 2 as const, chunkOverlapMs: 0, sourcePrepared: false, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: retained, mp3Preparation: { nextByteOffset: recoveredAtByte, nextTimestampMs: recoveredAtMs, recentFrames: [] } } satisfies NarrationTranscriptionState;
}

function advanceMp3Preparation(state: NarrationTranscriptionState, storageKey: string, preparation: Mp3PreparationState, frames: Mp3PreparationFrame[]) {
  for (const frame of frames) {
    const active = preparation.activeChunk;
    if (!active) {
      const overlapStart = selectMp3OverlapStart(preparation.recentFrames, frame);
      preparation.activeChunk = { startByte: overlapStart.startByte, endByteExclusive: frame.endByteExclusive, startMs: overlapStart.startMs, endMs: frame.endMs, contentStartByte: frame.startByte, contentStartMs: frame.startMs, contentEndMs: frame.endMs };
    } else if (frame.endMs - active.contentStartMs >= MP3_TARGET_CHUNK_DURATION_MS || frame.endByteExclusive - active.startByte > MP3_MAX_CHUNK_BYTES) {
      state.chunks.push(mp3PreparationChunk(active, storageKey));
      const overlapStart = selectMp3OverlapStart(preparation.recentFrames, frame);
      preparation.activeChunk = { startByte: overlapStart.startByte, endByteExclusive: frame.endByteExclusive, startMs: overlapStart.startMs, endMs: frame.endMs, contentStartByte: frame.startByte, contentStartMs: frame.startMs, contentEndMs: frame.endMs };
    } else {
      active.endByteExclusive = frame.endByteExclusive;
      active.endMs = frame.endMs;
      active.contentEndMs = frame.endMs;
    }
    preparation.recentFrames.push(frame);
  }
  preparation.recentFrames = preparation.recentFrames.filter(frame => preparation.nextTimestampMs - frame.startMs <= MP3_OVERLAP_DURATION_MS * 2 && frame.endByteExclusive > preparation.nextByteOffset - MP3_OVERLAP_BYTE_BUDGET * 4);
  const activeOverlapMs = preparation.activeChunk ? preparation.activeChunk.contentStartMs - preparation.activeChunk.startMs : 0;
  state.chunkOverlapMs = Math.max(0, ...state.chunks.map(chunk => chunk.contentStartMs - chunk.startMs), activeOverlapMs);
}

async function boundedVisionImageUrl(storageKey: string) {
  const url = await storageGetSignedUrl(storageKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Uploaded image could not be retrieved from secure storage.");
  const source = Buffer.from(await response.arrayBuffer());
  const preview = await sharp(source, { limitInputPixels: 36_000_000 }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${preview.toString("base64")}`; }  async function fetchNarrationStorageRange(storageKey: string, range?: string) { const controller = new AbortController(); const startedAtMs = Date.now(); const timeout = setTimeout(() => controller.abort(), HOSTED_STORAGE_READ_TIMEOUT_MS); try { const url = await storageGetSignedUrl(storageKey, controller.signal); return await fetch(url, { ...(range ? { headers: { Range: range } } : {}), signal: controller.signal }); } catch (error) { const durationMs = Date.now() - startedAtMs; if (controller.signal.aborted) throw new GroqRequestError("Secure storage timed out while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "timeout" }); throw new GroqRequestError("Secure storage was temporarily unavailable while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "network_failure" }); } finally { clearTimeout(timeout); } }  async function loadNarrationChunkBytes(chunk: PersistedNarrationChunk) { const response = await fetchNarrationStorageRange(chunk.storageKey, chunk.sourceRange ? `bytes=${chunk.sourceRange.startByte}-${chunk.sourceRange.endByteExclusive - 1}` : undefined); if (!response.ok) throw new Error("Prepared narration chunk could not be retrieved from secure storage."); if (chunk.sourceRange && response.status !== 206) throw new Error("Secure storage did not honor the bounded WAV byte-range request."); const bytes = new Uint8Array(await response.arrayBuffer()); return chunk.sourceRange?.wavFmtBase64 ? makePcmWavChunk(new Uint8Array(Buffer.from(chunk.sourceRange.wavFmtBase64, "base64")), bytes) : bytes; }  async function persistNarrationTranscriptionState(narration: typeof mediaAssets.$inferSelect, state: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>) { await db.update(mediaAssets).set({ analysisJson: { ...(narration.analysisJson && typeof narration.analysisJson === "object" ? narration.analysisJson as Record<string, unknown> : {}), transcriptionState: state } }).where(eq(mediaAssets.id, narration.id)); }  export function isWavNarration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) { return narration.mimeType === "audio/wav" || narration.mimeType === "audio/x-wav" || narration.storageKey.toLowerCase().endsWith(".wav"); }  function isMp3Narration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) { return narration.mimeType === "audio/mpeg" || narration.storageKey.toLowerCase().endsWith(".mp3"); }  export async function prepareNarrationChunks(projectId: number, narration: typeof mediaAssets.$inferSelect, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>): Promise<NarrationTranscriptionState> { const cached = readNarrationTranscriptionState(narration.analysisJson); const wavNarration = isWavNarration(narration); if (cached?.sourcePrepared && cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION) return cached; if (!isMp3Narration(narration) && !wavNarration) throw new Error("This narration must be uploaded as WAV or MP3 for automatic safe transcription chunking."); if (isMp3Narration(narration)) { const repairedCached = recoverLegacyInflatedMp3Preparation(cached); const resumableCached = repairedCached && (repairedCached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || repairedCached.chunks.some(chunk => chunk.status === "completed" && chunk.transcript)) ? repairedCached : null; const state: NarrationTranscriptionState = resumableCached ?? { version: 2, chunkOverlapMs: 0, sourcePrepared: false, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: [], mp3Preparation: { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] } }; const preparation = state.mp3Preparation ?? { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] }; state.mp3Preparation = preparation; state.sourcePrepared = false; state.sourcePreparationVersion = NARRATION_SOURCE_PREPARATION_VERSION; await persistNarrationTranscriptionState(narration, state, db); const sourceResponse = await fetchNarrationStorageRange(narration.storageKey, `bytes=${preparation.nextByteOffset}-${preparation.nextByteOffset + MP3_PREPARATION_SCAN_BYTES - 1}`); if (!sourceResponse.ok || sourceResponse.status !== 206) throw new Error("Secure storage did not provide the bounded MP3 range required for durable preparation."); const sourceByteLength = Number(sourceResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]); if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the MP3 source length required for durable preparation."); preparation.sourceByteLength = sourceByteLength; const scanned = scanMp3FrameRanges(new Uint8Array(await sourceResponse.arrayBuffer()), preparation.nextByteOffset, preparation.nextTimestampMs); if (!scanned.frames.length && scanned.nextByteOffset <= preparation.nextByteOffset) throw new Error("MP3 preparation could not find a complete frame in the bounded source range."); preparation.nextByteOffset = scanned.nextByteOffset; preparation.nextTimestampMs = scanned.nextTimestampMs; advanceMp3Preparation(state, narration.storageKey, preparation, scanned.frames); if (preparation.nextByteOffset >= sourceByteLength) { if (preparation.activeChunk) state.chunks.push(mp3PreparationChunk(preparation.activeChunk, narration.storageKey)); state.sourcePrepared = true; delete state.mp3Preparation; state.chunkOverlapMs = state.chunks.length > 1 ? 4_000 : 0; } await persistNarrationTranscriptionState(narration, state, db); return state; } const storedChunks: PersistedNarrationChunk[] = wavNarration ? await (async () => { const headerResponse = await fetchNarrationStorageRange(narration.storageKey, "bytes=0-65535"); if (!headerResponse.ok || headerResponse.status !== 206) throw new Error("Secure storage did not provide the bounded WAV header required for durable preparation."); const sourceByteLength = Number(headerResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]); if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the WAV source length required for durable preparation."); const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength); const wavFmtBase64 = Buffer.from(plan.fmtBytes).toString("base64"); return plan.ranges.map(range => ({ storageKey: narration.storageKey, sourceRange: { startByte: range.startByte, endByteExclusive: range.endByteExclusive, wavFmtBase64 }, startMs: range.startMs, endMs: range.endMs, contentStartMs: range.contentStartMs, contentEndMs: range.contentEndMs, byteSize: range.endByteExclusive - range.startByte + 28 + plan.fmtBytes.length, status: "pending" as const, attempts: 0 })); })() : []; const state: NarrationTranscriptionState = { version: 2, chunkOverlapMs: storedChunks.length > 1 ? 4_000 : 0, sourcePrepared: true, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: storedChunks }; await persistNarrationTranscriptionState(narration, state, db); return state; }  export async function transcribePreparedNarrationChunks(userId: number, narration: typeof mediaAssets.$inferSelect, narrationState: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>) { let transcriptionKey: { label: string; maskedKey: string } | null = null; for (let index = 0; index < narrationState.chunks.length; index += 1) { const chunk = narrationState.chunks[index]; if (chunk.status === "completed" && chunk.transcript) continue; chunk.status = "processing"; chunk.attempts += 1; narrationState.lastError = undefined; await persistNarrationTranscriptionState(narration, narrationState, db); try { const bytes = await loadNarrationChunkBytes(chunk); const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes; const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: wavBytes, filename: `narration-part-${index + 1}.wav`, mimeType: "audio/wav", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers.", timeoutMs: 120_000 }), key }));
      transcriptionKey ??= run.key;
      chunk.status = "completed";
      chunk.transcript = { text: run.value.text, language: run.value.language, segments: (run.value.segments ?? []).map(segment => ({ ...segment, start: segment.start + chunk.startMs / 1000, end: segment.end + chunk.startMs / 1000 })) };
      chunk.provider = { maskedKey: run.key.maskedKey, model: GROQ_TRANSCRIPTION_MODEL, durationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, category: run.value.requestMetadata.category };
      await persistNarrationTranscriptionState(narration, narrationState, db);
    } catch (error) {
      const safeError = error instanceof GroqRequestError || error instanceof GroqPoolExhaustedError ? error : null;
      const metadata = safeError?.metadata;
      chunk.status = error instanceof GroqRequestError && error.status === "quota_limited" ? "waiting" : "failed";
      chunk.provider = { maskedKey: transcriptionKey?.maskedKey ?? "Groq key", model: GROQ_TRANSCRIPTION_MODEL, durationMs: metadata?.durationMs ?? 0, httpStatus: metadata?.httpStatus, category: metadata?.category ?? "unknown" };
      narrationState.lastError = { category: metadata?.category ?? "unknown", message: safeError?.message ?? "Narration chunk transcription did not complete.", retryAfterMs: metadata?.retryAfterMs, httpStatus: metadata?.httpStatus, errorCode: metadata?.errorCode, remainingRequests: metadata?.remainingRequests, remainingAudio: metadata?.remainingAudio, resetAudio: metadata?.resetAudio, requestDurationMs: metadata?.durationMs ?? 0, occurredAtMs: Date.now() };
      await persistNarrationTranscriptionState(narration, narrationState, db);
      throw error;
    }
  }
  return { narrationState, transcriptionKey, transcription: { text: summarizeNarrationText(narrationState.chunks), language: narrationState.chunks.find(chunk => chunk.transcript?.language)?.transcript?.language, segments: mergeChunkTranscripts(narrationState.chunks) } };
}

export async function processProjectWithGlobalReadablePacing(userId: number, projectId: number, publicOrigin?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project.");
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const narration = assets.find(asset => asset.assetType === "narration");
  const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing.");
  const processingStartedAt = new Date();
  await db.update(projects).set({ status: "analyzing", workerState: "processing", processingStage: "transcribing", processingStartedAt, processingStageStartedAt: processingStartedAt }).where(eq(projects.id, projectId));
  try {
    const narrationState = await prepareNarrationChunks(projectId, narration, db);
    const narrationResult = await transcribePreparedNarrationChunks(userId, narration, narrationState, db);
    const { transcription, transcriptionKey } = narrationResult;
    const transcriptSegments = (transcription.segments ?? []).filter(segment => segment.text.trim());
    if (!transcriptSegments.length) throw new Error("Groq Whisper returned no timestamped narration segments.");
    await db.transaction(async transaction => {
      await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: "groq", model: GROQ_TRANSCRIPTION_MODEL, providerKeyLabel: transcriptionKey?.label ?? null, providerKeyMasked: transcriptionKey?.maskedKey ?? null, transcriptionState: narrationState, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
      await transaction.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    });
    const analyzedImageCache = await db.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed")));
    const analysisByContentHash = new Map(analyzedImageCache.filter(asset => asset.contentHash && asset.analysisJson).map(asset => [asset.contentHash!, asset.analysisJson as Record<string, unknown>]));
    const imageAnalyses = [] as Array<{ image: typeof images[number]; analysis: Record<string, unknown> }>;
    for (const image of images) {
      const cachedAnalysis = image.contentHash ? analysisByContentHash.get(image.contentHash) : null;
      if (cachedAnalysis && typeof cachedAnalysis.sceneDescription === "string" && cachedAnalysis.sceneDescription.trim()) {
        const analysis = { ...cachedAnalysis, sceneDescription: cachedAnalysis.sceneDescription.trim(), provider: "groq", model: GROQ_VISION_MODEL, reusedByContentHash: true };
        imageAnalyses.push({ image, analysis });
        await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
        continue;
      }
      const imageUrl = await boundedVisionImageUrl(image.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe visible actions, characters, emotions, objects, text, and environment in detail." }), key }));
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${image.originalFilename}.`);
      const analysis = { ...record, sceneDescription, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey };
      imageAnalyses.push({ image, analysis });
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
    }
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const visualCatalog = imageAnalyses.map(({ image, analysis }) => ({ sequence: image.sequenceNumber, scene: formatRichVisualScene(analysis) }));
    if (project.timelineSyncMode === "SEMANTIC_WEIGHTED") {
      const semantic = await collectSemanticAssignments(userId, visualCatalog, transcriptSegments, project.audioDurationMs);
      const rebuilt = buildSemanticRebuiltSegments(project.audioDurationMs, transcriptSegments, imageAnalyses.map(({ image, analysis }) => ({ id: image.id, sequence: image.sequenceNumber, scene: formatRichVisualScene(analysis) })), semantic.assignments, project.readableHoldMode ?? "MIN_2_SECONDS");
      const validation = validateTimeline(project.audioDurationMs, rebuilt);
      if (!validation.valid) throw new Error(`Generated semantic timeline failed validation: ${validation.issues.join(" ")}`);
      await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
      await db.transaction(async transaction => {
        await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
        await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, semanticProviderKeyLabel: semantic.providerKey?.label ?? null, semanticProviderKeyMasked: semantic.providerKey?.maskedKey ?? null, allImagesRequired: true, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: "semantic-transcript-boundary-weighted" } })));
        await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
        await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
      });
      return { imageCount: rebuilt.length, minimumDurationMs: project.readableHoldMode === "MIN_2_SECONDS" ? 2_200 : 0, validation };
    }
    const batches = buildBoundedPacingBatches(visualCatalog);
    const lines = splitTranscriptIntoSentenceLines(transcriptSegments);
    const anchors: number[] = [];
    const anchorHints: Array<number | null> = [];
    let pacingProviderKey: { label: string; maskedKey: string } | null = null;
    let cursorLine = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      let pacingRun: { value: unknown; key: { label: string; maskedKey: string } } | null = null;
      let batchAnchors: number[] = [];
      let batchHints: Array<number | null> = [];
      for (let qualityAttempt = 0; qualityAttempt <= MAX_ACTIVE_PACING_QUALITY_RETRIES; qualityAttempt += 1) {
        const prompt = buildDirectAnchorPacingPrompt({ batchIndex, batchCount: batches.length, batch, lines, cursorLine, audioDurationMs: project.audioDurationMs, imageCount: visualCatalog.length, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", corrective: qualityAttempt > 0 });
        const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt }), key }));
        const parsed = parseAndSanitizeAnchors(run.value, batch.length, lines.length, cursorLine);
        if (!parsed) {
          if (qualityAttempt === MAX_ACTIVE_PACING_QUALITY_RETRIES) throw new Error("Groq did not return a usable direct sentence-anchor plan.");
          continue;
        }
        pacingRun = run;
        batchAnchors = parsed.anchors;
        batchHints = parsed.hints;
        if (!parsed.lazy || qualityAttempt === MAX_ACTIVE_PACING_QUALITY_RETRIES) break;
        pacingRun = null;
      }
      if (!pacingRun) throw new Error("Groq did not return a usable direct sentence-anchor plan.");
      anchors.push(...batchAnchors);
      anchorHints.push(...batchHints);
      cursorLine = batchAnchors[batchAnchors.length - 1];
      pacingProviderKey = pacingRun.key;
    }
    const finalAnchors = sanitizeFinalAnchorSequence(project.audioDurationMs, lines, anchors);
    const anchorDurations = computeAnchorBoundaries(project.audioDurationMs, lines, finalAnchors, anchorHints);
    const minimumDurationMs = project.readableHoldMode === "MIN_2_SECONDS" ? MIN_READABLE_IMAGE_DURATION_MS : 0;
    let cursor = 0;
    const rebuilt = images.map((image, index) => {
      const startMs = cursor; const endMs = startMs + anchorDurations[index]; cursor = endMs;
      return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq locked image ${image.sequenceNumber} to transcript line ${finalAnchors[index]} with Direct Sentence Anchor: its start matches the exact spoken sentence timestamp, so sync drift can never accumulate across the ${images.length}-image narration.`, decisionType: "KEEP" as const };
    });
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
    if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`); await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId)); await db.transaction(async transaction => { await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId)); await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingProviderKey?.label ?? null, pacingProviderKeyMasked: pacingProviderKey?.maskedKey ?? null, allImagesRequired: true, minReadableDurationMs: minimumDurationMs, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: "direct-sentence-anchored" } }))); await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } }); await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId)); }); return { imageCount: rebuilt.length, minimumDurationMs, validation }; } catch (error) { await db.update(projects).set({ status: "failed", workerState: "error", processingStage: "failed", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId)); throw error; } }  export type TimelineGenerationWorkState = { preflightComplete?: boolean; firstDispatchAtMs?: number; pacingWeights?: number[]; pacingAnchors?: number[]; pacingAnchorHints?: Array<number | null>; nextPacingBatch?: number; pacingProviderKeyLabel?: string | null; pacingProviderKeyMasked?: string | null; pacingQualityRetries?: number; semanticAssignments?: SemanticAssignment[]; nextSemanticBatch?: number; semanticProviderKeyLabel?: string | null; semanticProviderKeyMasked?: string | null; };  export type TimelineGenerationSliceResult = { stage: "transcribing" | "analyzing_images" | "building_timeline" | "completed"; workState: TimelineGenerationWorkState; };  export function normalizeTimelineGenerationWorkState(value: unknown): TimelineGenerationWorkState { if (!value || typeof value !== "object") return {}; const record = value as Record<string, unknown>; return { preflightComplete: record.preflightComplete === true, firstDispatchAtMs: Number.isFinite(record.firstDispatchAtMs) ? Number(record.firstDispatchAtMs) : undefined, pacingWeights: Array.isArray(record.pacingWeights) ? record.pacingWeights.map(Number).filter(Number.isFinite) : [], pacingAnchors: Array.isArray(record.pacingAnchors) ? record.pacingAnchors.map(Number).filter(Number.isFinite) : [], pacingAnchorHints: Array.isArray(record.pacingAnchorHints) ? record.pacingAnchorHints.map(item => (Number.isFinite(item) && Number(item) > 0 ? Number(item) : null)) : [], nextPacingBatch: Number.isInteger(record.nextPacingBatch) && Number(record.nextPacingBatch) >= 0 ? Number(record.nextPacingBatch) : 0, pacingProviderKeyLabel: typeof record.pacingProviderKeyLabel === "string" ? record.pacingProviderKeyLabel : null, pacingProviderKeyMasked: typeof record.pacingProviderKeyMasked === "string" ? record.pacingProviderKeyMasked : null, pacingQualityRetries: Number.isInteger(record.pacingQualityRetries) && Number(record.pacingQualityRetries) >= 0 ? Number(record.pacingQualityRetries) : 0, semanticAssignments: Array.isArray(record.semanticAssignments) ? record.semanticAssignments.map(item => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { sequence: Number(value.sequence), segmentIndex: Number(value.segmentIndex), weight: Number(value.weight) }; }).filter(item => Number.isFinite(item.sequence) && Number.isFinite(item.segmentIndex) && Number.isFinite(item.weight)) : [], nextSemanticBatch: Number.isInteger(record.nextSemanticBatch) && Number(record.nextSemanticBatch) >= 0 ? Number(record.nextSemanticBatch) : 0, semanticProviderKeyLabel: typeof record.semanticProviderKeyLabel === "string" ? record.semanticProviderKeyLabel : null, semanticProviderKeyMasked: typeof record.semanticProviderKeyMasked === "string" ? record.semanticProviderKeyMasked : null, }; }  export async function processProjectTimelineSlice(userId: number, projectId: number, savedWorkState?: unknown): Promise<TimelineGenerationSliceResult> { const db = await getDb(); if (!db) throw new Error("Database storage is not available."); const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1); if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project."); const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId))); const narration = assets.find(asset => asset.assetType === "narration"); const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0)); if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing."); const workState = normalizeTimelineGenerationWorkState(savedWorkState);  if (narration.analysisState !== "analyzed") { const narrationState = await prepareNarrationChunks(projectId, narration, db); const nextChunkIndex = narrationState.chunks.findIndex(chunk => chunk.status !== "completed" || !chunk.transcript); if (nextChunkIndex >= 0) { const chunk = narrationState.chunks[nextChunkIndex]; chunk.status = "processing"; chunk.attempts += 1; chunk.lastAttemptAtMs = Date.now(); narrationState.lastError = undefined; await persistNarrationTranscriptionState(narration, narrationState, db); try { const bytes = await loadNarrationChunkBytes(chunk); const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes; const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: wavBytes, filename: `narration-part-${nextChunkIndex + 1}.wav`, mimeType: "audio/wav", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers.", timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
        chunk.status = "completed";
        chunk.transcript = { text: run.value.text, language: run.value.language, segments: (run.value.segments ?? []).map(segment => ({ ...segment, start: segment.start + chunk.startMs / 1000, end: segment.end + chunk.startMs / 1000 })) };
        chunk.provider = { maskedKey: run.key.maskedKey, model: GROQ_TRANSCRIPTION_MODEL, durationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, category: run.value.requestMetadata.category };
        await persistNarrationTranscriptionState(narration, narrationState, db);
        return { stage: "transcribing", workState };
      } catch (error) {
        const safeError = error instanceof GroqRequestError || error instanceof GroqPoolExhaustedError ? error : null;
        const metadata = safeError?.metadata;
        chunk.status = error instanceof GroqRequestError && error.status === "quota_limited" ? "waiting" : "failed";
        chunk.provider = { maskedKey: "Groq key", model: GROQ_TRANSCRIPTION_MODEL, durationMs: metadata?.durationMs ?? 0, httpStatus: metadata?.httpStatus, category: metadata?.category ?? "unknown" };
        const canAdaptivelySplit = !isMp3Narration(narration) && chunk.attempts >= ADAPTIVE_PCM_WAV_RANGE_SPLIT_AFTER_ATTEMPTS && (metadata?.category === "server_error" || metadata?.category === "timeout" || metadata?.category === "network_failure");
        const replacementChunks = canAdaptivelySplit ? splitRepeatedlyFailingPcmWavRange(chunk, narrationState.chunkOverlapMs) : null;
        if (replacementChunks) narrationState.chunks.splice(nextChunkIndex, 1, ...replacementChunks);
        narrationState.lastError = { category: metadata?.category ?? "unknown", message: replacementChunks ? "Groq did not complete this PCM WAV range repeatedly, so VisualSync safely divided only that pending range and will resume from its first child." : safeError?.message ?? "Narration chunk transcription did not complete.", retryAfterMs: metadata?.retryAfterMs, httpStatus: metadata?.httpStatus, errorCode: metadata?.errorCode, remainingRequests: metadata?.remainingRequests, remainingAudio: metadata?.remainingAudio, resetAudio: metadata?.resetAudio, requestDurationMs: metadata?.durationMs ?? 0, occurredAtMs: Date.now() };
        await persistNarrationTranscriptionState(narration, narrationState, db);
        throw error;
      }
    }
    const transcription = { text: summarizeNarrationText(narrationState.chunks), language: narrationState.chunks.find(chunk => chunk.transcript?.language)?.transcript?.language, segments: mergeChunkTranscripts(narrationState.chunks) };
    if (!transcription.segments.some(segment => segment.text.trim())) throw new Error("Groq Whisper returned no timestamped narration segments.");
    await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: "groq", model: GROQ_TRANSCRIPTION_MODEL, transcriptionState: narrationState, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
    await db.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    return { stage: "analyzing_images", workState };
  }

  const pendingImage = images.find(image => image.analysisState !== "analyzed");
  if (pendingImage) {
    const cachedAnalysis = (await db.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed")))).find(asset => asset.contentHash && asset.contentHash === pendingImage.contentHash && asset.analysisJson)?.analysisJson as Record<string, unknown> | undefined;
    if (cachedAnalysis && typeof cachedAnalysis.sceneDescription === "string" && cachedAnalysis.sceneDescription.trim()) {
      const analysis = { ...cachedAnalysis, sceneDescription: cachedAnalysis.sceneDescription.trim(), provider: "groq", model: GROQ_VISION_MODEL, reusedByContentHash: true };
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, pendingImage.id));
    } else {
      const imageUrl = await boundedVisionImageUrl(pendingImage.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe visible actions, characters, emotions, objects, text, and environment in detail.", timeoutMs: 60_000 }), key }), { maxAttempts: 1 });
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${pendingImage.originalFilename}.`);
      const nextAnalysis = { ...record, sceneDescription, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey };
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: nextAnalysis, embeddingSourceText: formatRichVisualScene(nextAnalysis) }).where(eq(mediaAssets.id, pendingImage.id));
    }
    return { stage: "analyzing_images", workState };
  }

  const refreshedAssets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const refreshedNarration = refreshedAssets.find(asset => asset.assetType === "narration");
  const refreshedImages = refreshedAssets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  const narrationJson = refreshedNarration?.analysisJson as { segments?: Array<{ start: number; end: number; text: string }> } | null;
  const transcriptSegments = (narrationJson?.segments ?? []).filter(segment => segment.text.trim());
  if (transcriptSegments.length === 0) throw new Error("Persisted narration transcript is unavailable for timeline construction.");
  const visualCatalog = refreshedImages.map(image => ({ sequence: image.sequenceNumber, scene: formatRichVisualScene(image.analysisJson as Record<string, unknown> | null) }));
  if (project.timelineSyncMode === "SEMANTIC_WEIGHTED") {
    const semanticBatches = buildBoundedPacingBatches(visualCatalog, MAX_SEMANTIC_IMAGES_PER_REQUEST);
    const nextSemanticBatch = workState.nextSemanticBatch ?? 0;
    if (nextSemanticBatch < semanticBatches.length) {
      await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
      const batch = semanticBatches[nextSemanticBatch];
      const priorAssignments = workState.semanticAssignments ?? [];
      const semanticRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeSemanticSyncPlan({ prompt: semanticSyncPrompt(batch, transcriptSegments, project.audioDurationMs!, priorAssignments), timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
      const batchAssignments = parseSemanticAssignments(semanticRun.value, batch, transcriptSegments, priorAssignments);
      assertSemanticBatchAssignments(batchAssignments, batch, transcriptSegments);
      return { stage: "building_timeline", workState: { ...workState, semanticAssignments: [...priorAssignments, ...batchAssignments], nextSemanticBatch: nextSemanticBatch + 1, semanticProviderKeyLabel: semanticRun.key.label, semanticProviderKeyMasked: semanticRun.key.maskedKey } };
    }
    const assignments = workState.semanticAssignments ?? [];
    const rebuilt = buildSemanticRebuiltSegments(project.audioDurationMs!, transcriptSegments, refreshedImages.map(image => ({ id: image.id, sequence: image.sequenceNumber, scene: formatRichVisualScene(image.analysisJson as Record<string, unknown> | null) })), assignments, project.readableHoldMode ?? "MIN_2_SECONDS");
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
    if (!validation.valid) throw new Error(`Generated semantic timeline failed validation: ${validation.issues.join(" ")}`);
    await db.transaction(async transaction => {
      await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
      await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, semanticProviderKeyLabel: workState.semanticProviderKeyLabel ?? null, semanticProviderKeyMasked: workState.semanticProviderKeyMasked ?? null, allImagesRequired: true, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: "semantic-transcript-boundary-weighted" } })));
      await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
      await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
    });
    return { stage: "completed", workState };
  }
  const lines = splitTranscriptIntoSentenceLines(transcriptSegments);
  const batches = buildBoundedPacingBatches(visualCatalog);
  const nextPacingBatch = workState.nextPacingBatch ?? 0;
  if (nextPacingBatch < batches.length) {
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const batch = batches[nextPacingBatch];
    const priorAnchors = workState.pacingAnchors ?? [];
    const cursorLine = priorAnchors.length ? priorAnchors[priorAnchors.length - 1] : 0;
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: nextPacingBatch, batchCount: batches.length, batch, lines, cursorLine, audioDurationMs: project.audioDurationMs, imageCount: visualCatalog.length, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", corrective: (workState.pacingQualityRetries ?? 0) > 0 });
    const pacingRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt, timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
    const parsed = parseAndSanitizeAnchors(pacingRun.value, batch.length, lines.length, cursorLine);
    if (!parsed || parsed.lazy) {
      const pacingQualityRetries = (workState.pacingQualityRetries ?? 0) + 1;
      if (pacingQualityRetries > MAX_ACTIVE_PACING_QUALITY_RETRIES) throw new Error("Groq did not return a usable direct sentence-anchor plan.");
      return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries } };
    }
    return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries: 0, pacingAnchors: [...priorAnchors, ...parsed.anchors], pacingAnchorHints: [...(workState.pacingAnchorHints ?? []), ...parsed.hints], nextPacingBatch: nextPacingBatch + 1, pacingProviderKeyLabel: pacingRun.key.label, pacingProviderKeyMasked: pacingRun.key.maskedKey } };
  }

  const savedAnchors = workState.pacingAnchors ?? [];
  const savedHints = workState.pacingAnchorHints ?? [];
  const legacyWeights = workState.pacingWeights ?? [];
  let minimumDurationMs = project.readableHoldMode === "MIN_2_SECONDS" ? MIN_READABLE_IMAGE_DURATION_MS : 0;
  let pacingMethod = "direct-sentence-anchored";
  let rebuilt: Array<{ imageAssetId: number; startMs: number; endMs: number; narrationText: string; confidence: number; selectionReason: string; decisionType: "KEEP" }>;
  if (savedAnchors.length === refreshedImages.length) {
    const finalAnchors = sanitizeFinalAnchorSequence(project.audioDurationMs, lines, savedAnchors);
    const anchorDurations = computeAnchorBoundaries(project.audioDurationMs, lines, finalAnchors, savedHints);
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + anchorDurations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq locked image ${image.sequenceNumber} to transcript line ${finalAnchors[index]} with Direct Sentence Anchor: its start matches the exact spoken sentence timestamp, so sync drift can never accumulate across the ${refreshedImages.length}-image narration.`, decisionType: "KEEP" as const }; });
  } else if (legacyWeights.length === refreshedImages.length) {
    const alignedWeights = alignOrderedWeightsToSpeechBoundaries(project.audioDurationMs, transcriptSegments, visualCatalog, batches, legacyWeights, project.readableHoldMode ?? "MIN_2_SECONDS");
    const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, alignedWeights, project.readableHoldMode ?? "MIN_2_SECONDS");
    minimumDurationMs = pacing.minimumDurationMs;
    pacingMethod = "bounded-global-full-narration-sequence";
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${legacyWeights[index]}. The ${project.readableHoldMode === "NO_MINIMUM" ? "no-minimum-hold mode applied no artificial duration floor" : `global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms`}.`, decisionType: "KEEP" as const }; });
  } else {
    const fallbackAnchors = fallbackProportionalAnchors(project.audioDurationMs, lines, refreshedImages.length);
    const fallbackDurations = computeAnchorBoundaries(project.audioDurationMs, lines, fallbackAnchors);
    pacingMethod = "sentence-boundary-fallback";
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + fallbackDurations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `VisualSync anchored image ${image.sequenceNumber} to the nearest spoken sentence boundary because the saved AI anchor plan was incomplete.`, decisionType: "KEEP" as const }; });
  }
  const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
  await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: workState.pacingProviderKeyLabel ?? null, pacingProviderKeyMasked: workState.pacingProviderKeyMasked ?? null, allImagesRequired: true, minReadableDurationMs: minimumDurationMs, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod } })));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
  });
  return { stage: "completed", workState };
}
