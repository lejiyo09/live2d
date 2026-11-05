import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { insideLoops, type Pt } from './contour.ts';

export interface TriangulateResult {
  triangles: number[];
  /** False when constraint insertion failed and the outline is only approximated. */
  constrained: boolean;
}

/**
 * Constrained Delaunay triangulation of `points` with `loops` (vertex-index
 * rings) as constrained edges. Triangles outside the loops (even–odd) are
 * dropped. Without loops, the full convex-hull triangulation is returned.
 */
export function triangulate(points: Float64Array | number[], loops: number[][], extraEdges: ReadonlyArray<readonly [number, number]> = []): TriangulateResult {
  const n = points.length / 2;
  if (n < 3) return { triangles: [], constrained: true };
  const coords = points instanceof Float64Array ? points : Float64Array.from(points);
  let del: Delaunator<Float64Array>;
  try {
    del = new Delaunator(coords);
  } catch {
    return { triangles: [], constrained: false };
  }
  let constrained = true;
  const edges: [number, number][] = [];
  for (const loop of loops) for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    if (a !== b) edges.push([a, b]);
  }
  for (const [a, b] of extraEdges) if (a !== b && a < n && b < n) edges.push([a, b]);
  if (edges.length) {
    const con = new Constrainautor(del);
    for (const [a, b] of edges) {
      try {
        con.constrainOne(a, b);
      } catch {
        constrained = false; // intersecting or degenerate constraint; skip it
      }
    }
    try { con.delaunify(true); } catch { /* keep current triangulation */ }
  }
  const tris = del.triangles;
  if (!loops.length) return { triangles: repairDegenerates(coords, Array.from(tris)), constrained };
  const polys: Pt[][] = loops.map((l) => l.map((i) => [coords[i * 2]!, coords[i * 2 + 1]!] as Pt));
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
    const cx = (coords[a * 2]! + coords[b * 2]! + coords[c * 2]!) / 3;
    const cy = (coords[a * 2 + 1]! + coords[b * 2 + 1]! + coords[c * 2 + 1]!) / 3;
    if (insideLoops(cx, cy, polys)) out.push(a, b, c);
  }
  return { triangles: repairDegenerates(coords, out), constrained };
}

/**
 * Remove zero-area triangles produced around collinear points (straight
 * outlines, e.g. art cut off at the canvas edge). A degenerate triangle
 * (a, b, c) with b lying on edge a–c would leave a T-junction at b, so the
 * neighbouring triangle on a–c is split at b instead of just dropping it.
 */
export function repairDegenerates(coords: ArrayLike<number>, triangles: number[], minArea2 = 0.5): number[] {
  const t = [...triangles];
  const area2 = (a: number, b: number, c: number) =>
    (coords[b * 2]! - coords[a * 2]!) * (coords[c * 2 + 1]! - coords[a * 2 + 1]!) - (coords[b * 2 + 1]! - coords[a * 2 + 1]!) * (coords[c * 2]! - coords[a * 2]!);
  const d2 = (a: number, b: number) => (coords[a * 2]! - coords[b * 2]!) ** 2 + (coords[a * 2 + 1]! - coords[b * 2 + 1]!) ** 2;
  for (let guard = 0; guard < 64; guard++) {
    let fixed = false;
    for (let i = 0; i < t.length; i += 3) {
      const tri = [t[i]!, t[i + 1]!, t[i + 2]!] as const;
      if (Math.abs(area2(...tri)) >= minArea2) continue;
      // Longest edge (a, c) and the vertex b lying on it.
      let k = 0, best = -1;
      for (let e = 0; e < 3; e++) {
        const l = d2(tri[e]!, tri[(e + 1) % 3]!);
        if (l > best) { best = l; k = e; }
      }
      const a = tri[k]!, c = tri[(k + 1) % 3]!, b = tri[(k + 2) % 3]!;
      t.splice(i, 3);
      for (let j = 0; j < t.length; j += 3) {
        const o = [t[j]!, t[j + 1]!, t[j + 2]!];
        if (!(o.includes(a) && o.includes(c))) continue;
        const withB = (from: number) => o.map((v) => (v === from ? b : v));
        t.splice(j, 3, ...withB(c), ...withB(a));
        break;
      }
      fixed = true;
      break;
    }
    if (!fixed) break;
  }
  return t;
}
