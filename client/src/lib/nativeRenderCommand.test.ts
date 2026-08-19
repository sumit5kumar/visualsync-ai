import { describe, expect, it } from "vitest";
import { buildNativeRenderCommand, isAbsoluteWindowsDirectory, outputFolderSeed } from "./nativeRenderCommand";

describe("project-aware native render command", () => {
  it("uses configured source and output locations without Windows picker dialogs", () => {
    const command = buildNativeRenderCommand("Finance project", "D:\\Visuals\\Finance", "D:\\Exports\\Finance");
    expect(command).toContain("$handoffPath = Join-Path $outputDirectory 'Finance_project-approved-render-handoff.json'");
    expect(command).toContain("D:\\Exports\\Finance");
    expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File \".\\render-approved-handoff.ps1\"");
    expect(command).not.toContain('& ".\\render-approved-handoff.ps1"');
    expect(command).not.toContain("OpenFileDialog");
  });

  it("keeps an absolute Windows output path and recognizes drive or UNC directories", () => {
    expect(outputFolderSeed("C:\\Videos\\Exports")).toBe("'C:\\Videos\\Exports'");
    expect(isAbsoluteWindowsDirectory("D:\\Test")).toBe(true);
    expect(isAbsoluteWindowsDirectory("\\\\media-server\\exports")).toBe(true);
  });

  it("never invents a Downloads folder from a legacy picker label", () => {
    expect(outputFolderSeed("Native output folder selected: Test")).toBeNull();
    const command = buildNativeRenderCommand("Test", "Native source folder selected: Test", "Native output folder selected: Test");
    expect(command).toContain("OpenFileDialog");
    expect(command).not.toContain("Downloads\\Test");
  });
});
