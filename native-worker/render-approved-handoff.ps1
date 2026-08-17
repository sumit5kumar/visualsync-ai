param(
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$FFmpegPath = "ffmpeg",
  [ValidateSet(30, 60)][int]$FrameRate = 30,
  [ValidateSet("AUTO", "GPU", "CPU")][string]$RenderMode = "AUTO"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $HandoffPath)) { throw "Approved render handoff not found: $HandoffPath" }
if (!(Test-Path $SourceDirectory)) { throw "Source directory not found: $SourceDirectory" }
if (!(Test-Path $OutputDirectory)) { throw "Output directory not found: $OutputDirectory" }
if (!(Test-Path $FFmpegPath)) { throw "FFmpeg executable not found: $FFmpegPath" }

Add-Type -AssemblyName System.Drawing

$handoff = Get-Content -Raw $HandoffPath | ConvertFrom-Json
if (!$handoff.approval.approvedAtMs -or !$handoff.approval.approvedByUserId) { throw "Rendering is blocked because the timeline handoff is not approved." }
if ($handoff.output.width -ne 1920 -or $handoff.output.height -ne 1080 -or $handoff.output.container -ne "mp4" -or !$handoff.output.filename) { throw "The worker accepts only the approved project-specific 1920x1080 MP4 contract." }

$canvasWidth = 1920
$canvasHeight = 1080
$oversizedWidth = 2112
$oversizedHeight = 1188
$transitionSeconds = 0.8
$zoomEnabled = $true
$zoomAmountPercent = 8.0
$zoomDirection = "IN"
$crossfadeDurationMs = 800

if ($handoff.PSObject.Properties.Name -contains "zoom") {
  $zoomSettings = $handoff.zoom
  if ($zoomSettings.PSObject.Properties.Name -contains "enabled") { $zoomEnabled = [bool]$zoomSettings.enabled }
  if ($zoomSettings.PSObject.Properties.Name -contains "amountPercent") { $zoomAmountPercent = [double]$zoomSettings.amountPercent }
  if ($zoomSettings.PSObject.Properties.Name -contains "direction") { $zoomDirection = ([string]$zoomSettings.direction).ToUpperInvariant() }
}
if ($handoff.PSObject.Properties.Name -contains "crossfade") {
  $crossfadeSettings = $handoff.crossfade
  if ($crossfadeSettings.PSObject.Properties.Name -contains "durationMs") { $crossfadeDurationMs = [int]$crossfadeSettings.durationMs }
}
if ($zoomAmountPercent -notin @(3.0, 5.0, 8.0, 12.0)) { $zoomAmountPercent = 8.0 }
if ($zoomDirection -notin @("IN", "OUT", "AUTO")) { $zoomDirection = "IN" }
if ($crossfadeDurationMs -notin @(300, 500, 800, 1000, 1200)) { $crossfadeDurationMs = 800 }
$transitionSeconds = $crossfadeDurationMs / 1000.0
$transitionHalfSeconds = $transitionSeconds / 2.0

$assetNames = @{}
foreach ($image in $handoff.images) { $assetNames[[string]$image.assetId] = $image.filename }
$narrationPath = Join-Path $SourceDirectory $handoff.narration.filename
if (!(Test-Path $narrationPath)) { throw "Narration file missing from source directory: $narrationPath" }

function Format-Number([double]$value) {
  return $value.ToString("0.0000000000", [System.Globalization.CultureInfo]::InvariantCulture)
}

