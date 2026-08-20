import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqRequestError } from "./groqClient";
import { getDb } from "./db";
import { executeWithGroqRotation, GroqPoolExhaustedError } from "./groqPool";
import { buildGlobalReadableImageDurations } from "./readablePacing";
import { storageGetSignedUrl, storagePut } from "./storage";
import { validateTimeline } from "./timelineValidation";
import { makePcmWavChunk, planPcmWavTranscriptionRanges, SAFE_GROQ_DIRECT_WAV_BYTES, SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, splitMp3ForTranscription } from "./audioChunking";
import { mp3ToMonoWav } from "./audioTranscoding";
import { mergeChunkTranscripts, readNarrationTranscriptionState, summarizeNarrationText, type NarrationTranscriptionState, type PersistedNarrationChunk } from "./narrationTranscription";
import sharp from "sharp";

function transcriptForRange(segments: Array<{ start: number; end: number; text: string }>, startMs: number, endMs: number) {
  const text = segments.filter(segment => segment.end * 1000 > startMs && segment.start * 1000 < endMs).map(segment => segment.text.trim()).filter(Boolean).join(" ");
  return text || segments.at(-1)?.text.trim() || "Narration visual sequence";
}

const MAX_PACING_IMAGES_PER_REQUEST = 24;
const MAX_PACING_NARRATION_CHARACTERS = 3600;
const NARRATION_CHUNK_STORAGE_CONCURRENCY = 3;
const NARRATION_SOURCE_PREPARATION_VERSION = 3;
export function buildBoundedPacingBatches<T>(items: T[], batchSize = MAX_PACING_IMAGES_PER_REQUEST) { const batches: T[][] = []; for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize)); return batches; }
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

