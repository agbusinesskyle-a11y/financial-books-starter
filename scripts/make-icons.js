// Writes the installable-app icons (public/icons/icon-192.png, icon-512.png) with no image libraries:
// a teal square with a white ledger page and three ruled lines. Run: node scripts/make-icons.js
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEAL = [15, 92, 92], WHITE = [255, 255, 255], LINE = [15, 92, 92], ACCENT = [224, 161, 0];

// Colour at (x, y) in a unit square, so every size draws the same picture. Content stays inside the
// central 60% so the icon also works as a "maskable" icon (Android crops to a circle).
function colour(u, v) {
  const inPage = u > 0.3 && u < 0.7 && v > 0.24 && v < 0.76;
  if (!inPage) return TEAL;
  const r = 0.035; // rounded page corners
  const cx = Math.min(Math.max(u, 0.3 + r), 0.7 - r), cy = Math.min(Math.max(v, 0.24 + r), 0.76 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return TEAL;
  if (u > 0.36 && u < 0.64) {
    for (const y of [0.36, 0.46, 0.56]) if (Math.abs(v - y) < 0.016) return LINE;
    if (Math.abs(v - 0.66) < 0.016 && u > 0.5) return ACCENT;
  }
  return WHITE;
}

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
}
const CRC = crcTable();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const ss = 4; // 4x4 supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = colour((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (ss * ss));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const size of [192, 512]) writeFileSync(`${dir}icon-${size}.png`, png(size));
  console.log('icons written');
}
