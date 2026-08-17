import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("middle-origin motion rendering", () => {
  it("uses user-approved continuous subpixel center zoom clips while preserving direct alpha crossfade and validated timing", () => {
    const worker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");

    expect(worker).toContain("[ValidateSet(30, 60)][int]$FrameRate = 30");
    expect(worker).toContain("function New-SubpixelCenteredZoomFilter");
    expect(worker).toContain("function Draw-AlphaLayer");
    expect(worker).toContain("geq=lum='lum($sourceX,$sourceY)'");
    expect(worker).toContain("interpolation=bilinear");
    expect(worker).toContain(".visualsync-subpixel-clips-");
    expect(worker).toContain(".visualsync-crossfade-");
    expect(worker).toContain("frame_{0:D6}.jpg");
    expect(worker).toContain("$frame.Save((Join-Path $frameDirectory");
    expect(worker).toContain("$jpegEncoder, $jpegParameters");
    expect(worker).toContain('(Join-Path $segment.frameDirectory "frame_%06d.jpg")');
    expect(worker).toContain('(Join-Path $frameDirectory "frame_%06d.jpg")');
    expect(worker).toContain("Remove-Item -Recurse -Force $frameDirectory");
    expect(worker).toContain('"-g", "1", "-keyint_min", "1", "-sc_threshold", "0", "-bf", "0"');
    expect(worker).toContain('"-x264-params", "keyint=1:min-keyint=1:scenecut=0:bframes=0:ref=1"');
    expect(worker).toContain('"-crf", "14"');
    expect(worker).not.toContain("zoompan=");
    expect(worker).not.toContain("perspective=");
    expect(worker).not.toContain("xfade=transition=");
    expect(worker).toContain("Draw-AlphaLayer $graphics $nextLayer $fadeProgress");
    expect(worker).toContain('$zoomAmountPercent = 5.0');
    expect(worker).toContain('$zoomDirection = "AUTO"');
    expect(worker).toContain("$transitionSeconds = 0.5");
    expect(worker).toContain('"-pix_fmt", "yuv420p", "-r", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-fps_mode", "cfr"');
  });

  it("uses a center origin for every zoomed browser preview layer", () => {
    const styles = readFileSync(resolve(projectRoot, "client/src/index.css"), "utf8");

    expect(styles).toMatch(/\.vs-preview-active\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toMatch(/\.vs-preview-transition\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toContain("vs-preview-crossfade 560ms");
  });

  it("keeps the editor-style staged zoom diagnostic free of continuous per-frame zoom filters", () => {
    const stagedRenderer = readFileSync(resolve(projectRoot, "native-worker/render-staged-zoom-test.ps1"), "utf8");

    expect(stagedRenderer).toContain("$stageCount = 12");
    expect(stagedRenderer).toContain("$blendDuration = 1.0");
    expect(stagedRenderer).toContain("xfade=transition=fade");
    expect(stagedRenderer).not.toContain("zoompan=");
    expect(stagedRenderer).not.toContain("eval=frame");
  });

  it("defines the required isolated continuous centered zoom verification matrix before timeline integration", () => {
    const continuousTestRenderer = readFileSync(resolve(projectRoot, "native-worker/render-continuous-center-zoom-tests.ps1"), "utf8");

    expect(continuousTestRenderer).toContain("$durations = @(1, 2, 5, 10)");
    expect(continuousTestRenderer).toContain('name = "off"; startZoom = 1.00; endZoom = 1.00');
    expect(continuousTestRenderer).toContain('name = "in"; startZoom = 1.00; endZoom = 1.05');
    expect(continuousTestRenderer).toContain('name = "out"; startZoom = 1.05; endZoom = 1.00');
    expect(continuousTestRenderer).toContain("geq=lum='lum($sourceX,$sourceY)'");
    expect(continuousTestRenderer).toContain("interpolation=bilinear");
    expect(continuousTestRenderer).toContain("in_range=pc:out_range=tv");
    expect(continuousTestRenderer).toContain("-count_frames");
    expect(continuousTestRenderer).toContain("$outputWidth = 1920");
    expect(continuousTestRenderer).toContain("$outputHeight = 1080");
    expect(continuousTestRenderer).toContain("$frameRate = 30");
    expect(continuousTestRenderer).not.toContain("zoompan=");
    expect(continuousTestRenderer).not.toContain("perspective=");
  });
});
