# VisualSync AI — Integration Constraints

The product uses Google's supported **Gemini Flash latest** alias (`gemini-flash-latest`) through the Interactions API as its only analysis model. The server must submit audio and image inputs directly to Gemini using a user-managed key that is decrypted only in server memory. The frontend must receive only key labels, masked suffixes, test status, and activation state. [3] [4]

For audio, Gemini supports both inline data and files uploaded before the analysis request. Files over 20 MB should use the Gemini Files API; smaller payloads can be sent inline. Prompt requests must require structured transcript and visual-beat JSON with model-provided timestamps only. No transcription fallback, sentence-duration estimate, image-count split, or universal timing rule is allowed. [2]

The managed web application can provide the authenticated control plane, encrypted key vault, metadata database, S3-compatible media references, and timeline review interface. A production renderer using **FAISS** and **FFmpeg** needs a local desktop worker or a host with Python/native dependencies and sustained CPU resources. The website will surface the connection state honestly and must not invent analysis, image metadata, timeline entries, rendering progress, or output files when that worker is unavailable.

The database stores only metadata and S3 object keys/URLs. Narration audio and image bytes remain in S3-compatible storage. The actual timeline is a sequence of AI-selected segments with explicit start/end values; validation must enforce full audio coverage and forbid gaps, overlaps, and non-positive duration records.

## References

[1] [Google AI for Developers — Models](https://ai.google.dev/gemini-api/docs/models)

[2] [Google AI for Developers — Audio understanding](https://ai.google.dev/gemini-api/docs/audio)

## Supported-model update — August 2026

The Gemini Interactions API is generally available and is Google's recommended API for access to current models and features. Its `POST /v1beta/interactions` operation accepts a required `model`, an `input`, `store`, a `generation_config`, and an optional JSON `response_format`. The documented model options include `gemini-flash-latest`, which is selected as the configurable default for new users instead of the retired legacy path. [3] [4]

The interaction response exposes generated content through a `model_output` step with a text content item. Key validation uses a minimal, stateless interaction (`store: false`) and extracts that step rather than parsing the legacy `candidates` response. Structured analysis requests retain an explicit JSON response format contract. [4]

The official OpenAPI schema represents text, image, and audio inputs as typed content objects. Image and audio objects accept `type`, `mime_type`, and either base64 `data` or a `uri`; structured text output uses a `response_format` object with `type: "text"`, `mime_type: "application/json"`, and an optional JSON `schema`. [4]

[3] [Google AI for Developers — Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions-overview)

[4] [Google AI for Developers — Interactions API reference](https://ai.google.dev/api/interactions-api#CreateInteraction)
