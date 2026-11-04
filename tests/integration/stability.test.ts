import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  CommandHistory, deleteNodes, groupNodes, moveNode, setNodeProps, translateNodes, ungroup, setClipMask, type Command, type LayerNode, type Project,
} from '@l2s/editor-core';
import { importPsd } from '@l2s/psd-importer';
import { AUTO_MESH_PRESETS, generateAutoMesh, setMeshes, moveVertices, addVertex, deleteVertices, connectVertices, removeEdge, deleteTriangles, moveUVs } from '@l2s/mesh-engine';
import {
  addStandardParameters, bindParameter, createRotationDeformer, createWarpDeformer, deleteDeformers, evaluateModel, insertKeyAt, removeKeyAt, reparent,
  setWarpKeyform, addBlendShape, setBlendShapeDelta, setRotationPivot,
} from '@l2s/deformer-engine';
import { addPhysicsSetting, newPhysicsSetting } from '@l2s/physics-engine';
import { addClip, newClip, setKey, moveKeys, setInterpolation } from '@l2s/animation-engine';
import { checkIntegrity } from '@l2s/project-format';

/** JSON with object keys sorted (key insertion order is not part of the document; array order is). */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function load() {
  if (!existsSync('samples/sample-character.psd')) execSync('node scripts/make-sample-psd.mjs');
  const r = importPsd(readFileSync('samples/sample-character.psd'), { fileName: 's.psd', sourceAssetId: 's' });
  const px = new Map(r.assets.map((a) => [a.id, a.pixels]));
  const alpha = (l: LayerNode) => { const p = px.get(l.assets.display)!; const a = new Uint8Array(p.width * p.height); for (let i = 0; i < a.length; i++) a[i] = p.data[i * 4 + 3]!; return a; };
  return { project: r.project, alpha };
}

