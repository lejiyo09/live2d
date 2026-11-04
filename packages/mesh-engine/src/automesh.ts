import type { ArtMesh, AutoMeshSettings, NodeId, Rect } from '@l2s/editor-core';
import { alphaToGrid, distanceTo, threshold } from './raster.ts';
import { resampleClosed, signedArea, simplifyClosed, traceContours, type Pt } from './contour.ts';
import { triangulate } from './triangulate.ts';

/**
 * Presets. Parameter *names* mirror Cubism Editor's auto-mesh dialog
 * (boundary opacity, outer/inner margin, outer/inner point spacing); the
 * numbers are this project's own defaults, tuned on test art.
 */
export const AUTO_MESH_PRESETS: Record<'standard' | 'fine' | 'coarse', AutoMeshSettings> = {
  standard: { alphaThreshold: 16, outerMargin: 12, innerMargin: 6, outerSpacing: 28, innerSpacing: 48, detailFactor: 0.6 },
  fine: { alphaThreshold: 16, outerMargin: 8, innerMargin: 4, outerSpacing: 16, innerSpacing: 28, detailFactor: 0.6 },
  coarse: { alphaThreshold: 16, outerMargin: 16, innerMargin: 0, outerSpacing: 48, innerSpacing: 96, detailFactor: 0.75 },
};

/** Part categories that deform strongly and get denser meshes (spec §5.3). */
export function isDetailPart(category: string | undefined): boolean {
  return !!category && /^(Eye|Eyebrow|Mouth)/.test(category);
}

export interface AutoMeshInput {
  layerId: NodeId;
  /** One byte per pixel, layer-local, `bounds.width × bounds.height`. */
  alpha: Uint8Array;
  bounds: Rect;
  settings: AutoMeshSettings;
  partCategory?: string;
  /** Max grid dimension used for contour analysis (performance / memory). */
  maxGridSize?: number;
}

export interface AutoMeshResult {
  mesh: ArtMesh | null;
  stats: { vertices: number; triangles: number; loops: number; constrained: boolean; gridScale: number };
}

