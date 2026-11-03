import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqRequestError } from "./groqClient";
import { getDb } from "./db";
import { executeWithGroqRotation, GroqPoolExhaustedError } from "./groqPool";
import { executeWithGeminiRotation, GeminiPoolExhaustedError } from "./geminiPool";
import { GeminiRequestError } from "./geminiClient";
import { isTranscriptionProviderId, isVisionSyncProviderId, type TranscriptionProviderId, type VisionSyncProviderId } from "./providerSelection";
import { DeepgramTranscriptionAdapter, LocalFasterWhisperAdapter, TranscriptionProviderError, localWhisperConfig, type ProviderTranscript, type TranscriptionAudioInput } from "./transcriptionProviders";
import { GEMINI_MODEL, type GeminiRequestMetadata } from "./geminiClient";
import { ABSOLUTE_MIN_IMAGE_DURATION_MS, buildGlobalReadableImageDurations, MIN_READABLE_IMAGE_DURATION_MS, resolveReadableMinimumDuration, type ReadableHoldMode } from "./readablePacing";
import { buildDirectAnchorPacingPrompt, buildPointAnchoredPacingItems, collectMissingPointNumbers, computeAnchorBoundaries, fallbackProportionalAnchors, formatPacingVisualScene, parseAndSanitizeAnchors, sanitizeFinalAnchorSequence, splitTranscriptIntoSentenceLines, type PacingBatchItem } from "./sentenceAnchors";
import { storageGetSignedUrl } from "./storage";
import { validateTimeline } from "./timelineValidation";
import { buildSemanticWeightedTimeline, type SemanticAssignment, type SemanticImage, type SemanticTranscriptSegment } from "./semanticTimeline";
import { makePcmWavChunk, planPcmWavTranscriptionRanges, SAFE_GROQ_DIRECT_WAV_BYTES, SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, scanMp3FrameRanges } from "./audioChunking";
import { mp3ToMonoWav } from "./audioTranscoding";
import { ADAPTIVE_PCM_WAV_RANGE_SPLIT_AFTER_ATTEMPTS, MAX_ALLOWED_INTERNAL_WORD_GAP_MS, mergeChunkTranscripts, readPacingTranscriptSegments, readNarrationTranscriptionState, recoverUnreliableNarrationChunks, shiftSegmentTimestamps, splitRepeatedlyFailingPcmWavRange, summarizeNarrationText, transcriptionWordGapQuality, type Mp3PreparationActiveChunk, type Mp3PreparationFrame, type Mp3PreparationState, type NarrationTranscriptionState, type PersistedNarrationChunk } from "./narrationTranscription";
import sharp from "sharp";

type TranscriptionProviderAdapterInstance = {
  id: TranscriptionProviderId;
  transcribe(input: TranscriptionAudioInput): Promise<ProviderTranscript>;
};

function createTranscriptionProviderAdapter(provider: TranscriptionProviderId): TranscriptionProviderAdapterInstance {
  if (provider === "DEEPGRAM_NOVA2") {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) throw new TranscriptionProviderError("Deepgram Nova-2 is selected, but no DEEPGRAM_API_KEY is configured on the server. Configure it in App Settings, or switch this project back to Groq Whisper.", provider, false, 400);
    return new DeepgramTranscriptionAdapter(apiKey);
  }
  if (provider === "LOCAL_FASTER_WHISPER") {
    const config = localWhisperConfig();
    if (!config) throw new TranscriptionProviderError("Local GPU (Faster-Whisper) is selected, but LOCAL_WHISPER_URL is not configured on the server. Configure the address, or switch this project back to Groq Whisper.", provider, false, 400);
    return new LocalFasterWhisperAdapter(config.url, config.token);
  }
  throw new TranscriptionProviderError("Unknown transcription provider.", provider, false, 400);
}

function maskProviderKeyLabel(keyId: string) {
  return keyId.length <= 8 ? "••••" : `${keyId.slice(0, 4)}…${keyId.slice(-4)}`;
}

function describeTranscriptionProviderModel(provider: TranscriptionProviderId) {
  if (provider === "GROQ_WHISPER") return GROQ_TRANSCRIPTION_MODEL;
  if (provider === "DEEPGRAM_NOVA2") return "nova-2";
  return "faster-whisper";
}

function providerKeyForTranscriptionProvider(provider: TranscriptionProviderId) {
  if (provider === "GROQ_WHISPER") return null;
  if (provider === "DEEPGRAM_NOVA2") {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) return null;
    return { label: "Deepgram key", maskedKey: maskProviderKeyLabel(apiKey) };
  }
  return { label: "Local GPU", maskedKey: "local-faster-whisper" };
}

type SingleShotTranscriptionResult = {
  providerId: TranscriptionProviderId;
  modelLabel: string;
  providerKey: { label: string; maskedKey: string } | null;
  durationMs: number;
  httpStatus?: number;
  category: string;
  text: string;
  language?: string;
  segments: ProviderTranscript["segments"];
};

async function transcribeNarrationChunkSingleShot(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">, chunk: PersistedNarrationChunk, provider: TranscriptionProviderId, index: number, timeoutMs: number): Promise<SingleShotTranscriptionResult> {
  const adapter = createTranscriptionProviderAdapter(provider);
  const bytes = await loadNarrationChunkBytes(chunk);
  const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes;
  const startedAtMs = Date.now();
  const transcript = await adapter.transcribe({
    bytes: wavBytes,
    mimeType: "audio/wav",
    filename: `narration-part-${index + 1}.wav`,
    language: "hi",
    timeoutMs,
  });
  return {
    providerId: provider,
    modelLabel: describeTranscriptionProviderModel(provider),
    providerKey: providerKeyForTranscriptionProvider(provider),
    durationMs: Date.now() - startedAtMs,
    category: "success",
    text: transcript.text,
    language: transcript.language,
    segments: transcript.segments,
  };
}

function recordSingleShotChunkTranscription(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">, chunk: PersistedNarrationChunk, result: SingleShotTranscriptionResult) {
  const segments = shiftSegmentTimestamps(result.segments ?? [], chunk.startMs / 1000);
  chunk.status = "completed";
  chunk.transcript = { text: result.text, language: result.language, segments };
  chunk.provider = { maskedKey: result.providerKey?.maskedKey ?? "provider key", model: result.modelLabel, durationMs: result.durationMs, httpStatus: result.httpStatus, category: result.category };
}

