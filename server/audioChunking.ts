export type AudioTranscriptionChunk = { bytes: Uint8Array; startMs: number; endMs: number };

type Mp3Frame = { offset: number; length: number; durationMs: number };

const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 144, 160, 176, 192, 224, 256, 0],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

function id3v2Length(source: Uint8Array) {
  if (source.length < 10 || source[0] !== 0x49 || source[1] !== 0x44 || source[2] !== 0x33) return 0;
  return 10 + ((source[6] & 0x7f) << 21) + ((source[7] & 0x7f) << 14) + ((source[8] & 0x7f) << 7) + (source[9] & 0x7f);
}

function parseMp3Frame(source: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > source.length || source[offset] !== 0xff || (source[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (source[offset + 1] >> 3) & 0x03;
  const layerBits = (source[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (source[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (source[offset + 2] >> 2) & 0x03;
  const padding = (source[offset + 2] >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const version = versionBits === 3 ? 1 : 2;
  const layer = 4 - layerBits;
  const bitrateKbps = BITRATES[`${version}-${layer}`]?.[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[versionBits]?.[sampleRateIndex] ?? 0;
  if (!bitrateKbps || !sampleRate) return null;
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const coefficient = layer === 1 ? 12 : layer === 3 && version !== 1 ? 72 : 144;
  const length = (Math.floor((coefficient * bitrateKbps * 1000) / sampleRate) + padding) * (layer === 1 ? 4 : 1);
  if (length <= 4 || offset + length > source.length) return null;
  return { offset, length, durationMs: (samplesPerFrame * 1000) / sampleRate };
}

function scanMp3Frames(source: Uint8Array) {
  const frames: Mp3Frame[] = [];
  let offset = id3v2Length(source);
  while (offset + 4 <= source.length) {
    const frame = parseMp3Frame(source, offset);
    if (!frame) {
      if (frames.length) break;
      offset += 1;
      continue;
    }
    frames.push(frame);
    offset += frame.length;
  }
  return frames;
}

export function splitMp3ForTranscription(source: Uint8Array, maxChunkBytes = 23 * 1024 * 1024): AudioTranscriptionChunk[] {
  if (source.byteLength <= maxChunkBytes) return [{ bytes: source, startMs: 0, endMs: 0 }];
  const frames = scanMp3Frames(source);
  if (!frames.length) throw new Error("Oversized narration must be a valid MP3 so it can be split safely for Groq transcription.");
  const chunks: AudioTranscriptionChunk[] = [];
  let frameIndex = 0;
  let startMs = 0;
  while (frameIndex < frames.length) {
    const start = frames[frameIndex];
    let endFrameIndex = frameIndex;
    let durationMs = 0;
    while (endFrameIndex < frames.length) {
      const candidate = frames[endFrameIndex];
      const candidateEnd = candidate.offset + candidate.length;
      if (endFrameIndex > frameIndex && candidateEnd - start.offset > maxChunkBytes) break;
      durationMs += candidate.durationMs;
      endFrameIndex += 1;
    }
    if (endFrameIndex === frameIndex) throw new Error("A single MP3 frame exceeds the safe Groq transcription chunk size.");
    const endOffset = frames[endFrameIndex - 1].offset + frames[endFrameIndex - 1].length;
    chunks.push({ bytes: source.slice(start.offset, endOffset), startMs: Math.round(startMs), endMs: Math.round(startMs + durationMs) });
    startMs += durationMs;
    frameIndex = endFrameIndex;
  }
  return chunks;
}
