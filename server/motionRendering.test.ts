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
    expect(worker).toContain('$transitionHalfSeconds = $transitionSeconds / 2.0');
    expect(worker).toContain('$fadeStart = [double]$current.endSeconds - $transitionHalfSeconds');
    expect(worker).toContain('$fadeEnd = [double]$current.endSeconds + $transitionHalfSeconds');
    expect(worker).toContain('$nextLocalSeconds = [Math]::Max(0.0, $timeSeconds - [double]$next.startSeconds)');
    expect(worker).toContain("function Test-FinalEncoder");
    expect(worker).toContain('"-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=0.1", "-frames:v", "1"');
    expect(worker).not.toContain('color=c=black:s=128x128:r=30:d=0.1');
    expect(worker).toContain('[ValidateSet("AUTO", "GPU", "CPU")][string]$RenderMode = "AUTO"');
    expect(worker).toContain("function Start-StageTelemetry");
    expect(worker).toContain("function Stop-StageTelemetry");
    expect(worker).toContain('Write-Output "RENDER_MODE_EFFECTIVE=$effectivePipelineMode"');
    expect(worker).toContain('Write-Output "CPU_BOUND_STAGES=continuous centered zoom frame generation; direct-opacity crossfade composition"');
    expect(worker).toContain('"-render-profile.json"');
    expect(worker).toContain("function Get-FinalVideoEncoder");
    expect(worker).toContain('label = "NVIDIA NVENC H.264"');
    expect(worker).toContain('label = "AMD AMF H.264"');
    expect(worker).toContain('label = "Intel Quick Sync H.264"');
    expect(worker).toContain('label = "CPU libx264 fallback"');
    expect(worker).toContain('"-c:v", "libx264", "-preset", "fast", "-crf", "16"');
    expect(worker).toContain('$finalEncoder = Get-FinalVideoEncoder');
    expect(worker).toContain('Write-Output "ENCODER=$($finalEncoder.label)"');
    expect(worker).toContain('"-g", ($FrameRate * 2).ToString(), "-keyint_min", $FrameRate.ToString()');
    expect(worker).not.toContain("zoompan=");
    expect(worker).not.toContain("perspective=");
    expect(worker).not.toContain("xfade=transition=");
    expect(worker).toContain("Draw-AlphaLayer $graphics $nextLayer $fadeProgress");
    expect(worker).toContain('$zoomEnabled = $true');
    expect(worker).toContain('if ($handoff.PSObject.Properties.Name -contains "zoom")');
    expect(worker).toContain('if (!$zoomEnabled)');
    expect(worker).toContain('$zoomAmountPercent = 8.0');
    expect(worker).toContain('$zoomDirection = "IN"');
    expect(worker).toContain('$crossfadeDurationMs = 800');
    expect(worker).toContain('if ($crossfadeDurationMs -notin @(0, 300, 500, 800, 1000, 1200))');
    expect(worker).toContain('$fastRender = !$zoomEnabled -and $crossfadeDurationMs -eq 0');
    expect(worker).toContain('if ($fastRender) {');
    expect(worker).toContain('concat=n=$($segments.Count):v=1:a=0[fastvideo]');
    expect(worker).toContain('CPU_BOUND_STAGES=none (Fast Render bypasses continuous zoom and alpha crossfade)');
    expect(worker).toContain('$transitionSeconds = $crossfadeDurationMs / 1000.0');
    expect(worker).toContain('$transitionHalfSeconds = $transitionSeconds / 2.0');
    expect(worker).toContain('"-pix_fmt", "yuv420p", "-r", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-fps_mode", "cfr"');
  });

  it("uses a center origin for every zoomed browser preview layer", () => {
    const styles = readFileSync(resolve(projectRoot, "client/src/index.css"), "utf8");

    expect(styles).toMatch(/\.vs-preview-active\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toMatch(/\.vs-preview-transition\s*\{\s*transform-origin:\s*center center;/);
    expect(styles).toContain("vs-preview-crossfade var(--preview-crossfade-duration, 800ms)");
  });

  it("keeps the Preview image alt text parseable and explains the final-encode GPU boundary", () => {
    const preview = readFileSync(resolve(projectRoot, "client/src/pages/Preview.tsx"), "utf8");

    expect(preview).toContain('alt={current.imageFilename ?? "Timeline image"}');
    expect(preview).toContain("ENCODER=NVIDIA NVENC H.264");
    expect(preview).toContain("The continuous zoom-frame preparation and direct-opacity crossfade compositor remain CPU-based");
    expect(preview).toContain("Fast Render");
    expect(preview).not.toContain("Import rendered MP4");
    expect(preview).not.toContain("Render history");
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
