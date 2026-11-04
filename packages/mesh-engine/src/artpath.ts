import { BUILTIN_BRUSH_ASSET, newId, type ArtMesh, type ArtPathStyle, type Command, type LayerNode, type NodeId, type Rect } from '@l2s/editor-core';

/**
 * ArtPath ribbon (Phase 7): Catmull-Rom curve through the control points,
 * expanded to a triangle strip. u runs along the stroke, v across it.
 */
export interface Ribbon { positions: Float32Array; uvs: Float32Array; indices: Uint32Array }

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Sample the centre line (flat x,y). */
export function samplePath(ctrl: ArrayLike<number>, closed: boolean, perSegment = 8): number[] {
  const n = ctrl.length / 2;
  if (n < 2) return Array.from(ctrl);
  const P = (i: number) => {
    const k = closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i));
    return [ctrl[k * 2]!, ctrl[k * 2 + 1]!] as const;
  };
  const out: number[] = [];
  const segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = P(s - 1), b = P(s), c = P(s + 1), d = P(s + 2);
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      out.push(catmull(a[0], b[0], c[0], d[0], t), catmull(a[1], b[1], c[1], d[1], t));
    }
  }
  const end = P(closed ? 0 : n - 1);
  out.push(end[0], end[1]);
  return out;
}

export function buildRibbon(ctrl: ArrayLike<number>, style: ArtPathStyle, perSegment = 8): Ribbon {
  const c = samplePath(ctrl, style.closed, perSegment);
  const m = c.length / 2;
  const positions = new Float32Array(m * 4), uvs = new Float32Array(m * 4);
  const len: number[] = [0];
  for (let i = 1; i < m; i++) len.push(len[i - 1]! + Math.hypot(c[i * 2]! - c[i * 2 - 2]!, c[i * 2 + 1]! - c[i * 2 - 1]!));
  const total = len[m - 1]! || 1;
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
    let tx = c[b * 2]! - c[a * 2]!, ty = c[b * 2 + 1]! - c[a * 2 + 1]!;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const u = len[i]! / total;
    const taper = style.taper && !style.closed ? Math.min(1, Math.sin(Math.PI * u) * 1.6 + 0.08) : 1;
    const hw = (style.width / 2) * taper;
    const x = c[i * 2]!, y = c[i * 2 + 1]!;
    positions.set([x - ty * hw, y + tx * hw, x + ty * hw, y - tx * hw], i * 4);
    uvs.set([u, 0, u, 1], i * 4);
  }
  const indices = new Uint32Array(Math.max(0, m - 1) * 6);
  for (let i = 0; i < m - 1; i++) indices.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
  return { positions, uvs, indices };
}

/** Bounds of the stroke for selection boxes. */
export function pathBounds(ctrl: ArrayLike<number>, style: ArtPathStyle): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const c = samplePath(ctrl, style.closed, 4);
  for (let i = 0; i < c.length; i += 2) { x0 = Math.min(x0, c[i]!); x1 = Math.max(x1, c[i]!); y0 = Math.min(y0, c[i + 1]!); y1 = Math.max(y1, c[i + 1]!); }
  const h = style.width / 2;
  return { x: Math.floor(x0 - h), y: Math.floor(y0 - h), width: Math.ceil(x1 - x0 + 2 * h) || 1, height: Math.ceil(y1 - y0 + 2 * h) || 1 };
}

export const DEFAULT_PATH_STYLE: ArtPathStyle = { width: 6, color: 0x2b2024, closed: false, taper: true };

/** Create an ArtPath layer from control points (canvas space) on top of `parentId` (or the root). */
export function createArtPath(points: number[], opts: { name?: string; parentId?: NodeId | null; style?: Partial<ArtPathStyle> } = {}): { command: Command; id: NodeId } {
  const id = newId('lyr');
  return {
    id,
    command: {
      label: 'New ArtPath',
      apply(d) {
        if (points.length < 4) throw new Error('An ArtPath needs at least two points');
        const style = { ...DEFAULT_PATH_STYLE, ...opts.style };
        const parentId = opts.parentId && d.nodes[opts.parentId]?.kind === 'group' ? opts.parentId : null;
        const layer: LayerNode = {
          id, kind: 'layer', name: opts.name ?? 'ArtPath', parentId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
          bounds: pathBounds(points, style), assets: { original: BUILTIN_BRUSH_ASSET, display: BUILTIN_BRUSH_ASSET }, clipping: false, sourcePath: [],
        };
        d.nodes[id] = layer;
        const list = parentId ? (d.nodes[parentId] as { childIds: string[] }).childIds : d.rootIds;
        list.push(id);
        const mesh: ArtMesh = { layerId: id, vertices: [...points], uvs: points.map(() => 0), triangles: [], boundary: [], generatedBy: 'manual', path: style };
        d.meshes[id] = mesh;
        d.updatedAt = new Date().toISOString();
      },
    },
  };
}

export function setPathStyle(layerId: NodeId, patch: Partial<ArtPathStyle>, mergeKey?: string): Command {
  return {
    label: 'Edit ArtPath',
    mergeKey,
    apply(d) {
      const m = d.meshes[layerId];
      if (!m?.path) return;
      Object.assign(m.path, patch);
      const n = d.nodes[layerId];
      if (n?.kind === 'layer') n.bounds = pathBounds(m.vertices, m.path);
    },
  };
}

export const isArtPath = (m: ArtMesh | undefined): m is ArtMesh & { path: ArtPathStyle } => !!m?.path;
