import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { CommandHistory, setNodeProps, type LayerNode } from '@l2s/editor-core';
import { importPsd } from '@l2s/psd-importer';
import { AUTO_MESH_PRESETS, generateAutoMesh } from '@l2s/mesh-engine';
import { evaluateModel } from '@l2s/deformer-engine';
import { checkIntegrity } from '@l2s/project-format';
import { analyzeRig, applyRigProposal, buildRigProposal, interpret, recognizeParts } from '@l2s/ai-engine';

function load() {
  if (!existsSync('samples/sample-character.psd')) execSync('node scripts/make-sample-psd.mjs');
  const r = importPsd(readFileSync('samples/sample-character.psd'), { fileName: 'sample.psd', sourceAssetId: 's' });
  const alpha = new Map(r.assets.map((a) => [a.id, a.pixels]));
  const alphaOf = (l: LayerNode) => {
    const px = alpha.get(l.assets.display)!;
    const out = new Uint8Array(px.width * px.height);
    for (let i = 0; i < out.length; i++) out[i] = px.data[i * 4 + 3]!;
    return out;
  };
  const meshesFor = (ls: LayerNode[]) => ls.map((l) => generateAutoMesh({ layerId: l.id, alpha: alphaOf(l), bounds: l.bounds, settings: AUTO_MESH_PRESETS.standard, partCategory: l.partTag?.category }).mesh!).filter(Boolean);
  return { project: r.project, alphaOf, meshesFor };
}

const byName = (p: { nodes: Record<string, { name: string; kind: string; id: string }> }, n: string) => Object.values(p.nodes).find((x) => x.name === n && x.kind === 'layer')!.id;

describe('part recognition', () => {
  it('uses folder names for side and geometry for unnamed layers', () => {
    const { project } = load();
    // Strip names/tags off the eye white to force geometric recognition.
    const white = byName(project, '흰자_좌');
    project.nodes[white]!.name = 'Layer 7';
    delete (project.nodes[white] as LayerNode).partTag;
    const sug = recognizeParts(project);
    const s = sug.find((x) => x.layerId === white)!;
    expect(s.suggested.category).toMatch(/^Eye\./);
    expect(s.reason).toMatch(/folder|small, paired/);
  });
  it('never overrides user tags', () => {
    const { project } = load();
    const face = byName(project, '얼굴');
    const h = new CommandHistory(project);
    h.execute(setNodeProps([face], { partTag: { category: 'Custom.Thing', confidence: 1, source: 'user' } }));
    expect(recognizeParts(h.project).some((s) => s.layerId === face)).toBe(false);
  });
});

