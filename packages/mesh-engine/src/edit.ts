import { defaultValues } from '@l2s/parameter-engine';
import { evaluateModel, parentResolved, toLocal } from '@l2s/deformer-engine';
import { getNode, snapshot, type ArtMesh, type Command, type LayerNode, type NodeId, type Project, type Rect } from '@l2s/editor-core';
import { insideLoops, segDist, type Pt } from './contour.ts';
import { triangulate } from './triangulate.ts';

// ------------------------------------------------------------------ queries

/** Nearest vertex within `radius` (canvas units) or -1. */
export function hitVertex(mesh: ArtMesh, x: number, y: number, radius: number): number {
  let best = -1, bestD = radius * radius;
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 2) {
    const d = (v[i]! - x) ** 2 + (v[i + 1]! - y) ** 2;
    if (d <= bestD) { bestD = d; best = i / 2; }
  }
  return best;
}

export function verticesInRect(mesh: ArtMesh, r: Rect): number[] {
  const out: number[] = [];
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 2) {
    const x = v[i]!, y = v[i + 1]!;
    if (x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height) out.push(i / 2);
  }
  return out;
}

export function boundaryPolygons(mesh: ArtMesh): Pt[][] {
  return mesh.boundary.map((l) => l.map((i) => [mesh.vertices[i * 2]!, mesh.vertices[i * 2 + 1]!] as Pt));
}

/** Unique undirected edges as flat index pairs (for wireframe rendering). */
export function meshEdges(mesh: ArtMesh): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const n = mesh.vertices.length / 2;
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (const [a, b] of [[t[i]!, t[i + 1]!], [t[i + 1]!, t[i + 2]!], [t[i + 2]!, t[i]!]] as const) {
      const k = a < b ? a * n + b : b * n + a;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a, b);
    }
  }
  return out;
}

// ------------------------------------------------------------------ builders

/** Simple rectangular mesh covering the layer bounds plus `margin` (manual starting point). */
export function rectMesh(layer: LayerNode, margin = 8, cols = 2, rows = 2): ArtMesh {
  const b = layer.bounds;
  const x0 = b.x - margin, y0 = b.y - margin, w = b.width + margin * 2, h = b.height + margin * 2;
  const vertices: number[] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) vertices.push(x0 + (w * c) / cols, y0 + (h * r) / rows);
  const idx = (c: number, r: number) => r * (cols + 1) + c;
  const ring: number[] = [];
  for (let c = 0; c <= cols; c++) ring.push(idx(c, 0));
  for (let r = 1; r <= rows; r++) ring.push(idx(cols, r));
  for (let c = cols - 1; c >= 0; c--) ring.push(idx(c, rows));
  for (let r = rows - 1; r >= 1; r--) ring.push(idx(0, r));
  const mesh: ArtMesh = { layerId: layer.id, vertices, uvs: [], triangles: [], boundary: [ring], generatedBy: 'manual' };
  mesh.uvs = uvsFor(vertices, b);
  mesh.triangles = triangulate(vertices, mesh.boundary).triangles;
  return mesh;
}

export function uvsFor(vertices: number[], b: Rect): number[] {
  const uvs: number[] = [];
  for (let i = 0; i < vertices.length; i += 2) uvs.push((vertices[i]! - b.x) / (b.width || 1), (vertices[i + 1]! - b.y) / (b.height || 1));
  return uvs;
}

const triKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');

/** Rebuild triangles from vertices + outline + user edges (constrained Delaunay), minus deleted triangles. */
export function retriangulated(mesh: ArtMesh): ArtMesh {
  const tris = triangulate(mesh.vertices, mesh.boundary, mesh.edges ?? []).triangles;
  if (!mesh.excluded?.length) return { ...mesh, triangles: tris };
  const ex = new Set(mesh.excluded.map(([a, b, c]) => triKey(a, b, c)));
  const out: number[] = [];
  for (let i = 0; i < tris.length; i += 3) if (!ex.has(triKey(tris[i]!, tris[i + 1]!, tris[i + 2]!))) out.push(tris[i]!, tris[i + 1]!, tris[i + 2]!);
  return { ...mesh, triangles: out };
}

/** Connect two vertices with a user edge (kept through re-triangulation). */
export function withEdge(mesh: ArtMesh, a: number, b: number): ArtMesh {
  if (a === b) return mesh;
  const edges = (mesh.edges ?? []).filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
  return retriangulated({ ...mesh, edges: [...edges, [a, b]] });
}

/**
 * Remove the edge a–b: a user edge is simply dropped; any other interior edge
 * is flipped (the opposite diagonal of its two triangles becomes a user edge).
 */
