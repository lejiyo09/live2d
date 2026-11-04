import { zlibSync } from 'fflate';

/**
 * Lossless RGBA8 PNG encoder. Canvas-based encoding premultiplies alpha and
 * loses color precision in semi-transparent pixels, which is not acceptable
 * for preserved layer originals.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  return assemble(width, height, zlibSync(filterUp(width, height, rgba), { level }));
}

function filterUp(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  // Filter type 2 (Up) is a cheap, effective default for illustrations.
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = y === 0 ? 0 : 2;
    const row = y * stride;
    if (y === 0) {
      raw.set(rgba.subarray(row, row + stride), o + 1);
    } else {
      const prev = row - stride;
      for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[row + x]! - rgba[prev + x]!) & 0xff;
    }
  }
  return raw;
}

function assemble(width: number, height: number, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const out = new Uint8Array(8 + chunks.reduce((s, c) => s + c.length, 0));
  out.set(sig, 0);
  let off = 8;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
