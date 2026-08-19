import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Groq key provenance indicator", () => {
  const source = readFileSync(resolve(process.cwd(), "client/src/pages/Gemini.tsx"), "utf8");

  it("labels the audited Default Project suffix without exposing key material", () => {
    expect(source).toContain('const DEFAULT_PROJECT_AUDITED_GROQ_SUFFIX = "Ws5z"');
    expect(source).toContain("projectVerification");
    expect(source).toContain('"DEFAULT PROJECT VERIFIED"');
    expect(source).toContain('"EXTERNAL PROJECT UNVERIFIED"');
  });

  it("shows the real dual-model verification action while preserving masked provider controls", () => {
    expect(source).toContain("Verify project");
    expect(source).toContain("onVerify(item.id)");
    expect(source).toContain("STORED · EXCLUDED");
    expect(source).toContain("onTest(item.id)");
    expect(source).toContain("onRemove(item.id)");
  });
});
