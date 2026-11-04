import type { AnimationClip, AnimationTrack, Keyframe } from '@l2s/editor-core';
import { newId } from '@l2s/editor-core';

/**
 * motion3.json (Cubism motion, Version 3) ⇄ AnimationClip.
 * Spec: Live2D/CubismSpecs FileFormats/motion3.json.md.
 *
 * Segments are flattened: first point (t, v), then per segment an id
 * (0 linear, 1 bezier, 2 stepped, 3 inverse stepped) followed by 1 point
 * (or 3 points P1, P2, P3 for bezier).
 */
export interface Motion3 {
  Version: 3;
  Meta: {
    Duration: number;
    Fps: number;
    Loop?: boolean;
    AreBeziersRestricted?: boolean;
    FadeInTime?: number;
    FadeOutTime?: number;
    CurveCount: number;
    TotalSegmentCount: number;
    TotalPointCount: number;
    UserDataCount?: number;
    TotalUserDataSize?: number;
  };
  Curves: Array<{ Target: 'Model' | 'Parameter' | 'PartOpacity'; Id: string; FadeInTime?: number; FadeOutTime?: number; Segments: number[] }>;
  UserData?: Array<{ Time: number; Value: string }>;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const isRestricted = (k: Keyframe, next: Keyframe) =>
  Math.abs((k.out?.[0] ?? 1 / 3) - 1 / 3) < 1e-6 && Math.abs((next.in?.[0] ?? 1 / 3) - 1 / 3) < 1e-6;

export function clipToMotion3(clip: AnimationClip, opts: { fadeIn?: number; fadeOut?: number } = {}): Motion3 {
  let segs = 0, points = 0;
  let restricted = true;
  const curves: Motion3['Curves'] = [];
  for (const tr of clip.tracks) {
    const k = tr.keyframes;
    if (!k.length) continue;
    const s: number[] = [r6(k[0]!.t), r6(k[0]!.v)];
    points++;
    if (k.length === 1) {
      // Curves can't be empty: hold the single value over the whole motion.
      s.push(0, r6(clip.duration), r6(k[0]!.v));
      segs++; points++;
    }
    for (let i = 0; i + 1 < k.length; i++) {
      const a = k[i]!, b = k[i + 1]!;
      const T = b.t - a.t;
      if (a.interp === 'bezier') {
        if (!isRestricted(a, b)) restricted = false;
        const o = a.out ?? [1 / 3, 0], n = b.in ?? [1 / 3, 0];
        s.push(1, r6(a.t + o[0] * T), r6(a.v + o[1]), r6(b.t - n[0] * T), r6(b.v + n[1]), r6(b.t), r6(b.v));
        points += 3;
      } else if (a.interp === 'step') {
        s.push(2, r6(b.t), r6(b.v));
        points++;
      } else {
        s.push(0, r6(b.t), r6(b.v));
        points++;
      }
      segs++;
    }
    curves.push({ Target: 'Parameter', Id: tr.parameterId, Segments: s });
  }
  return {
    Version: 3,
    Meta: {
      Duration: r6(clip.duration), Fps: clip.fps, Loop: clip.loop, AreBeziersRestricted: restricted,
      ...(opts.fadeIn !== undefined ? { FadeInTime: opts.fadeIn } : {}),
      ...(opts.fadeOut !== undefined ? { FadeOutTime: opts.fadeOut } : {}),
      CurveCount: curves.length, TotalSegmentCount: segs, TotalPointCount: points,
    },
    Curves: curves,
  };
}

export class Motion3Error extends Error {}

/**
 * Import a motion3.json. Parameter curves become tracks; `Model` and
 * `PartOpacity` curves are reported as skipped. Inverse-stepped segments
 * (value jumps at the start) are converted to a stepped key at the start.
 */
export function motion3ToClip(json: unknown, name: string): { clip: AnimationClip; skipped: string[] } {
  const m = json as Motion3;
  if (!m || typeof m !== 'object' || m.Version !== 3 || !m.Meta || !Array.isArray(m.Curves)) throw new Motion3Error('Not a Version 3 motion3.json');
  const skipped: string[] = [];
  const tracks: AnimationTrack[] = [];
  for (const c of m.Curves) {
    if (c.Target !== 'Parameter') { skipped.push(`${c.Target}:${c.Id}`); continue; }
    const s = c.Segments;
    if (!Array.isArray(s) || s.length < 2) throw new Motion3Error(`Curve ${c.Id} is empty`);
    const keys: Keyframe[] = [{ t: s[0]!, v: s[1]!, interp: 'linear' }];
    let i = 2;
    while (i < s.length) {
      const type = s[i]!;
      const prev = keys[keys.length - 1]!;
      if (type === 1) {
        const [p1t, p1v, p2t, p2v, t, v] = s.slice(i + 1, i + 7) as [number, number, number, number, number, number];
        const T = t - prev.t || 1;
        prev.interp = 'bezier';
        prev.out = [(p1t - prev.t) / T, p1v - prev.v];
        keys.push({ t, v, interp: 'linear', in: [(t - p2t) / T, p2v - v] });
        i += 7;
      } else if (type === 0 || type === 2 || type === 3) {
        const t = s[i + 1]!, v = s[i + 2]!;
        if (type === 3) {
          // Inverse stepped: jumps to the end value at the segment start.
          prev.interp = 'step';
          keys.push({ t: prev.t + 1e-6, v, interp: 'step' });
          keys.push({ t, v, interp: 'linear' });
        } else {
          prev.interp = type === 2 ? 'step' : 'linear';
          keys.push({ t, v, interp: 'linear' });
        }
        i += 3;
      } else {
        throw new Motion3Error(`Curve ${c.Id}: unknown segment type ${type}`);
      }
    }
    // Same-time keys from inverse steps would collide; keep strictly increasing times.
    const dedup = keys.filter((k, j) => j === 0 || k.t > keys[j - 1]!.t);
    tracks.push({ parameterId: c.Id, keyframes: dedup });
  }
  return {
    clip: { id: newId('clip'), name, duration: m.Meta.Duration, fps: m.Meta.Fps || 30, loop: !!m.Meta.Loop, tracks },
    skipped,
  };
}
