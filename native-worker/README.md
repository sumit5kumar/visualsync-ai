# Native FFmpeg Worker

This worker renders **only** an approved VisualSync handoff. It enforces the fixed 1920 × 1080 MP4 contract and retains every validated timeline start and end boundary.

After approving a Timeline in the app, download that project’s handoff JSON. In the folder containing `render-approved-handoff.ps1`, run the picker-based command shown on the project’s **Preview** page. It opens Windows dialogs to select the downloaded handoff JSON, the original narration-and-images folder, and the MP4 output folder:

```powershell
Add-Type -AssemblyName System.Windows.Forms
$handoff = New-Object System.Windows.Forms.OpenFileDialog
$handoff.Filter = "VisualSync handoff (*.json)|*.json"
if ($handoff.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$source = New-Object System.Windows.Forms.FolderBrowserDialog
if ($source.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$output = New-Object System.Windows.Forms.FolderBrowserDialog
if ($output.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
& ".\render-approved-handoff.ps1" -HandoffPath $handoff.FileName -SourceDirectory $source.SelectedPath -OutputDirectory $output.SelectedPath -FFmpegPath "D:\ffmpeg-8.1-essentials_build\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe"
```

The worker produces the exact project-specific filename embedded in the approved handoff, such as `Finance_project_approved_1920x1080.mp4`, and stops if the approval metadata, media files, output format, or timeline durations are invalid.
