import { create } from 'zustand';
import type { KeyformGrid, LayerNode, NodeId } from '@l2s/editor-core';
import { activeKeyIndex, presetKeys, keyValuesAt, KEY_EPSILON } from '@l2s/parameter-engine';
import {
  addBlendShape, removeBlendShape,
  addParameter, addStandardParameters, bindParameter, createRotationDeformer, createWarpDeformer, deleteDeformers, deleteParameter,
  formOwner, insertKeyAt, mirrorKeyform, ownerForm, pasteKeyform, removeKeyAt, reparent, unbindParameter, updateParameter,
} from '@l2s/deformer-engine';
import { rectMesh, setMesh } from '@l2s/mesh-engine';
import type { Parameter } from '@l2s/editor-core';
import { editor, log, useEditor } from './editor.ts';

export interface RigState {
  /** Selected points of the deform tool (mesh vertices / warp points / rotation 0=origin 1=handle). */
  deformSelected: number[];
  clipboard: { kind: string; length: number; keyform: unknown } | null;
  deformerDialog: 'warp' | 'rotation' | null;
  paramDialog: { mode: 'new' } | { mode: 'edit'; id: string } | null;
  warpCols: number;
  warpRows: number;
  /** Deform tool on warps: edit through a Bézier control net. */
  bezier: { on: boolean; div: 1 | 2 };
}

export const useRig = create<RigState>(() => ({
  deformSelected: [],
  clipboard: null,
  deformerDialog: null,
  paramDialog: null,
  warpCols: 5,
  warpRows: 5,
  bezier: { on: false, div: 1 },
}));

const sel = () => useEditor.getState().selection;

/** Keyed objects in the selection: ArtMesh layers (groups expanded) and deformers. */
export function selectedObjectIds(): string[] {
  const p = editor.project;
  const out = new Set<string>();
  const walk = (id: string) => {
    if (p.deformers[id]) { out.add(id); return; }
    const n = p.nodes[id];
    if (!n) return;
    if (n.kind === 'layer') { if (p.meshes[n.id]) out.add(n.id); }
    else n.childIds.forEach(walk);
  };
  sel().ids.forEach(walk);
  return [...out];
}

/** Active object (last clicked): ArtMesh layer or deformer. */
export function activeObjectId(): string | null {
  const p = editor.project;
  const s = sel();
  const id = s.anchor && s.ids.includes(s.anchor) ? s.anchor : s.ids.at(-1);
  if (!id) return null;
  if (p.deformers[id] || p.meshes[id]) return id;
  return null;
}

export type EditTarget =
  | { kind: 'keyform'; index: number }
  | { kind: 'blend'; parameterId: string; keyIndex: number }
  | { kind: 'none' };

export interface KeyState {
  form: KeyformGrid<unknown> | null;
  /** Index of the keyform being edited, -1 when not editing a keyform. */
  index: number;
  label: string;
  /** What a deform edit writes to. */
  target: EditTarget;
}

export function keyStateOf(id: string | null): KeyState {
  const none = (label: string): KeyState => ({ form: null, index: -1, label, target: { kind: 'none' } });
  if (!id) return none('');
  const p = editor.project;
  const o = formOwner(p, id);
  if (!o) return none('');
  const form = ownerForm(o) ?? null;
  const values = useEditor.getState().paramValues;
  const pname = (pid: string) => p.parameters.find((x) => x.id === pid)?.name ?? pid;
  // Blend shapes away from their default take precedence (spec §7.3).
  const shapes = (o.kind === 'mesh' ? o.mesh.blendShapes : o.deformer.blendShapes) ?? [];
  const activeShapes = shapes.filter((bs) => {
    const def = p.parameters.find((x) => x.id === bs.parameterId)?.default ?? 0;
    return Math.abs((values[bs.parameterId] ?? def) - def) > KEY_EPSILON;
  });
  if (activeShapes.length > 1) return { ...none(`Several blend shapes active (${activeShapes.map((x) => pname(x.parameterId)).join(', ')}) — set all but one to default`), form };
  if (activeShapes.length === 1) {
    const bs = activeShapes[0]!;
    const v = values[bs.parameterId]!;
    const k = bs.keys.findIndex((key) => Math.abs(key - v) <= KEY_EPSILON);
    if (k < 0) return { ...none(`Blend shape ${pname(bs.parameterId)}: between keys — move onto a key to edit`), form };
    return { form, index: -1, label: `Blend shape ${pname(bs.parameterId)} = ${fmt(v)}`, target: { kind: 'blend', parameterId: bs.parameterId, keyIndex: k } };
  }
  if (!form) return { form: null, index: 0, label: 'Static (no keys)', target: { kind: 'keyform', index: 0 } };
  const index = activeKeyIndex(form.bindings, values);
  if (!form.bindings.length) return { form, index: 0, label: 'Single keyform (no parameters bound)', target: { kind: 'keyform', index: 0 } };
  if (index < 0) return { form, index, label: 'Between keys — move parameters onto a key to edit', target: { kind: 'none' } };
  const kv = keyValuesAt(form.bindings, index);
  return { form, index, label: Object.entries(kv).map(([k, v]) => `${pname(k)} = ${fmt(v)}`).join(', '), target: { kind: 'keyform', index } };
}

