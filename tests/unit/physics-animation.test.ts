import { describe, expect, it } from 'vitest';
import { CommandHistory, createEmptyProject, type Parameter, type Project } from '@l2s/editor-core';
import { STANDARD_PARAMETERS } from '@l2s/parameter-engine';
import { PhysicsSimulator, newPhysicsSetting, normalizeParameterValue } from '@l2s/physics-engine';
import {
  addClip, bakePhysics, bezierAt, clipTime, deleteKeys, duplicateClip, evaluateTrack, moveKeys, newClip, reduceKeys, setClipDuration,
  setInterpolation, setKey, simulateClip,
} from '@l2s/animation-engine';

const hair: Parameter = { id: 'ParamHairFront', name: 'Hair', min: -1, max: 1, default: 0 };
function proj(): Project {
  const p = createEmptyProject('p');
  p.parameters = [...STANDARD_PARAMETERS.map((x) => ({ ...x })), hair];
  p.physics.settings = [newPhysicsSetting('s1', 'Front hair', 'ParamHairFront')];
  return p;
}

describe('physics', () => {
  it('normalizes around the centre of the parameter range, negated unless reflected', () => {
    const r = { min: -10, default: 0, max: 10 };
    expect(normalizeParameterValue(30, -30, 30, r, false)).toBeCloseTo(-10);
    expect(normalizeParameterValue(15, -30, 30, r, true)).toBeCloseTo(5);
    expect(normalizeParameterValue(0.5, 0, 1, r, true)).toBeCloseTo(0); // centre of 0..1, not its default
  });

  it('swings after a head turn, then settles back to rest', () => {
    const p = proj();
    const sim = new PhysicsSimulator(p.physics, p.parameters);
    const dt = 1 / 60;
    const vals: number[] = [];
    for (let i = 0; i < 20; i++) sim.evaluate({ ParamAngleX: 0 }, dt);
    for (let i = 0; i < 600; i++) vals.push(sim.evaluate({ ParamAngleX: 30 }, dt).ParamHairFront!);
    const peak = vals.slice(0, 120).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    expect(Math.abs(peak)).toBeGreaterThan(0.2);
    // Damped: oscillation reverses sign at least once, and the end value is near rest.
    expect(vals.slice(0, 200).some((v) => Math.sign(v) === -Math.sign(peak) && Math.abs(v) > 0.01)).toBe(true);
    expect(Math.abs(vals.at(-1)!)).toBeLessThan(0.05);
  });

  it('is deterministic and independent of frame slicing at step boundaries', () => {
    const p = proj();
    const a = new PhysicsSimulator(p.physics, p.parameters), b = new PhysicsSimulator(p.physics, p.parameters);
    let va = 0, vb = 0;
    for (let i = 0; i < 90; i++) va = a.evaluate({ ParamAngleX: 30 * Math.sin(i / 10) }, 1 / 30).ParamHairFront!;
    for (let i = 0; i < 90; i++) { b.evaluate({ ParamAngleX: 30 * Math.sin(i / 10) }, 1 / 60); vb = b.evaluate({ ParamAngleX: 30 * Math.sin(i / 10) }, 1 / 60).ParamHairFront!; }
    expect(vb).toBeCloseTo(va, 2);
  });
});

