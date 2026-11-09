import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { createEmptyProject, type AnimationClip } from '@l2s/editor-core';
import { STANDARD_PARAMETERS } from '@l2s/parameter-engine';
import { evaluateTrack } from '@l2s/animation-engine';
import { PhysicsSimulator, newPhysicsSetting } from '@l2s/physics-engine';
import { buildInteropBundle, clipToMotion3, motion3ToClip, physics3ToRig, rigToPhysics3, projectToCdi3 } from '@l2s/cubism-adapter';

const clip: AnimationClip = {
  id: 'c', name: 'Turn', duration: 2, fps: 30, loop: true,
  tracks: [
    { parameterId: 'ParamAngleX', keyframes: [
      { t: 0, v: 0, interp: 'bezier', out: [1 / 3, 0] },
      { t: 1, v: 30, interp: 'bezier', in: [1 / 3, 0], out: [0.42, 5] },
      { t: 2, v: 0, interp: 'linear', in: [0.2, -3] },
    ] },
    { parameterId: 'ParamEyeLOpen', keyframes: [{ t: 0, v: 1, interp: 'step' }, { t: 1.5, v: 0, interp: 'linear' }, { t: 1.7, v: 1, interp: 'linear' }] },
    { parameterId: 'ParamMouthForm', keyframes: [{ t: 0, v: 0.5, interp: 'linear' }] },
  ],
};

describe('motion3.json', () => {
  it('writes spec-conformant segments and meta counts', () => {
    const m = clipToMotion3(clip);
    expect(m.Version).toBe(3);
    expect(m.Meta.AreBeziersRestricted).toBe(false); // custom handles present
    expect(m.Meta.CurveCount).toBe(3);
    // ParamAngleX: P0 + bezier(3 pts) + bezier(3 pts) = 7 points, 2 segments
    expect(m.Curves[0]!.Segments.slice(0, 3)).toEqual([0, 0, 1]);
    expect(m.Curves[0]!.Segments.slice(3, 9)).toEqual([0.333333, 0, 0.666667, 30, 1, 30]);
    expect(m.Curves[1]!.Segments).toEqual([0, 1, 2, 1.5, 0, 0, 1.7, 1]);
    expect(m.Curves[2]!.Segments).toEqual([0, 0.5, 0, 2, 0.5]); // single key → held
    expect(m.Meta.TotalSegmentCount).toBe(2 + 2 + 1);
    expect(m.Meta.TotalPointCount).toBe(7 + 3 + 2);
  });

  it('round-trips to identical curves', () => {
    const { clip: back } = motion3ToClip(JSON.parse(JSON.stringify(clipToMotion3(clip))), 'Turn');
    for (const tr of clip.tracks) {
      const b = back.tracks.find((x) => x.parameterId === tr.parameterId)!;
      for (let t = 0; t <= 2; t += 0.05) expect(evaluateTrack(b, t)).toBeCloseTo(evaluateTrack(tr, t)!, 4);
    }
  });

  it('imports inverse-stepped segments and skips non-parameter curves', () => {
    const { clip: c, skipped } = motion3ToClip({
      Version: 3, Meta: { Duration: 1, Fps: 30, CurveCount: 2, TotalSegmentCount: 2, TotalPointCount: 4 },
      Curves: [{ Target: 'Model', Id: 'Opacity', Segments: [0, 1, 0, 1, 1] }, { Target: 'Parameter', Id: 'P', Segments: [0, 0, 3, 1, 5] }],
    }, 'x');
    expect(skipped).toEqual(['Model:Opacity']);
    expect(evaluateTrack(c.tracks[0]!, 0.5)).toBe(5);
    expect(() => motion3ToClip({ Version: 2 }, 'x')).toThrow();
  });
});

describe('physics3.json', () => {
  it('round-trips and simulates identically', () => {
    const params = [...STANDARD_PARAMETERS.map((x) => ({ ...x })), { id: 'ParamHairFront', name: '', min: -1, max: 1, default: 0 }];
    const rig = { fps: 30, gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 }, settings: [newPhysicsSetting('a', 'Front', 'ParamHairFront')] };
    const json = rigToPhysics3(rig);
    expect(json.Meta).toMatchObject({ PhysicsSettingCount: 1, TotalInputCount: 2, TotalOutputCount: 1, VertexCount: 2 });
    const { rig: back } = physics3ToRig(JSON.parse(JSON.stringify(json)));
    const a = new PhysicsSimulator(rig, params), b = new PhysicsSimulator(back, params);
    for (let i = 0; i < 60; i++) {
      const v = { ParamAngleX: 30 * Math.sin(i / 8) };
      expect(b.evaluate(v, 1 / 60).ParamHairFront).toBeCloseTo(a.evaluate(v, 1 / 60).ParamHairFront!, 10);
    }
  });
});

