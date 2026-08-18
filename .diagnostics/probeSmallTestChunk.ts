import { and, eq } from "drizzle-orm";
import { mediaAssets } from "../drizzle/schema";
import { getDb } from "../server/db";
import { executeWithGroqRotation } from "../server/groqPool";
import { splitMp3ForTranscription } from "../server/audioChunking";
import { mp3ToMonoWav } from "../server/audioTranscoding";
import { storageGetSignedUrl } from "../server/storage";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database storage is not available.");
  const [narration] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, 360001), eq(mediaAssets.assetType, "narration"))).limit(1);
  if (!narration) throw new Error("Test narration is unavailable.");
  const sourceResponse = await fetch(await storageGetSignedUrl(narration.storageKey));
  if (!sourceResponse.ok) throw new Error("Test narration could not be retrieved.");
  const first = splitMp3ForTranscription(new Uint8Array(await sourceResponse.arrayBuffer()), 1 * 1024 * 1024, 0)[0];
  const wavBytes = await mp3ToMonoWav(first.bytes);
  const run = await executeWithGroqRotation(1, async (client, key) => ({ key, value: await client.transcribeAudio({ bytes: wavBytes, filename: "narration-part-1.wav", mimeType: "audio/wav", language: "hi", prompt: "Transcribe the narration faithfully, preserving Hindi, Hinglish, financial terms, names, and numbers.", timeoutMs: 180_000 }) }));
  console.log(JSON.stringify({ byteSize: first.bytes.byteLength, durationMs: first.endMs - first.startMs, segmentCount: run.value.segments?.length ?? 0, requestDurationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, providerKey: run.key.maskedKey }));
}

void main();
