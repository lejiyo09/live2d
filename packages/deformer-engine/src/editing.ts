import {
  newId, snapshot,
  type ArtMesh, type Command, type Deformer, type DeformerId, type KeyformGrid, type MeshKeyform, type NodeId, type Parameter, type ParameterGroup,
  type ParameterId, type Project, type RotationDeformer, type RotationKeyform, type WarpDeformer, type WarpKeyform, type BlendShape,
} from '@l2s/editor-core';
import {
  STANDARD_PARAMETERS, STANDARD_PARAMETER_GROUPS, addBinding, blend, zeroLike, defaultValues, gridCoords, gridIndex, insertKey, keyValuesAt, keyformWeights, removeBinding,
  removeKey, validateParameter, KEY_EPSILON, type ParameterValues,
} from '@l2s/parameter-engine';
import { defaultDeformers, evaluateModel, isDeformerAncestor, parentResolved, type EvaluatedModel } from './evaluate.ts';
import { frameAt, toCanvas, toLocal, type Resolved } from './transform.ts';

/** Anything that carries keyforms: an ArtMesh (by layer id) or a deformer. */
export type FormOwner =
  | { kind: 'mesh'; id: NodeId; mesh: ArtMesh }
  | { kind: 'warp'; id: DeformerId; deformer: WarpDeformer }
  | { kind: 'rotation'; id: DeformerId; deformer: RotationDeformer };

export function formOwner(p: Project, id: string): FormOwner | null {
  const d = p.deformers[id];
  if (d) return d.kind === 'warp' ? { kind: 'warp', id, deformer: d } : { kind: 'rotation', id, deformer: d };
  const m = p.meshes[id];
  return m ? { kind: 'mesh', id, mesh: m } : null;
}

export function ownerForm(o: FormOwner): KeyformGrid<unknown> | undefined {
  return o.kind === 'mesh' ? o.mesh.form : o.deformer.form;
}

export function ownerParent(o: FormOwner): DeformerId | null {
  return o.kind === 'mesh' ? o.mesh.parentId ?? null : o.deformer.parentId;
}

/** Give a static mesh a single keyform equal to its rest pose (root space). */
function ensureMeshForm(m: ArtMesh): KeyformGrid<MeshKeyform> {
  if (!m.form) m.form = { bindings: [], keyforms: [{ positions: [...m.vertices], opacity: 1 }] };
  return m.form;
}

/** Defaults overridden by the key values of keyform `index`. */
export function contextValues(project: Project, grid: KeyformGrid<unknown>, index: number): ParameterValues {
  return { ...defaultValues(project), ...keyValuesAt(grid.bindings, index) };
}

class ModelCache {
  private m = new Map<string, EvaluatedModel>();
  constructor(private p: Project) {}
  get(values: ParameterValues) {
    const k = JSON.stringify(Object.entries(values).sort());
    let e = this.m.get(k);
    if (!e) { e = evaluateModel(this.p, values); this.m.set(k, e); }
    return e;
  }
}

/** Effective angle/scale offset a parent applies to a rotation child (inverse of resolveOne). */
function parentAngleOffset(p: Project, parent: Resolved | null, lx: number, ly: number) {
  if (!parent) return { angle: 0, scale: 1 };
  if (parent.kind === 'rotation') return { angle: parent.angle, scale: parent.scale };
  const now = frameAt(parent, lx, ly);
  const refRes = defaultDeformers(p).get(parent.id);
  const ref = refRes ? frameAt(refRes, lx, ly) : now;
  return { angle: now.angle - ref.angle, scale: ref.scale ? now.scale / ref.scale : 1 };
}

/**
 * Re-express blend-shape deltas (point arrays) for a new parent: displaced
 * rest points are mapped through the old parent to canvas and back through
 * the new one, at default parameter values.
 */
function convertShapeDeltas(before: Project, rest: number[], shapes: BlendShape<{ positions?: number[]; points?: number[] }>[] | undefined, key: 'positions' | 'points', oldParent: Resolved | null, newParent: Resolved | null) {
  if (!shapes?.length) return;
  const restCanvas = toCanvas(oldParent, rest);
  const restNew = toLocal(newParent, restCanvas);
  void before;
  for (const s of shapes) {
    s.deltas = s.deltas.map((d) => {
      const arr = d[key]!;
      const moved = toLocal(newParent, toCanvas(oldParent, rest.map((v, i) => v + (arr[i] ?? 0))));
      return { ...d, [key]: moved.map((v, i) => v - restNew[i]!) };
    });
  }
}

