import { newId, type AnimationClip, type AnimationTrack, type Command, type Keyframe, type ParameterId, type Project } from '@l2s/editor-core';
import { PRESET_HANDLES, type CurvePreset } from './curve.ts';

export interface KeyRef { parameterId: ParameterId; t: number }

const EPS = 1e-6;

function clipOf(d: Project, id: string): AnimationClip {
  const c = d.animations.find((x) => x.id === id);
  if (!c) throw new Error('Animation clip not found');
  return c;
}

function trackOf(c: AnimationClip, pid: ParameterId, create = false): AnimationTrack | undefined {
  let tr = c.tracks.find((x) => x.parameterId === pid);
  if (!tr && create) { tr = { parameterId: pid, keyframes: [] }; c.tracks.push(tr); }
  return tr;
}

/** Snap to the clip's frame grid. */
export function snapTime(c: Pick<AnimationClip, 'fps'>, t: number) {
  return Math.round(t * c.fps) / c.fps;
}

export function newClip(name: string, duration = 3, fps = 30): AnimationClip {
  return { id: newId('clip'), name, duration, fps, loop: true, tracks: [] };
}

export function addClip(clip: AnimationClip): Command {
  return { label: 'New Animation', apply(d) { d.animations.push(structuredClone(clip)); } };
}

/** Copy a clip (spec §9.1 클립 복사). */
export function duplicateClip(id: string, newClipId = newId('clip')): { command: Command; id: string } {
  return {
    id: newClipId,
    command: {
      label: 'Duplicate Animation',
      apply(d) {
        const c = clipOf(d, id);
        const i = d.animations.indexOf(c);
        d.animations.splice(i + 1, 0, { ...(JSON.parse(JSON.stringify(c)) as AnimationClip), id: newClipId, name: `${c.name} copy` });
      },
    },
  };
}

export function deleteClip(id: string): Command {
  return {
    label: 'Delete Animation',
    apply(d) {
      d.animations = d.animations.filter((c) => c.id !== id);
      for (const s of d.scenes ?? []) s.entries = s.entries.filter((e) => e.clipId !== id);
    },
  };
}

export function setClipProps(id: string, patch: Partial<Pick<AnimationClip, 'name' | 'fps' | 'loop' | 'range'>>): Command {
  return {
    label: 'Edit Animation',
    apply(d) {
      const c = clipOf(d, id);
      Object.assign(c, patch);
      if (patch.range === undefined && 'range' in patch) delete c.range;
    },
  };
}

/**
 * Change clip length (spec §9.1 클립 길이 변경). With `scale`, key times are
 * stretched proportionally; otherwise the clip is extended/trimmed and keys
 * beyond the new end are removed.
 */
export function setClipDuration(id: string, duration: number, scale: boolean): Command {
  return {
    label: scale ? 'Scale Animation' : 'Set Animation Length',
    apply(d) {
      const c = clipOf(d, id);
      const k = duration / c.duration;
      for (const tr of c.tracks) {
        if (scale) for (const kf of tr.keyframes) kf.t = snapTime(c, kf.t * k);
        else tr.keyframes = tr.keyframes.filter((kf) => kf.t <= duration + EPS);
        dedupe(tr);
      }
      if (c.range) c.range = { start: Math.min(c.range.start * (scale ? k : 1), duration), end: Math.min(c.range.end * (scale ? k : 1), duration) };
      c.duration = duration;
    },
  };
}

/** Insert or replace a key at time t (spec §9.1 키프레임). New keys continue the curve type of the key before them. */
export function setKey(clipId: string, parameterId: ParameterId, t: number, v: number): Command {
  return {
    label: 'Set Key',
    apply(d) {
      const c = clipOf(d, clipId);
      const tt = Math.min(c.duration, Math.max(0, snapTime(c, t)));
      const tr = trackOf(c, parameterId, true)!;
      const ex = tr.keyframes.find((k) => Math.abs(k.t - tt) < EPS);
      if (ex) { ex.v = v; return; }
      const before = [...tr.keyframes].reverse().find((k) => k.t < tt);
      tr.keyframes.push({ t: tt, v, interp: before?.interp ?? 'bezier', ...(before?.interp === 'bezier' ? { out: [1 / 3, 0] as [number, number], in: [1 / 3, 0] as [number, number] } : {}) });
      tr.keyframes.sort((a, b) => a.t - b.t);
    },
  };
}

