import { useEffect, useRef, useState } from 'react';
import { StudioRenderer } from '@l2s/rendering-engine';
import { editor, useEditor } from '../state/editor.ts';
import { actions } from '../state/actions.ts';
import { meshActions, useMesh } from '../state/mesh.ts';
import { createMeshEditTool } from '../tools/meshEditTool.ts';
import { createDeformTool, deformPoints } from '../tools/deformTool.ts';
import { createPenTool, pen } from '../tools/penTool.ts';
import { activeObjectId, keyStateOf, rigActions, useRig } from '../state/rig.ts';
import { evaluateModel } from '@l2s/deformer-engine';
import { PreviewBanner } from './AiDialogs.tsx';
import { SplitView, useSplit } from './SplitView.tsx';
import { defaultValues } from '@l2s/parameter-engine';
import type { Rect } from '@l2s/editor-core';

export function Workspace({ onReady }: { onReady: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const importing = useEditor((s) => s.importing);
  const empty = useEditor((s) => s.project.rootIds.length === 0);
  const lastError = useEditor((s) => s.lastError);
  const split = useSplit((s) => s.on);

  useEffect(() => {
    const el = host.current!;
    const r = new StudioRenderer();
    let alive = true;
    let unbind: (() => void) | null = null;
    const bindMeshTool = (rr: StudioRenderer) => {
      let overlay = { hover: -1, box: null as Rect | null };
      const onOverlay = (o: typeof overlay) => { overlay = o; push(); };
      const meshTool = createMeshEditTool(onOverlay);
      const deformTool = createDeformTool(onOverlay);
      const penTool = createPenTool();
      pen.onChange = () => push();
      let restCache: { project: unknown; model: ReturnType<typeof evaluateModel> } | null = null;
      const restModel = () => {
        const p = editor.project;
        if (restCache?.project !== p) restCache = { project: p, model: evaluateModel(p, defaultValues(p)) };
        return restCache.model;
      };
      const push = () => {
        const m = useMesh.getState();
        const p = editor.project;
        if (m.mode === 'mesh' && m.editLayerId && p.meshes[m.editLayerId]) {
          const mesh = p.meshes[m.editLayerId]!;
          const flagged = new Set<number>();
          for (const row of m.checkRows ?? []) if (row.layerId === m.editLayerId) for (const v of row.issue.vertices ?? []) flagged.add(v);
          rr.setEditOverlay({
            kind: 'mesh', targetId: m.editLayerId, points: mesh.vertices, triangles: mesh.triangles, boundary: mesh.boundary,
            selected: new Set(m.selectedVertices), hover: overlay.hover, box: overlay.box, flagged, editable: true,
          });
          return;
        }
        if (m.mode === 'pen') {
          const pts = [...pen.points, ...(pen.hover && pen.points.length ? pen.hover : [])];
          rr.setEditOverlay(pts.length ? { kind: 'mesh', targetId: '__pen', points: pts, selected: new Set(), hover: -1, box: null, flagged: new Set(), editable: true } : null);
          return;
        }
        if (m.mode === 'deform') {
          const id = activeObjectId();
          const pts = id ? deformPoints(id) : null;
          if (!id || !pts) { rr.setEditOverlay(null); return; }
          const editable = keyStateOf(id).target.kind !== 'none';
          const sel = new Set(useRig.getState().deformSelected);
          const rm = restModel();
          if (pts.kind === 'mesh') {
            const mesh = p.meshes[id]!;
            rr.setEditOverlay({ kind: 'mesh', targetId: id, points: pts.points, triangles: mesh.triangles, boundary: mesh.boundary, selected: sel, hover: overlay.hover, box: overlay.box, flagged: new Set(), ghost: rm.meshes.get(id)?.positions, editable });
          } else if (pts.kind === 'warp') {
            const d = p.deformers[id] as { cols: number; rows: number };
            const ghost = rm.deformers.get(id);
            const bz = useRig.getState().bezier;
            const cur = useEditor.getState().model.deformers.get(id);
            if (bz.on && cur?.kind === 'warp') {
              const n = 3 * bz.div;
              rr.setEditOverlay({ kind: 'warp', targetId: id, points: pts.points, cols: n, rows: n, selected: sel, hover: overlay.hover, box: overlay.box, flagged: new Set(), underlay: { points: cur.points, cols: d.cols, rows: d.rows }, editable });
            } else {
              rr.setEditOverlay({ kind: 'warp', targetId: id, points: pts.points, cols: d.cols, rows: d.rows, selected: sel, hover: overlay.hover, box: overlay.box, flagged: new Set(), ghost: ghost?.kind === 'warp' ? ghost.points : undefined, editable });
            }
          } else {
            rr.setEditOverlay({ kind: 'rotation', targetId: id, points: pts.points, selected: sel, hover: overlay.hover, box: null, flagged: new Set(), editable });
          }
          return;
        }
        rr.setEditOverlay(null);
      };
      let lastMode = '';
      const u1 = useMesh.subscribe((m) => {
        if (m.mode !== lastMode) {
          lastMode = m.mode;
          rr.setTool(m.mode === 'mesh' ? meshTool : m.mode === 'deform' ? deformTool : m.mode === 'pen' ? penTool : null);
          useRig.setState({ deformSelected: [] });
        }
        push();
      });
      const u2 = useEditor.subscribe((s, prev) => {
        if (s.project !== prev.project || s.model !== prev.model || s.selection !== prev.selection) {
          if (s.selection !== prev.selection) useRig.setState({ deformSelected: [] });
          push();
        }
      });
      const u3 = useEditor.subscribe((s, prev) => { if (s.showMeshes !== prev.showMeshes) rr.setOverlayOptions({ showMeshes: s.showMeshes }); });
      const u4 = useRig.subscribe(push);
      unbind = () => { u1(); u2(); u3(); u4(); rr.setTool(null); };
    };
    r.init(el, {
      pick: (e) => {
        if (e.id === null) { if (!e.shift && !e.ctrl) editor.select(null); return; }
        editor.select(e.id, e.shift ? 'add' : e.ctrl ? 'toggle' : 'replace');
      },
      hover: (id, w) => { editor.setHover(id); editor.setCursor(w ? { x: Math.floor(w.x), y: Math.floor(w.y) } : null); },
      camera: (c) => editor.setCamera(c),
    }).then(() => {
      if (!alive) return;
      editor.attachRenderer(r);
      bindMeshTool(r);
      onReady();
    }).catch((e: Error) => setError(`WebGL2 initialization failed: ${e.message}`));
    return () => {
      alive = false;
      unbind?.();
      editor.attachRenderer(null);
      r.destroy();
    };
  }, [onReady]);

  return (
    <section
      className={dragOver ? 'workspace drag-over' : 'workspace'}
      aria-label="Canvas"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) void editor.openFile(f);
      }}
    >
      <div className={split ? 'canvas-host half' : 'canvas-host'} ref={host} />
      {split && <SplitView />}
      {empty && !importing && (
        <div className="empty-state" data-testid="empty-state">
          <h2>Start a model</h2>
          <p>Drop a layered <b>.psd</b> or <b>.l2studio</b> file here, or</p>
          <div className="row-flex">
            <button className="btn primary" onClick={() => actions.openFileDialog()}>Open PSD…</button>
            <button className="btn" onClick={() => void editor.openSample()} data-testid="open-sample">Open the default character (Himikan)</button>
          </div>
          <p className="muted small">Files stay in this browser (IndexedDB). Nothing is uploaded.<br />Unofficial tool — not affiliated with or endorsed by Live2D Inc.</p>
        </div>
      )}
      <ToolStrip />
      <PreviewBanner />
      <ZoomControls />
      {error && <div className="overlay-msg error">{error}</div>}
      {lastError && !importing && (
        <div className="error-banner" role="alert" data-testid="error-banner">
          <span>{lastError}</span>
          <button className="btn small" onClick={() => editor.setBottomTab('console')}>Details</button>
          <button className="icon-btn" onClick={() => useEditor.setState({ lastError: null })} aria-label="Dismiss">✕</button>
        </div>
      )}
      {importing && (
        <div className="overlay-msg progress" role="status">
          <div>{phaseLabel(importing.phase)} — {importing.fileName}</div>
          <progress max={importing.total || 1} value={importing.done} />
          <div className="small">{importing.done} / {importing.total}</div>
          {(importing.phase === 'parse' || importing.phase === 'layers' || importing.phase === 'encode' || importing.phase === 'read') && (
            <button onClick={() => editor.cancelImport()}>Cancel</button>
          )}
        </div>
      )}
    </section>
  );
}

