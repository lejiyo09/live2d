import type { CoreModel, CubismCore } from './core.ts';
import { formatCoreVersion } from './core.ts';

/** model3.json (Version 3) — the parts this preview uses. */
export interface Model3 {
  Version: number;
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Expressions?: Array<{ Name: string; File: string }>;
    Motions?: Record<string, Array<{ File: string; FadeInTime?: number; FadeOutTime?: number }>>;
    UserData?: string;
  };
  Groups?: Array<{ Target: string; Name: string; Ids: string[] }>;
  HitAreas?: Array<{ Id: string; Name: string }>;
}

/** Files of a model folder or zip, keyed by path relative to the model3.json. */
export type BundleFiles = Map<string, Blob>;

export interface BundleIssue { severity: 'error' | 'warning'; message: string }

export interface ModelBundle {
  model3Path: string;
  model3: Model3;
  files: BundleFiles;
  /** Resolve a FileReferences path relative to the model3.json. */
  resolve(path: string): Blob | undefined;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

/** Locate the model3.json in a set of files and check its references (spec §11.2 error validation). */
export async function openBundle(files: BundleFiles): Promise<{ bundle: ModelBundle | null; issues: BundleIssue[] }> {
  const issues: BundleIssue[] = [];
  const candidates = [...files.keys()].filter((k) => k.toLowerCase().endsWith('.model3.json'));
  if (!candidates.length) return { bundle: null, issues: [{ severity: 'error', message: 'No *.model3.json found.' }] };
  if (candidates.length > 1) issues.push({ severity: 'warning', message: `Several model3.json files; using ${candidates[0]}.` });
  const model3Path = candidates.sort((a, b) => a.split('/').length - b.split('/').length)[0]!;
  let model3: Model3;
  try {
    model3 = JSON.parse(await files.get(model3Path)!.text()) as Model3;
  } catch (e) {
    return { bundle: null, issues: [{ severity: 'error', message: `model3.json is not valid JSON: ${(e as Error).message}` }] };
  }
  if (model3.Version !== 3) issues.push({ severity: 'warning', message: `model3.json Version ${model3.Version} (expected 3).` });
  const dir = model3Path.includes('/') ? model3Path.slice(0, model3Path.lastIndexOf('/') + 1) : '';
  const lookup = new Map([...files.keys()].map((k) => [normalizePath(k).toLowerCase(), k]));
  const resolve = (p: string) => {
    const k = lookup.get(normalizePath(dir + p).toLowerCase());
    return k ? files.get(k) : undefined;
  };
  const refs = model3.FileReferences;
  if (!refs?.Moc) return { bundle: null, issues: [...issues, { severity: 'error', message: 'model3.json has no FileReferences.Moc.' }] };
  const need = (p: string | undefined, what: string, severity: 'error' | 'warning') => {
    if (p && !resolve(p)) issues.push({ severity, message: `${what} not found: ${p}` });
  };
  need(refs.Moc, 'Moc', 'error');
  (refs.Textures ?? []).forEach((t, i) => need(t, `Texture ${i}`, 'error'));
  need(refs.Physics, 'Physics', 'warning');
  need(refs.DisplayInfo, 'Display info', 'warning');
  for (const [g, list] of Object.entries(refs.Motions ?? {})) list.forEach((m) => need(m.File, `Motion (${g})`, 'warning'));
  if (issues.some((i) => i.severity === 'error')) return { bundle: null, issues };
  return { bundle: { model3Path, model3, files, resolve }, issues };
}

export interface LoadedModel {
  core: CubismCore;
  model: CoreModel;
  info: ModelInfo;
  release(): void;
}

export interface ModelInfo {
  coreVersion: string;
  mocVersion: number;
  latestMocVersion: number;
  canvas: { width: number; height: number; originX: number; originY: number; pixelsPerUnit: number };
  parameters: Array<{ id: string; min: number; max: number; default: number; repeat: boolean }>;
  parts: string[];
  drawables: number;
  textures: number;
  maskedDrawables: number;
}

export class MocError extends Error {}

/** Create a Core model from .moc3 bytes, with the same checks as the official framework. */
export function loadMoc(core: CubismCore, bytes: ArrayBuffer, textureCount: number): LoadedModel {
  const latest = core.Version.csmGetLatestMocVersion();
  const mocVersion = core.Version.csmGetMocVersion(bytes);
  if (mocVersion > latest) throw new MocError(`This .moc3 (version ${mocVersion}) is newer than the loaded Core supports (${latest}). Load a newer Cubism Core.`);
  const consistency = core.Moc.prototype.hasMocConsistency?.(bytes);
  if (consistency === 0) throw new MocError('The .moc3 failed the Core consistency check (corrupt or not a moc3).');
  const moc = core.Moc.fromArrayBuffer(bytes);
  if (!moc) throw new MocError('The Core could not read this .moc3.');
  const model = core.Model.fromMoc(moc);
  if (!model) { moc._release?.(); throw new MocError('The Core could not create a model from this .moc3.'); }
  model.update();
  const p = model.parameters, ci = model.canvasinfo;
  let masked = 0;
  for (let i = 0; i < model.drawables.count; i++) if (model.drawables.maskCounts[i]! > 0) masked++;
  return {
    core, model,
    info: {
      coreVersion: formatCoreVersion(core.Version.csmGetVersion()),
      mocVersion, latestMocVersion: latest,
      canvas: { width: ci.CanvasWidth, height: ci.CanvasHeight, originX: ci.CanvasOriginX, originY: ci.CanvasOriginY, pixelsPerUnit: ci.PixelsPerUnit },
      parameters: Array.from({ length: p.count }, (_, i) => ({ id: p.ids[i]!, min: p.minimumValues[i]!, max: p.maximumValues[i]!, default: p.defaultValues[i]!, repeat: !!p.repeats?.[i] })),
      parts: [...model.parts.ids],
      drawables: model.drawables.count,
      textures: textureCount,
      maskedDrawables: masked,
    },
    release() { model.release(); moc._release?.(); },
  };
}

/** One drawable ready for rendering, in canvas pixels (y down). */
export interface DrawableFrame {
  index: number;
  id: string;
  visible: boolean;
  opacity: number;
  renderOrder: number;
  texture: number;
  blend: 'normal' | 'add' | 'multiply';
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  masks: number[];
  invertedMask: boolean;
}

/**
 * Apply parameter values, update the model and read back drawables.
 * Model units → canvas pixels: x·PPU + originX, −y·PPU + originY
 * (Cubism model space is y-up); UV v is flipped for top-left textures.
 */
export function updateFrame(lm: LoadedModel, values: Record<string, number>): DrawableFrame[] {
  const { model, core } = lm;
  const p = model.parameters;
  for (let i = 0; i < p.count; i++) {
    const v = values[p.ids[i]!];
    if (v !== undefined) p.values[i] = v;
  }
  model.update();
  const d = model.drawables;
  const order = model.getRenderOrders?.() ?? d.renderOrders ?? Int32Array.from({ length: d.count }, (_, i) => i);
  const { PixelsPerUnit: ppu, CanvasOriginX: ox, CanvasOriginY: oy } = model.canvasinfo;
  const out: DrawableFrame[] = [];
  for (let i = 0; i < d.count; i++) {
    const src = d.vertexPositions[i]!, uv = d.vertexUvs[i]!;
    const positions = new Float32Array(src.length), uvs = new Float32Array(uv.length);
    for (let k = 0; k < src.length; k += 2) {
      positions[k] = src[k]! * ppu + ox;
      positions[k + 1] = -src[k + 1]! * ppu + oy;
      uvs[k] = uv[k]!;
      uvs[k + 1] = 1 - uv[k + 1]!;
    }
    const cf = d.constantFlags[i]!;
    out.push({
      index: i, id: d.ids[i]!,
      visible: core.Utils.hasIsVisibleBit(d.dynamicFlags[i]!),
      opacity: d.opacities[i]!,
      renderOrder: order[i]!,
      texture: d.textureIndices[i]!,
      blend: core.Utils.hasBlendAdditiveBit(cf) ? 'add' : core.Utils.hasBlendMultiplicativeBit(cf) ? 'multiply' : 'normal',
      positions, uvs, indices: d.indices[i]!,
      masks: Array.from(d.masks[i] ?? []).slice(0, d.maskCounts[i]),
      invertedMask: core.Utils.hasIsInvertedMaskBit(cf),
    });
  }
  d.resetDynamicFlags();
  return out;
}

export function describeInfo(i: ModelInfo): string[] {
  return [
    `Cubism Core ${i.coreVersion} · moc3 version ${i.mocVersion} (Core supports ≤ ${i.latestMocVersion})`,
    `Canvas ${i.canvas.width}×${i.canvas.height}px · ${i.drawables} drawables (${i.maskedDrawables} masked) · ${i.parameters.length} parameters · ${i.parts.length} parts · ${i.textures} texture(s)`,
  ];
}
