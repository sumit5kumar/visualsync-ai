import { describe, expect, it } from "vitest";
import {
  DEEPGRAM_LISTEN_ENDPOINT,
  DeepgramTranscriptionAdapter,
  LocalFasterWhisperAdapter,
  TranscriptionProviderError,
  deepgramListenUrl,
  localWhisperConfig,
  normalizeDeepgramResponse,
  normalizeFasterWhisperResponse,
} from "./transcriptionProviders";

describe("transcription provider adapters", () => {
  it("builds the Deepgram Nova-2 listen URL with word timestamps and utterances enabled", () => {
    const url = new URL(deepgramListenUrl());
    expect(url.origin + url.pathname).toBe(DEEPGRAM_LISTEN_ENDPOINT);
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("hi");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("utterances")).toBe("true");
  });

  it("normalizes Deepgram utterances into provider-agnostic segments with word timestamps", () => {
    const transcript = normalizeDeepgramResponse({
      metadata: { duration: 10.5 },
      results: {
        channels: [{ detected_language: "hi", alternatives: [{ transcript: "hello world", words: [{ punctuated_word: "hello", start: 0.1, end: 0.4 }, { punctuated_word: "world.", start: 0.5, end: 0.9 }] }] }],
        utterances: [
          { start: 0.1, end: 0.4, transcript: "hello", words: [{ punctuated_word: "hello", start: 0.1, end: 0.4 }] },
          { start: 0.5, end: 0.9, transcript: "world.", words: [{ punctuated_word: "world.", start: 0.5, end: 0.9 }] },
        ],
      },
    });
    expect(transcript.provider).toBe("DEEPGRAM_NOVA2");
    expect(transcript.text).toBe("hello world");
    expect(transcript.language).toBe("hi");
    expect(transcript.durationSeconds).toBe(10.5);
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0].words?.[0]).toMatchObject({ word: "hello", start: 0.1, end: 0.4 });
  });

  it("normalizes a local Faster-Whisper response into the same provider-agnostic segment shape", () => {
    const transcript = normalizeFasterWhisperResponse({
      text: "namaste duniya",
      language: "hi",
      duration: 4.2,
      segments: [{ id: 0, start: 0, end: 4.2, text: "namaste duniya", words: [{ word: "namaste", start: 0, end: 0.8 }, { word: "duniya", start: 1, end: 1.8 }] }],
    });
    expect(transcript.provider).toBe("LOCAL_FASTER_WHISPER");
    expect(transcript.segments[0].words).toHaveLength(2);
  });

  it("exposes local GPU configuration only when LOCAL_WHISPER_URL is set", () => {
    expect(localWhisperConfig({})).toBeNull();
    expect(localWhisperConfig({ LOCAL_WHISPER_URL: "http://192.168.0.10:8000" })).toMatchObject({ url: "http://192.168.0.10:8000" });
  });

  it("surfaces a non-retryable TranscriptionProviderError when the Deepgram key is rejected", () => {
    const error = new TranscriptionProviderError("Deepgram rejected this API key.", "DEEPGRAM_NOVA2", false, 401);
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(401);
  });
});