describe('auto rig', () => {
  it('builds a working draft rig as one undo step', async () => {
    const { project, meshesFor, alphaOf } = load();
    const h = new CommandHistory(project);
    const proposal = buildRigProposal(h.project, meshesFor);
    expect(proposal.steps.filter((s) => s.enabled).map((s) => s.id)).toEqual(['meshes', 'parameters', 'headZ', 'faceXY', 'eyes', 'eyeballs', 'mouth', 'hairFront', 'hairBack', 'hairPhysics']);
    expect(proposal.pairs.length).toBeGreaterThanOrEqual(4);
    h.execute(applyRigProposal(proposal));
    expect(h.labels.undo).toEqual(['AI Auto Rig']);
    const p = h.project;
    const names = Object.values(p.deformers).map((d) => `${d.name}<${d.parentId ? p.deformers[d.parentId]!.name : 'root'}`).sort();
    expect(names).toEqual(['Eye L<Face XY', 'Eye R<Face XY', 'Face XY<Head Z', 'Hair Back Sway<Hair Back', 'Hair Back<Head Z', 'Hair Front Sway<Hair Front', 'Hair Front<Face XY', 'Head Z<root', 'Mouth<Face XY']);
    expect(p.physics.settings.map((x) => x.name)).toEqual(['Hair Front', 'Hair Back']);
    expect(checkIntegrity(p)).toEqual([]);

    // Default pose is unchanged by rigging.
    const before = evaluateModel({ ...p, deformers: {}, meshes: Object.fromEntries(Object.entries(p.meshes).map(([k, m]) => [k, { ...m, form: undefined, parentId: null }])) }, {});
    const rest = evaluateModel(p, {});
    for (const [id, m] of rest.meshes) Array.from(m.positions).forEach((v, i) => expect(v).toBeCloseTo(before.meshes.get(id)!.positions[i]!, 2));

    const span = (vals: Record<string, number>, id: string) => {
      const pos = evaluateModel(p, vals).meshes.get(id)!.positions;
      const ys = Array.from(pos).filter((_, i) => i % 2), xs = Array.from(pos).filter((_, i) => i % 2 === 0);
      return { h: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2 };
    };
    const eye = byName(p, '흰자_좌');
    expect(span({ ParamEyeLOpen: 0 }, eye).h).toBeLessThan(span({}, eye).h * 0.3);
    expect(span({ ParamEyeROpen: 0 }, eye).h).toBeCloseTo(span({}, eye).h, 3); // only the left eye
    const iris = byName(p, '홍채_좌');
    expect(span({ ParamEyeBallX: 1 }, iris).cx).toBeGreaterThan(span({}, iris).cx + 5);
    const mouthOpen = byName(p, '입_열림');
    expect(evaluateModel(p, { ParamMouthOpenY: 0 }).meshes.get(mouthOpen)!.opacity).toBe(0);
    expect(evaluateModel(p, { ParamMouthOpenY: 1 }).meshes.get(mouthOpen)!.opacity).toBe(1);
    const brow = byName(p, '눈썹_좌');
    expect(span({ ParamAngleX: 30 }, brow).cx).toBeGreaterThan(span({}, brow).cx + 10);

    // The analyzer finds no errors in the generated rig.
    const findings = analyzeRig(p, { alpha: alphaOf });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);

    // Physics drives the sway parameter after a head turn.
    const { PhysicsSimulator } = await import('@l2s/physics-engine');
    const sim = new PhysicsSimulator(p.physics, p.parameters);
    let peak = 0;
    for (let i = 0; i < 60; i++) peak = Math.max(peak, Math.abs(sim.evaluate({ ParamAngleX: 30 }, 1 / 60).ParamHairFront!));
    expect(peak).toBeGreaterThan(0.2);
    const tip = byName(p, '앞머리_좌');
    expect(span({ ParamHairFront: 1 }, tip).cx).toBeGreaterThan(span({}, tip).cx + 3);
    h.undo();
    expect(Object.keys(h.project.deformers)).toEqual([]);
    expect(Object.keys(h.project.meshes)).toEqual([]);
  });

  it('analyzer reports folds, unused parameters and missing bindings', () => {
    const { project, meshesFor } = load();
    const h = new CommandHistory(project);
    const proposal = buildRigProposal(h.project, meshesFor);
    proposal.steps.forEach((s) => { s.enabled = ['meshes', 'parameters', 'faceXY'].includes(s.id); });
    h.execute(applyRigProposal(proposal, { turn: 0.9 })); // absurd turn → folds
    const f = analyzeRig(h.project);
    expect(f.some((x) => x.kind === 'deformation-fold' || x.kind === 'deformation-stretch')).toBe(true);
    expect(f.some((x) => x.kind === 'unused-parameter' && x.target === 'ParamEyeLOpen')).toBe(true);
    expect(f.some((x) => x.kind === 'missing-binding' && /Left eye/.test(x.message))).toBe(true);
  });
});

describe('assistant', () => {
  it('maps the spec example request to front-hair parallax with prerequisites', () => {
    const { project, meshesFor } = load();
    const proposal = buildRigProposal(project, meshesFor);
    const plan = interpret('앞머리가 머리 회전에 맞춰 자연스럽게 움직이도록 해줘.', proposal, project);
    expect(plan.understood).toBe(true);
    expect(plan.steps).toEqual(expect.arrayContaining(['faceXY', 'hairFront', 'meshes', 'parameters']));
    expect(plan.steps).not.toContain('eyes');
    expect(interpret('눈 깜빡이게 해줘', proposal, project).steps).toContain('eyes');
    expect(interpret('asdf qwer', proposal, project).understood).toBe(false);
  });
});
