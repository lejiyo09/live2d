import { strToU8, strFromU8, unzip, zip, type Unzipped, type Zippable } from 'fflate';
import { PROJECT_FORMAT_VERSION, type AssetKind, type Project } from '@l2s/editor-core';
import { migrateProject } from './migrate.ts';
import type { StoredAsset } from './store.ts';

/**
 * `.l2studio` package (spec §12.1): a ZIP with the JSON document split by
 * concern and image binaries stored separately.
 *
 * Phase 1 writes `project.json` (scene graph) plus asset folders; the meshes /
 * deformers / parameters / physics / animations / ai files are written as
 * empty documents so the layout is stable for later phases.
 */
export const PACKAGE_EXTENSION = '.l2studio';
export const PACKAGE_MIME = 'application/vnd.l2studio+zip';

export interface Manifest {
  format: 'l2studio';
  formatVersion: number;
  generator: string;
  projectId: string;
  name: string;
  createdAt: string;
  savedAt: string;
  assets: Array<{ id: string; kind: AssetKind; mime: string; path: string; width?: number; height?: number; byteLength: number }>;
}

const FOLDER: Record<AssetKind, string> = {
  'source-psd': 'assets/original',
  'layer-original': 'assets/original',
  'layer-mask': 'assets/extracted',
  'layer-display': 'assets/extracted',
  thumbnail: 'preview',
};

const EXT: Record<string, string> = { 'image/png': 'png', 'image/vnd.adobe.photoshop': 'psd', 'application/octet-stream': 'bin' };

const EMPTY_SECTIONS: Record<string, unknown> = {
  'ai/suggestions.json': { version: 1, suggestions: [] },
};

export async function writePackage(project: Project, assets: StoredAsset[], opts: { thumbnail?: Blob; generator?: string } = {}): Promise<Uint8Array> {
  const files: Zippable = {};
  const manifest: Manifest = {
    format: 'l2studio',
    formatVersion: PROJECT_FORMAT_VERSION,
    generator: opts.generator ?? 'Live2D Studio',
    projectId: project.id,
    name: project.name,
    createdAt: project.createdAt,
    savedAt: new Date().toISOString(),
    assets: [],
  };
  for (const a of assets) {
    const path = `${FOLDER[a.kind]}/${a.id}.${EXT[a.mime] ?? 'bin'}`;
    const bytes = new Uint8Array(await a.blob.arrayBuffer());
    // PNG / PSD data is already compressed.
    files[path] = [bytes, { level: a.mime === 'image/png' ? 0 : 6 }];
    manifest.assets.push({ id: a.id, kind: a.kind, mime: a.mime, path, width: a.width, height: a.height, byteLength: bytes.byteLength });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  // Meshes are stored in their own section (spec §12.1); project.json keeps the scene graph.
  const { meshes, deformers, parameters, parameterGroups, physics, animations, expressions, ...sceneGraph } = project;
  files['parameters/expressions.json'] = strToU8(JSON.stringify({ version: 1, expressions: expressions ?? [] }));
  files['physics/physics.json'] = strToU8(JSON.stringify({ version: 1, ...physics }));
  files['animations/animations.json'] = strToU8(JSON.stringify({ version: 1, clips: animations ?? [] }));
  files['project.json'] = strToU8(JSON.stringify(sceneGraph));
  files['meshes/meshes.json'] = strToU8(JSON.stringify({ version: 1, meshes: Object.values(meshes ?? {}) }));
  files['deformers/deformers.json'] = strToU8(JSON.stringify({ version: 1, deformers: Object.values(deformers ?? {}) }));
  files['parameters/parameters.json'] = strToU8(JSON.stringify({ version: 1, parameters: parameters ?? [], groups: parameterGroups ?? [] }));
  for (const [p, v] of Object.entries(EMPTY_SECTIONS)) files[p] = strToU8(JSON.stringify(v, null, 2));
  if (opts.thumbnail) files['preview/thumbnail.png'] = [new Uint8Array(await opts.thumbnail.arrayBuffer()), { level: 0 }];
  return new Promise((res, rej) => zip(files, { level: 6 }, (err, data) => (err ? rej(err) : res(data))));
}

export class PackageError extends Error {}

export async function readPackage(bytes: Uint8Array): Promise<{ project: Project; assets: StoredAsset[]; manifest: Manifest }> {
  const files = await new Promise<Unzipped>((res, rej) => unzip(bytes, (err, data) => (err ? rej(new PackageError(`Not a valid ${PACKAGE_EXTENSION} file: ${err.message}`)) : res(data))));
  const m = files['manifest.json'];
  const p = files['project.json'];
  if (!m || !p) throw new PackageError('Package is missing manifest.json or project.json');
  const manifest = JSON.parse(strFromU8(m)) as Manifest;
  if (manifest.format !== 'l2studio') throw new PackageError('Unknown package format');
  const doc = JSON.parse(strFromU8(p)) as Record<string, unknown>;
  const meshFile = files['meshes/meshes.json'];
  if (meshFile) {
    const list = (JSON.parse(strFromU8(meshFile)) as { meshes?: Array<{ layerId: string }> }).meshes ?? [];
    doc.meshes = Object.fromEntries(list.map((m) => [m.layerId, m]));
  }
  const defFile = files['deformers/deformers.json'];
  if (defFile) {
    const list = (JSON.parse(strFromU8(defFile)) as { deformers?: Array<{ id: string }> }).deformers ?? [];
    doc.deformers = Object.fromEntries(list.map((d) => [d.id, d]));
  }
  const parFile = files['parameters/parameters.json'];
  if (parFile) {
    const pj = JSON.parse(strFromU8(parFile)) as { parameters?: unknown[]; groups?: unknown[] };
    doc.parameters = pj.parameters ?? [];
    doc.parameterGroups = pj.groups ?? [];
  }
  const phyFile = files['physics/physics.json'];
  if (phyFile) {
    const { version: _v, ...rig } = JSON.parse(strFromU8(phyFile)) as Record<string, unknown>;
    if (Array.isArray(rig.settings)) doc.physics = rig;
  }
  const exFile = files['parameters/expressions.json'];
  if (exFile) doc.expressions = (JSON.parse(strFromU8(exFile)) as { expressions?: unknown[] }).expressions ?? [];
  const animFile = files['animations/animations.json'];
  if (animFile) doc.animations = (JSON.parse(strFromU8(animFile)) as { clips?: unknown[] }).clips ?? [];
  const project = migrateProject(doc);
  const assets: StoredAsset[] = [];
  for (const a of manifest.assets) {
    const data = files[a.path];
    if (!data) throw new PackageError(`Missing asset file ${a.path}`);
    if (data.byteLength !== a.byteLength) throw new PackageError(`Corrupt asset file ${a.path}`);
    assets.push({ id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: a.mime }) });
  }
  return { project, assets, manifest };
}
