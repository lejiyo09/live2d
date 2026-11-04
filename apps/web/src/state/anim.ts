import { create } from 'zustand';
import type { AnimationClip, ParameterId } from '@l2s/editor-core';
import { defaultValues, resolveValues, type ParameterValues } from '@l2s/parameter-engine';
import { PhysicsSimulator } from '@l2s/physics-engine';
import { addClip, clipTime, newClip, sampleClip, setKey, type KeyRef } from '@l2s/animation-engine';
import { editor, log, useEditor, withExpressions } from './editor.ts';
import { evaluateModel } from '@l2s/deformer-engine';

export interface AnimState {
  clipId: string | null;
  time: number;
  playing: boolean;
  /** Realtime physics preview (spec §8: realtime vs baked). */
  physicsOn: boolean;
  selectedKeys: KeyRef[];
  /** Track shown in the curve editor. */
  curveTrack: ParameterId | null;
  exportOpen: boolean;
  exporting: { done: number; total: number } | null;
  strands: Array<Array<{ x: number; y: number }>>;
  /** Onion skin: ghosts at ±onionStep frames (spec §3.1). */
  onion: boolean;
  onionStep: number;
}

export const useAnim = create<AnimState>(() => ({
  clipId: null, time: 0, playing: false, physicsOn: false, selectedKeys: [], curveTrack: null, exportOpen: false, exporting: null, strands: [], onion: false, onionStep: 5,
}));
const set = useAnim.setState;
const get = useAnim.getState;

export function activeClip(): AnimationClip | null {
  const p = editor.project;
  const id = get().clipId;
  return p.animations.find((c) => c.id === id) ?? p.animations[0] ?? null;
}

// ------------------------------------------------------------------ runtime loop

let sim: PhysicsSimulator | null = null;
let simFor: { physics: unknown; params: unknown } | null = null;
let raf = 0;
let last = 0;

function simulator(): PhysicsSimulator {
  const p = editor.project;
  if (!sim) sim = new PhysicsSimulator(p.physics, p.parameters);
  if (simFor?.physics !== p.physics) sim.setRig(p.physics);
  if (simFor?.params !== p.parameters) sim.setParameters(p.parameters);
  simFor = { physics: p.physics, params: p.parameters };
  return sim;
}

/** Values the runtime feeds into evaluation this frame. */
function frameValues(dt: number): ParameterValues | null {
  const { playing, physicsOn } = get();
  const clip = activeClip();
  let values: ParameterValues = { ...useEditor.getState().paramValues };
  if (playing && clip) values = { ...values, ...sampleClip(clip, clipTime(clip, get().time)) };
  values = withExpressions(editor.project, values);
  if (physicsOn && editor.project.physics.settings.length) {
    const s = simulator();
    values = s.evaluate(resolveValues(editor.project, values), dt);
    set({ strands: s.strands() });
  }
  return playing || physicsOn ? values : null;
}

function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { playing } = get();
  if (playing) {
    const clip = activeClip();
    if (clip) {
      let t = get().time + dt;
      const end = clip.range?.end ?? clip.duration;
      if (t > end) {
        if (clip.loop) t = clipTime(clip, t);
        else { t = end; set({ playing: false }); }
      }
      set({ time: t });
    }
  }
  editor.setDriven(frameValues(dt));
  if (get().playing || get().physicsOn) raf = requestAnimationFrame(loop);
  else { raf = 0; editor.setDriven(null); }
}