/** Deepgram Nova-2 and the local Faster-Whisper server have no practical length limit, so the WHOLE narration is sent in a single request (no 30s chunking). */
async function transcribeWholeNarrationSingleShot(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">, provider: TranscriptionProviderId, timeoutMs: number): Promise<SingleShotTranscriptionResult> {
  const adapter = createTranscriptionProviderAdapter(provider);
  const response = await fetchNarrationStorageRange(narration.storageKey);
  if (!response.ok) throw new Error("Narration could not be retrieved from secure storage for whole-file transcription.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes;
  const startedAtMs = Date.now();
  const transcript = await adapter.transcribe({ bytes: wavBytes, mimeType: "audio/wav", filename: "narration.wav", language: "hi", timeoutMs });
  return {
    providerId: provider,
    modelLabel: describeTranscriptionProviderModel(provider),
    providerKey: providerKeyForTranscriptionProvider(provider),
    durationMs: Date.now() - startedAtMs,
    category: "success",
    text: transcript.text,
    language: transcript.language,
    segments: transcript.segments,
  };
}

/** Groq keeps its 30s chunked transcription; single-shot providers get the whole file in one request. */
async function transcribeNarrationForProvider(userId: number, projectId: number, narration: typeof mediaAssets.$inferSelect, provider: TranscriptionProviderId, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>): Promise<{ narrationState: NarrationTranscriptionState; transcription: { text: string; language?: string; segments: ProviderTranscript["segments"] }; transcriptionKey: { label: string; maskedKey: string } | null }> {
  if (provider === "GROQ_WHISPER") {
    const narrationState = await prepareNarrationChunks(projectId, narration, db);
    const result = await transcribePreparedNarrationChunks(userId, narration, narrationState, db, provider);
    return { narrationState, transcription: result.transcription, transcriptionKey: result.transcriptionKey };
  }
  const singleShot = await transcribeWholeNarrationSingleShot(narration, provider, 600_000);
  const narrationState: NarrationTranscriptionState = { version: 2, chunkOverlapMs: 0, sourcePrepared: true, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: [] };
  return { narrationState, transcription: { text: singleShot.text, language: singleShot.language, segments: singleShot.segments }, transcriptionKey: singleShot.providerKey };
}

// ---------------------------------------------------------------- Vision & sync
// Phase 3–4: a project may use either Groq (existing) or Gemini Flash batch
// vision + global-context sync. Everything below is provider-agnostic over the
// same image catalog + transcript shape; only the LLM call and batch size differ.

export const GEMINI_BATCH_IMAGES_PER_REQUEST = 12;
// Semantic weighted sync does NOT batch for Gemini: Gemini's 1M-token input
// budget means the FULL image catalog + FULL transcript go in ONE request and
// only the small assignment JSON (within GEMINI_MAX_OUTPUT_TOKENS) comes back.
const GEMINI_MAX_OUTPUT_TOKENS = 8_192;

function visionSyncProviderModel(provider: VisionSyncProviderId) {
  return provider === "GEMINI_FLASH" ? GEMINI_MODEL : GROQ_VISION_MODEL;
}

type VisionProviderKey = { label: string; maskedKey: string };

/** Asks Gemini to analyze up to GEMINI_BATCH_IMAGES_PER_REQUEST inline images in ONE request. */
export function buildGeminiBatchImageAnalysisPrompt(count: number): string {
  return [
    `Analyze ${count} images for a narration-driven video.`,
    "Return ONLY a JSON object with a single \"images\" key whose value is a JSON array containing exactly one object per image, in the SAME order as the images were provided.",
    "Each object in the images array must contain only these string fields: sceneDescription, subjects, setting, mood, relevance.",
    "Describe visible actions, characters, emotions, objects, on-screen text, and environment in detail.",
    "Do not skip, merge, or reorder any image. Every image must produce exactly one object.",
    "Example shape: {\"images\":[{\"sceneDescription\":\"...\",\"subjects\":\"...\",\"setting\":\"...\",\"mood\":\"...\",\"relevance\":\"...\"}]}",
  ].join("\n");
}

/** Extracts the per-image array from either a bare JSON array or a single-key object wrapper. */
function extractBatchImageArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value as unknown[];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // Prefer the field the prompt names, then any common wrapper keys.
  for (const key of ["images", "analyses", "results", "result", "items", "batch"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  // Unexpected wrapper: fall back to the first array-valued property.
  for (const candidate of Object.values(record)) {
    if (Array.isArray(candidate)) return candidate as unknown[];
  }
  return null;
}

export function parseGeminiBatchImageAnalysis(value: unknown, count: number): Array<Record<string, unknown>> {
  const array = extractBatchImageArray(value);
  if (!array || array.length !== count) throw new Error(`Gemini returned ${array ? array.length : 0} image analyses for a ${count}-image batch.`);
  return array.map(item => (item && typeof item === "object" ? item as Record<string, unknown> : {}));
}

async function analyzeImagesWithGeminiBatch(userId: number, images: Array<{ sequence: number | null; filename: string; dataBase64: string }>): Promise<Array<{ analysis: Record<string, unknown>; key: VisionProviderKey }>> {
  const parts = images.map(image => ({ mimeType: "image/jpeg", dataBase64: image.dataBase64 }));
  const run = await executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.analyzeImageBatch(parts, buildGeminiBatchImageAnalysisPrompt(images.length), GEMINI_MAX_OUTPUT_TOKENS), key }));
  let records: Array<Record<string, unknown>>;
  try {
    records = parseGeminiBatchImageAnalysis(run.value, images.length);
  } catch (error) {
    // A short/malformed batch is transient provider behavior, not a terminal job
    // failure: surface it as retryable so the hosted job cools down and retries
    // instead of permanently failing the project.
    throw new GeminiRequestError(error instanceof Error ? error.message : "Gemini returned an unusable image batch.", "unavailable", { durationMs: 0, category: "server_error", model: run.key.label });
  }
  return records.map(analysis => ({ analysis, key: run.key }));
}

// Phase 4: the LLM may answer each image either as a full transcript-line index
// ({"line":<idx>,"i":<seq>}) or a wall-clock timestamp ({"t":"MM:SS","i":<seq>}).
// The parser accepts both — line-index primary, timestamp fallback — then every
// value is clamped into [cursorLine, lineCount-1] and monotonic.
export type PacingPlanItem = { line: number; i: number } | { t: string; i: number };

function parseTimecodeMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  return (hours * 3_600 + minutes * 60 + seconds) * 1_000;
}

/** Normalizes raw pacing-plan items ({"line"} | {"t"}) into an array of transcript-line indexes. */
export function normalizePacingPlanItems(raw: unknown, lineCount: number, cursorLine: number, durationMs: number, sequences?: Array<number | null>): number[] | null {
  const array = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { anchors?: unknown }).anchors) ? (raw as { anchors: unknown[] }).anchors : null);
  if (!array || array.length === 0) return null;
  const bySequence = new Map<number, number>();
  let usedFallback = false;
  for (const item of array) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!record) return null;
    // Hybrid Phase 4 shape: {"line":<idx>,"i":<seq>} (primary) or
    // {"t":"MM:SS","i":<seq>} (fallback). Also accepts the older Groq
    // {"sequence":<seq>,"line":<idx>} shape by treating sequence==i.
    const seq = Number(record.i ?? record.sequence);
    if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0 || bySequence.has(seq)) return null;
    let line: number;
    if (record.line !== undefined) {
      const parsed = Number(record.line);
      if (!Number.isFinite(parsed)) return null;
      line = parsed;
    } else if (record.t !== undefined) {
      const ms = parseTimecodeMs(record.t);
      if (ms === null) return null;
      const fraction = Math.max(0, Math.min(1, ms / Math.max(1, durationMs)));
      line = Math.round(fraction * (lineCount - 1));
      usedFallback = true;
    } else {
      return null;
    }
    bySequence.set(seq, Math.max(cursorLine, Math.min(lineCount - 1, Math.round(line))));
  }
  // When the caller supplies the expected sequence order (a mix of real numbers
  // and null placeholders for unlabeled images), trust its length and map every
  // slot through bySequence (null slot → nearest remaining sequence).
  const ordered = (sequences && sequences.length === array.length
    ? Array.from(bySequence.keys()).sort((a, b) => a - b)
    : Array.from(bySequence.keys()).sort((a, b) => a - b));
  if (ordered.length !== bySequence.size || ordered.length !== array.length) return null;
  const result: number[] = [];
  for (const seq of ordered) {
    const line = bySequence.get(seq);
    if (line === undefined) return null;
    result.push(line);
  }
  if (usedFallback) {
    // Timecode fallback may land on a line earlier than the cursor; clamp monotonic.
    let cursor = cursorLine;
    for (let index = 0; index < result.length; index += 1) {
      cursor = Math.max(cursor, Math.min(lineCount - 1, result[index]));
      result[index] = cursor;
    }
  }
  // A plan where every image maps onto a single line (or onto the cursor with
  // zero forward progress) is "crammed" — the caller should trigger the
  // corrective retry path instead of accepting it.
  const distinct = new Set(result).size;
  const lastLine = result[result.length - 1];
  if (distinct <= 1 || (result.length > 1 && lastLine === cursorLine)) return null;
  return result;
}

/** Builds the batch-vision prompt: up to 8 inline images + a shared narration header. */
export function buildGeminiBatchVisionPrompt(batch: Array<{ sequence: number | null; originalFilename?: string; scene: string }>, globalHeader: string) {
  const numbered = batch.map((item, index) => `IMAGE ${index + 1} (sequence ${item.sequence ?? "?"}, file ${item.originalFilename ?? "?"}): ${item.scene}`);
  return [
    "You are given a short narration header and a batch of images in strict upload order.",
    "For each image, return a compact scene description that a later sync step can match against the narration.",
    "Return ONLY a JSON array, one object per image, in the SAME order as the input.",
    "Each object must have: { \"seq\": number, \"scene\": string, \"subjects\": string, \"mood\": string, \"relevance\": string }.",
    "Do not invent image indices; echo back the sequence numbers exactly as given.",
    "",
    `NARRATION HEADER:\n${globalHeader}`,
    "",
    "IMAGE BATCH:",
    ...numbered,
  ].join("\n");
}

/** Normalizes a Gemini/Groq batch-vision JSON array back into the per-image analysis shape. */
export function parseBatchVisionResponse(value: unknown, batch: Array<{ sequence: number | null }>): Array<{ sequence: number | null; scene: string; record: Record<string, unknown> }> {
  let raw: unknown = value;
  if (raw && typeof raw === "object" && Array.isArray((raw as { images?: unknown }).images)) raw = (raw as { images: unknown }).images;
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const seq = Number(record.seq ?? record.sequence);
    const fallbackSeq = batch[index]?.sequence ?? null;
    const sequence = Number.isFinite(seq) ? Math.round(seq) : fallbackSeq;
    const scene = typeof record.scene === "string" ? record.scene.trim() : "";
    return { sequence, scene: scene || `Image ${batch[index]?.sequence ?? index + 1}`, record };
  });
}

type SemanticProviderKey = VisionProviderKey & { metadata?: GeminiRequestMetadata };

