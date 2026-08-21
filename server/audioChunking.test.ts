import { describe, expect, it } from "vitest";
import { planPcmWavTranscriptionRanges, SAFE_GROQ_DIRECT_WAV_BYTES, SAFE_GROQ_DIRECT_WAV_DURATION_MS, SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, scanMp3FrameRanges, splitMp3ForTranscription, splitPcmWavForTranscription } from "./audioChunking";

function mpeg1Layer3Frame() {
  const length = 417;
  const frame = new Uint8Array(length);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

function pcmWav(dataLength: number) {
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataLength, true);
  for (let index = 44; index < bytes.length; index += 1) bytes[index] = index % 251;
  return bytes;
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

  it("keeps frame-aligned source-byte ranges so a long MP3 plan can be persisted without child uploads", () => {
    const source = new Uint8Array(417 * 5);
    for (let index = 0; index < 5; index++) source.set(mpeg1Layer3Frame(), index * 417);
    const chunks = splitMp3ForTranscription(source, 900, 0);

    expect(chunks.map(chunk => [chunk.sourceStartByte, chunk.sourceEndByteExclusive])).toEqual([[0, 834], [834, 1_668], [1_668, 2_085]]);
  });

  it("continues MP3 frame scanning from a persisted byte and timestamp boundary", () => {
    const source = new Uint8Array(417 * 5);
    for (let index = 0; index < 5; index++) source.set(mpeg1Layer3Frame(), index * 417);
    const first = scanMp3FrameRanges(source.slice(0, 900));
    const second = scanMp3FrameRanges(source.slice(first.nextByteOffset), first.nextByteOffset, first.nextTimestampMs);

    expect(first.frames.map(frame => frame.startByte)).toEqual([0, 417]);
    expect(second.frames.map(frame => frame.startByte)).toEqual([834, 1_251, 1_668]);
    expect(second.nextByteOffset).toBe(source.byteLength);
  });
});

describe("WAV transcription preparation", () => {
  it("keeps a short WAV as one direct Groq request within the direct WAV limit", () => {
    const source = pcmWav(192);
    const chunks = splitPcmWavForTranscription(source);
    expect(SAFE_GROQ_DIRECT_WAV_BYTES).toBe(24 * 1024 * 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.bytes).toEqual(source);
  });

  it("splits a long but file-size-safe PCM WAV into callback-safe duration chunks", () => {
    const source = pcmWav(3_200_000);
    const chunks = splitPcmWavForTranscription(source);

    expect(SAFE_GROQ_DIRECT_WAV_DURATION_MS).toBe(60_000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.contentEndMs).toBeLessThanOrEqual(SAFE_GROQ_DIRECT_WAV_DURATION_MS);
    expect(chunks[1]?.contentStartMs).toBe(chunks[0]?.contentEndMs);
    expect(chunks.every(chunk => chunk.bytes.byteLength <= SAFE_GROQ_DIRECT_WAV_BYTES)).toBe(true);
  });

  it("plans a five-hour PCM WAV from header metadata into bounded source ranges without allocating the full audio", () => {
    const header = pcmWav(8);
    const view = new DataView(header.buffer);
    const byteRate = 32_000;
    const dataLength = byteRate * 60 * 60 * 5;
    view.setUint32(40, dataLength, true);
    view.setUint32(4, 36 + dataLength, true);
    const plan = planPcmWavTranscriptionRanges(header, 44 + dataLength);

    expect(plan.ranges).toHaveLength(322);
    expect(plan.ranges[0]?.contentStartMs).toBe(0);
    expect(plan.ranges.at(-1)?.contentEndMs).toBe(18_000_000);
    expect(plan.ranges.every(range => range.endByteExclusive - range.startByte + 44 <= SAFE_GROQ_DIRECT_WAV_BYTES)).toBe(true);
  });

  it("splits oversized PCM WAV into independently valid bounded WAV chunks", () => {
    const chunks = splitPcmWavForTranscription(pcmWav(192), 120, 0);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => chunk.bytes.byteLength <= 120)).toBe(true);
    expect(chunks.map(chunk => String.fromCharCode(chunk.bytes[0] ?? 0, chunk.bytes[1] ?? 0, chunk.bytes[2] ?? 0, chunk.bytes[3] ?? 0))).toEqual(["RIFF", "RIFF", "RIFF"]);
    expect(chunks[1]?.contentStartMs).toBe(chunks[0]?.contentEndMs);
  });
});