export function withoutEdge(mesh: ArtMesh, a: number, b: number): { mesh: ArtMesh; flipped: boolean } {
  const user = (mesh.edges ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (user) return { mesh: retriangulated({ ...mesh, edges: mesh.edges!.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a))) }), flipped: false };
  const t = mesh.triangles;
  const opposite: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const tri = [t[i]!, t[i + 1]!, t[i + 2]!];
    if (tri.includes(a) && tri.includes(b)) opposite.push(tri.find((v) => v !== a && v !== b)!);
  }
  if (opposite.length !== 2) return { mesh, flipped: false }; // outline edge or not an edge
  const [c, d] = opposite as [number, number];
  // Only flip when the quad a-c-b-d is convex (otherwise the new diagonal would leave it).
  const v = mesh.vertices;
  const cross = (o: number, p: number, q: number) => (v[p * 2]! - v[o * 2]!) * (v[q * 2 + 1]! - v[o * 2 + 1]!) - (v[p * 2 + 1]! - v[o * 2 + 1]!) * (v[q * 2]! - v[o * 2]!);
  if (Math.sign(cross(c, d, a)) === Math.sign(cross(c, d, b))) return { mesh, flipped: false };
  return { mesh: withEdge(mesh, c, d), flipped: true };
}

/** Make sure triangle a-b-c exists (its edges become user edges; un-deletes it). */
export function withTriangle(mesh: ArtMesh, a: number, b: number, c: number): ArtMesh {
  const k = triKey(a, b, c);
  const excluded = (mesh.excluded ?? []).filter(([x, y, z]) => triKey(x, y, z) !== k);
  const pairs: Array<[number, number]> = [[a, b], [b, c], [c, a]];
  const edges = [...(mesh.edges ?? []).filter(([x, y]) => !pairs.some(([p, q]) => (x === p && y === q) || (x === q && y === p))), ...pairs];
  return retriangulated({ ...mesh, edges, excluded });
}

/** Delete every triangle whose three vertices are all in `selected`. */
export function withTrianglesDeleted(mesh: ArtMesh, selected: number[]): { mesh: ArtMesh; count: number } {
  const sel = new Set(selected);
  const t = mesh.triangles;
  const add: Array<[number, number, number]> = [];
  for (let i = 0; i < t.length; i += 3) {
    if (sel.has(t[i]!) && sel.has(t[i + 1]!) && sel.has(t[i + 2]!)) add.push([t[i]!, t[i + 1]!, t[i + 2]!].sort((x, y) => x - y) as [number, number, number]);
  }
  if (!add.length) return { mesh, count: 0 };
  return { mesh: retriangulated({ ...mesh, excluded: [...(mesh.excluded ?? []), ...add] }), count: add.length };
}

/**
 * Add a vertex. Inside the outline it becomes an interior point; outside, it
 * is inserted into the nearest outline edge so the outline grows to include it.
 */
export function withVertexAdded(mesh: ArtMesh, bounds: Rect, x: number, y: number): { mesh: ArtMesh; index: number } {
  const index = mesh.vertices.length / 2;
  const vertices = [...mesh.vertices, x, y];
  const uvs = [...mesh.uvs, (x - bounds.x) / (bounds.width || 1), (y - bounds.y) / (bounds.height || 1)];
  let boundary = mesh.boundary.map((l) => [...l]);
  const polys = boundaryPolygons(mesh);
  if (polys.length && !insideLoops(x, y, polys)) {
    let best = Infinity, bl = -1, bi = -1;
    polys.forEach((poly, li) => poly.forEach((a, i) => {
      const d = segDist([x, y], a, poly[(i + 1) % poly.length]!);
      if (d < best) { best = d; bl = li; bi = i; }
    }));
    if (bl >= 0) boundary[bl]!.splice(bi + 1, 0, index);
  } else if (!polys.length) {
    boundary = [];
  }
  return { mesh: retriangulated({ ...mesh, vertices, uvs, boundary }), index };
}