describe('stability: random editing sessions', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: 300 random operations keep the project valid and fully undoable`, () => {
      const { project, alpha } = load();
      const h = new CommandHistory(project, { mergeWindowMs: -1 });
      const initial = canon(h.project);
      const R = rng(seed);
      const pick = <T,>(a: T[]): T | undefined => a[Math.floor(R() * a.length)];
      const layers = () => Object.values(h.project.nodes).filter((n): n is LayerNode => n.kind === 'layer');
      const meshed = () => Object.keys(h.project.meshes);
      const defs = () => Object.keys(h.project.deformers);
      const params = () => h.project.parameters.map((p) => p.id);
      h.execute(addStandardParameters());
      const ops: Array<() => Command | null> = [
        () => { const n = pick(Object.values(h.project.nodes)); return n ? setNodeProps([n.id], { visible: R() > 0.3, opacity: R() }) : null; },
        () => { const a = pick(Object.keys(h.project.nodes)), b = pick(Object.values(h.project.nodes).filter((n) => n.kind === 'group')); return a ? moveNode(a, R() > 0.5 && b ? b.id : null, Math.floor(R() * 5)) : null; },
        () => { const ids = layers().filter(() => R() > 0.85).map((l) => l.id); return ids.length ? groupNodes(ids).command : null; },
        () => { const g = pick(Object.values(h.project.nodes).filter((n) => n.kind === 'group')); return g ? ungroup(g.id) : null; },
        () => { const l = pick(layers()); return l ? translateNodes([l.id], Math.round(R() * 10 - 5), Math.round(R() * 10 - 5)) : null; },
        () => { const ls = layers().filter((l) => !h.project.meshes[l.id]).slice(0, 3); return ls.length ? setMeshes(ls.map((l) => generateAutoMesh({ layerId: l.id, alpha: alpha(l), bounds: l.bounds, settings: AUTO_MESH_PRESETS.coarse }).mesh!).filter(Boolean)) : null; },
        () => { const id = pick(meshed()); if (!id) return null; const n = h.project.meshes[id]!.vertices.length / 2; return moveVertices(id, [Math.floor(R() * n)], R() * 6 - 3, R() * 6 - 3); },
        () => { const id = pick(meshed()); const l = id && (h.project.nodes[id] as LayerNode); return l ? addVertex(id, l.bounds.x + R() * l.bounds.width, l.bounds.y + R() * l.bounds.height) : null; },
        () => { const id = pick(meshed()); if (!id) return null; const n = h.project.meshes[id]!.vertices.length / 2; return n > 8 ? deleteVertices(id, [Math.floor(R() * n)]) : null; },
        () => { const id = pick(meshed()); if (!id) return null; const n = h.project.meshes[id]!.vertices.length / 2; return connectVertices(id, Math.floor(R() * n), Math.floor(R() * n)); },
        () => { const id = pick(meshed()); if (!id) return null; const t = h.project.meshes[id]!.triangles; const i = Math.floor(R() * (t.length / 3)) * 3; return t.length ? removeEdge(id, t[i]!, t[i + 1]!) : null; },
        () => { const id = pick(meshed()); if (!id) return null; const t = h.project.meshes[id]!.triangles; return t.length > 30 ? deleteTriangles(id, t.slice(0, 3)) : null; },
        () => { const id = pick(meshed()); return id ? moveUVs(id, [0], R() * 4 - 2, R() * 4 - 2) : null; },
        () => { const ids = meshed().filter(() => R() > 0.7); return ids.length ? createWarpDeformer(ids, { cols: 2 + Math.floor(R() * 3), rows: 2 }).command : null; },
        () => { const ids = [...meshed(), ...defs()].filter(() => R() > 0.8); return ids.length ? createRotationDeformer(ids).command : null; },
        () => { const a = pick([...meshed(), ...defs()]), b = pick(defs()); return a ? reparent([a], R() > 0.3 ? b ?? null : null) : null; },
        () => { const d = pick(defs()), p = pick(params()); return d && p ? bindParameter([d], p, [-30, 0, 30].map((x) => x * (p.includes('Angle') ? 1 : 1 / 30))) : null; },
        () => { const d = pick([...defs(), ...meshed()]), p = pick(params()); return d && p ? insertKeyAt([d], p, R() * 0.5) : null; },
        () => { const d = pick([...defs(), ...meshed()]), p = pick(params()); return d && p ? removeKeyAt([d], p, 0) : null; },
        () => { const d = pick(defs().filter((x) => h.project.deformers[x]!.kind === 'warp')); if (!d) return null; const w = h.project.deformers[d]!; const i = Math.floor(R() * w.form.keyforms.length); return setWarpKeyform(d, i, { points: (w.form.keyforms[i] as { points: number[] }).points.map((v) => v + (R() - 0.5) * 0.02) }); },
        () => { const d = pick([...defs(), ...meshed()]), p = pick(params()); return d && p ? addBlendShape([d], p, [-1, 0, 1]) : null; },
        () => { const id = pick(meshed()); const bs = id && h.project.meshes[id]!.blendShapes?.[0]; return bs ? setBlendShapeDelta(id, bs.parameterId, 0, { ...bs.deltas[0]!, positions: bs.deltas[0]!.positions.map(() => R() - 0.5) }) : null; },
        () => { const d = pick(defs().filter((x) => h.project.deformers[x]!.kind === 'rotation')); return d ? setRotationPivot(d, R() * 800, R() * 1000) : null; },
        () => { const ls = layers(); const a = pick(ls), b = pick(ls); return a && b ? setClipMask([a.id], R() > 0.2 ? { ids: [b.id], inverted: R() > 0.5 } : null) : null; },
        () => (R() > 0.8 ? addPhysicsSetting(newPhysicsSetting(`p${Math.floor(R() * 1e6)}`, 'P', pick(params())!)) : null),
        () => { if (!h.project.animations.length) return addClip(newClip('m')); const c = h.project.animations[0]!; return setKey(c.id, pick(params())!, R() * c.duration, R() * 10 - 5); },
        () => { const c = h.project.animations[0]; const tr = c && pick(c.tracks); const k = tr && pick(tr.keyframes); return k ? moveKeys(c!.id, [{ parameterId: tr!.parameterId, t: k.t }], R() - 0.5, R() - 0.5) : null; },
        () => { const c = h.project.animations[0]; const tr = c && pick(c.tracks); const k = tr && pick(tr.keyframes); return k ? setInterpolation(c!.id, [{ parameterId: tr!.parameterId, t: k.t }], pick(['linear', 'easeInOut', 'step', 'bezier'] as const)!) : null; },
        () => { const d = pick(defs()); return d && R() > 0.6 ? deleteDeformers([d]) : null; },
        () => { const l = pick(layers()); return l && R() > 0.85 ? deleteNodes([l.id]) : null; },
      ];
      let applied = 0, rejected = 0;
      for (let step = 0; step < 300; step++) {
        const cmd = pick(ops)!();
        if (!cmd) continue;
        const before = canon(h.project);
        let changed = false;
        try { changed = h.execute(cmd); } catch { rejected++; expect(canon(h.project), `rejected ${cmd.label} left changes`).toBe(before); continue; }
        if (changed) {
          applied++;
          // Every step must be exactly reversible.
          const after = canon(h.project);
          h.undo();
          expect(canon(h.project), `undo of step ${step} (${cmd.label})`).toBe(before);
          h.redo();
          expect(canon(h.project), `redo of step ${step} (${cmd.label})`).toBe(after);
        }
        const issues = checkIntegrity(h.project).filter((i) => i.severity === 'error');
        expect(issues, `after step ${step} (${cmd.label})`).toEqual([]);
        const values = Object.fromEntries(h.project.parameters.map((p) => [p.id, p.min + R() * (p.max - p.min)]));
        const model = evaluateModel(h.project, values);
        for (const [, m] of model.meshes) expect(m.positions.every(Number.isFinite), `finite after ${cmd.label}`).toBe(true);
      }
      expect(applied).toBeGreaterThan(100);
      const final = canon(h.project);
      let undos = 0;
      while (h.undo()) undos++;
      expect(canon(h.project)).toBe(initial);
      for (let i = 0; i < undos; i++) h.redo();
      expect(canon(h.project)).toBe(final);
      void rejected;
    }, 60_000);
  }
});