/**
 * Re-express an object's keyforms in a new parent's local space so that, for
 * every keyform's parameter context, its canvas pose is unchanged.
 */
function convertOwner(before: Project, after: Project, owner: FormOwner, newParent: DeformerId | null, cacheB: ModelCache, cacheA: ModelCache) {
  const oldParent = ownerParent(owner);
  const defaults = defaultValues(before);
  if (owner.kind === 'mesh') {
    const m = after.meshes[owner.id]!;
    const grid = ensureMeshForm(m);
    if (m.blendShapes?.length) {
      const rest = restKeyform(before, snapshot(grid)).positions;
      m.blendShapes = snapshot(m.blendShapes).map((x) => ({ ...x, deltas: x.deltas.map((d) => ({ ...d })) }));
      convertShapeDeltas(before, rest, m.blendShapes, 'positions', parentResolved(cacheB.get(defaults), oldParent), parentResolved(cacheA.get(defaults), newParent));
    }
    grid.keyforms = grid.keyforms.map((kf, i) => {
      const ctx = contextValues(before, grid, i);
      const canvas = toCanvas(parentResolved(cacheB.get(ctx), oldParent), kf.positions);
      return { ...kf, positions: toLocal(parentResolved(cacheA.get(ctx), newParent), canvas) };
    });
    m.parentId = newParent;
    return;
  }
  const d = after.deformers[owner.id]!;
  if (d.kind === 'warp') {
    if (d.blendShapes?.length) {
      const rest = restKeyform(before, snapshot(d.form)).points;
      d.blendShapes = snapshot(d.blendShapes).map((x) => ({ ...x, deltas: x.deltas.map((q) => ({ ...q })) }));
      convertShapeDeltas(before, rest, d.blendShapes, 'points', parentResolved(cacheB.get(defaults), oldParent), parentResolved(cacheA.get(defaults), newParent));
    }
    d.form.keyforms = d.form.keyforms.map((kf, i) => {
      const ctx = contextValues(before, d.form, i);
      const canvas = toCanvas(parentResolved(cacheB.get(ctx), oldParent), kf.points);
      return { ...kf, points: toLocal(parentResolved(cacheA.get(ctx), newParent), canvas) };
    });
  } else {
    d.form.keyforms = d.form.keyforms.map((kf, i) => {
      const ctx = contextValues(before, d.form, i);
      const res = cacheB.get(ctx).deformers.get(d.id);
      if (!res || res.kind !== 'rotation') return kf;
      const np = parentResolved(cacheA.get(ctx), newParent);
      const [x, y] = toLocal(np, [res.x, res.y]) as [number, number];
      const off = parentAngleOffset(after, np, x, y);
      return { ...kf, x, y, angle: res.angle - off.angle, scale: res.scale / off.scale };
    });
  }
  d.parentId = newParent;
}

