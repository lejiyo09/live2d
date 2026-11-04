import { useEffect, useRef, useState } from 'react';
import { evaluateTrack, moveKeys, setHandles, setInterpolation, snapTime, type CurvePreset } from '@l2s/animation-engine';
import { editor, useEditor } from '../state/editor.ts';
import { activeClip, animActions, useAnim } from '../state/anim.ts';

const PRESETS: Array<[CurvePreset, string]> = [['linear', 'Linear'], ['bezier', 'Bezier'], ['easeIn', 'Ease In'], ['easeOut', 'Ease Out'], ['easeInOut', 'Ease In-Out'], ['step', 'Step']];

/** Curve editor (spec §9.2): value-over-time graph of one track with draggable keys and Bezier handles. */
export function CurveEditor() {
  const project = useEditor((s) => s.project);
  const { curveTrack, selectedKeys, time } = useAnim();
  useAnim((s) => s.clipId);
  const clip = activeClip();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 160 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: Math.max(80, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const track = clip?.tracks.find((t) => t.parameterId === curveTrack) ?? clip?.tracks[0];
  const param = project.parameters.find((p) => p.id === track?.parameterId);
  const refsHere = selectedKeys.filter((k) => k.parameterId === track?.parameterId);
  const toolbar = (
    <div className="tl-toolbar">
      <select value={track?.parameterId ?? ''} onChange={(e) => animActions.setCurveTrack(e.target.value)} aria-label="Curve track">
        {clip?.tracks.map((t) => <option key={t.parameterId} value={t.parameterId}>{project.parameters.find((p) => p.id === t.parameterId)?.name || t.parameterId}</option>)}
      </select>
      {PRESETS.map(([p, label]) => (
        <button key={p} className="btn small" disabled={!clip || !selectedKeys.length} onClick={() => clip && editor.run(setInterpolation(clip.id, selectedKeys, p))} data-preset={p}>{label}</button>
      ))}
      <span className="muted small">Applies to segments starting at the selected keys. Drag keys or the round handles for a custom curve.</span>
    </div>
  );
  if (!clip || !track || !param) return <div className="curve-editor">{toolbar}<div className="muted pad">Select a track in the Timeline.</div></div>;

  const pad = 18, W = size.w, H = size.h - 34;
  const vMin = param.min - (param.max - param.min) * 0.08, vMax = param.max + (param.max - param.min) * 0.08;
  const X = (t: number) => pad + (t / clip.duration) * (W - pad * 2);
  const Y = (v: number) => pad + ((vMax - v) / (vMax - vMin)) * (H - pad * 2);
  const invT = (x: number) => ((x - pad) / (W - pad * 2)) * clip.duration;
  const invV = (y: number) => vMax - ((y - pad) / (H - pad * 2)) * (vMax - vMin);
  const pts: string[] = [];
  for (let i = 0; i <= 300; i++) { const t = (clip.duration * i) / 300; pts.push(`${X(t).toFixed(1)},${Y(evaluateTrack(track, t)!).toFixed(1)}`); }
  const keys = track.keyframes;

  const drag = (e: React.PointerEvent, onMove: (dxT: number, dyV: number, key: string) => void) => {
    e.stopPropagation();
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const key = `curve:${Date.now()}`;
    const move = (ev: PointerEvent) => onMove(invT(ev.clientX - svg.left) - invT(sx - svg.left), invV(ev.clientY - svg.top) - invV(sy - svg.top), key);
    const up = () => { editor.sealHistoryStep(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handles: React.ReactNode[] = [];
  keys.forEach((k, i) => {
    const sel = refsHere.some((r) => Math.abs(r.t - k.t) < 1e-6);
    const next = keys[i + 1];
    if (!sel || k.interp !== 'bezier' || !next) return;
    const T = next.t - k.t;
    const o = k.out ?? [1 / 3, 0], n = next.in ?? [1 / 3, 0];
    const ox = X(k.t + o[0] * T), oy = Y(k.v + o[1]), ix = X(next.t - n[0] * T), iy = Y(next.v + n[1]);
    handles.push(
      <g key={`h${k.t}`}>
        <line x1={X(k.t)} y1={Y(k.v)} x2={ox} y2={oy} className="handle-line" />
        <line x1={X(next.t)} y1={Y(next.v)} x2={ix} y2={iy} className="handle-line" />
        <circle cx={ox} cy={oy} r={5} className="handle" onPointerDown={(e) => { const s0 = [...o] as [number, number]; drag(e, (dt, dv, mk) => editor.run(setHandles(clip.id, { parameterId: track.parameterId, t: k.t }, { out: [s0[0] + dt / T, s0[1] + dv] }, mk))); }} />
        <circle cx={ix} cy={iy} r={5} className="handle" onPointerDown={(e) => { const s0 = [...n] as [number, number]; drag(e, (dt, dv, mk) => editor.run(setHandles(clip.id, { parameterId: track.parameterId, t: next.t }, { in: [s0[0] - dt / T, s0[1] + dv] }, mk))); }} />
      </g>,
    );
  });

  return (
    <div className="curve-editor">
      {toolbar}
      <div className="curve-box" ref={box}>
        <svg width={W} height={H} data-testid="curve-svg">
          {[param.min, param.default, param.max].map((v) => <line key={v} x1={pad} x2={W - pad} y1={Y(v)} y2={Y(v)} className={v === param.default ? 'grid mid' : 'grid'} />)}
          <text x={2} y={Y(param.max) + 4} className="axis">{param.max}</text>
          <text x={2} y={Y(param.min) + 4} className="axis">{param.min}</text>
          <line x1={X(time)} x2={X(time)} y1={0} y2={H} className="playhead" />
          <polyline points={pts.join(' ')} className="curve" />
          {handles}
          {keys.map((k) => {
            const r = { parameterId: track.parameterId, t: k.t };
            const sel = refsHere.some((x) => Math.abs(x.t - k.t) < 1e-6);
            return (
              <rect key={k.t} x={X(k.t) - 5} y={Y(k.v) - 5} width={10} height={10} transform={`rotate(45 ${X(k.t)} ${Y(k.v)})`} className={sel ? 'ckey sel' : 'ckey'}
                onPointerDown={(e) => {
                  if (!sel) animActions.selectKeys([r], e.shiftKey);
                  let at = { t: 0, v: 0 };
                  drag(e, (dt, dv, mk) => {
                    const st = snapTime(clip, dt);
                    const refs = useAnim.getState().selectedKeys.filter((x) => x.parameterId === track.parameterId);
                    editor.run(moveKeys(clip.id, refs, st - at.t, dv - at.v, mk));
                    useAnim.setState({ selectedKeys: refs.map((x) => ({ ...x, t: Math.min(clip.duration, Math.max(0, snapTime(clip, x.t + st - at.t))) })) });
                    at = { t: st, v: dv };
                  });
                }} />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
