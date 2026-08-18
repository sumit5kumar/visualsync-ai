import { describe, expect, it } from "vitest";
import { SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, splitMp3ForTranscription } from "./audioChunking";

function mpeg1Layer3Frame() {
  const length = 417;
  const frame = new Uint8Array(length);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

describe("MP3 transcription chunking", () => {
  it("uses the measured Free-tier source cap for Groq-compatible WAV transcription", () => {
    expect(SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES).toBe(128 * 1024);
  });

  it("splits an approximately five-minute medium narration into bounded frame-aligned requests", () => {
    const frame = mpeg1Layer3Frame();
    const source = new Uint8Array(frame.length * 11_485);
    for (let index = 0; index < 11_485; index++) source.set(frame, index * frame.length);

    const chunks = splitMp3ForTranscription(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.bytes.byteLength <= SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES)).toBe(true);
  });

  it("splits only at MP3 frame boundaries and calculates genuine sequential offsets", () => {
    const source = new Uint8Array(417 * 5);
    for (let index = 0; index < 5; index++) source.set(mpeg1Layer3Frame(), index * 417);
    const chunks = splitMp3ForTranscription(source, 900, 0);

    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.bytes.byteLength)).toEqual([834, 834, 417]);
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBeGreaterThan(50);
    expect(chunks[1].startMs).toBe(chunks[0].endMs);
    expect(chunks[2].startMs).toBe(chunks[1].endMs);
  });

  it("adds only bounded prior-frame overlap while keeping every chunk within the size cap", () => {
    const source = new Uint8Array(417 * 8);
    for (let index = 0; index < 8; index++) source.set(mpeg1Layer3Frame(), index * 417);
    const chunks = splitMp3ForTranscription(source, 1_300, 55);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startMs).toBeLessThan(chunks[1].contentStartMs);
    expect(chunks[1].contentStartMs).toBe(chunks[0].contentEndMs);
    expect(chunks.every(chunk => chunk.bytes.byteLength <= 1_300)).toBe(true);
  });
});
