import { executeWithGroqRotation } from "../server/groqPool";

function silentWavBytes() {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
  return bytes;
}

async function main() {
  const run = await executeWithGroqRotation(1, async (client, key) => ({ key, value: await client.transcribeAudio({ bytes: silentWavBytes(), filename: "health.wav", mimeType: "audio/wav", language: "hi", timeoutMs: 30_000 }) }));
  console.log(JSON.stringify({ segmentCount: run.value.segments?.length ?? 0, requestDurationMs: run.value.requestMetadata.durationMs, httpStatus: run.value.requestMetadata.httpStatus, providerKey: run.key.maskedKey }));
}

void main();
