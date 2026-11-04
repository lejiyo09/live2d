import { useEffect, useRef, useState } from 'react';
import { addClip, addScene, addSceneEntry, deleteScene, flattenScene, moveSceneEntry, removeSceneEntry, setSceneProps } from '@l2s/animation-engine';
import { editor, useEditor } from '../state/editor.ts';
import { activeScene, animActions, useAnim } from '../state/anim.ts';

const NAME_W = 110, ROW_H = 26;

/** Scene view of the timeline: clips placed on tracks (spec §9.1 장면 관리 · 클립 배치/이동). */
export function SceneTimeline() {
  const project = useEditor((s) => s.project);
  const { time, playing } = useAnim();
  useAnim((s) => s.sceneId);
  const scene = activeScene();
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - NAME_W - 16)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const newScene = () => { const s = addScene(`Scene ${project.scenes.length + 1}`); editor.run(s.command); animActions.selectScene(s.id); };
  if (!scene) {
    return (
      <div className="pad row-flex" ref={area}>
        <button className="btn primary" onClick={newScene} data-testid="scene-new">New Scene</button>
        <span className="muted">A scene places several animations on tracks; later tracks override earlier ones where they overlap.</span>
      </div>
    );
  }
  const pps = width / Math.max(0.5, scene.duration);
  const clips = new Map(project.animations.map((c) => [c.id, c]));
  const tracks = Math.max(2, ...scene.entries.map((e) => e.track + 2));
  const dragEntry = (ev: React.PointerEvent, id: string) => {
    ev.stopPropagation();
    setSel(id);
    const e0 = scene.entries.find((x) => x.id === id)!;
    const sx = ev.clientX, sy = ev.clientY, key = `scene:${Date.now()}`;
    const move = (m: PointerEvent) => editor.run(moveSceneEntry(scene.id, id, e0.start + (m.clientX - sx) / pps, e0.track + Math.round((m.clientY - sy) / ROW_H), key));
    const up = () => { editor.sealHistoryStep(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const scrub = (ev: React.PointerEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    animActions.pause();
    animActions.scrub(Math.min(scene.duration, Math.max(0, (ev.clientX - r.left) / pps)));
  };
  return (
    <div className="timeline" ref={area} tabIndex={0} data-testid="scene-timeline"
      onKeyDown={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.stopPropagation(); editor.run(removeSceneEntry(scene.id, sel)); setSel(null); } }}>
      <div className="tl-toolbar">
        <select value={scene.id} onChange={(e) => animActions.selectScene(e.target.value)} aria-label="Scene">{project.scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button className="btn small" onClick={newScene}>New</button>
        <button className="btn small danger-text" onClick={() => editor.run(deleteScene(scene.id))}>Delete</button>
        <input className="tl-name" defaultValue={scene.name} key={scene.id} onBlur={(e) => editor.run(setSceneProps(scene.id, { name: e.target.value || scene.name }))} aria-label="Scene name" />
        <label className="muted">Length</label>
        <input type="number" min={0.5} step={0.5} defaultValue={scene.duration} key={`${scene.id}:${scene.duration}`} onBlur={(e) => { const v = Number(e.target.value); if (v > 0) editor.run(setSceneProps(scene.id, { duration: v })); }} aria-label="Scene length" />
        <label className="muted small"><input type="checkbox" checked={scene.loop} onChange={(e) => editor.run(setSceneProps(scene.id, { loop: e.target.checked }))} /> loop</label>
        <select value="" onChange={(e) => { if (e.target.value) editor.run(addSceneEntry(scene.id, e.target.value, time, 0).command); }} aria-label="Add clip to scene" data-testid="scene-add-clip">
          <option value="">+ Clip at playhead…</option>
          {project.animations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn small" onClick={() => { const c = flattenScene(project, scene); editor.run(addClip(c)); }} title="Create one animation from the whole scene (for motion3 export or physics baking)">Flatten to clip</button>
        <span className="sep" />
        <button className="btn small primary" onClick={animActions.toggle} aria-label={playing ? 'Pause' : 'Play'} data-testid="scene-play">{playing ? '⏸' : '▶'}</button>
        <span className="mono tl-time">{time.toFixed(2)}s</span>
      </div>
      <div className="tl-body">
        <div className="tl-row tl-ruler"><div className="tl-name-cell" style={{ width: NAME_W }} /><div className="tl-lane" onPointerDown={scrub}>
          {Array.from({ length: Math.floor(scene.duration) + 1 }, (_, t) => <span key={t} className="tl-tick" style={{ left: t * pps }}>{t}</span>)}
        </div></div>
        {Array.from({ length: tracks }, (_, track) => (
          <div key={track} className="tl-row scene-row" style={{ height: ROW_H }}>
            <div className="tl-name-cell muted small" style={{ width: NAME_W }}>Track {track + 1}</div>
            <div className="tl-lane" onPointerDown={scrub}>
              {scene.entries.filter((e) => e.track === track).map((e) => {
                const c = clips.get(e.clipId);
                if (!c) return null;
                return (
                  <div key={e.id} className={sel === e.id ? 'scene-clip sel' : 'scene-clip'} style={{ left: e.start * pps, width: Math.max(8, c.duration * pps) }}
                    onPointerDown={(ev) => dragEntry(ev, e.id)} title={`${c.name} · ${e.start.toFixed(2)}s–${(e.start + c.duration).toFixed(2)}s (drag to move, Del to remove)`} data-entry={e.id}>
                    {c.name}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="tl-playhead" style={{ left: NAME_W + time * pps }} />
      </div>
    </div>
  );
}
