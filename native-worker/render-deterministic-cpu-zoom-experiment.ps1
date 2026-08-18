param(
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$FFmpegPath,
  [int[]]$SegmentIndexes = @(8, 19),
  [ValidateSet(30, 60)][int]$FrameRate = 30
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (!(Test-Path $HandoffPath)) { throw "Approved render handoff not found: $HandoffPath" }
if (!(Test-Path $SourceDirectory)) { throw "Source directory not found: $SourceDirectory" }
if (!(Test-Path $OutputDirectory)) { throw "Output directory not found: $OutputDirectory" }
if (!(Test-Path $FFmpegPath)) { throw "FFmpeg executable not found: $FFmpegPath" }

$handoff = Get-Content -Raw $HandoffPath | ConvertFrom-Json
if (!$handoff.approval.approvedAtMs -or !$handoff.approval.approvedByUserId) { throw "The experiment requires an approved handoff." }
if ($handoff.output.width -ne 1920 -or $handoff.output.height -ne 1080 -or $handoff.output.container -ne "mp4") { throw "The experiment accepts only the approved 1920x1080 MP4 contract." }

$canvasWidth = 1920
$canvasHeight = 1080
$oversizedWidth = 2112
$oversizedHeight = 1188
$zoomEnabled = $true
$zoomAmountPercent = 8.0
$zoomDirection = "IN"
if ($handoff.PSObject.Properties.Name -contains "zoom") {
  if ($handoff.zoom.PSObject.Properties.Name -contains "enabled") { $zoomEnabled = [bool]$handoff.zoom.enabled }
  if ($handoff.zoom.PSObject.Properties.Name -contains "amountPercent") { $zoomAmountPercent = [double]$handoff.zoom.amountPercent }
  if ($handoff.zoom.PSObject.Properties.Name -contains "direction") { $zoomDirection = ([string]$handoff.zoom.direction).ToUpperInvariant() }
}
if (!$zoomEnabled) { throw "The experiment requires zoom enabled in the supplied handoff." }
if ($zoomAmountPercent -notin @(3.0, 5.0, 8.0, 12.0)) { throw "Unsupported zoom amount in the supplied handoff." }
if ($zoomDirection -notin @("IN", "OUT", "AUTO")) { throw "Unsupported zoom direction in the supplied handoff." }

$assetNames = @{}
foreach ($image in $handoff.images) { $assetNames[[string]$image.assetId] = $image.filename }
$narrationPath = Join-Path $SourceDirectory $handoff.narration.filename
if (!(Test-Path $narrationPath)) { throw "Narration file missing: $narrationPath" }
$ffprobePath = Join-Path (Split-Path -Parent $FFmpegPath) "ffprobe.exe"
if (!(Test-Path $ffprobePath)) { throw "ffprobe.exe is required beside FFmpeg for the experiment." }

function Format-Number([double]$value) { $value.ToString("0.0000000000", [System.Globalization.CultureInfo]::InvariantCulture) }

function Start-Telemetry() {
  Start-Job -ScriptBlock {
    while ($true) {
      try {
        $cpu = (Get-Counter -Counter "\Processor Information(_Total)\% Processor Time").CounterSamples | Select-Object -First 1
        $gpu = Get-Counter -Counter "\GPU Engine(*)\Utilization Percentage"
        $gpuValues = @($gpu.CounterSamples | ForEach-Object { [double]$_.CookedValue })
        [pscustomobject]@{ cpuPercent = [double]$cpu.CookedValue; gpuPeakPercent = if ($gpuValues.Count) { ($gpuValues | Measure-Object -Maximum).Maximum } else { $null }; error = $null }
      } catch { [pscustomobject]@{ cpuPercent = $null; gpuPeakPercent = $null; error = $_.Exception.Message } }
      Start-Sleep -Seconds 1
    }
  }
}

function Stop-Telemetry([object]$job) {
  if (!$job) { return [pscustomobject]@{ samples = 0; cpuAveragePercent = $null; cpuPeakPercent = $null; gpuPeakPercent = $null; errors = @() } }
  Stop-Job $job -ErrorAction SilentlyContinue
  $samples = @(Receive-Job $job -ErrorAction SilentlyContinue)
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $cpu = @($samples | Where-Object { $null -ne $_.cpuPercent } | ForEach-Object { [double]$_.cpuPercent })
  $gpu = @($samples | Where-Object { $null -ne $_.gpuPeakPercent } | ForEach-Object { [double]$_.gpuPeakPercent })
  [pscustomobject]@{
    samples = $samples.Count
    cpuAveragePercent = if ($cpu.Count) { [Math]::Round(($cpu | Measure-Object -Average).Average, 2) } else { $null }
    cpuPeakPercent = if ($cpu.Count) { [Math]::Round(($cpu | Measure-Object -Maximum).Maximum, 2) } else { $null }
    gpuPeakPercent = if ($gpu.Count) { [Math]::Round(($gpu | Measure-Object -Maximum).Maximum, 2) } else { $null }
    errors = @($samples | Where-Object { $_.error } | Select-Object -ExpandProperty error -Unique)
  }
}

function Get-ZoomPlan([int]$segmentIndex) {
  $amount = $zoomAmountPercent / 100.0
  $direction = $zoomDirection
  if ($direction -eq "AUTO") { $direction = if (($segmentIndex % 2) -eq 0) { "IN" } else { "OUT" } }
  if ($direction -eq "OUT") { return [pscustomobject]@{ direction = "OUT"; startZoom = 1.0 + $amount; endZoom = 1.0 } }
  [pscustomobject]@{ direction = "IN"; startZoom = 1.0; endZoom = 1.0 + $amount }
}

function New-GeqReferenceFilter([double]$startZoom, [double]$endZoom, [int]$frameCount) {
  $denominator = [Math]::Max(1, $frameCount - 1)
  $start = Format-Number $startZoom
  $delta = Format-Number ($endZoom - $startZoom)
  $zoom = "($start+($delta*N/$denominator))"
  $centerX = Format-Number ($oversizedWidth / 2.0)
  $centerY = Format-Number ($oversizedHeight / 2.0)
  $sourceX = "$centerX+(X-$centerX)/$zoom"
  $sourceY = "$centerY+(Y-$centerY)/$zoom"
  "scale=$oversizedWidth`:$oversizedHeight`:force_original_aspect_ratio=increase:flags=lanczos,crop=$oversizedWidth`:$oversizedHeight,setsar=1,format=yuv444p,geq=lum='lum($sourceX,$sourceY)':cb='cb($sourceX,$sourceY)':cr='cr($sourceX,$sourceY)':interpolation=bilinear,scale=$canvasWidth`:$canvasHeight`:flags=lanczos:in_range=pc:out_range=tv,setsar=1,format=yuv420p"
}

function New-NormalizedCanvas([string]$imagePath) {
  $source = [System.Drawing.Image]::FromFile($imagePath)
  try {
    $canvas = New-Object System.Drawing.Bitmap($oversizedWidth, $oversizedHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::Black)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scale = [Math]::Max($oversizedWidth / [double]$source.Width, $oversizedHeight / [double]$source.Height)
      $drawWidth = $source.Width * $scale
      $drawHeight = $source.Height * $scale
      $drawX = ($oversizedWidth - $drawWidth) / 2.0
      $drawY = ($oversizedHeight - $drawHeight) / 2.0
      $graphics.DrawImage($source, [System.Drawing.RectangleF]::new([single]$drawX, [single]$drawY, [single]$drawWidth, [single]$drawHeight))
      return $canvas
    } finally { $graphics.Dispose() }
  } finally { $source.Dispose() }
}

