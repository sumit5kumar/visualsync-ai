# VisualSync AI

VisualSync AI is a **narration-driven visual timeline control plane**. It is designed around one core rule: the narration determines when visuals change. The application does not divide audio equally among images, schedule a universal still-image duration, or manufacture a timeline when no real analysis exists.

## What is implemented

The web application provides a desktop-style workspace for private project records, Gemini key control, visual-timeline inspection, and render readiness. The data model uses dedicated tables for projects, encrypted Gemini key records, S3-backed media metadata, and AI-generated timeline segments. Media bytes are intentionally excluded from the database.

| Area | Implemented behavior |
| --- | --- |
| Workspace | Responsive Home, Projects, Gemini AI, Timeline, Preview, and Settings routes with authenticated empty states. |
| Project records | Creates and lists user-owned projects with narration name, image path, output path, and fixed 1920 × 1080 / 16:9 settings. |
| Gemini key vault | Adds a key only after a real server-side Gemini Interactions API test, encrypts it with AES-256-GCM, masks it in all responses, supports explicit activation, retesting, and guarded removal. |
| Gemini client | Centralizes `gemini-flash-latest` Interactions API requests for key validation, audio analysis, image analysis, candidate scoring, timeline reasoning, and quality review. |
| Timeline validation | Rejects non-positive segments, non-zero starts, gaps, overlaps, out-of-range confidence, missing metadata, and incomplete audio coverage. It performs no fallback timing calculation. |
| Worker protocol | Defines typed payloads for ingestion, natural ordering, hashes, cache reuse, FAISS indexing, Gemini analysis, timeline submission, review, and FFmpeg rendering. |
| Tests | Nine unit tests currently cover key masking, key workflow policy, natural image ordering, worker constraints, and variable-duration timeline validation. |

## Gemini and media policy

The configured model is `gemini-flash-latest`, Google's supported alias for the latest Gemini Flash release. The key-validation call is made from the server through the Interactions API, and the raw key is never returned to the client. [1] [3]

Audio and image analysis are represented by centralized Gemini client methods. Gemini supports inline audio for smaller payloads and a Files API workflow for larger files; the production worker should follow that boundary while requesting structured transcript and visual-beat output. [2]

All production narration and image files must be written to S3-compatible storage. Database records hold only object keys, source metadata, hash values, image-analysis data, and timeline references.

## Local processing handoff

> The web control plane is not a substitute for a native renderer. The actual FAISS index, perceptual hashing, folder access, and FFmpeg MP4 render must run in a connected local worker or another supported native processing environment.

The next implementation stage is to bind a local folder in Manus Desktop and add the native worker. That worker must use the supplied job schema, download or upload media through S3, access Gemini through the server-side key pathway, persist only real Gemini outputs, submit its exact variable-duration timeline for validation, and render an MP4 only when validation succeeds. It must not simulate analysis, generate hard-coded media timing, or switch visuals based on a fixed timer.

## Verification completed

The application passed `pnpm test` with **5 test files and 9 tests**. It also passed `pnpm check` with no TypeScript errors. Desktop and 375 px mobile visual reviews were captured across every workspace route, and development/browser logs contained no errors after exercising those routes.

## References

[1] [Google AI for Developers — Models](https://ai.google.dev/gemini-api/docs/models)

[2] [Google AI for Developers — Audio understanding](https://ai.google.dev/gemini-api/docs/audio)

[3] [Google AI for Developers — Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
