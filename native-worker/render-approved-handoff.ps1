param(
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$FFmpegPath = "ffmpeg"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $HandoffPath)) { throw "Approved render handoff not found: $HandoffPath" }
if (!(Test-Path $SourceDirectory)) { throw "Source directory not found: $SourceDirectory" }
if (!(Test-Path $OutputDirectory)) { throw "Output directory not found: $OutputDirectory" }

$handoff = Get-Content -Raw $HandoffPath | ConvertFrom-Json
if (!$handoff.approval.approvedAtMs -or !$handoff.approval.approvedByUserId) { throw "Rendering is blocked because the timeline handoff is not approved." }
if ($handoff.output.width -ne 1920 -or $handoff.output.height -ne 1080 -or $handoff.output.container -ne "mp4" -or !$handoff.output.filename) { throw "The worker accepts only the approved project-specific 1920x1080 MP4 contract." }

$assetNames = @{}
foreach ($image in $handoff.images) { $assetNames[[string]$image.assetId] = $image.filename }
$narrationPath = Join-Path $SourceDirectory $handoff.narration.filename
if (!(Test-Path $narrationPath)) { throw "Narration file missing from source directory: $narrationPath" }

$inputs = @()
$filterParts = @()
$segmentDurations = @()
$index = 0
$transitionSeconds = 0.5
foreach ($segment in $handoff.timeline) {
  $filename = $assetNames[[string]$segment.imageAssetId]
  if (!$filename) { throw "Timeline image asset $($segment.imageAssetId) is absent from the approved handoff." }
  $imagePath = Join-Path $SourceDirectory $filename
  if (!(Test-Path $imagePath)) { throw "Timeline image missing from source directory: $imagePath" }
  $durationSeconds = ([double]$segment.endMs - [double]$segment.startMs) / 1000
  if ($durationSeconds -le 0) { throw "Timeline contains a non-positive duration for image: $filename" }
  $isLast = $index -eq ($handoff.timeline.Count - 1)
  $inputSeconds = $durationSeconds + $(if ($isLast) { 0 } else { $transitionSeconds })
  $zoomTarget = [Math]::Min(1.14, 1.05 + ($durationSeconds * 0.009))
  $zoomRate = ($zoomTarget - 1.0) / [Math]::Max(0.1, $durationSeconds)
  $zoomExpression = "min($($zoomTarget.ToString([System.Globalization.CultureInfo]::InvariantCulture))\,1+t*$($zoomRate.ToString([System.Globalization.CultureInfo]::InvariantCulture)))"
  $inputs += @("-loop", "1", "-t", $inputSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-i", $imagePath)
  $filterParts += "[$index`:v]fps=30,scale=2112:1188:force_original_aspect_ratio=increase,crop=2112:1188,scale=w='trunc(iw*$zoomExpression/2)*2':h='trunc(ih*$zoomExpression/2)*2':eval=frame:flags=lanczos,crop=1920:1080:(in_w-out_w)/2:(in_h-out_h)/2,setsar=1,format=yuv420p[v$index]"
  $segmentDurations += $durationSeconds
  $index++
}

$filterChain = ""
if ($index -eq 1) { $filterChain = "[v0]null[vout]" }
else {
  $cumulativeDuration = $segmentDurations[0]
  $filterChain = "[v0][v1]xfade=transition=fade:duration=$transitionSeconds`:offset=$($cumulativeDuration.ToString([System.Globalization.CultureInfo]::InvariantCulture))[xf1]"
  for ($transitionIndex = 2; $transitionIndex -lt $index; $transitionIndex++) {
    $cumulativeDuration += $segmentDurations[$transitionIndex - 1]
    $outputLabel = if ($transitionIndex -eq $index - 1) { "vout" } else { "xf$transitionIndex" }
    $filterChain += ";[xf$($transitionIndex - 1)][v$transitionIndex]xfade=transition=fade:duration=$transitionSeconds`:offset=$($cumulativeDuration.ToString([System.Globalization.CultureInfo]::InvariantCulture))[$outputLabel]"
  }
  if ($index -eq 2) { $filterChain = $filterChain -replace "\[xf1\]$", "[vout]" }
}
$timelineDurationSeconds = ([double]$handoff.timeline[-1].endMs) / 1000
$timelineDuration = $timelineDurationSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$filterComplex = ($filterParts -join ";") + ";" + $filterChain + ";[vout]trim=duration=$timelineDuration,setpts=PTS-STARTPTS[vfinal]"
$outputPath = Join-Path $OutputDirectory $handoff.output.filename
$audioInputIndex = $index
$arguments = @($inputs) + @("-i", $narrationPath, "-filter_complex", $filterComplex, "-map", "[vfinal]", "-map", "$audioInputIndex`:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", "-y", $outputPath)

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $FFmpegPath @arguments
$ffmpegExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($ffmpegExitCode -ne 0) { throw "FFmpeg exited with code $ffmpegExitCode" }
if (!(Test-Path $outputPath)) { throw "FFmpeg completed without writing the expected MP4." }

Write-Output "RENDERED=$outputPath"
