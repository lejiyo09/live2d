/**
 * Part segmentation (spec §10.2) — classical, no learned model: alpha
 * islands (8-connected components) and, optionally, colour regions
 * (k-means in RGB, then connected components per colour). Occluded art is
 * not reconstructed; the spec allows that and expects manual touch-up.
 */
export interface Region {
  /** Bounding box in layer pixels. */
  x: number; y: number; width: number; height: number;
  /** Alpha (0..255) of this region inside its box, row-major. */
  mask: Uint8Array;
  pixels: number;
  /** Mean colour (0..255). */
  color: [number, number, number];
}

export interface SegmentOptions {
  mode: 'islands' | 'colors';
  /** Colour clusters for 'colors' mode (2–8). */
  clusters?: number;
  alphaThreshold?: number;
  /** Regions smaller than this many pixels are merged into the nearest neighbour region (or dropped). */
  minPixels?: number;
}

function components(w: number, h: number, inside: (i: number) => boolean): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== -1 || !inside(i)) continue;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
          const q = ny * w + nx;
          if (labels[q] === -1 && inside(q) && sameGroup(p, q)) { labels[q] = count; stack.push(q); }
        }
      }
    }
    count++;
  }
  return { labels, count };
  function sameGroup(_a: number, _b: number) { return true; }
}

function kmeans(rgba: Uint8Array | Uint8ClampedArray, idx: number[], k: number): Uint8Array {
  // Deterministic init: spread over the sorted luminance.
  const lum = (i: number) => rgba[i * 4]! * 0.3 + rgba[i * 4 + 1]! * 0.59 + rgba[i * 4 + 2]! * 0.11;
  const sorted = [...idx].sort((a, b) => lum(a) - lum(b));
  const cent = Array.from({ length: k }, (_, c) => { const i = sorted[Math.floor(((c + 0.5) / k) * sorted.length)]!; return [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]; });
  const assign = new Uint8Array(rgba.length / 4);
  const step = Math.max(1, Math.floor(idx.length / 20000)); // subsample for speed
  for (let it = 0; it < 12; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < idx.length; j += step) {
      const i = idx[j]!;
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = (rgba[i * 4]! - cent[c]![0]!) ** 2 + (rgba[i * 4 + 1]! - cent[c]![1]!) ** 2 + (rgba[i * 4 + 2]! - cent[c]![2]!) ** 2; if (d < bd) { bd = d; best = c; } }
      const s = sum[best]!; s[0]! += rgba[i * 4]!; s[1]! += rgba[i * 4 + 1]!; s[2]! += rgba[i * 4 + 2]!; s[3]!++;
    }
    for (let c = 0; c < k; c++) if (sum[c]![3]) cent[c] = [sum[c]![0]! / sum[c]![3]!, sum[c]![1]! / sum[c]![3]!, sum[c]![2]! / sum[c]![3]!];
  }
  for (const i of idx) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const d = (rgba[i * 4]! - cent[c]![0]!) ** 2 + (rgba[i * 4 + 1]! - cent[c]![1]!) ** 2 + (rgba[i * 4 + 2]! - cent[c]![2]!) ** 2; if (d < bd) { bd = d; best = c; } }
    assign[i] = best;
  }
  return assign;
}

export function segmentLayer(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, opts: SegmentOptions): Region[] {
  const thr = opts.alphaThreshold ?? 16;
  const minPx = opts.minPixels ?? Math.max(32, Math.round(w * h * 0.0005));
  const opaque = (i: number) => rgba[i * 4 + 3]! >= thr;
  let labels: Int32Array, count: number;
  if (opts.mode === 'islands') {
    ({ labels, count } = components(w, h, opaque));
  } else {
    const idx: number[] = [];
    for (let i = 0; i < w * h; i++) if (opaque(i)) idx.push(i);
    const k = Math.min(8, Math.max(2, opts.clusters ?? 3));
    const cls = kmeans(rgba, idx, k);
    // Connected components within each colour class.
    labels = new Int32Array(w * h).fill(-1);
    count = 0;
    const stack: number[] = [];
    for (const i0 of idx) {
      if (labels[i0] !== -1) continue;
      const c = cls[i0]!;
      labels[i0] = count; stack.push(i0);
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
            const q = ny * w + nx;
            if (labels[q] === -1 && opaque(q) && cls[q] === c) { labels[q] = count; stack.push(q); }
          }
        }
      }
      count++;
    }
  }
  // Region sizes; merge small fragments into the most common neighbouring large region.
  const size = new Int32Array(count);
  for (let i = 0; i < w * h; i++) if (labels[i]! >= 0) size[labels[i]!]!++;
  const big = (l: number) => size[l]! >= minPx;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < w * h; i++) {
      const l = labels[i]!;
      if (l < 0 || big(l)) continue;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nl = labels[ny * w + nx]!;
        if (nl >= 0 && big(nl)) { labels[i] = nl; size[nl]!++; size[l]!--; break; }
      }
    }
  }
  const regions: Region[] = [];
  for (let l = 0; l < count; l++) {
    if (!big(l)) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < w * h; i++) if (labels[i] === l) {
      const x = i % w, y = (i - x) / w;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      n++; r += rgba[i * 4]!; g += rgba[i * 4 + 1]!; b += rgba[i * 4 + 2]!;
    }
    if (x1 < 0) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const mask = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === l) mask[(y - y0) * bw + (x - x0)] = rgba[(y * w + x) * 4 + 3]!;
    regions.push({ x: x0, y: y0, width: bw, height: bh, mask, pixels: n, color: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] });
  }
  return regions.sort((a, b) => b.pixels - a.pixels);
}

/** RGBA pixels of a region cut out of the source (straight alpha). */
export function regionPixels(rgba: Uint8Array | Uint8ClampedArray, w: number, r: Region): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const a = r.mask[y * r.width + x]!;
    if (!a) continue;
    const s = ((r.y + y) * w + (r.x + x)) * 4, d = (y * r.width + x) * 4;
    out[d] = rgba[s]!; out[d + 1] = rgba[s + 1]!; out[d + 2] = rgba[s + 2]!; out[d + 3] = a;
  }
  return out;
}
