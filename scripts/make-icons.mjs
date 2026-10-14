// Generates the extension icons (two overlapping "lenses" on a dark tile) without any deps.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.2; // tile corner radius
  const lens = size * 0.26;
  const left = [size * 0.43, size * 0.5];
  const right = [size * 0.57, size * 0.5];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Rounded-rect coverage with 1px antialiasing.
      const dx = Math.max(r - px, 0, px - (size - r));
      const dy = Math.max(r - py, 0, py - (size - r));
      const tile = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
      const inL = Math.min(1, Math.max(0, lens - Math.hypot(px - left[0], py - left[1]) + 0.5));
      const inR = Math.min(1, Math.max(0, lens - Math.hypot(px - right[0], py - right[1]) + 0.5));
      let c = [32, 34, 38];
      c = c.map((v, i) => v + ([230, 60, 60][i] - v) * inL * 0.9);
      c = c.map((v, i) => Math.max(v, v + ([40, 200, 230][i] - v) * inR * 0.9));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
      raw[o + 3] = Math.round(tile * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('src/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) await writeFile(`src/icons/icon${s}.png`, png(s));
console.log('Wrote src/icons/icon{16,32,48,128}.png');
