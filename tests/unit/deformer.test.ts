import { describe, expect, it } from 'vitest';
import { CommandHistory, createEmptyProject, type LayerNode, type Project, type WarpDeformer } from '@l2s/editor-core';
import { STANDARD_PARAMETERS, activeKeyIndex, insertKey, keyformWeights, evaluateGrid, normalizeValue, addBinding, removeKey } from '@l2s/parameter-engine';
import {
  addParameter, addStandardParameters, bindParameter, createRotationDeformer, createWarpDeformer, deleteDeformers, deleteParameter,
  evaluateModel, mirrorKeyform, reparent, setRotationKeyform, setWarpKeyform, setMeshKeyform, updateParameter, warpForward, warpInverse,
  insertKeyAt,
} from '@l2s/deformer-engine';
import { rectMesh } from '@l2s/mesh-engine';

function proj(): Project {
  const p = createEmptyProject('d', 400, 400);
  const mk = (id: string, x: number): LayerNode => ({ id, kind: 'layer', name: id, parentId: null, visible: true, locked: false, opacity: 1, blendMode: 'normal', bounds: { x, y: 100, width: 100, height: 100 }, assets: { original: id, display: id }, clipping: false, sourcePath: [] });
  p.nodes.A = mk('A', 50); p.nodes.B = mk('B', 250);
  p.rootIds = ['A', 'B'];
  p.meshes.A = rectMesh(p.nodes.A as LayerNode, 0);
  p.meshes.B = rectMesh(p.nodes.B as LayerNode, 0);
  p.parameters = STANDARD_PARAMETERS.map((x) => ({ ...x }));
  return p;
}
const pos = (h: CommandHistory, values: Record<string, number>, id = 'A') => Array.from(evaluateModel(h.project, values).meshes.get(id)!.positions);
const close = (a: number[], b: number[], eps = 1e-3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

describe('parameter engine', () => {
  it('interpolates multilinearly over two parameters', () => {
    let g = { bindings: [], keyforms: [{ v: 0 }] } as { bindings: { parameterId: string; keys: number[] }[]; keyforms: { v: number }[] };
    g = addBinding(g, 'X', [0, 10]);
    g = addBinding(g, 'Y', [0, 1]);
    g.keyforms = [{ v: 0 }, { v: 10 }, { v: 100 }, { v: 110 }]; // (x0,y0) (x1,y0) (x0,y1) (x1,y1)
    expect(evaluateGrid(g, { X: 5, Y: 0.5 }).v).toBeCloseTo(55);
    expect(evaluateGrid(g, { X: 20, Y: -1 }).v).toBeCloseTo(10); // clamped at ends
    expect(keyformWeights(g.bindings, { X: 10, Y: 1 })).toEqual([{ index: 3, weight: 1 }]);
    expect(activeKeyIndex(g.bindings, { X: 10, Y: 0 })).toBe(1);
    expect(activeKeyIndex(g.bindings, { X: 5, Y: 0 })).toBe(-1);
    const g2 = insertKey(g, 'X', 5);
    expect(g2.keyforms).toHaveLength(6);
    expect(evaluateGrid(g2, { X: 5, Y: 0.5 }).v).toBeCloseTo(55);
    expect(removeKey(g2, 'X', 5)).toEqual(g);
  });
  it('wraps repeat parameters', () => {
    expect(normalizeValue({ id: 'r', name: '', min: -180, max: 180, default: 0, repeat: true }, 190)).toBeCloseTo(-170);
    expect(normalizeValue(STANDARD_PARAMETERS[0]!, 99)).toBe(30);
  });
});

describe('warp transform', () => {
  it('inverts a distorted grid', () => {
    const w = { kind: 'warp' as const, id: 'w', cols: 2, rows: 2, opacity: 1, points: Float64Array.from([0, 0, 50, 5, 100, 0, -5, 50, 60, 55, 110, 50, 0, 100, 50, 110, 100, 100]) };
    for (const [u, v] of [[0.2, 0.3], [0.75, 0.9], [1.1, -0.1]]) {
      const [x, y] = warpForward(w, u!, v!);
      const [iu, iv] = warpInverse(w, x, y);
      expect(iu).toBeCloseTo(u!, 5);
      expect(iv).toBeCloseTo(v!, 5);
    }
  });
});

describe('deformer hierarchy', () => {
  it('creating a warp keeps the pose; keyforms deform children with interpolation', () => {
    const h = new CommandHistory(proj());
    const rest = pos(h, {});
    const { command, id } = createWarpDeformer(['A'], { cols: 2, rows: 2 });
    h.execute(command);
    expect(h.project.meshes.A!.parentId).toBe(id);
    close(pos(h, {}), rest);
    h.execute(bindParameter([id], 'ParamAngleX', [-30, 0, 30]));
    const w = h.project.deformers[id] as WarpDeformer;
    const k30 = activeKeyIndex(w.form.bindings, { ParamAngleX: 30 });
    h.execute(setWarpKeyform(id, k30, { points: w.form.keyforms[k30]!.points.map((v, i) => (i % 2 === 0 ? v + 20 : v)) }));
    const at15 = pos(h, { ParamAngleX: 15 }), at30 = pos(h, { ParamAngleX: 30 });
    at15.forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? 10 : 0, 4));
    at30.forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? 20 : 0, 4));
    // Symmetric copy: -30 becomes the mirror of +30.
    const km30 = activeKeyIndex(w.form.bindings, { ParamAngleX: -30 });
    h.execute(mirrorKeyform(id, km30, 'ParamAngleX'));
    pos(h, { ParamAngleX: -30 }).forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? -20 : 0, 4));
  });

  it('rotation deformer rotates children around its origin, nested inside a warp', () => {
    const h = new CommandHistory(proj());
    const rest = pos(h, {});
    const warp = createWarpDeformer(['A']);
    h.execute(warp.command);
    const rot = createRotationDeformer(['A']);
    h.execute(rot.command);
    expect(h.project.deformers[rot.id]!.parentId).toBe(warp.id);
    expect(h.project.meshes.A!.parentId).toBe(rot.id);
    close(pos(h, {}), rest);
    h.execute(bindParameter([rot.id], 'ParamAngleZ', [-30, 30]));
    const k = activeKeyIndex(h.project.deformers[rot.id]!.form.bindings, { ParamAngleZ: 30 });
    h.execute(setRotationKeyform(rot.id, k, { angle: 90 }));
    const out = pos(h, { ParamAngleZ: 30 });
    // Centre (100,150): corner (50,100) → rotated 90° clockwise on screen → (150,100).
    expect(out[0]).toBeCloseTo(150, 3);
    expect(out[1]).toBeCloseTo(100, 3);
    // Default value 0 lies between keys -30 (0°) and +30 (90°) → 45°.
    const atDefault = pos(h, {});
    expect(atDefault[0]).not.toBeCloseTo(rest[0]!, 1);
    // Reparent back to root and delete deformers: the current pose is preserved.
    h.execute(reparent(['A'], null));
    close(pos(h, {}), atDefault);
    h.execute(deleteDeformers([warp.id, rot.id]));
    expect(Object.keys(h.project.deformers)).toEqual([]);
    close(pos(h, {}), atDefault);
  });

  it('reparenting a bound mesh preserves every keyform pose', () => {
    const h = new CommandHistory(proj());
    h.execute(bindParameter(['A'], 'ParamMouthOpenY', [0, 1]));
    const kOpen = activeKeyIndex(h.project.meshes.A!.form!.bindings, { ParamMouthOpenY: 1 });
    h.execute(setMeshKeyform('A', kOpen, { positions: h.project.meshes.A!.form!.keyforms[kOpen]!.positions.map((v, i) => (i % 2 ? v + 30 : v)) }));
    const before = pos(h, { ParamMouthOpenY: 1 });
    const { command } = createWarpDeformer(['A', 'B']);
    h.execute(command);
    close(pos(h, { ParamMouthOpenY: 1 }), before);
    h.undo();
    expect(h.project.meshes.A!.parentId ?? null).toBeNull();
  });

  it('rejects cycles and updates bindings on parameter edits', () => {
    const h = new CommandHistory(proj());
    const outer = createWarpDeformer(['A']);
    h.execute(outer.command);
    const inner = createWarpDeformer(['A']);
    h.execute(inner.command);
    expect(() => h.execute(reparent([outer.id], inner.id))).toThrow();
    h.execute(bindParameter([inner.id], 'ParamAngleX', [-30, 30]));
    h.execute(updateParameter('ParamAngleX', { ...STANDARD_PARAMETERS[0]!, id: 'ParamHeadX' }));
    expect(h.project.deformers[inner.id]!.form.bindings[0]!.parameterId).toBe('ParamHeadX');
    h.execute(insertKeyAt([inner.id], 'ParamHeadX', 0));
    expect(h.project.deformers[inner.id]!.form.keyforms).toHaveLength(3);
    h.execute(deleteParameter('ParamHeadX'));
    expect(h.project.deformers[inner.id]!.form.bindings).toEqual([]);
    expect(h.project.deformers[inner.id]!.form.keyforms).toHaveLength(1);
    expect(() => h.execute(addParameter({ id: 'bad id', name: '', min: 0, max: 1, default: 0 }))).toThrow();
    h.execute(addStandardParameters());
    expect(h.project.parameters.map((p) => p.id)).toContain('ParamAngleX');
  });
});