function Start-StageTelemetry() {
  # Local Windows counters provide device-level samples without changing any
  # generated pixels, timeline timing, zoom math, or crossfade composition.
  return Start-Job -ScriptBlock {
    while ($true) {
      try {
        $cpu = (Get-Counter -Counter "\Processor Information(_Total)\% Processor Time").CounterSamples | Select-Object -First 1
        $gpu = Get-Counter -Counter "\GPU Engine(*)\Utilization Percentage"
        $gpuMemory = Get-Counter -Counter "\GPU Adapter Memory(*)\Dedicated Usage"
        $gpuValues = @($gpu.CounterSamples | ForEach-Object { [double]$_.CookedValue })
        $videoEncodeValues = @($gpu.CounterSamples | Where-Object { $_.Path -match "engtype_(VideoEncode|Encode)" } | ForEach-Object { [double]$_.CookedValue })
        $memoryValues = @($gpuMemory.CounterSamples | ForEach-Object { [double]$_.CookedValue })
        [pscustomobject]@{
          capturedAt = (Get-Date).ToUniversalTime().ToString("o")
          systemCpuPercent = [Math]::Round([double]$cpu.CookedValue, 2)
          gpuEnginePeakPercent = if ($gpuValues.Count) { [Math]::Round(($gpuValues | Measure-Object -Maximum).Maximum, 2) } else { $null }
          gpuVideoEncodePeakPercent = if ($videoEncodeValues.Count) { [Math]::Round(($videoEncodeValues | Measure-Object -Maximum).Maximum, 2) } else { $null }
          gpuDedicatedMemoryPeakBytes = if ($memoryValues.Count) { [Math]::Round(($memoryValues | Measure-Object -Maximum).Maximum, 0) } else { $null }
          counterError = $null
        }
      } catch {
        [pscustomobject]@{
          capturedAt = (Get-Date).ToUniversalTime().ToString("o")
          systemCpuPercent = $null
          gpuEnginePeakPercent = $null
          gpuVideoEncodePeakPercent = $null
          gpuDedicatedMemoryPeakBytes = $null
          counterError = $_.Exception.Message
        }
      }
      Start-Sleep -Seconds 1
    }
  }
}

function Stop-StageTelemetry([object]$job) {
  if (!$job) {
    return [pscustomobject]@{ sampleCount = 0; cpuAveragePercent = $null; cpuPeakPercent = $null; gpuEnginePeakPercent = $null; gpuVideoEncodePeakPercent = $null; gpuDedicatedMemoryPeakBytes = $null; counterErrors = @() }
  }
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  $samples = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  $cpuValues = @($samples | Where-Object { $null -ne $_.systemCpuPercent } | ForEach-Object { [double]$_.systemCpuPercent })
  $gpuValues = @($samples | Where-Object { $null -ne $_.gpuEnginePeakPercent } | ForEach-Object { [double]$_.gpuEnginePeakPercent })
  $videoEncodeValues = @($samples | Where-Object { $null -ne $_.gpuVideoEncodePeakPercent } | ForEach-Object { [double]$_.gpuVideoEncodePeakPercent })
  $memoryValues = @($samples | Where-Object { $null -ne $_.gpuDedicatedMemoryPeakBytes } | ForEach-Object { [double]$_.gpuDedicatedMemoryPeakBytes })
  return [pscustomobject]@{
    sampleCount = $samples.Count
    cpuAveragePercent = if ($cpuValues.Count) { [Math]::Round(($cpuValues | Measure-Object -Average).Average, 2) } else { $null }
    cpuPeakPercent = if ($cpuValues.Count) { [Math]::Round(($cpuValues | Measure-Object -Maximum).Maximum, 2) } else { $null }
    gpuEnginePeakPercent = if ($gpuValues.Count) { [Math]::Round(($gpuValues | Measure-Object -Maximum).Maximum, 2) } else { $null }
    gpuVideoEncodePeakPercent = if ($videoEncodeValues.Count) { [Math]::Round(($videoEncodeValues | Measure-Object -Maximum).Maximum, 2) } else { $null }
    gpuDedicatedMemoryPeakBytes = if ($memoryValues.Count) { [Math]::Round(($memoryValues | Measure-Object -Maximum).Maximum, 0) } else { $null }
    counterErrors = @($samples | Where-Object { $_.counterError } | Select-Object -ExpandProperty counterError -Unique)
  }
}

function Get-ZoomPlan([int]$segmentIndex) {
  if (!$zoomEnabled) {
    return [pscustomobject]@{ startZoom = 1.0; endZoom = 1.0; direction = "OFF" }
  }

  $amount = $zoomAmountPercent / 100.0
  $direction = $zoomDirection
  if ($direction -eq "AUTO") { $direction = if (($segmentIndex % 2) -eq 0) { "IN" } else { "OUT" } }
  if ($direction -eq "OUT") {
    return [pscustomobject]@{ startZoom = 1.0 + $amount; endZoom = 1.0; direction = "OUT" }
  }
  return [pscustomobject]@{ startZoom = 1.0; endZoom = 1.0 + $amount; direction = "IN" }
}

