import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqRequestError } from "./groqClient";
import { getDb } from "./db";
import { executeWithGroqRotation, GroqPoolExhaustedError } from "./groqPool";
import { buildGlobalReadableImageDurations } from "./readablePacing";
import { storageGetSignedUrl } from "./storage";
import { validateTimeline } from "./timelineValidation";
import { makePcmWavChunk, planPcmWavTranscriptionRanges, SAFE_GROQ_DIRECT_WAV_BYTES, SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, scanMp3FrameRanges } from "./audioChunking";
import { mp3ToMonoWav } from "./audioTranscoding";
import { ADAPTIVE_PCM_WAV_RANGE_SPLIT_AFTER_ATTEMPTS, mergeChunkTranscripts, readNarrationTranscriptionState, splitRepeatedlyFailingPcmWavRange, summarizeNarrationText, type Mp3PreparationActiveChunk, type Mp3PreparationFrame, type Mp3PreparationState, type NarrationTranscriptionState, type PersistedNarrationChunk } from "./narrationTranscription";
import sharp from "sharp";

function transcriptForRange(segments: Array<{ start: number; end: number; text: string }>, startMs: number, endMs: number) {
  const text = segments.filter(segment => segment.end * 1000 > startMs && segment.start * 1000 < endMs).map(segment => segment.text.trim()).filter(Boolean).join(" ");
  return text || segments.at(-1)?.text.trim() || "Narration visual sequence";
}

const MAX_PACING_IMAGES_PER_REQUEST = 24;
const MAX_PACING_NARRATION_CHARACTERS = 3600;
const NARRATION_SOURCE_PREPARATION_VERSION = 7;
const MP3_PREPARATION_SCAN_BYTES = 256 * 1024;
const MP3_OVERLAP_BYTE_BUDGET = Math.floor(SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES * 0.25);
const HOSTED_STORAGE_READ_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_PACING_QUALITY_RETRIES = 1;
export function buildBoundedPacingBatches<T>(items: T[], batchSize = MAX_PACING_IMAGES_PER_REQUEST) { const batches: T[][] = []; for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize)); return batches; }

export function isGenericLinearPacingRamp(weights: number[]) {
  if (weights.length < 4 || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) return false;
  const steps = weights.slice(1).map((weight, index) => weight - weights[index]);
  const strictlyIncreasing = steps.every(step => step > 0);
  const strictlyDecreasing = steps.every(step => step < 0);
  if (!strictlyIncreasing && !strictlyDecreasing) return false;
  const magnitudes = steps.map(step => Math.abs(step));
  const averageStep = magnitudes.reduce((sum, step) => sum + step, 0) / magnitudes.length;
  const stepSpread = Math.max(...magnitudes) - Math.min(...magnitudes);
  return stepSpread <= Math.max(0.001, averageStep * 0.025);
}

function activePacingPrompt(batchIndex: number, batchCount: number, batch: Array<{ sequence: number | null; scene: string }>, narrationDigest: string, corrective = false) {
  return `Create content-specific variable pacing weights for contiguous ordered image batch ${batchIndex + 1}/${batchCount}. Reply only {"weights":[...]} with exactly ${batch.length} positive non-equal decimals. Assign every weight independently from the narration and the visible scene: important, dense, or concept-changing scenes may need longer holds; simple bridge scenes may need shorter holds. Do not use image number as a proxy for duration. Do not return an ascending or descending sequence, arithmetic progression, evenly spaced ramp, or a repeated pattern.${corrective ? " The previous answer was rejected because it was a generic sequential ramp; recalculate each image from its actual scene and narrative role." : ""} Narration digest: ${JSON.stringify(narrationDigest)}. Image batch: ${JSON.stringify(batch)}`;
}

