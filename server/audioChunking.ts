export type AudioTranscriptionChunk = {
  bytes: Uint8Array;
  startMs: number;
  endMs: number;
  contentStartMs: number;
  contentEndMs: number;
};

// The production request converts this MP3 slice to 16 kHz mono WAV. A 128 KiB
// frame-aligned source slice produces a roughly 260 KiB WAV request that Groq
// completed successfully on the Free tier; larger measured attachments stalled.
export const SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES = 128 * 1024;
export const SAFE_GROQ_DIRECT_WAV_BYTES = 24 * 1024 * 1024;
export const SAFE_GROQ_DIRECT_WAV_DURATION_MS = 90_000;

type Mp3Frame = { offset: number; length: number; durationMs: number; startMs: number; endMs: number };

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
  return { offset, length, durationMs: (samplesPerFrame * 1000) / sampleRate, startMs: 0, endMs: 0 };
}

function scanMp3Frames(source: Uint8Array) {
  const frames: Mp3Frame[] = [];
  let offset = id3v2Length(source);
  let cursorMs = 0;
  while (offset + 4 <= source.length) {
    const frame = parseMp3Frame(source, offset);
    if (!frame) {
      if (frames.length) break;
      offset += 1;
      continue;
    }
    frame.startMs = cursorMs;
    frame.endMs = cursorMs + frame.durationMs;
    frames.push(frame);
    cursorMs = frame.endMs;
    offset += frame.length;
  }
  return frames;
}

type PcmWavInfo = {
  fmtBytes: Uint8Array;
  dataOffset: number;
  dataLength: number;
  blockAlign: number;
  byteRate: number;
};

function readAscii(source: Uint8Array, offset: number, length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(source[offset + index] ?? 0);
  return value;
}

function readPcmWavInfo(source: Uint8Array): PcmWavInfo {
  if (source.length < 44 || readAscii(source, 0, 4) !== "RIFF" || readAscii(source, 8, 4) !== "WAVE") throw new Error("Oversized WAV narration must use a standard RIFF/WAVE container.");
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 12;
  let fmtBytes: Uint8Array | null = null;
  let blockAlign = 0;
  let byteRate = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= source.length) {
    const chunkId = readAscii(source, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkLength > source.length) break;
    if (chunkId === "fmt ") {
      if (chunkLength < 16) throw new Error("WAV narration has an incomplete format chunk.");
      const audioFormat = view.getUint16(payloadOffset, true);
      if (audioFormat !== 1) throw new Error("Oversized WAV narration must use PCM audio for automatic chunking.");
      byteRate = view.getUint32(payloadOffset + 8, true);
      blockAlign = view.getUint16(payloadOffset + 12, true);
      if (!byteRate || !blockAlign) throw new Error("WAV narration has invalid PCM timing metadata.");
      fmtBytes = source.slice(payloadOffset, payloadOffset + chunkLength);
    } else if (chunkId === "data") {
      dataOffset = payloadOffset;
      dataLength = chunkLength;
      break;
    }
    offset = payloadOffset + chunkLength + (chunkLength % 2);
  }
  if (!fmtBytes || dataOffset < 0 || !dataLength) throw new Error("WAV narration is missing PCM audio data.");
  return { fmtBytes, dataOffset, dataLength, blockAlign, byteRate };
}

function makePcmWavChunk(fmtBytes: Uint8Array, pcmBytes: Uint8Array) {
  const bytes = new Uint8Array(12 + 8 + fmtBytes.length + 8 + pcmBytes.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, fmtBytes.length, true);
  bytes.set(fmtBytes, 20);
  const dataHeaderOffset = 20 + fmtBytes.length;
  bytes.set([0x64, 0x61, 0x74, 0x61], dataHeaderOffset);
  view.setUint32(dataHeaderOffset + 4, pcmBytes.length, true);
  bytes.set(pcmBytes, dataHeaderOffset + 8);
  return bytes;
}