describe('rotation pivot', () => {
  it('moves the pivot without moving children, and later rotations use it', async () => {
    const { setRotationPivot } = await import('@l2s/deformer-engine');
    const h = new CommandHistory(proj());
    const rest = pos(h, {});
    const rot = createRotationDeformer(['A']);
    h.execute(rot.command);
    h.execute(bindParameter([rot.id], 'ParamAngleZ', [-30, 0, 30]));
    h.execute(setRotationPivot(rot.id, 100, 300));
    close(pos(h, {}), rest);
    close(pos(h, { ParamAngleZ: 30 }), rest);
    const k = activeKeyIndex(h.project.deformers[rot.id]!.form.bindings, { ParamAngleZ: 30 });
    h.execute(setRotationKeyform(rot.id, k, { angle: 90 }));
    const out = pos(h, { ParamAngleZ: 30 });
    // corner (50,100) around pivot (100,300) by 90° → (300, 250)
    expect(out[0]).toBeCloseTo(300, 3);
    expect(out[1]).toBeCloseTo(250, 3);
  });
});

describe('blend shapes (spec §7.3)', () => {
  it('adds on top of keyforms without a key grid, follows reparenting, and is removed with its parameter', async () => {
    const { addBlendShape, setBlendShapeDelta, removeBlendShape } = await import('@l2s/deformer-engine');
    const h = new CommandHistory(proj());
    const rest = pos(h, {});
    const w = createWarpDeformer(['A'], { cols: 2, rows: 2 });
    h.execute(w.command);
    h.execute(bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]));
    const k30 = activeKeyIndex(h.project.deformers[w.id]!.form.bindings, { ParamAngleX: 30 });
    h.execute(setWarpKeyform(w.id, k30, { points: (h.project.deformers[w.id] as WarpDeformer).form.keyforms[k30]!.points.map((v, i) => (i % 2 === 0 ? v + 20 : v)) }));
    // Smile-like blend shape on the mesh: +10 px down at MouthForm = 1.
    h.execute(addBlendShape(['A'], 'ParamMouthForm', [-1, 0, 1]));
    const bs = h.project.meshes.A!.blendShapes![0]!;
    expect(bs.keys).toEqual([-1, 0, 1]);
    expect(h.project.meshes.A!.form!.keyforms).toHaveLength(1); // no grid growth
    const iPlus = bs.keys.indexOf(1);
    // Mesh is under the warp → local space is normalized; convert 10 px over the warp's 100+margin px height.
    const wy = (h.project.deformers[w.id] as WarpDeformer).form.keyforms[0]!.points;
    const span = wy[wy.length - 1]! - wy[1]!;
    h.execute(setBlendShapeDelta('A', 'ParamMouthForm', iPlus, { positions: bs.deltas[iPlus]!.positions.map((_, i) => (i % 2 ? 10 / span : 0)), opacity: 0 }));
    const both = pos(h, { ParamAngleX: 30, ParamMouthForm: 1 });
    both.forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? 20 : 10, 3));
    const half = pos(h, { ParamMouthForm: 0.5 });
    half.forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? 0 : 5, 3));
    // Reparent to root: the blend shape still moves 10 px.
    h.execute(reparent(['A'], null));
    pos(h, { ParamMouthForm: 1 }).forEach((v, i) => expect(v - rest[i]!).toBeCloseTo(i % 2 === 0 ? 0 : 10, 2));
    h.execute(removeBlendShape(['A'], 'ParamMouthForm'));
    expect(h.project.meshes.A!.blendShapes).toBeUndefined();
    h.undo();
    h.execute(deleteParameter('ParamMouthForm'));
    expect(h.project.meshes.A!.blendShapes).toBeUndefined();
  });
});

