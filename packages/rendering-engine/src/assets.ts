import { CanvasSource, Texture } from 'pixi.js';

/** Transparent border added around every texture so mesh margins outside the art sample transparency, not clamped edge pixels. */
export const TEXTURE_PAD = 2;

interface Entry {
  texture: Texture;
  /** Unpadded size (= layer bounds). */
  width: number;
  height: number;
  /** One byte per pixel, used for pixel-accurate picking. */
  alpha: Uint8Array;
}

/**
 * GPU textures + CPU alpha maps for display assets. Only display assets are
 * uploaded; originals and masks stay as compressed blobs in storage.
 */
export class TextureCache {
  private entries = new Map<string, Entry>();

  has(id: string) {
    return this.entries.has(id) || id.startsWith('builtin:');
  }

  get(id: string): Texture | undefined {
    if (id === 'builtin:brush') return brushTexture();
    return this.entries.get(id)?.texture;
  }

  /**
   * Takes ownership of `bitmap`. The bitmap is copied into a canvas with a
   * {@link TEXTURE_PAD}-px transparent border. Canvas uploads honour
   * UNPACK_PREMULTIPLY_ALPHA (ImageBitmap uploads do not), so alpha handling is
   * identical regardless of how the bitmap was decoded.
   */
  add(id: string, bitmap: ImageBitmap, alpha: Uint8Array) {
    this.delete(id);
    const canvas = new OffscreenCanvas(bitmap.width + TEXTURE_PAD * 2, bitmap.height + TEXTURE_PAD * 2);
    canvas.getContext('2d')!.drawImage(bitmap, TEXTURE_PAD, TEXTURE_PAD);
    const width = bitmap.width, height = bitmap.height;
    bitmap.close();
    const source = new CanvasSource({ resource: canvas as unknown as HTMLCanvasElement, label: id });
    const texture = new Texture({ source });
    this.entries.set(id, { texture, width, height, alpha });
  }

  /** Alpha map (one byte per pixel, unpadded) for mesh generation and quality checks. */
  getAlpha(id: string): { alpha: Uint8Array; width: number; height: number } | undefined {
    const e = this.entries.get(id);
    return e && { alpha: e.alpha, width: e.width, height: e.height };
  }

  async addFromBlob(id: string, blob: Blob) {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    this.add(id, bitmap, extractAlpha(bitmap));
  }

  sampleAlpha = (id: string, x: number, y: number): number | undefined => {
    if (id === 'builtin:brush') return BRUSH_ALPHA[Math.min(BRUSH_H - 1, Math.max(0, y))] ?? 0;
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (x < 0 || y < 0 || x >= e.width || y >= e.height) return 0;
    return e.alpha[y * e.width + x];
  };

  delete(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.texture.destroy(true);
    this.entries.delete(id);
  }

  /** Drop entries not in `keep`. */
  retain(keep: Set<string>) {
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.delete(id);
  }

  clear() {
    for (const id of [...this.entries.keys()]) this.delete(id);
  }

  get size() {
    return this.entries.size;
  }
}

export function extractAlpha(bitmap: ImageBitmap): Uint8Array {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const a = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j]!;
  return a;
}

export function alphaFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const a = new Uint8Array(width * height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = rgba[j]!;
  return a;
}

/** Built-in white brush for ArtPaths: soft edges across v (rows), uniform along u. */
const BRUSH_W = 4, BRUSH_H = 32;
const BRUSH_ALPHA = Array.from({ length: BRUSH_H }, (_, y) => {
  const d = Math.abs((y + 0.5) / BRUSH_H - 0.5) * 2; // 0 centre … 1 edge
  return Math.round(255 * Math.min(1, Math.max(0, (1 - d) / 0.25)));
});
let brush: Texture | null = null;
export function brushTexture(): Texture {
  if (brush) return brush;
  const c = new OffscreenCanvas(BRUSH_W, BRUSH_H);
  const g = c.getContext('2d')!;
  const img = g.createImageData(BRUSH_W, BRUSH_H);
  for (let y = 0; y < BRUSH_H; y++) for (let x = 0; x < BRUSH_W; x++) img.data.set([255, 255, 255, BRUSH_ALPHA[y]!], (y * BRUSH_W + x) * 4);
  g.putImageData(img, 0, 0);
  brush = new Texture({ source: new CanvasSource({ resource: c as unknown as HTMLCanvasElement, label: 'builtin:brush' }) });
  return brush;
}
