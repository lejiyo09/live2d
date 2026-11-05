import { useEffect, useState } from 'react';
import { boundsOf, setClipMask, setNodeProps, translateNodes, type BlendMode, type SceneNode } from '@l2s/editor-core';
import { isApproximated } from '@l2s/rendering-engine';
import { editor, useEditor } from '../state/editor.ts';
import { meshActions, useMesh } from '../state/mesh.ts';
import { setPathStyle } from '@l2s/mesh-engine';
import { DeformerInspector, KeyformSection } from './RigInspector.tsx';

const BLEND_MODES: BlendMode[] = [
  'normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color', 'lighten', 'screen', 'color-dodge',
  'linear-dodge', 'lighter-color', 'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
];

export function Inspector() {
  const project = useEditor((s) => s.project);
  const ids = useEditor((s) => s.selection.ids);
  const anchor = useEditor((s) => s.selection.anchor);
  const nodes = ids.map((id) => project.nodes[id]).filter((n): n is SceneNode => !!n);
  const deformer = ids.length === 1 ? project.deformers[ids[0]!] : undefined;
  if (deformer) {
    return (
      <section className="panel inspector" aria-label="Inspector">
        <header className="panel-header"><span>Inspector</span><span className="muted">Deformer</span></header>
        <DeformerInspector d={deformer} />
      </section>
    );
  }

  if (nodes.length === 0) {
    return (
      <section className="panel inspector" aria-label="Inspector">
        <header className="panel-header"><span>Inspector</span></header>
        <div className="props">
          <h4>Project</h4>
          <Row label="Name"><span>{project.name}</span></Row>
          <Row label="Canvas"><span>{project.canvas.width} × {project.canvas.height}px</span></Row>
          <Row label="Nodes"><span>{Object.keys(project.nodes).length}</span></Row>
          {project.source && <Row label="Source"><span title={project.source.importedAt}>{project.source.fileName}</span></Row>}
        </div>
      </section>
    );
  }

  const single = nodes.length === 1 ? nodes[0]! : null;
  const anchorNode = anchor ? project.nodes[anchor] : undefined;
  const activeLayer = anchorNode?.kind === 'layer' && ids.includes(anchorNode.id) ? anchorNode : single?.kind === 'layer' ? single : null;
  const common = <K extends keyof SceneNode>(k: K): SceneNode[K] | undefined => (nodes.every((n) => n[k] === nodes[0]![k]) ? nodes[0]![k] : undefined);
  const opacity = common('opacity');
  const blend = common('blendMode');
  const b = boundsOf(project, ids);
  const sel = nodes.map((n) => n.id);
  const anyLocked = nodes.some((n) => n.locked);

  return (
    <section className="panel inspector" aria-label="Inspector">
      <header className="panel-header"><span>Inspector</span><span className="muted">{single ? (single.kind === 'group' ? 'Folder' : 'Layer') : `${nodes.length} selected`}</span></header>
      <div className="props">
        {single && (
          <Row label="Name">
            <TextField value={single.name} onCommit={(v) => editor.run(setNodeProps([single.id], { name: v || 'Untitled' }, { label: 'Rename' }))} />
          </Row>
        )}

        <h4>Transform</h4>
        {b ? (
          <>
            <Row label="Position">
              <NumField label="X" value={b.x} disabled={anyLocked} onCommit={(v) => editor.run(translateNodes(sel, Math.round(v - b.x), 0))} />
              <NumField label="Y" value={b.y} disabled={anyLocked} onCommit={(v) => editor.run(translateNodes(sel, 0, Math.round(v - b.y)))} />
            </Row>
            <Row label="Size"><span>{b.width} × {b.height}px</span></Row>
          </>
        ) : <Row label="Bounds"><span className="muted">empty</span></Row>}
        <Row label="Rotation / Scale"><span className="muted" title="Applied through deformers in Phase 3">via Deformer (Phase 3)</span></Row>

        <h4>Display</h4>
        <Row label="Opacity">
          <input
            type="range" min={0} max={100} step={1}
            value={Math.round((opacity ?? nodes[0]!.opacity) * 100)}
            aria-label="Opacity"
            onChange={(e) => editor.run(setNodeProps(sel, { opacity: Number(e.target.value) / 100 }, { label: 'Opacity', mergeKey: `opacity:${sel.join()}` }))}
            onPointerUp={() => editor.sealHistoryStep()}
          />
          <span className="num">{opacity === undefined ? '—' : `${Math.round(opacity * 100)}%`}</span>
        </Row>
        <Row label="Blend">
          <select
            value={blend ?? ''}
            aria-label="Blend mode"
            onChange={(e) => editor.run(setNodeProps(sel, { blendMode: e.target.value as BlendMode }, { label: 'Blend Mode' }))}
          >
            {blend === undefined && <option value="">(mixed)</option>}
            {nodes.some((n) => n.kind === 'group') && <option value="pass-through">pass-through</option>}
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m}{isApproximated(m) ? ' (approx.)' : ''}</option>)}
          </select>
        </Row>
        <Row label="Visible">
          <input type="checkbox" ref={(el) => { if (el) el.indeterminate = !nodes.every((n) => n.visible) && nodes.some((n) => n.visible); }} checked={nodes.every((n) => n.visible)} onChange={(e) => editor.run(setNodeProps(sel, { visible: e.target.checked }, { label: e.target.checked ? 'Show' : 'Hide' }))} />
        </Row>
        <Row label="Locked">
          <input type="checkbox" ref={(el) => { if (el) el.indeterminate = !nodes.every((n) => n.locked) && nodes.some((n) => n.locked); }} checked={nodes.every((n) => n.locked)} onChange={(e) => editor.run(setNodeProps(sel, { locked: e.target.checked }, { label: e.target.checked ? 'Lock' : 'Unlock' }))} />
        </Row>

        <h4>Part</h4>
        <Row label="Category">
          <TextField
            value={single ? single.partTag?.category ?? '' : (common('partTag')?.category ?? '')}
            placeholder="e.g. Hair.Front.Left"
            onCommit={(v) => editor.run(setNodeProps(sel, { partTag: v ? { category: v, confidence: 1, source: 'user' } : undefined }, { label: 'Part Category' }))}
          />
        </Row>
        {single?.partTag && (
          <Row label="Suggested by"><span className="muted">{single.partTag.source} · {Math.round(single.partTag.confidence * 100)}%</span></Row>
        )}

        {single?.kind === 'layer' && (
          <>
            <h4>PSD Source</h4>
            <Row label="PSD clipping"><span>{single.clipping ? 'Yes' : 'No'}</span></Row>
            <Row label="Layer mask">
              <span>{single.mask ? `${single.mask.disabled ? 'disabled' : 'baked'} · ${single.mask.bounds.width}×${single.mask.bounds.height}` : 'None'}</span>
            </Row>
            <Row label="PSD path"><span className="mono">{single.sourcePath.join(' / ')}</span></Row>
          </>
        )}
        {activeLayer && <MaskSection layerId={activeLayer.id} />}
        {single?.kind === 'layer' && <MeshSection layerId={single.id} />}
        {single?.kind === 'layer' && project.meshes[single.id] && <KeyformSection id={single.id} />}
      </div>
    </section>
  );
}

