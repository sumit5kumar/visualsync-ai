import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project deletion controls", () => {
  it("requires a double confirmation for bulk deletion and labels active deletion work", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Projects.tsx"), "utf8");
    expect(source).toContain("Delete all ${count} projects?");
    expect(source).toContain("Final confirmation: delete every project now?");
    expect(source).toContain("Delete all projects");
    expect(source).toContain("Deleting all…");
    expect(source).toContain("Deleting…");
  });

  it("exposes a signed-in server-analysis resume control for a waiting hosted job", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Projects.tsx"), "utf8");
    expect(source).toContain('chunks?.state === "waiting"');
    expect(source).toContain("Resume server analysis");
    expect(source).toContain("onResume={() => retryAnalysis(project)}");
  });
});
