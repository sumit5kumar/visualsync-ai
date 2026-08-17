param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$FFmpegPath
)

$ErrorActionPreference = "Stop"
if (!(Test-Path $SourcePath)) { throw "Source image not found: $SourcePath" }

$frameRate = 30
$stageCount = 12
$stageDuration = 2.0
$blendDuration = 1.0
$inputs = @()
$filters = @()

for ($stage = 0; $stage -lt $stageCount; $stage++) {
  $zoom = 1.0 + ((0.06 * $stage) / ($stageCount - 1))
  $width = [int]([Math]::Ceiling((1920 * $zoom) / 2.0) * 2)
  $height = [int]([Math]::Ceiling((1080 * $zoom) / 2.0) * 2)
  $inputs += @("-loop", "1", "-framerate", $frameRate.ToString(), "-t", $stageDuration.ToString([System.Globalization.CultureInfo]::InvariantCulture), "-i", $SourcePath)
  $filters += "[$stage`:v]scale=$width`:$height`:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1[z$stage]"
}

$previousLabel = "z0"
for ($stage = 1; $stage -lt $stageCount; $stage++) {
  $outputLabel = if ($stage -eq ($stageCount - 1)) { "v" } else { "m$stage" }
  $offset = ([double]$stage * ($stageDuration - $blendDuration)).ToString([System.Globalization.CultureInfo]::InvariantCulture)
  $filters += "[$previousLabel][z$stage]xfade=transition=fade:duration=$blendDuration`:offset=$offset[$outputLabel]"
  $previousLabel = $outputLabel
}

$arguments = @("-hide_banner", "-loglevel", "warning") + $inputs + @("-filter_complex", ($filters -join ";"), "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-g", "1", "-keyint_min", "1", "-sc_threshold", "0", "-bf", "0", "-x264-params", "keyint=1:min-keyint=1:scenecut=0:bframes=0:ref=1", "-pix_fmt", "yuv420p", "-r", $frameRate.ToString(), "-movflags", "+faststart", "-y", $OutputPath)
& $FFmpegPath @arguments
if ($LASTEXITCODE -ne 0) { throw "FFmpeg exited with code $LASTEXITCODE" }
if (!(Test-Path $OutputPath)) { throw "FFmpeg did not create the staged zoom test video." }

Write-Output "RENDERED=$OutputPath"
