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

  it("uses one compact editor timeline with pointer drag, edge resizing, audio timing, and saved transition settings", () => {
    expect(source).toContain("function Workspace");
    expect(source).toContain("settings.crossfadeDurationMs");
    expect(source).toContain('data-clip-id={segment.id}');
    expect(source).toContain("onPointerMove={dragMove}");
    expect(source).toContain('aria-label="Resize end boundary"');
    expect(source).toContain("narration timing");
    expect(source).toContain('transition === "Crossfade"');
    expect(source).toContain("overflow-x-auto overflow-y-hidden");
    expect(source).toContain('data-insert-target={segment.id}');
    expect(source).toContain('data-insert-placement="before"');
    expect(source).toContain("insertRef.current = next");
    expect(source).toContain("<TimelineTrack");
    expect(source).toContain('document.addEventListener("click", saveTimelineTransition, true)');
    expect(source).toContain("onTransitionChange(toTransitionType(label))");
    expect(source).toContain("Random mix");
    expect(source).toContain("data-transition-duration");
    expect(source).toContain("data-zoom-amount");
    expect(source).toContain("Fast Render · no zoom / no transitions");
    expect(source).toContain("enabledZoomDirections");
  });
});
