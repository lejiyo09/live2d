import type { KeyformBinding, KeyformGrid, ParameterId } from '@l2s/editor-core';
import type { ParameterValues } from './parameters.ts';

export const KEY_EPSILON = 1e-4;

/** Number of keyforms a set of bindings requires. */
export function gridSize(bindings: readonly KeyformBinding[]): number {
  return bindings.reduce((n, b) => n * b.keys.length, 1);
}

export function gridIndex(bindings: readonly KeyformBinding[], keyIdx: readonly number[]): number {
  let idx = 0, stride = 1;
  bindings.forEach((b, i) => { idx += keyIdx[i]! * stride; stride *= b.keys.length; });
  return idx;
}

export function gridCoords(bindings: readonly KeyformBinding[], index: number): number[] {
  return bindings.map((b) => {
    const k = index % b.keys.length;
    index = Math.floor(index / b.keys.length);
    return k;
  });
}

/** Parameter values at which keyform `index` sits (bound parameters only). */
export function keyValuesAt(bindings: readonly KeyformBinding[], index: number): ParameterValues {
  const c = gridCoords(bindings, index);
  return Object.fromEntries(bindings.map((b, i) => [b.parameterId, b.keys[c[i]!]!]));
}

/** Segment and fraction of `v` along ascending `keys` (clamped at the ends). */
function locate(keys: readonly number[], v: number): [number, number] {
  const n = keys.length;
  if (n === 1 || v <= keys[0]!) return [0, 0];
  if (v >= keys[n - 1]!) return [n - 2, 1];
  let i = 0;
  while (i < n - 2 && v > keys[i + 1]!) i++;
  return [i, (v - keys[i]!) / (keys[i + 1]! - keys[i]!)];
}

export interface Weighted { index: number; weight: number }

/** Multilinear interpolation weights over the keyform grid (spec §7.2 / §7.3). */
export function keyformWeights(bindings: readonly KeyformBinding[], values: ParameterValues): Weighted[] {
  let out: Weighted[] = [{ index: 0, weight: 1 }];
  let stride = 1;
  for (const b of bindings) {
    const v = values[b.parameterId] ?? 0;
    const [seg, t] = locate(b.keys, v);
    const next: Weighted[] = [];
    for (const w of out) {
      if (b.keys.length === 1 || t === 0) next.push({ index: w.index + seg * stride, weight: w.weight });
      else if (t === 1) next.push({ index: w.index + (seg + 1) * stride, weight: w.weight });
      else next.push({ index: w.index + seg * stride, weight: w.weight * (1 - t) }, { index: w.index + (seg + 1) * stride, weight: w.weight * t });
    }
    out = next;
    stride *= b.keys.length;
  }
  return out;
}

/** Keyform index if every bound parameter sits on one of its keys, else -1. */
export function activeKeyIndex(bindings: readonly KeyformBinding[], values: ParameterValues, eps = KEY_EPSILON): number {
  const coords: number[] = [];
  for (const b of bindings) {
    const v = values[b.parameterId] ?? 0;
    const k = b.keys.findIndex((key) => Math.abs(key - v) <= eps);
    if (k < 0) return -1;
    coords.push(k);
  }
  return gridIndex(bindings, coords);
}

type Numeric = number | number[] | { [k: string]: Numeric };

/** Weighted sum of structurally identical keyforms (numbers and number arrays). */
export function blend<T>(forms: readonly T[], weighted: readonly Weighted[]): T {
  if (weighted.length === 1) return forms[weighted[0]!.index]!;
  const first = forms[weighted[0]!.index] as unknown as Numeric;
  const mix = (sample: Numeric, get: (f: Numeric) => Numeric): Numeric => {
    if (typeof sample === 'number') {
      let s = 0;
      for (const w of weighted) s += (get(forms[w.index] as unknown as Numeric) as number) * w.weight;
      return s;
    }
    if (Array.isArray(sample)) {
      const out = new Array<number>(sample.length).fill(0);
      for (const w of weighted) {
        const arr = get(forms[w.index] as unknown as Numeric) as number[];
        for (let i = 0; i < out.length; i++) out[i]! += arr[i]! * w.weight;
      }
      return out;
    }
    const o: Record<string, Numeric> = {};
    for (const k of Object.keys(sample)) o[k] = mix(sample[k]!, (f) => (get(f) as Record<string, Numeric>)[k]!);
    return o;
  };
  return mix(first, (f) => f) as unknown as T;
}

export function evaluateGrid<T>(grid: KeyformGrid<T>, values: ParameterValues): T {
  return blend(grid.keyforms, keyformWeights(grid.bindings, values));
}

// ------------------------------------------------------------------ grid editing (pure)

/** Bind a new parameter: every existing keyform is duplicated for each key. */
export function addBinding<T>(grid: KeyformGrid<T>, parameterId: ParameterId, keys: number[]): KeyformGrid<T> {
  if (grid.bindings.some((b) => b.parameterId === parameterId)) return grid;
  const sorted = uniqueSorted(keys);
  const keyforms: T[] = [];
  for (let k = 0; k < sorted.length; k++) for (const f of grid.keyforms) keyforms.push(structuredClone(f));
  return { bindings: [...grid.bindings, { parameterId, keys: sorted }], keyforms };
}