export function deleteKeys(clipId: string, refs: KeyRef[]): Command {
  return {
    label: 'Delete Keys',
    apply(d) {
      const c = clipOf(d, clipId);
      for (const r of refs) {
        const tr = trackOf(c, r.parameterId);
        if (tr) tr.keyframes = tr.keyframes.filter((k) => Math.abs(k.t - r.t) >= EPS);
      }
      c.tracks = c.tracks.filter((tr) => tr.keyframes.length);
    },
  };
}

export function deleteTrack(clipId: string, parameterId: ParameterId): Command {
  return { label: 'Delete Track', apply(d) { const c = clipOf(d, clipId); c.tracks = c.tracks.filter((t) => t.parameterId !== parameterId); } };
}

/** Move keys in time/value; keys landing on an existing key replace it. Returns the new refs via `onRefs`. */
export function moveKeys(clipId: string, refs: KeyRef[], dt: number, dv: number, mergeKey?: string): Command {
  return {
    label: 'Move Keys',
    mergeKey,
    apply(d) {
      const c = clipOf(d, clipId);
      for (const pid of new Set(refs.map((r) => r.parameterId))) {
        const tr = trackOf(c, pid);
        if (!tr) continue;
        const times = refs.filter((r) => r.parameterId === pid).map((r) => r.t);
        const moving = tr.keyframes.filter((k) => times.some((t) => Math.abs(k.t - t) < EPS));
        const staying = tr.keyframes.filter((k) => !moving.includes(k));
        for (const k of moving) { k.t = Math.min(c.duration, Math.max(0, snapTime(c, k.t + dt))); k.v += dv; }
        tr.keyframes = [...staying.filter((s) => !moving.some((m) => Math.abs(m.t - s.t) < EPS)), ...moving].sort((a, b) => a.t - b.t);
        dedupe(tr);
      }
    },
  };
}

/** Set the interpolation of segments starting at the given keys (spec §9.2). */
export function setInterpolation(clipId: string, refs: KeyRef[], preset: CurvePreset): Command {
  return {
    label: `Curve: ${preset}`,
    apply(d) {
      const c = clipOf(d, clipId);
      for (const r of refs) {
        const tr = trackOf(c, r.parameterId);
        if (!tr) continue;
        const i = tr.keyframes.findIndex((k) => Math.abs(k.t - r.t) < EPS);
        const k = tr.keyframes[i];
        if (!k) continue;
        if (preset === 'linear' || preset === 'step') { k.interp = preset; continue; }
        k.interp = 'bezier';
        k.out = [...PRESET_HANDLES[preset].out];
        const next = tr.keyframes[i + 1];
        if (next) next.in = [...PRESET_HANDLES[preset].in];
      }
    },
  };
}

/** Edit Bezier handles (custom curve). */
export function setHandles(clipId: string, ref: KeyRef, patch: { out?: [number, number]; in?: [number, number] }, mergeKey?: string): Command {
  return {
    label: 'Edit Curve',
    mergeKey,
    apply(d) {
      const tr = trackOf(clipOf(d, clipId), ref.parameterId);
      const k = tr?.keyframes.find((x) => Math.abs(x.t - ref.t) < EPS);
      if (!k) return;
      const clamp = (h: [number, number]): [number, number] => [Math.min(1, Math.max(0, h[0])), h[1]];
      if (patch.out) { k.out = clamp(patch.out); k.interp = 'bezier'; }
      if (patch.in) k.in = clamp(patch.in);
    },
  };
}

function dedupe(tr: AnimationTrack) {
  const out: Keyframe[] = [];
  for (const k of tr.keyframes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - k.t) < EPS) out[out.length - 1] = k; else out.push(k);
  }
  tr.keyframes = out;
}
