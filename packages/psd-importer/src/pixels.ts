import type { PixelData } from 'ag-psd';

/** 8-bit straight-alpha RGBA buffer. */
export interface Rgba8 {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Normalize ag-psd pixel data (8/16/32-bit) to 8-bit RGBA. */
export function toRgba8(px: PixelData, bitsPerChannel = 8): Rgba8 {
  const { width, height, data } = px;
  if (data instanceof Uint8ClampedArray) return { width, height, data };
  const out = new Uint8ClampedArray(width * height * 4);
  if (data instanceof Uint8Array) {
    out.set(data);
  } else if (data instanceof Uint16Array) {
    const max = bitsPerChannel === 16 ? 65535 : 255;
    for (let i = 0; i < out.length; i++) out[i] = Math.round((data[i]! / max) * 255);
  } else {
    // 32-bit float, linear 0..1. Photoshop stores 32-bit in linear light; convert to sRGB for color channels.
    for (let i = 0; i < out.length; i++) {
      const v = data[i]!;
      out[i] = (i & 3) === 3 ? Math.round(v * 255) : Math.round(linearToSrgb(v) * 255);
    }
  }
  return { width, height, data: out };
}

function linearToSrgb(v: number) {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function cloneRgba(src: Rgba8): Rgba8 {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

/** Count of pixels with alpha > 0. */
export function isFullyTransparent(img: Rgba8): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

/**
 * Multiply the alpha of `img` (placed at `imgX,imgY` in canvas space) by a
 * coverage function evaluated in canvas space.
 */
export function multiplyAlpha(img: Rgba8, imgX: number, imgY: number, coverage: (cx: number, cy: number) => number) {
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3;
      const a = data[i]!;
      if (a === 0) continue;
      const c = coverage(imgX + x, imgY + y);
      if (c >= 255) continue;
      data[i] = (a * c + 127) / 255;
    }
  }
}
