import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("centered motion rendering", () => {
  it("keeps the FFmpeg zoompan crop centered as the zoom value increases", () => {
    const worker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");

    expect(worker).toContain("x='floor((iw-ow/zoom)/2)'");
    expect(worker).toContain("y='floor((ih-oh/zoom)/2)'");
    expect(worker).toContain("xfade=transition=fade");
    expect(worker).toContain("$transitionSeconds = 0.55");
    expect(worker).toContain("[Math]::Min(1.17, 1.06 + ($durationSeconds * 0.011))");
    expect(worker).toContain("$durationSeconds * 30 * 0.9");
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
