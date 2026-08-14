# Project TODO

- [x] Create a desktop-style VisualSync AI shell with responsive navigation for Home, Projects, Gemini AI, Timeline, Preview, and Settings.
- [x] Implement project creation, persistent project records, recent-project listing, and fixed 1920 × 1080 / 16:9 output settings.
- [x] Add encrypted server-side storage for multiple Gemini API keys, including masked display, explicit status, controlled active-key switching, and safe removal.
- [x] Implement a real, server-only Gemini key-validation request with actionable authentication, quota, rate-limit, and availability errors; later migrated to the supported Interactions API.
- [x] Centralize the Gemini client with typed request contracts for audio analysis, image analysis, candidate evaluation, timeline reasoning, and quality review; later migrated to the supported Interactions API.
- [x] Model S3-backed narration and image asset references without storing media bytes in the database.
- [x] Define local-worker contracts for real audio ingestion, image scanning, natural sort, perceptual hashing, persistent cache reuse, FAISS search, and FFmpeg MP4 rendering.
- [x] Implement timeline validation that rejects gaps, overlaps, non-positive durations, non-zero starts, and incomplete audio coverage without creating fixed-duration fallbacks.
- [x] Build a no-fabrication project workspace UI that displays only real persisted data and clearly reports when the local processing engine is not connected.
- [x] Add tests for API-key masking, secure key workflow rules, and variable-duration timeline validation.
- [x] Verify responsive UI states, run type checks and tests, and capture a visual review of the finished application.
- [x] Define typed local-worker job contracts for audio ingestion, natural image ordering, perceptual hashing, persistent cache reuse, FAISS indexing, Gemini analysis, timeline submission, and FFmpeg rendering.
- [x] Add server tests that enforce verified-only key activation, active-key removal safeguards, duplicate-key rejection, and key-test state recording.
- [x] Verify all client routes render and surface authenticated empty and loading states correctly.
- [x] Replace the retired legacy Generate Content path with a current supported model and official Interactions API contract for key testing and structured analysis.
- [x] Update all server, UI, worker-protocol, documentation, and test references to the supported Gemini model without exposing API keys to the client.
- [x] Add regression tests for the configured model and key-test request contract, then verify the application builds cleanly.
