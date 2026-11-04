import { useState } from 'react';
import type { PhysicsSetting, PhysicsSourceType } from '@l2s/editor-core';
import { addParameter } from '@l2s/deformer-engine';
import { addPhysicsSetting, deletePhysicsSetting, newPhysicsSetting, setPhysicsGlobals, updatePhysicsSetting } from '@l2s/physics-engine';
import { newId } from '@l2s/editor-core';
import { editor, useEditor } from '../state/editor.ts';
import { animActions, useAnim } from '../state/anim.ts';

/** Physics settings (spec §8.2), modelled on Cubism physics groups. */
export function PhysicsPanel() {
  const physics = useEditor((s) => s.project.physics);
  const params = useEditor((s) => s.project.parameters);
  const physicsOn = useAnim((s) => s.physicsOn);
  const strands = useAnim((s) => s.strands);
  const [sel, setSel] = useState<string | null>(null);
  const setting = physics.settings.find((s) => s.id === sel) ?? physics.settings[0];
  const upd = (fn: (s: PhysicsSetting) => void, mk?: string) => setting && editor.run(updatePhysicsSetting(setting.id, fn, mk));
  const idx = setting ? physics.settings.indexOf(setting) : -1;

  const addGroup = () => {
    const n = physics.settings.length + 1;
    let out = `ParamPhysics${n}`;
    while (params.some((p) => p.id === out)) out += '_';
    editor.run({
      label: 'Add Physics Group',
      apply(d) {
        addParameter({ id: out, name: `Physics ${n}`, min: -1, max: 1, default: 0 }).apply(d);
        const ins = (['ParamAngleX', 'ParamAngleZ'] as const).filter((id) => d.parameters.some((p) => p.id === id));
        addPhysicsSetting(newPhysicsSetting(newId('phy'), `Physics ${n}`, out, { inputs: ins.map((id) => [id, id === 'ParamAngleZ' ? 'angle' : 'x', 60] as [string, PhysicsSourceType, number]) })).apply(d);
      },
    });
  };
  const num = (v: number, on: (x: number) => void, label: string, step = 0.01) => (
    <input type="number" step={step} value={Number(v.toFixed(4))} aria-label={label} onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) on(x); }} />
  );
  const paramSelect = (v: string, on: (x: string) => void, label: string) => (
    <select value={v} onChange={(e) => on(e.target.value)} aria-label={label}>
      {!params.some((p) => p.id === v) && <option value={v}>{v} (missing)</option>}
      {params.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
    </select>
  );
  const typeSelect = (v: PhysicsSourceType, on: (x: PhysicsSourceType) => void, label: string) => (
    <select value={v} onChange={(e) => on(e.target.value as PhysicsSourceType)} aria-label={label}><option value="x">X</option><option value="y">Y</option><option value="angle">Angle</option></select>
  );

  return (
    <div className="physics" data-testid="physics-panel">
      <div className="ph-side">
        <div className="tl-toolbar">
          <button className="btn small" onClick={addGroup} data-testid="physics-add">+ Group</button>
          {setting && <button className="btn small danger-text" onClick={() => editor.run(deletePhysicsSetting(setting.id))}>Delete</button>}
        </div>
        <ul className="ph-list">
          {physics.settings.map((s) => <li key={s.id} className={s === setting ? 'sel' : ''} onClick={() => setSel(s.id)}>{s.name}<small className="muted"> → {s.outputs.map((o) => o.parameterId).join(', ')}</small></li>)}
        </ul>
        <div className="ph-globals">
          <label className="small"><input type="checkbox" checked={physicsOn} onChange={(e) => animActions.setPhysics(e.target.checked)} /> Realtime preview</label>
          <button className="btn small" onClick={animActions.resetPhysics}>Reset</button>
          <div className="form-grid tight">
            <label>Sim FPS</label>{num(physics.fps, (x) => editor.run(setPhysicsGlobals({ fps: Math.max(0, Math.round(x)) })), 'Physics fps', 1)}
            <label>Gravity</label><span className="pair">{num(physics.gravity.x, (x) => editor.run(setPhysicsGlobals({ gravity: { ...physics.gravity, x } }, 'grav')), 'Gravity X')}{num(physics.gravity.y, (y) => editor.run(setPhysicsGlobals({ gravity: { ...physics.gravity, y } }, 'grav')), 'Gravity Y')}</span>
            <label>Wind</label><span className="pair">{num(physics.wind.x, (x) => editor.run(setPhysicsGlobals({ wind: { ...physics.wind, x } }, 'wind')), 'Wind X')}{num(physics.wind.y, (y) => editor.run(setPhysicsGlobals({ wind: { ...physics.wind, y } }, 'wind')), 'Wind Y')}</span>
          </div>
        </div>
      </div>
      {!setting ? <div className="muted pad">No physics groups. Add one, or let AI Tools → Auto Rig create hair physics.</div> : (
        <div className="ph-main">
          <div className="row-flex">
            <input className="tl-name" value={setting.name} onChange={(e) => upd((s) => { s.name = e.target.value; }, `phname:${setting.id}`)} aria-label="Group name" />
            <StrandView strand={strands[idx]} />
          </div>
          <h4>Inputs</h4>
          <table className="ph-table"><thead><tr><th>Parameter</th><th>Type</th><th>Weight %</th><th>Reflect</th><th /></tr></thead><tbody>
            {setting.inputs.map((inp, i) => (
              <tr key={i}>
                <td>{paramSelect(inp.parameterId, (v) => upd((s) => { s.inputs[i]!.parameterId = v; }), `Input ${i} parameter`)}</td>
                <td>{typeSelect(inp.type, (v) => upd((s) => { s.inputs[i]!.type = v; }), `Input ${i} type`)}</td>
                <td>{num(inp.weight, (v) => upd((s) => { s.inputs[i]!.weight = Math.min(100, Math.max(0, v)); }, `in-w:${i}`), `Input ${i} weight`, 1)}</td>
                <td><input type="checkbox" checked={inp.reflect} onChange={(e) => upd((s) => { s.inputs[i]!.reflect = e.target.checked; })} /></td>
                <td><button className="icon-btn" onClick={() => upd((s) => { s.inputs.splice(i, 1); })} aria-label="Remove input">✕</button></td>
              </tr>
            ))}
          </tbody></table>
          <button className="btn small" onClick={() => upd((s) => { s.inputs.push({ parameterId: params[0]?.id ?? '', type: 'x', weight: 50, reflect: false }); })}>+ Input</button>
          <h4>Outputs</h4>
          <table className="ph-table"><thead><tr><th>Parameter</th><th>Type</th><th>Vertex</th><th>Scale</th><th>Weight %</th><th>Reflect</th><th /></tr></thead><tbody>
            {setting.outputs.map((o, i) => (
              <tr key={i}>
                <td>{paramSelect(o.parameterId, (v) => upd((s) => { s.outputs[i]!.parameterId = v; }), `Output ${i} parameter`)}</td>
                <td>{typeSelect(o.type, (v) => upd((s) => { s.outputs[i]!.type = v; }), `Output ${i} type`)}</td>
                <td>{num(o.vertexIndex, (v) => upd((s) => { s.outputs[i]!.vertexIndex = Math.min(s.particles.length - 1, Math.max(1, Math.round(v))); }), `Output ${i} vertex`, 1)}</td>
                <td>{num(o.scale, (v) => upd((s) => { s.outputs[i]!.scale = v; }, `out-s:${i}`), `Output ${i} scale`, 0.1)}</td>
                <td>{num(o.weight, (v) => upd((s) => { s.outputs[i]!.weight = Math.min(100, Math.max(0, v)); }, `out-w:${i}`), `Output ${i} weight`, 1)}</td>
                <td><input type="checkbox" checked={o.reflect} onChange={(e) => upd((s) => { s.outputs[i]!.reflect = e.target.checked; })} /></td>
                <td><button className="icon-btn" onClick={() => upd((s) => { s.outputs.splice(i, 1); })} aria-label="Remove output">✕</button></td>
              </tr>
            ))}
          </tbody></table>
          <button className="btn small" onClick={() => upd((s) => { s.outputs.push({ parameterId: params[0]?.id ?? '', type: 'angle', vertexIndex: Math.min(1, s.particles.length - 1), scale: 1.5, weight: 100, reflect: false }); })}>+ Output</button>
          <h4>Pendulum (particles)</h4>
          <table className="ph-table"><thead><tr><th>#</th><th>Length</th><th>Mobility</th><th>Delay</th><th>Acceleration</th><th /></tr></thead><tbody>
            {setting.particles.map((p, i) => (
              <tr key={i}>
                <td>{i}</td>
                <td>{i === 0 ? <span className="muted">root</span> : num(p.radius, (v) => upd((s) => { s.particles[i]!.radius = Math.max(0, v); s.particles[i]!.y = (s.particles[i - 1]?.y ?? 0) + Math.max(0, v); }, `p-r:${i}`), `Particle ${i} length`, 1)}</td>
                <td>{i === 0 ? '' : num(p.mobility, (v) => upd((s) => { s.particles[i]!.mobility = Math.min(1, Math.max(0, v)); }, `p-m:${i}`), `Particle ${i} mobility`)}</td>
                <td>{i === 0 ? '' : num(p.delay, (v) => upd((s) => { s.particles[i]!.delay = Math.max(0, v); }, `p-d:${i}`), `Particle ${i} delay`)}</td>
                <td>{i === 0 ? '' : num(p.acceleration, (v) => upd((s) => { s.particles[i]!.acceleration = Math.max(0, v); }, `p-a:${i}`), `Particle ${i} acceleration`)}</td>
                <td>{i > 1 && <button className="icon-btn" onClick={() => upd((s) => { s.particles.splice(i, 1); s.outputs.forEach((o) => { o.vertexIndex = Math.min(o.vertexIndex, s.particles.length - 1); }); })} aria-label="Remove particle">✕</button>}</td>
              </tr>
            ))}
          </tbody></table>
          <button className="btn small" onClick={() => upd((s) => { const lp = s.particles[s.particles.length - 1]!; s.particles.push({ ...lp, y: lp.y + (lp.radius || 10), radius: lp.radius || 10 }); })}>+ Particle</button>
          <h4>Normalization</h4>
          <div className="form-grid tight">
            {(['position', 'angle'] as const).map((k) => (
              <span key={k} style={{ display: 'contents' }}>
                <label>{k === 'position' ? 'Position' : 'Angle'} min/def/max</label>
                <span className="pair">
                  {(['min', 'default', 'max'] as const).map((f) => <span key={f}>{num(setting.normalization[k][f], (v) => upd((s) => { s.normalization[k][f] = v; }, `norm:${k}:${f}`), `${k} ${f}`, 0.5)}</span>)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StrandView({ strand }: { strand?: Array<{ x: number; y: number }> }) {
  const pts = strand ?? [];
  const max = Math.max(1, ...pts.map((p) => Math.hypot(p.x - (pts[0]?.x ?? 0), p.y - (pts[0]?.y ?? 0))));
  const s = 40 / max;
  const ox = 50 - (pts[0]?.x ?? 0) * s, oy = 8 - (pts[0]?.y ?? 0) * s;
  return (
    <svg className="strand" width={100} height={56} aria-label="Pendulum preview">
      <polyline points={pts.map((p) => `${ox + p.x * s},${oy + p.y * s}`).join(' ')} />
      {pts.map((p, i) => <circle key={i} cx={ox + p.x * s} cy={oy + p.y * s} r={i ? 3 : 2} />)}
      {!pts.length && <text x={6} y={32} className="axis">enable preview</text>}
    </svg>
  );
}