async function boundedVisionImageUrl(storageKey: string) {
  const url = await storageGetSignedUrl(storageKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Uploaded image could not be retrieved from secure storage.");
  const source = Buffer.from(await response.arrayBuffer());
  const preview = await sharp(source, { limitInputPixels: 36_000_000 }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${preview.toString("base64")}`;
}

async function loadNarrationChunkBytes(chunk: PersistedNarrationChunk) {
  const response = await fetch(await storageGetSignedUrl(chunk.storageKey), chunk.sourceRange ? { headers: { Range: `bytes=${chunk.sourceRange.startByte}-${chunk.sourceRange.endByteExclusive - 1}` } } : undefined);
  if (!response.ok) throw new Error("Prepared narration chunk could not be retrieved from secure storage.");
  if (chunk.sourceRange && response.status !== 206) throw new Error("Secure storage did not honor the bounded WAV byte-range request.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return chunk.sourceRange ? makePcmWavChunk(new Uint8Array(Buffer.from(chunk.sourceRange.wavFmtBase64, "base64")), bytes) : bytes;
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
  const hasCompletedChunk = cached?.chunks.some(chunk => chunk.status === "completed" && chunk.transcript);
  if (cached?.sourcePrepared && (cached.sourcePreparationVersion === NARRATION_SOURCE_PREPARATION_VERSION || hasCompletedChunk)) return cached;
  if (!isMp3Narration(narration) && !wavNarration) throw new Error("This narration must be uploaded as WAV or MP3 for automatic safe transcription chunking.");
  const storedChunks: PersistedNarrationChunk[] = wavNarration
    ? await (async () => {
      const headerResponse = await fetch(await storageGetSignedUrl(narration.storageKey), { headers: { Range: "bytes=0-65535" } });
      if (!headerResponse.ok || headerResponse.status !== 206) throw new Error("Secure storage did not provide the bounded WAV header required for durable preparation.");
      const sourceByteLength = Number(headerResponse.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]);
      if (!Number.isSafeInteger(sourceByteLength)) throw new Error("Secure storage did not provide the WAV source length required for durable preparation.");
      const plan = planPcmWavTranscriptionRanges(new Uint8Array(await headerResponse.arrayBuffer()), sourceByteLength);
      const wavFmtBase64 = Buffer.from(plan.fmtBytes).toString("base64");
      return plan.ranges.map(range => ({ storageKey: narration.storageKey, sourceRange: { startByte: range.startByte, endByteExclusive: range.endByteExclusive, wavFmtBase64 }, startMs: range.startMs, endMs: range.endMs, contentStartMs: range.contentStartMs, contentEndMs: range.contentEndMs, byteSize: range.endByteExclusive - range.startByte + 28 + plan.fmtBytes.length, status: "pending" as const, attempts: 0 }));
    })()
    : await (async () => {
      const sourceResponse = await fetch(await storageGetSignedUrl(narration.storageKey));
      if (!sourceResponse.ok) throw new Error("The narration could not be retrieved from secure storage for transcription preparation.");
      const chunks = splitMp3ForTranscription(new Uint8Array(await sourceResponse.arrayBuffer()));
      return mapWithConcurrency(chunks, NARRATION_CHUNK_STORAGE_CONCURRENCY, async (chunk, index) => {
        const stored = await storagePut(`projects/${projectId}/transcription-chunks/${narration.id}-part-${index + 1}.mp3`, chunk.bytes, "audio/mpeg");
        return { storageKey: stored.key, startMs: chunk.startMs, endMs: chunk.endMs, contentStartMs: chunk.contentStartMs, contentEndMs: chunk.contentEndMs, byteSize: chunk.bytes.byteLength, status: "pending" as const, attempts: 0 };
      });
    })();
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
      const prompt = `Create variable pacing weights for contiguous ordered image batch ${batchIndex + 1}/${batches.length}. Reply only {"weights":[...]} with exactly ${batch.length} positive non-equal decimals. Larger means longer hold. Narration digest: ${JSON.stringify(narrationDigest)}. Image batch: ${JSON.stringify(batch)}`;
      const pacingRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt }), key }));
      const batchWeights = Array.isArray((pacingRun.value as { weights?: unknown }).weights) ? (pacingRun.value as { weights: unknown[] }).weights.map(weight => Number(weight)) : [];
      if (batchWeights.length !== batch.length || batchWeights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error("Groq returned an invalid bounded pacing plan.");
      weights.push(...batchWeights);
      pacingProviderKey = pacingRun.key;
    }
    if (weights.length !== images.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0) || new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Groq returned an invalid variable pacing plan.");
    const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights);
    let cursor = 0;
    const rebuilt = images.map((image, index) => {
      const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs;
      return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${weights[index]}. The global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms.`, decisionType: "KEEP" as const };
    });
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
    if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
    await db.update(projects).set({ processingStage: "finalizing", processingStageStartedAt: new Date() }).where(eq(projects.id, projectId));
    await db.transaction(async transaction => {
      await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
      await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingProviderKey?.label ?? null, pacingProviderKeyMasked: pacingProviderKey?.maskedKey ?? null, allImagesRequired: true, minReadableDurationMs: pacing.minimumDurationMs, pacingMethod: "bounded-global-full-narration-sequence" } })));
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
        narrationState.lastError = { category: metadata?.category ?? "unknown", message: safeError?.message ?? "Narration chunk transcription did not complete.", retryAfterMs: metadata?.retryAfterMs, httpStatus: metadata?.httpStatus, errorCode: metadata?.errorCode, remainingRequests: metadata?.remainingRequests, remainingAudio: metadata?.remainingAudio, resetAudio: metadata?.resetAudio, requestDurationMs: metadata?.durationMs ?? 0, occurredAtMs: Date.now() };
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
    const prompt = `Create variable pacing weights for contiguous ordered image batch ${nextPacingBatch + 1}/${batches.length}. Reply only {"weights":[...]} with exactly ${batch.length} positive non-equal decimals. Larger means longer hold. Narration digest: ${JSON.stringify(fullNarration.slice(0, MAX_PACING_NARRATION_CHARACTERS))}. Image batch: ${JSON.stringify(batch)}`;
    const pacingRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt, timeoutMs: 20_000 }), key }), { maxAttempts: 1 });
    const batchWeights = Array.isArray((pacingRun.value as { weights?: unknown }).weights) ? (pacingRun.value as { weights: unknown[] }).weights.map(Number) : [];
    if (batchWeights.length !== batch.length || batchWeights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error("Groq returned an invalid bounded pacing plan.");
    return { stage: "building_timeline", workState: { ...workState, pacingWeights: [...(workState.pacingWeights ?? []), ...batchWeights], nextPacingBatch: nextPacingBatch + 1, pacingProviderKeyLabel: pacingRun.key.label, pacingProviderKeyMasked: pacingRun.key.maskedKey } };
  }

  const weights = workState.pacingWeights ?? [];
  if (weights.length !== refreshedImages.length || new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Persisted Groq pacing state is incomplete or invalid.");
  const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights);
  let cursor = 0;
  const rebuilt = refreshedImages.map((image, index) => { const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs; return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: 0, selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${weights[index]}. The global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms.`, decisionType: "KEEP" as const }; });
  const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: workState.pacingProviderKeyLabel ?? null, pacingProviderKeyMasked: workState.pacingProviderKeyMasked ?? null, allImagesRequired: true, minReadableDurationMs: pacing.minimumDurationMs, pacingMethod: "bounded-global-full-narration-sequence" } })));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready", processingStage: "idle", processingStartedAt: null, processingStageStartedAt: null }).where(eq(projects.id, projectId));
  });
  return { stage: "completed", workState };
}
