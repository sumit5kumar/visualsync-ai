import { describe, expect, it } from "vitest";
import { splitMp3ForTranscription } from "./audioChunking";

function mpeg1Layer3Frame() {
  const length = 417;
  const frame = new Uint8Array(length);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

describe("MP3 transcription chunking", () => {
  it("splits only at MP3 frame boundaries and calculates genuine sequential offsets", () => {
    const source = new Uint8Array(417 * 5);
    for (let index = 0; index < 5; index++) source.set(mpeg1Layer3Frame(), index * 417);
    const chunks = splitMp3ForTranscription(source, 900);

    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.bytes.byteLength)).toEqual([834, 834, 417]);
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBeGreaterThan(50);
    expect(chunks[1].startMs).toBe(chunks[0].endMs);
    expect(chunks[2].startMs).toBe(chunks[1].endMs);
  });
});
