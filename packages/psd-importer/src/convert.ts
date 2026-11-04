import { initializeCanvas, readPsd, type Layer, type Psd, type BlendMode as PsdBlendMode } from 'ag-psd';
import {
  PROJECT_FORMAT_VERSION, newId, defaultPhysicsRig,
  type AssetId, type AssetKind, type BlendMode, type GroupNode, type LayerNode, type NodeId, type Project, type Rect,
} from '@l2s/editor-core';
import { cloneRgba, isFullyTransparent, multiplyAlpha, toRgba8, type Rgba8 } from './pixels.ts';
import { suggestPartTag } from './naming.ts';

export interface RawAsset {
  id: AssetId;
  kind: AssetKind;
  pixels: Rgba8;
}

export type ImportWarningCode =
  | 'unsupported-color-mode'
  | 'layer-effects-ignored'
  | 'adjustment-layer-skipped'
  | 'empty-layer-skipped'
  | 'fill-opacity-baked'
  | 'clipping-base-group'
  | 'vector-mask-ignored'
  | 'group-blend-approximated'
  | 'blend-mode-unsupported';

export interface ImportWarning {
  code: ImportWarningCode;
  layerName?: string;
  message: string;
}

export interface ImportResult {
  project: Project;
  /** Decoded pixel assets keyed by id. Display assets may alias the original asset id. */
  assets: RawAsset[];
  warnings: ImportWarning[];
  stats: { layers: number; groups: number; skipped: number; width: number; height: number };
}

export interface ImportOptions {
  fileName: string;
  /** Asset id the caller will store the source PSD bytes under. */
  sourceAssetId: AssetId;
  /** Suggest part tags from layer names (rule based; AI classifier comes in Phase 4). */
  suggestTags?: boolean;
  onProgress?: (done: number, total: number) => void;
}

let canvasReady = false;
/**
 * ag-psd only auto-configures canvas creation when `document` exists. Inside a
 * Worker (or Node tests) we provide plain-buffer ImageData so decoding never
 * touches a canvas (which would also premultiply and corrupt pixels).
 */
function ensureCanvasFactory() {
  if (canvasReady || typeof document !== 'undefined') return;
  canvasReady = true;
  const createImageData = (width: number, height: number) =>
    ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData;
  const createCanvas = (width: number, height: number) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
    throw new Error('Canvas is not available in this environment');
  };
  initializeCanvas(createCanvas, createImageData);
}

export function parsePsd(buffer: ArrayBuffer | Uint8Array): Psd {
  ensureCanvasFactory();
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return readPsd(view, {
    useImageData: true,
    skipThumbnail: true,
    skipCompositeImageData: true,
    skipLinkedFilesData: true,
    logMissingFeatures: false,
  });
}

export function importPsd(buffer: ArrayBuffer | Uint8Array, opts: ImportOptions): ImportResult {
  return convertPsd(parsePsd(buffer), opts);
}

const SUPPORTED_COLOR_MODES = new Set([1 /* Grayscale */, 3 /* RGB */, 4 /* CMYK */]);

