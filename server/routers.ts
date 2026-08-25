import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { activateGeminiKey, activateGroqKey, adjustTimelineBoundary, approveTimeline, createProjectRecord, deleteAllProjectRecords, deleteProjectRecord, getApprovedRenderHandoff, getRenderedProjectVideo, getStoredGeminiKey, getStoredGroqKey, getTimelineReview, listProjectTimeline, listRenderedProjectVideos, listTimelineCandidates, listUserProjects, listVisibleGeminiKeys, listVisibleGroqKeys, moveTimelineVisual, prepareProjectMediaImport, recordGeminiKeyTest, recordGroqKeyTest, recordGroqProjectVerification, removeGeminiKey, removeGroqKey, saveValidatedGeminiKey, saveValidatedGroqKey, substituteTimelineImage, updateProjectSetup, updateProjectZoomSettings } from "./db";
import { createHeartbeatJob, updateHeartbeatJob } from "./_core/heartbeat";
import { getTimelineGenerationJob, queueTimelineGenerationJob, runTimelineGenerationJob, setTimelineGenerationSchedule, TIMELINE_JOB_CRON } from "./timelineGenerationJobs";
import { signTimelineScheduleTask } from "./timelineScheduleAuth";
import { isAmbiguousHeartbeatUpdateTimeout } from "./timelineScheduleRecovery";
import { decryptSecret, describeApiKey, describeGeminiKey, encryptSecret, fingerprintSecret } from "./crypto";
import { GEMINI_MODEL, GeminiClient } from "./geminiClient";
import { GROQ_TRANSCRIPTION_MODEL, GROQ_VISION_MODEL, GroqClient } from "./groqClient";
import { canActivateGeminiKey, canActivateProviderKey, canRemoveGeminiKey, canRemoveProviderKey } from "./keyPolicy";
import { validateTimeline } from "./timelineValidation";
import { getWorkerCapabilities, workerPayloadSchemas } from "./workerContracts";