function phaseLabel(p: string) {
  return ({ read: 'Reading file', parse: 'Parsing PSD', layers: 'Extracting layers', encode: 'Encoding images', store: 'Saving to local storage', upload: 'Uploading textures' } as Record<string, string>)[p] ?? p;
}

function ToolStrip() {
  const mode = useMesh((s) => s.mode);
  const editLayerId = useMesh((s) => s.editLayerId);
  const nsel = useMesh((s) => s.selectedVertices.length);
  const uvMode = useMesh((s) => s.uvMode);
  const running = useMesh((s) => s.running);
  const project = useEditor((s) => s.project);
  const mesh = editLayerId ? project.meshes[editLayerId] : undefined;
  return (
    <>
      <div className="tool-strip" role="toolbar" aria-label="Tools">
        <button className={mode === 'select' ? 'active' : ''} title="Select (V)" aria-label="Select tool" onClick={() => meshActions.exitMeshEdit()}>⬚</button>
        <button className={mode === 'mesh' ? 'active' : ''} title="Edit Mesh (M)" aria-label="Mesh edit tool" onClick={() => meshActions.toggleMeshEdit()}>◭</button>
        <button className={mode === 'deform' ? 'active' : ''} title="Deform / edit keyform (D)" aria-label="Deform tool" onClick={() => meshActions.toggleDeform()}>⤧</button>
        <button className={mode === 'pen' ? 'active' : ''} title="ArtPath pen (P): click points, double-click / Enter to finish" aria-label="ArtPath pen" onClick={() => meshActions.togglePen()} data-testid="pen-tool">✎</button>
        <button title="Auto Generate ArtMesh… (Ctrl+Shift+M)" aria-label="Auto mesh" onClick={() => meshActions.openAutoMesh(true)}>✱</button>
      </div>
      {mode === 'mesh' && mesh && (
        <div className="mode-banner" data-testid="mesh-banner">
          <strong>Mesh Edit{uvMode ? ' · UV' : ''}</strong> {project.nodes[editLayerId!]?.name} · {mesh.vertices.length / 2} vertices · {mesh.triangles.length / 3} triangles{nsel ? ` · ${nsel} selected` : ''}
          <span className="muted"> — drag: {uvMode ? 'slide texture' : 'move'}/box · Alt+click: add · Del: delete · Esc: exit</span>
          <div className="banner-tools">
            <button className="btn small" disabled={nsel !== 2} onClick={meshActions.connect} title="Connect two vertices with an edge (E)">Connect</button>
            <button className="btn small" disabled={nsel !== 2} onClick={meshActions.removeEdge} title="Remove a user edge or flip an interior edge (F)">Remove/flip edge</button>
            <button className="btn small" disabled={nsel !== 3} onClick={meshActions.triangle} title="Create a triangle from three vertices (T)">Triangle</button>
            <button className="btn small" disabled={nsel < 3} onClick={meshActions.deleteTriangles} title="Delete triangles whose corners are all selected (Shift+Del)">Delete triangles</button>
            {!!mesh.excluded?.length && <button className="btn small" onClick={meshActions.restoreTriangles}>Restore {mesh.excluded.length}</button>}
            <button className={uvMode ? 'btn small primary' : 'btn small'} onClick={meshActions.toggleUvMode} title="UV mode: drag moves texture coordinates (U)" data-testid="uv-mode">UV</button>
            <button className="btn small" onClick={meshActions.resetUVs}>Reset UVs</button>
          </div>
        </div>
      )}
      {mode === 'deform' && <DeformBanner />}
      {mode === 'pen' && <div className="mode-banner" data-testid="pen-banner"><strong>ArtPath Pen</strong> <span className="muted">— click to add points · double-click or Enter: finish · Esc: cancel</span></div>}
      {running && (
        <div className="overlay-msg progress" role="status">
          <div>Generating meshes…</div>
          <progress max={running.total} value={running.done} />
          <div className="small">{running.done} / {running.total}</div>
        </div>
      )}
    </>
  );
}

