import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { activateGeminiKey, createProjectRecord, getStoredGeminiKey, listProjectTimeline, listUserProjects, listVisibleGeminiKeys, recordGeminiKeyTest, removeGeminiKey, saveValidatedGeminiKey } from "./db";
import { decryptSecret, describeGeminiKey, encryptSecret, fingerprintSecret } from "./crypto";
import { GEMINI_MODEL, GeminiClient } from "./geminiClient";
import { canActivateGeminiKey, canRemoveGeminiKey } from "./keyPolicy";
import { validateTimeline } from "./timelineValidation";
import { getWorkerCapabilities } from "./workerContracts";

const projectInput = z.object({ name: z.string().trim().min(2).max(160), narrationOriginalName: z.string().trim().max(255).optional(), imageSourcePath: z.string().trim().max(2048).optional(), outputPath: z.string().trim().max(2048).optional() });
const proposedSegment = z.object({ startMs: z.number().finite(), endMs: z.number().finite(), imageAssetId: z.number().int().positive().nullable().optional(), narrationText: z.string(), confidence: z.number(), selectionReason: z.string(), decisionType: z.enum(["KEEP", "CHANGE", "SKIP", "FALLBACK"]) });

export const appRouter = router({
  system: systemRouter,
  auth: router({ me: publicProcedure.query(opts => opts.ctx.user), logout: publicProcedure.mutation(({ ctx }) => { const cookieOptions = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 }); return { success: true } as const; }) }),
  project: router({ list: protectedProcedure.query(({ ctx }) => listUserProjects(ctx.user.id)), create: protectedProcedure.input(projectInput).mutation(async ({ ctx, input }) => { await createProjectRecord(ctx.user.id, input); return { success: true } as const; }) }),
  gemini: router({
    model: publicProcedure.query(() => GEMINI_MODEL),
    list: protectedProcedure.query(({ ctx }) => listVisibleGeminiKeys(ctx.user.id)),
    addAndTest: protectedProcedure.input(z.object({ label: z.string().trim().min(1).max(80), apiKey: z.string().trim().min(16).max(512) })).mutation(async ({ ctx, input }) => { const apiKey = input.apiKey.trim(); const testResult = await new GeminiClient(apiKey).testKey(); if (testResult.status !== "verified") return { saved: false, ...testResult }; const encryption = encryptSecret(apiKey); const descriptor = describeGeminiKey(apiKey); await saveValidatedGeminiKey(ctx.user.id, { label: input.label, keyPrefix: descriptor.prefix, keySuffix: descriptor.suffix, keyFingerprint: fingerprintSecret(apiKey), encryptedCiphertext: encryption.ciphertext, encryptionIv: encryption.iv, encryptionTag: encryption.tag }); return { saved: true, ...testResult }; }),
    test: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const storedKey = await getStoredGeminiKey(ctx.user.id, input.keyId); if (!storedKey) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); const apiKey = decryptSecret({ ciphertext: storedKey.encryptedCiphertext, iv: storedKey.encryptionIv, tag: storedKey.encryptionTag }); const testResult = await new GeminiClient(apiKey).testKey(); await recordGeminiKeyTest(ctx.user.id, input.keyId, testResult.status); return testResult; }),
    activate: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const key = await getStoredGeminiKey(ctx.user.id, input.keyId); if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); if (!canActivateGeminiKey(key.testStatus)) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a successfully verified Gemini key can become active." }); await activateGeminiKey(ctx.user.id, input.keyId); return { success: true } as const; }),
    remove: protectedProcedure.input(z.object({ keyId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const keys = await listVisibleGeminiKeys(ctx.user.id); const target = keys.find(key => key.id === input.keyId); if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Gemini key not found." }); const verifiedAlternatives = keys.filter(key => key.id !== input.keyId && key.testStatus === "verified"); if (!canRemoveGeminiKey(target.isActive, verifiedAlternatives.length)) throw new TRPCError({ code: "BAD_REQUEST", message: "Add and verify another key before removing the active key." }); await removeGeminiKey(ctx.user.id, input.keyId); return { success: true } as const; }),
  }),
  timeline: router({ list: protectedProcedure.input(z.object({ projectId: z.number().int().positive() })).query(({ ctx, input }) => listProjectTimeline(ctx.user.id, input.projectId)), validate: protectedProcedure.input(z.object({ audioDurationMs: z.number().finite().positive(), segments: z.array(proposedSegment).min(1) })).mutation(({ input }) => validateTimeline(input.audioDurationMs, input.segments)) }),
  worker: router({ status: protectedProcedure.query(() => ({ connected: false, message: "A local VisualSync worker is required for FAISS indexing and FFmpeg rendering." })), contract: protectedProcedure.query(() => getWorkerCapabilities()) }),
});
export type AppRouter = typeof appRouter;