describe('draw order keyforms', () => {
  it('reorders siblings by interpolated draw order', async () => {
    const { resolveDrawOrder } = await import('@l2s/editor-core');
    const h = new CommandHistory(proj());
    expect(resolveDrawOrder(h.project).map((r) => r.node.id)).toEqual(['A', 'B']);
    h.execute(bindParameter(['A'], 'ParamAngleX', [-30, 30]));
    const k = activeKeyIndex(h.project.meshes.A!.form!.bindings, { ParamAngleX: 30 });
    h.execute(setMeshKeyform('A', k, { drawOrder: 900 }));
    expect(h.project.meshes.A!.form!.keyforms.map((x) => x.drawOrder)).toEqual(k === 1 ? [500, 900] : [900, 500]);
    const order = (v: number) => { const m = evaluateModel(h.project, { ParamAngleX: v }); return resolveDrawOrder(h.project, (id) => m.meshes.get(id)?.drawOrder).map((r) => r.node.id); };
    expect(evaluateModel(h.project, { ParamAngleX: 0 }).meshes.get('A')!.drawOrder).toBe(700);
    expect(order(30)).toEqual(['B', 'A']); // A (900) now above B (500)
    expect(order(-30)).toEqual(['A', 'B']);
  });
});

describe('bezier warp editing', () => {
  it('reproduces a bilinear grid exactly and moves smoothly without disturbing untouched corners', async () => {
    const { netFromGrid, evalNet, displaceGrid } = await import('@l2s/deformer-engine');
    const cols = 4, rows = 4, grid: number[] = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) grid.push(c * 25 + r * 5, r * 25); // sheared (bilinear) grid
    const net = netFromGrid(grid, cols, rows, 1);
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const [x, y] = evalNet(net, c / cols, r / rows);
      expect(x).toBeCloseTo(grid[(r * 5 + c) * 2]!, 6);
      expect(y).toBeCloseTo(grid[(r * 5 + c) * 2 + 1]!, 6);
    }
    const moved = { ...net, points: Float64Array.from(net.points) };
    moved.points[(1 * 4 + 1) * 2] += 20; // inner control point
    const out = displaceGrid(grid, cols, rows, net, moved);
    expect(out[0]).toBeCloseTo(grid[0]!, 9); // corners fixed
    expect(out[(4 * 5 + 4) * 2]).toBeCloseTo(grid[(4 * 5 + 4) * 2]!, 9);
    const centre = (2 * 5 + 2) * 2;
    expect(out[centre]! - grid[centre]!).toBeGreaterThan(1);
    expect(out[centre]! - grid[centre]!).toBeLessThan(20);
  });
});