function Render-DeterministicFrames([object]$segment, [string]$frameDirectory) {
  $canvas = New-NormalizedCanvas $segment.imagePath
  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 95L)
  $cropSamples = @()
  try {
    for ($frameIndex = 0; $frameIndex -lt $segment.frameCount; $frameIndex++) {
      $progress = if ($segment.frameCount -le 1) { 0.0 } else { $frameIndex / [double]($segment.frameCount - 1) }
      $zoom = $segment.startZoom + (($segment.endZoom - $segment.startZoom) * $progress)
      $sourceWidth = $oversizedWidth / $zoom
      $sourceHeight = $oversizedHeight / $zoom
      $sourceX = ($oversizedWidth - $sourceWidth) / 2.0
      $sourceY = ($oversizedHeight - $sourceHeight) / 2.0
      $cropSamples += [pscustomobject]@{ frame = $frameIndex; zoom = $zoom; sourceX = $sourceX; sourceY = $sourceY; sourceWidth = $sourceWidth; sourceHeight = $sourceHeight }
      $frame = New-Object System.Drawing.Bitmap($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [System.Drawing.Graphics]::FromImage($frame)
      try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($canvas, [System.Drawing.Rectangle]::new(0, 0, $canvasWidth, $canvasHeight), [single]$sourceX, [single]$sourceY, [single]$sourceWidth, [single]$sourceHeight, [System.Drawing.GraphicsUnit]::Pixel)
        $frame.Save((Join-Path $frameDirectory ("frame_{0:D6}.jpg" -f $frameIndex)), $encoder, $parameters)
      } finally { $graphics.Dispose(); $frame.Dispose() }
    }
  } finally { $parameters.Dispose(); $canvas.Dispose() }
  return $cropSamples
}