function ensureLoop() {
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

export const animActions = {
  selectClip(id: string | null) {
    set({ clipId: id, selectedKeys: [], time: 0 });
    animActions.scrub(0);
  },
  newClip() {
    const c = newClip(`Motion ${editor.project.animations.length + 1}`, 3, 30);
    editor.run(addClip(c));
    animActions.selectClip(c.id);
    editor.setBottomTab('timeline');
  },
  play() {
    if (!activeClip()) return;
    set({ playing: true });
    ensureLoop();
  },
  pause() {
    set({ playing: false });
    animActions.scrub(get().time);
  },
  stop() {
    set({ playing: false });
    animActions.scrub(activeClip()?.range?.start ?? 0);
  },
  toggle() { if (get().playing) animActions.pause(); else animActions.play(); },
  /** Move the playhead; while paused the sliders follow the animation so edits can be keyed. */
  scrub(t: number) {
    const clip = activeClip();
    const tt = clip ? Math.min(clip.duration, Math.max(0, t)) : 0;
    set({ time: tt });
    if (clip && !get().playing) editor.setParams(sampleClip(clip, tt));
  },
  setPhysics(on: boolean) {
    set({ physicsOn: on });
    if (on) { simulator().reset(); ensureLoop(); }
    else { set({ strands: [] }); if (!get().playing) editor.setDriven(null); }
  },
  resetPhysics() { sim?.reset(); },
  /** Key the given parameters (default: those that differ from the animation / defaults) at the playhead. */
  keyCurrent(params?: ParameterId[]) {
    const clip = activeClip();
    if (!clip) { log('warn', 'Create an animation first (Timeline → New).'); return; }
    const values = useEditor.getState().paramValues;
    const sampled = sampleClip(clip, get().time);
    const defs = defaultValues(editor.project);
    const ids = params ?? editor.project.parameters.map((p) => p.id).filter((id) => {
      const v = values[id]!;
      return id in sampled ? Math.abs(sampled[id]! - v) > 1e-6 : Math.abs(defs[id]! - v) > 1e-6;
    });
    if (!ids.length) { log('info', 'Nothing to key: no parameter differs from the animation at this time.'); return; }
    editor.run({
      label: ids.length === 1 ? 'Set Key' : `Set Keys (${ids.length})`,
      apply(d) { for (const id of ids) setKey(clip.id, id, get().time, values[id]!).apply(d); },
    });
  },
  selectKeys(refs: KeyRef[], additive = false) {
    set({ selectedKeys: additive ? [...get().selectedKeys, ...refs.filter((r) => !get().selectedKeys.some((s) => s.parameterId === r.parameterId && Math.abs(s.t - r.t) < 1e-6))] : refs });
  },
  setCurveTrack(id: ParameterId | null) { set({ curveTrack: id }); },
  openExport(v: boolean) { set({ exportOpen: v }); },
  toggleOnion() { set({ onion: !get().onion }); updateOnion(); },
  setOnionStep(n: number) { set({ onionStep: Math.max(1, Math.round(n)) }); updateOnion(); },
};

/** Recompute onion-skin ghosts (past = red, future = green), only while paused. */
function updateOnion() {
  const r = editor.renderer;
  const clip = activeClip();
  const { onion, onionStep, time, playing } = get();
  if (!r) return;
  if (!onion || !clip || playing) { r.setOnionSkin([]); return; }
  const p = editor.project;
  const base = useEditor.getState().paramValues;
  const ghosts = [] as Array<{ meshes: Map<string, Float32Array>; color: number; alpha: number }>;
  for (const [k, color] of [[-1, 0xff5a6e], [1, 0x6eff8f]] as const) {
    for (let n = 1; n <= 2; n++) {
      const t = time + (k * n * onionStep) / clip.fps;
      if (t < 0 || t > clip.duration) continue;
      const model = evaluateModel(p, { ...base, ...sampleClip(clip, t) });
      ghosts.push({ meshes: new Map([...model.meshes].map(([id, m]) => [id, m.positions])), color, alpha: n === 1 ? 0.7 : 0.35 });
    }
  }
  r.setOnionSkin(ghosts);
}

useAnim.subscribe((s, prev) => { if (s.time !== prev.time || s.playing !== prev.playing || s.clipId !== prev.clipId) updateOnion(); });
useEditor.subscribe((s, prev) => { if (s.project !== prev.project && useAnim.getState().onion) updateOnion(); });

// Keep the selected clip valid after undo / delete.
useEditor.subscribe((s, prev) => {
  if (s.project.animations === prev.project.animations) return;
  const id = get().clipId;
  if (id && !s.project.animations.some((c) => c.id === id)) set({ clipId: s.project.animations[0]?.id ?? null, selectedKeys: [] });
  else if (!id && s.project.animations[0]) set({ clipId: s.project.animations[0].id });
});

if (import.meta.env.DEV) {
  const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
  if (g.__l2s) Object.assign(g.__l2s, { useAnim, animActions });
}
