import { describe, expect, it } from "vitest";
import { buildNativeRenderCommand, outputFolderSeed } from "./nativeRenderCommand";

describe("project-aware native render command", () => {
  it("uses configured source and output locations without Windows picker dialogs", () => {
    const command = buildNativeRenderCommand("Finance project", "C:\\Users\\sumit\\Downloads\\Finance", "Native output folder selected: Finance Exports");
    expect(command).toContain("$handoffPath = Join-Path $outputDirectory 'Finance_project-approved-render-handoff.json'");
    expect(command).toContain("Downloads\\Finance Exports");
    expect(command).not.toContain("OpenFileDialog");
  });

  it("keeps a legacy absolute Windows output path when one is stored", () => {
    expect(outputFolderSeed("C:\\Videos\\Exports")).toBe("'C:\\Videos\\Exports'");
  });
});
