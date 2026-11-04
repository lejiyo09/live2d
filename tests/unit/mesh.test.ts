import { describe, expect, it } from 'vitest';
import {
  AUTO_MESH_PRESETS, checkMeshQuality, coverage, generateAutoMesh, hitVertex, meshEdges, moveVertices, addVertex,
  deleteVertices, copyMesh, rectMesh, verticesInRect, traceContours, triangulate,
} from '@l2s/mesh-engine';
import { CommandHistory, createEmptyProject, deleteNodes, translateNodes, type LayerNode, type Project, type Rect } from '@l2s/editor-core';

function disc(w: number, h: number, cx: number, cy: number, r: number) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) a[y * w + x] = 255;
  return a;
}

function layer(id: string, bounds: Rect): LayerNode {
  return { id, kind: 'layer', name: id, parentId: null, visible: true, locked: false, opacity: 1, blendMode: 'normal', bounds, assets: { original: id, display: id }, clipping: false, sourcePath: [] };
}

describe('contours & triangulation', () => {
  it('traces outer loop and hole of a ring', () => {
    const w = 10, h = 10, g = new Uint8Array(w * h);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) g[y * w + x] = 1;
    g[5 * w + 5] = 0;
    const loops = traceContours({ width: w, height: h, data: g });
    expect(loops).toHaveLength(2);
  });
  it('respects constraint loops (concave L shape)', () => {
    const pts = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10];
    const { triangles, constrained } = triangulate(pts, [[0, 1, 2, 3, 4, 5]]);
    expect(constrained).toBe(true);
    expect(triangles.length / 3).toBe(4);
  });
});

