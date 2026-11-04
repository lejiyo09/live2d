import { useEffect, useRef } from 'react';
import { describeInfo } from '@l2s/cubism-adapter';
import { moc3Actions, useMoc3 } from '../state/moc3.ts';

/** Read-only preview of an existing MOC3 model through the user's official Cubism Core (spec §11.2–11.3). */
export function Moc3Preview() {
  const s = useMoc3();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!s.open) return;
    void moc3Actions.attach(host.current);
    return () => { void moc3Actions.attach(null); };
  }, [s.open]);
  if (!s.open) return null;
  return (
    <div className="modal-backdrop">
      <div className="moc3" role="dialog" aria-label="MOC3 Preview">
        <aside className="moc3-side">
          <header className="row-flex"><h3>MOC3 Preview</h3><span className="muted small">read-only</span><span className="spacer" /><button onClick={() => moc3Actions.setOpen(false)} aria-label="Close">✕</button></header>
          <section>
            <h4>1 · Cubism Core</h4>
            {s.coreVersion ? <p className="small">Loaded {s.coreVersion !== 'loaded' ? `v${s.coreVersion}` : ''}</p> : (
              <p className="muted small">
                Choose <code>live2dcubismcore.min.js</code> from the official <strong>Cubism SDK for Web</strong> (Live2D Proprietary Software License).
                It is not bundled with Live2D Studio and is used only in this tab.
              </p>
            )}
            <label className="btn small file-btn">
              Choose Core file…
              <input type="file" accept=".js" hidden data-testid="core-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void moc3Actions.loadCore(f); e.target.value = ''; }} />
            </label>
          </section>
          <section>
            <h4>2 · Model</h4>
            <div className="row-flex">
              <label className={`btn small file-btn${s.coreVersion ? '' : ' disabled'}`}>
                Model folder…
                <input type="file" hidden disabled={!s.coreVersion} {...{ webkitdirectory: '', directory: '' }} onChange={(e) => { if (e.target.files) void moc3Actions.loadModel(e.target.files); e.target.value = ''; }} />
              </label>
              <label className={`btn small file-btn${s.coreVersion ? '' : ' disabled'}`}>
                Zip / files…
                <input type="file" multiple hidden disabled={!s.coreVersion} accept=".zip,.json,.moc3,.png" data-testid="model-input" onChange={(e) => { if (e.target.files) void moc3Actions.loadModel(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
            {s.loading && <p className="small">{s.loading}</p>}
            {s.issues.map((i, k) => <p key={k} className={i.severity === 'error' ? 'error-text small' : 'warn-text small'}>{i.severity === 'error' ? '✕' : '⚠'} {i.message}</p>)}
            {s.info && <div className="small" data-testid="moc3-info">{[`Model: ${s.modelName}`, ...describeInfo(s.info)].map((l) => <div key={l}>{l}</div>)}</div>}
          </section>
          {s.info && (
            <>
              <section>
                <h4>Motions, expressions & physics</h4>
                <div className="row-flex wrap">
                  {s.motions.map((m) => <button key={m.name} className={s.playing === m.name ? 'btn small primary' : 'btn small'} onClick={() => moc3Actions.play(s.playing === m.name ? null : m.name)}>{m.group}: {m.name}</button>)}
                  {!s.motions.length && <span className="muted small">No motions</span>}
                </div>
                {s.expressions.length > 0 && (
                  <div className="row-flex wrap">
                    {s.expressions.map((x) => <button key={x.name} className={s.expression === x.name ? 'btn small primary' : 'btn small'} onClick={() => moc3Actions.setExpression(s.expression === x.name ? null : x.name)}>{x.name}</button>)}
                  </div>
                )}
                <label className="small"><input type="checkbox" disabled={!s.hasPhysics} checked={s.physics} onChange={(e) => moc3Actions.setPhysics(e.target.checked)} /> Physics (physics3.json via Live2D Studio's engine)</label>
                <div className="row-flex"><button className="btn small" onClick={moc3Actions.reset}>Reset</button><button className="btn small" onClick={moc3Actions.fit}>Fit</button></div>
              </section>
              <section className="moc3-params">
                <h4>Parameters</h4>
                {s.info.parameters.map((p) => (
                  <div key={p.id} className="moc3-param">
                    <span className="mono small" title={p.id}>{p.id}</span>
                    <input type="range" min={p.min} max={p.max} step={(p.max - p.min) / 200} value={s.values[p.id] ?? p.default} aria-label={p.id} onChange={(e) => moc3Actions.setValue(p.id, Number(e.target.value))} onDoubleClick={() => moc3Actions.setValue(p.id, p.default)} />
                  </div>
                ))}
              </section>
            </>
          )}
        </aside>
        <div className="moc3-canvas" ref={host} />
      </div>
    </div>
  );
}
