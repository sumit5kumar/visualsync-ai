function quotePowerShell(value: string) { return `'${value.replace(/'/g, "''")}'`; }

export function isAbsoluteWindowsDirectory(value: string | null | undefined) {
  return Boolean(value && /^(?:[A-Za-z]:\\|\\\\)/.test(value.trim()));
}

export function outputFolderSeed(savedOutputPath: string | null | undefined) {
  if (isAbsoluteWindowsDirectory(savedOutputPath)) return quotePowerShell(savedOutputPath!.trim());
  return null;
}

export function buildNativeRenderCommand(projectName: string, savedSourcePath?: string | null, savedOutputPath?: string | null) {
  const sourceSeed = outputFolderSeed(savedSourcePath);
  const outputSeed = outputFolderSeed(savedOutputPath);
  const handoffName = `${projectName.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "project"}-approved-render-handoff.json`;
  if (sourceSeed && outputSeed) return `# VisualSync approved render: ${projectName}
$sourceDirectory = ${sourceSeed}
$outputDirectory = ${outputSeed}
$handoffPath = Join-Path $outputDirectory ${quotePowerShell(handoffName)}
# Launches only this downloaded worker with a temporary policy bypass; it does not change your system policy.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\render-approved-handoff.ps1" -HandoffPath $handoffPath -SourceDirectory $sourceDirectory -OutputDirectory $outputDirectory -FFmpegPath "D:\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe"`;
  return `# VisualSync approved render: ${projectName}
	Add-Type -AssemblyName System.Windows.Forms
$handoff = New-Object System.Windows.Forms.OpenFileDialog
$handoff.Filter = "VisualSync handoff (*.json)|*.json"
if ($handoff.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$source = New-Object System.Windows.Forms.FolderBrowserDialog
$source.Description = "Choose the folder containing the original narration and images"
if ($source.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$output = New-Object System.Windows.Forms.FolderBrowserDialog
	$output.Description = "Choose the folder where the project MP4 will be saved"
		$output.SelectedPath = (Join-Path $env:USERPROFILE 'Downloads')
if ($output.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
# Launches only this downloaded worker with a temporary policy bypass; it does not change your system policy.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\render-approved-handoff.ps1" -HandoffPath $handoff.FileName -SourceDirectory $source.SelectedPath -OutputDirectory $output.SelectedPath -FFmpegPath "D:\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe"`;
}
