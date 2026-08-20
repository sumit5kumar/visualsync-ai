import { storageGetSignedUrl } from "../server/storage.ts";

const key = "projects/480001/narration/Generated_Audio_August_20_2026_-_7_39PM_b15cb115.wav";
const url = await storageGetSignedUrl(key);
const response = await fetch(url, { headers: { Range: "bytes=0-127" } });
if (!response.ok && response.status !== 206) throw new Error(`Header request failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
const fmtOffset = bytes.findIndex((_, index) => ascii(index, 4) === "fmt ");
console.log(JSON.stringify({
  riff: ascii(0, 4),
  wave: ascii(8, 4),
  fmtOffset,
  audioFormat: fmtOffset >= 0 ? view.getUint16(fmtOffset + 8, true) : null,
  channels: fmtOffset >= 0 ? view.getUint16(fmtOffset + 10, true) : null,
  sampleRate: fmtOffset >= 0 ? view.getUint32(fmtOffset + 12, true) : null,
  byteRate: fmtOffset >= 0 ? view.getUint32(fmtOffset + 16, true) : null,
  blockAlign: fmtOffset >= 0 ? view.getUint16(fmtOffset + 20, true) : null,
}, null, 2));
