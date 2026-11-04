import { useState, type DragEvent, type MouseEvent } from 'react';
import { isDeformerAncestor } from '@l2s/deformer-engine';
import { editor, useEditor } from '../state/editor.ts';
import { deformerChildren, rigActions } from '../state/rig.ts';

export function DeformerTree() {
  useEditor((s) => s.project.deformers);
  useEditor((s) => s.project.meshes);
  const selection = useEditor((s) => s.selection);
  const [drop, setDrop] = useState<string | null>(null);
  const selected = new Set(selection.ids);
  const p = editor.project;

  const click = (e: MouseEvent, id: string) => editor.select(id, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');
  const dragStart = (e: DragEvent, id: string) => {
    const ids = selected.has(id) ? selection.ids.filter((x) => p.deformers[x] || p.meshes[x]) : [id];
    if (!selected.has(id)) editor.select(id);
    e.dataTransfer.setData('application/x-l2s-rig', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };
  const over = (e: DragEvent, target: string | null) => {
    if (!e.dataTransfer.types.includes('application/x-l2s-rig')) return;
    e.preventDefault();
    setDrop(target ?? '__root');
  };
  const doDrop = (e: DragEvent, target: string | null) => {
    e.preventDefault();
    setDrop(null);
    const ids = e.dataTransfer.getData('application/x-l2s-rig').split(',').filter(Boolean);
    if (target && ids.some((id) => p.deformers[id] && isDeformerAncestor(p, id, target))) return;
    rigActions.setParent(ids.filter((id) => id !== target), target);
  };

  const render = (parentId: string | null, depth: number): React.ReactNode => {
    const { deformers, meshes } = deformerChildren(parentId);
    return (
      <>
        {deformers.map((id) => {
          const d = p.deformers[id]!;
          const nb = d.form.bindings.length;
          return (
            <div key={id}>
              <div
                className={['tree-row', selected.has(id) && 'selected', drop === id && 'drop-inside'].filter(Boolean).join(' ')}
                style={{ paddingLeft: 6 + depth * 14 }} data-deformer-id={id} draggable
                onClick={(e) => click(e, id)} onDragStart={(e) => dragStart(e, id)} onDragOver={(e) => over(e, id)} onDrop={(e) => doDrop(e, id)}
              >
                <span className={`kind ${d.kind}`}>{d.kind === 'warp' ? '▦' : '⟳'}</span>
                <span className="name">{d.name}</span>
                {nb > 0 && <span className="tag" title={d.form.bindings.map((b) => `${b.parameterId}: ${b.keys.join(', ')}`).join('\n')}>{d.form.bindings.map((b) => b.parameterId.replace(/^Param/, '')).join('·')}</span>}
              </div>
              {render(id, depth + 1)}
            </div>
          );
        })}
        {meshes.map((id) => {
          const n = p.nodes[id];
          const f = p.meshes[id]!.form;
          return (
            <div
              key={id}
              className={['tree-row', selected.has(id) && 'selected'].filter(Boolean).join(' ')}
              style={{ paddingLeft: 6 + depth * 14 }} data-rig-mesh={id} draggable
              onClick={(e) => click(e, id)} onDragStart={(e) => dragStart(e, id)} onDragOver={(e) => over(e, parentId)} onDrop={(e) => doDrop(e, parentId)}
            >
              <span className="kind mesh">◭</span>
              <span className={n?.visible ? 'name' : 'name muted'}>{n?.name ?? id}</span>
              {f && f.bindings.length > 0 && <span className="tag">{f.bindings.map((b) => b.parameterId.replace(/^Param/, '')).join('·')}</span>}
            </div>
          );
        })}
      </>
    );
  };

  const empty = Object.keys(p.deformers).length === 0 && Object.keys(p.meshes).length === 0;
  return (
    <div className="tree" data-testid="deformer-tree">
      <div className={drop === '__root' ? 'tree-row root-row drop-inside' : 'tree-row root-row'} onDragOver={(e) => over(e, null)} onDrop={(e) => doDrop(e, null)} onClick={() => editor.select(null)}>
        <span className="kind">⌂</span><span className="name muted">Root (canvas)</span>
      </div>
      {empty ? <div className="empty-hint">No ArtMeshes yet.<br /><small>Generate meshes, then Deform → Create Warp / Rotation Deformer.</small></div> : render(null, 1)}
    </div>
  );
}

export function DeformerDialog() {
  const kind = useRigDialog();
  const [name, setName] = useState('');
  const cols = useRigCols();
  if (!kind) return null;
  const n = name || (kind === 'warp' ? 'Warp' : 'Rotation');
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && rigActions.openDeformerDialog(null)}>
      <form className="modal" role="dialog" aria-label="Create deformer" onSubmit={(e) => { e.preventDefault(); rigActions.createDeformer(kind, n); setName(''); }}>
        <header><h3>{kind === 'warp' ? 'Create Warp Deformer' : 'Create Rotation Deformer'}</h3></header>
        <div className="form-grid">
          <label>Name</label><input autoFocus value={name} placeholder={kind === 'warp' ? 'Warp' : 'Rotation'} onChange={(e) => setName(e.target.value)} aria-label="Deformer name" />
          {kind === 'warp' && (
            <>
              <label>Columns</label><input type="number" min={1} max={20} value={cols.cols} onChange={(e) => rigActions.setWarpDivisions(Math.max(1, Number(e.target.value)), cols.rows)} aria-label="Columns" />
              <label>Rows</label><input type="number" min={1} max={20} value={cols.rows} onChange={(e) => rigActions.setWarpDivisions(cols.cols, Math.max(1, Number(e.target.value)))} aria-label="Rows" />
            </>
          )}
        </div>
        <p className="muted small">The selected layers / ArtMeshes / deformers become children of the new deformer. Layers without a mesh get a rectangle mesh. Their current look is preserved.</p>
        <footer className="dialog-actions">
          <button type="button" onClick={() => rigActions.openDeformerDialog(null)}>Cancel</button>
          <button type="submit" className="primary" data-testid="deformer-create">Create</button>
        </footer>
      </form>
    </div>
  );
}

import { useRig } from '../state/rig.ts';
function useRigDialog() { return useRig((s) => s.deformerDialog); }
function useRigCols() { const cols = useRig((s) => s.warpCols); const rows = useRig((s) => s.warpRows); return { cols, rows }; }
