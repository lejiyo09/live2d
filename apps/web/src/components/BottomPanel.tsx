import { editor, useEditor } from '../state/editor.ts';
import { meshActions, useMesh } from '../state/mesh.ts';
import { ParameterPanel } from './ParameterPanel.tsx';
import { AnalyzerPanel } from './AiDialogs.tsx';
import { TimelinePanel } from './TimelinePanel.tsx';
import { CurveEditor } from './CurveEditor.tsx';
import { PhysicsPanel } from './PhysicsPanel.tsx';

const PLANNED = [] as Array<readonly [string, string]>;

export function BottomPanel() {
  const tab = useEditor((s) => s.bottomTab);
  const warnings = useEditor((s) => s.importWarnings);
  const logs = useEditor((s) => s.logs);
  const undo = useEditor((s) => s.undoLabels);
  const redo = useEditor((s) => s.redoLabels);
  return (
    <section className="panel bottom-panel" aria-label="Bottom panel">
      <header className="panel-header tabs" role="tablist">
        <Tab id="params" label="Parameters" active={tab} />
        <Tab id="timeline" label="Timeline" active={tab} />
        <Tab id="curves" label="Curves" active={tab} />
        <Tab id="physics" label="Physics" active={tab} />
        <Tab id="report" label={`Import Report${warnings.length ? ` (${warnings.length})` : ''}`} active={tab} />
        <Tab id="mesh" label="Mesh Check" active={tab} />
        <Tab id="analyzer" label="Rig Analyzer" active={tab} />
        <Tab id="history" label="History" active={tab} />
        <Tab id="console" label="Debug Console" active={tab} />
        {PLANNED.map(([l, p]) => <button key={l} className="tab" disabled title={`Planned: ${p}`}>{l}</button>)}
      </header>
      <div className="bottom-body">
        {tab === 'report' && (
          warnings.length === 0
            ? <div className="muted pad">No import warnings. Layer structure, order, visibility, opacity, blend modes, masks and clipping were preserved.</div>
            : <table className="report"><tbody>{warnings.map((w, i) => (
                <tr key={i}><td className="code">{w.code}</td><td>{w.layerName ?? '—'}</td><td>{w.message}</td></tr>
              ))}</tbody></table>
        )}
        {tab === 'mesh' && <MeshCheck />}
        {tab === 'params' && <ParameterPanel />}
        {tab === 'analyzer' && <AnalyzerPanel />}
        {tab === 'timeline' && <TimelinePanel />}
        {tab === 'curves' && <CurveEditor />}
        {tab === 'physics' && <PhysicsPanel />}
        {tab === 'history' && (
          <ol className="history-list">
            <li className="muted">(Initial state)</li>
            {undo.map((l, i) => <li key={`u${i}`} className={i === undo.length - 1 ? 'current' : ''}>{l}</li>)}
            {redo.map((l, i) => <li key={`r${i}`} className="redo">{l}</li>)}
          </ol>
        )}
        {tab === 'console' && (
          <div className="console" data-testid="console">
            {logs.map((l) => <div key={l.id} className={`log ${l.level}`}><span className="time">{l.time}</span> {l.message}</div>)}
          </div>
        )}
      </div>
    </section>
  );
}

function MeshCheck() {
  const rows = useMesh((s) => s.checkRows);
  const at = useMesh((s) => s.checkedAt);
  return (
    <div>
      <div className="pad row-flex">
        <button className="btn" onClick={() => meshActions.runCheck()}>Check all meshes</button>
        <button className="btn" onClick={() => meshActions.runCheck(meshActions.selectedLayers().map((l) => l.id))}>Check selected</button>
        <span className="muted">{at ? `Last run ${at}` : 'Not run yet'}{rows && rows.length === 0 ? ' — no problems found' : ''}</span>
      </div>
      {rows && rows.length > 0 && (
        <table className="report" data-testid="mesh-check"><tbody>
          {rows.map((r, i) => (
            <tr key={i} className="clickable" onClick={() => editor.selectIds([r.layerId])}>
              <td className={r.issue.severity === 'error' ? 'sev error' : 'sev warn'}>{r.issue.severity}</td>
              <td>{r.layerName}</td>
              <td className="code">{r.issue.code}</td>
              <td>{r.issue.message}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

function Tab({ id, label, active }: { id: 'report' | 'history' | 'console' | 'mesh' | 'params' | 'analyzer' | 'timeline' | 'curves' | 'physics'; label: string; active: string }) {
  return <button role="tab" data-testid={`tab-${id}`} aria-selected={active === id} className={active === id ? 'tab active' : 'tab'} onClick={() => editor.setBottomTab(id)}>{label}</button>;
}