/** ArtMesh mask references (spec §5.1). */
function MaskSection({ layerId }: { layerId: string }) {
  const project = useEditor((s) => s.project);
  const layer = project.nodes[layerId];
  if (layer?.kind !== 'layer') return null;
  const cm = layer.clipMask;
  const pickMasks = () => {
    const ids = useEditor.getState().selection.ids.filter((id) => id !== layerId && project.nodes[id]?.kind === 'layer');
    if (ids.length) editor.run(setClipMask([layerId], { ids, inverted: cm?.inverted ?? false }));
  };
  return (
    <>
      <h4>Clipping Mask</h4>
      <Row label="Masked by">
        <span data-testid="clip-mask">{cm ? cm.ids.map((id) => project.nodes[id]?.name ?? '?').join(', ') : <span className="muted">None</span>}</span>
      </Row>
      {cm && (
        <Row label="Inverted">
          <input type="checkbox" checked={cm.inverted} onChange={(e) => editor.run(setClipMask([layerId], { ...cm, inverted: e.target.checked }))} aria-label="Invert mask" />
        </Row>
      )}
      <div className="button-row">
        <button className="btn" onClick={pickMasks} title="Ctrl+click the mask layer(s) in the Parts tree, then Ctrl+click this layer last (it becomes the active layer)">Mask with other selected</button>
        {cm && <button className="btn danger-text" onClick={() => editor.run(setClipMask([layerId], null))}>Clear</button>}
      </div>
    </>
  );
}

