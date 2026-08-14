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
if ($handoff.output.width -ne 1920 -or $handoff.output.height -ne 1080 -or $handoff.output.container -ne "mp4") { throw "The worker accepts only the approved 1920x1080 MP4 contract." }

$assetNames = @{}
foreach ($image in $handoff.images) { $assetNames[[string]$image.assetId] = $image.filename }
$narrationPath = Join-Path $SourceDirectory $handoff.narration.filename
if (!(Test-Path $narrationPath)) { throw "Narration file missing from source directory: $narrationPath" }

$inputs = @()
$filterParts = @()
$concatInputs = @()
$index = 0
foreach ($segment in $handoff.timeline) {
  $filename = $assetNames[[string]$segment.imageAssetId]
  if (!$filename) { throw "Timeline image asset $($segment.imageAssetId) is absent from the approved handoff." }
  $imagePath = Join-Path $SourceDirectory $filename
  if (!(Test-Path $imagePath)) { throw "Timeline image missing from source directory: $imagePath" }
  $durationSeconds = ([double]$segment.endMs - [double]$segment.startMs) / 1000
  if ($durationSeconds -le 0) { throw "Timeline contains a non-positive duration for image: $filename" }
  $inputs += @("-loop", "1", "-t", $durationSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-i", $imagePath)
  $filterParts += "[$index`:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p[v$index]"
  $concatInputs += "[v$index]"
  $index++
}

$filterComplex = ($filterParts -join ";") + ";" + (($concatInputs -join "") + "concat=n=$index`:v=1:a=0[vout]")
$outputPath = Join-Path $OutputDirectory "Nothing_approved_1920x1080.mp4"
$audioInputIndex = $index
$arguments = @($inputs) + @("-i", $narrationPath, "-filter_complex", $filterComplex, "-map", "[vout]", "-map", "$audioInputIndex`:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", "-y", $outputPath)

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $FFmpegPath @arguments
$ffmpegExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($ffmpegExitCode -ne 0) { throw "FFmpeg exited with code $ffmpegExitCode" }
if (!(Test-Path $outputPath)) { throw "FFmpeg completed without writing the expected MP4." }

Write-Output "RENDERED=$outputPath"
