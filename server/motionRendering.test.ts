import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("centered motion rendering", () => {
  it("keeps the FFmpeg zoompan crop centered as the zoom value increases", () => {
    const worker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");

    expect(worker).not.toContain("zoompan=");
    expect(worker).toContain("fps=30,scale=2112:1188:force_original_aspect_ratio=increase");
    expect(worker).toContain("scale=w='trunc(iw*$zoomExpression/2)*2'");
    expect(worker).toContain("crop=1920:1080:(in_w-out_w)/2:(in_h-out_h)/2");
    expect(worker).toContain("xfade=transition=fade");
    expect(worker).toContain("$transitionSeconds = 0.5");
    expect(worker).toContain("[Math]::Min(1.14, 1.05 + ($durationSeconds * 0.009))");
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