function assertActivePacingWeights(weights: number[], expectedLength: number) {
  if (weights.length !== expectedLength || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error("Groq returned an invalid active per-image pacing plan.");
  if (isGenericLinearPacingRamp(weights)) throw new Error("Groq returned a generic linear pacing ramp instead of content-specific per-image pacing.");
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
  return frames.find(candidate => frame.endByteExclusive - candidate.startByte <= MP3_OVERLAP_BYTE_BUDGET) ?? frame;
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
    } else if (frame.endByteExclusive - active.startByte > SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES) {
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
  preparation.recentFrames = preparation.recentFrames.filter(frame => frame.endByteExclusive > preparation.nextByteOffset - MP3_OVERLAP_BYTE_BUDGET);
  const activeOverlapMs = preparation.activeChunk ? preparation.activeChunk.contentStartMs - preparation.activeChunk.startMs : 0;
  state.chunkOverlapMs = Math.max(0, ...state.chunks.map(chunk => chunk.contentStartMs - chunk.startMs), activeOverlapMs);
}

async function boundedVisionImageUrl(storageKey: string) {
  const url = await storageGetSignedUrl(storageKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Uploaded image could not be retrieved from secure storage.");
  const source = Buffer.from(await response.arrayBuffer());
  const preview = await sharp(source, { limitInputPixels: 36_000_000 }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${preview.toString("base64")}`;
}

async function fetchNarrationStorageRange(storageKey: string, range?: string) {
  const controller = new AbortController();
  const startedAtMs = Date.now();
  const timeout = setTimeout(() => controller.abort(), HOSTED_STORAGE_READ_TIMEOUT_MS);
  try {
    const url = await storageGetSignedUrl(storageKey, controller.signal);
    return await fetch(url, { ...(range ? { headers: { Range: range } } : {}), signal: controller.signal });
  } catch (error) {
    const durationMs = Date.now() - startedAtMs;
    if (controller.signal.aborted) throw new GroqRequestError("Secure storage timed out while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "timeout" });
    throw new GroqRequestError("Secure storage was temporarily unavailable while preparing the saved narration. The hosted Timeline job will retry automatically.", "unavailable", { durationMs, category: "network_failure" });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadNarrationChunkBytes(chunk: PersistedNarrationChunk) {
  const response = await fetchNarrationStorageRange(chunk.storageKey, chunk.sourceRange ? `bytes=${chunk.sourceRange.startByte}-${chunk.sourceRange.endByteExclusive - 1}` : undefined);
  if (!response.ok) throw new Error("Prepared narration chunk could not be retrieved from secure storage.");
  if (chunk.sourceRange && response.status !== 206) throw new Error("Secure storage did not honor the bounded WAV byte-range request.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return chunk.sourceRange?.wavFmtBase64 ? makePcmWavChunk(new Uint8Array(Buffer.from(chunk.sourceRange.wavFmtBase64, "base64")), bytes) : bytes;
}

async function persistNarrationTranscriptionState(narration: typeof mediaAssets.$inferSelect, state: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>) {
  await db.update(mediaAssets).set({ analysisJson: { ...(narration.analysisJson && typeof narration.analysisJson === "object" ? narration.analysisJson as Record<string, unknown> : {}), transcriptionState: state } }).where(eq(mediaAssets.id, narration.id));
}

export function isWavNarration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) {
  return narration.mimeType === "audio/wav" || narration.mimeType === "audio/x-wav" || narration.storageKey.toLowerCase().endsWith(".wav");
}

function isMp3Narration(narration: Pick<typeof mediaAssets.$inferSelect, "mimeType" | "storageKey">) {
  return narration.mimeType === "audio/mpeg" || narration.storageKey.toLowerCase().endsWith(".mp3");
}

export async function prepareNarrationChunks(projectId: number, narration: typeof mediaAssets.$inferSelect, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>): Promise<NarrationTranscriptionState> {
  const cached = readNarrationTranscriptionState(narration.analysisJson);
  const wavNarration = isWavNarration(narration);
  if (cached?.sourcePrepared && cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION) return cached;
  if (!isMp3Narration(narration) && !wavNarration) throw new Error("This narration must be uploaded as WAV or MP3 for automatic safe transcription chunking.");
  if (isMp3Narration(narration)) {
    const repairedCached = recoverLegacyInflatedMp3Preparation(cached);
    const resumableCached = repairedCached && (repairedCached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || repairedCached.chunks.some(chunk => chunk.status === "completed" && chunk.transcript)) ? repairedCached : null;
    const state: NarrationTranscriptionState = resumableCached ?? { version: 2, chunkOverlapMs: 0, sourcePrepared: false, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: [], mp3Preparation: { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] } };
    const preparation = state.mp3Preparation ?? { nextByteOffset: 0, nextTimestampMs: 0, recentFrames: [] };
    state.mp3Preparation = preparation;
    state.sourcePrepared = false;
    state.sourcePreparationVersion = NARRATION_SOURCE_PREPARATION_VERSION;
    await persistNarrationTranscriptionState(narration, state, db);
    const sourceResponse = await fetchNarrationStorageRange(narration.storageKey, `bytes=${preparation.nextByteOffset}-${preparation.nextByteOffset + MP3_PREPARATION_SCAN_BYTES - 1}`);
    if (!sourceResponse.ok || sourceResponse.status !== 206) throw new Error("Secure storage did not provide the bounded MP3 range required for durable preparation.");
    const sourceByteLength = Number(sourceResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the MP3 source length required for durable preparation.");
    preparation.sourceByteLength = sourceByteLength;
    const scanned = scanMp3FrameRanges(new Uint8Array(await sourceResponse.arrayBuffer()), preparation.nextByteOffset, preparation.nextTimestampMs);
    if (!scanned.frames.length && scanned.nextByteOffset <= preparation.nextByteOffset) throw new Error("MP3 preparation could not find a complete frame in the bounded source range.");
    preparation.nextByteOffset = scanned.nextByteOffset;
    preparation.nextTimestampMs = scanned.nextTimestampMs;
    advanceMp3Preparation(state, narration.storageKey, preparation, scanned.frames);
    if (preparation.nextByteOffset >= sourceByteLength) {
      if (preparation.activeChunk) state.chunks.push(mp3PreparationChunk(preparation.activeChunk, narration.storageKey));
      state.sourcePrepared = true;
      delete state.mp3Preparation;
      state.chunkOverlapMs = state.chunks.length > 1 ? 4_000 : 0;
    }
    await persistNarrationTranscriptionState(narration, state, db);
    return state;
  }
  const storedChunks: PersistedNarrationChunk[] = wavNarration
    ? await (async () => {
      const headerResponse = await fetchNarrationStorageRange(narration.storageKey, "bytes=0-65535");
      if (!headerResponse.ok || headerResponse.status !== 206) throw new Error("Secure storage did not provide the bounded WAV header required for durable preparation.");
      const sourceByteLength = Number(headerResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]);
      if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the WAV source length required for durable preparation.");
      const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength);
      const wavFmtBase64 = Buffer.from(plan.fmtBytes).toString("base64");
      return plan.ranges.map(range => ({ storageKey: narration.storageKey, sourceRange: { startByte: range.startByte, endByteExclusive: range.endByteExclusive, wavFmtBase64 }, startMs: range.startMs, endMs: range.endMs, contentStartMs: range.contentStartMs, contentEndMs: range.contentEndMs, byteSize: range.endByteExclusive - range.startByte + 28 + plan.fmtBytes.length, status: "pending" as const, attempts: 0 }));
    })()
    : [];
  const state: NarrationTranscriptionState = { version: 2, chunkOverlapMs: storedChunks.length > 1 ? 4_000 : 0, sourcePrepared: true, sourcePreparationVersion: NARRATION_SOURCE_PREPARATION_VERSION, chunks: storedChunks };
  await persistNarrationTranscriptionState(narration, state, db);
  return state;
}

export async function transcribePreparedNarrationChunks(userId: number, narration: typeof mediaAssets.$inferSelect, narrationState: NarrationTranscriptionState, db: Exclude<Awaited<ReturnType<typeof getDb>>, null>) {
  let transcriptionKey: { label: string; maskedKey: string } | null = null;
  for (let index = 0; index < narrationState.chunks.length; index += 1) {
    const chunk = narrationState.chunks[index];
    if (chunk.status === "completed" && chunk.transcript) continue;
    chunk.status = "processing";
    chunk.attempts += 1;
    narrationState.lastError = undefined;
    await persistNarrationTranscriptionState(narration, narrationState, db);
    try {
      const bytes = await loadNarrationChunkBytes(chunk);
      const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes;
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: wavBytes, filename: `narration-part-${index + 1}.wav`, mimeType: "audio/wav", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers.", timeoutMs: 120_000 }), key }));
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
        await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: String(analysis.sceneDescription) }).where(eq(mediaAssets.id, image.id));
        continue;
      }
      const imageUrl = await boundedVisionImageUrl(image.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe only visible content." }), key }));
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${image.originalFilename}.`);
      const analysis = { ...record, sceneDescription, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey };
      imageAnalyses.push({ image, analysis });
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: sceneDescription }).where(eq(mediaAssets.id, image.id));
    }
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const fullNarration = transcriptSegments.map(segment => segment.text.trim()).join(" ");
    const narrationDigest = fullNarration.slice(0, MAX_PACING_NARRATION_CHARACTERS);
    const visualCatalog = imageAnalyses.map(({ image, analysis }) => ({ sequence: image.sequenceNumber, scene: String(analysis.sceneDescription).replace(/\s+/g, " ").slice(0, 84) }));
    const batches = buildBoundedPacingBatches(visualCatalog);
    const weights: number[] = [];
    let pacingProviderKey: { label: string; maskedKey: string } | null = null;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      let pacingRun: { value: unknown; key: { label: string; maskedKey: string } } | null = null;
      let batchWeights: number[] = [];
      for (let qualityAttempt = 0; qualityAttempt <= MAX_ACTIVE_PACING_QUALITY_RETRIES; qualityAttempt += 1) {
        const prompt = activePacingPrompt(batchIndex, batches.length, batch, narrationDigest, qualityAttempt > 0);
        const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt }), key }));
        const candidateWeights = Array.isArray((run.value as { weights?: unknown }).weights) ? (run.value as { weights: unknown[] }).weights.map(weight => Number(weight)) : [];
        try {
          assertActivePacingWeights(candidateWeights, batch.length);
          pacingRun = run;
          batchWeights = candidateWeights;
          break;
        } catch (error) {
          if (qualityAttempt === MAX_ACTIVE_PACING_QUALITY_RETRIES) throw error;
        }
      }
      if (!pacingRun) throw new Error("Groq did not return an active per-image pacing plan.");
      weights.push(...batchWeights);
      pacingProviderKey = pacingRun.key;
    }
    if (weights.length !== images.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0) || new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Groq returned an invalid variable pacing plan.");
    const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights, project.readableHoldMode ?? "MIN_2_SECONDS");
    let cursor = 0;
    const rebuilt = images.map((image, index) => {
      const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs;
      return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${weights[index]}. The ${project.readableHoldMode === "NO_MINIMUM" ? "no-minimum-hold mode applied no artificial duration floor" : `global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms`}.`, decisionType: "KEEP" as const };
    });
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
    if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
    await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    await db.transaction(async transaction => {
      await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
      await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingProviderKey?.label ?? null, pacingProviderKeyMasked: pacingProviderKey?.maskedKey ?? null, allImagesRequired: true, minReadableDurationMs: pacing.minimumDurationMs, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: "bounded-global-full-narration-sequence" } })));
      await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
      await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
    });
    return { imageCount: rebuilt.length, minimumDurationMs: pacing.minimumDurationMs, validation };
  } catch (error) {
    await db.update(projects).set({ status: "failed", workerState: "error", processingStage: "failed", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    throw error;
  }
}

export type TimelineGenerationWorkState = {
  preflightComplete?: boolean;
  firstDispatchAtMs?: number;
  pacingWeights?: number[];
  nextPacingBatch?: number;
  pacingProviderKeyLabel?: string | null;
  pacingProviderKeyMasked?: string | null;
  pacingQualityRetries?: number;
};

export type TimelineGenerationSliceResult = {
  stage: "transcribing" | "analyzing_images" | "building_timeline" | "completed";
  workState: TimelineGenerationWorkState;
};

export function normalizeTimelineGenerationWorkState(value: unknown): TimelineGenerationWorkState {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    preflightComplete: record.preflightComplete === true,
    firstDispatchAtMs: Number.isFinite(record.firstDispatchAtMs) ? Number(record.firstDispatchAtMs) : undefined,
    pacingWeights: Array.isArray(record.pacingWeights) ? record.pacingWeights.map(Number).filter(Number.isFinite) : [],
    nextPacingBatch: Number.isInteger(record.nextPacingBatch) && Number(record.nextPacingBatch) >= 0 ? Number(record.nextPacingBatch) : 0,
    pacingProviderKeyLabel: typeof record.pacingProviderKeyLabel === "string" ? record.pacingProviderKeyLabel : null,
    pacingProviderKeyMasked: typeof record.pacingProviderKeyMasked === "string" ? record.pacingProviderKeyMasked : null,
    pacingQualityRetries: Number.isInteger(record.pacingQualityRetries) && Number(record.pacingQualityRetries) >= 0 ? Number(record.pacingQualityRetries) : 0,
  };
}

/**
 * Executes one provider-sized unit of the proven Timeline pipeline. Each call
 * persists before returning, making it safe for a hosted scheduler to resume
 * after a browser close, server restart, or provider retry delay.
 */
export async function processProjectTimelineSlice(userId: number, projectId: number, savedWorkState?: unknown): Promise<TimelineGenerationSliceResult> {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project.");
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const narration = assets.find(asset => asset.assetType === "narration");
  const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing.");
  const workState = normalizeTimelineGenerationWorkState(savedWorkState);

  if (narration.analysisState !== "analyzed") {
    const narrationState = await prepareNarrationChunks(projectId, narration, db);
    const nextChunkIndex = narrationState.chunks.findIndex(chunk => chunk.status !== "completed" || !chunk.transcript);
    if (nextChunkIndex >= 0) {
      const chunk = narrationState.chunks[nextChunkIndex];
      chunk.status = "processing";
      chunk.attempts += 1;
      chunk.lastAttemptAtMs = Date.now();
      narrationState.lastError = undefined;
      await persistNarrationTranscriptionState(narration, narrationState, db);
      try {
        const bytes = await loadNarrationChunkBytes(chunk);
        const wavBytes = isMp3Narration(narration) ? await mp3ToMonoWav(bytes) : bytes;
        const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: wavBytes, filename: `narration-part-${nextChunkIndex + 1}.wav`, mimeType: "audio/wav", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers.", timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
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
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: String(analysis.sceneDescription) }).where(eq(mediaAssets.id, pendingImage.id));
    } else {
      const imageUrl = await boundedVisionImageUrl(pendingImage.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe only visible content.", timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${pendingImage.originalFilename}.`);
      await db.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { ...record, sceneDescription, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey }, embeddingSourceText: sceneDescription }).where(eq(mediaAssets.id, pendingImage.id));
    }
    return { stage: "analyzing_images", workState };
  }

  const refreshedAssets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const refreshedNarration = refreshedAssets.find(asset => asset.assetType === "narration");
  const refreshedImages = refreshedAssets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  const narrationJson = refreshedNarration?.analysisJson as { segments?: Array<{ start: number; end: number; text: string }> } | null;
  const transcriptSegments = (narrationJson?.segments ?? []).filter(segment => segment.text.trim());
  if (transcriptSegments.length === 0) throw new Error("Persisted narration transcript is unavailable for timeline construction.");
  const fullNarration = transcriptSegments.map(segment => segment.text.trim()).join(" ");
  const visualCatalog = refreshedImages.map(image => ({ sequence: image.sequenceNumber, scene: String((image.analysisJson as Record<string, unknown> | null)?.sceneDescription ?? "").replace(/\s+/g, " ").slice(0, 84) }));
  const batches = buildBoundedPacingBatches(visualCatalog);
  const nextPacingBatch = workState.nextPacingBatch ?? 0;
  if (nextPacingBatch < batches.length) {
    await db.update(projects).set({ processingStage: "building_timeline", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    const batch = batches[nextPacingBatch];
    const prompt = activePacingPrompt(nextPacingBatch, batches.length, batch, fullNarration.slice(0, MAX_PACING_NARRATION_CHARACTERS), (workState.pacingQualityRetries ?? 0) > 0);
    const pacingRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt, timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
    const batchWeights = Array.isArray((pacingRun.value as { weights?: unknown }).weights) ? (pacingRun.value as { weights: unknown[] }).weights.map(Number) : [];
    try {
      assertActivePacingWeights(batchWeights, batch.length);
    } catch (error) {
      const pacingQualityRetries = (workState.pacingQualityRetries ?? 0) + 1;
      if (pacingQualityRetries > MAX_ACTIVE_PACING_QUALITY_RETRIES) throw error;
      return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries } };
    }
    return { stage: "building_timeline", workState: { ...workState, pacingQualityRetries: 0, pacingWeights: [...(workState.pacingWeights ?? []), ...batchWeights], nextPacingBatch: nextPacingBatch + 1, pacingProviderKeyLabel: pacingRun.key.label, pacingProviderKeyMasked: pacingRun.key.maskedKey } };
  }

  const weights = workState.pacingWeights ?? [];
  if (weights.length !== refreshedImages.length || new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Persisted Groq pacing state is incomplete or invalid.");
  const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights, project.readableHoldMode ?? "MIN_2_SECONDS");
  let cursor = 0;
  const rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${weights[index]}. The ${project.readableHoldMode === "NO_MINIMUM" ? "no-minimum-hold mode applied no artificial duration floor" : `global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms`}.`, decisionType: "KEEP" as const }; });
  const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: workState.pacingProviderKeyLabel ?? null, pacingProviderKeyMasked: workState.pacingProviderKeyMasked ?? null, allImagesRequired: true, minReadableDurationMs: pacing.minimumDurationMs, holdMode: project.readableHoldMode ?? "MIN_2_SECONDS", pacingMethod: "bounded-global-full-narration-sequence" } })));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
  });
  return { stage: "completed", workState };
}
