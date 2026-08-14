# Native FFmpeg Worker

This worker renders **only** an approved VisualSync handoff. It enforces the fixed 1920 × 1080 MP4 contract and retains every validated timeline start and end boundary.

After approving the Timeline in the app, save the worker handoff JSON as `approved-render-handoff.json` in the local `Nothing` folder. From PowerShell, run:

```powershell
& ".\render-approved-handoff.ps1" `
  -HandoffPath "C:\Users\sumit\Downloads\Nothing\approved-render-handoff.json" `
  -SourceDirectory "C:\Users\sumit\Downloads\try" `
  -OutputDirectory "C:\Users\sumit\Downloads\Nothing" `
  -FFmpegPath "D:\ffmpeg-8.1-essentials_build\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe"
```

The worker produces `Nothing_approved_1920x1080.mp4` in the output folder and stops if the approval metadata, media files, output format, or timeline durations are invalid.