function New-SubpixelCenteredZoomFilter([double]$startZoom, [double]$endZoom, [int]$frameCount) {
  $denominator = [Math]::Max(1, $frameCount - 1)
  $start = Format-Number $startZoom
  $delta = Format-Number ($endZoom - $startZoom)
  $zoom = "($start+($delta*N/$denominator))"
  $centerX = Format-Number ($oversizedWidth / 2.0)
  $centerY = Format-Number ($oversizedHeight / 2.0)
  $sourceX = "$centerX+(X-$centerX)/$zoom"
  $sourceY = "$centerY+(Y-$centerY)/$zoom"
  $normalize = "scale=$oversizedWidth`:$oversizedHeight`:force_original_aspect_ratio=increase:flags=lanczos,crop=$oversizedWidth`:$oversizedHeight,setsar=1,format=yuv444p"

  # This is one continuous source-to-canvas transform. GEQ samples fractional source coordinates with bilinear interpolation;
  # it does not animate crop dimensions or rounded crop positions.
  return "$normalize,geq=lum='lum($sourceX,$sourceY)':cb='cb($sourceX,$sourceY)':cr='cr($sourceX,$sourceY)':interpolation=bilinear,scale=$canvasWidth`:$canvasHeight`:flags=lanczos:in_range=pc:out_range=tv,setsar=1,format=yuv420p"
}

function Test-FinalEncoder([string[]]$encoderArguments) {
  $probePath = Join-Path $OutputDirectory (".visualsync-encoder-probe-" + [Guid]::NewGuid().ToString("N") + ".mp4")
  try {
    # Probe at the same 1920x1080 geometry used by the final encoder. Some NVENC
    # driver profiles reject the old 128x128 test with an invalid-parameter error
    # despite successfully encoding the approved output contract.
    $probeArguments = @(
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=0.1", "-frames:v", "1"
    ) + $encoderArguments + @("-pix_fmt", "yuv420p", "-y", $probePath)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $FFmpegPath @probeArguments 2>$null
    $probeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    return $probeExitCode -eq 0 -and (Test-Path $probePath) -and (Get-Item $probePath).Length -gt 0
  } finally {
    if (Test-Path $probePath) { Remove-Item -Force $probePath }
  }
}