export function convertPsd(psd: Psd, opts: ImportOptions): ImportResult {
  const warnings: ImportWarning[] = [];
  const assets: RawAsset[] = [];
  const nodes: Record<NodeId, GroupNode | LayerNode> = {};
  const bits = psd.bitsPerChannel ?? 8;
  if (psd.colorMode !== undefined && !SUPPORTED_COLOR_MODES.has(psd.colorMode)) {
    warnings.push({ code: 'unsupported-color-mode', message: `Color mode ${psd.colorMode} may not import correctly.` });
  }

  const total = countLayers(psd.children ?? []);
  let done = 0;
  let skipped = 0;
  let layerCount = 0;
  let groupCount = 0;


  const convertList = (layers: Layer[], parentId: NodeId | null, path: number[]): NodeId[] => {
    const ids: NodeId[] = [];
    let clipBase: NodeId | 'group' | null = null;
    layers.forEach((layer, index) => {
      const name = layer.name ?? 'Layer';
      const sourcePath = [...path, index];
      const isGroup = layer.children !== undefined;
      const blendMode = mapBlendMode(layer.blendMode, isGroup);
      if (layer.blendMode && !isKnownBlend(layer.blendMode)) {
        warnings.push({ code: 'blend-mode-unsupported', layerName: name, message: `Blend mode "${layer.blendMode}" is not supported; using normal.` });
      }
      if (layer.effects && !layer.effects.disabled && hasActiveEffects(layer.effects)) {
        warnings.push({ code: 'layer-effects-ignored', layerName: name, message: 'Layer effects (layer styles) are not imported. Rasterize them in Photoshop to keep the look.' });
      }
      if (layer.vectorMask) {
        warnings.push({ code: 'vector-mask-ignored', layerName: name, message: 'Vector masks are not imported. Rasterize the mask to keep it.' });
      }

      if (isGroup) {
        groupCount++;
        const id = newId('grp');
        const group: GroupNode = {
          id, kind: 'group', name, parentId,
          visible: !layer.hidden, locked: false, opacity: layer.opacity ?? 1,
          blendMode, childIds: [], collapsed: !layer.opened,
        };
        nodes[id] = group;
        if (opts.suggestTags !== false) {
          const tag = suggestPartTag(name);
          if (tag) group.partTag = tag;
        }
        group.childIds = convertList(layer.children!, id, sourcePath);
        if (blendMode !== 'pass-through' && blendMode !== 'normal') {
          warnings.push({ code: 'group-blend-approximated', layerName: name, message: 'Group blend modes are applied per child layer (approximation).' });
        }
        ids.push(id);
        if (!layer.clipping) clipBase = 'group';
        return;
      }

      done++;
      opts.onProgress?.(done, total);

      if (isAdjustmentLayer(layer)) {
        skipped++;
        warnings.push({ code: 'adjustment-layer-skipped', layerName: name, message: 'Adjustment / fill layers have no pixels and were skipped.' });
        return;
      }

      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      const width = Math.max(0, (layer.right ?? 0) - left);
      const height = Math.max(0, (layer.bottom ?? 0) - top);
      if (!layer.imageData || width === 0 || height === 0) {
        skipped++;
        warnings.push({ code: 'empty-layer-skipped', layerName: name, message: 'Layer has no pixels and was skipped.' });
        return;
      }

      const original = toRgba8(layer.imageData, bits);
      if (isFullyTransparent(original)) {
        skipped++;
        warnings.push({ code: 'empty-layer-skipped', layerName: name, message: 'Layer is fully transparent and was skipped.' });
        return;
      }

      layerCount++;
      const id = newId('lyr');
      const originalId = newId('ast');
      assets.push({ id: originalId, kind: 'layer-original', pixels: original });

      let display: Rgba8 | null = null;
      const ensureDisplay = () => (display ??= cloneRgba(original));

      // Fill opacity: no effects are imported, so it is equivalent to an alpha multiplier on the pixels.
      const fill = layer.fillOpacity ?? 1;
      if (fill < 1) {
        const d = ensureDisplay();
        const c = Math.round(fill * 255);
        multiplyAlpha(d, left, top, () => c);
        warnings.push({ code: 'fill-opacity-baked', layerName: name, message: `Fill opacity ${Math.round(fill * 100)}% baked into display pixels.` });
      }

      // Layer (user) mask.
      let maskId: AssetId | undefined;
      let maskInfo: LayerNode['mask'];
      const m = layer.mask;
      if (m) {
        const mb: Rect = { x: m.left ?? 0, y: m.top ?? 0, width: Math.max(0, (m.right ?? 0) - (m.left ?? 0)), height: Math.max(0, (m.bottom ?? 0) - (m.top ?? 0)) };
        const defaultColor = m.defaultColor ?? 0;
        maskInfo = { bounds: mb, defaultColor, disabled: !!m.disabled, positionedRelativeToLayer: !!m.positionRelativeToLayer };
        const maskPx = m.imageData && mb.width > 0 && mb.height > 0 ? toRgba8(m.imageData, bits) : null;
        if (maskPx) {
          maskId = newId('ast');
          assets.push({ id: maskId, kind: 'layer-mask', pixels: maskPx });
        }
        if (!m.disabled) {
          const d = ensureDisplay();
          multiplyAlpha(d, left, top, (cx, cy) => {
            const mx = cx - mb.x;
            const my = cy - mb.y;
            if (!maskPx || mx < 0 || my < 0 || mx >= mb.width || my >= mb.height) return defaultColor;
            return maskPx.data[(my * mb.width + mx) * 4]!;
          });
        }
      }

      // Clipping mask: referenced as a runtime ArtMesh mask (follows deformation),
      // unless the base is a group, which cannot be a mask source.
      const clipping = !!layer.clipping;
      let clipMask: LayerNode['clipMask'];
      if (clipping) {
        if (clipBase === 'group') {
          warnings.push({ code: 'clipping-base-group', layerName: name, message: 'Clipping onto a group is not supported; the layer is shown unclipped.' });
        } else if (clipBase) {
          clipMask = { ids: [clipBase], inverted: false };
        }
      }

      let displayId = originalId;
      if (display) {
        displayId = newId('ast');
        assets.push({ id: displayId, kind: 'layer-display', pixels: display });
      }
      if (!clipping) clipBase = id;

      const node: LayerNode = {
        id, kind: 'layer', name, parentId,
        visible: !layer.hidden, locked: false, opacity: layer.opacity ?? 1,
        blendMode,
        bounds: { x: left, y: top, width, height },
        assets: { original: originalId, display: displayId, ...(maskId ? { mask: maskId } : {}) },
        clipping,
        ...(clipMask ? { clipMask } : {}),
        ...(maskInfo ? { mask: maskInfo } : {}),
        sourcePath,
      };
      if (opts.suggestTags !== false) {
        const tag = suggestPartTag(name);
        if (tag) node.partTag = tag;
      }
      nodes[id] = node;
      ids.push(id);
    });
    return ids;
  };

  const rootIds = convertList(psd.children ?? [], null, []);
  const now = new Date().toISOString();
  const project: Project = {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId('prj'),
    name: opts.fileName.replace(/\.psd$/i, ''),
    createdAt: now,
    updatedAt: now,
    canvas: { width: psd.width, height: psd.height },
    rootIds,
    nodes,
    meshes: {},
    parameters: [],
    parameterGroups: [],
    deformers: {},
    physics: defaultPhysicsRig(),
    animations: [],
    scenes: [],
    expressions: [],
    source: { kind: 'psd', fileName: opts.fileName, assetId: opts.sourceAssetId, importedAt: now },
  };
  return {
    project,
    assets,
    warnings,
    stats: { layers: layerCount, groups: groupCount, skipped, width: psd.width, height: psd.height },
  };
}