export function fmt(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
}

function ensureMeshes(): string[] {
  // Layers without an ArtMesh get a rectangle mesh so they can be deformed (deformers act on ArtMeshes).
  const p = editor.project;
  const ids: string[] = [];
  const walk = (id: string) => {
    if (p.deformers[id]) { ids.push(id); return; }
    const n = p.nodes[id];
    if (!n) return;
    if (n.kind === 'group') { n.childIds.forEach(walk); return; }
    if (!p.meshes[n.id]) editor.run(setMesh(n.id, rectMesh(n as LayerNode, 8), 'Create Mesh'));
    ids.push(n.id);
  };
  // Top-level selection only; objects inside a selected deformer move with it.
  sel().ids.forEach(walk);
  return ids.filter((id) => {
    const o = formOwner(editor.project, id);
    if (!o) return false;
    const parent = o.kind === 'mesh' ? o.mesh.parentId : o.deformer.parentId;
    return !parent || !ids.includes(parent);
  });
}

export const rigActions = {
  openDeformerDialog(kind: 'warp' | 'rotation' | null) { useRig.setState({ deformerDialog: kind }); },
  setWarpDivisions(cols: number, rows: number) { useRig.setState({ warpCols: cols, warpRows: rows }); },
  toggleBezier() { const b = useRig.getState().bezier; useRig.setState({ bezier: { ...b, on: !b.on }, deformSelected: [] }); },
  setBezierDiv(div: 1 | 2) { useRig.setState({ bezier: { on: true, div }, deformSelected: [] }); },

  createDeformer(kind: 'warp' | 'rotation', name: string) {
    const ids = ensureMeshes();
    if (!ids.length) { log('warn', 'Select layers, ArtMeshes or deformers first.'); return; }
    const { warpCols, warpRows } = useRig.getState();
    const r = kind === 'warp' ? createWarpDeformer(ids, { name, cols: warpCols, rows: warpRows }) : createRotationDeformer(ids, { name });
    if (editor.run(r.command)) {
      editor.selectIds([r.id]);
      editor.setLeftTab('deformers');
      log('info', `Created ${kind} deformer "${name}" with ${ids.length} child object(s).`);
    }
    useRig.setState({ deformerDialog: null });
  },

  deleteSelectedDeformers() {
    const ids = sel().ids.filter((id) => editor.project.deformers[id]);
    if (ids.length) editor.run(deleteDeformers(ids));
  },

  setParent(ids: string[], parentId: string | null) {
    editor.run(reparent(ids, parentId));
  },

  // -------------------------------------------------------------- parameters
  addStandard() { editor.run(addStandardParameters()); },
  openParamDialog(d: RigState['paramDialog']) { useRig.setState({ paramDialog: d }); },
  saveParam(prev: string | null, p: Parameter): string | null {
    try {
      const ok = prev ? editor.run(updateParameter(prev, p)) : editor.run(addParameter(p));
      void ok;
      const exists = editor.project.parameters.some((x) => x.id === p.id);
      if (!exists) return 'Could not save the parameter (see console).';
      useRig.setState({ paramDialog: null });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },
  deleteParam(id: string) { editor.run(deleteParameter(id)); },

  bind(paramId: string, count: 2 | 3) {
    const p = editor.project.parameters.find((x) => x.id === paramId);
    const ids = selectedObjectIds();
    if (!p || !ids.length) { log('warn', 'Select ArtMeshes or deformers to add keys to.'); return; }
    editor.run(bindParameter(ids, paramId, presetKeys(p, count)));
  },
  addBlendShape(paramId: string) {
    const p = editor.project.parameters.find((x) => x.id === paramId);
    const ids = selectedObjectIds();
    if (!p || !ids.length) { log('warn', 'Select ArtMeshes or deformers to add a blend shape to.'); return; }
    editor.run(addBlendShape(ids, paramId, presetKeys(p, 3)));
  },
  removeBlendShape(paramId: string) {
    editor.run(removeBlendShape(selectedObjectIds(), paramId));
  },
  /** 'all' | 'some' | 'none' of the selected objects have a blend shape on this parameter. */
  hasBlendShape(paramId: string): 'all' | 'some' | 'none' {
    const p = editor.project;
    const ids = selectedObjectIds();
    const n = ids.filter((id) => { const o = formOwner(p, id); const list = o ? (o.kind === 'mesh' ? o.mesh.blendShapes : o.deformer.blendShapes) : undefined; return !!list?.some((b) => b.parameterId === paramId); }).length;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  },
  blendKeysOf(paramId: string): number[] {
    const p = editor.project;
    const keys = new Set<number>();
    for (const id of selectedObjectIds()) {
      const o = formOwner(p, id);
      const list = o ? (o.kind === 'mesh' ? o.mesh.blendShapes : o.deformer.blendShapes) : undefined;
      list?.find((b) => b.parameterId === paramId)?.keys.forEach((k) => keys.add(k));
    }
    return [...keys].sort((a, b) => a - b);
  },
  unbind(paramId: string) {
    const p = editor.project.parameters.find((x) => x.id === paramId);
    if (!p) return;
    editor.run(unbindParameter(selectedObjectIds(), paramId, useEditor.getState().paramValues[paramId] ?? p.default));
  },
  addKeyHere(paramId: string) {
    const v = useEditor.getState().paramValues[paramId];
    if (v !== undefined) editor.run(insertKeyAt(selectedObjectIds(), paramId, Number(v.toFixed(4))));
  },
  removeKeyHere(paramId: string) {
    const v = useEditor.getState().paramValues[paramId];
    if (v !== undefined) editor.run(removeKeyAt(selectedObjectIds(), paramId, v));
  },
  /** Keys of `paramId` on the active (or first selected) object, for slider ticks. */
  keysOf(paramId: string): number[] {
    const p = editor.project;
    const keys = new Set<number>();
    for (const id of selectedObjectIds()) {
      const o = formOwner(p, id);
      const f = o && ownerForm(o);
      f?.bindings.find((b) => b.parameterId === paramId)?.keys.forEach((k) => keys.add(k));
    }
    return [...keys].sort((a, b) => a - b);
  },
  isBound(paramId: string): 'all' | 'some' | 'none' {
    const p = editor.project;
    const ids = selectedObjectIds();
    const n = ids.filter((id) => { const o = formOwner(p, id); return !!o && !!ownerForm(o)?.bindings.some((b) => b.parameterId === paramId); }).length;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  },
  /** Snap a parameter to the nearest key of the selection. */
  snap(paramId: string) {
    const keys = rigActions.keysOf(paramId);
    const v = useEditor.getState().paramValues[paramId];
    if (!keys.length || v === undefined) return;
    const k = keys.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    if (Math.abs(k - v) > KEY_EPSILON) editor.setParam(paramId, k);
  },

  // -------------------------------------------------------------- keyform clipboard / symmetry
  copyKeyform() {
    const id = activeObjectId();
    const ks = keyStateOf(id);
    if (!id || !ks.form || ks.index < 0) { log('warn', 'Put the parameters on a key of the active object to copy its keyform.'); return; }
    const o = formOwner(editor.project, id)!;
    const kf = ks.form.keyforms[ks.index];
    const len = o.kind === 'mesh' ? o.mesh.vertices.length : o.kind === 'warp' ? o.deformer.form.keyforms[0]!.points.length : 0;
    useRig.setState({ clipboard: { kind: o.kind, length: len, keyform: structuredClone(kf) } });
    log('info', 'Keyform copied.');
  },
  pasteKeyform() {
    const id = activeObjectId();
    const ks = keyStateOf(id);
    const clip = useRig.getState().clipboard;
    if (!id || !clip || ks.index < 0) return;
    editor.run(pasteKeyform(id, ks.index, clip.keyform));
  },
  mirrorKeyform(paramId?: string) {
    const id = activeObjectId();
    const ks = keyStateOf(id);
    if (!id || !ks.form || ks.index < 0) { log('warn', 'Put the parameters on a key of the active object first.'); return; }
    const pid = paramId ?? ks.form.bindings[0]?.parameterId;
    if (!pid) { log('warn', 'The active object has no parameter keys.'); return; }
    editor.run(mirrorKeyform(id, ks.index, pid));
  },
};

export function deformerChildren(parentId: string | null): { meshes: NodeId[]; deformers: string[] } {
  const p = editor.project;
  return {
    deformers: Object.values(p.deformers).filter((d) => d.parentId === parentId).map((d) => d.id),
    meshes: Object.values(p.meshes).filter((m) => (m.parentId ?? null) === parentId).map((m) => m.layerId),
  };
}

if (import.meta.env.DEV) {
  const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
  if (g.__l2s) Object.assign(g.__l2s, { useRig, rigActions });
}

if (import.meta.env.DEV) {
  void import('@l2s/deformer-engine').then((m) => {
    const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
    if (g.__l2s) g.__l2s.deformerEngine = m;
  });
}
