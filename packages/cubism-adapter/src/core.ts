/**
 * Minimal typing of the official Cubism Core for Web (`live2dcubismcore.js`),
 * written from how the open-source Cubism Web Framework uses it. The Core
 * itself is proprietary (Live2D Proprietary Software License): it is never
 * bundled; the user loads their own copy from the official SDK package.
 */
export interface CoreMoc {
  _release?(): void;
}

export interface CoreModel {
  parameters: {
    count: number;
    ids: string[];
    minimumValues: Float32Array;
    maximumValues: Float32Array;
    defaultValues: Float32Array;
    values: Float32Array;
    repeats?: ArrayLike<number>;
  };
  parts: { count: number; ids: string[]; opacities: Float32Array; parentIndices: Int32Array };
  drawables: {
    count: number;
    ids: string[];
    constantFlags: Uint8Array;
    dynamicFlags: Uint8Array;
    textureIndices: Int32Array;
    renderOrders?: Int32Array;
    opacities: Float32Array;
    maskCounts: Int32Array;
    masks: ArrayLike<number>[];
    vertexCounts: Int32Array;
    vertexPositions: Float32Array[];
    vertexUvs: Float32Array[];
    indexCounts: Int32Array;
    indices: Uint16Array[];
    resetDynamicFlags(): void;
  };
  canvasinfo: { CanvasWidth: number; CanvasHeight: number; CanvasOriginX: number; CanvasOriginY: number; PixelsPerUnit: number };
  getRenderOrders?(): Int32Array;
  update(): void;
  release(): void;
}

export interface CubismCore {
  Version: { csmGetVersion(): number; csmGetLatestMocVersion(): number; csmGetMocVersion(buffer: ArrayBuffer): number };
  Moc: { fromArrayBuffer(buffer: ArrayBuffer): CoreMoc | null; prototype: { hasMocConsistency?(buffer: ArrayBuffer): number } };
  Model: { fromMoc(moc: CoreMoc): CoreModel | null };
  Utils: {
    hasIsVisibleBit(flags: number): boolean;
    hasBlendAdditiveBit(flags: number): boolean;
    hasBlendMultiplicativeBit(flags: number): boolean;
    hasIsInvertedMaskBit(flags: number): boolean;
    hasIsDoubleSidedBit?(flags: number): boolean;
  };
}

export class CoreLoadError extends Error {}

/** The Core, if it was already loaded into this page. */
export function getCore(): CubismCore | null {
  return ((globalThis as Record<string, unknown>).Live2DCubismCore as CubismCore | undefined) ?? null;
}

/** Version number (0xMMmmpppp) → "M.m.p". */
export function formatCoreVersion(v: number): string {
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${v & 0xffff}`;
}

/**
 * Load a user-supplied `live2dcubismcore(.min).js` by injecting it as a
 * script. Resolves once the global `Live2DCubismCore` exists.
 */
export async function loadCoreScript(source: Blob | string, timeoutMs = 10_000): Promise<CubismCore> {
  const existing = getCore();
  if (existing) return existing;
  if (typeof document === 'undefined') throw new CoreLoadError('The Cubism Core can only be loaded in a browser page.');
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new CoreLoadError('The Cubism Core script failed to load.'));
    document.head.appendChild(s);
  });
  const t0 = Date.now();
  while (!getCore()) {
    if (Date.now() - t0 > timeoutMs) throw new CoreLoadError('The file did not define Live2DCubismCore. Is it live2dcubismcore.js from the official SDK?');
    await new Promise((r) => setTimeout(r, 20));
  }
  return getCore()!;
}
