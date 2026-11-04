import type { CanvasTool, ToolPointerEvent } from '@l2s/rendering-engine';
import { rotationHandle } from '@l2s/rendering-engine';
import type { Rect } from '@l2s/editor-core';
import { formOwner, parentResolved, setMeshKeyform, setRotationKeyform, setWarpKeyform, setRotationPivot, toLocal, meshLocalPositions, deformerLocalKeyform, setBlendShapeDelta } from '@l2s/deformer-engine';
import type { RotationKeyform, WarpKeyform } from '@l2s/editor-core';
import { editor, useEditor } from '../state/editor.ts';
import { activeObjectId, keyStateOf, useRig } from '../state/rig.ts';
import { netFromGrid, displaceGrid, type BezierNet } from '@l2s/deformer-engine';

/** Current Bézier net (canvas space) of a warp; rebuilt when the target or division changes. */
let netCache: { key: string; net: BezierNet } | null = null;
export function bezierNetFor(id: string, grid: ArrayLike<number>, cols: number, rows: number, div: number): BezierNet {
  const key = `${id}|${div}|${JSON.stringify(keyStateOf(id).target)}`;
  if (netCache?.key !== key) netCache = { key, net: netFromGrid(grid, cols, rows, div) };
  return netCache.net;
}
export function resetBezierNet() { netCache = null; }
function setBezierNet(net: BezierNet) { if (netCache) netCache = { ...netCache, net }; }

const HIT_RADIUS_PX = 8;

/** Canvas-space editable points of an object at the current pose. */
export function deformPoints(id: string): { kind: 'mesh' | 'warp' | 'rotation'; points: Float64Array | Float32Array } | null {
  const s = useEditor.getState();
  const p = s.project;
  if (p.meshes[id]) {
    const pos = s.model.meshes.get(id)?.positions;
    return pos ? { kind: 'mesh', points: pos } : null;
  }
  const r = s.model.deformers.get(id);
  if (!r) return null;
  if (r.kind === 'warp') {
    const bz = useRig.getState().bezier;
    if (bz.on) return { kind: 'warp', points: bezierNetFor(id, r.points, r.cols, r.rows, bz.div).points };
    return { kind: 'warp', points: r.points };
  }
  const [hx, hy] = rotationHandle(r);
  return { kind: 'rotation', points: Float64Array.from([r.x, r.y, hx, hy]) };
}

function nearest(points: ArrayLike<number>, x: number, y: number, radius: number) {
  let best = radius * radius, idx = -1;
  for (let i = 0; i < points.length; i += 2) {
    const d = (points[i]! - x) ** 2 + (points[i + 1]! - y) ** 2;
    if (d <= best) { best = d; idx = i / 2; }
  }
  return idx;
}

/**
 * Write new canvas positions for `indices` into the edit target: the active
 * keyform, or the active blend shape's delta (spec §7.2 / §7.3).
 */
export function commitDeform(id: string, start: ArrayLike<number>, indices: number[], dx: number, dy: number, mergeKey?: string) {
  const moved: number[] = [];
  for (const i of indices) moved.push(start[i * 2]! + dx, start[i * 2 + 1]! + dy);
  commitPoints(id, start, indices, moved, mergeKey);
}

