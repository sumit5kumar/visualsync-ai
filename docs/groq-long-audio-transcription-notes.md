# Groq Long-Audio Transcription Notes

The official Groq speech-to-text documentation states that free-tier speech-to-text requests have a 25 MB maximum file size and recommends audio chunking for files that exceed the provider limit or need more precise transcription control. It specifies chunking with small overlap and careful merging of the resulting timestamped output. The same documentation confirms that `verbose_json` with segment timestamps is supported.

The official Batch documentation confirms that batch transcription requests use URL input, but asynchronous batch completion can take from 24 hours to seven days. The active VisualSync user flow therefore remains a sequential, user-triggered transcription path with persisted chunk state rather than switching to a delayed batch-only experience.

Sources:

- https://console.groq.com/docs/speech-to-text
- https://console.groq.com/docs/batch
