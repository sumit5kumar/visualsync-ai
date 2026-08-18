import decodeMp3 from "@audio/decode-mp3";

const TARGET_SAMPLE_RATE = 16_000;

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}

export async function mp3ToMonoWav(source: Uint8Array) {
  const decoded = await decodeMp3(source);
  const frames = Math.max(1, Math.floor((decoded.channelData[0]?.length ?? 0) * TARGET_SAMPLE_RATE / decoded.sampleRate));
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, frames * 2, true);

  for (let frame = 0; frame < frames; frame++) {
    const sourceFrame = Math.min(Math.floor(frame * decoded.sampleRate / TARGET_SAMPLE_RATE), (decoded.channelData[0]?.length ?? 1) - 1);
    const sample = decoded.channelData.reduce((total, channel) => total + (channel[sourceFrame] ?? 0), 0) / Math.max(1, decoded.channelData.length);
    view.setInt16(44 + frame * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }

  return bytes;
}
