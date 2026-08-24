import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/Timeline.tsx"), "utf8");

describe("Timeline editor presentation", () => {
  it("uses saved clip timing and preserves the existing approval action", () => {
    expect(source).toContain("Visual sequence editor");
    expect(source).toContain("segment.startMs");
    expect(source).toContain("segment.endMs");
    expect(source).toContain("onClick={() => approve.mutate(input)}");
    expect(source).toContain("Approve timeline for render");
  });

  it("represents existing effects and keeps Timeline view zoom presentation-only", () => {
    expect(source).toContain("visualSettings.crossfadeDurationMs");
    expect(source).toContain("resolvedZoomDirection(visualSettings, currentIndex)");
    expect(source).toContain("Timeline view");
    expect(source).toContain("original timing locked");
    expect(source).toContain("affect only this review interface");
  });
});
