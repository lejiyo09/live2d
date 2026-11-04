import type { Grid } from './raster.ts';

export type Pt = [number, number];

/**
 * Trace region boundaries as closed loops along cell edges ("crack following").
 * Coordinates are cell corners. Outer boundaries are clockwise on screen
 * (y down), holes counter-clockwise. Diagonal-only contacts are split.
 */
export function traceContours(g: Grid): Pt[][] {
  const { width: w, height: h, data } = g;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
  const W = w + 1;
  const key = (x: number, y: number) => y * W + x;
  // Directed edges, inside on the right (screen space).
  const out = new Map<number, number[]>(); // start → list of end keys
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const l = out.get(k);
    if (l) l.push(key(x1, y1));
    else out.set(k, [key(x1, y1)]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: Pt[][] = [];
  const pos = (k: number): Pt => [k % W, Math.floor(k / W)];
  for (const [start] of out) {
    while ((out.get(start)?.length ?? 0) > 0) {
      const loop: Pt[] = [];
      let prev = start;
      let cur = takeEdge(out, start, null, pos);
      loop.push(pos(start));
      let guard = 0;
      while (cur !== start && guard++ < 4 * W * (h + 1)) {
        loop.push(pos(cur));
        const next = takeEdge(out, cur, [pos(cur)[0] - pos(prev)[0], pos(cur)[1] - pos(prev)[1]], pos);
        prev = cur;
        cur = next;
      }
      loops.push(removeCollinear(loop));
    }
  }
  return loops;
}

function takeEdge(out: Map<number, number[]>, from: number, dir: Pt | null, pos: (k: number) => Pt): number {
  const l = out.get(from)!;
  let pickIdx = 0;
  if (l.length > 1 && dir) {
    // Saddle: turn right (keeps diagonal-touching cells as separate loops).
    const p = pos(from);
    for (let i = 0; i < l.length; i++) {
      const q = pos(l[i]!);
      const cross = dir[0] * (q[1] - p[1]) - dir[1] * (q[0] - p[0]);
      if (cross > 0) { pickIdx = i; break; }
    }
  }
  const [k] = l.splice(pickIdx, 1);
  if (l.length === 0) out.delete(from);
  return k!;
}

function removeCollinear(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n]!, b = loop[i]!, c = loop[(i + 1) % n]!;
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

/** Signed area (positive = clockwise on screen with y down). */
export function signedArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) s += (loop[j]![0] * loop[i]![1] - loop[i]![0] * loop[j]![1]);
  return s / 2;
}

/** Closed-polygon Douglas–Peucker. */
export function simplifyClosed(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 4) return loop;
  // Split at the two most distant points to get two open chains.
  let a = 0, b = 0, best = -1;
  const p0 = loop[0]!;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i]![0] - p0[0]) ** 2 + (loop[i]![1] - p0[1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  const chain1 = loop.slice(a, b + 1);
  const chain2 = [...loop.slice(b), loop[0]!];
  const s1 = dp(chain1, tol);
  const s2 = dp(chain2, tol);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let idx = -1, maxD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i]!, pts[s]!, pts[e]!);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Subdivide edges longer than `spacing` into equal parts. */
export function resampleClosed(loop: Pt[], spacing: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / spacing + 0.35);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Even–odd point-in-polygon over a set of loops (outer + holes). */
export function insideLoops(x: number, y: number, loops: ReadonlyArray<ReadonlyArray<Pt>>): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i]!, [xj, yj] = loop[j]!;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
