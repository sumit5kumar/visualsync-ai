import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("crossfade-only diagnostic rendering", () => {
  it("removes native zoom while preserving static framing, direct crossfade, and validated output timing", () => {
    const worker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");

    expect(worker).not.toContain("zoompan=");
    expect(worker).not.toContain("zoomTarget");
    expect(worker).not.toContain("zoomExpression");
    expect(worker).not.toContain("eval=frame");
    expect(worker).toContain("fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080");
    expect(worker).toContain("xfade=transition=fade");
    expect(worker).toContain("$transitionSeconds = 0.5");
    expect(worker).toContain("[vout]trim=duration=$timelineDuration,setpts=PTS-STARTPTS[vfinal]");
    expect(worker).toContain('"-map", "[vfinal]"');
  });

  it("uses a center origin for every zoomed browser preview layer", () => {
    const styles = readFileSync(resolve(projectRoot, "client/src/index.css"), "utf8");

    expect(styles).toMatch(/\.vs-preview-active\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toMatch(/\.vs-preview-transition\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toContain("vs-preview-crossfade 560ms");
  });
});
