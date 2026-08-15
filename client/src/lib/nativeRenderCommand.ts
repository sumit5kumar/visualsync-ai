function quotePowerShell(value: string) { return `'${value.replace(/'/g, "''")}'`; }

export function outputFolderSeed(savedOutputPath: string | null | undefined) {
  const selectedName = savedOutputPath?.match(/^Native output folder selected:\s*(.+)$/i)?.[1]?.trim();
  if (selectedName) return `Join-Path $env:USERPROFILE ${quotePowerShell(`Downloads\\${selectedName.replace(/[\\/]/g, "_")}`)}`;
  if (savedOutputPath && /^[A-Za-z]:\\/.test(savedOutputPath)) return quotePowerShell(savedOutputPath);
  return "(Join-Path $env:USERPROFILE 'Downloads')";
}

export function buildNativeRenderCommand(projectName: string, savedOutputPath?: string | null) {
  const outputSeed = outputFolderSeed(savedOutputPath);
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
$output.SelectedPath = ${outputSeed}
if ($output.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
& ".\\render-approved-handoff.ps1" -HandoffPath $handoff.FileName -SourceDirectory $source.SelectedPath -OutputDirectory $output.SelectedPath -FFmpegPath "D:\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe"`;
}