function Render-GeqReferenceFrames([object]$segment, [string]$frameDirectory) {
  $filter = New-GeqReferenceFilter $segment.startZoom $segment.endZoom $segment.frameCount
  $arguments = @("-hide_banner", "-loglevel", "warning", "-loop", "1", "-framerate", $FrameRate.ToString(), "-i", $segment.imagePath, "-vf", $filter, "-frames:v", $segment.frameCount.ToString(), "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p", "-start_number", "0", "-y", (Join-Path $frameDirectory "frame_%06d.jpg"))
  & $FFmpegPath @arguments
  if ($LASTEXITCODE -ne 0) { throw "GEQ reference failed for $($segment.filename)." }
}

function Encode-Clip([string]$framesDirectory, [object]$segment, [string]$outputPath) {
  $audioEndSeconds = [double]$segment.startSeconds + [double]$segment.durationSeconds
  $audioFilter = "[0:a]atrim=start=$(Format-Number $segment.startSeconds):end=$(Format-Number $audioEndSeconds),asetpts=PTS-STARTPTS[audio]"
  $arguments = @("-hide_banner", "-loglevel", "warning", "-i", $narrationPath, "-framerate", $FrameRate.ToString(), "-start_number", "0", "-i", (Join-Path $framesDirectory "frame_%06d.jpg"), "-filter_complex", $audioFilter, "-map", "1:v:0", "-map", "[audio]", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", $FrameRate.ToString(), "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "-y", $outputPath)
  & $FFmpegPath @arguments
  if ($LASTEXITCODE -ne 0) { throw "Clip encode failed: $outputPath" }
}

function Get-VideoContract([string]$videoPath) {
  $raw = & $ffprobePath -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt -of json $videoPath
  $probe = ($raw -join "`n") | ConvertFrom-Json
  $video = @($probe.streams | Where-Object { $_.codec_type -eq "video" })[0]
  [pscustomobject]@{ durationSeconds = [Math]::Round([double]$probe.format.duration, 3); width = $video.width; height = $video.height; frameRate = $video.r_frame_rate; pixelFormat = $video.pix_fmt; codec = $video.codec_name }
}

