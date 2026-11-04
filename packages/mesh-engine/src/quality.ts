import type { ArtMesh, Rect } from '@l2s/editor-core';

export type MeshIssueCode =
  | 'degenerate-triangle'
  | 'duplicate-vertex'
  | 'flipped-triangle'
  | 'non-manifold-edge'
  | 'vertex-outside-image'
  | 'unused-vertex'
  | 'uncovered-pixels'
  | 'high-aspect-ratio'
  | 'excessive-vertices'
  | 'empty-mesh';

export interface MeshIssue {
  code: MeshIssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** Vertex indices involved (for highlighting). */
  vertices?: number[];
  count?: number;
}

export interface QualityOptions {
  /** Layer alpha for coverage analysis (layer-local, bounds-sized). */
  alpha?: Uint8Array;
  alphaThreshold?: number;
  /** Max allowed distance of vertices outside the layer bounds, px. */
  outsideTolerance?: number;
  maxAspectRatio?: number;
}

/** Mesh quality check (spec §5.4). */
export function checkMeshQuality(mesh: ArtMesh, bounds: Rect, opts: QualityOptions = {}): MeshIssue[] {
  const issues: MeshIssue[] = [];
  if (mesh.path) return mesh.vertices.length < 4 ? [{ code: 'empty-mesh', severity: 'error', message: 'ArtPath needs at least two control points.' }] : [];
  const v = mesh.vertices;
  const n = v.length / 2;
  const t = mesh.triangles;
  if (n === 0 || t.length === 0) return [{ code: 'empty-mesh', severity: 'error', message: 'Mesh has no triangles.' }];

  const area2 = (a: number, b: number, c: number) =>
    (v[b * 2]! - v[a * 2]!) * (v[c * 2 + 1]! - v[a * 2 + 1]!) - (v[b * 2 + 1]! - v[a * 2 + 1]!) * (v[c * 2]! - v[a * 2]!);

  // Orientation: the majority winding is "correct"; the rest are flipped (folded mesh).
  let pos = 0, neg = 0;
  const degenerate: number[] = [], aspect: number[] = [];
  const maxAspect = opts.maxAspectRatio ?? 12;
  for (let i = 0; i < t.length; i += 3) {
    const a2 = area2(t[i]!, t[i + 1]!, t[i + 2]!);
    if (Math.abs(a2) < 0.5) { degenerate.push(t[i]!, t[i + 1]!, t[i + 2]!); continue; }
    if (a2 > 0) pos++; else neg++;
    const L = [[t[i]!, t[i + 1]!], [t[i + 1]!, t[i + 2]!], [t[i + 2]!, t[i]!]].map(([p, q]) => Math.hypot(v[p! * 2]! - v[q! * 2]!, v[p! * 2 + 1]! - v[q! * 2 + 1]!));
    const longest = Math.max(...L);
    const altitude = Math.abs(a2) / longest;
    if (longest / altitude > maxAspect) aspect.push(t[i]!, t[i + 1]!, t[i + 2]!);
  }
  if (degenerate.length) issues.push({ code: 'degenerate-triangle', severity: 'error', message: `${degenerate.length / 3} degenerate (zero-area) triangle(s).`, vertices: uniq(degenerate), count: degenerate.length / 3 });
  const minority = pos >= neg ? -1 : 1;
  const flipped: number[] = [];
  if (pos && neg) for (let i = 0; i < t.length; i += 3) {
    const a2 = area2(t[i]!, t[i + 1]!, t[i + 2]!);
    if (Math.abs(a2) >= 0.5 && Math.sign(a2) === minority) flipped.push(t[i]!, t[i + 1]!, t[i + 2]!);
  }
  if (flipped.length) issues.push({ code: 'flipped-triangle', severity: 'error', message: `${flipped.length / 3} folded/flipped triangle(s) — vertices crossed over each other.`, vertices: uniq(flipped), count: flipped.length / 3 });
  if (aspect.length) issues.push({ code: 'high-aspect-ratio', severity: 'warning', message: `${aspect.length / 3} very thin triangle(s) (aspect > ${maxAspect}); they deform poorly.`, vertices: uniq(aspect), count: aspect.length / 3 });

  // Edges used by more than two triangles.
  const edgeUse = new Map<string, number>();
  for (let i = 0; i < t.length; i += 3) for (const [a, b] of [[t[i]!, t[i + 1]!], [t[i + 1]!, t[i + 2]!], [t[i + 2]!, t[i]!]]) {
    const k = a! < b! ? `${a},${b}` : `${b},${a}`;
    edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
  }
  const nm = [...edgeUse].filter(([, c]) => c > 2).map(([k]) => k.split(',').map(Number)).flat();
  if (nm.length) issues.push({ code: 'non-manifold-edge', severity: 'error', message: `${nm.length / 2} edge(s) shared by more than two triangles (overlapping mesh).`, vertices: uniq(nm), count: nm.length / 2 });

  // Duplicate / unused vertices.
  const used = new Uint8Array(n);
  for (const i of t) used[i] = 1;
  const unused = [...used.keys()].filter((i) => !used[i]);
  if (unused.length) issues.push({ code: 'unused-vertex', severity: 'warning', message: `${unused.length} vertex/vertices not part of any triangle.`, vertices: unused, count: unused.length });
  const seen = new Map<string, number>();
  const dups: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(v[i * 2]! * 2)},${Math.round(v[i * 2 + 1]! * 2)}`;
    if (seen.has(k)) dups.push(seen.get(k)!, i); else seen.set(k, i);
  }
  if (dups.length) issues.push({ code: 'duplicate-vertex', severity: 'error', message: `${dups.length / 2} pair(s) of overlapping vertices.`, vertices: uniq(dups), count: dups.length / 2 });

  // Vertices far outside the image.
  const tolOut = opts.outsideTolerance ?? Math.max(24, (mesh.settings?.outerMargin ?? 0) * 2);
  const outside: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = v[i * 2]!, y = v[i * 2 + 1]!;
    if (x < bounds.x - tolOut || y < bounds.y - tolOut || x > bounds.x + bounds.width + tolOut || y > bounds.y + bounds.height + tolOut) outside.push(i);
  }
  if (outside.length) issues.push({ code: 'vertex-outside-image', severity: 'warning', message: `${outside.length} vertex/vertices more than ${tolOut}px outside the image.`, vertices: outside, count: outside.length });

  // Coverage: drawn pixels that no triangle covers ("holes").
  if (opts.alpha) {
    const { uncovered, drawn } = coverage(mesh, bounds, opts.alpha, opts.alphaThreshold ?? 16);
    if (uncovered > 0) {
      const pct = (uncovered / Math.max(1, drawn)) * 100;
      issues.push({ code: 'uncovered-pixels', severity: pct > 0.5 ? 'error' : 'warning', message: `${pct.toFixed(pct < 1 ? 2 : 1)}% of drawn pixels are not covered by the mesh (holes / cut-off art).`, count: uncovered });
    }
    // Vertex density: more than one vertex per ~(8px)² of drawn area is rarely useful.
    const expected = drawn / 64;
    if (n > Math.max(64, expected)) issues.push({ code: 'excessive-vertices', severity: 'warning', message: `${n} vertices for ${drawn} drawn pixels — consider a coarser mesh.`, count: n });
  }
  return issues;
}

function uniq(a: number[]) {
  return [...new Set(a)];
}

/** Rasterize triangles (layer-local, sampled every `step` px) and count drawn pixels left uncovered. */
export function coverage(mesh: ArtMesh, bounds: Rect, alpha: Uint8Array, thr: number) {
  const w = bounds.width, h = bounds.height;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 512));
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step);
  const cov = new Uint8Array(gw * gh);
  const v = mesh.vertices, t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const P = [t[i]!, t[i + 1]!, t[i + 2]!].map((k) => [(v[k * 2]! - bounds.x) / step, (v[k * 2 + 1]! - bounds.y) / step] as const);
    const [a, b, c] = P as [readonly [number, number], readonly [number, number], readonly [number, number]];
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(gw - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(gh - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) continue;
    const eps = 0.5 / Math.max(1, Math.sqrt(Math.abs(d))); // half-cell tolerance on edges
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -eps && l2 >= -eps && l3 >= -eps) cov[y * gw + x] = 1;
    }
  }
  let uncovered = 0, drawn = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx = Math.min(w - 1, x * step + (step >> 1)), sy = Math.min(h - 1, y * step + (step >> 1));
    if (alpha[sy * w + sx]! < thr) continue;
    drawn++;
    if (!cov[y * gw + x]) uncovered++;
  }
  return { uncovered: uncovered * step * step, drawn: drawn * step * step };
}
