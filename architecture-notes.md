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

## Groq Cloud provider contract — August 2026

Groq Cloud will remain an independent, user-selectable provider alongside Gemini. Its API key must be encrypted at rest, decrypted only in server memory, and sent only as a server-side `Authorization: Bearer` header. The browser receives labels, masked suffixes, verification state, and activation state only.

For Hindi and Hinglish narration transcription, Groq documents its OpenAI-compatible `POST https://api.groq.com/openai/v1/audio/transcriptions` endpoint with `whisper-large-v3` for multilingual accuracy and `whisper-large-v3-turbo` for lower-cost multilingual transcription. The integration will request `verbose_json`, segment timestamps, and an explicit `hi` language hint where suitable, preserving only returned timestamps rather than estimating durations. [5]

For image analysis, Groq documents `qwen/qwen3.6-27b` as the current vision-capable model through `POST https://api.groq.com/openai/v1/chat/completions`, accepting text plus image URLs or data URLs and supporting JSON mode. This supersedes the unverified assumption that a Llama 3.2 Vision identifier is the current contract. [6]

[5] [GroqDocs — Speech to Text](https://console.groq.com/docs/speech-to-text)

[6] [GroqDocs — Images and Vision](https://console.groq.com/docs/vision)
