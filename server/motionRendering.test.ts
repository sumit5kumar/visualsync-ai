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
    expect(worker).toContain('$fadeStart = [double]$current.startSeconds');
    expect(worker).toContain('$fadeEnd = $fadeStart + $transitionSeconds');
    expect(worker).toContain('while ($segmentIndex -lt ($segments.Count - 1) -and $timeSeconds -ge ([double]$segments[$segmentIndex].endSeconds))');
    expect(worker).toContain('$previous = $segments[$segmentIndex - 1]');
    expect(worker).toContain("function Test-FinalEncoder");
    expect(worker).toContain('$supportedOutputPresets = @("1920x1080:16:9", "1280x720:16:9", "854x480:16:9", "1080x1920:9:16", "720x1280:9:16", "480x854:9:16")');
    expect(worker).toContain('color=c=black:s=$canvasWidth`x$canvasHeight:r=30:d=0.1');
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
    expect(worker).toContain("function Draw-TransitionFrame");
    expect(worker).toContain('"CROSSFADE"');
    expect(worker).toContain('"FADE_BLACK"');
    expect(worker).toContain('"WIPE_LEFT"');
    expect(worker).toContain('"WIPE_RIGHT"');
    expect(worker).toContain('"SLIDE_LEFT"');
    expect(worker).toContain('"SLIDE_RIGHT"');
    expect(worker).toContain('"CIRCLE_OPEN"');
    expect(worker).toContain("function Get-TransitionType");
    expect(worker).toContain("return $enabledTransitions");
    expect(worker).toContain("function Get-DeterministicMixIndex");
    expect(worker).toContain('Get-DeterministicMixIndex "effect" $segmentSeed $enabledZoomDirections.Count');
    expect(worker).toContain('Get-DeterministicMixIndex "transition" $boundarySeed $enabledTransitions.Count');
    expect(worker).not.toContain('(($boundaryIndex * 17) + 3) % $enabledTransitions.Count');
    expect(worker).not.toContain('(($segmentIndex * 13) + 1) % $enabledZoomDirections.Count');
    expect(worker).toContain("Draw-TransitionFrame $graphics $previousLayer $currentLayer $fadeProgress $activeTransition");
    expect(worker).toContain('$zoomEnabled = $true');
    expect(worker).toContain('if ($handoff.PSObject.Properties.Name -contains "zoom")');
    expect(worker).toContain('if (!$zoomEnabled)');
    expect(worker).toContain('$zoomAmountPercent = 8.0');
    expect(worker).toContain('$zoomDirection = "IN"');
    expect(worker).toContain('$crossfadeDurationMs = 800');
    expect(worker).toContain('if ($crossfadeDurationMs -notin @(0, 300, 500, 800, 1000, 1200))');
    expect(worker).toContain('$fastRender = !$zoomEnabled -and ($crossfadeDurationMs -eq 0 -or $transitionType -eq "NONE")');
    expect(worker).toContain('if ($fastRender) {');
    expect(worker).toContain('$fastConcatPath = Join-Path $clipRoot "fast-render.ffconcat"');
    expect(worker).toContain('@("-hide_banner", "-loglevel", "warning", "-f", "concat", "-safe", "0", "-i", $fastConcatPath');
    expect(worker).toContain('Repeat the last file because ffconcat applies the preceding duration');
    expect(worker).not.toContain('concat=n=$($segments.Count):v=1:a=0[fastvideo]');
    expect(worker).toContain('if ($renderedOutputPath) { Write-Output "RENDERED=$renderedOutputPath" }');
    expect(worker).toContain('CPU_BOUND_STAGES=none (Fast Render bypasses continuous zoom and alpha crossfade)');
    expect(worker).toContain('$transitionSeconds = $crossfadeDurationMs / 1000.0');
    expect(worker).not.toContain('$fadeStart = [double]$current.endSeconds - $transitionHalfSeconds');
    expect(worker).toContain('"-pix_fmt", "yuv420p", "-r", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-fps_mode", "cfr"');
    expect(worker).toContain("Every effect paints a complete outgoing canvas before revealing the incoming visual");
    expect(worker).toContain('$progress = $progress * $progress * (3.0 - (2.0 * $progress))');
    expect(worker).toContain('if ($type -ne "CROSSFADE" -and $type -ne "NONE")');
    expect(worker).toContain('"PAN_LEFT", "PAN_RIGHT", "DIAGONAL", "KEN_BURNS"');
    expect(worker).toContain('function Get-BalancedMotionCornerIndex');
    expect(worker).toContain('Get-BalancedMotionCornerIndex "diagonal" $segmentIndex');
    expect(worker).toContain('Get-BalancedMotionCornerIndex "ken-burns" $segmentIndex');
    expect(worker).toContain('direction = "DIAGONAL_TR_BL"');
    expect(worker).toContain('direction = "KEN_BURNS_TR_BL"');
    expect(worker).toContain('startPanX');
    expect(worker).toContain('Test-DeterministicProductionFrames');
  });

  it("keeps explicit None controls in the Timeline sidebar without changing the transition or zoom contracts", () => {
    const timeline = readFileSync(resolve(projectRoot, "client/src/pages/Timeline.tsx"), "utf8");
    expect(timeline).toContain('data-transition-none="true"');
    expect(timeline).toContain('data-zoom-none="true"');
    expect(timeline).toContain('selectedTransition = "NONE"');
    expect(timeline).toContain('zoomEnabled = false');
    expect(timeline).toContain('"Pan left"');
    expect(timeline).toContain('"Pan right"');
    expect(timeline).toContain('"Diagonal pan"');
    expect(timeline).toContain('"Ken Burns mix"');
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
    expect(preview).toContain("The continuous zoom-frame preparation and full-canvas transition compositor remain CPU-based");
    expect(preview).toContain("Fast Render");
    expect(preview).toContain('aria-label="Transition type"');
    expect(preview).toContain('aria-label="Transition duration"');
    expect(preview).toContain("Random enabled transitions");
    expect(preview).toContain("Transitions used by Random");
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

  it("uses deterministic CPU zoom by default in production while retaining GEQ as an explicit fallback", () => {
    const productionWorker = readFileSync(resolve(projectRoot, "native-worker/render-approved-handoff.ps1"), "utf8");
    const experiment = readFileSync(resolve(projectRoot, "native-worker/render-deterministic-cpu-zoom-experiment.ps1"), "utf8");

    expect(productionWorker).toContain('[ValidateSet("DETERMINISTIC", "GEQ")][string]$ZoomRenderer = "DETERMINISTIC"');
    expect(productionWorker).toContain("function New-NormalizedDeterministicCanvas");
    expect(productionWorker).toContain("function Render-DeterministicProductionFrames");
    expect(productionWorker).toContain("function Test-DeterministicProductionFrames");
    expect(productionWorker).toContain("function Render-GeqFallbackFrames");
    expect(productionWorker).toContain('DETERMINISTIC_ZOOM_FALLBACK=GEQ');
    expect(productionWorker).toContain('Write-Output "ZOOM_RENDERER_EFFECTIVE=$($zoomRendererResults -join \',\')"');
    expect(productionWorker).toContain("zoomRendererRequested = $ZoomRenderer");
    expect(experiment).toContain("separate deterministic CPU zoom candidate");
    expect(experiment).toContain("function Render-GeqReferenceFrames");
    expect(experiment).toContain("function Render-DeterministicFrames");
    expect(experiment).toContain("Get-StabilityMetrics");
    expect(experiment).toContain("duplicateConsecutiveFramePairs");
    expect(experiment).toContain("cropPositionReversals");
    expect(experiment).toContain("SPEED_IMPROVEMENT_PERCENT=");
  });

  it("keeps the UI cleanup presentation-only by retaining the existing workflow controls", () => {
    const projects = readFileSync(resolve(projectRoot, "client/src/pages/Projects.tsx"), "utf8");
    const providers = readFileSync(resolve(projectRoot, "client/src/pages/Gemini.tsx"), "utf8");
    const timeline = readFileSync(resolve(projectRoot, "client/src/pages/Timeline.tsx"), "utf8");
    const preview = readFileSync(resolve(projectRoot, "client/src/pages/Preview.tsx"), "utf8");

    expect(projects).toContain("uploadMediaFile");
    expect(projects).toContain("processTimeline.mutateAsync");
    expect(projects).toContain("AbortController");
    expect(projects).toContain('setBusyLabel("Cancelling upload…")');
    expect(projects).toContain("onClear={selection.narration ? clearNarration : undefined}");
    expect(projects).toContain('aria-label={busy ? "Cancel upload" : "Close project setup"}');
    expect(projects).toContain("overflow-x-hidden overflow-y-auto");
    expect(projects).toContain('className="mt-3 w-full border-white/10');
    expect(projects).toContain("break-words text-xs leading-5");
    expect(projects).toContain("LiveProcessingStatus");
    expect(projects).toContain("processTimeline.mutateAsync");
    expect(projects).toContain("images.completed");
    expect(projects).toContain("Retry analysis");
    expect(projects).toContain("retryAnalysis");
    const processor = readFileSync(resolve(projectRoot, "server/projectProcessor.ts"), "utf8");
    expect(processor).toContain("prepareNarrationChunks");
    expect(processor).toContain("scanMp3FrameRanges");
    expect(processor).toContain("MP3_PREPARATION_SCAN_BYTES");
    expect(processor).toContain("loadNarrationChunkBytes(chunk)");
    expect(processor).toContain("fetchNarrationStorageRange(chunk.storageKey, chunk.sourceRange ? `bytes=${chunk.sourceRange.startByte}-${chunk.sourceRange.endByteExclusive - 1}` : undefined)");
    expect(processor).toContain("mp3ToMonoWav(bytes)");
    expect(processor).toContain("transcribeAudio({ bytes: wavBytes, filename: `narration-part-${index + 1}.wav`");
    expect(providers).toContain("groqActivate.mutate");
    expect(providers).toContain("geminiActivate.mutate");
    expect(timeline).toContain("approve.mutate(input)");
    expect(timeline).toContain("replace.mutate");
    expect(preview).toContain("updateZoom.mutate");
    expect(preview).toContain("buildNativeRenderCommand");
    expect(preview).toContain("Fast Render");
  });
});
