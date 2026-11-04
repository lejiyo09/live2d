import type { AnimationClip, AnimationTrack, Keyframe } from '@l2s/editor-core';
import type { ParameterValues } from '@l2s/parameter-engine';

/** Interpolation presets offered by the curve editor (spec §9.2). */
export type CurvePreset = 'linear' | 'step' | 'bezier' | 'easeIn' | 'easeOut' | 'easeInOut';

/** Handle pairs [out of the left key, in of the right key]; fractions of segment duration + value offset. */
export const PRESET_HANDLES: Record<'bezier' | 'easeIn' | 'easeOut' | 'easeInOut', { out: [number, number]; in: [number, number] }> = {
  bezier: { out: [1 / 3, 0], in: [1 / 3, 0] },
  easeIn: { out: [0.42, 0], in: [0, 0] },
  easeOut: { out: [0, 0], in: [0.42, 0] },
  easeInOut: { out: [0.42, 0], in: [0.42, 0] },
};

const cubic = (p0: number, p1: number, p2: number, p3: number, s: number) => {
  const u = 1 - s;
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
};

/** Value of the Bezier segment between `a` and `b` at time `t`. Handles are clamped inside the segment so time stays monotonic. */
export function bezierAt(a: Keyframe, b: Keyframe, t: number): number {
  const T = b.t - a.t;
  const ox = Math.min(1, Math.max(0, a.out?.[0] ?? 1 / 3)), oy = a.out?.[1] ?? 0;
  const ix = Math.min(1, Math.max(0, b.in?.[0] ?? 1 / 3)), iy = b.in?.[1] ?? 0;
  const x0 = a.t, x1 = a.t + ox * T, x2 = b.t - ix * T, x3 = b.t;
  // Solve x(s) = t: bisection (robust) refined with Newton.
  let lo = 0, hi = 1, s = (t - a.t) / T;
  for (let i = 0; i < 30; i++) {
    const x = cubic(x0, x1, x2, x3, s);
    if (Math.abs(x - t) < 1e-7) break;
    if (x < t) lo = s; else hi = s;
    const dx = 3 * (1 - s) * (1 - s) * (x1 - x0) + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (x3 - x2);
    const ns = dx > 1e-9 ? s - (x - t) / dx : (lo + hi) / 2;
    s = ns > lo && ns < hi ? ns : (lo + hi) / 2;
  }
  return cubic(a.v, a.v + oy, b.v + iy, b.v, s);
}

/** Track value at `t` (held before the first and after the last key). */
export function evaluateTrack(track: AnimationTrack, t: number): number | undefined {
  const k = track.keyframes;
  if (!k.length) return undefined;
  if (t <= k[0]!.t) return k[0]!.v;
  if (t >= k[k.length - 1]!.t) return k[k.length - 1]!.v;
  let lo = 0, hi = k.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (k[m]!.t <= t) lo = m; else hi = m;
  }
  const a = k[lo]!, b = k[hi]!;
  if (a.interp === 'step') return a.v;
  if (a.interp === 'bezier') return bezierAt(a, b, t);
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** Clip-local time for a playhead time (loop wraps, otherwise clamps). */
export function clipTime(clip: AnimationClip, t: number): number {
  const start = clip.range?.start ?? 0, end = clip.range?.end ?? clip.duration;
  const len = Math.max(1e-6, end - start);
  if (clip.loop) return start + ((((t - start) % len) + len) % len);
  return Math.min(end, Math.max(start, t));
}

/** Parameter values animated by the clip at time `t` (only parameters that have tracks). */
export function sampleClip(clip: AnimationClip, t: number): ParameterValues {
  const out: ParameterValues = {};
  for (const tr of clip.tracks) {
    const v = evaluateTrack(tr, t);
    if (v !== undefined) out[tr.parameterId] = v;
  }
  return out;
}