const projectInput = z.object({ name: z.string().trim().min(2).max(160), narrationOriginalName: z.string().trim().max(255).optional(), imageSourcePath: z.string().trim().max(2048).optional(), outputPath: z.string().trim().max(2048).optional() });
const proposedSegment = z.object({ startMs: z.number().finite(), endMs: z.number().finite(), imageAssetId: z.number().int().positive().nullable().optional(), narrationText: z.string(), confidence: z.number(), selectionReason: z.string(), decisionType: z.enum(["KEEP", "CHANGE", "SKIP", "FALLBACK"]) });
export function requestPublicOrigin(req: { protocol?: string; get?: (name: string) => string | undefined; headers: Record<string, unknown> }) {
  const originHeader = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
  for (const candidate of [originHeader, refererHeader]) {
    if (!candidate) continue;
    try { return new URL(candidate).origin; } catch { /* fall through to forwarded request metadata */ }
  }
  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"].split(",")[0].trim() : undefined;
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0].trim() : undefined;
  const host = forwardedHost || req.get?.("host");
  return host ? `${forwardedProto || req.protocol || "https"}://${host}` : undefined;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({ me: publicProcedure.query(opts => opts.ctx.user), logout: publicProcedure.mutation(({ ctx }) => { const cookieOptions = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 }); return { success: true } as const; }) }),
  project: router({ list: protectedProcedure.query(({ ctx }) => listUserProjects(ctx.user.id)), create: protectedProcedure.input(projectInput).mutation(async ({ ctx, input }) => ({ success: true as const, ...(await createProjectRecord(ctx.user.id, input)) })), updateSetup: protectedProcedure.input(z.object({ projectId: z.number().int().positive(), narrationOriginalName: z.string().trim().max(255).optional(), imageSourcePath: z.string().trim().max(2048).optional(), outputPath: z.string().trim().max(2048).optional() })).mutation(({ ctx, input }) => updateProjectSetup(ctx.user.id, input.projectId, input)), updateZoom: protectedProcedure.input(z.object({ projectId: z.number().int().positive(), enabled: z.boolean(), amountPercent: z.union([z.literal(3), z.literal(5), z.literal(8), z.literal(12)]), direction: z.enum(["IN", "OUT", "AUTO"]), crossfadeDurationMs: z.union([z.literal(0), z.literal(300), z.literal(500), z.literal(800), z.literal(1000), z.literal(1200)]), transitionType: z.enum(["NONE", "CROSSFADE", "FADE_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT", "CIRCLE_OPEN", "RANDOM"]).optional(), enabledTransitions: z.array(z.enum(["CROSSFADE", "FADE_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT", "CIRCLE_OPEN"])).min(1).optional(), enabledZoomDirections: z.array(z.enum(["IN", "OUT", "PAN_LEFT", "PAN_RIGHT", "DIAGONAL", "KEN_BURNS"])).min(1).optional() })).mutation(({ ctx, input }) => updateProjectZoomSettings(ctx.user.id, input.projectId, input)), remove: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).mutation(({ ctx, input }) => deleteProjectRecord(ctx.user.id, input.projectId)), removeAll: protectedProcedure.mutation(({ ctx }) => deleteAllProjectRecords(ctx.user.id)), prepareMediaImport: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).mutation(({ ctx, input }) => prepareProjectMediaImport(ctx.user.id, input.projectId)), processGlobalTimeline: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const previous = await getTimelineGenerationJob(ctx.user.id, input.projectId);
    const job = await queueTimelineGenerationJob(ctx.user.id, input.projectId);
    const sessionToken = parseCookie(ctx.req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
    if (!sessionToken) throw new Error("Sign in again before starting hosted Timeline Generation.");
    if (previous?.scheduleCronTaskUid) {
      let scheduleRefreshDeferred = false;
      try {
        await updateHeartbeatJob(previous.scheduleCronTaskUid, { cron: TIMELINE_JOB_CRON, path: "/api/scheduled/timeline-generation", method: "POST", payload: { taskUid: previous.scheduleCronTaskUid, signature: signTimelineScheduleTask(previous.scheduleCronTaskUid) }, enable: true, description: `Persistent Timeline Generation for project ${input.projectId}` }, sessionToken);
      } catch (error) {
        if (!isAmbiguousHeartbeatUpdateTimeout(error)) throw error;
        scheduleRefreshDeferred = true;
      }
      const dispatch = await runTimelineGenerationJob(job.id);
      return { jobId: job.id, status: "queued" as const, scheduled: true, scheduleRefreshDeferred, dispatch };
    }
    const schedule = await createHeartbeatJob({ name: `timeline-generation-${input.projectId}`, cron: TIMELINE_JOB_CRON, path: "/api/scheduled/timeline-generation", method: "POST", payload: {}, description: `Persistent Timeline Generation for project ${input.projectId}` }, sessionToken);
    let scheduleRefreshDeferred = false;
    try {
      await updateHeartbeatJob(schedule.taskUid, { payload: { taskUid: schedule.taskUid, signature: signTimelineScheduleTask(schedule.taskUid) } }, sessionToken);
    } catch (error) {
      if (!isAmbiguousHeartbeatUpdateTimeout(error)) throw error;
      scheduleRefreshDeferred = true;
    }
    await setTimelineGenerationSchedule(ctx.user.id, input.projectId, schedule.taskUid);
    const dispatch = await runTimelineGenerationJob(job.id);
    return { jobId: job.id, status: "queued" as const, scheduled: true, scheduleRefreshDeferred, nextExecutionAt: schedule.nextExecutionAt ?? null, dispatch };
  }), readablePacingPolicy: protectedProcedure.query(() => ({ useEverySourceImageInOrder: true, provider: "groq", preferredMinimumDurationMs: 2200, adaptiveMinimum: true, equalDurationFallbackAllowed: false })) }),
  gemini: router({
    model: publicProcedure.query(() => GEMINI_MODEL),
    list: protectedProcedure.query(({ ctx }) => listVisibleGeminiKeys(ctx.user.id)),
    addAndTest: protectedProcedure.input(z.object({ label: z.string().trim().min(1).max(80), apiKey: z.string().trim().min(16).max(512) })).mutation(async ({ ctx, input }) => { const apiKey = input.apiKey.trim(); const testResult = await new GeminiClient(apiKey).testKey(); if (testResult.status !== "verified") return { saved: false, ...testResult }; const encryption = encryptSecret(apiKey); const descriptor = describeGeminiKey(apiKey); await saveValidatedGeminiKey(ctx.user.id, { label: input.label, keyPrefix: descriptor.prefix, keySuffix: descriptor.suffix, keyFingerprint: fingerprintSecret(apiKey), encryptedCiphertext: encryption.ciphertext, encryptionIv: encryption.iv, encryptionTag: encryption.tag }); return { saved: true, ...testResult }; }),
    test: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const storedKey = await getStoredGeminiKey(ctx.user.id, input.keyId); if (!storedKey) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); const apiKey = decryptSecret({ ciphertext: storedKey.encryptedCiphertext, iv: storedKey.encryptionIv, tag: storedKey.encryptionTag }); const testResult = await new GeminiClient(apiKey).testKey(); await recordGeminiKeyTest(ctx.user.id, input.keyId, testResult.status); return testResult; }),
    activate: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const key = await getStoredGeminiKey(ctx.user.id, input.keyId); if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); if (!canActivateGeminiKey(key.testStatus)) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a successfully verified Gemini key can become active." }); await activateGeminiKey(ctx.user.id, input.keyId); return { success: true } as const; }),
    remove: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const keys = await listVisibleGeminiKeys(ctx.user.id); const target = keys.find(key => key.id === input.keyId); if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); const verifiedAlternatives = keys.filter(key => key.id !== input.keyId && key.testStatus === "verified"); if (!canRemoveGeminiKey(target.isActive, verifiedAlternatives.length)) throw new TRPCError({ code: "BAD_REQUEST", message: "Add and verify another key before removing the active key." }); await removeGeminiKey(ctx.user.id, input.keyId); return { success: true } as const; }),
  }),
  groq: router({
    models: publicProcedure.query(() => ({ transcription: GROQ_TRANSCRIPTION_MODEL, vision: GROQ_VISION_MODEL })),
    list: protectedProcedure.query(({ ctx }) => listVisibleGroqKeys(ctx.user.id)),
    addAndTest: protectedProcedure.input(z.object({ label: z.string().trim().min(1).max(80), apiKey: z.string().trim().regex(/^gsk_[A-Za-z0-9_-]{20,}$/, "Enter a Groq Cloud API key beginning with gsk_.") })).mutation(async ({ ctx, input }) => {
      const apiKey = input.apiKey.trim(); const testResult = await new GroqClient(apiKey).testKey();
      if (testResult.status !== "verified") return { saved: false, ...testResult };
      const encryption = encryptSecret(apiKey); const descriptor = describeApiKey(apiKey);
      await saveValidatedGroqKey(ctx.user.id, { label: input.label, keyPrefix: descriptor.prefix, keySuffix: descriptor.suffix, keyFingerprint: fingerprintSecret(apiKey), encryptedCiphertext: encryption.ciphertext, encryptionIv: encryption.iv, encryptionTag: encryption.tag });
      return { saved: true, ...testResult };
    }),
    test: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const storedKey = await getStoredGroqKey(ctx.user.id, input.keyId); if (!storedKey) throw new TRPCError({ code: "NOT_FOUND", message: "Groq key not found." });
      const testResult = await new GroqClient(decryptSecret({ ciphertext: storedKey.encryptedCiphertext, iv: storedKey.encryptionIv, tag: storedKey.encryptionTag })).testKey();
      await recordGroqKeyTest(ctx.user.id, input.keyId, testResult.status === "request_too_large" || testResult.status === "prompt_error" ? "unavailable" : testResult.status); return testResult;
    }),
    verifyProject: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const storedKey = await getStoredGroqKey(ctx.user.id, input.keyId); if (!storedKey) throw new TRPCError({ code: "NOT_FOUND", message: "Groq key not found." });
      const probe = await new GroqClient(decryptSecret({ ciphertext: storedKey.encryptedCiphertext, iv: storedKey.encryptionIv, tag: storedKey.encryptionTag })).verifyProjectModels();
      const normalizedStatus = probe.status === "request_too_large" || probe.status === "prompt_error" ? "unavailable" : probe.status;
      const persisted = await recordGroqProjectVerification(ctx.user.id, input.keyId, { ...probe, status: normalizedStatus });
      return { ...probe, ...persisted };
    }),
    activate: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const key = await getStoredGroqKey(ctx.user.id, input.keyId); if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Groq key not found." });
      if (!canActivateProviderKey(key.testStatus)) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a successfully verified Groq key can become active." });
      await activateGroqKey(ctx.user.id, input.keyId); return { success: true } as const;
    }),
    remove: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const keys = await listVisibleGroqKeys(ctx.user.id); const target = keys.find(key => key.id === input.keyId); if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Groq key not found." });
      const verifiedAlternatives = keys.filter(key => key.id !== input.keyId && key.testStatus === "verified");
      if (!canRemoveProviderKey(target.isActive, verifiedAlternatives.length)) throw new TRPCError({ code: "BAD_REQUEST", message: "Add and verify another Groq key before removing the active key." });
      await removeGroqKey(ctx.user.id, input.keyId); return { success: true } as const;
    }),
  }),
  timeline: router({
    list: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => listProjectTimeline(ctx.user.id, input.projectId)),
    review: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => getTimelineReview(ctx.user.id, input.projectId)),
    candidates: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => listTimelineCandidates(ctx.user.id, input.projectId)),
    approve: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).mutation(({ ctx, input }) => approveTimeline(ctx.user.id, input.projectId)),
    substituteImage: protectedProcedure.input(z.object({ projectId: z.number().int().positive(), segmentId: z.number().int().positive(), newImageAssetId: z.number().int().positive() })).mutation(({ ctx, input }) => substituteTimelineImage(ctx.user.id, input)),
    adjustBoundary: protectedProcedure.input(z.object({ projectId: z.number().int().positive(), segmentId: z.number().int().positive(), edge: z.enum(["start", "end"]), boundaryMs: z.number().int().nonnegative() })).mutation(({ ctx, input }) => adjustTimelineBoundary(ctx.user.id, input)),
    moveVisual: protectedProcedure.input(z.object({ projectId: z.number().int().positive(), sourceSegmentId: z.number().int().positive(), targetSegmentId: z.number().int().positive(), placement: z.enum(["swap", "before", "after"]).optional() })).mutation(({ ctx, input }) => moveTimelineVisual(ctx.user.id, input)),
    validate: protectedProcedure.input(z.object({ audioDurationMs: z.number().finite().positive(), segments: z.array(proposedSegment).min(1) })).mutation(({ input }) => validateTimeline(input.audioDurationMs, input.segments)),
  }),
  worker: router({
    status: protectedProcedure.query(() => ({ connected: false, message: "A local VisualSync worker is required for FAISS indexing and FFmpeg rendering." })),
    contract: protectedProcedure.query(() => getWorkerCapabilities()),
    renderHandoff: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(async ({ ctx, input }) => workerPayloadSchemas.renderHandoff.parse(await getApprovedRenderHandoff(ctx.user.id, input.projectId))),
    renderedVideo: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => getRenderedProjectVideo(ctx.user.id, input.projectId)),
    renderHistory: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => listRenderedProjectVideos(ctx.user.id, input.projectId)),
  }),
});
export type AppRouter = typeof appRouter;
