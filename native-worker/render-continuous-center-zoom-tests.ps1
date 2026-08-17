param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$FFmpegPath
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $SourcePath)) { throw "Source image not found: $SourcePath" }
if (!(Test-Path $FFmpegPath)) { throw "FFmpeg executable not found: $FFmpegPath" }

$ffprobePath = Join-Path (Split-Path -Parent $FFmpegPath) "ffprobe.exe"
if (!(Test-Path $ffprobePath)) { throw "FFprobe executable not found beside FFmpeg: $ffprobePath" }

$frameRate = 30
$sourceWidth = 2112
$sourceHeight = 1188
$outputWidth = 1920
$outputHeight = 1080
$durations = @(1, 2, 5, 10)
$modes = @(
  [pscustomobject]@{ name = "off"; startZoom = 1.00; endZoom = 1.00 },
  [pscustomobject]@{ name = "in"; startZoom = 1.00; endZoom = 1.05 },
  [pscustomobject]@{ name = "out"; startZoom = 1.05; endZoom = 1.00 }
)

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Format-Number([double]$value) {
  return $value.ToString("0.0000000000", [System.Globalization.CultureInfo]::InvariantCulture)
}

function New-CenteredSubpixelZoomFilter([double]$startZoom, [double]$endZoom, [int]$frameCount) {
  $denominator = [Math]::Max(1, $frameCount - 1)
  $start = Format-Number $startZoom
  $delta = Format-Number ($endZoom - $startZoom)
  $zoom = "($start+($delta*N/$denominator))"
  $halfWidth = $sourceWidth / 2.0
  $halfHeight = $sourceHeight / 2.0
  $centerX = Format-Number $halfWidth
  $centerY = Format-Number $halfHeight
  $sourceX = "$centerX+(X-$centerX)/$zoom"
  $sourceY = "$centerY+(Y-$centerY)/$zoom"
  $normalize = "scale=$sourceWidth`:$sourceHeight`:force_original_aspect_ratio=increase:flags=lanczos,crop=$sourceWidth`:$sourceHeight,setsar=1,format=yuv444p"

  return "$normalize,geq=lum='lum($sourceX,$sourceY)':cb='cb($sourceX,$sourceY)':cr='cr($sourceX,$sourceY)':interpolation=bilinear,scale=$outputWidth`:$outputHeight`:flags=lanczos:in_range=pc:out_range=tv,setsar=1,format=yuv420p"
}

function Assert-VideoContract([string]$VideoPath, [int]$ExpectedFrames, [int]$ExpectedDurationSeconds) {
  $probeJson = & $ffprobePath -v error -select_streams v:0 -count_frames -show_entries stream=width,height,avg_frame_rate,r_frame_rate,nb_read_frames,time_base,pix_fmt:format=duration -of json $VideoPath
  if ($LASTEXITCODE -ne 0) { throw "FFprobe failed for $VideoPath" }
  $probe = $probeJson | ConvertFrom-Json
  $stream = $probe.streams[0]
  if ($stream.width -ne $outputWidth -or $stream.height -ne $outputHeight) { throw "Invalid frame dimensions for $VideoPath" }
  if ($stream.avg_frame_rate -ne "30/1" -or $stream.r_frame_rate -ne "30/1") { throw "Video is not constant 30 FPS: $VideoPath" }
  if ([int]$stream.nb_read_frames -ne $ExpectedFrames) { throw "Frame-count mismatch for $VideoPath. Expected $ExpectedFrames; got $($stream.nb_read_frames)." }
  if ($stream.pix_fmt -ne "yuv420p") { throw "Pixel-format mismatch for ${VideoPath}: $($stream.pix_fmt)" }
  if ([Math]::Abs(([double]$probe.format.duration) - $ExpectedDurationSeconds) -gt 0.04) { throw "Duration mismatch for ${VideoPath}: $($probe.format.duration)" }
  return [pscustomobject]@{
    file = [System.IO.Path]::GetFileName($VideoPath)
    width = $stream.width
    height = $stream.height
    fps = $stream.avg_frame_rate
    frames = [int]$stream.nb_read_frames
    timeBase = $stream.time_base
    pixelFormat = $stream.pix_fmt
    durationSeconds = [double]$probe.format.duration
  }
}

$results = @()
foreach ($duration in $durations) {
  $frameCount = $duration * $frameRate
  foreach ($mode in $modes) {
    $fileName = "continuous-center-zoom-$($mode.name)-$($duration)s.mp4"
    $outputPath = Join-Path $OutputDirectory $fileName
    $filter = New-CenteredSubpixelZoomFilter $mode.startZoom $mode.endZoom $frameCount
    $arguments = @(
      "-hide_banner", "-loglevel", "warning",
      "-loop", "1", "-framerate", $frameRate.ToString(), "-i", $SourcePath,
      "-vf", $filter,
      "-frames:v", $frameCount.ToString(),
      "-c:v", "libx264", "-preset", "medium", "-crf", "14",
      "-g", "1", "-keyint_min", "1", "-sc_threshold", "0", "-bf", "0",
      "-x264-params", "keyint=1:min-keyint=1:scenecut=0:bframes=0:ref=1",
      "-pix_fmt", "yuv420p", "-r", $frameRate.ToString(), "-fps_mode", "cfr",
      "-movflags", "+faststart", "-y", $outputPath
    )
    & $FFmpegPath @arguments
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed for $fileName with exit code $LASTEXITCODE" }
    $result = Assert-VideoContract $outputPath $frameCount $duration
    $result | Add-Member -NotePropertyName mode -NotePropertyValue $mode.name
    $result | Add-Member -NotePropertyName zoomStart -NotePropertyValue $mode.startZoom
    $result | Add-Member -NotePropertyName zoomEnd -NotePropertyValue $mode.endZoom
    $results += $result
    Write-Output "VERIFIED=$outputPath"
  }
}

$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory "continuous-center-zoom-verification.json")
Write-Output "VERIFIED_TEST_SET=$OutputDirectory"
