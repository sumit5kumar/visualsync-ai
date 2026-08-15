import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineSegments } from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL } from "../server/groqClient.ts";
import { executeWithGroqRotation } from "../server/groqPool.ts";
import { storageGetSignedUrl } from "../server/storage.ts";
import { validateTimeline } from "../server/timelineValidation.ts";

const projectId = 60001;
const userId = 1;
const db = await getDb();
if (!db) throw new Error("Database storage is not available.");

const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
if (!project?.audioDurationMs) throw new Error("Finance project is missing an attached narration duration.");
const existingSegments = await db.select({ id: timelineSegments.id }).from(timelineSegments).where(eq(timelineSegments.projectId, projectId)).limit(1);
if (existingSegments.length) throw new Error("Finance already has a persisted timeline; refusing to overwrite a real review artifact.");
const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
const narration = assets.find(asset => asset.assetType === "narration");
const images = assets.filter(asset => asset.assetType === "image").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
if (!narration || !images.length) throw new Error("Finance media attachment is incomplete.");

await db.update(projects).set({ status: "analyzing", workerState: "processing" }).where(eq(projects.id, projectId));
try {
  const narrationUrl = await storageGetSignedUrl(narration.storageKey);
  const narrationResponse = await fetch(narrationUrl);
  if (!narrationResponse.ok) throw new Error("Could not retrieve the uploaded Finance narration from managed storage.");
  const narrationBytes = new Uint8Array(await narrationResponse.arrayBuffer());
  const transcriptionResult = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.transcribeAudio({ bytes: narrationBytes, filename: narration.originalFilename, mimeType: narration.mimeType ?? "audio/wav", language: "hi", prompt: "हिंदी या हिंग्लिश वित्तीय नैरेशन का सटीक प्रतिलेखन करें। नाम, संख्याएँ और वित्तीय शब्द ज्यों के त्यों रखें।" }), key }));
  const transcription = transcriptionResult.value;
  if (!transcription.text.trim() || !transcription.segments?.length) throw new Error("Groq Whisper returned no timestamped Finance narration segments.");

  const imageAnalyses = [];
  for (const image of images) {
    const imageUrl = await storageGetSignedUrl(image.storageKey);
    const analysisResult = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.analyzeImage({ imageUrl, prompt: "Analyze this image for a narration-driven finance video. Return valid JSON with exactly these string fields: sceneDescription, subjects, setting, mood, financeRelevance. Describe only what is visibly supported by the image; do not invent events, names, figures, or claims." }), key }));
    const analysis = analysisResult.value;
    const record = typeof analysis === "object" && analysis ? analysis : {};
    const sceneDescription = typeof record.sceneDescription === "string" && record.sceneDescription.trim() ? record.sceneDescription.trim() : null;
    if (!sceneDescription) throw new Error(`Groq returned no usable scene description for ${image.originalFilename}.`);
    imageAnalyses.push({ image, analysis: { ...record, provider: "groq", model: GROQ_VISION_MODEL, providerKeyLabel: analysisResult.key.label, providerKeyMasked: analysisResult.key.maskedKey, sceneDescription } });
  }

  const visualCatalog = imageAnalyses.map(({ image, analysis }) => ({ imageAssetId: image.id, scene: String(analysis.sceneDescription).slice(0, 180) }));
  const transcriptCatalog = transcription.segments.map(segment => ({ startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), text: segment.text })).filter(segment => segment.text.trim());
  if (!transcriptCatalog.length) throw new Error("Groq Whisper returned no usable Finance transcript beats.");
  if (transcriptCatalog.length > visualCatalog.length) throw new Error("Finance has more real narration beats than unique analyzed images, so a non-repeating genuine timeline cannot be created.");
  const selectedImageIds = new Set();
  const normalized = [];
  const selectionAudit = [];
  for (const [index, beat] of transcriptCatalog.entries()) {
    const availableImages = visualCatalog.filter(image => !selectedImageIds.has(image.imageAssetId));
    const compactChoices = availableImages.map((image, choice) => ({ choice: choice + 1, scene: image.scene }));
    const selectionPrompt = `Choose the best available image for this exact narration beat. Respond only as CHOICE=<integer>;CONFIDENCE=<decimal from 0 to 1>. CHOICE must be one of the listed choice numbers, not an image ID. Beat: ${JSON.stringify(beat)}. Choices: ${JSON.stringify(compactChoices)}`;
    const selectionResult = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeText({ prompt: selectionPrompt }), key }));
    const choiceMatches = Array.from(selectionResult.value.matchAll(/CHOICE\s*=\s*(\d+)/gi));
    const confidenceMatches = Array.from(selectionResult.value.matchAll(/CONFIDENCE\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)/gi));
    const selectedChoice = Number(choiceMatches.at(-1)?.[1]);
    const confidence = Number(confidenceMatches.at(-1)?.[1]);
    const chosenImage = availableImages[selectedChoice - 1];
    const chosenId = chosenImage?.imageAssetId;
    const selectionReason = chosenImage ? `Groq selected this image for the timestamped narration beat through the active rotation pool. Its genuine Groq scene analysis: ${chosenImage.scene}` : "";
    if (!chosenImage || !Number.isFinite(confidence)) throw new Error(`Groq returned an invalid Finance image choice for transcript beat ${index + 1}: ${selectionResult.value.slice(-300)}`);
    selectedImageIds.add(chosenId);
    normalized.push({ imageAssetId: chosenId, startMs: beat.startMs, endMs: beat.endMs, narrationText: beat.text.trim(), confidence, selectionReason, decisionType: "KEEP", index });
    selectionAudit.push({ providerKeyLabel: selectionResult.key.label, providerKeyMasked: selectionResult.key.maskedKey });
  }
  const validation = validateTimeline(project.audioDurationMs, normalized);
  if (!validation.valid) throw new Error(`Groq Finance timeline did not pass continuous-coverage validation: ${validation.issues.join(" ")}`);

  await db.transaction(async transaction => {
    await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: { provider: "groq", model: GROQ_TRANSCRIPTION_MODEL, providerKeyLabel: transcriptionResult.key.label, providerKeyMasked: transcriptionResult.key.maskedKey, text: transcription.text, language: transcription.language ?? "hi", segments: transcription.segments } }).where(eq(mediaAssets.id, narration.id));
    for (const { image, analysis } of imageAnalyses) await transaction.update(mediaAssets).set({ analysisState: "analyzed", analysisJson: analysis, embeddingSourceText: analysis.sceneDescription }).where(eq(mediaAssets.id, image.id));
    await transaction.insert(timelineSegments).values(normalized.map((segment, index) => ({ projectId, imageAssetId: segment.imageAssetId, startMs: segment.startMs, endMs: segment.endMs, narrationText: segment.narrationText, confidence: String(segment.confidence), selectionReason: segment.selectionReason, candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, ...selectionAudit[index] }, decisionType: segment.decisionType })));
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
  });
  console.log(JSON.stringify({ projectId, provider: "groq", transcriptionModel: GROQ_TRANSCRIPTION_MODEL, visionModel: GROQ_VISION_MODEL, segmentCount: normalized.length, validation }));
} catch (error) {
  await db.update(projects).set({ status: "failed", workerState: "error" }).where(eq(projects.id, projectId));
  console.error(error);
  process.exitCode = 1;
  throw error;
}