export function withVerticesDeleted(mesh: ArtMesh, indices: number[]): ArtMesh {
  const del = new Set(indices);
  const n = mesh.vertices.length / 2;
  const map = new Int32Array(n).fill(-1);
  const vertices: number[] = [], uvs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (del.has(i)) continue;
    map[i] = vertices.length / 2;
    vertices.push(mesh.vertices[i * 2]!, mesh.vertices[i * 2 + 1]!);
    uvs.push(mesh.uvs[i * 2]!, mesh.uvs[i * 2 + 1]!);
  }
  const boundary = mesh.boundary.map((l) => l.filter((i) => map[i]! >= 0).map((i) => map[i]!)).filter((l) => l.length >= 3);
  const edges = (mesh.edges ?? []).filter(([a, b]) => map[a]! >= 0 && map[b]! >= 0).map(([a, b]) => [map[a]!, map[b]!] as [number, number]);
  const excluded = (mesh.excluded ?? []).filter((tr) => tr.every((i) => map[i]! >= 0)).map((tr) => tr.map((i) => map[i]!).sort((x, y) => x - y) as [number, number, number]);
  return retriangulated({ ...mesh, vertices, uvs, boundary, edges, excluded, generatedBy: mesh.generatedBy === 'auto' ? 'manual' : mesh.generatedBy });
}

/**
 * Copy a mesh onto another layer (spec §5.2 메시 복제 / 대칭 복사). The shape is
 * moved so the source bounds centre lands on the target bounds centre; with
 * `mirror` it is flipped horizontally around that centre.
 */
export function copiedMesh(src: ArtMesh, from: Rect, to: LayerNode, mirror: boolean): ArtMesh {
  const cxS = from.x + from.width / 2, cyS = from.y + from.height / 2;
  const cxT = to.bounds.x + to.bounds.width / 2, cyT = to.bounds.y + to.bounds.height / 2;
  const vertices: number[] = [];
  for (let i = 0; i < src.vertices.length; i += 2) {
    const dx = src.vertices[i]! - cxS;
    vertices.push(cxT + (mirror ? -dx : dx), cyT + (src.vertices[i + 1]! - cyS));
  }
  const triangles = [...src.triangles];
  if (mirror) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2]!, triangles[i + 1]!];
  return {
    layerId: to.id, vertices, uvs: uvsFor(vertices, to.bounds), triangles,
    boundary: src.boundary.map((l) => (mirror ? [...l].reverse() : [...l])),
    ...(src.edges ? { edges: src.edges.map(([a, b]) => [a, b] as [number, number]) } : {}),
    ...(src.excluded ? { excluded: src.excluded.map((t) => [...t] as [number, number, number]) } : {}),
    generatedBy: 'manual', ...(src.settings ? { settings: src.settings } : {}),
  };
}

/**
 * Keyform position for a vertex added at rest position (x, y): barycentric
 * interpolation inside the rest triangle that contains it, otherwise the
 * displacement of the nearest vertex.
 */
function keyformForNewVertex(p: Project, m: ArtMesh, kfPositions: number[], x: number, y: number): [number, number] {
  const v = m.vertices, t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
    const ax = v[a * 2]!, ay = v[a * 2 + 1]!, bx = v[b * 2]!, by = v[b * 2 + 1]!, cx = v[c * 2]!, cy = v[c * 2 + 1]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    return [
      l1 * kfPositions[a * 2]! + l2 * kfPositions[b * 2]! + l3 * kfPositions[c * 2]!,
      l1 * kfPositions[a * 2 + 1]! + l2 * kfPositions[b * 2 + 1]! + l3 * kfPositions[c * 2 + 1]!,
    ];
  }
  let best = Infinity, j = 0;
  for (let i = 0; i < v.length; i += 2) {
    const dd = (v[i]! - x) ** 2 + (v[i + 1]! - y) ** 2;
    if (dd < best) { best = dd; j = i; }
  }
  const [lx, ly] = restToLocal(p, m.parentId, [x, y]) as [number, number];
  const [jx, jy] = restToLocal(p, m.parentId, [v[j]!, v[j + 1]!]) as [number, number];
  return [lx + kfPositions[j]! - jx, ly + kfPositions[j + 1]! - jy];
}

/** Delta of a new vertex: barycentric blend of its rest triangle's deltas, else the nearest vertex's delta. */
function deltaForNewVertex(m: ArtMesh, deltas: number[], x: number, y: number): [number, number] {
  const v = m.vertices, t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
    const ax = v[a * 2]!, ay = v[a * 2 + 1]!, bx = v[b * 2]!, by = v[b * 2 + 1]!, cx = v[c * 2]!, cy = v[c * 2 + 1]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    return [l1 * deltas[a * 2]! + l2 * deltas[b * 2]! + l3 * deltas[c * 2]!, l1 * deltas[a * 2 + 1]! + l2 * deltas[b * 2 + 1]! + l3 * deltas[c * 2 + 1]!];
  }
  let best = Infinity, j = 0;
  for (let i = 0; i < v.length; i += 2) { const dd = (v[i]! - x) ** 2 + (v[i + 1]! - y) ** 2; if (dd < best) { best = dd; j = i; } }
  return [deltas[j]!, deltas[j + 1]!];
}