function Get-StabilityMetrics([string]$videoPath, [object[]]$cropSamples) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $hashRows = @(& $FFmpegPath -hide_banner -loglevel error -i $videoPath -map 0:v -f framemd5 - 2>$null | Where-Object { $_ -match '^[0-9]+,' })
  $hashExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($hashExitCode -ne 0) { throw "Frame-hash analysis failed: $videoPath" }
  $hashes = @($hashRows | ForEach-Object { ($_ -split ',')[-1].Trim() })
  $duplicatePairs = 0
  for ($index = 1; $index -lt $hashes.Count; $index++) { if ($hashes[$index] -eq $hashes[$index - 1]) { $duplicatePairs++ } }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $motionOutput = @(& $FFmpegPath -hide_banner -loglevel info -i $videoPath -vf "tblend=all_mode=difference,signalstats,metadata=print" -an -f null - 2>&1)
  $motionExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($motionExitCode -ne 0) { throw "Frame-motion analysis failed: $videoPath" }
  $motionValues = @($motionOutput | ForEach-Object { if ($_ -match 'lavfi.signalstats.YAVG=(?<value>[0-9.]+)') { [double]$Matches.value } })
  $motionDeltas = @()
  for ($index = 1; $index -lt $motionValues.Count; $index++) { $motionDeltas += [Math]::Abs($motionValues[$index] - $motionValues[$index - 1]) }
  $widthSteps = @()
  for ($index = 1; $index -lt $cropSamples.Count; $index++) { $widthSteps += ($cropSamples[$index].sourceWidth - $cropSamples[$index - 1].sourceWidth) }
  $expectedSign = [Math]::Sign($cropSamples[-1].sourceWidth - $cropSamples[0].sourceWidth)
  $reversals = @($widthSteps | Where-Object { [Math]::Sign($_) -ne 0 -and [Math]::Sign($_) -ne $expectedSign }).Count
  [pscustomobject]@{
    analyzedFrames = $hashes.Count
    duplicateConsecutiveFramePairs = $duplicatePairs
    lumaMotionAverage = if ($motionValues.Count) { [Math]::Round(($motionValues | Measure-Object -Average).Average, 4) } else { $null }
    lumaMotionMaximum = if ($motionValues.Count) { [Math]::Round(($motionValues | Measure-Object -Maximum).Maximum, 4) } else { $null }
    lumaMotionMaximumStep = if ($motionDeltas.Count) { [Math]::Round(($motionDeltas | Measure-Object -Maximum).Maximum, 4) } else { $null }
    cropPositionReversals = $reversals
    maxCropWidthStep = if ($widthSteps.Count) { [Math]::Round((@($widthSteps | ForEach-Object { [Math]::Abs($_) }) | Measure-Object -Maximum).Maximum, 8) } else { 0 }
    deterministicCropPath = ($reversals -eq 0)
    resetDetected = ($duplicatePairs -gt 0)
  }
}

