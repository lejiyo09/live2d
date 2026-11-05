import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { StudioRenderer } from '@l2s/rendering-engine';
import { evaluateModel } from '@l2s/deformer-engine';
import { defaultValues } from '@l2s/parameter-engine';
import { editor, useEditor } from '../state/editor.ts';

type Pose = 'current' | 'default';
export const useSplit = create<{ on: boolean; pose: Pose }>(() => ({ on: false, pose: 'default' }));

/**
 * Secondary view (spec Phase 7 다중 뷰): the same model with its own camera,
 * showing either the current pose or the default pose for comparison.
 * Clicking selects, but no tools act here.
 */
/** One long-lived secondary renderer, moved in and out of the DOM (never destroyed). */
let shared: { r: StudioRenderer; el: HTMLDivElement; ready: Promise<void>; projectId: string | null } | null = null;
function sharedRenderer() {
  if (!shared) {
    const el = document.createElement('div');
    el.className = 'split-host';
    const r = new StudioRenderer();
    shared = { r, el, projectId: null, ready: r.init(el, { pick: (e) => editor.select(e.id, e.shift ? 'add' : e.ctrl ? 'toggle' : 'replace') }) };
  }
  return shared;
}

export function SplitView() {
  const host = useRef<HTMLDivElement>(null);
  const pose = useSplit((s) => s.pose);
  const [ready, setReady] = useState(false);
  const r = useRef<StudioRenderer | null>(null);

  useEffect(() => {
    const sh = sharedRenderer();
    host.current!.appendChild(sh.el);
    r.current = sh.r;
    let alive = true;
    void sh.ready.then(async () => {
      if (!alive) return;
      sh.r.setActive(true);
      // Textures are reloaded when the document changed since the view was last shown.
      if (sh.projectId !== editor.project.id) { sh.r.textures.clear(); await editor.loadTexturesInto(sh.r); sh.projectId = editor.project.id; }
      if (alive) { sh.r.fitToView(); setReady(true); }
    });
    return () => { alive = false; sh.r.setActive(false); sh.el.remove(); r.current = null; };
  }, []);

  useEffect(() => {
    if (!ready || !r.current) return;
    const rr = r.current;
    let restFor: unknown = null, rest: ReturnType<typeof evaluateModel> | null = null;
    const push = () => {
      const s = useEditor.getState();
      if (useSplit.getState().pose === 'default') {
        if (restFor !== s.project) { rest = evaluateModel(s.project, defaultValues(s.project)); restFor = s.project; }
        rr.sync(s.project, rest);
      } else {
        rr.sync(s.project, s.model);
      }
      rr.setSelection(s.selection.ids);
      rr.setOverlayOptions({ showMeshes: s.showMeshes, grid: s.grid, guides: s.guides });
    };
    push();
    const u1 = useEditor.subscribe((s, prev) => { if (s.project !== prev.project || s.model !== prev.model || s.selection !== prev.selection || s.grid !== prev.grid || s.guides !== prev.guides) push(); });
    const u2 = useSplit.subscribe(push);
    return () => { u1(); u2(); };
  }, [ready]);

  return (
    <div className="split-view" data-testid="split-view">
      <div className="split-slot" ref={host} />
      <div className="split-bar">
        <select value={pose} onChange={(e) => useSplit.setState({ pose: e.target.value as Pose })} aria-label="Split view pose">
          <option value="default">Default pose</option>
          <option value="current">Current pose</option>
        </select>
        <button className="btn small" onClick={() => r.current?.fitToView()}>Fit</button>
        <button className="btn small" onClick={() => useSplit.setState({ on: false })} aria-label="Close split view">✕</button>
      </div>
      {!ready && <div className="overlay-msg">Loading…</div>}
    </div>
  );
}
