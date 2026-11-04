import { useEffect, useState } from 'react';
import type { Deformer, RotationKeyform } from '@l2s/editor-core';
import { formOwner, isDeformerAncestor, ownerForm, renameDeformer, setMeshKeyform, setRotationKeyform, setWarpKeyform } from '@l2s/deformer-engine';
import { editor, useEditor } from '../state/editor.ts';
import { fmt, keyStateOf, rigActions, useRig } from '../state/rig.ts';
import { meshActions, useMesh } from '../state/mesh.ts';

/** Inspector body for a selected deformer. */
export function DeformerInspector({ d }: { d: Deformer }) {
  const deformers = useEditor((s) => s.project.deformers);
  const parents = Object.values(deformers).filter((x) => !isDeformerAncestor(editor.project, d.id, x.id));
  return (
    <div className="props">
      <Row label="Name"><Text value={d.name} onCommit={(v) => editor.run(renameDeformer(d.id, v))} /></Row>
      <Row label="Type"><span>{d.kind === 'warp' ? `Warp deformer · ${d.cols}×${d.rows}` : 'Rotation deformer'}</span></Row>
      <Row label="Parent">
        <select value={d.parentId ?? ''} aria-label="Parent deformer" onChange={(e) => rigActions.setParent([d.id], e.target.value || null)}>
          <option value="">Root (canvas)</option>
          {parents.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Row>
      <KeyformSection id={d.id} />
    </div>
  );
}

/** Parameter bindings and the keyform at the current parameter values (spec §7.2). */
export function KeyformSection({ id }: { id: string }) {
  useEditor((s) => s.paramValues);
  const project = useEditor((s) => s.project);
  const clip = useRig((s) => s.clipboard);
  const mode = useMesh((s) => s.mode);
  const o = formOwner(project, id);
  if (!o) return null;
  const form = ownerForm(o);
  const ks = keyStateOf(id);
  const kf = form && ks.index >= 0 ? (form.keyforms[ks.index] as Record<string, unknown>) : null;
  const name = (pid: string) => project.parameters.find((p) => p.id === pid)?.name || pid;
  const setOpacity = (v: number) => {
    const mk = `kf-opacity:${id}`;
    if (o.kind === 'mesh') editor.run(setMeshKeyform(id, ks.index, { opacity: v }, mk));
    else if (o.kind === 'warp') editor.run(setWarpKeyform(id, ks.index, { opacity: v }, mk));
    else editor.run(setRotationKeyform(id, ks.index, { opacity: v }, mk));
  };
  return (
    <>
      <h4>Keyforms</h4>
      {form && form.bindings.length > 0 ? form.bindings.map((b) => (
        <Row key={b.parameterId} label={name(b.parameterId)}>
          <span className="mono small" title={b.parameterId}>{b.keys.map(fmt).join(' · ')}</span>
        </Row>
      )) : <Row label="Bindings"><span className="muted">None — use the Parameters panel</span></Row>}
      {(() => { const list = (o.kind === 'mesh' ? o.mesh.blendShapes : o.deformer.blendShapes) ?? []; return list.map((bs) => (
        <Row key={`bs-${bs.parameterId}`} label={`Blend: ${name(bs.parameterId)}`}><span className="mono small">{bs.keys.map(fmt).join(' · ')}</span></Row>
      )); })()}
      <Row label="Current"><span className={ks.target.kind === 'none' ? 'warn-text' : ''} data-testid="keyform-state">{ks.label}</span></Row>
      {kf && (
        <Row label="Opacity">
          <input type="range" min={0} max={100} value={Math.round((kf.opacity as number) * 100)} aria-label="Keyform opacity" onChange={(e) => setOpacity(Number(e.target.value) / 100)} onPointerUp={() => editor.sealHistoryStep()} />
          <span className="num">{Math.round((kf.opacity as number) * 100)}%</span>
        </Row>
      )}
      {kf && o.kind === 'rotation' && <RotationFields id={id} index={ks.index} kf={kf as unknown as RotationKeyform} />}
      {kf && o.kind === 'mesh' && (
        <Row label="Draw order">
          <Num value={(kf.drawOrder as number | undefined) ?? 500} step={10} label="Draw order" onCommit={(v) => editor.run(setMeshKeyform(id, ks.index, { drawOrder: v }))} />
          <span className="muted small">0–1000, among siblings</span>
        </Row>
      )}
      <div className="button-row">
        <button className={mode === 'deform' ? 'btn primary' : 'btn'} onClick={meshActions.toggleDeform} title="Deform tool (D)">{mode === 'deform' ? 'Done' : 'Deform'}</button>
        <button className="btn" disabled={ks.index < 0} onClick={rigActions.copyKeyform} title="Ctrl+Shift+C">Copy</button>
        <button className="btn" disabled={ks.index < 0 || !clip} onClick={rigActions.pasteKeyform} title="Ctrl+Shift+V">Paste</button>
        {form?.bindings.map((b) => (
          <button key={b.parameterId} className="btn" disabled={ks.index < 0} onClick={() => rigActions.mirrorKeyform(b.parameterId)} title={`Fill this keyform with the mirror of the opposite ${b.parameterId} key`}>
            Mirror {b.parameterId.replace(/^Param/, '')}
          </button>
        ))}
      </div>
    </>
  );
}

function RotationFields({ id, index, kf }: { id: string; index: number; kf: RotationKeyform }) {
  const set = (patch: Partial<RotationKeyform>) => editor.run(setRotationKeyform(id, index, patch));
  return (
    <>
      <Row label="Angle (°)"><Num value={kf.angle} onCommit={(v) => set({ angle: v })} label="Angle" /></Row>
      <Row label="Scale"><Num value={kf.scale} step={0.01} onCommit={(v) => set({ scale: Math.max(0.01, v) })} label="Scale" /></Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="prop-row"><label>{label}</label><div className="prop-value">{children}</div></div>;
}

function Text({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function Num({ value, onCommit, step = 1, label }: { value: number; onCommit: (v: number) => void; step?: number; label: string }) {
  const [v, setV] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setV(String(Number(value.toFixed(3)))), [value]);
  return <input type="number" step={step} value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={() => { const n = Number(v); if (Number.isFinite(n) && n !== value) onCommit(n); }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}