async function collectSemanticAssignmentsForProvider(userId: number, provider: VisionSyncProviderId, visualCatalog: Array<{ sequence: number | null; scene: string }>, transcriptSegments: SemanticTranscriptSegment[], audioDurationMs: number, timeoutMs = 60_000): Promise<{ assignments: SemanticAssignment[]; providerKey: VisionProviderKey | null }> {
  const isGemini = provider === "GEMINI_FLASH";
  // Gemini: send the FULL transcript every call (1M-token input budget) but emit
  // the assignment list in bounded output windows so each response stays under
  // the 8k output budget even for 1000+ images. Groq keeps a smaller batch to fit
  // its context window.
  const batches = buildBoundedPacingBatches(visualCatalog, isGemini ? MAX_GEMINI_SEMANTIC_OUTPUT_IMAGES : MAX_SEMANTIC_IMAGES_PER_REQUEST);
  const assignments: SemanticAssignment[] = [];
  let providerKey: VisionProviderKey | null = null;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const prompt = semanticSyncPrompt(batch, transcriptSegments, audioDurationMs, assignments, isGemini);
    const run = provider === "GEMINI_FLASH"
      ? await executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(prompt, [], GEMINI_MAX_OUTPUT_TOKENS), key }))
      : await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeSemanticSyncPlan({ prompt, timeoutMs }), key }));
    const batchAssignments = parseSemanticAssignments(run.value, batch, transcriptSegments, assignments);
    assertSemanticBatchAssignments(batchAssignments, batch, transcriptSegments);
    assignments.push(...batchAssignments);
    providerKey = { label: run.key.label, maskedKey: run.key.maskedKey };
  }
  return { assignments, providerKey };
}

async function completePacingPlanForProvider(userId: number, provider: VisionSyncProviderId, prompt: string, timeoutMs?: number): Promise<{ value: unknown; key: VisionProviderKey }> {
  if (provider === "GEMINI_FLASH") {
    return executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(prompt, [], 5_000), key }));
  }
  return executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt, timeoutMs }), key }));
}

function transcriptForRange(segments: Array<{ start: number; end: number; text: string }>, startMs: number, endMs: number) {
  const text = segments.filter(segment => segment.end * 1000 > startMs && segment.start * 1000 < endMs).map(segment => segment.text.trim()).filter(Boolean).join(" ");
  return text || segments.at(-1)?.text.trim() || "Narration visual sequence";
}

const MAX_PACING_IMAGES_PER_REQUEST = 24;
const MAX_SEMANTIC_IMAGES_PER_REQUEST = 20;
/**
 * Gemini gets the FULL transcript every call (1M-token input budget) but its
 * OUTPUT budget is only 8k tokens, so the assignment list is emitted in windows.
 * ~100 assignments (≈6k tokens of JSON) leaves comfortable headroom under 8k.
 */
const MAX_GEMINI_SEMANTIC_OUTPUT_IMAGES = 100;
const MAX_PACING_NARRATION_CHARACTERS = 16000;
const NARRATION_SOURCE_PREPARATION_VERSION = 8;
const MP3_PREPARATION_SCAN_BYTES = 256 * 1024;
const MP3_OVERLAP_BYTE_BUDGET = Math.floor(SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES * 0.25);
const MP3_TARGET_CHUNK_DURATION_MS = 60_000;
const MP3_MAX_CHUNK_BYTES = 1_536 * 1024;
const MP3_OVERLAP_DURATION_MS = 4_000;
const HOSTED_STORAGE_READ_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_PACING_QUALITY_RETRIES = 1;
const MAX_VISUAL_CATALOG_SCENE_CHARS = 300;
const ORDERED_PACING_PLAN_VERSION = 3;

/** Old anchors must not index a recovered or re-transcribed word-boundary grid. */
export function prepareOrderedPacingWorkState(state: TimelineGenerationWorkState): TimelineGenerationWorkState {
  if (state.pacingPlanVersion === ORDERED_PACING_PLAN_VERSION) return state;
  return { ...state, pacingPlanVersion: ORDERED_PACING_PLAN_VERSION, pacingAnchors: [], pacingAnchorHints: [], pacingWeights: [], nextPacingBatch: 0, pacingQualityRetries: 0, pacingProviderKeyLabel: null, pacingProviderKeyMasked: null };
}

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
 * Translates the fine word-boundary narration lines from Hindi/Hinglish to
 * English so image scenes (English) and narration (English) are matched in the
 * SAME language. Cross-lingual matching at fine granularity scatters images and
 * lets Gemini fall back to image order (which follows the filename); matching by
 * meaning alone keeps the result identical even when files are renamed.
 */
function translationPrompt(lines: SemanticTranscriptSegment[]): string {
  const payload = lines.map((line, index) => ({ index, text: line.text.trim() }));
  return `Translate each timestamped narration line from Hindi/Hinglish into clear English. Keep every number, percentage, and English loanword (grocery, petrol, medical, school, percent) unchanged. Translate the meaning exactly; do not summarize, merge, or reorder lines. Reply only with JSON {"translations":[{"index":number,"text":"string"}]} containing exactly one entry for every supplied index (${lines.length} total). Lines: ${JSON.stringify(payload)}`;
}

export function parseLineTranslations(value: unknown, lines: SemanticTranscriptSegment[]): SemanticTranscriptSegment[] {
  const raw = value && typeof value === "object" && Array.isArray((value as { translations?: unknown }).translations)
    ? (value as { translations: unknown[] }).translations
    : [];
  const byIndex = new Map<number, string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (Number.isInteger(index) && index >= 0 && index < lines.length && text) byIndex.set(index, text);
  }
  // Any line the model skipped keeps its original text, so a partial translation
  // degrades gracefully to cross-lingual matching instead of hard-failing.
  return lines.map((line, index) => ({ ...line, text: byIndex.get(index) ?? line.text.trim() }));
}

async function translateSemanticLinesToEnglish(userId: number, provider: VisionSyncProviderId, lines: SemanticTranscriptSegment[]): Promise<SemanticTranscriptSegment[]> {
  if (!lines.length) return lines;
  // Gemini translates the whole grid in one request; Groq's structured JSON has
  // a small output budget so it is translated in small chunks (via the
  // completeSemanticSyncPlan path, which has a 1500-token budget and a tolerant
  // JSON extractor).
  const chunks = buildBoundedPacingBatches(lines, provider === "GEMINI_FLASH" ? lines.length : 15);
  const translated: SemanticTranscriptSegment[] = [];
  for (const chunk of chunks) {
    const prompt = translationPrompt(chunk);
    const run = provider === "GEMINI_FLASH"
      ? await executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(prompt, [], GEMINI_MAX_OUTPUT_TOKENS), key }))
      : await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeSemanticSyncPlan({ prompt, timeoutMs: 20_000 }), key }));
    translated.push(...parseLineTranslations(unwrapSemanticPlanValue(run.value), chunk));
  }
  return translated;
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
  useFullContext = false,
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
  if (!useFullContext && fullJson.length > MAX_PACING_NARRATION_CHARACTERS) {
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
  return `Map every image in this batch to the most semantically relevant timestamped narration segment across the entire narration. Any image can match any timestamped segment from 0 ms to ${audioDurationMs} ms based on its visible meaning, not its filename or numeric order. Prefer segments with used=0 when semantic relevance is similar so images do not pile up on a single sentence. Assign each image to its best matching segment; only OMIT an image when it has no meaningful connection to any narration segment (for example a duplicate, a broken image, or content never mentioned in the narration). Do not invent a placement for an unrelated image. Reply only with JSON {"assignments":[{"imageSequence":number,"transcriptSegmentIndex":number,"weight":number}]}. Return at most one assignment per image, never duplicate an image, use only the supplied transcriptSegmentIndex values, and use positive weights from 0.5 to 3.0. Full narration duration is ${audioDurationMs} ms. Timestamped narration segments: ${JSON.stringify(selectedTranscript)}. Image batch: ${JSON.stringify(batch)}`;
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
  const bySequence = new Map<number, SemanticAssignment>();
  for (const item of parsed) {
    if (!bySequence.has(item.sequence)) {
      const clampedSegment = Math.max(0, Math.min(totalSegments - 1, Math.round(item.segmentIndex)));
      const clampedWeight = Number.isFinite(item.weight) && item.weight > 0 ? Math.min(3.0, Math.max(0.5, item.weight)) : 1.0;
      bySequence.set(item.sequence, { sequence: item.sequence, segmentIndex: clampedSegment, weight: clampedWeight });
    }
  }

  // Return ONLY what the model actually assigned. Images the model omitted are
  // intentionally skipped (never force-filled), so an unrelated image does not
  // get jammed onto a wrong narration line just to satisfy a coverage rule.
  return Array.from(bySequence.values());
}

