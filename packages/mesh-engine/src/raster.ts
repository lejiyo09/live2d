/**
 * Binary grids and Euclidean distance transforms used by the auto-mesh
 * generator. Grids are row-major Uint8Array (1 = inside).
 */
export interface Grid {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Downsample an alpha map into a padded grid. A cell is inside if *any*
 * covered pixel reaches `threshold` (conservative: never loses coverage).
 *
 * @param pad  padding in source pixels added on every side
 * @param scale  cells per source pixel (≤ 1)
 */
export function alphaToGrid(alpha: Uint8Array, w: number, h: number, threshold: number, pad: number, scale: number): Grid {
  const cell = 1 / scale;
  const gw = Math.ceil((w + pad * 2) * scale) + 1;
  const gh = Math.ceil((h + pad * 2) * scale) + 1;
  const data = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor((y + pad) * scale);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x]! >= threshold) data[gy * gw + Math.floor((x + pad) * scale)] = 1;
    }
  }
  void cell;
  return { width: gw, height: gh, data };
}

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/** Euclidean distance (in cells) from every cell to the nearest cell where `grid == target`. */
export function distanceTo(grid: Grid, target: 0 | 1): Float32Array {
  const { width: w, height: h, data } = grid;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const tmp = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) tmp[i] = data[i] === target ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = tmp[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) tmp[y * w + x] = d[y]!;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = tmp[y * w + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]!);
  }
  return out;
}

export function threshold(dist: Float32Array, w: number, h: number, pred: (d: number) => boolean): Grid {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = pred(dist[i]!) ? 1 : 0;
  return { width: w, height: h, data };
}