describe('interop bundle', () => {
  it('contains physics3, cdi3, motion3 and a README, never a moc3', async () => {
    const p = createEmptyProject('My Char');
    p.parameters = STANDARD_PARAMETERS.map((x) => ({ ...x }));
    p.physics.settings = [newPhysicsSetting('a', 'Front', 'ParamAngleZ')];
    p.animations = [clip, { ...clip, id: 'd' }];
    const { zip, report } = await buildInteropBundle(p);
    const files = Object.keys(unzipSync(zip)).sort();
    expect(files).toEqual(['My_Char.cdi3.json', 'My_Char.physics3.json', 'README.txt', 'motions/Turn.motion3.json', 'motions/Turn_.motion3.json']);
    expect(report.files.some((f) => f.endsWith('.moc3') || f.endsWith('model3.json'))).toBe(false);
    expect(JSON.parse(strFromU8(unzipSync(zip)['My_Char.cdi3.json']!)).Parameters).toHaveLength(STANDARD_PARAMETERS.length);
    expect(projectToCdi3(p).Version).toBe(3);
  });
});

// Optional check against official sample files (not committed; set CUBISM_SAMPLES to a folder with Haru files).
const SAMPLES = process.env.CUBISM_SAMPLES;
describe.skipIf(!SAMPLES || !existsSync(`${SAMPLES}/Haru.physics3.json`))('official sample files', () => {
  it('imports Haru physics3 and motions and re-exports equivalent curves', () => {
    const { rig } = physics3ToRig(JSON.parse(readFileSync(`${SAMPLES}/Haru.physics3.json`, 'utf8')));
    expect(rig.settings.length).toBeGreaterThan(0);
    for (const f of ['haru_g_idle', 'haru_g_m15']) {
      const src = JSON.parse(readFileSync(`${SAMPLES}/motions/${f}.motion3.json`, 'utf8'));
      const { clip: c } = motion3ToClip(src, f);
      const again = motion3ToClip(JSON.parse(JSON.stringify(clipToMotion3(c))), f).clip;
      for (const tr of c.tracks) {
        const b = again.tracks.find((x) => x.parameterId === tr.parameterId)!;
        for (let t = 0; t <= c.duration; t += c.duration / 50) expect(evaluateTrack(b, t)).toBeCloseTo(evaluateTrack(tr, t)!, 3);
      }
      expect(c.tracks.length).toBe(src.Curves.filter((x: { Target: string }) => x.Target === 'Parameter').length);
    }
  });
  it.skipIf(!existsSync(`${SAMPLES}/expressions/F01.exp3.json`))('imports and re-exports Haru F01 expression', async () => {
    const { exp3ToExpression, expressionToExp3 } = await import('@l2s/cubism-adapter');
    const src = JSON.parse(readFileSync(`${SAMPLES}/expressions/F01.exp3.json`, 'utf8'));
    const ex = exp3ToExpression(src, 'F01');
    expect(ex.parameters.length).toBe(src.Parameters.length);
    const out = expressionToExp3(ex);
    expect(out.Parameters.map((p) => [p.Id, p.Value, p.Blend])).toEqual(src.Parameters.map((p: { Id: string; Value: number; Blend?: string }) => [p.Id, p.Value, p.Blend ?? 'Add']));
  });
});

describe('expressions (exp3.json)', () => {
  it('applies Add / Multiply / Overwrite like the runtime and round-trips exp3', async () => {
    const { applyExpressions, captureExpression } = await import('@l2s/parameter-engine');
    const { expressionToExp3, exp3ToExpression } = await import('@l2s/cubism-adapter');
    const params = [
      { id: 'A', name: '', min: -10, max: 10, default: 0 },
      { id: 'B', name: '', min: 0, max: 10, default: 1 },
      { id: 'C', name: '', min: 0, max: 1, default: 1 },
    ];
    const ex = { id: 'e', name: 'smile', parameters: [
      { parameterId: 'A', value: 2, blend: 'Add' as const },
      { parameterId: 'B', value: 3, blend: 'Multiply' as const },
      { parameterId: 'C', value: 0, blend: 'Overwrite' as const },
    ] };
    expect(applyExpressions({ A: 1, B: 2, C: 1 }, [{ expression: ex, weight: 1 }], params)).toEqual({ A: 3, B: 6, C: 0 });
    expect(applyExpressions({ A: 1, B: 2, C: 1 }, [{ expression: ex, weight: 0.5 }], params)).toEqual({ A: 2, B: 4, C: 0.5 });
    expect(applyExpressions({ A: 9 }, [{ expression: ex, weight: 1 }], params).A).toBe(10); // clamped
    const json = expressionToExp3({ ...ex, fadeIn: 0.5 });
    expect(json).toMatchObject({ Type: 'Live2D Expression', FadeInTime: 0.5, Parameters: [{ Id: 'A', Value: 2, Blend: 'Add' }, { Id: 'B', Value: 3, Blend: 'Multiply' }, { Id: 'C', Value: 0, Blend: 'Overwrite' }] });
    const back = exp3ToExpression(JSON.parse(JSON.stringify(json)), 'smile');
    expect(back.parameters).toEqual(ex.parameters);
    expect(exp3ToExpression({ Type: 'Live2D Expression', Parameters: [{ Id: 'A', Value: 1 }] }, 'x').parameters[0]!.blend).toBe('Add'); // default blend
    expect(captureExpression({ A: 2, B: 1, C: 0.5 }, params)).toEqual([{ parameterId: 'A', value: 2, blend: 'Add' }, { parameterId: 'C', value: -0.5, blend: 'Add' }]);
  });
});
