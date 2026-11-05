import { newId, type AnimationClip, type Command, type Keyframe, type Project, type Scene } from '@l2s/editor-core';
import type { ParameterValues } from '@l2s/parameter-engine';
import { clipTime, evaluateTrack } from './curve.ts';
import { reduceKeys } from './bake.ts';

/** Values of all clips active at scene time `t` (later tracks / later starts override). */
export function sampleScene(project: Pick<Project, 'animations'>, scene: Scene, t: number): ParameterValues {
  const clips = new Map(project.animations.map((c) => [c.id, c]));
  const out: ParameterValues = {};
  const active = scene.entries
    .filter((e) => { const c = clips.get(e.clipId); return c && t >= e.start && t <= e.start + c.duration; })
    .sort((a, b) => a.track - b.track || a.start - b.start);
  for (const e of active) {
    const c = clips.get(e.clipId)!;
    const local = t - e.start;
    for (const tr of c.tracks) {
      const v = evaluateTrack(tr, local);
      if (v !== undefined) out[tr.parameterId] = v;
    }
  }
  return out;
}

export function sceneTime(scene: Scene, t: number) {
  return clipTime({ duration: scene.duration, loop: scene.loop } as AnimationClip, t);
}

/** Flatten a scene into one clip (for export, baking, motion3). Sampled per frame, then reduced. */
export function flattenScene(project: Project, scene: Scene, tolerance = 1e-3): AnimationClip {
  const frames = Math.round(scene.duration * scene.fps) + 1;
  const samples: ParameterValues[] = [];
  for (let f = 0; f < frames; f++) samples.push(sampleScene(project, scene, f / scene.fps));
  const ids = new Set(samples.flatMap((s) => Object.keys(s)));
  const tracks = [...ids].map((parameterId) => {
    let last = project.parameters.find((p) => p.id === parameterId)?.default ?? 0;
    const keys: Keyframe[] = samples.map((s, f) => { if (s[parameterId] !== undefined) last = s[parameterId]!; return { t: Math.round((f / scene.fps) * 1e6) / 1e6, v: last, interp: 'linear' }; });
    return { parameterId, keyframes: reduceKeys(keys, tolerance) };
  });
  return { id: newId('clip'), name: `${scene.name} (flattened)`, duration: scene.duration, fps: scene.fps, loop: scene.loop, tracks };
}

export function addScene(name: string, fps = 30): { command: Command; id: string } {
  const id = newId('scene');
  return { id, command: { label: 'New Scene', apply(d) { d.scenes.push({ id, name, duration: 5, fps, loop: false, entries: [] }); } } };
}

export function deleteScene(id: string): Command {
  return { label: 'Delete Scene', apply(d) { d.scenes = d.scenes.filter((s) => s.id !== id); } };
}

export function setSceneProps(id: string, patch: Partial<Pick<Scene, 'name' | 'duration' | 'fps' | 'loop'>>): Command {
  return { label: 'Edit Scene', apply(d) { const s = d.scenes.find((x) => x.id === id); if (s) Object.assign(s, patch); } };
}

/** Place a clip in a scene (spec §9.1 클립 배치). Extends the scene if needed. */
export function addSceneEntry(sceneId: string, clipId: string, start: number, track: number): { command: Command; id: string } {
  const id = newId('entry');
  return {
    id,
    command: {
      label: 'Add Clip to Scene',
      apply(d) {
        const s = d.scenes.find((x) => x.id === sceneId);
        const c = d.animations.find((x) => x.id === clipId);
        if (!s || !c) return;
        s.entries.push({ id, clipId, start: Math.max(0, start), track: Math.max(0, track) });
        s.duration = Math.max(s.duration, start + c.duration);
      },
    },
  };
}

/** Move an entry in time / to another track (spec §9.1 클립 이동). */
export function moveSceneEntry(sceneId: string, entryId: string, start: number, track: number, mergeKey?: string): Command {
  return {
    label: 'Move Clip',
    mergeKey,
    apply(d) {
      const s = d.scenes.find((x) => x.id === sceneId);
      const e = s?.entries.find((x) => x.id === entryId);
      if (!s || !e) return;
      e.start = Math.max(0, Math.round(start * s.fps) / s.fps);
      e.track = Math.max(0, Math.round(track));
      const c = d.animations.find((x) => x.id === e.clipId);
      if (c) s.duration = Math.max(s.duration, e.start + c.duration);
    },
  };
}

export function removeSceneEntry(sceneId: string, entryId: string): Command {
  return { label: 'Remove Clip from Scene', apply(d) { const s = d.scenes.find((x) => x.id === sceneId); if (s) s.entries = s.entries.filter((e) => e.id !== entryId); } };
}
