import { describe, expect, it } from "vitest";
import { canActivateGeminiKey, canRemoveGeminiKey, isDuplicateGeminiKey } from "./keyPolicy";

describe("Gemini key workflow policy", () => {
  it("permits activation only after a real verified test result", () => {
    expect(canActivateGeminiKey("verified")).toBe(true);
    expect(canActivateGeminiKey("untested")).toBe(false);
    expect(canActivateGeminiKey("quota_limited")).toBe(false);
  });

  it("protects the only active verified key from removal", () => {
    expect(canRemoveGeminiKey(true, 0)).toBe(false);
    expect(canRemoveGeminiKey(true, 1)).toBe(true);
    expect(canRemoveGeminiKey(false, 0)).toBe(true);
  });

  it("detects duplicate fingerprints before encrypted records are saved", () => {
    expect(isDuplicateGeminiKey(["a", "b"], "b")).toBe(true);
    expect(isDuplicateGeminiKey(["a", "b"], "c")).toBe(false);
  });
});
