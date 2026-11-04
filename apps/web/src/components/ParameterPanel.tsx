import { useState } from 'react';
import type { Parameter } from '@l2s/editor-core';
import { moveParameter, addParameterGroup, renameParameterGroup, deleteParameterGroup, setParameterGroup, addExpression, updateExpression, deleteExpression } from '@l2s/deformer-engine';
import { KEY_EPSILON, captureExpression } from '@l2s/parameter-engine';
import { newId } from '@l2s/editor-core';
import { editor, useEditor } from '../state/editor.ts';
import { fmt, rigActions, selectedObjectIds, useRig } from '../state/rig.ts';

export function ParameterPanel() {
  const params = useEditor((s) => s.project.parameters);
  const groups = useEditor((s) => s.project.parameterGroups);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEditor((s) => s.selection);
  useEditor((s) => s.project.meshes);
  useEditor((s) => s.project.deformers);
  const nObj = selectedObjectIds().length;
  return (
    <div className="params" data-testid="param-panel">
      <div className="pad row-flex">
        <button className="btn" onClick={() => rigActions.openParamDialog({ mode: 'new' })}>New Parameter</button>
        <button className="btn" onClick={rigActions.addStandard} title="Spec §7.1 presets">Add Standard Parameters</button>
        <button className="btn" onClick={() => editor.resetParams()} title="Ctrl+Shift+R">Reset Values</button>
        <button className="btn" onClick={() => { const n = prompt('Group name', `Group ${groups.length + 1}`); if (n) editor.run(addParameterGroup(newId('pgrp'), n)); }} data-testid="group-new">New Group</button>
        <span className="muted">{nObj ? `${nObj} keyable object(s) selected — key buttons apply to them` : 'Select ArtMeshes or deformers to add keys'}</span>
      </div>
      <ExpressionBar />
      {params.length === 0 && <div className="muted pad">No parameters yet. Add the standard set or create your own.</div>}
      {[...groups.map((g) => ({ id: g.id, name: g.name })), { id: '', name: 'Ungrouped' }].map((g) => {
        const list = params.filter((p) => (p.groupId ?? '') === g.id);
        if (!g.id && !list.length) return null;
        const isCollapsed = !!collapsed[g.id];
        return (
          <div key={g.id || '_none'} className="param-group" data-group={g.id}>
            {(groups.length > 0 || g.id) && (
              <div className="param-group-header">
                <button className="twisty" onClick={() => setCollapsed({ ...collapsed, [g.id]: !isCollapsed })} aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}>{isCollapsed ? '▸' : '▾'}</button>
                <strong>{g.name}</strong><span className="muted small"> {list.length}</span>
                {g.id && <button className="icon-btn" onClick={() => { const n = prompt('Rename group', g.name); if (n) editor.run(renameParameterGroup(g.id, n)); }} aria-label="Rename group">✎</button>}
                {g.id && <button className="icon-btn" onClick={() => editor.run(deleteParameterGroup(g.id))} aria-label="Delete group">✕</button>}
              </div>
            )}
            {!isCollapsed && list.map((p) => { const i = params.indexOf(p); return <ParamRow key={p.id} p={p} first={i === 0} last={i === params.length - 1} hasObjects={nObj > 0} />; })}
          </div>
        );
      })}
      <ParamDialog />
    </div>
  );
}