function Get-FinalVideoEncoder([string]$mode) {
  if ($mode -eq "CPU") {
    return [pscustomobject]@{ label = "CPU libx264 (requested)"; acceleration = "CPU"; arguments = @("-c:v", "libx264", "-preset", "fast", "-crf", "16") }
  }
  # Each hardware encoder is verified through an actual tiny MP4 encode instead of relying on
  # FFmpeg merely listing a compiled-in encoder. This safely handles missing or outdated drivers.
  $candidates = @(
    [pscustomobject]@{ label = "NVIDIA NVENC H.264"; acceleration = "GPU"; arguments = @("-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc:v", "vbr", "-cq:v", "18", "-b:v", "0") },
    [pscustomobject]@{ label = "AMD AMF H.264"; acceleration = "GPU"; arguments = @("-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18") },
    [pscustomobject]@{ label = "Intel Quick Sync H.264"; acceleration = "GPU"; arguments = @("-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "18") }
  )
  foreach ($candidate in $candidates) {
    if (Test-FinalEncoder $candidate.arguments) {
      return $candidate
    }
  }
  return [pscustomobject]@{ label = "CPU libx264 fallback"; acceleration = "CPU"; arguments = @("-c:v", "libx264", "-preset", "fast", "-crf", "16") }
}

function Open-ClipFrame([object]$segment, [int]$frameIndex) {
  $safeIndex = [Math]::Min([Math]::Max(0, $frameIndex), [int]$segment.frameCount - 1)
  $framePath = Join-Path $segment.frameDirectory ("frame_{0:D6}.jpg" -f $safeIndex)
  if (!(Test-Path $framePath)) { throw "Rendered zoom frame missing: $framePath" }
  return [System.Drawing.Image]::FromFile($framePath)
}

function Get-ClipFrameIndex([object]$segment, [double]$localSeconds) {
  $rawFrame = [Math]::Floor(([Math]::Max(0.0, $localSeconds) * $FrameRate) + 0.000001)
  return [int][Math]::Min($rawFrame, [int]$segment.frameCount - 1)
}

function Draw-AlphaLayer([System.Drawing.Graphics]$graphics, [System.Drawing.Image]$layer, [double]$opacity) {
  $destination = New-Object System.Drawing.Rectangle(0, 0, $canvasWidth, $canvasHeight)
  $attributes = New-Object System.Drawing.Imaging.ImageAttributes
  $matrix = New-Object System.Drawing.Imaging.ColorMatrix
  $matrix.Matrix33 = [single]$opacity
  $attributes.SetColorMatrix($matrix)
  $graphics.DrawImage($layer, $destination, 0, 0, $canvasWidth, $canvasHeight, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
  $attributes.Dispose()
}

$segments = @()
$clipRoot = Join-Path $OutputDirectory (".visualsync-subpixel-clips-" + [Guid]::NewGuid().ToString("N"))
$frameDirectory = Join-Path $OutputDirectory (".visualsync-crossfade-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $clipRoot -Force | Out-Null
New-Item -ItemType Directory -Path $frameDirectory -Force | Out-Null

foreach ($segmentIndex in 0..($handoff.timeline.Count - 1)) {
  $timelineSegment = $handoff.timeline[$segmentIndex]
  $filename = $assetNames[[string]$timelineSegment.imageAssetId]
  if (!$filename) { throw "Timeline image asset $($timelineSegment.imageAssetId) is absent from the approved handoff." }
  $imagePath = Join-Path $SourceDirectory $filename
  if (!(Test-Path $imagePath)) { throw "Timeline image missing from source directory: $imagePath" }
  $startSeconds = ([double]$timelineSegment.startMs) / 1000
  $endSeconds = ([double]$timelineSegment.endMs) / 1000
  $durationSeconds = $endSeconds - $startSeconds
  if ($durationSeconds -le 0) { throw "Timeline contains a non-positive duration for image: $filename" }
  $frameCount = [Math]::Max(1, [int][Math]::Ceiling($durationSeconds * $FrameRate))
  $plan = Get-ZoomPlan $segmentIndex
  $segments += [pscustomobject]@{
    filename = $filename
    imagePath = $imagePath
    startSeconds = $startSeconds
    endSeconds = $endSeconds
    durationSeconds = $durationSeconds
    frameCount = $frameCount
    frameDirectory = (Join-Path $clipRoot ("clip_{0:D4}" -f $segmentIndex))
    zoomStart = $plan.startZoom
    zoomEnd = $plan.endZoom
    zoomDirection = $plan.direction
  }
}

$jpegEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$jpegParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
$jpegParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 95L)
$renderStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$clipTelemetryJob = $null
$compositionTelemetryJob = $null
$encodeTelemetryJob = $null

try {
  $clipStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $clipTelemetryJob = Start-StageTelemetry
  $clipPosition = 0
  foreach ($segment in $segments) {
    New-Item -ItemType Directory -Path $segment.frameDirectory -Force | Out-Null
    $filter = New-SubpixelCenteredZoomFilter $segment.zoomStart $segment.zoomEnd $segment.frameCount
    $clipArguments = @(
      "-hide_banner", "-loglevel", "warning",
      "-loop", "1", "-framerate", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-i", $segment.imagePath,
      "-vf", $filter,
      "-frames:v", $segment.frameCount.ToString(),
      "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p",
      "-start_number", "0", "-y", (Join-Path $segment.frameDirectory "frame_%06d.jpg")
    )
    Write-Progress -Activity "Rendering continuous centered zoom clips" -Status "$($segment.filename) ($($segment.zoomDirection), $($zoomAmountPercent)%)" -PercentComplete (($clipPosition / [double]$segments.Count) * 45)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $FFmpegPath @clipArguments
    $clipExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($clipExitCode -ne 0) { throw "FFmpeg failed while building the continuous zoom clip for $($segment.filename) with exit code $clipExitCode" }
    if (!(Test-Path (Join-Path $segment.frameDirectory "frame_000000.jpg"))) { throw "FFmpeg did not write the expected continuous zoom frames for $($segment.filename)." }
    $clipPosition++
  }
  $clipStopwatch.Stop()
  $clipTelemetry = Stop-StageTelemetry $clipTelemetryJob
  $clipTelemetryJob = $null

  $timelineDurationSeconds = ([double]$handoff.timeline[-1].endMs) / 1000
  $outputFrameCount = [Math]::Ceiling($timelineDurationSeconds * $FrameRate)
  $compositionStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $compositionTelemetryJob = Start-StageTelemetry
  $segmentIndex = 0
  for ($outputFrameIndex = 0; $outputFrameIndex -lt $outputFrameCount; $outputFrameIndex++) {
    $timeSeconds = $outputFrameIndex / [double]$FrameRate
    # Keep the direct opacity transition centered on the approved segment boundary.
    # The outgoing shot remains full-strength until the final half-transition; the incoming shot
    # reaches full opacity only after its own approved start time. This prevents crossfades from
    # moving visual cues early relative to the narration timeline.
    while ($segmentIndex -lt ($segments.Count - 1) -and $timeSeconds -ge ([double]$segments[$segmentIndex].endSeconds + $transitionHalfSeconds)) { $segmentIndex++ }
    $current = $segments[$segmentIndex]
    $currentLocalSeconds = $timeSeconds - [double]$current.startSeconds
    $frame = New-Object System.Drawing.Bitmap($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($frame)
    $graphics.Clear([System.Drawing.Color]::Black)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $fadeStart = [double]$current.endSeconds - $transitionHalfSeconds
    $fadeEnd = [double]$current.endSeconds + $transitionHalfSeconds
    try {
      if ($segmentIndex -lt ($segments.Count - 1) -and $timeSeconds -ge $fadeStart -and $timeSeconds -lt $fadeEnd) {
        $fadeProgress = [Math]::Min(1.0, [Math]::Max(0.0, ($timeSeconds - $fadeStart) / $transitionSeconds))
        $currentLayer = Open-ClipFrame $current (Get-ClipFrameIndex $current $currentLocalSeconds)
        $next = $segments[$segmentIndex + 1]
        $nextLocalSeconds = [Math]::Max(0.0, $timeSeconds - [double]$next.startSeconds)
        $nextLayer = Open-ClipFrame $next (Get-ClipFrameIndex $next $nextLocalSeconds)
        try {
          Draw-AlphaLayer $graphics $currentLayer (1.0 - $fadeProgress)
          Draw-AlphaLayer $graphics $nextLayer $fadeProgress
        } finally {
          $currentLayer.Dispose()
          $nextLayer.Dispose()
        }
      } else {
        $currentLayer = Open-ClipFrame $current (Get-ClipFrameIndex $current $currentLocalSeconds)
        try { Draw-AlphaLayer $graphics $currentLayer 1.0 } finally { $currentLayer.Dispose() }
      }
      $frame.Save((Join-Path $frameDirectory ("frame_{0:D6}.jpg" -f $outputFrameIndex)), $jpegEncoder, $jpegParameters)
    } finally {
      $graphics.Dispose()
      $frame.Dispose()
    }
    if (($outputFrameIndex % $FrameRate) -eq 0) { Write-Progress -Activity "Applying existing direct crossfade" -Status "Frame $outputFrameIndex of $outputFrameCount" -PercentComplete (45 + (($outputFrameIndex / [double]$outputFrameCount) * 45)) }
  }
  $compositionStopwatch.Stop()
  $compositionTelemetry = Stop-StageTelemetry $compositionTelemetryJob
  $compositionTelemetryJob = $null

  $outputPath = Join-Path $OutputDirectory $handoff.output.filename
  $encoderSelectionStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $finalEncoder = Get-FinalVideoEncoder $RenderMode
  $encoderSelectionStopwatch.Stop()
  $effectivePipelineMode = if ($finalEncoder.acceleration -eq "GPU") { "HYBRID" } else { "CPU" }
  Write-Output "RENDER_MODE_REQUESTED=$RenderMode"
  Write-Output "RENDER_MODE_EFFECTIVE=$effectivePipelineMode"
  Write-Output "ENCODER=$($finalEncoder.label)"
  Write-Output "CPU_BOUND_STAGES=continuous centered zoom frame generation; direct-opacity crossfade composition"
  $encodeArguments = @(
    "-hide_banner", "-loglevel", "warning",
    "-framerate", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-start_number", "0", "-i", (Join-Path $frameDirectory "frame_%06d.jpg"),
    "-i", $narrationPath
  ) + $finalEncoder.arguments + @(
    # The accepted subpixel renderer produces stable source frames, so the final H.264 encoder can
    # use normal inter-frame compression safely. Hardware acceleration affects only this final encode;
    # the exact subpixel zoom and alpha compositing remain on the established deterministic path.
    "-g", ($FrameRate * 2).ToString(), "-keyint_min", $FrameRate.ToString(), "-sc_threshold", "0", "-bf", "2",
    "-pix_fmt", "yuv420p", "-r", $FrameRate.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-fps_mode", "cfr",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", "-y", $outputPath
  )
  $encodeStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $encodeTelemetryJob = Start-StageTelemetry
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $FFmpegPath @encodeArguments
  $encodeExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $encodeStopwatch.Stop()
  $encodeTelemetry = Stop-StageTelemetry $encodeTelemetryJob
  $encodeTelemetryJob = $null
  if ($encodeExitCode -ne 0) { throw "FFmpeg exited with code $encodeExitCode" }
  if (!(Test-Path $outputPath)) { throw "FFmpeg completed without writing the expected MP4." }
  $renderStopwatch.Stop()
  $profilePath = Join-Path $OutputDirectory (([System.IO.Path]::GetFileNameWithoutExtension($handoff.output.filename)) + "-render-profile.json")
  $profile = [pscustomobject]@{
    schemaVersion = 1
    renderModeRequested = $RenderMode
    renderModeEffective = $effectivePipelineMode
    encoder = $finalEncoder.label
    cpuBoundStages = @("continuous centered zoom frame generation", "direct-opacity crossfade composition")
    output = [pscustomobject]@{ path = $outputPath; width = $canvasWidth; height = $canvasHeight; frameRate = $FrameRate; frameCount = $outputFrameCount; timelineDurationSeconds = [Math]::Round($timelineDurationSeconds, 3) }
    stages = [pscustomobject]@{
      continuousZoomFrameGeneration = [pscustomobject]@{ elapsedSeconds = [Math]::Round($clipStopwatch.Elapsed.TotalSeconds, 3); telemetry = $clipTelemetry }
      directCrossfadeComposition = [pscustomobject]@{ elapsedSeconds = [Math]::Round($compositionStopwatch.Elapsed.TotalSeconds, 3); telemetry = $compositionTelemetry }
      encoderSelection = [pscustomobject]@{ elapsedSeconds = [Math]::Round($encoderSelectionStopwatch.Elapsed.TotalSeconds, 3) }
      finalH264EncodeAndAudioMux = [pscustomobject]@{ elapsedSeconds = [Math]::Round($encodeStopwatch.Elapsed.TotalSeconds, 3); outputFramesPerSecond = [Math]::Round(($outputFrameCount / [Math]::Max(0.001, $encodeStopwatch.Elapsed.TotalSeconds)), 3); telemetry = $encodeTelemetry }
    }
    totalElapsedSeconds = [Math]::Round($renderStopwatch.Elapsed.TotalSeconds, 3)
  }
  $profile | ConvertTo-Json -Depth 8 | Set-Content -Path $profilePath -Encoding UTF8
  Write-Output "PROFILE=$profilePath"
} finally {
  if ($clipTelemetryJob) { Stop-Job -Job $clipTelemetryJob -ErrorAction SilentlyContinue; Remove-Job -Job $clipTelemetryJob -Force -ErrorAction SilentlyContinue }
  if ($compositionTelemetryJob) { Stop-Job -Job $compositionTelemetryJob -ErrorAction SilentlyContinue; Remove-Job -Job $compositionTelemetryJob -Force -ErrorAction SilentlyContinue }
  if ($encodeTelemetryJob) { Stop-Job -Job $encodeTelemetryJob -ErrorAction SilentlyContinue; Remove-Job -Job $encodeTelemetryJob -Force -ErrorAction SilentlyContinue }
  $jpegParameters.Dispose()
  if (Test-Path $clipRoot) { Remove-Item -Recurse -Force $clipRoot }
  if (Test-Path $frameDirectory) { Remove-Item -Recurse -Force $frameDirectory }
}

Write-Output "RENDERED=$outputPath"
