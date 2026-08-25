import { z } from "zod";

export const workerStageSchema = z.enum([
  "ingest_media",
  "analyze_audio",
  "analyze_images",
  "build_faiss_index",
  "build_timeline",
  "review_timeline",
  "render_mp4",
]);

export const workerAssetSchema = z.object({
  assetId: z.number().int().positive(),
  filename: z.string().min(1),
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative().nullable(),
  contentHash: z.string().min(1).nullable(),
  perceptualHash: z.string().min(1).nullable(),
});

export const workerJobSchema = z.object({
  jobId: z.string().uuid(),
  projectId: z.number().int().positive(),
  stage: workerStageSchema,
  createdAtMs: z.number().int().nonnegative(),
  output: z.object({ width: z.literal(1920), height: z.literal(1080), aspectRatio: z.literal("16:9") }),
  narration: workerAssetSchema.nullable(),
  images: z.array(workerAssetSchema),
  activeGeminiKeyRef: z.number().int().positive(),
  faissIndexKey: z.string().min(1).nullable(),
});

export const workerProgressSchema = z.object({
  jobId: z.string().uuid(),
  stage: workerStageSchema,
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive(),
  message: z.string().min(1),
  occurredAtMs: z.number().int().nonnegative(),
});

export const workerTimelineSubmissionSchema = z.object({
  projectId: z.number().int().positive(),
  audioDurationMs: z.number().finite().positive(),
  segments: z.array(z.object({
    imageAssetId: z.number().int().positive().nullable(),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().positive(),
    narrationText: z.string().min(1),
    confidence: z.number().min(0).max(1),
    selectionReason: z.string().min(1),
    candidateImages: z.array(z.object({ imageAssetId: z.number().int().positive(), score: z.number().min(0).max(1) })),
    decisionType: z.enum(["KEEP", "CHANGE", "SKIP", "FALLBACK"]),
  })).min(1),
});

export const workerRenderHandoffSchema = z.object({
  projectId: z.number().int().positive(),
  projectName: z.string().min(1),
  approval: z.object({ approvedByUserId: z.number().int().positive(), approvedAtMs: z.number().int().positive() }),
  nativePaths: z.object({ sourceDirectory: z.string().nullable(), outputDirectory: z.string().nullable() }),
  output: z.object({ width: z.number().int(), height: z.number().int(), aspectRatio: z.enum(["16:9", "9:16"]), container: z.literal("mp4"), filename: z.string().regex(/^[A-Za-z0-9_-]+_approved_(?:1920x1080|1280x720|854x480|1080x1920|720x1280|480x854)\.mp4$/) }).refine(output => [[1920, 1080, "16:9"], [1280, 720, "16:9"], [854, 480, "16:9"], [1080, 1920, "9:16"], [720, 1280, "9:16"], [480, 854, "9:16"]].some(([width, height, aspectRatio]) => output.width === width && output.height === height && output.aspectRatio === aspectRatio), "Unsupported approved render output preset"),
  zoom: z.object({ enabled: z.boolean(), amountPercent: z.union([z.literal(3), z.literal(5), z.literal(8), z.literal(12)]), direction: z.enum(["IN", "OUT", "AUTO"]), randomMix: z.boolean().default(false), enabledDirections: z.array(z.enum(["IN", "OUT", "PAN_LEFT", "PAN_RIGHT", "DIAGONAL", "KEN_BURNS"])).min(1) }),
  crossfade: z.object({ durationMs: z.union([z.literal(0), z.literal(300), z.literal(500), z.literal(800), z.literal(1000), z.literal(1200)]) }),
  transition: z.object({ type: z.enum(["NONE", "CROSSFADE", "FADE_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT", "CIRCLE_OPEN", "RANDOM"]), enabled: z.array(z.enum(["CROSSFADE", "FADE_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT", "CIRCLE_OPEN"])).min(1) }),
  narration: workerAssetSchema,
  images: z.array(workerAssetSchema).min(1),
  timeline: z.array(z.object({ imageAssetId: z.number().int().positive(), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), narrationText: z.string().min(1) })).min(1),
});

export type WorkerJob = z.infer<typeof workerJobSchema>;
export type WorkerProgress = z.infer<typeof workerProgressSchema>;
export type WorkerTimelineSubmission = z.infer<typeof workerTimelineSubmissionSchema>;
export type WorkerRenderHandoff = z.infer<typeof workerRenderHandoffSchema>;
