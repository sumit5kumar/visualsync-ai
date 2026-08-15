import { and, eq } from "drizzle-orm";
import { mediaAssets, projects, timelineApprovals, timelineSegments } from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { GROQ_VISION_MODEL } from "../server/groqClient.ts";
import { executeWithGroqRotation } from "../server/groqPool.ts";
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
const currentSegments = await db.select().from(timelineSegments).where(eq(timelineSegments.projectId, projectId)).orderBy(timelineSegments.startMs);
if (!narration || images.length !== 20 || currentSegments.length !== 5) throw new Error("Finance requires its existing five genuine narration beats and all twenty analyzed script images.");

const narrationAnalysis = narration.analysisJson;
const beats = Array.isArray(narrationAnalysis?.segments) ? narrationAnalysis.segments.map((segment, index) => ({ index: index + 1, text: String(segment.text ?? "").trim(), startMs: currentSegments[index]?.startMs, endMs: currentSegments[index]?.endMs })).filter(beat => beat.text && Number.isInteger(beat.startMs) && Number.isInteger(beat.endMs)) : [];
if (beats.length !== 5) throw new Error("The genuine Finance Whisper beats are incomplete.");
const catalog = images.map((image, index) => ({ sequence: index + 1, scene: String(image.analysisJson?.sceneDescription ?? "").slice(0, 140) }));
if (catalog.some(image => !image.scene)) throw new Error("Every Finance image needs a genuine Groq scene description before all-image pacing.");

await db.update(projects).set({ status: "analyzing", workerState: "processing" }).where(eq(projects.id, projectId));
try {
  const pacingPrompt = `The user supplied these 20 images as one chronological visual sequence for this Hindi finance script. Use every image exactly once and do not reorder them. Assign each image to the narration beat it visually supports, preserving nondecreasing beat order and using every beat 1 through 5. Give a variable visual pacing weight for each image; weights must not all be equal. Return only valid JSON in this exact shape: {"assignments":[{"beat":1,"weight":1.2}]}. The assignments array must contain exactly 20 objects in image order.\nNarration beats: ${JSON.stringify(beats.map(({ index, text }) => ({ index, text })))}\nImage sequence: ${JSON.stringify(catalog)}`;
  const planResult = await executeWithGroqRotation(userId, async (client, key) => ({ value: await client.completeJson({ prompt: pacingPrompt }), key }));
  const assignments = Array.isArray(planResult.value?.assignments) ? planResult.value.assignments.map(item => ({ beat: Number(item?.beat), weight: Number(item?.weight) })) : [];
  if (assignments.length !== images.length || assignments.some(item => !Number.isInteger(item.beat) || item.beat < 1 || item.beat > beats.length || !Number.isFinite(item.weight) || item.weight <= 0)) throw new Error("Groq returned an invalid structured all-image pacing plan.");
  if (assignments.some((item, index) => index > 0 && item.beat < assignments[index - 1].beat) || new Set(assignments.map(item => item.beat)).size !== beats.length) throw new Error("Groq pacing plan did not preserve chronological image order or cover every narration beat.");
  if (new Set(assignments.map(item => item.weight.toFixed(3))).size === 1) throw new Error("Groq pacing plan used equal weights, which is not a valid variable-duration visual flow.");

  const rebuilt = [];
  for (const beat of beats) {
    const group = assignments.map((assignment, index) => ({ ...assignment, image: images[index] })).filter(item => item.beat === beat.index);
    const totalWeight = group.reduce((sum, item) => sum + item.weight, 0);
    let cursor = beat.startMs;
    for (const [groupIndex, item] of group.entries()) {
      const remaining = beat.endMs - cursor;
      const duration = groupIndex === group.length - 1 ? remaining : Math.max(1, Math.round((beat.endMs - beat.startMs) * (item.weight / totalWeight)));
      const endMs = groupIndex === group.length - 1 ? beat.endMs : Math.min(beat.endMs - (group.length - groupIndex - 1), cursor + duration);
      rebuilt.push({ imageAssetId: item.image.id, startMs: cursor, endMs, narrationText: beat.text, confidence: Math.min(0.99, 0.7 + Math.min(item.weight, 2) * 0.12), selectionReason: `Groq preserved this user-supplied script image at sequence ${item.image.sequenceNumber} and assigned it to narration beat ${beat.index} with a variable pacing weight of ${item.weight}.`, decisionType: "KEEP" });
      cursor = endMs;
    }
  }
  const validation = validateTimeline(project.audioDurationMs, rebuilt);
  if (!validation.valid || rebuilt.length !== images.length) throw new Error(`All-image Finance timeline failed validation: ${validation.issues.join(" ")}`);

  await db.transaction(async transaction => {
    await transaction.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId));
    await transaction.insert(timelineSegments).values(rebuilt.map(segment => ({ ...segment, projectId, confidence: String(segment.confidence), candidateImagesJson: { provider: "groq", model: GROQ_VISION_MODEL, pacingProviderKeyLabel: planResult.key.label, pacingProviderKeyMasked: planResult.key.maskedKey, allImagesRequired: true } })));
    await transaction.insert(timelineApprovals).values({ projectId, userId, status: "revoked", approvedAt: null }).onDuplicateKeyUpdate({ set: { userId, status: "revoked", approvedAt: null } });
    await transaction.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
  });
  console.log(JSON.stringify({ projectId, provider: "groq", imageCount: rebuilt.length, validation }));
} catch (error) {
  await db.update(projects).set({ status: "timeline_ready", workerState: "ready" }).where(eq(projects.id, projectId));
  console.error(error);
  process.exitCode = 1;
  throw error;
}