$experimentRoot = Join-Path $OutputDirectory ("deterministic-cpu-zoom-experiment-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$referenceRoot = Join-Path $experimentRoot "geq-reference"
$candidateRoot = Join-Path $experimentRoot "deterministic-cpu"
New-Item -ItemType Directory -Path $referenceRoot, $candidateRoot -Force | Out-Null
$segments = @()
foreach ($segmentIndex in $SegmentIndexes) {
  if ($segmentIndex -lt 0 -or $segmentIndex -ge $handoff.timeline.Count) { throw "Segment index $segmentIndex is outside the approved timeline." }
  $timelineSegment = $handoff.timeline[$segmentIndex]
  $filename = $assetNames[[string]$timelineSegment.imageAssetId]
  $imagePath = Join-Path $SourceDirectory $filename
  if (!(Test-Path $imagePath)) { throw "Timeline image missing: $imagePath" }
  $durationSeconds = (([double]$timelineSegment.endMs) - ([double]$timelineSegment.startMs)) / 1000.0
  $frameCount = [Math]::Max(1, [int][Math]::Ceiling($durationSeconds * $FrameRate))
  $plan = Get-ZoomPlan $segmentIndex
  $segments += [pscustomobject]@{ index = $segmentIndex; filename = $filename; imagePath = $imagePath; startSeconds = ([double]$timelineSegment.startMs) / 1000.0; durationSeconds = $durationSeconds; frameCount = $frameCount; direction = $plan.direction; startZoom = $plan.startZoom; endZoom = $plan.endZoom }
}

$results = @()
foreach ($segment in $segments) {
  $name = "segment_{0:D2}" -f $segment.index
  $referenceFrames = Join-Path $referenceRoot ("$name-frames")
  $candidateFrames = Join-Path $candidateRoot ("$name-frames")
  New-Item -ItemType Directory -Path $referenceFrames, $candidateFrames -Force | Out-Null
  $referenceTelemetryJob = Start-Telemetry
  $referenceStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  Render-GeqReferenceFrames $segment $referenceFrames
  $referenceStopwatch.Stop()
  $referenceTelemetry = Stop-Telemetry $referenceTelemetryJob
  $candidateTelemetryJob = Start-Telemetry
  $candidateStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $cropSamples = @(Render-DeterministicFrames $segment $candidateFrames)
  $candidateStopwatch.Stop()
  $candidateTelemetry = Stop-Telemetry $candidateTelemetryJob
  $referenceVideo = Join-Path $referenceRoot ("$name-geq-reference.mp4")
  $candidateVideo = Join-Path $candidateRoot ("$name-deterministic-cpu.mp4")
  Encode-Clip $referenceFrames $segment $referenceVideo
  Encode-Clip $candidateFrames $segment $candidateVideo
  $referenceContract = Get-VideoContract $referenceVideo
  $candidateContract = Get-VideoContract $candidateVideo
  $candidateStability = Get-StabilityMetrics $candidateVideo $cropSamples
  $referenceStability = Get-StabilityMetrics $referenceVideo $cropSamples
  $results += [pscustomobject]@{
    segmentIndex = $segment.index
    filename = $segment.filename
    direction = $segment.direction
    durationSeconds = [Math]::Round($segment.durationSeconds, 3)
    frameCount = $segment.frameCount
    geq = [pscustomobject]@{ zoomGenerationSeconds = [Math]::Round($referenceStopwatch.Elapsed.TotalSeconds, 3); telemetry = $referenceTelemetry; output = $referenceContract; stability = $referenceStability; videoPath = $referenceVideo }
    deterministicCpu = [pscustomobject]@{ zoomGenerationSeconds = [Math]::Round($candidateStopwatch.Elapsed.TotalSeconds, 3); telemetry = $candidateTelemetry; output = $candidateContract; stability = $candidateStability; videoPath = $candidateVideo }
    zoomStageSpeedImprovementPercent = [Math]::Round((1.0 - ($candidateStopwatch.Elapsed.TotalSeconds / [Math]::Max(0.001, $referenceStopwatch.Elapsed.TotalSeconds))) * 100.0, 2)
  }
}

$referenceTotal = ($results | ForEach-Object { [double]$_.geq.zoomGenerationSeconds } | Measure-Object -Sum).Sum
$candidateTotal = ($results | ForEach-Object { [double]$_.deterministicCpu.zoomGenerationSeconds } | Measure-Object -Sum).Sum
$report = [pscustomobject]@{
  experiment = "separate deterministic CPU zoom candidate; production render-approved-handoff.ps1 was not modified or invoked"
  approvedContract = [pscustomobject]@{ width = $canvasWidth; height = $canvasHeight; frameRate = $FrameRate; aspectRatio = "16:9"; zoomAmountPercent = $zoomAmountPercent; zoomDirection = $zoomDirection }
  segments = $results
  totals = [pscustomobject]@{ geqZoomGenerationSeconds = [Math]::Round($referenceTotal, 3); deterministicCpuZoomGenerationSeconds = [Math]::Round($candidateTotal, 3); speedImprovementPercent = [Math]::Round((1.0 - ($candidateTotal / [Math]::Max(0.001, $referenceTotal))) * 100.0, 2) }
  caveat = "The per-segment MP4 clips preserve source segment timing and audio snippets for validation. They are not a replacement for the full production timeline render."
}
$reportPath = Join-Path $experimentRoot "deterministic-cpu-zoom-experiment-report.json"
$report | ConvertTo-Json -Depth 12 | Set-Content -Path $reportPath -Encoding UTF8
Write-Output "EXPERIMENT_ROOT=$experimentRoot"
Write-Output "REPORT=$reportPath"
Write-Output "GEQ_ZOOM_SECONDS=$($report.totals.geqZoomGenerationSeconds)"
Write-Output "DETERMINISTIC_CPU_ZOOM_SECONDS=$($report.totals.deterministicCpuZoomGenerationSeconds)"
Write-Output "SPEED_IMPROVEMENT_PERCENT=$($report.totals.speedImprovementPercent)"