export function splitPcmWavForTranscription(source: Uint8Array, maxChunkBytes = SAFE_GROQ_DIRECT_WAV_BYTES, overlapMs = 4_000): AudioTranscriptionChunk[] {
  let info: PcmWavInfo;
  try {
    info = readPcmWavInfo(source);
  } catch (error) {
    if (source.byteLength <= maxChunkBytes) return [{ bytes: source, startMs: 0, endMs: 0, contentStartMs: 0, contentEndMs: 0 }];
    throw error;
  }
  const durationMs = Math.round((info.dataLength / info.byteRate) * 1000);
  if (source.byteLength <= maxChunkBytes && durationMs <= SAFE_GROQ_DIRECT_WAV_DURATION_MS) return [{ bytes: source, startMs: 0, endMs: durationMs, contentStartMs: 0, contentEndMs: durationMs }];
  const headerBytes = 28 + info.fmtBytes.length;
  const byteLimitedPayload = Math.floor((maxChunkBytes - headerBytes) / info.blockAlign) * info.blockAlign;
  const durationLimitedPayload = Math.floor((info.byteRate * SAFE_GROQ_DIRECT_WAV_DURATION_MS) / 1000 / info.blockAlign) * info.blockAlign;
  const maximumPayload = Math.min(byteLimitedPayload, durationLimitedPayload);
  if (maximumPayload <= 0) throw new Error("WAV transcription chunk limit is too small for this PCM format.");
  const overlapBytes = Math.floor((info.byteRate * overlapMs) / 1000 / info.blockAlign) * info.blockAlign;
  const chunks: AudioTranscriptionChunk[] = [];
  let contentOffset = 0;
  while (contentOffset < info.dataLength) {
    const startOffset = Math.max(0, contentOffset - overlapBytes);
    const remaining = info.dataLength - contentOffset;
    const contentLength = Math.min(maximumPayload - (contentOffset > 0 ? Math.min(overlapBytes, contentOffset) : 0), remaining);
    const alignedContentLength = Math.max(info.blockAlign, Math.floor(contentLength / info.blockAlign) * info.blockAlign);
    const endOffset = Math.min(info.dataLength, contentOffset + alignedContentLength);
    const pcmBytes = source.slice(info.dataOffset + startOffset, info.dataOffset + endOffset);
    chunks.push({
      bytes: makePcmWavChunk(info.fmtBytes, pcmBytes),
      startMs: Math.round((startOffset / info.byteRate) * 1000),
      endMs: Math.round((endOffset / info.byteRate) * 1000),
      contentStartMs: Math.round((contentOffset / info.byteRate) * 1000),
      contentEndMs: Math.round((endOffset / info.byteRate) * 1000),
    });
    contentOffset = endOffset;
  }
  return chunks;
}

export function splitMp3ForTranscription(source: Uint8Array, maxChunkBytes = SAFE_GROQ_TRANSCRIPTION_CHUNK_BYTES, overlapMs = 4_000): AudioTranscriptionChunk[] {
  if (source.byteLength <= maxChunkBytes) return [{ bytes: source, startMs: 0, endMs: 0, contentStartMs: 0, contentEndMs: 0 }];
  const frames = scanMp3Frames(source);
  if (!frames.length) throw new Error("Oversized narration must be a valid MP3 so it can be split safely for Groq transcription.");
  const chunks: AudioTranscriptionChunk[] = [];
  let frameIndex = 0;
  while (frameIndex < frames.length) {
    const contentStart = frames[frameIndex];
    let overlapStartIndex = frameIndex;
    while (overlapStartIndex > 0 && contentStart.startMs - frames[overlapStartIndex - 1].startMs < overlapMs) overlapStartIndex -= 1;
    const start = frames[overlapStartIndex];
    let endFrameIndex = frameIndex;
    while (endFrameIndex < frames.length) {
      const candidate = frames[endFrameIndex];
      const candidateEnd = candidate.offset + candidate.length;
      if (endFrameIndex > frameIndex && candidateEnd - start.offset > maxChunkBytes) break;
      endFrameIndex += 1;
    }
    if (endFrameIndex === frameIndex) throw new Error("A single MP3 frame exceeds the safe Groq transcription chunk size.");
    const endOffset = frames[endFrameIndex - 1].offset + frames[endFrameIndex - 1].length;
    const contentEnd = frames[endFrameIndex - 1];
    chunks.push({ bytes: source.slice(start.offset, endOffset), startMs: Math.round(start.startMs), endMs: Math.round(contentEnd.endMs), contentStartMs: Math.round(contentStart.startMs), contentEndMs: Math.round(contentEnd.endMs) });
    frameIndex = endFrameIndex;
  }
  return chunks;
}