function ParamRow({ p, first, last, hasObjects }: { p: Parameter; first: boolean; last: boolean; hasObjects: boolean }) {
  const groups = useEditor((s) => s.project.parameterGroups);
  const value = useEditor((s) => s.paramValues[p.id] ?? p.default);
  const keys = rigActions.keysOf(p.id);
  const bound = rigActions.isBound(p.id);
  const shape = rigActions.hasBlendShape(p.id);
  const shapeKeys = rigActions.blendKeysOf(p.id);
  const onKey = keys.some((k) => Math.abs(k - value) <= KEY_EPSILON);
  const step = (p.max - p.min) / 1000;
  const pct = (v: number) => ((v - p.min) / (p.max - p.min)) * 100;
  return (
    <div className={bound !== 'none' ? 'param-row bound' : 'param-row'} data-param={p.id}>
      <div className="param-name" title={p.id}>
        <span>{p.name || p.id}</span>
        <small className="muted mono">{p.id}{p.repeat ? ' ⟲' : ''}</small>
      </div>
      <div className="param-slider">
        <input
          type="range" min={p.min} max={p.max} step={step} value={value} aria-label={p.id}
          onChange={(e) => editor.setParam(p.id, Number(e.target.value))}
          onDoubleClick={() => editor.setParam(p.id, p.default)}
          onPointerUp={() => rigActions.snap(p.id)}
        />
        <div className="ticks">
          {keys.map((k) => (
            <button key={k} className={Math.abs(k - value) <= KEY_EPSILON ? 'tick on' : 'tick'} style={{ left: `${pct(k)}%` }} title={`Key ${fmt(k)}`} onClick={() => editor.setParam(p.id, k)} />
          ))}
          {shapeKeys.map((k) => (
            <button key={`bs${k}`} className={Math.abs(k - value) <= KEY_EPSILON ? 'tick blend on' : 'tick blend'} style={{ left: `${pct(k)}%` }} title={`Blend shape key ${fmt(k)}`} onClick={() => editor.setParam(p.id, k)} />
          ))}
          <span className="tick default" style={{ left: `${pct(p.default)}%` }} />
        </div>
      </div>
      <input className="param-value" type="number" step={step * 10} value={Number(value.toFixed(3))} aria-label={`${p.id} value`} onChange={(e) => editor.setParam(p.id, Number(e.target.value))} />
      <div className="param-keys">
        {shape !== 'none' ? (
          <button className="btn small danger-text" onClick={() => rigActions.removeBlendShape(p.id)} title="Remove the blend shape from the selected objects">−blend</button>
        ) : bound === 'none' ? (
          <>
            <button className="btn small" disabled={!hasObjects} onClick={() => rigActions.bind(p.id, 2)} title={`Keys at ${fmt(p.min)} and ${fmt(p.max)}`}>2 keys</button>
            <button className="btn small" disabled={!hasObjects} onClick={() => rigActions.bind(p.id, 3)} title={`Keys at ${fmt(p.min)}, ${fmt(p.default)}, ${fmt(p.max)}`}>3 keys</button>
            <button className="btn small" disabled={!hasObjects} onClick={() => rigActions.addBlendShape(p.id)} title="Additive blend shape: added on top of the keyforms, no key grid (spec §7.3)" data-testid={`blend-${p.id}`}>blend</button>
          </>
        ) : (
          <>
            {bound === 'some' && <button className="btn small" onClick={() => rigActions.bind(p.id, 3)} title="Bind the remaining selected objects">+objects</button>}
            <button className="btn small" disabled={onKey} onClick={() => rigActions.addKeyHere(p.id)} title="Add a key at the current value">+key</button>
            <button className="btn small" disabled={!onKey} onClick={() => rigActions.removeKeyHere(p.id)} title="Remove the key at the current value">−key</button>
            <button className="btn small danger-text" onClick={() => rigActions.unbind(p.id)} title="Remove this parameter from the selected objects (keeps the keyform nearest the current value)">unbind</button>
          </>
        )}
      </div>
      <div className="param-tools">
        <button className="icon-btn" disabled={first} onClick={() => editor.run(moveParameter(p.id, -1))} aria-label="Move up">↑</button>
        <button className="icon-btn" disabled={last} onClick={() => editor.run(moveParameter(p.id, 1))} aria-label="Move down">↓</button>
        {groups.length > 0 && (
          <select className="group-select" value={p.groupId ?? ''} onChange={(e) => editor.run(setParameterGroup([p.id], e.target.value || null))} aria-label={`Group of ${p.id}`}>
            <option value="">—</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        <button className="icon-btn" onClick={() => rigActions.openParamDialog({ mode: 'edit', id: p.id })} aria-label="Edit">✎</button>
        <button className="icon-btn" onClick={() => { if (confirm(`Delete parameter ${p.id}? Bound objects keep the keyform at its default.`)) rigActions.deleteParam(p.id); }} aria-label="Delete">✕</button>
      </div>
    </div>
  );
}

/** Expressions / parameter presets (spec §7.3), Cubism exp3 blend semantics. */
function ExpressionBar() {
  const expressions = useEditor((s) => s.project.expressions);
  const active = useEditor((s) => s.activeExpressions);
  const params = useEditor((s) => s.project.parameters);
  const [editing, setEditing] = useState<string | null>(null);
  const ex = expressions.find((e) => e.id === editing);
  const save = () => {
    const parameters = captureExpression(useEditor.getState().paramValues, params);
    if (!parameters.length) { alert('Move some parameters away from their defaults first; those become the expression.'); return; }
    const name = prompt('Expression name', `Expression ${expressions.length + 1}`);
    if (!name) return;
    const id = newId('exp');
    editor.run(addExpression({ id, name, fadeIn: 0.5, fadeOut: 0.5, parameters }));
    editor.resetParams();
    setEditing(id);
  };
  return (
    <div className="expressions" data-testid="expressions">
      <div className="row-flex wrap pad">
        <strong className="small">Expressions</strong>
        {expressions.map((e) => (
          <span key={e.id} className="expr-chip">
            <button className={active.includes(e.id) ? 'btn small primary' : 'btn small'} onClick={() => editor.toggleExpression(e.id)} title="Preview on top of the current values" data-expr={e.name}>{e.name}</button>
            <button className="icon-btn" onClick={() => setEditing(editing === e.id ? null : e.id)} aria-label={`Edit ${e.name}`}>✎</button>
          </span>
        ))}
        <button className="btn small" onClick={save} title="Save the parameters that differ from their default as an expression (Add offsets)" data-testid="expr-save">+ From current values</button>
      </div>
      {ex && (
        <div className="expr-editor">
          <div className="row-flex">
            <input value={ex.name} onChange={(e) => editor.run(updateExpression(ex.id, (x) => { x.name = e.target.value; }, `exname:${ex.id}`))} aria-label="Expression name" />
            <label className="small muted">Fade in</label><input type="number" step={0.1} min={0} value={ex.fadeIn ?? 0} onChange={(e) => editor.run(updateExpression(ex.id, (x) => { x.fadeIn = Number(e.target.value); }))} aria-label="Fade in" />
            <label className="small muted">Fade out</label><input type="number" step={0.1} min={0} value={ex.fadeOut ?? 0} onChange={(e) => editor.run(updateExpression(ex.id, (x) => { x.fadeOut = Number(e.target.value); }))} aria-label="Fade out" />
            <button className="btn small danger-text" onClick={() => { editor.run(deleteExpression(ex.id)); setEditing(null); }}>Delete</button>
          </div>
          <table className="ph-table"><tbody>
            {ex.parameters.map((ep, i) => (
              <tr key={ep.parameterId}>
                <td className="mono small">{ep.parameterId}</td>
                <td><select value={ep.blend} onChange={(e) => editor.run(updateExpression(ex.id, (x) => { x.parameters[i]!.blend = e.target.value as 'Add'; }))} aria-label={`Blend of ${ep.parameterId}`}><option>Add</option><option>Multiply</option><option>Overwrite</option></select></td>
                <td><input type="number" step={0.05} value={Number(ep.value.toFixed(4))} onChange={(e) => editor.run(updateExpression(ex.id, (x) => { x.parameters[i]!.value = Number(e.target.value); }, `exv:${ex.id}:${i}`))} aria-label={`Value of ${ep.parameterId}`} /></td>
                <td><button className="icon-btn" onClick={() => editor.run(updateExpression(ex.id, (x) => { x.parameters.splice(i, 1); }))} aria-label="Remove">✕</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}

function ParamDialog() {
  const d = useRig((s) => s.paramDialog);
  const params = useEditor((s) => s.project.parameters);
  if (!d) return null;
  const existing = d.mode === 'edit' ? params.find((p) => p.id === d.id) : undefined;
  return <ParamForm key={d.mode === 'edit' ? d.id : 'new'} initial={existing ?? { id: `Param${params.length + 1}`, name: '', min: 0, max: 1, default: 0 }} prevId={existing?.id ?? null} />;
}

function ParamForm({ initial, prevId }: { initial: Parameter; prevId: string | null }) {
  const [p, setP] = useState<Parameter>(initial);
  const [err, setErr] = useState<string | null>(null);
  const num = (k: 'min' | 'max' | 'default') => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && rigActions.openParamDialog(null)}>
      <form className="modal" role="dialog" aria-label="Parameter" onSubmit={(e) => { e.preventDefault(); setErr(rigActions.saveParam(prevId, p)); }}>
        <header><h3>{prevId ? 'Edit Parameter' : 'New Parameter'}</h3></header>
        <div className="form-grid">
          <label>ID</label><input value={p.id} onChange={(e) => setP({ ...p, id: e.target.value })} aria-label="Parameter ID" autoFocus />
          <label>Name</label><input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} aria-label="Parameter name" />
          <label>Minimum</label><input type="number" step="any" value={p.min} onChange={num('min')} aria-label="Minimum" />
          <label>Default</label><input type="number" step="any" value={p.default} onChange={num('default')} aria-label="Default" />
          <label>Maximum</label><input type="number" step="any" value={p.max} onChange={num('max')} aria-label="Maximum" />
          <label>Repeat</label><input type="checkbox" checked={!!p.repeat} onChange={(e) => setP({ ...p, repeat: e.target.checked })} aria-label="Repeat" />
        </div>
        {err && <p className="error-text">{err}</p>}
        <footer className="dialog-actions">
          <button type="button" onClick={() => rigActions.openParamDialog(null)}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </footer>
      </form>
    </div>
  );
}