describe('generateAutoMesh', () => {
  const bounds = { x: 100, y: 50, width: 200, height: 200 };
  const alpha = disc(200, 200, 100, 100, 90);
  const { mesh, stats } = generateAutoMesh({ layerId: 'L', alpha, bounds, settings: AUTO_MESH_PRESETS.standard });

  it('covers every drawn pixel with a clean mesh', () => {
    expect(mesh).not.toBeNull();
    expect(stats.constrained).toBe(true);
    expect(coverage(mesh!, bounds, alpha, 16).uncovered).toBe(0);
    const issues = checkMeshQuality(mesh!, bounds, { alpha });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('places the outline outside the drawing and uses canvas-space vertices with matching UVs', () => {
    const v = mesh!.vertices, uv = mesh!.uvs;
    for (const i of mesh!.boundary[0]!) {
      const d = Math.hypot(v[i * 2]! - 200, v[i * 2 + 1]! - 150);
      expect(d).toBeGreaterThan(90);
      expect(d).toBeLessThan(90 + 12 + 6);
    }
    for (let i = 0; i < v.length; i += 2) {
      expect(uv[i]!).toBeCloseTo((v[i]! - 100) / 200, 6);
      expect(uv[i + 1]!).toBeCloseTo((v[i + 1]! - 50) / 200, 6);
    }
  });

  it('is denser for detail parts (eyes, mouth)', () => {
    const eye = generateAutoMesh({ layerId: 'L', alpha, bounds, settings: AUTO_MESH_PRESETS.standard, partCategory: 'Eye.Iris.Left' });
    expect(eye.stats.vertices).toBeGreaterThan(stats.vertices * 1.5);
  });

  it('handles multiple islands and returns null for empty layers', () => {
    const a = new Uint8Array(300 * 100);
    for (let y = 30; y < 70; y++) for (let x = 0; x < 300; x++) if (x < 80 || x > 220) a[y * 300 + x] = 255;
    const r = generateAutoMesh({ layerId: 'L', alpha: a, bounds: { x: 0, y: 0, width: 300, height: 100 }, settings: AUTO_MESH_PRESETS.standard });
    expect(r.stats.loops).toBe(2);
    expect(coverage(r.mesh!, { x: 0, y: 0, width: 300, height: 100 }, a, 16).uncovered).toBe(0);
    expect(generateAutoMesh({ layerId: 'L', alpha: new Uint8Array(100), bounds: { x: 0, y: 0, width: 10, height: 10 }, settings: AUTO_MESH_PRESETS.standard }).mesh).toBeNull();
  });
});

describe('mesh editing commands', () => {
  function proj(): Project {
    const p = createEmptyProject('m', 400, 400);
    p.nodes.A = layer('A', { x: 50, y: 50, width: 100, height: 100 });
    p.nodes.B = layer('B', { x: 250, y: 50, width: 100, height: 100 });
    p.rootIds = ['A', 'B'];
    p.meshes.A = rectMesh(p.nodes.A as LayerNode, 10);
    return p;
  }

  it('moves vertices with UVs, merges drags, and undoes', () => {
    const h = new CommandHistory(proj());
    const before = h.project.meshes.A!;
    h.execute(moveVertices('A', [4], 5, 0, 'drag'));
    h.execute(moveVertices('A', [4], 5, 0, 'drag'));
    expect(h.labels.undo).toHaveLength(1);
    expect(h.project.meshes.A!.vertices[8]).toBeCloseTo(before.vertices[8]! + 10);
    expect(h.project.meshes.A!.uvs[8]).toBeCloseTo(before.uvs[8]! + 0.1);
    h.undo();
    expect(h.project.meshes.A).toEqual(before);
  });

  it('adds interior and outline vertices, deletes vertices', () => {
    const h = new CommandHistory(proj());
    const n0 = h.project.meshes.A!.vertices.length / 2;
    h.execute(addVertex('A', 70, 70));
    expect(h.project.meshes.A!.boundary[0]).not.toContain(n0);
    h.execute(addVertex('A', 100, 10)); // above the top edge → outline grows
    expect(h.project.meshes.A!.boundary[0]).toContain(n0 + 1);
    expect(checkMeshQuality(h.project.meshes.A!, h.project.nodes.A!.kind === 'layer' ? (h.project.nodes.A as LayerNode).bounds : { x: 0, y: 0, width: 0, height: 0 })
      .filter((i) => i.severity === 'error')).toEqual([]);
    h.execute(deleteVertices('A', [n0, n0 + 1]));
    expect(h.project.meshes.A!.vertices.length / 2).toBe(n0);
  });

  it('flags folded meshes', () => {
    const h = new CommandHistory(proj());
    h.execute(moveVertices('A', [4], 80, 80)); // centre vertex dragged past the corner
    const issues = checkMeshQuality(h.project.meshes.A!, (h.project.nodes.A as LayerNode).bounds);
    expect(issues.map((i) => i.code)).toContain('flipped-triangle');
  });

  it('copies / mirrors meshes and follows layer moves and deletes', () => {
    const h = new CommandHistory(proj());
    h.execute(copyMesh('A', ['B'], true));
    const b = h.project.meshes.B!;
    expect(b.layerId).toBe('B');
    expect(Math.min(...b.vertices.filter((_, i) => i % 2 === 0))).toBeCloseTo(240);
    expect(checkMeshQuality(b, (h.project.nodes.B as LayerNode).bounds).filter((i) => i.severity === 'error')).toEqual([]);
    h.execute(translateNodes(['B'], 10, 0));
    expect(h.project.meshes.B!.vertices[0]).toBeCloseTo(b.vertices[0]! + 10);
    h.execute(deleteNodes(['B']));
    expect(h.project.meshes.B).toBeUndefined();
  });

  it('queries vertices and edges', () => {
    const m = rectMesh(layer('A', { x: 0, y: 0, width: 100, height: 100 }), 0);
    expect(hitVertex(m, 49, 51, 3)).toBe(4);
    expect(hitVertex(m, 30, 30, 3)).toBe(-1);
    expect(verticesInRect(m, { x: -1, y: -1, width: 60, height: 60 }).sort()).toEqual([0, 1, 3, 4]);
    expect(meshEdges(m).length / 2).toBe(16); // 3x3 grid: 12 grid edges + 4 diagonals
  });
});

describe('degenerate repair', () => {
  it('splits the neighbour of a zero-area triangle instead of leaving a T-junction', async () => {
    const { repairDegenerates } = await import('@l2s/mesh-engine');
    // 0-1-2 collinear on y=0 (1 between 0 and 2); 3 above.
    const coords = [0, 0, 5, 0, 10, 0, 5, 5];
    const out = repairDegenerates(coords, [0, 1, 2, 0, 2, 3]);
    expect(out).toHaveLength(6);
    const tris = [out.slice(0, 3), out.slice(3)].map((t) => [...t].sort().join());
    expect(tris.sort()).toEqual(['0,1,3', '1,2,3']);
  });

  it('auto mesh of art cut by the layer edge has no degenerate triangles', () => {
    const w = 300, h = 120, a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - 150) / 150) ** 2 + ((y - 120) / 120) ** 2 <= 1) a[y * w + x] = 255;
    const bounds = { x: 0, y: 0, width: w, height: h };
    for (const preset of ['standard', 'fine', 'coarse'] as const) {
      const { mesh } = generateAutoMesh({ layerId: 'L', alpha: a, bounds, settings: AUTO_MESH_PRESETS[preset] });
      const issues = checkMeshQuality(mesh!, bounds, { alpha: a });
      expect(issues.filter((i) => i.severity === 'error'), preset).toEqual([]);
    }
  });
});

