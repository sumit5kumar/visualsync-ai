# VisualSync AI — Integration Constraints

The product uses **Gemini 2.5 Flash** (`gemini-2.5-flash`) as its only analysis model. The server must submit audio and image inputs directly to Gemini using a user-managed key that is decrypted only in server memory. The frontend must receive only key labels, masked suffixes, test status, and activation state. The model identifier is listed in Google's model documentation as the Gemini 2.5 Flash endpoint. [1]

For audio, Gemini supports both inline data and files uploaded before the analysis request. Files over 20 MB should use the Gemini Files API; smaller payloads can be sent inline. Prompt requests must require structured transcript and visual-beat JSON with model-provided timestamps only. No transcription fallback, sentence-duration estimate, image-count split, or universal timing rule is allowed. [2]

The managed web application can provide the authenticated control plane, encrypted key vault, metadata database, S3-compatible media references, and timeline review interface. A production renderer using **FAISS** and **FFmpeg** needs a local desktop worker or a host with Python/native dependencies and sustained CPU resources. The website will surface the connection state honestly and must not invent analysis, image metadata, timeline entries, rendering progress, or output files when that worker is unavailable.

The database stores only metadata and S3 object keys/URLs. Narration audio and image bytes remain in S3-compatible storage. The actual timeline is a sequence of AI-selected segments with explicit start/end values; validation must enforce full audio coverage and forbid gaps, overlaps, and non-positive duration records.

## References

[1] [Google AI for Developers — Models](https://ai.google.dev/gemini-api/docs/models)

[2] [Google AI for Developers — Audio understanding](https://ai.google.dev/gemini-api/docs/audio)
