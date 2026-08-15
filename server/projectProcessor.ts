import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL } from "./groqClient";
import { getDb } from "./db";
import { executeWithGroqRotation } from "./groqPool";
import { buildGlobalReadableImageDurations } from "./readablePacing";
import { storageGetSignedUrl } from "./storage";
import { validateTimeline } from "./timelineValidation";

function transcriptForRange(segments: Array<{ start: number; end: number; text: string }>, startMs: number, endMs: number) {
  const text = segments.filter(segment => segment.end * 1000 > startMs && segment.start * 1000 < endMs).map(segment => segment.text.trim()).filter(Boolean).join(" ");
  return text || segments.at(-1)?.text.trim() || "Narration visual sequence";
}

export async function processProjectWithGlobalReadablePacing(userId: number, projectId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project?.audioDurationMs) throw new Error("Select and upload the narration before processing this project.");
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
  const narration = assets.find(asset => asset.assetType === "narration");
  const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
  if (!narration || !images.length) throw new Error("Select and upload one narration and at least one image before processing.");
  await db.update(projects).set({ status: "analyzing", workerState: "processing" }).where(eq(projects.id, projectId));
  try {
    const narrationUrl = await storageGetSignedUrl(narration.storageKey);
    const narrationResponse = await fetch(narrationUrl);
    if (!narrationResponse.ok) throw new Error("Uploaded narration could not be retrieved from secure storage.");
    const bytes = new Uint8Array(await narrationResponse.arrayBuffer());
    const transcriptionRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes, filename: narration.originalFilename, mimeType: narration.mimeType ?? "audio/mpeg", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers." }), key }));
    const transcription = transcriptionRun.value;
    const transcriptSegments = (transcription.segments ?? []).filter(segment => segment.text.trim());
    if (!transcriptSegments.length) throw new Error("Groq Whisper returned no timestamped narration segments.");
    const imageAnalyses = [] as Array<{ image: typeof images[number]; analysis: Record<string, unknown> }>;
    for (const image of images) {
      const imageUrl = await storageGetSignedUrl(image.storageKey);
      const run = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven video. Return JSON with sceneDescription, subjects, setting, mood, and relevance. Describe only visible content." }), key }));
      const record = typeof run.value === "object" && run.value ? run.value as Record<string, unknown> : {};
      const sceneDescription = typeof record.sceneDescription === "string" ? record.sceneDescription.trim() : "";
      if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${image.originalFilename}.`);
      imageAnalyses.push({ image, analysis: { ...record, sceneDescription, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: run.key.label, providerKeyMasked: run.key.maskedKey } });
    }
    const fullNarration = transcriptSegments.map(segment => segment.text.trim()).join(" ");
    const visualCatalog = imageAnalyses.map(({ image, analysis }) => ({ sequence: image.sequenceNumber, scene: String(analysis.sceneDescription).slice(0, 160) }));
    const prompt = `Create a calm, variable visual pacing plan for the full narration below. The supplied images are already in exact script order: use every image once, do not reorder them, and do not force them into individual Whisper timestamp boundaries. Reply with exactly one JSON object and no markdown or explanation. The object must have only this property: "weights", an array of exactly ${images.length} positive, non-equal decimal numbers. Larger weights mean a longer visual hold. Narration: ${JSON.stringify(fullNarration)}. Ordered image scenes: ${JSON.stringify(visualCatalog)}`;
    const pacingRun = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completePacingPlan({ prompt }), key }));
    const weights = Array.isArray((pacingRun.value as { weights?: unknown }).weights) ? (pacingRun.value as { weights: unknown[] }).weights.map(weight => Number(weight)) : [];
    if (weights.length !== images.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0) || new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Groq returned an invalid variable pacing plan.");
    const pacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights);
    let cursor = 0;
    const rebuilt = images.map((image, index) => {
      const startMs = cursor; const endMs = startMs + pacing.durations[index]; cursor = endMs;
      return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptForRange(transcriptSegments, startMs, endMs), confidence: Math.min(0.99, 0.72 + Math.min(weights[index], 2) * 0.1), selectionReason: `Groq retained user-supplied image ${image.sequenceNumber} in chronological script order and assigned a variable full-narration pacing weight of ${weights[index]}. The global readable-hold rule set a minimum of ${pacing.minimumDurationMs} ms.`, decisionType: "KEEP" as const };
    });
    const validation = validateTimeline(project.audioDurationMs, rebuilt);
    if (!validation.valid || cursor !== project.audioDurationMs) throw new Error(`Generated timeline failed validation: ${validation.issues.join(" ")}`);
    await db.transaction(async transaction => {
      await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: "groq", model: GROQ_TRANSCRIPTION_MODEL, providerKeyLabel: transcriptionRun.key.label, providerKeyMasked: transcriptionRun.key.maskedKey, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
      for (const { image, analysis } of imageAnalyses) await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: String(analysis.sceneDescription) }).where(eq(mediaAssets.id, image.id));
      await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
      await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingRun.key.label, pacingProviderKeyMasked: pacingRun.key.maskedKey, allImagesRequired: true, minReadableDurationMs: pacing.minimumDurationMs, pacingMethod: "global-full-narration-sequence" } })));
      await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
      await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
    });
    return { imageCount: rebuilt.length, minimumDurationMs: pacing.minimumDurationMs, validation };
  } catch (error) {
    await db.update(projects).set({ status: "ready", workerState: "error" }).where(eq(projects.id, projectId));
    throw error;
  }
}
