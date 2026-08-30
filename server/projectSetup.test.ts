import { describe, expect, it } from "vitest";
import { projectSetupUpdateValues } from "./db";

describe("project setup path persistence", () => {
  it("updates only explicitly supplied setup fields so native-path edits retain uploaded narration metadata", () => {
    expect(projectSetupUpdateValues({ imageSourcePath: "D:\\Test", outputPath: "D:\\Test" })).toEqual({ imageSourcePath: "D:\\Test", outputPath: "D:\\Test" });
  });

  it("keeps deliberate empty values as null without overwriting omitted fields", () => {
    expect(projectSetupUpdateValues({ outputPath: "" })).toEqual({ outputPath: null });
  });

  it("persists either explicit hold mode without changing unrelated setup fields", () => {
    expect(projectSetupUpdateValues({ readableHoldMode: "NO_MINIMUM" })).toEqual({ readableHoldMode: "NO_MINIMUM" });
    expect(projectSetupUpdateValues({ readableHoldMode: "MIN_2_SECONDS" })).toEqual({ readableHoldMode: "MIN_2_SECONDS" });
  });

  it("persists either semantic sync mode and keeps omitted sync mode untouched", () => {
    expect(projectSetupUpdateValues({ timelineSyncMode: "SEMANTIC_WEIGHTED" })).toEqual({ timelineSyncMode: "SEMANTIC_WEIGHTED" });
    expect(projectSetupUpdateValues({ timelineSyncMode: "ORDERED_PACING" })).toEqual({ timelineSyncMode: "ORDERED_PACING" });
    expect(projectSetupUpdateValues({ outputPath: "D:\\Output" })).toEqual({ outputPath: "D:\\Output" });
  });
});
