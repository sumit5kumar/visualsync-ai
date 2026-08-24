import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/Timeline.tsx"), "utf8");

describe("Timeline editor presentation", () => {
  it("uses saved clip timing and preserves the existing approval action", () => {
    expect(source).toContain("VisualSync <span className=\"text-cyan-200\">Timeline Editor</span>");
    expect(source).toContain("segment.startMs");
    expect(source).toContain("segment.endMs");
    expect(source).toContain("onApprove={() => approve.mutate(input)}");
    expect(source).toContain("Approve Timeline");
  });

  it("represents existing effects and keeps Timeline view zoom presentation-only", () => {
    expect(source).toContain("visualSettings.crossfadeDurationMs");
    expect(source).toContain("resolvedZoomDirection(visualSettings, currentIndex)");
    expect(source).toContain("Timeline view");
    expect(source).toContain("activeRenderTransition");
    expect(source).toContain("transitionChoices");
    expect(source).toContain("non-crossfade transition choices affect only this Timeline interface");
  });
});
