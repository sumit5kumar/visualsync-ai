import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { GROQ_VISION_MODEL } from "../server/groqClient.ts";
import { executeWithGroqRotation } from "../server/groqPool.ts";
import { MIN_READABLE_IMAGE_DURATION_MS, buildGlobalReadableImageDurations } from "../server/readablePacing.ts";
import { validateTimeline } from "../server/timelineValidation.ts";

const projectId = 60001;
const userId = 1;
const db = await getDb();
if (!db) throw new Error("Database storage is not available.");

const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
if (!project?.audioDurationMs) throw new Error("Finance project is missing measured narration duration.");
const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.userId, userId)));
const narration = assets.find(asset => asset.assetType === "narration");
const images = assets.filter(asset => asset.assetType === "image" && asset.analysisState === "analyzed").sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
if (!narration || images.length !== 20) throw new Error("Finance requires the narration and all twenty analyzed script images.");
const transcriptSegments = Array.isArray(narration.analysisJson?.segments) ? narration.analysisJson.segments.map(segment => String(segment.text ?? "").trim()).filter(Boolean) : [];
if (!transcriptSegments.length) throw new Error("Finance requires its genuine Whisper transcription before pacing.");
const catalog = images.map((image, index) => ({ sequence: index + 1, scene: String(image.analysisJson?.sceneDescription ?? "").slice(0, 150) }));
if (catalog.some(item => !item.scene)) throw new Error("Every Finance source image needs its genuine Groq scene description.");

await db.update(projects).set({ status: "analyzing", workerState: "processing" }).where(eq(projects.id, projectId));
try {
  const pacingPrompt = `Create a calm, readable visual rhythm for one Hindi finance narration. The 20 supplied images are already in exact story order; retain that order and use every image exactly once. Do NOT constrain images to individual Whisper transcript boundaries. Plan the visual sequence over the full ${project.audioDurationMs} ms narration so each static image remains on screen for at least ${MIN_READABLE_IMAGE_DURATION_MS} ms. Use genuinely variable pacing: emphasis images may hold longer, but no image may be under the minimum. Return only valid JSON exactly shaped as {"weights":[1.1,0.9]}; weights must contain exactly 20 positive numbers and must not all be equal.\nFull narration in order: ${JSON.stringify(transcriptSegments)}\nImage sequence in order: ${JSON.stringify(catalog)}`;
  const pacingResult = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeJson({ prompt: pacingPrompt }), key }));
  const weights = Array.isArray(pacingResult.value?.weights) ? pacingResult.value.weights.map(value => Number(value)) : [];
  if (weights.length !== images.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error("Groq returned an invalid readable visual-pacing plan.");
  if (new Set(weights.map(weight => weight.toFixed(3))).size === 1) throw new Error("Groq returned equal visual pacing weights, which would violate the variable-duration rule.");
  const globalPacing = buildGlobalReadableImageDurations(project.audioDurationMs, weights);
  const durations = globalPacing.durations;
  if (durations.some(duration => duration < globalPacing.minimumDurationMs) || new Set(durations).size === 1) throw new Error("The regenerated Finance pacing plan is not readable and variable.");

  let cursor = 0;
  const rebuilt = images.map((image, index) => {
    const startMs = cursor;
    const endMs = startMs + durations[index];
    cursor = endMs;
    return { imageAssetId: image.id, startMs, endMs, narrationText: transcriptSegments.join(" "), confidence: Math.min(0.99, 0.72 + Math.min(weights[index], 2) * 0.1), selectionReason: `Groq retained this user-supplied script image at sequence ${image.sequenceNumber} in the full narration flow and assigned a readable variable pacing weight of ${weights[index]}, with a minimum on-screen hold of ${MIN_READABLE_IMAGE_DURATION_MS} ms enforced.`, decisionType: "KEEP" };
  });
  const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid || cursor !== project.audioDurationMs || rebuilt.length !== images.length) throw new Error(`Readable Finance timeline failed validation: ${validation.issues.join(" ")}`);

  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: pacingResult.key.label, pacingProviderKeyMasked: pacingResult.key.maskedKey, allImagesRequired: true, minReadableDurationMs: globalPacing.minimumDurationMs, pacingMethod: "global-full-narration-sequence" } })));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
  });
  console.log(JSON.stringify({ projectId, imageCount: rebuilt.length, minimumDurationMs: Math.min(...durations), maximumDurationMs: Math.max(...durations), validation }));
} catch (error) {
  await db.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
  console.error(error);
  process.exitCode = 1;
  throw error;
}
