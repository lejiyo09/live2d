import { describe, expect, it } from 'vitest';
import { STANDARD_PARAMETERS } from '@l2s/parameter-engine';
import { checkIntegrity, readPackage, writePackage, migrateProject, ProjectVersionError } from '@l2s/project-format';
import { importPsd, encodePng } from '@l2s/psd-importer';
import { referencedAssetIds } from '@l2s/editor-core';
import { buildPsd, layer } from '../helpers.ts';

describe('.l2studio package', () => {
  it('round-trips a PSD-imported project', async () => {
    const psdBytes = buildPsd({ width: 32, height: 32, children: [layer('a', 0, 0, 8, 8, [1, 2, 3, 255]), layer('b', 4, 4, 8, 8, [9, 9, 9, 128], { clipping: true })] });
    const { project, assets } = importPsd(psdBytes, { fileName: 'x.psd', sourceAssetId: 'src_psd' });
    const stored = [
      { id: 'src_psd', kind: 'source-psd' as const, mime: 'image/vnd.adobe.photoshop', blob: new Blob([psdBytes as Uint8Array<ArrayBuffer>]) },
      ...assets.map((a) => ({ id: a.id, kind: a.kind, mime: 'image/png', width: a.pixels.width, height: a.pixels.height, blob: new Blob([encodePng(a.pixels.width, a.pixels.height, a.pixels.data) as Uint8Array<ArrayBuffer>]) })),
    ];
    const zip = await writePackage(project, stored);
    const back = await readPackage(zip);
    expect(back.project).toEqual(project);
    expect(back.assets.map((a) => a.id).sort()).toEqual(stored.map((a) => a.id).sort());
    const psdBack = new Uint8Array(await back.assets.find((a) => a.id === 'src_psd')!.blob.arrayBuffer());
    expect(psdBack).toEqual(psdBytes);
    expect(checkIntegrity(back.project, new Set(back.assets.map((a) => a.id)))).toEqual([]);
    expect([...referencedAssetIds(project)].every((id) => stored.some((s) => s.id === id))).toBe(true);
  });

  it('detects integrity problems', () => {
    const { project } = importPsd(buildPsd({ width: 8, height: 8, children: [layer('a', 0, 0, 2, 2, [1, 1, 1, 255])] }), { fileName: 'y.psd', sourceAssetId: 's' });
    project.rootIds.push('ghost');
    const issues = checkIntegrity(project, new Set());
    expect(issues.some((i) => i.message.includes('Missing node'))).toBe(true);
    expect(issues.some((i) => i.message.includes('Missing asset'))).toBe(true);
  });

  it('refuses documents from newer format versions', () => {
    expect(() => migrateProject({ formatVersion: 999 })).toThrow(ProjectVersionError);
  });
});

describe('format v2 meshes', () => {
  it('stores meshes in meshes/meshes.json and migrates v1 documents', async () => {
    const { importPsd: imp } = await import('@l2s/psd-importer');
    const { rectMesh } = await import('@l2s/mesh-engine');
    const { project } = imp(buildPsd({ width: 16, height: 16, children: [layer('a', 0, 0, 8, 8, [1, 1, 1, 255])] }), { fileName: 'm.psd', sourceAssetId: 's' });
    const id = project.rootIds[0]!;
    project.meshes[id] = rectMesh(project.nodes[id] as never, 2);
    const zip = await writePackage(project, []);
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(zip);
    expect(JSON.parse(strFromU8(files['project.json']!)).meshes).toBeUndefined();
    expect(JSON.parse(strFromU8(files['meshes/meshes.json']!)).meshes).toHaveLength(1);
    const back = await readPackage(zip);
    expect(back.project.meshes[id]).toEqual(project.meshes[id]);
    const v1 = { ...project, formatVersion: 1 } as Record<string, unknown>;
    delete v1.meshes;
    expect(migrateProject(v1).meshes).toEqual({});
  });
});

describe('format v3 deformers and parameters', () => {
  it('round-trips deformers/parameters in their own sections and migrates v2', async () => {
    const { importPsd: imp } = await import('@l2s/psd-importer');
    const { rectMesh } = await import('@l2s/mesh-engine');
    const { createWarpDeformer, bindParameter, addStandardParameters } = await import('@l2s/deformer-engine');
    const { CommandHistory } = await import('@l2s/editor-core');
    const { project } = imp(buildPsd({ width: 16, height: 16, children: [layer('a', 0, 0, 8, 8, [1, 1, 1, 255])] }), { fileName: 'm.psd', sourceAssetId: 's' });
    const id = project.rootIds[0]!;
    project.meshes[id] = rectMesh(project.nodes[id] as never, 2);
    const h = new CommandHistory(project);
    h.execute(addStandardParameters());
    const w = createWarpDeformer([id]);
    h.execute(w.command);
    h.execute(bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]));
    const zip = await writePackage(h.project, []);
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(zip);
    expect(JSON.parse(strFromU8(files['deformers/deformers.json']!)).deformers).toHaveLength(1);
    expect(JSON.parse(strFromU8(files['parameters/parameters.json']!)).parameters).toHaveLength(STANDARD_PARAMETERS.length);
    const back = await readPackage(zip);
    expect(back.project).toEqual(h.project);
    expect(checkIntegrity(back.project)).toEqual([]);
    const v2 = { ...h.project, formatVersion: 2 } as Record<string, unknown>;
    delete v2.deformers; delete v2.parameters; delete v2.parameterGroups;
    const m = migrateProject(v2);
    expect(m.deformers).toEqual({});
    expect(m.parameters).toEqual([]);
  });
});
