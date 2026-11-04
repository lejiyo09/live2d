import type { Parameter, ParameterId, PhysicsOutput, PhysicsRange, PhysicsRig, PhysicsSetting, PhysicsSourceType } from '@l2s/editor-core';
import type { ParameterValues } from '@l2s/parameter-engine';

/**
 * Pendulum physics (spec §8) with the same model and numeric behaviour as
 * Cubism's physics3 runtime: normalized inputs → strand of particles →
 * outputs, fixed-step simulation with interpolated input and output.
 * Written from the published algorithm; constants match the runtime.
 */
const AIR_RESISTANCE = 5;
const MAXIMUM_WEIGHT = 100;
const MOVEMENT_THRESHOLD = 0.001;
const MAX_DELTA_TIME = 5;

interface V2 { x: number; y: number }

interface ParticleState {
  position: V2;
  lastPosition: V2;
  lastGravity: V2;
  velocity: V2;
  force: V2;
}

interface SettingState {
  particles: ParticleState[];
  prevOutputs: number[];
  curOutputs: number[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function directionToRadian(from: V2, to: V2): number {
  let r = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x);
  while (r < -Math.PI) r += Math.PI * 2;
  while (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/**
 * Map a parameter value into the setting's normalized range, piecewise
 * linear around the *centre of the parameter range* (as the runtime does).
 * The result is negated unless the input is reflected.
 */
export function normalizeParameterValue(value: number, pMin: number, pMax: number, range: PhysicsRange, reflect: boolean): number {
  const maxV = Math.max(pMin, pMax), minV = Math.min(pMin, pMax);
  const v = Math.min(maxV, Math.max(minV, value));
  const minN = Math.min(range.min, range.max), maxN = Math.max(range.min, range.max), midN = range.default;
  const mid = minV + (maxV - minV) / 2;
  const d = v - mid;
  let result = 0;
  if (d > 0) {
    const len = maxV - mid;
    if (len !== 0) result = d * ((maxN - midN) / len) + midN;
  } else if (d < 0) {
    const len = minV - mid;
    if (len !== 0) result = d * ((minN - midN) / len) + midN;
  } else {
    result = midN;
  }
  return reflect ? result : -result;
}

function initStrand(setting: PhysicsSetting): ParticleState[] {
  const out: ParticleState[] = [];
  let prev: V2 = { x: 0, y: 0 };
  setting.particles.forEach((p, i) => {
    const pos = i === 0 ? { x: 0, y: 0 } : { x: prev.x, y: prev.y + p.radius };
    out.push({ position: { ...pos }, lastPosition: { ...pos }, lastGravity: { x: 0, y: 1 }, velocity: { x: 0, y: 0 }, force: { x: 0, y: 0 } });
    prev = pos;
  });
  return out;
}

function outputValue(o: PhysicsOutput, strand: ParticleState[], gravity: V2): number {
  const i = o.vertexIndex;
  const t = { x: strand[i]!.position.x - strand[i - 1]!.position.x, y: strand[i]!.position.y - strand[i - 1]!.position.y };
  let v: number;
  if (o.type === 'x') v = t.x;
  else if (o.type === 'y') v = t.y;
  else {
    const parent = i >= 2
      ? { x: strand[i - 1]!.position.x - strand[i - 2]!.position.x, y: strand[i - 1]!.position.y - strand[i - 2]!.position.y }
      : { x: -gravity.x, y: -gravity.y };
    v = directionToRadian(parent, t);
  }
  return o.reflect ? -v : v;
}

/** Clamp to the parameter range and blend by output weight into `current`. */
function applyOutput(current: number, raw: number, o: PhysicsOutput, p: Parameter | undefined): number {
  let v = raw * o.scale;
  if (p) v = Math.min(p.max, Math.max(p.min, v));
  const w = o.weight / MAXIMUM_WEIGHT;
  return w >= 1 ? v : current * (1 - w) + v * w;
}

export class PhysicsSimulator {
  private rig: PhysicsRig;
  private params = new Map<ParameterId, Parameter>();
  private states: SettingState[] = [];
  private remain = 0;
  private inputCache: ParameterValues | null = null;

  constructor(rig: PhysicsRig, parameters: readonly Parameter[]) {
    this.rig = rig;
    this.setParameters(parameters);
    this.reset();
  }

  setParameters(parameters: readonly Parameter[]) {
    this.params = new Map(parameters.map((p) => [p.id, p]));
  }

  /** Swap in an edited rig, keeping particle state of settings whose strand length is unchanged. */
  setRig(rig: PhysicsRig) {
    const old = this.states;
    this.rig = rig;
    this.states = rig.settings.map((s, i) => {
      const prev = old[i];
      if (prev && prev.particles.length === s.particles.length) {
        return { ...prev, prevOutputs: s.outputs.map((_, k) => prev.prevOutputs[k] ?? 0), curOutputs: s.outputs.map((_, k) => prev.curOutputs[k] ?? 0) };
      }
      return { particles: initStrand(s), prevOutputs: s.outputs.map(() => 0), curOutputs: s.outputs.map(() => 0) };
    });
  }

  reset() {
    this.states = this.rig.settings.map((s) => ({ particles: initStrand(s), prevOutputs: s.outputs.map(() => 0), curOutputs: s.outputs.map(() => 0) }));
    this.remain = 0;
    this.inputCache = null;
  }

  /** Parameters written by physics. */
  outputIds(): ParameterId[] {
    return [...new Set(this.rig.settings.flatMap((s) => s.outputs.map((o) => o.parameterId)))];
  }

  /** Particle positions per setting (for the editor preview). */
  strands(): V2[][] {
    return this.states.map((s) => s.particles.map((p) => ({ ...p.position })));
  }

  /**
   * Advance the simulation by `dt` seconds with the given input values and
   * return a copy of the values with physics outputs applied.
   */
  evaluate(values: ParameterValues, dt: number): ParameterValues {
    const out: ParameterValues = { ...values };
    if (!(dt > 0) || !this.rig.settings.length) return out;
    this.remain += dt;
    if (this.remain > MAX_DELTA_TIME) this.remain = 0;
    const ids = [...this.params.keys()];
    const valueOf = (v: ParameterValues, id: string) => v[id] ?? this.params.get(id)?.default ?? 0;
    if (!this.inputCache) this.inputCache = Object.fromEntries(ids.map((id) => [id, valueOf(values, id)]));
    const step = this.rig.fps > 0 ? 1 / this.rig.fps : dt;
    const cache: ParameterValues = {};
    while (this.remain >= step) {
      for (const s of this.states) s.prevOutputs = [...s.curOutputs];
      // Input at the moment of this sub-step: interpolate from the previous input towards the current one.
      const w = step / this.remain;
      for (const id of ids) {
        cache[id] = this.inputCache[id]! * (1 - w) + valueOf(values, id) * w;
        this.inputCache[id] = cache[id]!;
      }
      this.rig.settings.forEach((setting, si) => this.stepSetting(setting, this.states[si]!, cache, step));
      this.remain -= step;
    }
    const alpha = this.remain / step;
    this.rig.settings.forEach((setting, si) => {
      const st = this.states[si]!;
      setting.outputs.forEach((o, k) => {
        if (o.vertexIndex < 1 || o.vertexIndex >= setting.particles.length) return;
        const v = st.prevOutputs[k]! * (1 - alpha) + st.curOutputs[k]! * alpha;
        out[o.parameterId] = applyOutput(valueOf(out, o.parameterId), v, o, this.params.get(o.parameterId));
      });
    });
    return out;
  }

  private stepSetting(setting: PhysicsSetting, st: SettingState, cache: ParameterValues, dt: number) {
    const tr: V2 = { x: 0, y: 0 };
    let angle = 0;
    for (const input of setting.inputs) {
      const p = this.params.get(input.parameterId);
      if (!p) continue;
      const weight = input.weight / MAXIMUM_WEIGHT;
      const range = input.type === 'angle' ? setting.normalization.angle : setting.normalization.position;
      const n = normalizeParameterValue(cache[input.parameterId] ?? p.default, p.min, p.max, range, input.reflect) * weight;
      addInput(input.type, n, tr, (a) => { angle += a; });
    }
    const r = rad(-angle);
    // The runtime rotates in place (y uses the already-rotated x); reproduced for identical motion.
    tr.x = tr.x * Math.cos(r) - tr.y * Math.sin(r);
    tr.y = tr.x * Math.sin(r) + tr.y * Math.cos(r);
    updateParticles(st.particles, setting, tr, angle, this.rig.wind, MOVEMENT_THRESHOLD * setting.normalization.position.max, dt);
    setting.outputs.forEach((o, k) => {
      if (o.vertexIndex < 1 || o.vertexIndex >= setting.particles.length) return;
      const v = outputValue(o, st.particles, this.rig.gravity);
      st.curOutputs[k] = v;
      // Outputs feed later settings within the same step (chained physics groups).
      cache[o.parameterId] = applyOutput(cache[o.parameterId] ?? 0, v, o, this.params.get(o.parameterId));
    });
  }
}

function addInput(type: PhysicsSourceType, n: number, tr: V2, addAngle: (a: number) => void) {
  if (type === 'x') tr.x += n;
  else if (type === 'y') tr.y += n;
  else addAngle(n);
}

function updateParticles(strand: ParticleState[], setting: PhysicsSetting, tr: V2, totalAngle: number, wind: V2, threshold: number, dt: number) {
  strand[0]!.position = { x: tr.x, y: tr.y };
  const g = { x: Math.sin(rad(totalAngle)), y: Math.cos(rad(totalAngle)) };
  const gl = Math.hypot(g.x, g.y) || 1;
  g.x /= gl; g.y /= gl;
  for (let i = 1; i < strand.length; i++) {
    const s = strand[i]!, prev = strand[i - 1]!, def = setting.particles[i]!;
    s.force = { x: g.x * def.acceleration + wind.x, y: g.y * def.acceleration + wind.y };
    s.lastPosition = { ...s.position };
    const delay = def.delay * dt * 30;
    const dir = { x: s.position.x - prev.position.x, y: s.position.y - prev.position.y };
    const r = directionToRadian(s.lastGravity, g) / AIR_RESISTANCE;
    dir.x = Math.cos(r) * dir.x - dir.y * Math.sin(r);
    dir.y = Math.sin(r) * dir.x + dir.y * Math.cos(r); // in-place, as in the runtime
    s.position = { x: prev.position.x + dir.x, y: prev.position.y + dir.y };
    s.position.x += s.velocity.x * delay + s.force.x * delay * delay;
    s.position.y += s.velocity.y * delay + s.force.y * delay * delay;
    const nd = { x: s.position.x - prev.position.x, y: s.position.y - prev.position.y };
    const nl = Math.hypot(nd.x, nd.y);
    if (nl > 0) { nd.x /= nl; nd.y /= nl; }
    s.position = { x: prev.position.x + nd.x * def.radius, y: prev.position.y + nd.y * def.radius };
    if (Math.abs(s.position.x) < threshold) s.position.x = 0;
    if (delay !== 0) {
      s.velocity = { x: ((s.position.x - s.lastPosition.x) / delay) * def.mobility, y: ((s.position.y - s.lastPosition.y) / delay) * def.mobility };
    }
    s.force = { x: 0, y: 0 };
    s.lastGravity = { ...g };
  }
}

/** A typical hair-sway setting: head turn and tilt in, one angle output. */
export function newPhysicsSetting(id: string, name: string, output: ParameterId, opts: { inputs?: Array<[ParameterId, PhysicsSourceType, number]>; length?: number } = {}): PhysicsSetting {
  const inputs = opts.inputs ?? [['ParamAngleX', 'x', 60], ['ParamAngleZ', 'angle', 60]];
  const length = opts.length ?? 10;
  return {
    id, name,
    inputs: inputs.map(([parameterId, type, weight]) => ({ parameterId, type, weight, reflect: false })),
    outputs: [{ parameterId: output, type: 'angle', vertexIndex: 1, scale: 1.5, weight: 100, reflect: false }],
    particles: [
      { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
      { x: 0, y: length, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: length },
    ],
    normalization: { position: { min: -10, default: 0, max: 10 }, angle: { min: -10, default: 0, max: 10 } },
  };
}
