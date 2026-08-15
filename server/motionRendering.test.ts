import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("middle-origin motion rendering", () => {
  it("uses a conservative 30-fps native zoom that keeps the output window centered while preserving direct crossfade and validated timing", () => {
    const worker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");

    expect(worker).toContain('"-framerate", "30"');
    expect(worker).toContain("scale=4224:2376:force_original_aspect_ratio=increase,crop=4224:2376");
    expect(worker).toContain("zoompan=z='min(zoom+$($zoomIncrement.ToString([System.Globalization.CultureInfo]::InvariantCulture))\\,$($zoomTarget.ToString([System.Globalization.CultureInfo]::InvariantCulture)))'");
    expect(worker).toContain("x='floor(iw/2-iw/(2*zoom))'");
    expect(worker).toContain("y='floor(ih/2-ih/(2*zoom))'");
    expect(worker).toContain("s=3840x2160:fps=30,scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int");
    expect(worker).toContain('"-sws_flags", "lanczos+accurate_rnd+full_chroma_int"');
    expect(worker).toContain('"-fps_mode", "cfr"');
    expect(worker).toContain('"-pix_fmt", "yuv420p"');
    expect(worker).toContain("[Math]::Min(1.08, 1.035 + ($durationSeconds * 0.006))");
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