function DeformBanner() {
  useEditor((s) => s.model);
  useEditor((s) => s.selection);
  const id = activeObjectId();
  const p = useEditor((s) => s.project);
  if (!id) return <div className="mode-banner" data-testid="deform-banner"><strong>Deform</strong> <span className="muted">— select an ArtMesh or deformer</span></div>;
  const ks = keyStateOf(id);
  const name = p.deformers[id]?.name ?? p.nodes[id]?.name ?? id;
  const isWarp = p.deformers[id]?.kind === 'warp';
  return (
    <div className={ks.target.kind === 'none' ? 'mode-banner warn' : 'mode-banner'} data-testid="deform-banner">
      <strong>Deform</strong> {name} · <span data-testid="deform-key">{ks.label}</span>
      <span className="muted"> — drag points · box select{p.deformers[id]?.kind === 'rotation' ? ' · drag ○ moves, Alt+drag ○ sets pivot, drag handle rotates' : ''} · Esc: exit</span>
      {isWarp && <BezierControls />}
    </div>
  );
}

function BezierControls() {
  const bz = useRig((s) => s.bezier);
  return (
    <div className="banner-tools">
      <button className={bz.on ? 'btn small primary' : 'btn small'} onClick={rigActions.toggleBezier} title="Edit the warp through a smooth Bézier control net (B)" data-testid="bezier-toggle">Bézier</button>
      {bz.on && [1, 2].map((d) => <button key={d} className={bz.div === d ? 'btn small primary' : 'btn small'} onClick={() => rigActions.setBezierDiv(d as 1 | 2)}>{d}×{d}</button>)}
    </div>
  );
}

function ZoomControls() {
  const zoom = useEditor((s) => s.camera.zoom);
  return (
    <div className="zoom-controls">
      <button onClick={() => editor.zoomBy(0.8)} title="Zoom out">−</button>
      <button onClick={() => editor.setZoom(1)} title="100%" className="zoom-value">{(zoom * 100).toFixed(zoom < 0.1 ? 1 : 0)}%</button>
      <button onClick={() => editor.zoomBy(1.25)} title="Zoom in">+</button>
      <button onClick={() => editor.fitView()} title="Fit (Ctrl+0)">⤢</button>
    </div>
  );
}