function assertSemanticBatchAssignments(assignments: SemanticAssignment[], batch: Array<{ sequence: number | null; scene: string }>, transcriptSegments: SemanticTranscriptSegment[]) {
  const expected = new Set(batch.map(item => item.sequence));
  const seen = new Set<number>();
  for (const item of assignments) {
    if (!expected.has(item.sequence)) throw new Error("Provider returned an assignment for an image that is not in this batch.");
    if (seen.has(item.sequence)) throw new Error("Provider assigned one image more than once in a batch.");
    if (!Number.isInteger(item.segmentIndex) || item.segmentIndex < 0 || item.segmentIndex >= transcriptSegments.length || !Number.isFinite(item.weight) || item.weight <= 0) throw new Error("Provider returned an invalid semantic transcript assignment.");
    seen.add(item.sequence);
  }
  // Subset is allowed: the provider may omit images it has no confident match for.
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
  return `data:image/jpeg;base64,${preview.toString("base64")}`; }  async function fetchNarrationStorageRange(storageKey: string, range?: string) { const controller = new AbortController(); const startedAtMs = Date.now(); const timeout = setTimeout(() => controller.abort(), HOSTED_STORAGE_READ_TIMEOUT_MS); try { const url = await storageGetSignedUrl(storageKey, controller.signal); return await fetch(url, { ...(range ? { headers: { Range: range } } : {}), signal: controller.signal }); } catch (error) { const durationMs = Date.now() - startedAtMs; if (controller.signal.aborted) throw new GroqRequestError("Secure storage timed out while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "timeout" }); throw new GroqRequestError("Secure storage was temporarily unavailable while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "network_failure" }); } finally { clearTimeout(timeout); } }  async function loadNarrationChunkBytes(chunk: PersistedNarrationChunk) { const response = await fetchNarrationStorageRange(chunk.storageKey, chunk.sourceRange ? `bytes=${chunk.sourceRange.startByte}-${chunk.sourceRange.endByteExclusive - 1}` : undefined); if (!response.ok) throw new Error("Prepared narration chunk could not be retrieved from secure storage."); if (chunk.sourceRange && response.status !== 206) throw new Error("Secure storage did not honor the bounded WAV byte-range request."); const bytes = new Uint8Array(await response.arrayBuffer()); return chunk.sourceRange?.wavFmtBase64 ? makePcmWavChunk(new Uint8Array(Buffer.from(chunk.sourceRange.wavFmtBase64, "base64")), bytes) : bytes; }  async function persistNarrationTranscriptionState(narration: typeof mediaAssets.$inferSelect, state: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>) { await db.update(mediaAssets).set({ analysisJson: { ...(narration.analysisJson && typeof narration.analysisJson === "object" ? narration.analysisJson as Record<string, unknown> : {}), transcriptionState: state } }).where(eq(mediaAssets.id, narration.id)); }  // No prompt is passed to Whisper: an English "preserve Hindi/Hinglish/financial terms"
  // prompt measurably degraded whisper-large-v3 decoding on Hindi narrations (deterministic
  // 207→84 words with a 20.7 s internal hole in A/B tests of the same audio at temperature 0).
  // The word-gap quality gate plus the "…" sentence fallback already cover bad runs.
  async function transcribeNarrationChunkBytes(userId: number, wavBytes: Uint8Array, partIndex: number, timeoutMs: number, maxAttempts?: number) { const options = maxAttempts !== undefined ? { maxAttempts } : undefined; return executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: wavBytes, filename: `narration-part-${partIndex + 1}.wav`, mimeType: "audio/wav", language: "hi", timeoutMs }), key }), options); }  export function isWavNarration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) { return narration.mimeType === "audio/wav" || narration.mimeType === "audio/x-wav" || narration.storageKey.toLowerCase().endsWith(".wav"); }  function isMp3Narration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) { return narration.mimeType === "audio/mpeg" || narration.storageKey.toLowerCase().endsWith(".mp3"); }  export async function prepareNarrationChunks(projectId: number, narration: typeof mediaAssets.$inferSelect, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>): Promise<NarrationTranscriptionState> { const saved = readNarrationTranscriptionState(narration.analysisJson); const cached = saved ? recoverUnreliableNarrationChunks(saved) : null; const wavNarration = isWavNarration(narration); if (cached && cached !== saved) { cached.sourcePreparationVersion = NARRATION_SOURCE_PREPARATION_VERSION; await persistNarrationTranscriptionState(narration, cached, db); return cached; } if (cached?.sourcePrepared && cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION) return cached; if (cached?.sourcePrepared && cached.chunks.some(chunk => chunk.status === "completed" && chunk.transcript)) return cached; if (!isMp3Narration(narration) && !wavNarration) throw new Error("This narration must be uploaded as WAV or MP3 for automatic safe transcription chunking."); if (isMp3Narration(narration)) { const repairedCached = recoverLegacyInflatedMp3Preparation(cached); const resumableCached = repairedCached && (repairedCached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || repairedCached.chunks.some(chunk => chunk.status === "completed" && chunk.transcript)) ? repairedCached : null; const state: NarrationTranscriptionState = resumableCached ?? { version: 2, chunkOverlapMs: 0, sourcePrepared: false, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: [], mp3Preparation: { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] } }; const preparation = state.mp3Preparation ?? { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] }; state.mp3Preparation = preparation; state.sourcePrepared = false; state.sourcePreparationVersion = NARRATION_SOURCE_PREPARATION_VERSION; await persistNarrationTranscriptionState(narration, state, db); const sourceResponse = await fetchNarrationStorageRange(narration.storageKey, `bytes=${preparation.nextByteOffset}-${preparation.nextByteOffset + MP3_PREPARATION_SCAN_BYTES - 1}`); if (!sourceResponse.ok || sourceResponse.status !== 206) throw new Error("Secure storage did not provide the bounded MP3 range required for durable preparation."); const sourceByteLength = Number(sourceResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]); if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the MP3 source length required for durable preparation."); preparation.sourceByteLength = sourceByteLength; const scanned = scanMp3FrameRanges(new Uint8Array(await sourceResponse.arrayBuffer()), preparation.nextByteOffset, preparation.nextTimestampMs); if (!scanned.frames.length && scanned.nextByteOffset <= preparation.nextByteOffset) throw new Error("MP3 preparation could not find a complete frame in the bounded source range."); preparation.nextByteOffset = scanned.nextByteOffset; preparation.nextTimestampMs = scanned.nextTimestampMs; advanceMp3Preparation(state, narration.storageKey, preparation, scanned.frames); if (preparation.nextByteOffset >= sourceByteLength) { if (preparation.activeChunk) state.chunks.push(mp3PreparationChunk(preparation.activeChunk, narration.storageKey)); state.sourcePrepared = true; delete state.mp3Preparation; state.chunkOverlapMs = state.chunks.length > 1 ? 4_000 : 0; } await persistNarrationTranscriptionState(narration, state, db); return state; } const storedChunks: PersistedNarrationChunk[] = wavNarration ? await (async () => { const headerResponse = await fetchNarrationStorageRange(narration.storageKey, "bytes=0-65535"); if (!headerResponse.ok || headerResponse.status !== 206) throw new Error("Secure storage did not provide the bounded WAV header required for durable preparation."); const sourceByteLength = Number(headerResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]); if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the WAV source length required for durable preparation."); const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength); const wavFmtBase64 = Buffer.from(plan.fmtBytes).toString("base64"); return plan.ranges.map(range => ({ storageKey: narration.storageKey, sourceRange: { startByte: range.startByte, endByteExclusive: range.endByteExclusive, wavFmtBase64 }, startMs: range.startMs, endMs: range.endMs, contentStartMs: range.contentStartMs, contentEndMs: range.contentEndMs, byteSize: range.endByteExclusive - range.startByte + 28 + plan.fmtBytes.length, status: "pending" as const, attempts: 0 })); })() : []; const state: NarrationTranscriptionState = { version: 2, chunkOverlapMs: storedChunks.length > 1 ? 4_000 : 0, sourcePrepared: true, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: storedChunks }; await persistNarrationTranscriptionState(narration, state, db); return state; }  export async function transcribePreparedNarrationChunks(userId: number, narration: typeof mediaAssets.$inferSelect, narrationState: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>, transcriptionProvider: TranscriptionProviderId = "GROQ_WHISPER") { let transcriptionKey: { label: string; maskedKey: string } | null = null; for (let index = 0; index < narrationState.chunks.length; index += 1) { const chunk = narrationState.chunks[index]; if (chunk.status === "completed" && chunk.transcript) continue; chunk.status = "processing"; chunk.attempts += 1; narrationState.lastError = undefined; await persistNarrationTranscriptionState(narration, narrationState, db); if (transcriptionProvider !== "GROQ_WHISPER") { try { const singleShot = await transcribeNarrationChunkSingleShot(narration, chunk, transcriptionProvider, index, 180_000); recordSingleShotChunkTranscription(narration, chunk, singleShot); transcriptionKey = providerKeyForTranscriptionProvider(transcriptionProvider); await persistNarrationTranscriptionState(narration, narrationState, db); continue; } catch (error) { if (error instanceof TranscriptionProviderError) { chunk.status = "failed"; chunk.provider = { maskedKey: providerKeyForTranscriptionProvider(transcriptionProvider)?.maskedKey ?? "provider key", model: describeTranscriptionProviderModel(transcriptionProvider), durationMs: 0, httpStatus: error.httpStatus, category: "unknown" }; narrationState.lastError = { category: "unknown", message: error.message, httpStatus: error.httpStatus, requestDurationMs: 0, occurredAtMs: Date.now() }; await persistNarrationTranscriptionState(narration, narrationState, db); throw error; } throw error; } } try { const bytes = await loadNarrationChunkBytes(chunk); const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes; const first = await transcribeNarrationChunkBytes(userId, wavBytes, index, 180_000); transcriptionKey ??= first.key; let selected = first; const firstQuality = transcriptionWordGapQuality(shiftSegmentTimestamps(first.value.segments ?? [], chunk.startMs / 1000), chunk);
      if (firstQuality.needsRecovery) {
        const children = splitRepeatedlyFailingPcmWavRange(chunk, 2_000, 5_000);
        if (children) { narrationState.chunks.splice(index, 1, ...children); await persistNarrationTranscriptionState(narration, narrationState, db); index -= 1; continue; }
        if (chunk.attempts < 2) {
          chunk.attempts += 1;
          const retry = await transcribeNarrationChunkBytes(userId, wavBytes, index, 180_000);
          const retryQuality = transcriptionWordGapQuality(shiftSegmentTimestamps(retry.value.segments ?? [], chunk.startMs / 1000), chunk);
          const score = (q: typeof firstQuality) => Math.max(q.largestGapMs, q.largestWordDurationMs, q.outOfRangeMs);
          if (!retryQuality.needsRecovery || score(retryQuality) < score(firstQuality) || (score(retryQuality) === score(firstQuality) && retryQuality.wordCount > firstQuality.wordCount)) selected = retry;
        }
      }
      chunk.status = "completed";
      chunk.transcript = { text: selected.value.text, language: selected.value.language, segments: shiftSegmentTimestamps(selected.value.segments ?? [], chunk.startMs / 1000) };
      chunk.provider = { maskedKey: selected.key.maskedKey, model: GROQ_TRANSCRIPTION_MODEL, durationMs: selected.value.requestMetadata.durationMs, httpStatus: selected.value.requestMetadata.httpStatus, category: selected.value.requestMetadata.category };
      await persistNarrationTranscriptionState(narration, narrationState, db);
    } catch (error) {
      if (error instanceof TranscriptionProviderError) {
        chunk.status = "failed";
        chunk.provider = { maskedKey: transcriptionKey?.maskedKey ?? "provider key", model: describeTranscriptionProviderModel("DEEPGRAM_NOVA2"), durationMs: 0, httpStatus: error.httpStatus, category: "unknown" };
        narrationState.lastError = { category: "unknown", message: error.message, httpStatus: error.httpStatus, requestDurationMs: 0, occurredAtMs: Date.now() };
        await persistNarrationTranscriptionState(narration, narrationState, db);
      }
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

export async function processProjectWithGlobalReadablePacing(userId: number, projectId: number, publicOrigin?: string, visionProvider?: VisionSyncProviderId) {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  const resolvedVisionProvider: VisionSyncProviderId = visionProvider ?? (isVisionSyncProviderId(project.visionSyncProvider) ? project.visionSyncProvider : "GROQ");
  if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project.");
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const narration = assets.find(asset => asset.assetType === "narration");
  const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing.");
  const processingStartedAt = new Date();
  await db.update(projects).set({ status: "analyzing", workerState: "processing", processingStage: "transcribing", processingStartedAt, processingStageStartedAt: processingStartedAt }).where(eq(projects.id, projectId));
  try {
    const projectTranscriptionProvider: TranscriptionProviderId = isTranscriptionProviderId(project.transcriptionProvider) ? project.transcriptionProvider : "GROQ_WHISPER";
    const narrationResult = await transcribeNarrationForProvider(userId, projectId, narration, projectTranscriptionProvider, db);
    const { transcription, transcriptionKey, narrationState } = narrationResult;
    const transcriptSegments = (transcription.segments ?? []).filter(segment => segment.text.trim());
    if (!transcriptSegments.length) throw new Error(`Transcription (${describeTranscriptionProviderModel(projectTranscriptionProvider)}) returned no timestamped narration segments.`);
    await db.transaction(async transaction => {
      await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: projectTranscriptionProvider === "GROQ_WHISPER" ? "groq" : projectTranscriptionProvider.toLowerCase(), model: describeTranscriptionProviderModel(projectTranscriptionProvider), providerKeyLabel: transcriptionKey?.label ?? null, providerKeyMasked: transcriptionKey?.maskedKey ?? null, transcriptionState: narrationState, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
      await transaction.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    });
    const analyzedImageCache = await db.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed")));
    const analysisByContentHash = new Map(analyzedImageCache.filter(asset => asset.contentHash && asset.analysisJson).map(asset => [asset.contentHash!, asset.analysisJson as Record<string, unknown>]));
    const imageAnalyses = new Array<{ image: typeof images[number]; analysis: Record<string, unknown> }>(images.length);
    const visionProviderLabel = resolvedVisionProvider === "GEMINI_FLASH" ? "gemini" : "groq";
    const visionModelLabel = resolvedVisionProvider === "GEMINI_FLASH" ? GEMINI_MODEL : GROQ_VISION_MODEL;
    const visionImagePrompt = "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe visible actions, characters, emotions, objects, text, and environment in detail.";
    const pendingSlots: Array<{ index: number; image: typeof images[number] }> = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const cachedAnalysis = image.contentHash ? analysisByContentHash.get(image.contentHash) : null;
      if (cachedAnalysis && typeof cachedAnalysis.sceneDescription === "string" && cachedAnalysis.sceneDescription.trim()) {
        const analysis = { ...cachedAnalysis, sceneDescription: cachedAnalysis.sceneDescription.trim(), provider: "groq", model: GROQ_VISION_MODEL, reusedByContentHash: true };
        imageAnalyses[index] = { image, analysis };
        await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
      } else {
        pendingSlots.push({ index, image });
      }
    }
    if (resolvedVisionProvider === "GEMINI_FLASH") {
      // Batch up to 12 inline images per Gemini call (1M-token input budget).
      const batches = buildBoundedPacingBatches(pendingSlots, GEMINI_BATCH_IMAGES_PER_REQUEST);
      for (const batch of batches) {
        const loaded = await Promise.all(batch.map(async ({ index, image }) => ({ index, image, dataBase64: (await boundedVisionImageUrl(image.storageKey)).split(",")[1] ?? "" })));
        const results = await analyzeImagesWithGeminiBatch(userId, loaded.map(({ image, dataBase64 }) => ({ sequence: image.sequenceNumber, filename: image.originalFilename, dataBase64 })));
        for (let position = 0; position < loaded.length; position += 1) {
          const { index, image } = loaded[position];
          const { analysis: rawAnalysis, key } = results[position];
          const sceneDescription = typeof rawAnalysis.sceneDescription === "string" ? rawAnalysis.sceneDescription.trim() : "";
          if (!sceneDescription) throw new Error(`Gemini returned no usable scene description for ${image.originalFilename}.`);
          const analysis = { ...rawAnalysis, sceneDescription, provider: visionProviderLabel, model: visionModelLabel, providerKeyLabel: key.label, providerKeyMasked: key.maskedKey };
          imageAnalyses[index] = { image, analysis };
          await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
        }
      }
    } else {
      for (const { index, image } of pendingSlots) {
        const imageUrl = await boundedVisionImageUrl(image.storageKey);
        const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: visionImagePrompt }), key }));
        const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
        const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
        if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${image.originalFilename}.`);
        const analysis = { ...record, sceneDescription, provider: visionProviderLabel, model: visionModelLabel, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey };
        imageAnalyses[index] = { image, analysis };
        await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
      }
    }
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const visualCatalog = imageAnalyses.map(({ image, analysis }) => ({ sequence: image.sequenceNumber, scene: formatRichVisualScene(analysis) }));
    if (project.timelineSyncMode === "SEMANTIC_WEIGHTED") {
      const semanticLines = splitTranscriptIntoSentenceLines(transcriptSegments);
      // Translate the fine word-boundary lines to English so image scenes
      // (English) and narration (English) are matched in the same language.
      // Cross-lingual matching at fine granularity scatters images and lets
      // Gemini lean on image order (which follows the filename); English↔English
      // lets it match by meaning alone, so renaming files cannot change the
      // result. Images are anchored directly to English fine lines.
      const englishLines = await translateSemanticLinesToEnglish(userId, resolvedVisionProvider, semanticLines);
      const semantic = await collectSemanticAssignmentsForProvider(userId, resolvedVisionProvider, visualCatalog, englishLines, project.audioDurationMs);
      const rebuilt = buildSemanticRebuiltSegments(project.audioDurationMs, semanticLines, imageAnalyses.map(({ image, analysis }) => ({ id: image.id, sequence: image.sequenceNumber, scene: formatRichVisualScene(analysis) })), semantic.assignments, project.readableHoldMode ?? "MIN_2_SECONDS");
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
    const orderedCatalog = imageAnalyses.map(({ image, analysis }, index) => ({ sequence: image.sequenceNumber ?? index + 1, originalFilename: image.originalFilename, scene: formatPacingVisualScene(analysis) }));
    const pacingItems = buildPointAnchoredPacingItems(orderedCatalog);
    const pacingCatalog: PacingBatchItem[] = pacingItems ?? orderedCatalog.map(({ sequence, scene }) => ({ sequence, scene, point: null }));
    const missingPoints = pacingItems ? collectMissingPointNumbers(pacingItems) : [];
    const batches = buildBoundedPacingBatches(pacingCatalog);
    const lines = splitTranscriptIntoSentenceLines(transcriptSegments);
    const anchors: number[] = [];
    const anchorHints: Array<number | null> = [];
    let pacingProviderKey: { label: string; maskedKey: string } | null = null;
    let cursorLine = 0;
    let pacingRescued = false;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      let pacingRun: { value: unknown; key: { label: string; maskedKey: string } } | null = null;
      let batchAnchors: number[] = [];
      let batchHints: Array<number | null> = [];
      for (let qualityAttempt = 0; qualityAttempt <= MAX_ACTIVE_PACING_QUALITY_RETRIES; qualityAttempt += 1) {
        let parsed = null as ReturnType<typeof parseAndSanitizeAnchors>;
        try {
          const prompt = buildDirectAnchorPacingPrompt({ batchIndex, batchCount: batches.length, batch, lines, cursorLine, audioDurationMs: project.audioDurationMs, imageCount: visualCatalog.length, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", corrective: qualityAttempt > 0, missingPoints, previousImage: batches[batchIndex - 1]?.at(-1) });
          const run = resolvedVisionProvider === "GEMINI_FLASH"
            ? await executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(prompt, [], GEMINI_MAX_OUTPUT_TOKENS), key }))
            : await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt }), key }));
          const normalized = normalizePacingPlanItems(run.value, lines.length, cursorLine, project.audioDurationMs!, batch.map(item => item.sequence));
          parsed = normalized
            ? { anchors: normalized, hints: [], lazy: false }
            : parseAndSanitizeAnchors(run.value, batch.length, lines.length, cursorLine, batch.map(item => item.sequence));
          if (parsed) pacingRun = run;
        } catch (error) {
          // Only the model's own unusable output is rescued here; transient API
          // failures (429/timeout/network) keep propagating to the scheduler.
          if (!(error instanceof GroqRequestError) || error.metadata?.category !== "client_request") throw error;
        }
        if (!parsed || parsed.lazy) {
          if (qualityAttempt === MAX_ACTIVE_PACING_QUALITY_RETRIES) { pacingRescued = true; break; }
          continue;
        }
        batchAnchors = parsed.anchors;
        batchHints = parsed.hints;
        break;
      }
      if (pacingRescued) break;
      if (!pacingRun) throw new Error("Groq did not return a usable direct sentence-anchor plan.");
      anchors.push(...batchAnchors);
      anchorHints.push(...batchHints);
      cursorLine = batchAnchors[batchAnchors.length - 1];
      pacingProviderKey = pacingRun.key;
    }
    const acceptedAnchorCount = anchors.length;
    const finalAnchors = pacingRescued
      ? fallbackProportionalAnchors(project.audioDurationMs, lines, images.length, anchors)
      : sanitizeFinalAnchorSequence(project.audioDurationMs, lines, anchors, { pointAware: Boolean(pacingItems) });
    const anchorDurations = computeAnchorBoundaries(project.audioDurationMs, lines, finalAnchors, anchorHints);
    const minimumDurationMs = project.readableHoldMode === "MIN_2_SECONDS" ? MIN_READABLE_IMAGE_DURATION_MS : 0;
    let cursor = 0;
    const rebuilt = images.map((image, index) => {
      const startMs = cursor; const endMs = startMs + anchorDurations[index]; cursor = endMs;
      const pointLabel = pacingItems ? `, filename label ${pacingItems[index]?.point ?? "?"}` : "";
      const selectionReason = pacingRescued && index >= acceptedAnchorCount
        ? `Groq's pacing plan was unusable for this project, so VisualSync anchored image ${image.sequenceNumber} to the nearest spoken sentence boundary with deterministic equal pacing.`
        : `Groq locked image ${image.sequenceNumber}${pointLabel} to transcript line ${finalAnchors[index]} with Direct Sentence Anchor: its boundary uses the matched narration timestamp rather than accumulated duration estimates. Review the content match before approval.`;
      return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason, decisionType: "KEEP" as const };
    });
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
  await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
  await db.transaction(async transaction => { await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId)); await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingProviderKey?.label ?? null, pacingProviderKeyMasked: pacingProviderKey?.maskedKey ?? null, allImagesRequired: true, minReadableDurationMs: minimumDurationMs, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: pacingRescued ? "sentence-boundary-fallback" : pacingItems ? "point-anchored" : "direct-sentence-anchored" } }))); await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } }); await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId)); });
  return { imageCount: rebuilt.length, minimumDurationMs, validation };
  } catch (error) { await db.update(projects).set({ status: "failed", workerState: "error", processingStage: "failed", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId)); throw error; } }  export type TimelineGenerationWorkState = { pacingPlanVersion?: number; preflightComplete?: boolean; firstDispatchAtMs?: number; pacingWeights?: number[]; pacingAnchors?: number[]; pacingAnchorHints?: Array<number | null>; nextPacingBatch?: number; pacingProviderKeyLabel?: string | null; pacingProviderKeyMasked?: string | null; pacingQualityRetries?: number; semanticAssignments?: SemanticAssignment[]; nextSemanticBatch?: number; semanticProviderKeyLabel?: string | null; semanticProviderKeyMasked?: string | null; };
  export type TimelineGenerationSliceResult = { stage: "transcribing" | "analyzing_images" | "building_timeline" | "completed"; workState: TimelineGenerationWorkState; };
  export function normalizeTimelineGenerationWorkState(value: unknown): TimelineGenerationWorkState { if (!value || typeof value !== "object") return {}; const record = value as Record<string, unknown>; return { pacingPlanVersion: Number.isInteger(record.pacingPlanVersion) ? Number(record.pacingPlanVersion) : undefined, preflightComplete: record.preflightComplete === true, firstDispatchAtMs: Number.isFinite(record.firstDispatchAtMs) ? Number(record.firstDispatchAtMs) : undefined, pacingWeights: Array.isArray(record.pacingWeights) ? record.pacingWeights.map(Number).filter(Number.isFinite) : [], pacingAnchors: Array.isArray(record.pacingAnchors) ? record.pacingAnchors.map(Number).filter(Number.isFinite) : [], pacingAnchorHints: Array.isArray(record.pacingAnchorHints) ? record.pacingAnchorHints.map(item => (Number.isFinite(item) && Number(item) > 0 ? Number(item) : null)) : [], nextPacingBatch: Number.isInteger(record.nextPacingBatch) && Number(record.nextPacingBatch) >= 0 ? Number(record.nextPacingBatch) : 0, pacingProviderKeyLabel: typeof record.pacingProviderKeyLabel === "string" ? record.pacingProviderKeyLabel : null, pacingProviderKeyMasked: typeof record.pacingProviderKeyMasked === "string" ? record.pacingProviderKeyMasked : null, pacingQualityRetries: Number.isInteger(record.pacingQualityRetries) && Number(record.pacingQualityRetries) >= 0 ? Number(record.pacingQualityRetries) : 0, semanticAssignments: Array.isArray(record.semanticAssignments) ? record.semanticAssignments.map(item => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { sequence: Number(value.sequence), segmentIndex: Number(value.segmentIndex), weight: Number(value.weight) }; }).filter(item => Number.isFinite(item.sequence) && Number.isFinite(item.segmentIndex) && Number.isFinite(item.weight)) : [], nextSemanticBatch: Number.isInteger(record.nextSemanticBatch) && Number(record.nextSemanticBatch) >= 0 ? Number(record.nextSemanticBatch) : 0, semanticProviderKeyLabel: typeof record.semanticProviderKeyLabel === "string" ? record.semanticProviderKeyLabel : null, semanticProviderKeyMasked: typeof record.semanticProviderKeyMasked === "string" ? record.semanticProviderKeyMasked : null, }; }  export async function processProjectTimelineSlice(userId: number, projectId: number, savedWorkState?: unknown): Promise<TimelineGenerationSliceResult> { const db = await getDb(); if (!db) throw new Error("Database storage is not available."); const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1); if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project."); const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId))); const narration = assets.find(asset => asset.assetType === "narration"); const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0)); if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing."); const workState = normalizeTimelineGenerationWorkState(savedWorkState);
  const resolvedVisionProvider: VisionSyncProviderId = isVisionSyncProviderId(project.visionSyncProvider) ? project.visionSyncProvider : "GROQ";
  if (narration.analysisState !== "analyzed") {
    const projectTranscriptionProvider: TranscriptionProviderId = isTranscriptionProviderId(project.transcriptionProvider) ? project.transcriptionProvider : "GROQ_WHISPER";
    if (projectTranscriptionProvider !== "GROQ_WHISPER") {
      // Whole-file single-shot: Deepgram Nova-2 / local Faster-Whisper transcribe the entire audio in ONE request (no 30s chunking).
      const singleShot = await transcribeWholeNarrationSingleShot(narration, projectTranscriptionProvider, 600_000);
      const transcription = { text: singleShot.text, language: singleShot.language, segments: singleShot.segments };
      if (!transcription.segments.some(segment => segment.text.trim())) throw new Error(`Transcription (${describeTranscriptionProviderModel(projectTranscriptionProvider)}) returned no timestamped narration segments.`);
      const narrationState: NarrationTranscriptionState = { version: 2, chunkOverlapMs: 0, sourcePrepared: true, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: [] };
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: projectTranscriptionProvider.toLowerCase(), model: describeTranscriptionProviderModel(projectTranscriptionProvider), transcriptionState: narrationState, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
      await db.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
      return { stage: "analyzing_images", workState };
    }
    const narrationState = await prepareNarrationChunks(projectId, narration, db); const nextChunkIndex = narrationState.chunks.findIndex(chunk => chunk.status !== "completed" || !chunk.transcript); if (nextChunkIndex >= 0) { const chunk = narrationState.chunks[nextChunkIndex]; chunk.status = "processing"; chunk.attempts += 1; chunk.lastAttemptAtMs = Date.now(); narrationState.lastError = undefined; await persistNarrationTranscriptionState(narration, narrationState, db); const transcriptionProvider: TranscriptionProviderId = isTranscriptionProviderId(project.transcriptionProvider) ? project.transcriptionProvider : "GROQ_WHISPER";
        if (transcriptionProvider !== "GROQ_WHISPER") {
          try {
            const singleShot = await transcribeNarrationChunkSingleShot(narration, chunk, transcriptionProvider, nextChunkIndex, 90_000);
            recordSingleShotChunkTranscription(narration, chunk, singleShot);
            await persistNarrationTranscriptionState(narration, narrationState, db);
            return { stage: "transcribing", workState };
          } catch (error) {
            if (error instanceof TranscriptionProviderError) {
              chunk.status = "failed";
              chunk.provider = { maskedKey: providerKeyForTranscriptionProvider(transcriptionProvider)?.maskedKey ?? "provider key", model: describeTranscriptionProviderModel(transcriptionProvider), durationMs: 0, httpStatus: error.httpStatus, category: "unknown" };
              narrationState.lastError = { category: "unknown", message: error.message, httpStatus: error.httpStatus, requestDurationMs: 0, occurredAtMs: Date.now() };
              await persistNarrationTranscriptionState(narration, narrationState, db);
              throw error;
            }
            throw error;
          }
        }
        try { const bytes = await loadNarrationChunkBytes(chunk); const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes; const run = await transcribeNarrationChunkBytes(userId, wavBytes, nextChunkIndex, 90_000, 1); const segments = shiftSegmentTimestamps(run.value.segments ?? [], chunk.startMs / 1000); const quality = transcriptionWordGapQuality(segments); if (quality.largestGapMs > MAX_ALLOWED_INTERNAL_WORD_GAP_MS && chunk.attempts < 2) { chunk.status = "pending"; chunk.provider = { maskedKey: run.key.maskedKey, model: GROQ_TRANSCRIPTION_MODEL, durationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, category: run.value.requestMetadata.category }; await persistNarrationTranscriptionState(narration, narrationState, db); return { stage: "transcribing", workState }; }
        chunk.status = "completed";
        chunk.transcript = { text: run.value.text, language: run.value.language, segments };
        chunk.provider = { maskedKey: run.key.maskedKey, model: GROQ_TRANSCRIPTION_MODEL, durationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, category: run.value.requestMetadata.category };
        await persistNarrationTranscriptionState(narration, narrationState, db);
        return { stage: "transcribing", workState };
      } catch (error) {
        if (error instanceof TranscriptionProviderError) {
          chunk.status = "failed";
          chunk.provider = { maskedKey: providerKeyForTranscriptionProvider(transcriptionProvider)?.maskedKey ?? "provider key", model: describeTranscriptionProviderModel(transcriptionProvider), durationMs: 0, httpStatus: error.httpStatus, category: "unknown" };
          narrationState.lastError = { category: "unknown", message: error.message, httpStatus: error.httpStatus, requestDurationMs: 0, occurredAtMs: Date.now() };
          await persistNarrationTranscriptionState(narration, narrationState, db);
          throw error;
        }
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
    const transcriptionProviderModel = isTranscriptionProviderId(project.transcriptionProvider) ? describeTranscriptionProviderModel(project.transcriptionProvider) : GROQ_TRANSCRIPTION_MODEL;
    if (!transcription.segments.some(segment => segment.text.trim())) throw new Error(`Transcription (${transcriptionProviderModel}) returned no timestamped narration segments.`);
    await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: isTranscriptionProviderId(project.transcriptionProvider) && project.transcriptionProvider !== "GROQ_WHISPER" ? project.transcriptionProvider.toLowerCase() : "groq", model: transcriptionProviderModel, transcriptionState: narrationState, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
    await db.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    return { stage: "analyzing_images", workState };
  }

  const pendingImages = images.filter(image => image.analysisState !== "analyzed");
  if (pendingImages.length > 0) {
    // Re-queuing a job resets the project stage to "transcribing"; once the
    // narration is already analyzed and we are back to images, move the stage
    // forward so the UI shows "Analyzing source images" instead of "Transcribing".
    await db.update(projects).set({ processingStage: "analyzing_images", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const analyzedCache = await db.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.assetType, "image"), eq(mediaAssets.analysisState, "analyzed")));
    const visionProviderLabel = resolvedVisionProvider === "GEMINI_FLASH" ? "gemini" : "groq";
    const visionModelLabel = resolvedVisionProvider === "GEMINI_FLASH" ? GEMINI_MODEL : GROQ_VISION_MODEL;
    const visionImagePrompt = "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe visible actions, characters, emotions, objects, text, and environment in detail.";

    if (resolvedVisionProvider === "GEMINI_FLASH") {
      // Analyze up to 12 inline images in a single Gemini call per slice.
      const sliceImages = pendingImages.slice(0, GEMINI_BATCH_IMAGES_PER_REQUEST);
      const toAnalyze: Array<{ image: typeof images[number]; dataBase64: string }> = [];
      for (const image of sliceImages) {
        const cachedAnalysis = analyzedCache.find(asset => asset.contentHash && asset.contentHash === image.contentHash && asset.analysisJson)?.analysisJson as Record<string, unknown> | undefined;
        if (cachedAnalysis && typeof cachedAnalysis.sceneDescription === "string" && cachedAnalysis.sceneDescription.trim()) {
          const analysis = { ...cachedAnalysis, sceneDescription: cachedAnalysis.sceneDescription.trim(), provider: "groq", model: GROQ_VISION_MODEL, reusedByContentHash: true };
          await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, image.id));
        } else {
          const imageUrl = await boundedVisionImageUrl(image.storageKey);
          toAnalyze.push({ image, dataBase64: imageUrl.split(",")[1] ?? "" });
        }
      }
      const results = await analyzeImagesWithGeminiBatch(userId, toAnalyze.map(({ image, dataBase64 }) => ({ sequence: image.sequenceNumber, filename: image.originalFilename, dataBase64 })));
      for (let position = 0; position < toAnalyze.length; position += 1) {
        const { image } = toAnalyze[position];
        const { analysis: rawAnalysis, key } = results[position];
        const sceneDescription = typeof rawAnalysis.sceneDescription === "string" ? rawAnalysis.sceneDescription.trim() : "";
        if (!sceneDescription) throw new Error(`Gemini returned no usable scene description for ${image.originalFilename}.`);
        const nextAnalysis = { ...rawAnalysis, sceneDescription, provider: visionProviderLabel, model: visionModelLabel, providerKeyLabel: key.label, providerKeyMasked: key.maskedKey };
        await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: nextAnalysis, embeddingSourceText: formatRichVisualScene(nextAnalysis) }).where(eq(mediaAssets.id, image.id));
      }
      return { stage: "analyzing_images", workState };
    }

    const pendingImage = pendingImages[0];
    const cachedAnalysis = analyzedCache.find(asset => asset.contentHash && asset.contentHash === pendingImage.contentHash && asset.analysisJson)?.analysisJson as Record<string, unknown> | undefined;
    if (cachedAnalysis && typeof cachedAnalysis.sceneDescription === "string" && cachedAnalysis.sceneDescription.trim()) {
      const analysis = { ...cachedAnalysis, sceneDescription: cachedAnalysis.sceneDescription.trim(), provider: "groq", model: GROQ_VISION_MODEL, reusedByContentHash: true };
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: formatRichVisualScene(analysis) }).where(eq(mediaAssets.id, pendingImage.id));
    } else {
      const imageUrl = await boundedVisionImageUrl(pendingImage.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: visionImagePrompt, timeoutMs: 60_000 }), key }), { maxAttempts: 1 });
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${pendingImage.originalFilename}.`);
      const nextAnalysis = { ...record, sceneDescription, provider: visionProviderLabel, model: visionModelLabel, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey };
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: nextAnalysis, embeddingSourceText: formatRichVisualScene(nextAnalysis) }).where(eq(mediaAssets.id, pendingImage.id));
    }
    return { stage: "analyzing_images", workState };
  }

  const refreshedAssets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const refreshedNarration = refreshedAssets.find(asset => asset.assetType === "narration");
  const refreshedImages = refreshedAssets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  const narrationJson = refreshedNarration?.analysisJson as { segments?: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }> } | null;
  const transcriptSegments = readPacingTranscriptSegments(narrationJson);
  if (transcriptSegments.length === 0) throw new Error("Persisted narration transcript is unavailable for timeline construction.");
  const visualCatalog = refreshedImages.map(image => ({ sequence: image.sequenceNumber, scene: formatRichVisualScene(image.analysisJson as Record<string, unknown> | null) }));
  if (project.timelineSyncMode === "SEMANTIC_WEIGHTED") {
    // Translate the fine word-boundary lines to English so image scenes and
    // narration match in the same language; matching by meaning alone (never
    // image order) keeps the result identical even if files are renamed.
    const semanticLines = splitTranscriptIntoSentenceLines(transcriptSegments);
    const englishLines = await translateSemanticLinesToEnglish(userId, resolvedVisionProvider, semanticLines);
    const isGeminiSemantic = resolvedVisionProvider === "GEMINI_FLASH";
    const semanticBatches = buildBoundedPacingBatches(visualCatalog, isGeminiSemantic ? MAX_GEMINI_SEMANTIC_OUTPUT_IMAGES : MAX_SEMANTIC_IMAGES_PER_REQUEST);
    const nextSemanticBatch = workState.nextSemanticBatch ?? 0;
    if (nextSemanticBatch < semanticBatches.length) {
      await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
      const batch = semanticBatches[nextSemanticBatch];
      const priorAssignments = workState.semanticAssignments ?? [];
      const semanticPrompt = semanticSyncPrompt(batch, englishLines, project.audioDurationMs!, priorAssignments, isGeminiSemantic);
      const semanticRun = resolvedVisionProvider === "GEMINI_FLASH"
        ? await executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(semanticPrompt, [], GEMINI_MAX_OUTPUT_TOKENS), key }))
        : await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeSemanticSyncPlan({ prompt: semanticPrompt, timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
      const batchAssignments = parseSemanticAssignments(semanticRun.value, batch, englishLines, priorAssignments);
      assertSemanticBatchAssignments(batchAssignments, batch, englishLines);
      return { stage: "building_timeline", workState: { ...workState, semanticAssignments: [...priorAssignments, ...batchAssignments], nextSemanticBatch: nextSemanticBatch + 1, semanticProviderKeyLabel: semanticRun.key.label, semanticProviderKeyMasked: semanticRun.key.maskedKey } };
    }
    const assignments = workState.semanticAssignments ?? [];
    const rebuilt = buildSemanticRebuiltSegments(project.audioDurationMs!, semanticLines, refreshedImages.map(image => ({ id: image.id, sequence: image.sequenceNumber, scene: formatRichVisualScene(image.analysisJson as Record<string, unknown> | null) })), assignments, project.readableHoldMode ?? "MIN_2_SECONDS");
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
  Object.assign(workState, prepareOrderedPacingWorkState(workState));
  const lines = splitTranscriptIntoSentenceLines(transcriptSegments);
  const orderedCatalog = refreshedImages.map((image, index) => ({ sequence: image.sequenceNumber ?? index + 1, originalFilename: image.originalFilename, scene: formatPacingVisualScene(image.analysisJson as Record<string, unknown> | null) }));
  const pacingItems = buildPointAnchoredPacingItems(orderedCatalog);
  const pacingCatalog: PacingBatchItem[] = pacingItems ?? orderedCatalog.map(({ sequence, scene }) => ({ sequence, scene, point: null }));
  const missingPoints = pacingItems ? collectMissingPointNumbers(pacingItems) : [];
  const batches = buildBoundedPacingBatches(pacingCatalog);
  const nextPacingBatch = workState.nextPacingBatch ?? 0;
  if (nextPacingBatch < batches.length) {
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const batch = batches[nextPacingBatch];
    const priorAnchors = workState.pacingAnchors ?? [];
    const cursorLine = priorAnchors.length ? priorAnchors[priorAnchors.length - 1] : 0;
    const prompt = buildDirectAnchorPacingPrompt({ batchIndex: nextPacingBatch, batchCount: batches.length, batch, lines, cursorLine, audioDurationMs: project.audioDurationMs, imageCount: visualCatalog.length, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", corrective: (workState.pacingQualityRetries ?? 0) > 0, missingPoints, previousImage: batches[nextPacingBatch - 1]?.at(-1) });
    let pacingRun: { value: unknown; key: { label: string; maskedKey: string } } | null = null;
    let parsed = null as ReturnType<typeof parseAndSanitizeAnchors>;
    try {
      const pacingPromise: Promise<{ value: unknown; key: { label: string; maskedKey: string } }> = resolvedVisionProvider === "GEMINI_FLASH"
        ? executeWithGeminiRotation(userId, async (client, key) => ({ value: await client.generateJson(prompt, [], GEMINI_MAX_OUTPUT_TOKENS), key }))
        : executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt, timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
      pacingRun = await pacingPromise;
      const normalized = normalizePacingPlanItems(pacingRun.value, lines.length, cursorLine, project.audioDurationMs!, batch.map(item => item.sequence));
      parsed = normalized
        ? { anchors: normalized, hints: [], lazy: false }
        : parseAndSanitizeAnchors(pacingRun.value, batch.length, lines.length, cursorLine, batch.map(item => item.sequence));
    } catch (error) {
      // Unusable model output is rescued below; transient API failures propagate.
      if (error instanceof GeminiRequestError || error instanceof GeminiPoolExhaustedError) {
        if (error instanceof GeminiRequestError && error.metadata?.category === "client_request") { /* rescue */ }
        else throw error;
      }
      if (!(error instanceof GroqRequestError) || error.metadata?.category !== "client_request") throw error;
    }
    if (!parsed || parsed.lazy) {
      const pacingQualityRetries = (workState.pacingQualityRetries ?? 0) + 1;
      if (pacingQualityRetries > MAX_ACTIVE_PACING_QUALITY_RETRIES) return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries: 0, nextPacingBatch: batches.length } };
      return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries } };
    }
    return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries: 0, pacingAnchors: [...priorAnchors, ...parsed.anchors], pacingAnchorHints: [...(workState.pacingAnchorHints ?? []), ...parsed.hints], nextPacingBatch: nextPacingBatch + 1, pacingProviderKeyLabel: pacingRun!.key.label, pacingProviderKeyMasked: pacingRun!.key.maskedKey } };
  }

  const savedAnchors = workState.pacingAnchors ?? [];
  const savedHints = workState.pacingAnchorHints ?? [];
  const legacyWeights = workState.pacingWeights ?? [];
  let minimumDurationMs = project.readableHoldMode === "MIN_2_SECONDS" ? MIN_READABLE_IMAGE_DURATION_MS : 0;
  let pacingMethod = pacingItems ? "point-anchored" : "direct-sentence-anchored";
  let rebuilt: Array<{ imageAssetId: number; startMs: number; endMs: number; narrationText: string; confidence: number; selectionReason: string; decisionType: "KEEP" }>;
  if (savedAnchors.length === refreshedImages.length) {
    const finalAnchors = sanitizeFinalAnchorSequence(project.audioDurationMs, lines, savedAnchors, { pointAware: Boolean(pacingItems) });
    const anchorDurations = computeAnchorBoundaries(project.audioDurationMs, lines, finalAnchors, savedHints);
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + anchorDurations[index]; cursor = endMs; const pointLabel = pacingItems ? `, filename label ${pacingItems[index]?.point ?? "?"}` : ""; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq locked image ${image.sequenceNumber}${pointLabel} to transcript line ${finalAnchors[index]} with Direct Sentence Anchor: its boundary uses the matched narration timestamp rather than accumulated duration estimates. Review the content match before approval.`, decisionType: "KEEP" as const }; });
  } else if (legacyWeights.length === refreshedImages.length) {
    const alignedWeights = alignOrderedWeightsToSpeechBoundaries(project.audioDurationMs, transcriptSegments, visualCatalog, batches, legacyWeights, project.readableHoldMode ?? "MIN_2_SECONDS");
    const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, alignedWeights, project.readableHoldMode ?? "MIN_2_SECONDS");
    minimumDurationMs = pacing.minimumDurationMs;
    pacingMethod = "bounded-global-full-narration-sequence";
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${legacyWeights[index]}. The ${project.readableHoldMode === "NO_MINIMUM" ? "no-minimum-hold mode applied no artificial duration floor" : `global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms`}.`, decisionType: "KEEP" as const }; });
  } else {
    const fallbackAnchors = fallbackProportionalAnchors(project.audioDurationMs, lines, refreshedImages.length, savedAnchors);
    const fallbackDurations = computeAnchorBoundaries(project.audioDurationMs, lines, fallbackAnchors, savedHints);
    pacingMethod = "sentence-boundary-fallback";
    let cursor = 0;
    rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + fallbackDurations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: index < savedAnchors.length ? `VisualSync preserved the accepted content anchor for image ${image.sequenceNumber}; only later unfinished images needed fallback pacing.` : `VisualSync anchored image ${image.sequenceNumber} to the nearest spoken sentence boundary because the saved AI anchor plan was incomplete.`, decisionType: "KEEP" as const }; });
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

