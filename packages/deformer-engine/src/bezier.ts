/**
 * Bézier editing for warp deformers: a control net of (3d+1)×(3d+1) points
 * (d×d bicubic patches) over a warp grid. Dragging net points displaces the
 * grid by the change of the patch surface, so untouched areas stay put.
 */
export interface BezierNet {
  div: number;
  /** Flat [x0, y0, …], row-major, (3·div+1)² points. */
  points: Float64Array;
}

const B = (t: number) => { const u = 1 - t; return [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const; };

/** Sample a bilinear grid (cols×rows cells, flat points) at (u, v) ∈ [0,1]². */
function sampleGrid(points: ArrayLike<number>, cols: number, rows: number, u: number, v: number): [number, number] {
  const fx = u * cols, fy = v * rows;
  const cx = Math.min(cols - 1, Math.floor(fx)), cy = Math.min(rows - 1, Math.floor(fy));
  const s = fx - cx, t = fy - cy, st = cols + 1;
  const i00 = (cy * st + cx) * 2, i10 = i00 + 2, i01 = i00 + st * 2, i11 = i01 + 2;
  const a = (1 - s) * (1 - t), b = s * (1 - t), c = (1 - s) * t, d = s * t;
  return [a * points[i00]! + b * points[i10]! + c * points[i01]! + d * points[i11]!, a * points[i00 + 1]! + b * points[i10 + 1]! + c * points[i01 + 1]! + d * points[i11 + 1]!];
}

/** Initial net sampled from the current grid (exact for bilinear regions). */
export function netFromGrid(points: ArrayLike<number>, cols: number, rows: number, div = 1): BezierNet {
  const n = 3 * div + 1;
  const out = new Float64Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [x, y] = sampleGrid(points, cols, rows, i / (n - 1), j / (n - 1));
    out[(j * n + i) * 2] = x; out[(j * n + i) * 2 + 1] = y;
  }
  return { div, points: out };
}

/** Evaluate the piecewise bicubic surface at (u, v) ∈ [0,1]². */
export function evalNet(net: BezierNet, u: number, v: number): [number, number] {
  const d = net.div, n = 3 * d + 1;
  const pu = Math.min(d - 1, Math.floor(u * d)), pv = Math.min(d - 1, Math.floor(v * d));
  const bu = B(u * d - pu), bv = B(v * d - pv);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const k = ((pv * 3 + j) * n + (pu * 3 + i)) * 2;
    const w = bu[i]! * bv[j]!;
    x += w * net.points[k]!; y += w * net.points[k + 1]!;
  }
  return [x, y];
}

/** Grid points after moving the net from `from` to `to`: grid + P(to) − P(from). */
export function displaceGrid(grid: ArrayLike<number>, cols: number, rows: number, from: BezierNet, to: BezierNet): Float64Array {
  const out = Float64Array.from(grid);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const u = c / cols, v = r / rows;
    const [ax, ay] = evalNet(from, u, v), [bx, by] = evalNet(to, u, v);
    const k = (r * (cols + 1) + c) * 2;
    out[k] = out[k]! + bx - ax; out[k + 1] = out[k + 1]! + by - ay;
  }
  return out;
}
