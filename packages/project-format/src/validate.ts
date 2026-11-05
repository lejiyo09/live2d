import { referencedAssetIds, type Project } from '@l2s/editor-core';

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

/** Structural integrity check of a project document (spec §12.2). */
export function checkIntegrity(project: Project, availableAssets?: Set<string>): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const seen = new Map<string, number>();
  const visit = (ids: string[], parentId: string | null, path: Set<string>) => {
    for (const id of ids) {
      const n = project.nodes[id];
      if (!n) { issues.push({ severity: 'error', message: `Missing node ${id}`, nodeId: id }); continue; }
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (n.parentId !== parentId) issues.push({ severity: 'error', message: `Node ${n.name} has wrong parentId`, nodeId: id });
      if (path.has(id)) { issues.push({ severity: 'error', message: `Cycle at ${n.name}`, nodeId: id }); continue; }
      if (n.kind === 'group') visit(n.childIds, id, new Set([...path, id]));
      if (n.opacity < 0 || n.opacity > 1 || Number.isNaN(n.opacity)) issues.push({ severity: 'error', message: `Invalid opacity on ${n.name}`, nodeId: id });
    }
  };
  visit(project.rootIds, null, new Set());
  for (const [id, c] of seen) if (c > 1) issues.push({ severity: 'error', message: `Node ${id} is referenced ${c} times`, nodeId: id });
  for (const id of Object.keys(project.nodes)) if (!seen.has(id)) issues.push({ severity: 'warning', message: `Orphan node ${id}`, nodeId: id });
  for (const [layerId, m] of Object.entries(project.meshes ?? {})) {
    const owner = project.nodes[layerId];
    if (!owner || owner.kind !== 'layer' || m.layerId !== layerId) {
      issues.push({ severity: 'error', message: `Mesh ${layerId} has no owning layer`, nodeId: layerId });
      continue;
    }
    const n = m.vertices.length / 2;
    if (m.vertices.length % 2 || m.uvs.length !== m.vertices.length) issues.push({ severity: 'error', message: `Mesh of ${owner.name} has mismatched vertex/uv arrays`, nodeId: layerId });
    if (m.triangles.length % 3 || m.triangles.some((i) => i < 0 || i >= n || !Number.isInteger(i))) issues.push({ severity: 'error', message: `Mesh of ${owner.name} has invalid triangle indices`, nodeId: layerId });
    if (m.boundary.some((loop) => loop.some((i) => i < 0 || i >= n))) issues.push({ severity: 'error', message: `Mesh of ${owner.name} has invalid boundary indices`, nodeId: layerId });
  }
  // Parameters, deformers and keyform grids.
  const paramIds = new Set<string>();
  for (const prm of project.parameters ?? []) {
    if (paramIds.has(prm.id)) issues.push({ severity: 'error', message: `Duplicate parameter ID ${prm.id}` });
    paramIds.add(prm.id);
    if (!(prm.min < prm.max) || prm.default < prm.min || prm.default > prm.max) issues.push({ severity: 'error', message: `Parameter ${prm.id} has an invalid range` });
  }
  const checkGrid = (label: string, g: { bindings: { parameterId: string; keys: number[] }[]; keyforms: unknown[] }, check: (kf: unknown) => boolean) => {
    const size = g.bindings.reduce((n, b) => n * b.keys.length, 1);
    if (g.keyforms.length !== size) issues.push({ severity: 'error', message: `${label}: ${g.keyforms.length} keyforms, expected ${size}` });
    for (const b of g.bindings) {
      if (!paramIds.has(b.parameterId)) issues.push({ severity: 'error', message: `${label}: bound to unknown parameter ${b.parameterId}` });
      if (!b.keys.length || b.keys.some((k, i) => i > 0 && k <= b.keys[i - 1]!)) issues.push({ severity: 'error', message: `${label}: keys of ${b.parameterId} must be ascending and unique` });
    }
    if (!g.keyforms.every(check)) issues.push({ severity: 'error', message: `${label}: keyform data does not match its structure` });
  };
  const defs = project.deformers ?? {};
  for (const [id, d] of Object.entries(defs)) {
    if (d.id !== id) issues.push({ severity: 'error', message: `Deformer key mismatch ${id}` });
    if (d.parentId !== null && !defs[d.parentId]) issues.push({ severity: 'error', message: `Deformer ${d.name} has a missing parent` });
    const seen = new Set<string>();
    for (let cur: string | null = id; cur; cur = defs[cur]?.parentId ?? null) {
      if (seen.has(cur)) { issues.push({ severity: 'error', message: `Deformer ${d.name} is part of a parent cycle` }); break; }
      seen.add(cur);
    }
    if (d.kind === 'warp') checkGrid(`Warp ${d.name}`, d.form, (kf) => (kf as { points: number[] }).points?.length === (d.cols + 1) * (d.rows + 1) * 2);
    else checkGrid(`Rotation ${d.name}`, d.form, (kf) => ['x', 'y', 'angle', 'scale'].every((k) => Number.isFinite((kf as Record<string, number>)[k])));
  }
  const checkShapes = (label: string, shapes: Array<{ parameterId: string; keys: number[]; deltas: unknown[] }> | undefined) => {
    for (const bs of shapes ?? []) {
      if (!paramIds.has(bs.parameterId)) issues.push({ severity: 'error', message: `${label}: blend shape on unknown parameter ${bs.parameterId}` });
      if (bs.deltas.length !== bs.keys.length) issues.push({ severity: 'error', message: `${label}: blend shape ${bs.parameterId} has ${bs.deltas.length} deltas for ${bs.keys.length} keys` });
    }
  };
  for (const d of Object.values(defs)) checkShapes(`Deformer ${d.name}`, d.blendShapes as never);
  for (const [layerId, m] of Object.entries(project.meshes ?? {})) {
    checkShapes(`Mesh ${layerId}`, m.blendShapes as never);
    if (m.blendShapes?.some((bs) => bs.deltas.some((x) => x.positions.length !== m.vertices.length))) issues.push({ severity: 'error', message: `Mesh ${layerId}: blend shape delta size does not match vertices` });
    if (m.parentId && !defs[m.parentId]) issues.push({ severity: 'error', message: `Mesh ${layerId} has a missing parent deformer`, nodeId: layerId });
    if (m.parentId && !m.form) issues.push({ severity: 'error', message: `Mesh ${layerId} has a parent but no keyforms`, nodeId: layerId });
    if (m.form) checkGrid(`Mesh ${project.nodes[layerId]?.name ?? layerId}`, m.form, (kf) => (kf as { positions: number[] }).positions?.length === m.vertices.length);
  }
  for (const st of project.physics?.settings ?? []) {
    if (st.particles.length < 2) issues.push({ severity: 'error', message: `Physics ${st.name}: needs at least 2 particles` });
    for (const i of st.inputs) if (!paramIds.has(i.parameterId)) issues.push({ severity: 'error', message: `Physics ${st.name}: unknown input parameter ${i.parameterId}` });
    for (const o of st.outputs) {
      if (!paramIds.has(o.parameterId)) issues.push({ severity: 'error', message: `Physics ${st.name}: unknown output parameter ${o.parameterId}` });
      if (o.vertexIndex < 1 || o.vertexIndex >= st.particles.length) issues.push({ severity: 'error', message: `Physics ${st.name}: output vertex index ${o.vertexIndex} out of range` });
    }
  }
  for (const ex of project.expressions ?? []) {
    for (const ep of ex.parameters) if (!paramIds.has(ep.parameterId)) issues.push({ severity: 'warning', message: `Expression ${ex.name}: unknown parameter ${ep.parameterId}` });
  }
  const clipIds = new Set((project.animations ?? []).map((c) => c.id));
  for (const sc of project.scenes ?? []) for (const e of sc.entries) if (!clipIds.has(e.clipId)) issues.push({ severity: 'warning', message: `Scene ${sc.name}: entry refers to a deleted animation` });
  const groupIds = new Set((project.parameterGroups ?? []).map((g) => g.id));
  for (const prm of project.parameters ?? []) if (prm.groupId && !groupIds.has(prm.groupId)) issues.push({ severity: 'warning', message: `Parameter ${prm.id}: unknown group ${prm.groupId}` });
  for (const c of project.animations ?? []) {
    for (const tr of c.tracks) {
      if (!paramIds.has(tr.parameterId)) issues.push({ severity: 'warning', message: `Animation ${c.name}: track for unknown parameter ${tr.parameterId}` });
      if (tr.keyframes.some((k, i) => i > 0 && k.t <= tr.keyframes[i - 1]!.t)) issues.push({ severity: 'error', message: `Animation ${c.name}: keyframes of ${tr.parameterId} are not in time order` });
    }
  }
  if (availableAssets) {
    for (const a of referencedAssetIds(project)) if (!availableAssets.has(a)) issues.push({ severity: 'error', message: `Missing asset ${a}` });
  }
  return issues;
}
