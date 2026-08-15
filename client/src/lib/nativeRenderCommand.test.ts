import { describe, expect, it } from "vitest";
import { buildNativeRenderCommand, outputFolderSeed } from "./nativeRenderCommand";

describe("project-aware native render command", () => {
  it("prefills the Windows output dialog from the current project’s selected output folder", () => {
    const command = buildNativeRenderCommand("Finance project", "Native output folder selected: Finance Exports");
    expect(command).toContain("$output.SelectedPath = Join-Path $env:USERPROFILE 'Downloads\\Finance Exports'");
    expect(command).toContain("# VisualSync approved render: Finance project");
  });

  it("keeps a legacy absolute Windows output path when one is stored", () => {
    expect(outputFolderSeed("C:\\Videos\\Exports")).toBe("'C:\\Videos\\Exports'");
  });
});