export function generateAutoMesh(input: AutoMeshInput): AutoMeshResult {
  const { alpha, bounds, layerId } = input;
  const s0 = input.settings;
  const w = bounds.width, h = bounds.height;
  const detail = isDetailPart(input.partCategory) ? s0.detailFactor : 1;
  const outerSpacing = Math.max(4, s0.outerSpacing * detail);
  const innerSpacing = Math.max(outerSpacing, s0.innerSpacing * detail);

  const pad = s0.outerMargin + 2;
  const maxGrid = input.maxGridSize ?? 512;
  const scale = Math.min(1, maxGrid / Math.max(w + pad * 2, h + pad * 2));
  const cell = 1 / scale; // px per cell
  const grid = alphaToGrid(alpha, w, h, s0.alphaThreshold, pad, scale);
  const gw = grid.width, gh = grid.height;
  const empty = { mesh: null, stats: { vertices: 0, triangles: 0, loops: 0, constrained: true, gridScale: scale } };
  if (!grid.data.some((v) => v)) return empty;

  const outDist = distanceTo(grid, 1); // cells to nearest drawn cell
  const inDist = distanceTo(grid, 0); // cells to nearest empty cell
  const outerRegion = threshold(outDist, gw, gh, (d) => d * cell <= s0.outerMargin);

  // Grid corner (cx, cy) → layer px.
  const toLayer = (p: Pt): Pt => [p[0] * cell - pad, p[1] * cell - pad];
  const minArea = (outerSpacing * 0.5) ** 2;
  const tol = Math.max(cell * 0.75, outerSpacing * 0.12);

  const prepLoops = (region: typeof outerRegion, spacing: number) =>
    traceContours(region)
      .map((l) => l.map(toLayer))
      .filter((l) => Math.abs(signedArea(l)) >= minArea)
      .map((l) => resampleClosed(simplifyClosed(l, tol), spacing))
      .filter((l) => l.length >= 3);

  const outerLoops = prepLoops(outerRegion, outerSpacing);
  if (outerLoops.length === 0) return empty;

  const pts: Pt[] = [];
  const hash = new SpatialHash(Math.max(2, outerSpacing * 0.25));
  const boundary: number[][] = [];
  for (const loop of outerLoops) {
    const idx: number[] = [];
    for (const p of loop) {
      if (hash.near(p, 0.5)) continue;
      idx.push(pts.length);
      hash.add(p, pts.length);
      pts.push(p);
    }
    if (idx.length >= 3) boundary.push(idx);
  }

  // Inner ring keeps the silhouette stable when the mesh is deformed.
  if (s0.innerMargin > 0) {
    const innerRegion = threshold(inDist, gw, gh, (d) => d * cell > s0.innerMargin);
    for (const loop of prepLoops(innerRegion, outerSpacing)) {
      for (const p of loop) {
        if (hash.near(p, outerSpacing * 0.45)) continue;
        hash.add(p, pts.length);
        pts.push(p);
      }
    }
  }

  // Interior points: spacing shrinks in thin regions (hair tips, strands) so they keep enough resolution.
  const minSp = outerSpacing * 0.6;
  const sampleIn = (x: number, y: number) => {
    const gx = Math.floor((x + pad) * scale), gy = Math.floor((y + pad) * scale);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return -1;
    return inDist[gy * gw + gx]! * cell;
  };
  const step = minSp * 0.5;
  const innerLimit = Math.max(s0.innerMargin, 0) + outerSpacing * 0.5;
  for (let row = 0, y = step / 2; y < h; y += step * 0.866, row++) {
    for (let x = (row % 2 ? step / 2 : 0) + step / 2; x < w; x += step) {
      const thick = sampleIn(x, y);
      if (thick < innerLimit) continue;
      const local = Math.max(minSp, Math.min(innerSpacing, thick * 1.1));
      const p: Pt = [x, y];
      if (hash.near(p, local * 0.85)) continue;
      hash.add(p, pts.length);
      pts.push(p);
    }
  }

  const flat = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
  const { triangles, constrained } = triangulate(flat, boundary);
  const mesh = compact(layerId, flat, triangles, boundary, bounds, s0);
  return { mesh, stats: { vertices: mesh.vertices.length / 2, triangles: mesh.triangles.length / 3, loops: boundary.length, constrained, gridScale: scale } };
}

/** Drop unreferenced points and convert layer-local px to canvas space + UVs. */
export function compact(layerId: NodeId, local: Float64Array, triangles: number[], boundary: number[][], bounds: Rect, settings?: AutoMeshSettings, generatedBy: ArtMesh['generatedBy'] = 'auto'): ArtMesh {
  const used = new Int32Array(local.length / 2).fill(-1);
  const vertices: number[] = [];
  const uvs: number[] = [];
  const use = (i: number) => {
    if (used[i]! >= 0) return used[i]!;
    used[i] = vertices.length / 2;
    const x = local[i * 2]!, y = local[i * 2 + 1]!;
    vertices.push(bounds.x + x, bounds.y + y);
    uvs.push(bounds.width ? x / bounds.width : 0, bounds.height ? y / bounds.height : 0);
    return used[i]!;
  };
  const tris = triangles.map(use);
  const loops = boundary.map((l) => l.filter((i) => used[i]! >= 0).map((i) => used[i]!)).filter((l) => l.length >= 3);
  return { layerId, vertices, uvs, triangles: tris, boundary: loops, generatedBy, ...(settings ? { settings } : {}) };
}

class SpatialHash {
  private cells = new Map<string, Array<[number, number]>>();
  constructor(private size: number) {}
  private k(x: number, y: number) { return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`; }
  add(p: Pt, _i: number) {
    const k = this.k(p[0], p[1]);
    const c = this.cells.get(k);
    if (c) c.push(p); else this.cells.set(k, [p]);
  }
  near(p: Pt, r: number): boolean {
    const r2 = r * r;
    const n = Math.ceil(r / this.size);
    const cx = Math.floor(p[0] / this.size), cy = Math.floor(p[1] / this.size);
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const c = this.cells.get(`${cx + dx},${cy + dy}`);
      if (!c) continue;
      for (const q of c) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < r2) return true;
    }
    return false;
  }
}
