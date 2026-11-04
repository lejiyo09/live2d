import { resolveDrawOrder, type NodeId, type Project } from '@l2s/editor-core';

/** Alpha lookup for a display asset: returns 0..255 at pixel (x, y) in asset space. */
export type AlphaSampler = (assetId: string, x: number, y: number) => number | undefined;

/**
 * Alpha at a canvas point through a (possibly deformed) ArtMesh: `null` if the
 * layer has no mesh (bounds-based test is used), 0 outside the mesh.
 */
export type MeshSampler = (layerId: NodeId, x: number, y: number) => number | undefined | null;

export interface HitTestOptions {
  meshSampler?: MeshSampler;
  drawOrderOf?: (id: NodeId) => number | undefined;
  /** Minimum alpha (0..255) counted as a hit. Default 16. */
  alphaThreshold?: number;
  includeLocked?: boolean;
  includeHidden?: boolean;
}

/** All layers under the canvas-space point, top-most first. */
export function hitTestAll(project: Project, sample: AlphaSampler, x: number, y: number, opts: HitTestOptions = {}): NodeId[] {
  const threshold = opts.alphaThreshold ?? 16;
  const layers = resolveDrawOrder(project, opts.drawOrderOf);
  const hits: NodeId[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const r = layers[i]!;
    if (!opts.includeHidden && (!r.effectiveVisible || r.effectiveOpacity <= 0)) continue;
    if (!opts.includeLocked && r.effectiveLocked) continue;
    if (!(alphaAt(project, r.node.id, x, y, sample, opts.meshSampler) >= threshold)) continue;
    const cm = r.node.clipMask;
    if (cm?.ids.length) {
      const inside = cm.ids.some((m) => alphaAt(project, m, x, y, sample, opts.meshSampler) >= threshold);
      if (inside === cm.inverted) continue;
    }
    hits.push(r.node.id);
  }
  return hits;
}

/**
 * Pick for a click. With `cycleFrom` (alt-click), returns the hit just below
 * the currently selected one so repeated clicks walk down the stack.
 */
export function pick(project: Project, sample: AlphaSampler, x: number, y: number, opts: HitTestOptions & { cycleFrom?: NodeId } = {}): NodeId | null {
  const hits = hitTestAll(project, sample, x, y, opts);
  if (hits.length === 0) return null;
  if (opts.cycleFrom) {
    const i = hits.indexOf(opts.cycleFrom);
    if (i >= 0) return hits[(i + 1) % hits.length]!;
  }
  return hits[0]!;
}

/** Alpha of a layer at a canvas point (mesh-aware); unknown alpha counts as opaque inside the bounds. */
function alphaAt(project: Project, id: NodeId, x: number, y: number, sample: AlphaSampler, meshSampler?: MeshSampler): number {
  const n = project.nodes[id];
  if (n?.kind !== 'layer') return 0;
  const viaMesh = meshSampler?.(id, x, y);
  if (viaMesh !== null && viaMesh !== undefined) return viaMesh;
  const b = n.bounds;
  const lx = Math.floor(x - b.x), ly = Math.floor(y - b.y);
  if (lx < 0 || ly < 0 || lx >= b.width || ly >= b.height) return 0;
  return sample(n.assets.display, lx, ly) ?? 255;
}