describe('edge, triangle and UV editing (spec §5.2)', () => {
  // 3×3 grid: indices row-major 0..8; centre = 4.
  const base = () => rectMesh(layer('A', { x: 0, y: 0, width: 100, height: 100 }), 0);
  const hasEdge = (m: { triangles: number[] }, a: number, b: number) => {
    for (let i = 0; i < m.triangles.length; i += 3) { const t = m.triangles.slice(i, i + 3); if (t.includes(a) && t.includes(b)) return true; }
    return false;
  };
  it('keeps user edges through later re-triangulation and vertex edits', async () => {
    const { withEdge, withVertexAdded, withVerticesDeleted } = await import('@l2s/mesh-engine');
    let m = base();
    // Force the diagonal 0–4 the other way round: 1–3 is the alternative in the top-left cell.
    const diag = hasEdge(m, 0, 4) ? [1, 3] : [0, 4];
    m = withEdge(m, diag[0]!, diag[1]!);
    expect(hasEdge(m, diag[0]!, diag[1]!)).toBe(true);
    m = withVertexAdded(m, { x: 0, y: 0, width: 100, height: 100 }, 80, 80).mesh;
    expect(hasEdge(m, diag[0]!, diag[1]!)).toBe(true);
    m = withVerticesDeleted(m, [8]); // indices above 8 shift down; edge 0–4 / 1–3 is unaffected
    expect(hasEdge(m, diag[0]!, diag[1]!)).toBe(true);
  });

  it('flips interior edges, refuses outline edges', async () => {
    const { withoutEdge } = await import('@l2s/mesh-engine');
    const m = base();
    const interior = hasEdge(m, 0, 4) ? [0, 4] : [1, 3];
    const r = withoutEdge(m, interior[0]!, interior[1]!);
    expect(r.flipped).toBe(true);
    expect(hasEdge(r.mesh, interior[0]!, interior[1]!)).toBe(false);
    expect(withoutEdge(m, 0, 1).flipped).toBe(false); // outline
  });

  it('deletes triangles persistently and restores them; creates triangles', async () => {
    const { withTrianglesDeleted, retriangulated, withTriangle } = await import('@l2s/mesh-engine');
    const m = base();
    const n = m.triangles.length / 3;
    const del = withTrianglesDeleted(m, [0, 1, 3, 4]);
    expect(del.count).toBe(2);
    expect(retriangulated(del.mesh).triangles.length / 3).toBe(n - 2);
    expect(retriangulated({ ...del.mesh, excluded: [] }).triangles.length / 3).toBe(n);
    const t = del.mesh.excluded![0]!;
    expect(withTriangle(del.mesh, t[0], t[1], t[2]).triangles.length / 3).toBe(n - 1);
    expect(checkMeshQuality(del.mesh, { x: 0, y: 0, width: 100, height: 100 }, { alpha: new Uint8Array(10000).fill(255) }).map((i) => i.code)).toContain('uncovered-pixels');
  });

  it('moves and resets UVs without moving vertices', async () => {
    const { moveUVs, resetUVs } = await import('@l2s/mesh-engine');
    const p = createEmptyProject('u', 200, 200);
    p.nodes.A = layer('A', { x: 0, y: 0, width: 100, height: 100 });
    p.rootIds = ['A'];
    p.meshes.A = base();
    const h = new CommandHistory(p);
    h.execute(moveUVs('A', [4], 10, 0));
    expect(h.project.meshes.A!.uvs[8]).toBeCloseTo(0.4);
    expect(h.project.meshes.A!.vertices[8]).toBe(50);
    h.execute(resetUVs('A'));
    expect(h.project.meshes.A!.uvs[8]).toBeCloseTo(0.5);
  });
});