/** Remove a binding, keeping the keyforms at the key nearest `keepValue`. */
export function removeBinding<T>(grid: KeyformGrid<T>, parameterId: ParameterId, keepValue: number): KeyformGrid<T> {
  const bi = grid.bindings.findIndex((b) => b.parameterId === parameterId);
  if (bi < 0) return grid;
  const b = grid.bindings[bi]!;
  let keep = 0;
  b.keys.forEach((k, i) => { if (Math.abs(k - keepValue) < Math.abs(b.keys[keep]! - keepValue)) keep = i; });
  const bindings = grid.bindings.filter((_, i) => i !== bi);
  const keyforms: T[] = [];
  for (let idx = 0; idx < gridSize(bindings); idx++) {
    const c = gridCoords(bindings, idx);
    c.splice(bi, 0, keep);
    keyforms.push(grid.keyforms[gridIndex(grid.bindings, c)]!);
  }
  return { bindings, keyforms };
}

/** Insert a key; the new keyforms are interpolated so the current shape is unchanged. */
export function insertKey<T>(grid: KeyformGrid<T>, parameterId: ParameterId, key: number): KeyformGrid<T> {
  const bi = grid.bindings.findIndex((b) => b.parameterId === parameterId);
  if (bi < 0) return grid;
  const old = grid.bindings[bi]!;
  if (old.keys.some((k) => Math.abs(k - key) <= KEY_EPSILON)) return grid;
  const keys = uniqueSorted([...old.keys, key]);
  const bindings = grid.bindings.map((b, i) => (i === bi ? { ...b, keys } : b));
  const keyforms: T[] = [];
  for (let idx = 0; idx < gridSize(bindings); idx++) {
    const c = gridCoords(bindings, idx);
    const value = keys[c[bi]!]!;
    // Interpolate along this binding only, other coordinates fixed.
    const sub = old.keys.length === 1 ? [{ k: 0, w: 1 }] : weights1d(old.keys, value);
    const weighted = sub.map(({ k, w }) => {
      const oc = [...c];
      oc[bi] = k;
      return { index: gridIndex(grid.bindings, oc), weight: w };
    });
    keyforms.push(structuredClone(blend(grid.keyforms, weighted)));
  }
  return { bindings, keyforms };
}

export function removeKey<T>(grid: KeyformGrid<T>, parameterId: ParameterId, key: number): KeyformGrid<T> {
  const bi = grid.bindings.findIndex((b) => b.parameterId === parameterId);
  if (bi < 0) return grid;
  const old = grid.bindings[bi]!;
  const ki = old.keys.findIndex((k) => Math.abs(k - key) <= KEY_EPSILON);
  if (ki < 0) return grid;
  if (old.keys.length === 1) return removeBinding(grid, parameterId, key);
  const keys = old.keys.filter((_, i) => i !== ki);
  const bindings = grid.bindings.map((b, i) => (i === bi ? { ...b, keys } : b));
  const keyforms: T[] = [];
  for (let idx = 0; idx < gridSize(bindings); idx++) {
    const c = gridCoords(bindings, idx);
    if (c[bi]! >= ki) c[bi]!++;
    keyforms.push(grid.keyforms[gridIndex(grid.bindings, c)]!);
  }
  return { bindings, keyforms };
}

function weights1d(keys: number[], v: number) {
  const [seg, t] = (() => {
    const n = keys.length;
    if (v <= keys[0]!) return [0, 0] as const;
    if (v >= keys[n - 1]!) return [n - 2, 1] as const;
    let i = 0;
    while (i < n - 2 && v > keys[i + 1]!) i++;
    return [i, (v - keys[i]!) / (keys[i + 1]! - keys[i]!)] as const;
  })();
  return [{ k: seg, w: 1 - t }, { k: seg + 1, w: t }].filter((x) => x.w > 0);
}

function uniqueSorted(keys: number[]) {
  const s = [...keys].sort((a, b) => a - b);
  return s.filter((k, i) => i === 0 || Math.abs(k - s[i - 1]!) > KEY_EPSILON);
}

/** Default keys for "2 keys" / "3 keys" binding (Cubism's quick-add buttons). */
export function presetKeys(p: { min: number; max: number; default: number }, count: 2 | 3): number[] {
  if (count === 2) return [p.min, p.max];
  return uniqueSorted([p.min, p.default, p.max]);
}

// ------------------------------------------------------------------ blend shapes (spec §7.3)

type Num = number | number[] | { [k: string]: Num };

/** base + Σ interpolated deltas (structure of `base`). */
export function applyBlendShapes<T>(base: T, shapes: ReadonlyArray<{ parameterId: string; keys: number[]; deltas: T[] }> | undefined, values: ParameterValues): T {
  if (!shapes?.length) return base;
  let acc = base as unknown as Num;
  for (const s of shapes) {
    const w = keyformWeights([{ parameterId: s.parameterId, keys: s.keys }], values);
    const d = blend(s.deltas, w) as unknown as Num;
    acc = addNum(acc, d);
  }
  return acc as unknown as T;
}

function addNum(a: Num, b: Num): Num {
  if (typeof a === 'number') return a + (b as number);
  if (Array.isArray(a)) return a.map((v, i) => v + ((b as number[])[i] ?? 0));
  const o: Record<string, Num> = {};
  for (const k of Object.keys(a)) o[k] = (b as Record<string, Num>)[k] === undefined ? a[k]! : addNum(a[k]!, (b as Record<string, Num>)[k]!);
  return o;
}

export function subNum<T>(a: T, b: T): T {
  const neg = (x: Num): Num => (typeof x === 'number' ? -x : Array.isArray(x) ? x.map((v) => -v) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, neg(v)])));
  return addNum(a as unknown as Num, neg(b as unknown as Num)) as unknown as T;
}

/** A zero delta with the structure of `like`. */
export function zeroLike<T>(like: T): T {
  const z = (x: Num): Num => (typeof x === 'number' ? 0 : Array.isArray(x) ? x.map(() => 0) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, z(v)])));
  return z(like as unknown as Num) as unknown as T;
}