function countLayers(layers: Layer[]): number {
  let n = 0;
  for (const l of layers) n += l.children ? countLayers(l.children) : 1;
  return n;
}

const BLEND_MAP: Partial<Record<PsdBlendMode, BlendMode>> = {
  'pass through': 'pass-through', normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply',
  'color burn': 'color-burn', 'linear burn': 'linear-burn', 'darker color': 'darker-color', lighten: 'lighten',
  screen: 'screen', 'color dodge': 'color-dodge', 'linear dodge': 'linear-dodge', 'lighter color': 'lighter-color',
  overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'vivid-light',
  'linear light': 'linear-light', 'pin light': 'pin-light', 'hard mix': 'hard-mix', difference: 'difference',
  exclusion: 'exclusion', subtract: 'subtract', subtraction: 'subtract', divide: 'divide', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

function isKnownBlend(b: PsdBlendMode) {
  return b in BLEND_MAP;
}

export function mapBlendMode(b: PsdBlendMode | undefined, isGroup: boolean): BlendMode {
  if (!b) return isGroup ? 'pass-through' : 'normal';
  const m = BLEND_MAP[b] ?? 'normal';
  // Pass-through is only meaningful for groups.
  return m === 'pass-through' && !isGroup ? 'normal' : m;
}

function hasActiveEffects(e: NonNullable<Layer['effects']>): boolean {
  const keys = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'solidFill', 'satin', 'gradientOverlay', 'patternOverlay', 'stroke'] as const;
  return keys.some((k) => {
    const v = (e as Record<string, unknown>)[k];
    const list = Array.isArray(v) ? v : v ? [v] : [];
    return list.some((x: { enabled?: boolean }) => x.enabled !== false);
  });
}

function isAdjustmentLayer(layer: Layer): boolean {
  return !!(layer.adjustment || (layer as { vectorFill?: unknown }).vectorFill) && !layer.imageData;
}
