import { eq } from "drizzle-orm";
import { mediaAssets } from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { prepareNarrationChunks } from "../server/projectProcessor.ts";

const db = await getDb();
if (!db) throw new Error("Database unavailable");
const [narration] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, 480001)).limit(1);
if (!narration) throw new Error("Five-minute narration asset not found");
const state = await prepareNarrationChunks(480001, narration, db);
console.log(JSON.stringify({ sourcePrepared: state.sourcePrepared, chunkOverlapMs: state.chunkOverlapMs, chunks: state.chunks.map((chunk, index) => ({ index: index + 1, byteSize: chunk.byteSize, startMs: chunk.startMs, endMs: chunk.endMs, contentStartMs: chunk.contentStartMs, contentEndMs: chunk.contentEndMs, status: chunk.status })) }, null, 2));