// ------------------------------------------------------------------ commands

function layerOf(d: Project, id: NodeId): LayerNode {
  const n = getNode(d, id);
  if (n.kind !== 'layer') throw new Error('ArtMeshes can only be attached to layers');
  return n;
}

// ------------------------------------------------------------------ keyform sync

/** Rest positions (canvas) → the mesh's parent-local space at default parameter values. */
function restToLocal(p: Project, parentId: string | null | undefined, canvas: number[]): number[] {
  if (!parentId) return canvas;
  const model = evaluateModel(p, defaultValues(p));
  return toLocal(parentResolved(model, parentId), canvas);
}

/**
 * Install a freshly built mesh (auto mesh, copy, rectangle) on a layer. If the
 * layer's previous mesh was attached to a deformer it stays attached, with a
 * single keyform matching the new rest pose (old keyforms cannot be mapped
 * onto different topology).
 */
function installMesh(d: Project, mesh: ArtMesh) {
  const prev = d.meshes[mesh.layerId];
  const next: ArtMesh = { ...mesh };
  delete next.form;
  delete next.parentId;
  if (prev?.parentId && d.deformers[prev.parentId]) {
    next.parentId = prev.parentId;
    next.form = { bindings: [], keyforms: [{ positions: restToLocal(snapshot(d), prev.parentId, mesh.vertices), opacity: 1 }] };
  }
  d.meshes[mesh.layerId] = next;
}

export function setMesh(layerId: NodeId, mesh: ArtMesh | null, label = mesh ? 'Set Mesh' : 'Delete Mesh'): Command {
  return {
    label,
    apply(d) {
      layerOf(d, layerId);
      if (mesh) installMesh(d, mesh);
      else delete d.meshes[layerId];
      d.updatedAt = new Date().toISOString();
    },
  };
}

/** Set several meshes in one undo step (auto-mesh on a selection). */
export function setMeshes(meshes: ArtMesh[], label = 'Auto Mesh'): Command {
  return {
    label,
    apply(d) {
      for (const m of meshes) { layerOf(d, m.layerId); installMesh(d, m); }
      d.updatedAt = new Date().toISOString();
    },
  };
}

/**
 * Move vertices in mesh-edit mode: the texture stays put, so UVs follow the
 * vertices (deformation keyforms in Phase 3 move positions only).
 */
