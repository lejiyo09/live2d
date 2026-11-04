import type { Expression, Parameter, ParameterId, Project } from '@l2s/editor-core';

/** Standard parameter presets (spec §7.1). IDs follow the Cubism standard parameter naming. */
export const STANDARD_PARAMETERS: readonly Parameter[] = [
  { id: 'ParamAngleX', name: '좌우 얼굴 회전', min: -30, max: 30, default: 0 },
  { id: 'ParamAngleY', name: '상하 얼굴 회전', min: -30, max: 30, default: 0 },
  { id: 'ParamAngleZ', name: '얼굴 기울기', min: -30, max: 30, default: 0 },
  { id: 'ParamEyeLOpen', name: '왼쪽 눈 개폐', min: 0, max: 1, default: 1 },
  { id: 'ParamEyeROpen', name: '오른쪽 눈 개폐', min: 0, max: 1, default: 1 },
  { id: 'ParamEyeBallX', name: '눈동자 좌우', min: -1, max: 1, default: 0 },
  { id: 'ParamEyeBallY', name: '눈동자 상하', min: -1, max: 1, default: 0 },
  { id: 'ParamMouthOpenY', name: '입 개폐', min: 0, max: 1, default: 0 },
  { id: 'ParamMouthForm', name: '입 모양', min: -1, max: 1, default: 0 },
];

export type ParameterValues = Record<ParameterId, number>;

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isValidParameterId(id: string) {
  return ID_RE.test(id) && id.length <= 64;
}

export function validateParameter(p: Parameter, others: readonly Parameter[]): string | null {
  if (!isValidParameterId(p.id)) return 'ID must start with a letter or _, and contain only letters, digits and _.';
  if (others.some((o) => o.id === p.id)) return `ID "${p.id}" already exists.`;
  if (!(p.min < p.max)) return 'Minimum must be less than maximum.';
  if (p.default < p.min || p.default > p.max) return 'Default must lie within min..max.';
  return null;
}

/** Clamp (or wrap, for repeat parameters) a value into range. */
export function normalizeValue(p: Parameter, v: number): number {
  if (!Number.isFinite(v)) return p.default;
  if (p.repeat) {
    const span = p.max - p.min;
    return ((((v - p.min) % span) + span) % span) + p.min;
  }
  return Math.min(p.max, Math.max(p.min, v));
}

export function defaultValues(project: Pick<Project, 'parameters'>): ParameterValues {
  const out: ParameterValues = {};
  for (const p of project.parameters) out[p.id] = p.default;
  return out;
}

/** Current values for every defined parameter (missing → default, out of range → normalized). */
export function resolveValues(project: Pick<Project, 'parameters'>, values: ParameterValues): ParameterValues {
  const out: ParameterValues = {};
  for (const p of project.parameters) out[p.id] = normalizeValue(p, values[p.id] ?? p.default);
  return out;
}

/**
 * Apply expressions with Cubism exp3 semantics: per parameter
 * (value + Σ add·w) × Π(1 + (mul − 1)·w), then overwrite blended by w.
 */
export function applyExpressions(values: ParameterValues, active: ReadonlyArray<{ expression: Expression; weight: number }>, params: readonly Parameter[]): ParameterValues {
  if (!active.length) return values;
  const out: ParameterValues = { ...values };
  const byId = new Map(params.map((p) => [p.id, p]));
  const add = new Map<string, number>(), mul = new Map<string, number>(), over = new Map<string, { v: number; w: number }>();
  for (const { expression, weight } of active) {
    const w = Math.min(1, Math.max(0, weight));
    for (const ep of expression.parameters) {
      if (ep.blend === 'Add') add.set(ep.parameterId, (add.get(ep.parameterId) ?? 0) + ep.value * w);
      else if (ep.blend === 'Multiply') mul.set(ep.parameterId, (mul.get(ep.parameterId) ?? 1) * (1 + (ep.value - 1) * w));
      else over.set(ep.parameterId, { v: ep.value, w });
    }
  }
  for (const id of new Set([...add.keys(), ...mul.keys(), ...over.keys()])) {
    const p = byId.get(id);
    let v = out[id] ?? p?.default ?? 0;
    v = (v + (add.get(id) ?? 0)) * (mul.get(id) ?? 1);
    const o = over.get(id);
    if (o) v = v * (1 - o.w) + o.v * o.w;
    out[id] = p ? normalizeValue(p, v) : v;
  }
  return out;
}

/** Capture an expression from current values: parameters away from their default, as Add offsets. */
export function captureExpression(values: ParameterValues, params: readonly Parameter[], eps = 1e-4): Expression['parameters'] {
  return params.filter((p) => Math.abs((values[p.id] ?? p.default) - p.default) > eps).map((p) => ({ parameterId: p.id, value: (values[p.id] ?? p.default) - p.default, blend: 'Add' as const }));
}
