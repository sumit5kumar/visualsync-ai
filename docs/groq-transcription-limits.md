# Groq Speech-to-Text Limits

Source: [Groq Speech-to-Text documentation](https://console.groq.com/docs/speech-to-text), accessed 2026-08-18.

The official documentation states that the maximum direct audio attachment is **25 MB**, and that larger files should use the transcription endpoint's `url` parameter. It also documents that the free-tier maximum file size is 25 MB and that URL or direct upload are accepted for transcription.

VisualSync uses a server-generated, time-limited S3 URL for oversized narration. The URL is sent only from the backend to Groq; it is not exposed to the frontend. This avoids direct multipart attachment limits while preserving Groq's genuine timestamped `verbose_json` transcription response.
