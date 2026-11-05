import type { LayerNode, NodeId, Project } from '@l2s/editor-core';
import { defaultValues, type ParameterValues } from '@l2s/parameter-engine';
import { deformerOrder, evaluateModel } from '@l2s/deformer-engine';
import { checkMeshQuality } from '@l2s/mesh-engine';
import { rigGroups } from './autorig.ts';

/**
 * Rig quality analyzer (spec §10.6). Findings are split into errors (broken
 * or visibly wrong) and suggestions (improvements). Everything is rule based
 * and deterministic; deformation problems are found by evaluating the model
 * at each parameter's extreme keys.
 */
export type FindingKind =
  | 'mesh'
  | 'deformation-fold'
  | 'deformation-stretch'
  | 'missing-binding'
  | 'unused-parameter'
  | 'deformer-structure'
  | 'symmetry'
  | 'missing-mesh';

export interface Finding {
  severity: 'error' | 'suggestion';
  kind: FindingKind;
  /** Object the finding is about (layer id or deformer id). */
  target?: string;
  targetName?: string;
  message: string;
  /** Parameter values reproducing the problem. */
  at?: ParameterValues;
}

export interface AnalyzeOptions {
  alpha?: (layer: LayerNode) => Uint8Array | undefined;
  /** Triangle area ratio (deformed / rest) beyond which a stretch is reported. */
  maxStretch?: number;
}

function triAreas(pos: ArrayLike<number>, tris: number[]): Float64Array {
  const out = new Float64Array(tris.length / 3);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]! * 2, b = tris[i + 1]! * 2, c = tris[i + 2]! * 2;
    out[i / 3] = ((pos[b]! - pos[a]!) * (pos[c + 1]! - pos[a + 1]!) - (pos[b + 1]! - pos[a + 1]!) * (pos[c]! - pos[a]!)) / 2;
  }
  return out;
}