function PathSection({ layerId }: { layerId: string }) {
  const mesh = useEditor((s) => s.project.meshes[layerId]);
  if (!mesh?.path) return null;
  const st = mesh.path;
  const hex = `#${st.color.toString(16).padStart(6, '0')}`;
  return (
    <>
      <h4>ArtPath</h4>
      <Row label="Control points"><span>{mesh.vertices.length / 2}</span></Row>
      <Row label="Width">
        <input type="range" min={1} max={80} value={st.width} aria-label="Stroke width" onChange={(e) => editor.run(setPathStyle(layerId, { width: Number(e.target.value) }, `pw:${layerId}`))} onPointerUp={() => editor.sealHistoryStep()} />
        <span className="num">{st.width}</span>
      </Row>
      <Row label="Colour"><input type="color" value={hex} aria-label="Stroke colour" onChange={(e) => editor.run(setPathStyle(layerId, { color: parseInt(e.target.value.slice(1), 16) }, `pc:${layerId}`))} /></Row>
      <Row label="Closed"><input type="checkbox" checked={st.closed} onChange={(e) => editor.run(setPathStyle(layerId, { closed: e.target.checked }))} aria-label="Closed path" /></Row>
      <Row label="Taper ends"><input type="checkbox" checked={st.taper} onChange={(e) => editor.run(setPathStyle(layerId, { taper: e.target.checked }))} aria-label="Taper" /></Row>
      <div className="button-row">
        <button className="btn" onClick={meshActions.toggleMeshEdit} title="Move / add / delete control points (M)">Edit points</button>
      </div>
    </>
  );
}

function MeshSection({ layerId }: { layerId: string }) {
  const mesh = useEditor((s) => s.project.meshes[layerId]);
  const project = useEditor((s) => s.project);
  if (mesh?.path) return <PathSection layerId={layerId} />;
  const editing = useMesh((s) => s.mode === 'mesh' && s.editLayerId === layerId);
  return (
    <>
      <h4>ArtMesh</h4>
      {mesh ? (
        <>
          <Row label="Vertices"><span data-testid="mesh-vertices">{mesh.vertices.length / 2}</span></Row>
          <Row label="Triangles"><span>{mesh.triangles.length / 3}</span></Row>
          <Row label="Outline loops"><span>{mesh.boundary.length}</span></Row>
          <Row label="Parent"><span>{mesh.parentId ? project.deformers[mesh.parentId]?.name ?? '?' : 'Root'}</span></Row>
          <Row label="Origin"><span className="muted">{mesh.generatedBy}{mesh.settings ? ` · margin ${mesh.settings.outerMargin}/${mesh.settings.innerMargin} · spacing ${mesh.settings.outerSpacing}/${mesh.settings.innerSpacing}` : ''}</span></Row>
        </>
      ) : <Row label="Mesh"><span className="muted">None (drawn as a quad)</span></Row>}
      <div className="button-row">
        <button className="btn" onClick={() => void meshActions.runAutoMesh()}>{mesh ? 'Regenerate' : 'Auto Mesh'}</button>
        <button className={editing ? 'btn primary' : 'btn'} onClick={meshActions.toggleMeshEdit}>{editing ? 'Done' : 'Edit Mesh'}</button>
        {mesh && <button className="btn" onClick={() => meshActions.runCheck([layerId])}>Check</button>}
        {mesh && <button className="btn danger-text" onClick={meshActions.deleteMeshes}>Delete</button>}
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="prop-row"><label>{label}</label><div className="prop-value">{children}</div></div>;
}

function TextField({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type="text" value={v} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v.trim())}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setV(value); }}
    />
  );
}

function NumField({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <span className="num-field">
      <span className="muted">{label}</span>
      <input
        type="number" value={v} disabled={disabled} aria-label={label}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (Number.isFinite(n) && n !== value) onCommit(n); else setV(String(value)); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </span>
  );
}