/** Reparent meshes / deformers (spec §6.3), rejecting cycles. */
export function reparent(ids: string[], newParent: DeformerId | null): Command {
  return {
    label: newParent ? 'Set Parent Deformer' : 'Unparent',
    apply(d) {
      const before = structuredClone(snapshot(d));
      if (newParent && !d.deformers[newParent]) throw new Error('Target deformer does not exist');
      for (const id of ids) {
        if (d.deformers[id] && newParent && isDeformerAncestor(d, id, newParent)) throw new Error('A deformer cannot be placed inside itself or its children');
      }
      const cacheB = new ModelCache(before);
      // Deformers first (parents of other selected items keep their pose), then meshes.
      const owners = ids.map((id) => formOwner(before, id)).filter((o): o is FormOwner => !!o && ownerParent(o) !== newParent);
      owners.sort((a, b) => (a.kind === 'mesh' ? 1 : 0) - (b.kind === 'mesh' ? 1 : 0));
      for (const o of owners) {
        const after = snapshot(d);
        convertOwner(before, d, o, newParent, cacheB, new ModelCache(structuredClone(after)));
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

// ------------------------------------------------------------------ deformer creation

function canvasBounds(p: Project, ids: string[]) {
  const model = evaluateModel(p, defaultValues(p));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const addPts = (pts: ArrayLike<number>) => {
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!); maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!); maxY = Math.max(maxY, pts[i + 1]!);
    }
  };
  const visit = (id: string) => {
    const m = model.meshes.get(id);
    if (m) addPts(m.positions);
    const r = model.deformers.get(id);
    if (r?.kind === 'warp') addPts(r.points);
    if (r?.kind === 'rotation') addPts([r.x, r.y]);
    if (r) {
      for (const [mid, mesh] of Object.entries(p.meshes)) if (mesh.parentId === id) visit(mid);
      for (const dd of Object.values(p.deformers)) if (dd.parentId === id) visit(dd.id);
    }
  };
  ids.forEach(visit);
  return { model, rect: minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

function commonParent(p: Project, ids: string[]): DeformerId | null {
  const parents = new Set(ids.map((id) => { const o = formOwner(p, id); return o ? ownerParent(o) : null; }));
  if (parents.size !== 1) return null;
  const [only] = parents;
  return only && !ids.includes(only) ? only : null;
}

export interface CreateDeformerOptions {
  name?: string;
  cols?: number;
  rows?: number;
  /** Margin around the children, fraction of the larger side. */
  margin?: number;
}

/** Wrap meshes/deformers in a new warp deformer (spec §6.1). */
export function createWarpDeformer(childIds: string[], opts: CreateDeformerOptions = {}): { command: Command; id: DeformerId } {
  const id = newId('warp');
  return {
    id,
    command: {
      label: 'Create Warp Deformer',
      apply(d) {
        const snap = snapshot(d);
        const children = childIds.filter((c) => formOwner(snap, c));
        if (!children.length) throw new Error('Select ArtMeshes or deformers to deform.');
        const { model, rect } = canvasBounds(snap, children);
        if (!rect) throw new Error('Selection is empty.');
        const cols = Math.max(1, opts.cols ?? 5), rows = Math.max(1, opts.rows ?? 5);
        const m = Math.max(10, Math.max(rect.width, rect.height) * (opts.margin ?? 0.08));
        const x0 = rect.x - m, y0 = rect.y - m, w = rect.width + m * 2, h = rect.height + m * 2;
        const canvas: number[] = [];
        for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) canvas.push(x0 + (w * c) / cols, y0 + (h * r) / rows);
        const parentId = commonParent(snap, children);
        const points = toLocal(parentResolved(model, parentId), canvas);
        d.deformers[id] = { id, kind: 'warp', name: opts.name ?? 'Warp', parentId, cols, rows, form: { bindings: [], keyforms: [{ points, opacity: 1 }] } };
        reparent(children, id).apply(d);
      },
    },
  };
}

/** Wrap meshes/deformers in a new rotation deformer (spec §6.2), origin at the selection centre. */
export function createRotationDeformer(childIds: string[], opts: CreateDeformerOptions = {}): { command: Command; id: DeformerId } {
  const id = newId('rot');
  return {
    id,
    command: {
      label: 'Create Rotation Deformer',
      apply(d) {
        const snap = snapshot(d);
        const children = childIds.filter((c) => formOwner(snap, c));
        if (!children.length) throw new Error('Select ArtMeshes or deformers to rotate.');
        const { model, rect } = canvasBounds(snap, children);
        if (!rect) throw new Error('Selection is empty.');
        const parentId = commonParent(snap, children);
        const [x, y] = toLocal(parentResolved(model, parentId), [rect.x + rect.width / 2, rect.y + rect.height / 2]) as [number, number];
        d.deformers[id] = {
          id, kind: 'rotation', name: opts.name ?? 'Rotation', parentId,
          handleLength: Math.max(40, Math.min(rect.width, rect.height) * 0.4),
          form: { bindings: [], keyforms: [{ x, y, angle: 0, scale: 1, opacity: 1 }] },
        };
        reparent(children, id).apply(d);
      },
    },
  };
}

/** Delete deformers; their children move to the deleted deformer's parent, keeping their pose. */
export function deleteDeformers(ids: DeformerId[]): Command {
  return {
    label: 'Delete Deformer',
    apply(d) {
      for (const id of ids) {
        const def = d.deformers[id];
        if (!def) continue;
        const children = [
          ...Object.values(d.meshes).filter((m) => m.parentId === id).map((m) => m.layerId),
          ...Object.values(d.deformers).filter((x) => x.parentId === id).map((x) => x.id),
        ];
        if (children.length) reparent(children, def.parentId).apply(d);
        delete d.deformers[id];
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function renameDeformer(id: DeformerId, name: string): Command {
  return { label: 'Rename Deformer', apply(d) { const x = d.deformers[id]; if (x) x.name = name.trim() || x.name; } };
}

// ------------------------------------------------------------------ parameters

export function addParameter(p: Parameter): Command {
  return {
    label: 'Add Parameter',
    apply(d) {
      const err = validateParameter(p, d.parameters);
      if (err) throw new Error(err);
      d.parameters.push({ ...p });
      d.updatedAt = new Date().toISOString();
    },
  };
}

/** Add the default parameters (and their groups) that are not defined yet. */
export function addStandardParameters(): Command {
  return {
    label: 'Add Standard Parameters',
    apply(d) { mergeParameterList(d, STANDARD_PARAMETER_GROUPS, STANDARD_PARAMETERS, false); },
  };
}

/**
 * Import a parameter list (e.g. a Cubism parameter-list CSV). New groups and parameters
 * are added; existing IDs get the list's name / range / group / description, and their
 * keys and bindings stay as they are.
 */
export function importParameterList(groups: readonly ParameterGroup[], parameters: readonly Parameter[]): Command {
  return {
    label: 'Import Parameter List',
    apply(d) {
      mergeParameterList(d, groups, parameters, true);
      d.updatedAt = new Date().toISOString();
    },
  };
}

function mergeParameterList(d: Project, groups: readonly ParameterGroup[], parameters: readonly Parameter[], update: boolean) {
  for (const g of groups) {
    const cur = d.parameterGroups.find((x) => x.id === g.id);
    if (!cur) d.parameterGroups.push({ ...g });
    else if (update) Object.assign(cur, g);
  }
  for (const p of parameters) {
    const i = d.parameters.findIndex((x) => x.id === p.id);
    const next = { ...p };
    if (next.groupId && !d.parameterGroups.some((g) => g.id === next.groupId)) delete next.groupId;
    if (i < 0) {
      const err = validateParameter(next, d.parameters);
      if (err) throw new Error(`${p.id}: ${err}`);
      d.parameters.push(next);
    } else if (update) {
      d.parameters[i] = { ...d.parameters[i]!, ...next };
    }
  }
}

/** Update a definition; renaming the ID updates every binding. Keys outside the new range are kept. */
export function updateParameter(id: ParameterId, next: Parameter): Command {
  return {
    label: 'Edit Parameter',
    apply(d) {
      const i = d.parameters.findIndex((p) => p.id === id);
      if (i < 0) return;
      const err = validateParameter(next, d.parameters.filter((_, j) => j !== i));
      if (err) throw new Error(err);
      d.parameters[i] = { ...next };
      if (next.id !== id) {
        for (const g of allForms(d)) for (const b of g.bindings) if (b.parameterId === id) b.parameterId = next.id;
        for (const o of [...Object.values(d.meshes), ...Object.values(d.deformers)]) for (const bs of o.blendShapes ?? []) if (bs.parameterId === id) bs.parameterId = next.id;
        for (const ex of d.expressions ?? []) for (const ep of ex.parameters) if (ep.parameterId === id) ep.parameterId = next.id;
        for (const c of d.animations ?? []) for (const tr of c.tracks) if (tr.parameterId === id) tr.parameterId = next.id;
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

/** Delete a parameter; bound objects keep the keyform at the parameter's default. */
export function deleteParameter(id: ParameterId): Command {
  return {
    label: 'Delete Parameter',
    apply(d) {
      const p = d.parameters.find((x) => x.id === id);
      if (!p) return;
      forEachOwner(d, (set, grid) => { if (grid.bindings.some((b) => b.parameterId === id)) set(removeBinding(grid, id, p.default)); });
      for (const o of [...Object.values(d.meshes), ...Object.values(d.deformers)]) {
        if (!o.blendShapes) continue;
        const kept = (o.blendShapes as Array<{ parameterId: string }>).filter((bs) => bs.parameterId !== id);
        if (kept.length) (o as { blendShapes?: unknown }).blendShapes = kept;
        else delete (o as { blendShapes?: unknown }).blendShapes;
      }
      d.parameters = d.parameters.filter((x) => x.id !== id);
      for (const ex of d.expressions ?? []) ex.parameters = ex.parameters.filter((ep) => ep.parameterId !== id);
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function moveParameter(id: ParameterId, delta: -1 | 1): Command {
  return {
    label: 'Reorder Parameter',
    apply(d) {
      const i = d.parameters.findIndex((p) => p.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.parameters.length) return;
      [d.parameters[i], d.parameters[j]] = [d.parameters[j]!, d.parameters[i]!];
    },
  };
}

function allForms(d: Project): KeyformGrid<unknown>[] {
  return [...Object.values(d.meshes).map((m) => m.form).filter((f): f is KeyformGrid<MeshKeyform> => !!f), ...Object.values(d.deformers).map((x) => x.form)];
}

function forEachOwner(d: Project, fn: (set: (g: KeyformGrid<never>) => void, grid: KeyformGrid<never>) => void, only?: Set<string>) {
  for (const m of Object.values(d.meshes)) {
    if (only && !only.has(m.layerId)) continue;
    if (only) ensureMeshForm(m);
    if (m.form) fn((g) => { m.form = g as KeyformGrid<MeshKeyform>; }, snapshot(m.form) as KeyformGrid<never>);
  }
  for (const x of Object.values(d.deformers)) {
    if (only && !only.has(x.id)) continue;
    fn((g) => { (x as { form: unknown }).form = g; }, snapshot(x.form) as KeyformGrid<never>);
  }
}

// ------------------------------------------------------------------ bindings & keys

export function bindParameter(objectIds: string[], parameterId: ParameterId, keys: number[]): Command {
  return {
    label: 'Add Keys',
    apply(d) {
      if (!d.parameters.some((p) => p.id === parameterId)) throw new Error(`Unknown parameter ${parameterId}`);
      forEachOwner(d, (set, g) => set(addBinding(g, parameterId, keys)), new Set(objectIds));
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function unbindParameter(objectIds: string[], parameterId: ParameterId, keepValue: number): Command {
  return {
    label: 'Remove Binding',
    apply(d) {
      forEachOwner(d, (set, g) => set(removeBinding(g, parameterId, keepValue)), new Set(objectIds));
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function insertKeyAt(objectIds: string[], parameterId: ParameterId, value: number): Command {
  return {
    label: 'Add Key',
    apply(d) {
      forEachOwner(d, (set, g) => { if (g.bindings.some((b) => b.parameterId === parameterId)) set(insertKey(g, parameterId, value)); }, new Set(objectIds));
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function removeKeyAt(objectIds: string[], parameterId: ParameterId, value: number): Command {
  return {
    label: 'Remove Key',
    apply(d) {
      forEachOwner(d, (set, g) => { if (g.bindings.some((b) => b.parameterId === parameterId)) set(removeKey(g, parameterId, value)); }, new Set(objectIds));
      d.updatedAt = new Date().toISOString();
    },
  };
}

// ------------------------------------------------------------------ keyform edits

export function setMeshKeyform(layerId: NodeId, index: number, patch: Partial<MeshKeyform>, mergeKey?: string): Command {
  return {
    label: 'Edit Keyform',
    mergeKey,
    apply(d) {
      const m = d.meshes[layerId];
      if (!m) return;
      const g = ensureMeshForm(m);
      const kf = g.keyforms[index];
      if (!kf) throw new Error('Keyform does not exist');
      if (patch.positions) { if (patch.positions.length !== kf.positions.length) throw new Error('Vertex count mismatch'); kf.positions = patch.positions; }
      if (patch.opacity !== undefined) kf.opacity = Math.min(1, Math.max(0, patch.opacity));
      if (patch.drawOrder !== undefined) {
        // Keep the field on every keyform so interpolation stays structural.
        for (const k of g.keyforms) if (k.drawOrder === undefined) k.drawOrder = 500;
        for (const bs of m.blendShapes ?? []) for (const dl of bs.deltas) if (dl.drawOrder === undefined) dl.drawOrder = 0;
        kf.drawOrder = Math.round(Math.min(1000, Math.max(0, patch.drawOrder)));
      }
    },
  };
}

export function setWarpKeyform(id: DeformerId, index: number, patch: Partial<WarpKeyform>, mergeKey?: string): Command {
  return {
    label: 'Edit Keyform',
    mergeKey,
    apply(d) {
      const x = d.deformers[id];
      if (x?.kind !== 'warp') return;
      const kf = x.form.keyforms[index];
      if (!kf) throw new Error('Keyform does not exist');
      if (patch.points) kf.points = patch.points;
      if (patch.opacity !== undefined) kf.opacity = Math.min(1, Math.max(0, patch.opacity));
    },
  };
}

export function setRotationKeyform(id: DeformerId, index: number, patch: Partial<RotationKeyform>, mergeKey?: string): Command {
  return {
    label: 'Edit Keyform',
    mergeKey,
    apply(d) {
      const x = d.deformers[id];
      if (x?.kind !== 'rotation') return;
      const kf = x.form.keyforms[index];
      if (!kf) throw new Error('Keyform does not exist');
      Object.assign(kf, patch);
      if (patch.opacity !== undefined) kf.opacity = Math.min(1, Math.max(0, patch.opacity));
    },
  };
}

/** Replace a keyform wholesale (paste, spec §7.2). Structure must match. */
export function pasteKeyform(objectId: string, index: number, keyform: unknown): Command {
  return {
    label: 'Paste Keyform',
    apply(d) {
      const o = formOwner(d, objectId);
      if (!o) return;
      const g = (o.kind === 'mesh' ? ensureMeshForm(o.mesh) : o.deformer.form) as unknown as KeyformGrid<Record<string, unknown>>;
      const cur = g.keyforms[index];
      if (!cur) throw new Error('Keyform does not exist');
      const src = keyform as Record<string, unknown>;
      for (const k of Object.keys(cur)) {
        const a = cur[k], b = src[k];
        if (typeof a !== typeof b || (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length))) throw new Error('Clipboard keyform does not match this object');
      }
      g.keyforms[index] = structuredClone(src);
    },
  };
}

/** Direct children (meshes by layer id, deformers) of a deformer. */
export function childrenOf(p: Project, id: DeformerId): string[] {
  return [
    ...Object.values(p.meshes).filter((m) => m.parentId === id).map((m) => m.layerId),
    ...Object.values(p.deformers).filter((x) => x.parentId === id).map((x) => x.id),
  ];
}

/**
 * Move a rotation deformer's pivot (in every keyform) without moving anything
 * on screen: children are re-expressed relative to the new origin.
 */
export function setRotationPivot(id: DeformerId, canvasX: number, canvasY: number): Command {
  return {
    label: 'Move Rotation Pivot',
    apply(d) {
      const before = structuredClone(snapshot(d));
      const rot = before.deformers[id];
      if (rot?.kind !== 'rotation') return;
      const cacheB = new ModelCache(before);
      const defaults = defaultValues(before);
      const res = cacheB.get(defaults).deformers.get(id);
      if (res?.kind !== 'rotation') return;
      const parent = parentResolved(cacheB.get(defaults), rot.parentId);
      const [nx, ny] = toLocal(parent, [canvasX, canvasY]) as [number, number];
      const [ox, oy] = toLocal(parent, [res.x, res.y]) as [number, number];
      const target = d.deformers[id] as RotationDeformer;
      for (const kf of target.form.keyforms) { kf.x += nx - ox; kf.y += ny - oy; }
      const after = structuredClone(snapshot(d));
      const cacheA = new ModelCache(after);
      for (const cid of childrenOf(before, id)) {
        const o = formOwner(before, cid);
        if (!o) continue;
        // Same parent, new frame: convert from the old pose to the new one.
        rebase(before, d, o, cacheB, cacheA);
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

function rebase(before: Project, d: Project, owner: FormOwner, cacheB: ModelCache, cacheA: ModelCache) {
  const parentId = ownerParent(owner);
  const defaults = defaultValues(before);
  if (owner.kind === 'mesh') {
    const m = d.meshes[owner.id]!;
    const grid = ensureMeshForm(m);
    if (m.blendShapes?.length) {
      m.blendShapes = snapshot(m.blendShapes).map((x) => ({ ...x, deltas: x.deltas.map((q) => ({ ...q })) }));
      convertShapeDeltas(before, restKeyform(before, snapshot(grid)).positions, m.blendShapes, 'positions', parentResolved(cacheB.get(defaults), parentId), parentResolved(cacheA.get(defaults), parentId));
    }
    grid.keyforms = snapshot(grid.keyforms).map((kf, i) => {
      const ctx = contextValues(before, grid, i);
      const canvas = toCanvas(parentResolved(cacheB.get(ctx), parentId), kf.positions);
      return { ...kf, positions: toLocal(parentResolved(cacheA.get(ctx), parentId), canvas) };
    });
    return;
  }
  const x = d.deformers[owner.id]!;
  if (x.kind === 'warp') {
    if (x.blendShapes?.length) {
      x.blendShapes = snapshot(x.blendShapes).map((b) => ({ ...b, deltas: b.deltas.map((q) => ({ ...q })) }));
      convertShapeDeltas(before, restKeyform(before, snapshot(x.form)).points, x.blendShapes, 'points', parentResolved(cacheB.get(defaults), parentId), parentResolved(cacheA.get(defaults), parentId));
    }
    x.form.keyforms = snapshot(x.form.keyforms).map((kf, i) => {
      const ctx = contextValues(before, x.form, i);
      const canvas = toCanvas(parentResolved(cacheB.get(ctx), parentId), kf.points);
      return { ...kf, points: toLocal(parentResolved(cacheA.get(ctx), parentId), canvas) };
    });
  } else {
    x.form.keyforms = snapshot(x.form.keyforms).map((kf, i) => {
      const ctx = contextValues(before, x.form, i);
      const res = cacheB.get(ctx).deformers.get(x.id);
      if (!res || res.kind !== 'rotation') return kf;
      const np = parentResolved(cacheA.get(ctx), parentId);
      const [lx, ly] = toLocal(np, [res.x, res.y]) as [number, number];
      const off = parentAngleOffset(d, np, lx, ly);
      return { ...kf, x: lx, y: ly, angle: res.angle - off.angle, scale: res.scale / off.scale };
    });
  }
}

/** Keyform blended at the object's default parameter values (symmetry axis / reference). */
function restKeyform<T>(p: Project, g: KeyformGrid<T>): T {
  return blend(g.keyforms, keyformWeights(g.bindings, defaultValues(p)));
}

/**
 * Symmetric keyform copy (spec §7.2): fill keyform `index` with the mirror of
 * the keyform at the opposite key of `parameterId` (2·default − value).
 * Displacements from the rest keyform are mirrored horizontally.
 */
export function mirrorKeyform(objectId: string, index: number, parameterId: ParameterId): Command {
  return {
    label: 'Mirror Keyform',
    apply(d) {
      const p = d.parameters.find((x) => x.id === parameterId);
      const o = formOwner(d, objectId);
      if (!p || !o) return;
      const g = (o.kind === 'mesh' ? ensureMeshForm(o.mesh) : o.deformer.form) as KeyformGrid<never>;
      const bi = g.bindings.findIndex((b) => b.parameterId === parameterId);
      if (bi < 0) throw new Error(`Not bound to ${parameterId}`);
      const c = gridCoords(g.bindings, index);
      const target = g.bindings[bi]!.keys[c[bi]!]!;
      const mirrored = 2 * p.default - target;
      const ks = g.bindings[bi]!.keys.findIndex((k) => Math.abs(k - mirrored) <= KEY_EPSILON);
      if (ks < 0) throw new Error(`No key at ${mirrored} to mirror from`);
      const sc = [...c];
      sc[bi] = ks;
      const srcIdx = gridIndex(g.bindings, sc);
      if (srcIdx === index) return;
      const snap = snapshot(d);
      const so = formOwner(snap, objectId)!;
      if (so.kind === 'warp') {
        const grid = so.deformer.form;
        const rest = restKeyform(snap, grid).points, src = grid.keyforms[srcIdx]!.points;
        const { cols, rows } = so.deformer;
        const out = [...rest];
        for (let r = 0; r <= rows; r++) for (let col = 0; col <= cols; col++) {
          const t = (r * (cols + 1) + col) * 2, s = (r * (cols + 1) + (cols - col)) * 2;
          out[t] = rest[t]! - (src[s]! - rest[s]!);
          out[t + 1] = rest[t + 1]! + (src[s + 1]! - rest[s + 1]!);
        }
        (d.deformers[objectId] as WarpDeformer).form.keyforms[index] = { points: out, opacity: grid.keyforms[srcIdx]!.opacity };
      } else if (so.kind === 'rotation') {
        const grid = so.deformer.form;
        const rest = restKeyform(snap, grid), src = grid.keyforms[srcIdx]!;
        (d.deformers[objectId] as RotationDeformer).form.keyforms[index] = {
          x: rest.x - (src.x - rest.x), y: src.y, angle: rest.angle - (src.angle - rest.angle), scale: src.scale, opacity: src.opacity,
        };
      } else {
        const grid = so.mesh.form ?? { bindings: [], keyforms: [{ positions: so.mesh.vertices, opacity: 1 }] };
        const rest = restKeyform(snap, grid).positions, src = grid.keyforms[srcIdx]!.positions;
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i < rest.length; i += 2) { minX = Math.min(minX, rest[i]!); maxX = Math.max(maxX, rest[i]!); }
        const axis2 = minX + maxX;
        const out = [...rest];
        for (let i = 0; i < rest.length; i += 2) {
          // Vertex whose rest position is nearest to this vertex's mirror image.
          const mx = axis2 - rest[i]!, my = rest[i + 1]!;
          let best = Infinity, j = i;
          for (let k = 0; k < rest.length; k += 2) {
            const dd = (rest[k]! - mx) ** 2 + (rest[k + 1]! - my) ** 2;
            if (dd < best) { best = dd; j = k; }
          }
          out[i] = rest[i]! - (src[j]! - rest[j]!);
          out[i + 1] = rest[i + 1]! + (src[j + 1]! - rest[j + 1]!);
        }
        d.meshes[objectId]!.form!.keyforms[index] = { positions: out, opacity: grid.keyforms[srcIdx]!.opacity };
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

// ------------------------------------------------------------------ parameter groups & expressions (spec §7.3)

export function addParameterGroup(id: string, name: string): Command {
  return { label: 'Add Parameter Group', apply(d) { if (!d.parameterGroups.some((g) => g.id === id)) d.parameterGroups.push({ id, name }); } };
}
export function renameParameterGroup(id: string, name: string): Command {
  return { label: 'Rename Parameter Group', apply(d) { const g = d.parameterGroups.find((x) => x.id === id); if (g) g.name = name.trim() || g.name; } };
}
/** Delete a group; its parameters become ungrouped. */
export function deleteParameterGroup(id: string): Command {
  return {
    label: 'Delete Parameter Group',
    apply(d) {
      d.parameterGroups = d.parameterGroups.filter((g) => g.id !== id);
      for (const p of d.parameters) if (p.groupId === id) delete p.groupId;
    },
  };
}
export function setParameterGroup(parameterIds: string[], groupId: string | null): Command {
  return {
    label: 'Set Parameter Group',
    apply(d) {
      for (const p of d.parameters) if (parameterIds.includes(p.id)) { if (groupId) p.groupId = groupId; else delete p.groupId; }
    },
  };
}

export function addExpression(e: import('@l2s/editor-core').Expression): Command {
  return { label: 'Add Expression', apply(d) { d.expressions.push(structuredClone(e)); } };
}
export function updateExpression(id: string, fn: (e: import('@l2s/editor-core').Expression) => void, mergeKey?: string): Command {
  return { label: 'Edit Expression', mergeKey, apply(d) { const e = d.expressions.find((x) => x.id === id); if (e) fn(e); } };
}
export function deleteExpression(id: string): Command {
  return { label: 'Delete Expression', apply(d) { d.expressions = d.expressions.filter((x) => x.id !== id); } };
}

// ------------------------------------------------------------------ blend shapes (spec §7.3)

type AnyShape = BlendShape<Record<string, unknown>>;
function shapesOf(o: FormOwner): { list: AnyShape[] | undefined; set: (l: AnyShape[] | undefined) => void; like: Record<string, unknown> } {
  if (o.kind === 'mesh') {
    const g = ensureMeshForm(o.mesh);
    return { list: o.mesh.blendShapes as AnyShape[] | undefined, set: (l) => { if (l?.length) o.mesh.blendShapes = l as never; else delete o.mesh.blendShapes; }, like: snapshot(g.keyforms[0]) as never };
  }
  return { list: o.deformer.blendShapes as AnyShape[] | undefined, set: (l) => { if (l?.length) o.deformer.blendShapes = l as never; else delete o.deformer.blendShapes; }, like: snapshot(o.deformer.form.keyforms[0]) as never };
}

/** Add a blend shape on `parameterId` (keys must include the default, where the delta is zero). */
export function addBlendShape(objectIds: string[], parameterId: ParameterId, keys: number[]): Command {
  return {
    label: 'Add Blend Shape',
    apply(d) {
      const p = d.parameters.find((x) => x.id === parameterId);
      if (!p) throw new Error(`Unknown parameter ${parameterId}`);
      const ks = [...new Set([...keys, p.default])].sort((a, b) => a - b);
      for (const id of objectIds) {
        const o = formOwner(d, id);
        if (!o) continue;
        const form = ownerForm(o);
        if (form?.bindings.some((b) => b.parameterId === parameterId)) continue; // already a keyform parameter
        const sh = shapesOf(o);
        if (sh.list?.some((x) => x.parameterId === parameterId)) continue;
        sh.set([...(sh.list ?? []), { parameterId, keys: ks, deltas: ks.map(() => zeroLike(sh.like)) }]);
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

export function removeBlendShape(objectIds: string[], parameterId: ParameterId): Command {
  return {
    label: 'Remove Blend Shape',
    apply(d) {
      for (const id of objectIds) {
        const o = formOwner(d, id);
        if (!o) continue;
        const sh = shapesOf(o);
        if (sh.list) sh.set(sh.list.filter((x) => x.parameterId !== parameterId));
      }
    },
  };
}

/** Replace the delta at one key of a blend shape. */
export function setBlendShapeDelta(objectId: string, parameterId: ParameterId, keyIndex: number, delta: Record<string, unknown>, mergeKey?: string): Command {
  return {
    label: 'Edit Blend Shape',
    mergeKey,
    apply(d) {
      const o = formOwner(d, objectId);
      if (!o) return;
      const s = shapesOf(o).list?.find((x) => x.parameterId === parameterId);
      if (!s || !s.deltas[keyIndex]) throw new Error('Blend shape key does not exist');
      s.deltas[keyIndex] = delta;
    },
  };
}

export type { Deformer };
