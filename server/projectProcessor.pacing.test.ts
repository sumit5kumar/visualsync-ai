import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects, timelineSegments } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), rotate: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./groqPool", async importOriginal => ({ ...await importOriginal<typeof import("./groqPool")>(), executeWithGroqRotation: mocks.rotate }));
import { processProjectTimelineSlice, type TimelineGenerationWorkState } from "./projectProcessor";

type SavedSegment = { imageAssetId: number; startMs: number; endMs: number; selectionReason: string; candidateImagesJson: { pacingMethod: string } };

function setup(analysis: unknown, imageCount: number, durationMs: number) {
  const project = { id: 1, userId: 1, audioDurationMs: durationMs, timelineSyncMode: "ORDERED", readableHoldMode: "MIN_2_SECONDS" };
  const filenames = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 20];
  const assets = [
    { id: 1, userId: 1, projectId: 1, assetType: "narration", analysisState: "analyzed", analysisJson: analysis },
    ...Array.from({ length: imageCount }, (_, index) => ({ id: 100 + index, userId: 1, projectId: 1, assetType: "image", sequenceNumber: index + 1, originalFilename: `${imageCount === 18 ? filenames[index] : index + 1}_image.jpg`, analysisState: "analyzed", analysisJson: { sceneDescription: `Scene ${index}`, relevance: `Meaning ${index}` } })),
  ];
  const saved: SavedSegment[] = [];
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === projects ? [project] : assets;
      return Object.assign(Promise.resolve(rows), { limit: async () => rows });
    } }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
    insert: (table: unknown) => ({ values: (rows: SavedSegment[] | unknown) => {
      if (table === timelineSegments) saved.push(...rows as SavedSegment[]);
      return Object.assign(Promise.resolve(), { onDuplicateKeyUpdate: async () => undefined });
    } }),
    transaction: async (callback: (transaction: unknown) => Promise<void>) => callback(db),
  };
  const completePacingPlan = vi.fn();
  mocks.getDb.mockResolvedValue(db);
  mocks.rotate.mockImplementation(async (_userId, callback) => callback({ completePacingPlan }, { label: "test", maskedKey: "test" }));
  return { saved, completePacingPlan };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("hosted ordered pacing pipeline", () => {
  const fixture = JSON.parse(readFileSync(new URL("./sentenceAnchors.regression.json", import.meta.url), "utf8"));

  it.each([undefined, [], [null]])("recovers raw narration before validating broken merged segments: %j", async segments => {
    const { saved, completePacingPlan } = setup({ ...fixture.analysis, segments }, 18, fixture.audioDurationMs);
    completePacingPlan.mockResolvedValue({ anchors: fixture.expectedAnchors.map((line: number, index: number) => ({ sequence: index + 1, line })) });
    const first = await processProjectTimelineSlice(1, 1, { pacingAnchors: [0, 1], nextPacingBatch: 1 });
    expect(first.stage).toBe("building_timeline");
    expect(first.workState.pacingPlanVersion).toBe(3);
    expect(completePacingPlan).toHaveBeenCalledOnce();
    const prompt = completePacingPlan.mock.calls[0][0].prompt;
    expect(prompt).toContain('{"anchors":[[IMAGE_SEQUENCE_ID,LINE_INDEX],...]}');
    expect(prompt).toContain("पहले खर्च करते हैं");
    expect(prompt).toContain("Meaning:Meaning 11");
    const final = await processProjectTimelineSlice(1, 1, JSON.parse(JSON.stringify(first.workState)));
    expect(final.stage).toBe("completed");
    expect(completePacingPlan).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(18);
    expect(saved.find(segment => segment.imageAssetId === 111)).toMatchObject({ startMs: 40320, endMs: 42720 });
    expect(saved.at(-1)?.endMs).toBe(67451);
  });

  it.each(["malformed", "crammed"])("preserves the accepted first batch after a %s later batch and corrective retry", async failure => {
    const analysis = { segments: Array.from({ length: 100 }, (_, index) => ({ start: index * 3, end: index * 3 + 3, text: `Topic ${index}.` })) };
    const { saved, completePacingPlan } = setup(analysis, 32, 300_000);
    const firstAnchors = Array.from({ length: 24 }, (_, index) => index * 2);
    completePacingPlan.mockResolvedValueOnce({ anchors: firstAnchors.map((line, index) => ({ sequence: index + 1, line })) });
    completePacingPlan.mockResolvedValue(failure === "malformed" ? {} : { anchors: Array.from({ length: 8 }, (_, index) => ({ sequence: index + 25, line: 46 })) });
    let state: TimelineGenerationWorkState = {};
    let stage = "";
    for (let tick = 0; tick < 5 && stage !== "completed"; tick += 1) {
      const result = await processProjectTimelineSlice(1, 1, JSON.parse(JSON.stringify(state)));
      state = result.workState;
      stage = result.stage;
    }
    expect(stage).toBe("completed");
    expect(completePacingPlan).toHaveBeenCalledTimes(3);
    expect(saved).toHaveLength(32);
    expect(saved.slice(0, 24).map(segment => segment.startMs)).toEqual(firstAnchors.map(anchor => anchor * 3000));
    expect(saved[0].selectionReason).toContain("preserved the accepted content anchor");
    expect(saved.at(-1)?.endMs).toBe(300_000);
    expect(saved.every((segment, index) => segment.endMs > segment.startMs && (index === 0 || segment.startMs === saved[index - 1].endMs))).toBe(true);
  });
});
