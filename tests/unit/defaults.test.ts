import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CommandHistory, type LayerNode, type Project } from '@l2s/editor-core';
import { importPsd } from '@l2s/psd-importer';
import { AUTO_MESH_PRESETS, generateAutoMesh } from '@l2s/mesh-engine';
import { evaluateModel, importParameterList } from '@l2s/deformer-engine';
import { DEFAULT_PARAMETERS, STANDARD_PARAMETER_GROUPS, parseParameterCsv, toParameterCsv } from '@l2s/parameter-engine';
import { checkIntegrity } from '@l2s/project-format';
import { applyRigProposal, buildRigProposal, recognizeParts } from '@l2s/ai-engine';

const CSV = readFileSync('samples/himikan-parameters.csv', 'utf8');

describe('parameter-list CSV (Cubism layout)', () => {
  it('parses groups, ranges, descriptions and label colours', () => {
    const l = parseParameterCsv(CSV);
    expect(l.warnings).toEqual([]);
    expect(l.groups.map((g) => g.name)).toEqual(['XYZ', '눈', '눈썹', '입', '몸', '물리']);
    expect(l.groups[0]!.color).toBe('RED:#903D34');
    expect(l.parameters).toHaveLength(19);
    const eye = l.parameters.find((p) => p.id === 'ParamEyeLOpen')!;
    expect(eye).toMatchObject({ name: '왼쪽 눈 깜빡임', min: 0, default: 1, max: 1, groupId: 'ParamGroup2', description: '+로 눈을 뜨기' });
    // Quoted field with a comma.
    expect(l.parameters.find((p) => p.id === 'ParamMouthForm')!.description).toBe('+로 웃는 입, -로 화가난 입');
    expect(l.parameters.find((p) => p.id === 'ParamBodyAngleX')).toMatchObject({ min: -10, max: 10 });
  });

  it('is the default parameter list and round-trips', () => {
    expect(DEFAULT_PARAMETERS.map((p) => p.id)).toEqual(parseParameterCsv(CSV).parameters.map((p) => p.id));
    expect(STANDARD_PARAMETER_GROUPS).toHaveLength(6);
    const back = parseParameterCsv(toParameterCsv({ parameters: [...DEFAULT_PARAMETERS], parameterGroups: [...STANDARD_PARAMETER_GROUPS] }));
    expect(back.parameters).toEqual(DEFAULT_PARAMETERS);
    expect(back.groups).toEqual(STANDARD_PARAMETER_GROUPS);
  });

  it('rejects files without parameter rows and skips invalid ranges', () => {
    expect(() => parseParameterCsv('a,b,c\n1,2,3\n')).toThrow(/PARAMETER/);
    const l = parseParameterCsv('GUID,Type,ID,Name,Group,Min,Default,Max,Repeat\n,PARAMETER,ParamX,X,,1,0,-1,false\n,PARAMETER,ParamY,Y,Nope,0,0,1,true\n');
    expect(l.parameters.map((p) => p.id)).toEqual(['ParamY']);
    expect(l.parameters[0]).toMatchObject({ repeat: true });
    expect(l.parameters[0]!.groupId).toBeUndefined();
    expect(l.warnings).toHaveLength(2);
  });
});

function loadHimikan() {
  const r = importPsd(readFileSync('samples/himikan.psd'), { fileName: 'himikan.psd', sourceAssetId: 's' });
  const alpha = new Map(r.assets.map((a) => [a.id, a.pixels]));
  const alphaOf = (l: LayerNode) => { const px = alpha.get(l.assets.display)!; const o = new Uint8Array(px.width * px.height); for (let i = 0; i < o.length; i++) o[i] = px.data[i * 4 + 3]!; return o; };
  const meshesFor = (ls: LayerNode[]) => ls.map((l) => generateAutoMesh({ layerId: l.id, alpha: alphaOf(l), bounds: l.bounds, settings: AUTO_MESH_PRESETS.standard, partCategory: l.partTag?.category }).mesh!).filter(Boolean);
  return { project: r.project, meshesFor, warnings: r.warnings };
}
const layer = (p: Project, name: string) => Object.values(p.nodes).find((n) => n.kind === 'layer' && n.name === name) as LayerNode;

describe('default character (Himikan PSD)', () => {
  it('imports cleanly with "<" / ">" pairs sided by position and guide layers untagged', () => {
    const { project, warnings } = loadHimikan();
    expect(warnings).toEqual([]);
    expect(project.canvas).toEqual({ width: 2000, height: 3000 });
    const l = layer(project, '눈흰자<'), r = layer(project, '눈흰자>');
    const left = l.bounds.x < r.bounds.x ? l : r, right = left === l ? r : l;
    expect(left.partTag?.category).toBe('Eye.White.Left');
    expect(right.partTag?.category).toBe('Eye.White.Right');
    expect(layer(project, '쌍커풀<').partTag?.category).toMatch(/^Eye\.Lid\.(Left|Right)$/);
    expect(layer(project, '눈썹>').partTag?.category).toMatch(/^Eyebrow\.(Left|Right)$/);
    for (const g of ['A', 'E', 'O', 'U', '웃음', '찡그림']) expect(layer(project, g).partTag).toBeUndefined();
    expect(recognizeParts(project).some((s) => ['A', 'E', 'O', 'U'].includes(s.layerName))).toBe(false);
  });

  it('auto rig: both eyes blink, guides and the chest bow stay out of the head', () => {
    const { project, meshesFor } = loadHimikan();
    const prop = buildRigProposal(project, meshesFor);
    const step = (id: string) => prop.steps.find((s) => s.id === id)!;
    const names = (id: string) => step(id).targets.map((t) => project.nodes[t]!.name);
    expect(names('eyes')).toEqual(expect.arrayContaining(['눈꺼풀<', '눈꺼풀>', '속눈썹1<', '속눈썹1>']));
    expect(names('mouth')).not.toContain('A');
    expect(names('headZ')).not.toContain('리본위');
    expect(names('hairPhysics')).toContain('더듬이');
    const h = new CommandHistory(project);
    h.execute(applyRigProposal(prop));
    expect(checkIntegrity(h.project)).toEqual([]);
    expect(h.project.parameters.map((p) => p.id)).toEqual(expect.arrayContaining(['ParamBreath', 'ParamBrowLY', 'ParamHairFront']));
    expect(h.project.parameters.find((p) => p.id === 'ParamHairFront')!.groupId).toBe('ParamGroup6');
    const m = evaluateModel(h.project, { ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamAngleX: 30 });
    for (const v of m.meshes.values()) for (const x of v.positions) expect(Number.isFinite(x)).toBe(true);
  });

  it('importParameterList updates existing parameters without dropping others', () => {
    const { project } = loadHimikan();
    project.parameters = [{ id: 'ParamAngleX', name: 'old', min: -10, max: 10, default: 0 }, { id: 'ParamCustom', name: 'c', min: 0, max: 1, default: 0 }];
    const h = new CommandHistory(project);
    const l = parseParameterCsv(CSV);
    h.execute(importParameterList(l.groups, l.parameters));
    expect(h.project.parameters.find((p) => p.id === 'ParamAngleX')).toMatchObject({ name: '각도 X', min: -30, max: 30, groupId: 'ParamGroup' });
    expect(h.project.parameters.some((p) => p.id === 'ParamCustom')).toBe(true);
    expect(h.project.parameters).toHaveLength(20);
  });
});
