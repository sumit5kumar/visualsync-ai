import { describe, expect, it } from "vitest";
import { projectSetupUpdateValues } from "./db";

describe("project setup path persistence", () => {
  it("updates only explicitly supplied setup fields so native-path edits retain uploaded narration metadata", () => {
    expect(projectSetupUpdateValues({ imageSourcePath: "D:\\Test", outputPath: "D:\\Test" })).toEqual({ imageSourcePath: "D:\\Test", outputPath: "D:\\Test" });
  });

  it("keeps deliberate empty values as null without overwriting omitted fields", () => {
    expect(projectSetupUpdateValues({ outputPath: "" })).toEqual({ outputPath: null });
  });
});
