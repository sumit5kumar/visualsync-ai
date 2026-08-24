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
    expect(source).toContain("onPointerMove={moveDrag}");
    expect(source).toContain('aria-label="Resize end boundary"');
    expect(source).toContain("narration waveform");
    expect(source).toContain('transition === "Crossfade"');
    expect(source).toContain("overflow-x-auto overflow-y-hidden");
    expect(source).toContain("document.elementFromPoint(event.clientX, event.clientY)");
    expect(source).toContain("dropRef.current = target");
    expect(source).toContain('pointerEvents: drag?.id === segment.id ? "none" : "auto"');
  });
});
