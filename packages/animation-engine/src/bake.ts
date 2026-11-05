import type { AnimationClip, Command, Keyframe, Project } from '@l2s/editor-core';
import { defaultValues, resolveValues, type ParameterValues } from '@l2s/parameter-engine';
import { PhysicsSimulator } from '@l2s/physics-engine';
import { sampleClip } from './curve.ts';

/** Deterministic per-frame values of a clip with physics, simulated from rest at t = 0. */
export function simulateClip(project: Project, clip: AnimationClip, opts: { physics?: boolean; warmup?: number } = {}): ParameterValues[] {
  const sim = opts.physics === false || !project.physics.settings.length ? null : new PhysicsSimulator(project.physics, project.parameters);
  const frames = Math.round(clip.duration * clip.fps) + 1;
  const base = defaultValues(project);
  const dt = 1 / clip.fps;
  const out: ParameterValues[] = [];
  // Let the strands settle at the first pose so baked loops don't start with a jolt.
  if (sim) for (let i = 0; i < (opts.warmup ?? 0) * clip.fps; i++) sim.evaluate(resolveValues(project, { ...base, ...sampleClip(clip, 0) }), dt);
  for (let f = 0; f < frames; f++) {
    const v = resolveValues(project, { ...base, ...sampleClip(clip, f * dt) });
    out.push(sim ? sim.evaluate(v, f === 0 ? 1e-9 : dt) : v);
  }
  return out;
}

/** Drop keys that linear interpolation reproduces within `tol` (keeps baked tracks small). */
export function reduceKeys(keys: Keyframe[], tol: number): Keyframe[] {
  if (keys.length <= 2) return keys;
  const keep = new Uint8Array(keys.length);
  keep[0] = keep[keys.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, keys.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, err = tol;
    for (let i = a + 1; i < b; i++) {
      const ka = keys[a]!, kb = keys[b]!, k = keys[i]!;
      const lin = ka.v + ((kb.v - ka.v) * (k.t - ka.t)) / (kb.t - ka.t);
      const e = Math.abs(lin - k.v);
      if (e > err) { err = e; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return keys.filter((_, i) => keep[i]);
}

/**
 * Bake physics outputs into keyframes (spec §8.3: baked animation vs realtime).
 * Existing tracks of the output parameters are replaced.
 */
export function bakePhysics(clipId: string, opts: { tolerance?: number; warmup?: number } = {}): Command {
  return {
    label: 'Bake Physics',
    apply(d) {
      const clip = d.animations.find((c) => c.id === clipId);
      if (!clip) return;
      const snap = JSON.parse(JSON.stringify(d)) as Project;
      const snapClip = snap.animations.find((c) => c.id === clipId)!;
      // Simulate without the tracks that are about to be replaced.
      const outIds = [...new Set(snap.physics.settings.flatMap((s) => s.outputs.map((o) => o.parameterId)))];
      snapClip.tracks = snapClip.tracks.filter((t) => !outIds.includes(t.parameterId));
      const frames = simulateClip(snap, snapClip, { warmup: opts.warmup ?? 1 });
      const dt = 1 / clip.fps;
      clip.tracks = clip.tracks.filter((t) => !outIds.includes(t.parameterId));
      for (const id of outIds) {
        const p = snap.parameters.find((x) => x.id === id);
        const tol = opts.tolerance ?? (p ? (p.max - p.min) * 0.002 : 0.002);
        const keys: Keyframe[] = frames.map((v, f) => ({ t: Math.round(f * dt * 1e6) / 1e6, v: v[id] ?? p?.default ?? 0, interp: 'linear' }));
        clip.tracks.push({ parameterId: id, keyframes: reduceKeys(keys, tol) });
      }
      clip.bakedFromPhysics = outIds;
    },
  };
}