describe('ArtPath (Phase 7)', () => {
  it('builds a tapered ribbon through the control points and follows keyforms / deformers', async () => {
    const { buildRibbon, samplePath, createArtPath, addVertex } = await import('@l2s/mesh-engine');
    const { createWarpDeformer, bindParameter, setWarpKeyform, evaluateModel } = await import('@l2s/deformer-engine');
    const { STANDARD_PARAMETERS, activeKeyIndex } = await import('@l2s/parameter-engine');
    const ctrl = [0, 0, 50, 20, 100, 0];
    const c = samplePath(ctrl, false, 8);
    expect([c[0], c[1]]).toEqual([0, 0]);
    expect([c[c.length - 2], c[c.length - 1]]).toEqual([100, 0]);
    expect(c.length / 2).toBe(17); // 2 segments × 8 + end
    const r = buildRibbon(ctrl, { width: 10, color: 0, closed: false, taper: false });
    expect(r.positions.length / 2).toBe(34);
    expect(Math.hypot(r.positions[0]! - r.positions[2]!, r.positions[1]! - r.positions[3]!)).toBeCloseTo(10);
    const tapered = buildRibbon(ctrl, { width: 10, color: 0, closed: false, taper: true });
    expect(Math.hypot(tapered.positions[0]! - tapered.positions[2]!, tapered.positions[1]! - tapered.positions[3]!)).toBeLessThan(2);

    const p = createEmptyProject('ap', 400, 400);
    p.parameters = STANDARD_PARAMETERS.map((x) => ({ ...x }));
    const h = new CommandHistory(p);
    const ap = createArtPath([100, 100, 200, 120, 300, 100]);
    h.execute(ap.command);
    expect(h.project.meshes[ap.id]!.path).toBeDefined();
    expect(h.project.meshes[ap.id]!.triangles).toEqual([]);
    // Put it under a warp keyed on AngleX and move the warp at +30.
    const w = createWarpDeformer([ap.id], { cols: 2, rows: 2 });
    h.execute(w.command);
    h.execute(bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]));
    const k = activeKeyIndex(h.project.deformers[w.id]!.form.bindings, { ParamAngleX: 30 });
    const pts = (h.project.deformers[w.id] as { form: { keyforms: Array<{ points: number[] }> } }).form.keyforms[k]!.points;
    h.execute(setWarpKeyform(w.id, k, { points: pts.map((v, i) => (i % 2 === 0 ? v + 15 : v)) }));
    const at = evaluateModel(h.project, { ParamAngleX: 30 }).meshes.get(ap.id)!.positions;
    expect(at[0]).toBeCloseTo(115, 3);
    // Insert a control point in the middle: keyforms stay aligned.
    h.execute(addVertex(ap.id, 150, 112));
    const m = h.project.meshes[ap.id]!;
    expect(m.vertices.length / 2).toBe(4);
    expect(m.vertices.slice(2, 4)).toEqual([150, 112]);
    expect(m.form!.keyforms[0]!.positions.length).toBe(8);
    const at2 = evaluateModel(h.project, { ParamAngleX: 30 }).meshes.get(ap.id)!.positions;
    expect(at2[2]).toBeCloseTo(165, 1); // new point follows the warp too
  });
});
