import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { deleteClip, deleteKeys, duplicateClip, moveKeys, setClipDuration, setClipProps, setKey, snapTime, bakePhysics, type KeyRef } from '@l2s/animation-engine';
import { editor, useEditor } from '../state/editor.ts';
import { activeClip, animActions, useAnim } from '../state/anim.ts';

const NAME_W = 190;

export function TimelinePanel() {
  const project = useEditor((s) => s.project);
  const { time, playing, physicsOn, selectedKeys, curveTrack, onion, onionStep } = useAnim();
  useAnim((s) => s.clipId);
  const clip = activeClip();
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [scaleKeys, setScaleKeys] = useState(true);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - NAME_W - 16)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!clip) {
    return (
      <div className="pad row-flex" ref={area}>
        <button className="btn primary" onClick={animActions.newClip} data-testid="anim-new">New Animation</button>
        <span className="muted">No animations yet. Create one, scrub the playhead, set parameters, and press ◆ Key (K).</span>
      </div>
    );
  }
  const pps = width / clip.duration;
  const frame = Math.round(time * clip.fps);
  const pname = (id: string) => project.parameters.find((p) => p.id === id)?.name || id;
  const order = new Map(project.parameters.map((p, i) => [p.id, i]));
  const tracks = [...clip.tracks].sort((a, b) => (order.get(a.parameterId) ?? 999) - (order.get(b.parameterId) ?? 999));
  const isSel = (r: KeyRef) => selectedKeys.some((s) => s.parameterId === r.parameterId && Math.abs(s.t - r.t) < 1e-6);
  const untracked = project.parameters.filter((p) => !clip.tracks.some((t) => t.parameterId === p.id));

  const timeAt = (clientX: number) => {
    const r = area.current!.querySelector('.tl-lane')!.getBoundingClientRect();
    return Math.min(clip.duration, Math.max(0, (clientX - r.left) / pps));
  };
  const scrubStart = (e: RPE) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    animActions.pause();
    animActions.scrub(snapTime(clip, timeAt(e.clientX)));
    const move = (ev: PointerEvent) => animActions.scrub(snapTime(clip, timeAt(ev.clientX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const keyDown = (e: RPE, r: KeyRef) => {
    e.stopPropagation();
    if (!isSel(r)) animActions.selectKeys([r], e.shiftKey);
    animActions.setCurveTrack(r.parameterId);
    const startX = e.clientX;
    let applied = 0;
    const key = `tl-drag:${Date.now()}`;
    const move = (ev: PointerEvent) => {
      const dt = snapTime(clip, (ev.clientX - startX) / pps);
      if (dt === applied) return;
      const refs = useAnim.getState().selectedKeys;
      editor.run(moveKeys(clip.id, refs, dt - applied, 0, key));
      useAnim.setState({ selectedKeys: refs.map((k) => ({ ...k, t: Math.min(clip.duration, Math.max(0, snapTime(clip, k.t + dt - applied))) })) });
      applied = dt;
    };
    const up = () => { editor.sealHistoryStep(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKeys.length) {
      e.stopPropagation(); e.preventDefault();
      editor.run(deleteKeys(clip.id, selectedKeys));
      animActions.selectKeys([]);
    }
  };
  const ticks: number[] = [];
  const step = clip.duration <= 2 ? 0.25 : clip.duration <= 6 ? 0.5 : clip.duration <= 20 ? 1 : 5;
  for (let t = 0; t <= clip.duration + 1e-9; t += step) ticks.push(t);

  return (
    <div className="timeline" ref={area} tabIndex={0} onKeyDown={onKey} data-testid="timeline">
      <div className="tl-toolbar">
        <select value={clip.id} onChange={(e) => animActions.selectClip(e.target.value)} aria-label="Animation">
          {project.animations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn small" onClick={animActions.newClip}>New</button>
        <button className="btn small" onClick={() => { const d = duplicateClip(clip.id); editor.run(d.command); animActions.selectClip(d.id); }}>Duplicate</button>
        <button className="btn small danger-text" onClick={() => { if (confirm(`Delete animation "${clip.name}"?`)) editor.run(deleteClip(clip.id)); }}>Delete</button>
        <input className="tl-name" defaultValue={clip.name} key={clip.id} onBlur={(e) => e.target.value !== clip.name && editor.run(setClipProps(clip.id, { name: e.target.value || clip.name }))} aria-label="Animation name" />
        <label className="muted">Length</label>
        <input type="number" min={0.1} step={0.1} defaultValue={clip.duration} key={`${clip.id}:${clip.duration}`} aria-label="Length (s)"
          onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== clip.duration) editor.run(setClipDuration(clip.id, v, scaleKeys)); }} />
        <label className="muted small"><input type="checkbox" checked={scaleKeys} onChange={(e) => setScaleKeys(e.target.checked)} /> scale keys</label>
        <select value={clip.fps} onChange={(e) => editor.run(setClipProps(clip.id, { fps: Number(e.target.value) }))} aria-label="FPS">
          {[24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
        <label className="muted small"><input type="checkbox" checked={clip.loop} onChange={(e) => editor.run(setClipProps(clip.id, { loop: e.target.checked }))} /> loop</label>
        <span className="sep" />
        <button className="btn small" onClick={() => editor.run(setClipProps(clip.id, { range: { start: time, end: clip.range?.end ?? clip.duration } }))} title="Set range start at the playhead">In</button>
        <button className="btn small" onClick={() => editor.run(setClipProps(clip.id, { range: { start: clip.range?.start ?? 0, end: Math.max(time, (clip.range?.start ?? 0) + 1 / clip.fps) } }))} title="Set range end at the playhead">Out</button>
        {clip.range && <button className="btn small" onClick={() => editor.run(setClipProps(clip.id, { range: undefined }))}>Clear range</button>}
      </div>
      <div className="tl-toolbar">
        <button className="btn small" onClick={animActions.stop} aria-label="Stop">⏮</button>
        <button className="btn small primary" onClick={animActions.toggle} aria-label={playing ? 'Pause' : 'Play'} data-testid="anim-play">{playing ? '⏸' : '▶'}</button>
        <button className="btn small" onClick={() => animActions.scrub(time - 1 / clip.fps)} aria-label="Previous frame">◀|</button>
        <button className="btn small" onClick={() => animActions.scrub(time + 1 / clip.fps)} aria-label="Next frame">|▶</button>
        <span className="mono tl-time" data-testid="anim-time">{time.toFixed(2)}s · f{frame}</span>
        <button className="btn small" onClick={() => animActions.keyCurrent()} title="Key every parameter that differs from the animation at the playhead (K)" data-testid="anim-key">◆ Key changed</button>
        <select value="" onChange={(e) => { if (e.target.value) editor.run(setKey(clip.id, e.target.value, time, useEditor.getState().paramValues[e.target.value] ?? 0)); }} aria-label="Add track">
          <option value="">+ Track…</option>
          {untracked.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
        </select>
        <span className="sep" />
        <label className="small"><input type="checkbox" checked={physicsOn} onChange={(e) => animActions.setPhysics(e.target.checked)} data-testid="physics-toggle" /> Physics (realtime)</label>
        <button className="btn small" disabled={!project.physics.settings.length} onClick={() => editor.run(bakePhysics(clip.id))} title="Simulate physics over this animation and write the outputs as keyframes">Bake physics</button>
        <button className="btn small" onClick={() => animActions.openExport(true)}>Export…</button>
        <span className="sep" />
        <label className="small"><input type="checkbox" checked={onion} onChange={animActions.toggleOnion} data-testid="onion" /> Onion skin</label>
        {onion && <input type="number" min={1} max={30} value={onionStep} onChange={(e) => animActions.setOnionStep(Number(e.target.value))} aria-label="Onion step (frames)" title="Frames between ghosts" />}
      </div>
      <div className="tl-body">
        <div className="tl-row tl-ruler">
          <div className="tl-name-cell muted small">{clip.bakedFromPhysics?.length ? 'baked: ' + clip.bakedFromPhysics.join(', ') : ''}</div>
          <div className="tl-lane" onPointerDown={scrubStart}>
            {clip.range && <div className="tl-range" style={{ left: clip.range.start * pps, width: (clip.range.end - clip.range.start) * pps }} />}
            {ticks.map((t) => <span key={t} className="tl-tick" style={{ left: t * pps }}>{Number(t.toFixed(2))}</span>)}
          </div>
        </div>
        {tracks.map((tr) => (
          <div key={tr.parameterId} className={curveTrack === tr.parameterId ? 'tl-row active' : 'tl-row'}>
            <div className="tl-name-cell" onClick={() => animActions.setCurveTrack(tr.parameterId)} title={tr.parameterId}>
              <span>{pname(tr.parameterId)}</span>
              <button className="icon-btn" title="Key this parameter at the playhead" onClick={(e) => { e.stopPropagation(); animActions.keyCurrent([tr.parameterId]); }}>◆</button>
            </div>
            <div className="tl-lane" onPointerDown={(e) => { animActions.selectKeys([]); scrubStart(e); }}>
              {tr.keyframes.map((k) => {
                const r = { parameterId: tr.parameterId, t: k.t };
                return <span key={k.t} className={`tl-key ${k.interp}${isSel(r) ? ' sel' : ''}`} style={{ left: k.t * pps }} title={`${k.t.toFixed(3)}s = ${k.v.toFixed(3)} (${k.interp})`} onPointerDown={(e) => keyDown(e, r)} data-key={`${tr.parameterId}@${k.t}`} />;
              })}
            </div>
          </div>
        ))}
        <div className="tl-playhead" style={{ left: NAME_W + time * pps }} />
      </div>
    </div>
  );
}