export function moveVertices(layerId: NodeId, indices: number[], dx: number, dy: number, mergeKey?: string): Command {
  return {
    label: 'Move Vertices',
    mergeKey,
    apply(d) {
      const m = d.meshes[layerId];
      if (!m || (dx === 0 && dy === 0)) return;
      const b = layerOf(d, layerId).bounds;
      const du = dx / (b.width || 1), dv = dy / (b.height || 1);
      // Keyforms: shift each moved vertex by its displacement expressed in the parent's local space.
      let deltas: number[] | null = null;
      if (m.form) {
        const snap = snapshot(d);
        const oldPts: number[] = [], newPts: number[] = [];
        for (const i of indices) {
          oldPts.push(m.vertices[i * 2]!, m.vertices[i * 2 + 1]!);
          newPts.push(m.vertices[i * 2]! + dx, m.vertices[i * 2 + 1]! + dy);
        }
        const a = restToLocal(snap, m.parentId, oldPts), c = restToLocal(snap, m.parentId, newPts);
        deltas = c.map((v, k) => v - a[k]!);
      }
      indices.forEach((i, k) => {
        m.vertices[i * 2]! += dx; m.vertices[i * 2 + 1]! += dy;
        m.uvs[i * 2]! += du; m.uvs[i * 2 + 1]! += dv;
        if (deltas && m.form) for (const kf of m.form.keyforms) { kf.positions[i * 2]! += deltas[k * 2]!; kf.positions[i * 2 + 1]! += deltas[k * 2 + 1]!; }
      });
      if (m.generatedBy === 'auto') m.generatedBy = 'manual';
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function addVertex(layerId: NodeId, x: number, y: number): Command {
  return {
    label: 'Add Vertex',
    apply(d) {
      const m = snapshot(d.meshes[layerId]);
      if (!m) return;
      const added = withVertexAdded(m, layerOf(d, layerId).bounds, x, y).mesh;
      if (m.form) added.form = { ...m.form, keyforms: m.form.keyforms.map((kf) => ({ ...kf, positions: [...kf.positions, ...keyformForNewVertex(snapshot(d), m, kf.positions, x, y)] })) };
      if (m.blendShapes) added.blendShapes = m.blendShapes.map((bs) => ({ ...bs, deltas: bs.deltas.map((dl) => ({ ...dl, positions: [...dl.positions, ...deltaForNewVertex(m, dl.positions, x, y)] })) }));
      d.meshes[layerId] = added;
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function deleteVertices(layerId: NodeId, indices: number[]): Command {
  return {
    label: 'Delete Vertices',
    apply(d) {
      const m = snapshot(d.meshes[layerId]);
      if (!m || !indices.length) return;
      const out = withVerticesDeleted(m, indices);
      if (m.form) {
        const del = new Set(indices);
        out.form = { ...m.form, keyforms: m.form.keyforms.map((kf) => ({ ...kf, positions: kf.positions.filter((_, k) => !del.has(k >> 1)) })) };
      }
      if (m.blendShapes) {
        const del = new Set(indices);
        out.blendShapes = m.blendShapes.map((bs) => ({ ...bs, deltas: bs.deltas.map((dl) => ({ ...dl, positions: dl.positions.filter((_, k) => !del.has(k >> 1)) })) }));
      }
      d.meshes[layerId] = out;
      d.updatedAt = new Date().toISOString();
    },
  };
}

/** Topology edits that keep vertex count and order (keyforms stay valid). */
function topology(label: string, layerId: NodeId, edit: (m: ArtMesh) => ArtMesh): Command {
  return {
    label,
    apply(d) {
      const m = snapshot(d.meshes[layerId]);
      if (!m) return;
      const next = edit(m);
      if (next === m) return;
      d.meshes[layerId] = { ...next, generatedBy: m.generatedBy === 'auto' ? 'manual' : m.generatedBy };
      d.updatedAt = new Date().toISOString();
    },
  };
}

export const connectVertices = (layerId: NodeId, a: number, b: number) => topology('Connect Vertices', layerId, (m) => withEdge(m, a, b));
export const removeEdge = (layerId: NodeId, a: number, b: number) => topology('Remove / Flip Edge', layerId, (m) => withoutEdge(m, a, b).mesh);
export const createTriangle = (layerId: NodeId, a: number, b: number, c: number) => topology('Create Triangle', layerId, (m) => withTriangle(m, a, b, c));
export const deleteTriangles = (layerId: NodeId, selected: number[]) => topology('Delete Triangles', layerId, (m) => withTrianglesDeleted(m, selected).mesh);
export const restoreTriangles = (layerId: NodeId) => topology('Restore Triangles', layerId, (m) => (m.excluded?.length ? retriangulated({ ...m, excluded: [] }) : m));

/**
 * UV editing (spec §5.2): move the texture sample point of vertices without
 * moving them. Dragging by (dx, dy) canvas px slides the texture so the
 * image under the vertices moves with the pointer.
 */
export function moveUVs(layerId: NodeId, indices: number[], dx: number, dy: number, mergeKey?: string): Command {
  return {
    label: 'Move UVs',
    mergeKey,
    apply(d) {
      const m = d.meshes[layerId];
      if (!m || (!dx && !dy)) return;
      const b = layerOf(d, layerId).bounds;
      for (const i of indices) { m.uvs[i * 2]! -= dx / (b.width || 1); m.uvs[i * 2 + 1]! -= dy / (b.height || 1); }
      d.updatedAt = new Date().toISOString();
    },
  };
}

/** Reset UVs to match the rest positions (texture mapped straight under the mesh). */
export function resetUVs(layerId: NodeId): Command {
  return {
    label: 'Reset UVs',
    apply(d) {
      const m = d.meshes[layerId];
      if (m) m.uvs = uvsFor(m.vertices, layerOf(d, layerId).bounds);
    },
  };
}

export function retriangulate(layerId: NodeId): Command {
  return {
    label: 'Retriangulate',
    apply(d) {
      const m = d.meshes[layerId];
      if (m) d.meshes[layerId] = retriangulated(m);
    },
  };
}

export function copyMesh(sourceLayerId: NodeId, targetLayerIds: NodeId[], mirror: boolean): Command {
  return {
    label: mirror ? 'Mirror Mesh' : 'Copy Mesh',
    apply(d) {
      const src = d.meshes[sourceLayerId];
      if (!src) throw new Error('Source layer has no mesh');
      const from = layerOf(d, sourceLayerId).bounds;
      for (const t of targetLayerIds) {
        if (t === sourceLayerId) continue;
        installMesh(d, copiedMesh(snapshot(src), from, layerOf(d, t), mirror));
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}