/** Write explicit canvas positions (`moved`, one pair per index) into the edit target. */
export function commitPoints(id: string, start: ArrayLike<number>, indices: number[], moved: number[], mergeKey?: string) {
  const dx = indices.length ? moved[0]! - start[indices[0]! * 2]! : 0, dy = indices.length ? moved[1]! - start[indices[0]! * 2 + 1]! : 0;
  const ks = keyStateOf(id);
  const target = ks.target;
  if (target.kind === 'none') return;
  const s = useEditor.getState();
  const p = s.project;
  const o = formOwner(p, id);
  if (!o) return;
  const values = s.paramValues;
  const parent = parentResolved(s.model, o.kind === 'mesh' ? o.mesh.parentId : o.deformer.parentId);
  const conv = toLocal(parent, moved);

  if (target.kind === 'blend') {
    // new delta = old delta + (desired local − current local)
    const shapes = (o.kind === "mesh" ? o.mesh.blendShapes : o.deformer.blendShapes) as unknown as Array<{ parameterId: string; deltas: Array<Record<string, unknown>> }>;
    const bs = shapes.find((x) => x.parameterId === target.parameterId)!;
    const old = bs.deltas[target.keyIndex]!;
    if (o.kind === 'mesh' || o.kind === 'warp') {
      const key = o.kind === 'mesh' ? 'positions' : 'points';
      const cur = o.kind === 'mesh' ? meshLocalPositions(o.mesh, values).positions : (deformerLocalKeyform(o.deformer as never, values) as { points: number[] }).points;
      const arr = [...(old[key] as number[])];
      indices.forEach((i, k) => { arr[i * 2] = arr[i * 2]! + conv[k * 2]! - cur[i * 2]!; arr[i * 2 + 1] = arr[i * 2 + 1]! + conv[k * 2 + 1]! - cur[i * 2 + 1]!; });
      editor.run(setBlendShapeDelta(id, target.parameterId, target.keyIndex, { ...old, [key]: arr }, mergeKey));
    } else {
      const r = s.model.deformers.get(id);
      const cur = deformerLocalKeyform(o.deformer as never, values) as { x: number; y: number };
      if (r?.kind !== 'rotation') return;
      if (indices.includes(0)) {
        editor.run(setBlendShapeDelta(id, target.parameterId, target.keyIndex, { ...old, x: (old.x as number) + conv[0]! - cur.x, y: (old.y as number) + conv[1]! - cur.y }, mergeKey));
      } else if (indices.includes(1)) {
        const eff = (Math.atan2(start[3]! + dy - r.y, start[2]! + dx - r.x) * 180) / Math.PI + 90;
        const delta = ((eff - r.angle + 540) % 360) - 180;
        editor.run(setBlendShapeDelta(id, target.parameterId, target.keyIndex, { ...old, angle: (old.angle as number) + delta }, mergeKey));
      }
    }
    return;
  }

  const index = target.index;
  if (o.kind === 'mesh') {
    const local = [...(o.mesh.form?.keyforms[index]?.positions ?? meshLocalPositions(o.mesh, values).positions)];
    indices.forEach((i, k) => { local[i * 2] = conv[k * 2]!; local[i * 2 + 1] = conv[k * 2 + 1]!; });
    editor.run(setMeshKeyform(id, index, { positions: local }, mergeKey));
  } else if (o.kind === 'warp') {
    const kf = o.deformer.form.keyforms[index] as WarpKeyform;
    const local = [...kf.points];
    indices.forEach((i, k) => { local[i * 2] = conv[k * 2]!; local[i * 2 + 1] = conv[k * 2 + 1]!; });
    editor.run(setWarpKeyform(id, index, { points: local }, mergeKey));
  } else {
    const kf = o.deformer.form.keyforms[index] as RotationKeyform;
    const r = s.model.deformers.get(id);
    if (r?.kind !== 'rotation') return;
    if (indices.includes(0)) {
      // Moving the origin moves the deformer (and its children).
      const [x, y] = conv as [number, number];
      editor.run(setRotationKeyform(id, index, { x, y }, mergeKey));
    } else if (indices.includes(1)) {
      const hx = start[2]! + dx, hy = start[3]! + dy;
      const effective = (Math.atan2(hy - r.y, hx - r.x) * 180) / Math.PI + 90;
      let delta = effective - r.angle;
      delta = ((delta + 540) % 360) - 180;
      editor.run(setRotationKeyform(id, index, { angle: kf.angle + delta }, mergeKey));
    }
  }
}