export function analyzeRig(project: Project, opts: AnalyzeOptions = {}): Finding[] {
  const out: Finding[] = [];
  const name = (id: string) => project.nodes[id]?.name ?? project.deformers[id]?.name ?? id;
  const layers = Object.values(project.nodes).filter((n): n is LayerNode => n.kind === 'layer');

  // 1. Mesh quality (rest pose).
  for (const [id, m] of Object.entries(project.meshes)) {
    const n = project.nodes[id];
    if (n?.kind !== 'layer') continue;
    for (const i of checkMeshQuality(m, n.bounds, { alpha: opts.alpha?.(n) })) {
      out.push({ severity: i.severity === 'error' ? 'error' : 'suggestion', kind: 'mesh', target: id, targetName: n.name, message: i.message });
    }
  }
  const unmeshed = layers.filter((l) => l.visible && l.partTag && !project.meshes[l.id]);
  for (const l of unmeshed) out.push({ severity: 'suggestion', kind: 'missing-mesh', target: l.id, targetName: l.name, message: `Tagged ${l.partTag!.category} but has no ArtMesh, so it cannot deform.` });

  // 2. Deformation at extreme keys: folds and extreme stretching.
  const maxStretch = opts.maxStretch ?? 4;
  const rest = evaluateModel(project, defaultValues(project));
  const restAreas = new Map<NodeId, Float64Array>();
  for (const [id, m] of Object.entries(project.meshes)) {
    const p = rest.meshes.get(id);
    if (p) restAreas.set(id, triAreas(p.positions, m.triangles));
  }
  const reported = new Set<string>();
  const used = new Set<string>();
  for (const prm of project.parameters) {
    const keys = new Set<number>();
    for (const f of [...Object.values(project.meshes).map((m) => m.form), ...Object.values(project.deformers).map((x) => x.form)]) {
      const b = f?.bindings.find((x) => x.parameterId === prm.id);
      if (b) { used.add(prm.id); b.keys.forEach((k) => keys.add(k)); }
    }
    for (const v of [prm.min, prm.max]) {
      if (!used.has(prm.id)) continue;
      const at = { ...defaultValues(project), [prm.id]: v };
      const model = evaluateModel(project, at);
      for (const [id, m] of Object.entries(project.meshes)) {
        const p = model.meshes.get(id), ra = restAreas.get(id);
        if (!p || !ra || !project.nodes[id]?.visible) continue;
        const areas = triAreas(p.positions, m.triangles);
        let flips = 0, stretch = 0;
        for (let t = 0; t < areas.length; t++) {
          if (Math.abs(ra[t]!) < 1) continue;
          if (Math.sign(areas[t]!) !== Math.sign(ra[t]!) && Math.abs(areas[t]!) > 1) flips++;
          else if (Math.abs(areas[t]! / ra[t]!) > maxStretch) stretch++;
        }
        const key = `${id}:${prm.id}`;
        if (flips && !reported.has(key + 'f')) {
          reported.add(key + 'f');
          out.push({ severity: 'error', kind: 'deformation-fold', target: id, targetName: name(id), at: { [prm.id]: v }, message: `${flips} triangle(s) fold over at ${prm.id} = ${v} (image will tear or overlap).` });
        }
        if (stretch && !reported.has(key + 's')) {
          reported.add(key + 's');
          out.push({ severity: 'suggestion', kind: 'deformation-stretch', target: id, targetName: name(id), at: { [prm.id]: v }, message: `${stretch} triangle(s) stretch more than ${maxStretch}× at ${prm.id} = ${v} (texture will blur).` });
        }
      }
    }
  }

  // 3. Parameter usage and expected bindings for tagged parts.
  for (const prm of project.parameters) if (!used.has(prm.id)) out.push({ severity: 'suggestion', kind: 'unused-parameter', target: prm.id, targetName: prm.id, message: `Parameter ${prm.id} is not bound to anything.` });
  const g = rigGroups(project);
  const boundTo = (layerId: string, pid: string): boolean => {
    let cur: string | null | undefined = layerId;
    let first = true;
    while (cur) {
      const form = first ? project.meshes[cur]?.form : project.deformers[cur]?.form;
      if (form?.bindings.some((b) => b.parameterId === pid)) return true;
      cur = first ? project.meshes[cur]?.parentId : project.deformers[cur]?.parentId;
      first = false;
    }
    return false;
  };
  const expect = (parts: LayerNode[], pid: string, what: string) => {
    if (!project.parameters.some((p) => p.id === pid)) return;
    const missing = parts.filter((l) => project.meshes[l.id] && !boundTo(l.id, pid));
    if (missing.length && missing.length === parts.filter((l) => project.meshes[l.id]).length && parts.length) {
      out.push({ severity: 'suggestion', kind: 'missing-binding', message: `${what}: none of ${missing.map((l) => l.name).slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''} react to ${pid}.` });
    }
  };
  expect(g.eyeL, 'ParamEyeLOpen', 'Left eye');
  expect(g.eyeR, 'ParamEyeROpen', 'Right eye');
  expect(g.mouth, 'ParamMouthOpenY', 'Mouth');
  expect(g.face, 'ParamAngleX', 'Face');
  expect(g.head, 'ParamAngleZ', 'Head');

  // 4. Deformer structure.
  const { broken } = deformerOrder(project);
  for (const id of broken) out.push({ severity: 'error', kind: 'deformer-structure', target: id, targetName: name(id), message: 'Deformer is in a parent cycle or has a missing parent; it is ignored.' });
  for (const dd of Object.values(project.deformers)) {
    const kids = Object.values(project.meshes).filter((m) => m.parentId === dd.id).length + Object.values(project.deformers).filter((x) => x.parentId === dd.id).length;
    if (!kids) out.push({ severity: 'suggestion', kind: 'deformer-structure', target: dd.id, targetName: dd.name, message: 'Deformer has no children.' });
    if (!dd.form.bindings.length && kids) out.push({ severity: 'suggestion', kind: 'deformer-structure', target: dd.id, targetName: dd.name, message: 'Deformer has no parameter keys, so it never moves.' });
  }

  // 5. Symmetry: paired parts should be keyed alike.
  const byCat = new Map(layers.filter((l) => l.partTag).map((l) => [l.partTag!.category, l]));
  for (const [cat, left] of byCat) {
    if (!cat.endsWith('.Left')) continue;
    const right = byCat.get(cat.replace(/Left$/, 'Right'));
    if (!right) continue;
    const ml = project.meshes[left.id], mr = project.meshes[right.id];
    if (!!ml !== !!mr) { out.push({ severity: 'suggestion', kind: 'symmetry', target: ml ? right.id : left.id, targetName: (ml ? right : left).name, message: `${left.name} / ${right.name}: only one side has a mesh.` }); continue; }
    if (!ml || !mr) continue;
    const pl = new Set(project.parameters.filter((p) => boundTo(left.id, p.id)).map((p) => p.id.replace(/L(?=Open)|R(?=Open)/, '?')));
    const pr = new Set(project.parameters.filter((p) => boundTo(right.id, p.id)).map((p) => p.id.replace(/L(?=Open)|R(?=Open)/, '?')));
    const diff = [...pl].filter((x) => !pr.has(x)).concat([...pr].filter((x) => !pl.has(x)));
    if (diff.length) out.push({ severity: 'suggestion', kind: 'symmetry', target: right.id, targetName: `${left.name} / ${right.name}`, message: `Left/right parts react to different parameters (${diff.join(', ')}).` });
    const vl = ml.vertices.length / 2, vr = mr.vertices.length / 2;
    if (Math.max(vl, vr) > 1.6 * Math.min(vl, vr) && Math.max(vl, vr) > 20) out.push({ severity: 'suggestion', kind: 'symmetry', target: right.id, targetName: `${left.name} / ${right.name}`, message: `Mesh density differs a lot between sides (${vl} vs ${vr} vertices); consider Mirror Mesh.` });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
