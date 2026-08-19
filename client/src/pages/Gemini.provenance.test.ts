import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Groq key provenance indicator", () => {
  const source = readFileSync(resolve(process.cwd(), "client/src/pages/Gemini.tsx"), "utf8");

  it("labels the audited Default Project suffix without exposing key material", () => {
    expect(source).toContain('const DEFAULT_PROJECT_AUDITED_GROQ_SUFFIX = "Ws5z"');
    expect(source).toContain('key.maskedKey.endsWith(DEFAULT_PROJECT_AUDITED_GROQ_SUFFIX)');
    expect(source).toContain('"DEFAULT PROJECT VERIFIED"');
    expect(source).toContain('"EXTERNAL PROJECT UNVERIFIED"');
  });

  it("keeps provenance explicitly read-only and preserves existing provider controls", () => {
    expect(source).toContain("Project provenance is read-only");
    expect(source).toContain("This label does not change rotation, access, or key status.");
    expect(source).toContain("onTest(key.id)");
    expect(source).toContain("onActivate(key.id)");
    expect(source).toContain("onRemove(key.id)");
  });
});