/** Deform tool: edits the keyform at the current parameter values (spec §7.2). */
export function createDeformTool(onOverlay: (o: { hover: number; box: Rect | null }) => void): CanvasTool {
  let drag: { id: string; start: Float64Array; startPt: { x: number; y: number }; indices: number[]; key: string; pivot: boolean; bezier?: { net: BezierNet; grid: Float64Array } } | null = null;
  let box: { start: { x: number; y: number }; cur: { x: number; y: number }; additive: boolean } | null = null;
  let hover = -1, seq = 0;
  const rectOf = (b: NonNullable<typeof box>): Rect => ({ x: Math.min(b.start.x, b.cur.x), y: Math.min(b.start.y, b.cur.y), width: Math.abs(b.cur.x - b.start.x), height: Math.abs(b.cur.y - b.start.y) });

  return {
    cursor: 'crosshair',
    onPointerDown(e: ToolPointerEvent) {
      const id = activeObjectId();
      const pts = id ? deformPoints(id) : null;
      if (!id || !pts) return false;
      const editable = keyStateOf(id).target.kind !== 'none';
      const hit = nearest(pts.points, e.world.x, e.world.y, HIT_RADIUS_PX / e.zoom);
      const selPts = useRig.getState().deformSelected;
      if (hit >= 0) {
        let next = selPts;
        if (pts.kind === 'rotation') next = [hit];
        else if (e.ctrl) next = selPts.includes(hit) ? selPts.filter((i) => i !== hit) : [...selPts, hit];
        else if (e.shift) next = selPts.includes(hit) ? selPts : [...selPts, hit];
        else if (!selPts.includes(hit)) next = [hit];
        useRig.setState({ deformSelected: next });
        // Alt+drag on a rotation origin moves the pivot only (all keyforms, children stay put).
        const pivot = pts.kind === 'rotation' && hit === 0 && e.alt;
        if ((!editable && !pivot) || !next.includes(hit)) return false;
        drag = { id, start: Float64Array.from(pts.points), startPt: e.world, indices: pts.kind === 'rotation' ? [hit] : next, key: `deform:${++seq}`, pivot };
        const res = useEditor.getState().model.deformers.get(id);
        if (pts.kind === 'warp' && useRig.getState().bezier.on && res?.kind === 'warp') {
          drag.bezier = { net: { div: useRig.getState().bezier.div, points: Float64Array.from(pts.points) }, grid: Float64Array.from(res.points) };
        }
        return true;
      }
      if (pts.kind === 'rotation') { useRig.setState({ deformSelected: [] }); return false; }
      box = { start: e.world, cur: e.world, additive: e.shift || e.ctrl };
      return true;
    },
    onPointerMove(e: ToolPointerEvent, captured: boolean) {
      if (captured && drag?.pivot) return; // applied once on release (it rewrites every keyform)
      if (captured && drag) {
        const dx = e.world.x - drag.startPt.x, dy = e.world.y - drag.startPt.y;
        const r = useEditor.getState().model.deformers.get(drag.id);
        if (drag.bezier && r?.kind === 'warp') {
          // Move net handles; the grid follows the change of the Bézier surface.
          const to = Float64Array.from(drag.bezier.net.points);
          for (const i of drag.indices) { to[i * 2] = to[i * 2]! + dx; to[i * 2 + 1] = to[i * 2 + 1]! + dy; }
          const toNet = { div: drag.bezier.net.div, points: to };
          const grid = displaceGrid(drag.bezier.grid, r.cols, r.rows, drag.bezier.net, toNet);
          const all = [...Array(grid.length / 2).keys()];
          commitPoints(drag.id, drag.bezier.grid, all, Array.from(grid), drag.key);
          setBezierNet(toNet);
          return;
        }
        commitDeform(drag.id, drag.start, drag.indices, dx, dy, drag.key);
        return;
      }
      if (captured && box) { box.cur = e.world; onOverlay({ hover, box: rectOf(box) }); return; }
      const id = activeObjectId();
      const pts = id ? deformPoints(id) : null;
      const h = pts ? nearest(pts.points, e.world.x, e.world.y, HIT_RADIUS_PX / e.zoom) : -1;
      if (h !== hover) { hover = h; onOverlay({ hover, box: null }); }
    },
    onPointerUp(e: ToolPointerEvent) {
      if (drag?.pivot) editor.run(setRotationPivot(drag.id, drag.start[0]! + e.world.x - drag.startPt.x, drag.start[1]! + e.world.y - drag.startPt.y));
      if (drag) { editor.sealHistoryStep(); drag = null; }
      if (box) {
        const id = activeObjectId();
        const pts = id ? deformPoints(id) : null;
        const r = rectOf(box);
        const inBox: number[] = [];
        if (pts && r.width * r.height > 0) for (let i = 0; i < pts.points.length; i += 2) {
          const x = pts.points[i]!, y = pts.points[i + 1]!;
          if (x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height) inBox.push(i / 2);
        }
        const cur = useRig.getState().deformSelected;
        useRig.setState({ deformSelected: box.additive ? [...new Set([...cur, ...inBox])] : inBox });
        box = null;
        onOverlay({ hover, box: null });
      }
    },
  };
}

/** Move Bézier handles of a warp by (dx, dy) and apply the resulting grid displacement. */
export function moveBezierHandles(id: string, indices: number[], dx: number, dy: number, mergeKey?: string): boolean {
  const r = useEditor.getState().model.deformers.get(id);
  const bz = useRig.getState().bezier;
  if (!bz.on || r?.kind !== 'warp') return false;
  const from = bezierNetFor(id, r.points, r.cols, r.rows, bz.div);
  const to = Float64Array.from(from.points);
  for (const i of indices) { to[i * 2] = to[i * 2]! + dx; to[i * 2 + 1] = to[i * 2 + 1]! + dy; }
  const toNet = { div: from.div, points: to };
  const grid = displaceGrid(r.points, r.cols, r.rows, from, toNet);
  commitPoints(id, r.points, [...Array(grid.length / 2).keys()], Array.from(grid), mergeKey);
  setBezierNet(toNet);
  return true;
}
