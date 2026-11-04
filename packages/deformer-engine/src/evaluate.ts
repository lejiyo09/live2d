import type { ArtMesh, Deformer, DeformerId, MeshKeyform, NodeId, Project, RotationKeyform, WarpKeyform } from '@l2s/editor-core';
import { applyBlendShapes, defaultValues, evaluateGrid, resolveValues, type ParameterValues } from '@l2s/parameter-engine';
import { frameAt, toCanvas, type Resolved } from './transform.ts';

export interface EvaluatedMesh {
  /** Canvas-space positions. */
  positions: Float32Array;
  /** Interpolated draw order (rounded), when the mesh keys it. */
  drawOrder?: number;
  /** Keyform opacity × deformer chain opacity (layer opacity is applied separately). */
  opacity: number;
}

export interface EvaluatedModel {
  values: ParameterValues;
  deformers: Map<DeformerId, Resolved>;
  meshes: Map<NodeId, EvaluatedMesh>;
  /** Deformers skipped because of a cycle or missing parent. */
  broken: DeformerId[];
}

/** Parents-first order; deformers in cycles are reported separately. */
export function deformerOrder(project: Pick<Project, 'deformers'>): { order: DeformerId[]; broken: DeformerId[] } {
  const order: DeformerId[] = [];
  const state = new Map<DeformerId, 1 | 2>(); // 1 visiting, 2 done
  const broken = new Set<DeformerId>();
  const visit = (id: DeformerId, path: DeformerId[]): boolean => {
    const s = state.get(id);
    if (s === 2) return !broken.has(id);
    if (s === 1) { for (const p of path.slice(path.indexOf(id))) broken.add(p); return false; }
    state.set(id, 1);
    const d = project.deformers[id]!;
    let ok = true;
    if (d.parentId !== null) ok = !!project.deformers[d.parentId] && visit(d.parentId, [...path, id]);
    state.set(id, 2);
    if (!ok) { broken.add(id); return false; }
    order.push(id);
    return true;
  };
  for (const id of Object.keys(project.deformers)) visit(id, []);
  return { order: order.filter((id) => !broken.has(id)), broken: [...broken] };
}

/** Is `ancestor` the deformer `id` itself or one of its ancestors? */
export function isDeformerAncestor(project: Pick<Project, 'deformers'>, ancestor: DeformerId, id: DeformerId | null): boolean {
  let cur = id;
  for (let guard = 0; cur !== null && guard < 10_000; guard++) {
    if (cur === ancestor) return true;
    cur = project.deformers[cur]?.parentId ?? null;
  }
  return false;
}

const defaultCache = new WeakMap<object, { params: object; map: Map<DeformerId, Resolved> }>();

/** Deformers resolved at default parameter values (reference frame for rotation-under-warp). */
export function defaultDeformers(project: Project): Map<DeformerId, Resolved> {
  const c = defaultCache.get(project.deformers);
  if (c && c.params === project.parameters) return c.map;
  const map = resolveDeformers(project, defaultValues(project), null);
  defaultCache.set(project.deformers, { params: project.parameters, map });
  return map;
}

function resolveDeformers(project: Project, values: ParameterValues, ref: Map<DeformerId, Resolved> | null): Map<DeformerId, Resolved> {
  const out = new Map<DeformerId, Resolved>();
  for (const id of deformerOrder(project).order) {
    const d = project.deformers[id]!;
    const parent = d.parentId ? out.get(d.parentId)! : null;
    out.set(id, resolveOne(d, parent, values, ref?.get(d.parentId ?? '') ?? null));
  }
  return out;
}

function resolveOne(d: Deformer, parent: Resolved | null, values: ParameterValues, parentAtDefault: Resolved | null): Resolved {
  const pOpacity = parent?.opacity ?? 1;
  if (d.kind === 'warp') {
    const kf = applyBlendShapes(evaluateGrid<WarpKeyform>(d.form, values), d.blendShapes, values);
    return { kind: 'warp', id: d.id, cols: d.cols, rows: d.rows, points: toCanvas(parent, kf.points), opacity: Math.min(1, Math.max(0, kf.opacity)) * pOpacity };
  }
  const kf = applyBlendShapes(evaluateGrid<RotationKeyform>(d.form, values), d.blendShapes, values);
  const [x, y] = toCanvas(parent, [kf.x, kf.y]) as unknown as [number, number];
  let angle = kf.angle, scale = kf.scale;
  if (parent?.kind === 'rotation') {
    angle += parent.angle;
    scale *= parent.scale;
  } else if (parent?.kind === 'warp') {
    // Follow the warp's local rotation/stretch relative to its default pose.
    const now = frameAt(parent, kf.x, kf.y);
    const ref = parentAtDefault ? frameAt(parentAtDefault, kf.x, kf.y) : now;
    angle += now.angle - ref.angle;
    scale *= ref.scale ? now.scale / ref.scale : 1;
  }
  return { kind: 'rotation', id: d.id, x, y, angle, scale, opacity: Math.min(1, Math.max(0, kf.opacity)) * pOpacity, handleLength: d.handleLength };
}

export function meshLocalPositions(mesh: ArtMesh, values: ParameterValues): { positions: number[]; opacity: number; drawOrder?: number } {
  if (!mesh.form) return { positions: mesh.vertices, opacity: 1 };
  const kf = applyBlendShapes(evaluateGrid<MeshKeyform>(mesh.form, values), mesh.blendShapes, values);
  return { positions: kf.positions, opacity: Math.min(1, Math.max(0, kf.opacity)), ...(kf.drawOrder !== undefined ? { drawOrder: Math.round(Math.min(1000, Math.max(0, kf.drawOrder))) } : {}) };
}

/** Evaluate the whole model for the given parameter values (spec §7.2: evaluation is independent of rendering). */
export function evaluateModel(project: Project, input: ParameterValues): EvaluatedModel {
  const values = resolveValues(project, input);
  const ref = Object.values(project.deformers).some((d) => d.kind === 'rotation') ? defaultDeformers(project) : null;
  const deformers = resolveDeformers(project, values, ref);
  const meshes = new Map<NodeId, EvaluatedMesh>();
  for (const [layerId, mesh] of Object.entries(project.meshes)) {
    const parent = mesh.parentId ? deformers.get(mesh.parentId) ?? null : null;
    const local = meshLocalPositions(mesh, values);
    const positions = new Float32Array(toCanvas(parent, local.positions));
    meshes.set(layerId, { positions, opacity: local.opacity * (parent?.opacity ?? 1), ...(local.drawOrder !== undefined ? { drawOrder: local.drawOrder } : {}) });
  }
  return { values, deformers, meshes, broken: deformerOrder(project).broken };
}

export function parentResolved(model: EvaluatedModel, parentId: DeformerId | null | undefined): Resolved | null {
  return parentId ? model.deformers.get(parentId) ?? null : null;
}

/** Current local keyform of a deformer including blend shapes (for editing). */
export function deformerLocalKeyform<T>(d: { form: { bindings: never[] | unknown[]; keyforms: T[] }; blendShapes?: Array<{ parameterId: string; keys: number[]; deltas: T[] }> }, values: ParameterValues): T {
  return applyBlendShapes(evaluateGrid(d.form as never, values) as T, d.blendShapes, values);
}