describe('animation curves', () => {
  it('evaluates linear, step and bezier presets', () => {
    const tr = { parameterId: 'X', keyframes: [{ t: 0, v: 0, interp: 'linear' as const }, { t: 1, v: 10, interp: 'linear' as const }] };
    expect(evaluateTrack(tr, 0.25)).toBeCloseTo(2.5);
    expect(evaluateTrack(tr, -1)).toBe(0);
    expect(evaluateTrack({ ...tr, keyframes: [{ ...tr.keyframes[0]!, interp: 'step' }, tr.keyframes[1]!] }, 0.99)).toBe(0);
    const easeInOut = bezierAt({ t: 0, v: 0, interp: 'bezier', out: [0.42, 0] }, { t: 1, v: 1, interp: 'linear', in: [0.42, 0] }, 0.5);
    expect(easeInOut).toBeCloseTo(0.5, 5);
    const easeIn = bezierAt({ t: 0, v: 0, interp: 'bezier', out: [0.42, 0] }, { t: 1, v: 1, interp: 'linear', in: [0, 0] }, 0.25);
    expect(easeIn).toBeLessThan(0.15);
  });

  it('clip editing: keys, move, interpolation, duplicate, length, loop', () => {
    const p = proj();
    const h = new CommandHistory(p);
    const clip = newClip('idle', 2, 30);
    h.execute(addClip(clip));
    h.execute(setKey(clip.id, 'ParamAngleX', 0, 0));
    h.execute(setKey(clip.id, 'ParamAngleX', 1.01, 30)); // snapped to the frame grid
    h.execute(setKey(clip.id, 'ParamAngleX', 2, 0));
    const tr = () => h.project.animations[0]!.tracks[0]!;
    expect(tr().keyframes.map((k) => k.t)).toEqual([0, 1, 2]);
    h.execute(setInterpolation(clip.id, [{ parameterId: 'ParamAngleX', t: 0 }], 'linear'));
    expect(evaluateTrack(tr(), 0.5)).toBeCloseTo(15);
    h.execute(moveKeys(clip.id, [{ parameterId: 'ParamAngleX', t: 1 }], 0.5, -10, 'drag'));
    expect(tr().keyframes.map((k) => [k.t, k.v])).toEqual([[0, 0], [1.5, 20], [2, 0]]);
    h.execute(moveKeys(clip.id, [{ parameterId: 'ParamAngleX', t: 1.5 }], 0.5, 0)); // lands on the last key → replaces it
    expect(tr().keyframes.map((k) => [k.t, k.v])).toEqual([[0, 0], [2, 20]]);
    h.execute(setClipDuration(clip.id, 4, true));
    expect(tr().keyframes.map((k) => k.t)).toEqual([0, 4]);
    const dup = duplicateClip(clip.id);
    h.execute(dup.command);
    expect(h.project.animations.map((c) => c.name)).toEqual(['idle', 'idle copy']);
    h.execute(deleteKeys(dup.id, [{ parameterId: 'ParamAngleX', t: 0 }, { parameterId: 'ParamAngleX', t: 4 }]));
    expect(h.project.animations[1]!.tracks).toEqual([]);
    expect(clipTime(h.project.animations[0]!, 5)).toBeCloseTo(1);
  });

  it('bakes physics into reduced keyframes', () => {
    const p = proj();
    const h = new CommandHistory(p);
    const clip = newClip('turn', 3, 30);
    h.execute(addClip(clip));
    h.execute(setKey(clip.id, 'ParamAngleX', 0, 0));
    h.execute(setKey(clip.id, 'ParamAngleX', 0.5, 30));
    h.execute(setKey(clip.id, 'ParamAngleX', 3, 30));
    h.execute(bakePhysics(clip.id));
    const c = h.project.animations[0]!;
    const baked = c.tracks.find((t) => t.parameterId === 'ParamHairFront')!;
    expect(c.bakedFromPhysics).toEqual(['ParamHairFront']);
    expect(baked.keyframes.length).toBeGreaterThan(4);
    expect(baked.keyframes.length).toBeLessThan(91);
    // Baked curve reproduces the simulation (without physics re-applied).
    const live = simulateClip({ ...h.project, animations: [] }, { ...c, tracks: c.tracks.filter((t) => t !== baked) });
    for (let f = 0; f < live.length; f += 7) expect(evaluateTrack(baked, f / 30)).toBeCloseTo(live[f]!.ParamHairFront!, 1);
    expect(reduceKeys([{ t: 0, v: 0, interp: 'linear' }, { t: 1, v: 1, interp: 'linear' }, { t: 2, v: 2, interp: 'linear' }], 1e-6)).toHaveLength(2);
  });
});

describe('scenes (multi-clip timeline)', () => {
  it('places clips on tracks, later tracks override, flattens to one clip', async () => {
    const { addScene, addSceneEntry, moveSceneEntry, sampleScene, flattenScene, deleteClip } = await import('@l2s/animation-engine');
    const h = new CommandHistory(proj());
    const a = newClip('turn', 2, 30), b = newClip('nod', 1, 30);
    h.execute(addClip(a)); h.execute(addClip(b));
    h.execute(setKey(a.id, 'ParamAngleX', 0, 0)); h.execute(setKey(a.id, 'ParamAngleX', 2, 30));
    h.execute(setInterpolation(a.id, [{ parameterId: 'ParamAngleX', t: 0 }], 'linear'));
    h.execute(setKey(b.id, 'ParamAngleX', 0, -10)); h.execute(setKey(b.id, 'ParamAngleY', 0, 5));
    const sc = addScene('Intro');
    h.execute(sc.command);
    const e1 = addSceneEntry(sc.id, a.id, 0, 0); h.execute(e1.command);
    const e2 = addSceneEntry(sc.id, b.id, 3, 1); h.execute(e2.command);
    const s = () => h.project.scenes[0]!;
    expect(s().duration).toBe(5);
    expect(sampleScene(h.project, s(), 1).ParamAngleX).toBeCloseTo(15);
    expect(sampleScene(h.project, s(), 2.5)).toEqual({}); // gap
    expect(sampleScene(h.project, s(), 3.5)).toEqual({ ParamAngleX: -10, ParamAngleY: 5 });
    // Move the nod over the turn on a higher track: it overrides AngleX there.
    h.execute(moveSceneEntry(sc.id, e2.id, 1, 1));
    expect(sampleScene(h.project, s(), 1.5).ParamAngleX).toBe(-10);
    const flat = flattenScene(h.project, s());
    expect(evaluateTrack(flat.tracks.find((t) => t.parameterId === 'ParamAngleX')!, 0.5)).toBeCloseTo(7.5, 1);
    expect(evaluateTrack(flat.tracks.find((t) => t.parameterId === 'ParamAngleX')!, 1.5)).toBeCloseTo(-10, 1);
    h.execute(deleteClip(b.id));
    expect(h.project.scenes[0]!.entries).toHaveLength(1);
  });
});
