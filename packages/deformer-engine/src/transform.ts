/**
 * Resolved (canvas-space) deformers. A child's local coordinates are mapped
 * through its *immediate* parent's resolved form only: warp children are
 * interpolated among the warp's canvas grid points, rotation children are
 * rotated/scaled around the canvas origin.
 */
export interface ResolvedWarp {
  kind: 'warp';
  id: string;
  cols: number;
  rows: number;
  /** Canvas-space grid points, row-major, flat. */
  points: Float64Array;
  opacity: number;
}

export interface ResolvedRotation {
  kind: 'rotation';
  id: string;
  x: number;
  y: number;
  /** Effective canvas angle in degrees (includes parent rotation). */
  angle: number;
  /** Effective scale (includes parent scale). */
  scale: number;
  opacity: number;
  handleLength: number;
}

export type Resolved = ResolvedWarp | ResolvedRotation;

/** Bilinear warp; points outside 0..1 extrapolate from the border cell. */
export function warpForward(w: ResolvedWarp, u: number, v: number, out: [number, number] = [0, 0]): [number, number] {
  const fx = u * w.cols, fy = v * w.rows;
  const cx = Math.min(w.cols - 1, Math.max(0, Math.floor(fx)));
  const cy = Math.min(w.rows - 1, Math.max(0, Math.floor(fy)));
  const s = fx - cx, t = fy - cy;
  const stride = w.cols + 1;
  const p = w.points;
  const i00 = (cy * stride + cx) * 2, i10 = i00 + 2, i01 = i00 + stride * 2, i11 = i01 + 2;
  const a = (1 - s) * (1 - t), b = s * (1 - t), c = (1 - s) * t, d = s * t;
  out[0] = a * p[i00]! + b * p[i10]! + c * p[i01]! + d * p[i11]!;
  out[1] = a * p[i00 + 1]! + b * p[i10 + 1]! + c * p[i01 + 1]! + d * p[i11 + 1]!;
  return out;
}

/** Inverse warp by Newton iteration (finds u, v with warpForward(u, v) ≈ (x, y)). */
export function warpInverse(w: ResolvedWarp, x: number, y: number): [number, number] {
  // Initial guess: nearest grid point.
  const stride = w.cols + 1;
  let best = Infinity, bi = 0;
  for (let i = 0; i < w.points.length / 2; i++) {
    const d = (w.points[i * 2]! - x) ** 2 + (w.points[i * 2 + 1]! - y) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  let u = (bi % stride) / w.cols, v = Math.floor(bi / stride) / w.rows;
  const f: [number, number] = [0, 0], fu: [number, number] = [0, 0], fv: [number, number] = [0, 0];
  for (let it = 0; it < 30; it++) {
    warpForward(w, u, v, f);
    const ex = f[0] - x, ey = f[1] - y;
    if (ex * ex + ey * ey < 1e-12) break;
    const h = 1e-6;
    warpForward(w, u + h, v, fu);
    warpForward(w, u, v + h, fv);
    const j00 = (fu[0] - f[0]) / h, j10 = (fu[1] - f[1]) / h, j01 = (fv[0] - f[0]) / h, j11 = (fv[1] - f[1]) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-12) break;
    const du = (j11 * ex - j01 * ey) / det, dv = (-j10 * ex + j00 * ey) / det;
    // Damp large steps across cells for stability on strongly deformed grids.
    const step = Math.max(1, Math.hypot(du * w.cols, dv * w.rows) / 0.5);
    u -= du / step;
    v -= dv / step;
  }
  return [u, v];
}

const RAD = Math.PI / 180;

export function rotationForward(r: ResolvedRotation, px: number, py: number): [number, number] {
  const a = r.angle * RAD, c = Math.cos(a) * r.scale, s = Math.sin(a) * r.scale;
  return [r.x + c * px - s * py, r.y + s * px + c * py];
}

export function rotationInverse(r: ResolvedRotation, x: number, y: number): [number, number] {
  const a = -r.angle * RAD, c = Math.cos(a) / r.scale, s = Math.sin(a) / r.scale;
  const dx = x - r.x, dy = y - r.y;
  return [c * dx - s * dy, s * dx + c * dy];
}

/** Map flat local points through `parent` (null = root/identity) into canvas space. */
export function toCanvas(parent: Resolved | null, local: ArrayLike<number>, out = new Float64Array(local.length)): Float64Array {
  if (!parent) { for (let i = 0; i < local.length; i++) out[i] = local[i]!; return out; }
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < local.length; i += 2) {
    const q = parent.kind === 'warp' ? warpForward(parent, local[i]!, local[i + 1]!, tmp) : rotationForward(parent, local[i]!, local[i + 1]!);
    out[i] = q[0]; out[i + 1] = q[1];
  }
  return out;
}

export function toLocal(parent: Resolved | null, canvas: ArrayLike<number>): number[] {
  const out = new Array<number>(canvas.length);
  for (let i = 0; i < canvas.length; i += 2) {
    const q = !parent ? [canvas[i]!, canvas[i + 1]!] : parent.kind === 'warp' ? warpInverse(parent, canvas[i]!, canvas[i + 1]!) : rotationInverse(parent, canvas[i]!, canvas[i + 1]!);
    out[i] = q[0]!; out[i + 1] = q[1]!;
  }
  return out;
}

/** Canvas-space rotation (deg) and scale of the parent's local frame at a local point. */
export function frameAt(parent: Resolved | null, lx: number, ly: number): { angle: number; scale: number } {
  if (!parent) return { angle: 0, scale: 1 };
  if (parent.kind === 'rotation') return { angle: parent.angle, scale: parent.scale };
  const d = 1e-3;
  const o = warpForward(parent, lx, ly, [0, 0]);
  const e = warpForward(parent, lx + d, ly, [0, 0]);
  return { angle: Math.atan2(e[1] - o[1], e[0] - o[0]) / RAD, scale: Math.hypot(e[0] - o[0], e[1] - o[1]) / d };
}
