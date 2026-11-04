import { aiActions, useAi } from '../state/ai.ts';
import { useEditor } from '../state/editor.ts';

export function RecognizeDialog() {
  const r = useAi((s) => s.recognize);
  if (!r) return null;
  const n = Object.values(r.accepted).filter(Boolean).length;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && aiActions.closeRecognize()}>
      <div className="modal wide" role="dialog" aria-label="Recognize Parts">
        <header><h3>Recognize Parts</h3><button onClick={aiActions.closeRecognize} aria-label="Close">✕</button></header>
        <p className="muted small">Suggestions from layer/folder names and from shape and position relative to the face. Nothing changes until you apply; your own tags are never overwritten.</p>
        {r.suggestions.length === 0 ? <p>No new suggestions.</p> : (
          <table className="report"><thead><tr><th /><th>Layer</th><th>Current</th><th>Suggested</th><th>Conf.</th><th>Why</th></tr></thead><tbody>
            {r.suggestions.map((s) => (
              <tr key={s.layerId}>
                <td><input type="checkbox" checked={!!r.accepted[s.layerId]} onChange={(e) => aiActions.toggleSuggestion(s.layerId, e.target.checked)} aria-label={`Accept ${s.layerName}`} /></td>
                <td>{s.layerName}</td>
                <td className="muted">{s.current?.category ?? '—'}</td>
                <td><span className={`tag tag-${s.suggested.source}`}>{s.suggested.category}</span></td>
                <td>{Math.round(s.suggested.confidence * 100)}%</td>
                <td className="muted small">{s.reason}</td>
              </tr>
            ))}
          </tbody></table>
        )}
        <footer className="dialog-actions">
          <button onClick={aiActions.closeRecognize}>Cancel</button>
          <button className="primary" disabled={!n} onClick={aiActions.applyRecognize} data-testid="recognize-apply">Apply {n}</button>
        </footer>
      </div>
    </div>
  );
}

export function AutoRigDialog() {
  const rig = useAi((s) => s.rig);
  const nodes = useEditor((s) => s.project.nodes);
  if (!rig) return null;
  const { proposal } = rig;
  const any = proposal.steps.some((s) => s.enabled);
  const names = (ids: string[]) => ids.slice(0, 6).map((id) => nodes[id]?.name ?? id).join(', ') + (ids.length > 6 ? ` +${ids.length - 6}` : '');
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && aiActions.closeRig()}>
      <div className="modal wide" role="dialog" aria-label="Auto Rig">
        <header><h3>{rig.source === 'assistant' ? 'Assistant Plan' : 'Auto Rig — Draft Proposal'}</h3><button onClick={aiActions.closeRig} aria-label="Close">✕</button></header>
        {rig.plan && <ul className="plan">{rig.plan.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        <p className="muted small">Rule-based draft from part tags. Applied as a single undo step; every generated deformer and keyform stays editable.</p>
        {proposal.notes.map((n, i) => <p key={i} className="warn-text small">⚠ {n}</p>)}
        <ul className="steps">
          {proposal.steps.map((s) => (
            <li key={s.id} className={s.enabled ? '' : 'off'}>
              <label>
                <input type="checkbox" checked={s.enabled} onChange={(e) => aiActions.toggleStep(s.id, e.target.checked)} data-step={s.id} />
                <strong>{s.title}</strong>
              </label>
              <div className="muted small">{s.detail}</div>
              {s.targets.length > 0 && <div className="small targets">{names(s.targets)}</div>}
            </li>
          ))}
        </ul>
        {proposal.physicsCandidates.length > 0 && <p className="muted small">Physics candidates (Phase 5): {names(proposal.physicsCandidates)}</p>}
        {proposal.pairs.length > 0 && <p className="muted small">Symmetric pairs: {proposal.pairs.length}</p>}
        <footer className="dialog-actions">
          <button onClick={aiActions.closeRig}>Cancel</button>
          <button disabled={!any} onClick={() => aiActions.applyRig(true)} data-testid="rig-preview">Preview</button>
          <button className="primary" disabled={!any} onClick={() => aiActions.applyRig(false)} data-testid="rig-apply">Apply</button>
        </footer>
      </div>
    </div>
  );
}

export function AssistantDialog() {
  const open = useAi((s) => s.assistantOpen);
  const text = useAi((s) => s.assistantText);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && aiActions.openAssistant(false)}>
      <form className="modal" role="dialog" aria-label="Rigging Assistant" onSubmit={(e) => { e.preventDefault(); aiActions.openAssistant(false); aiActions.ask(); }}>
        <header><h3>Rigging Assistant</h3><button type="button" onClick={() => aiActions.openAssistant(false)} aria-label="Close">✕</button></header>
        <textarea className="assistant-input" autoFocus rows={3} value={text} placeholder="예: 앞머리가 머리 회전에 맞춰 자연스럽게 움직이도록 해줘." onChange={(e) => aiActions.setAssistantText(e.target.value)} aria-label="Request" />
        <p className="muted small">Requests are interpreted locally in the browser; nothing is uploaded. You will see the plan before anything changes.</p>
        <footer className="dialog-actions"><button type="submit" className="primary" data-testid="assistant-ask">Make a plan</button></footer>
      </form>
    </div>
  );
}

export function PreviewBanner() {
  const preview = useAi((s) => s.preview);
  const demo = useAi((s) => s.demo);
  if (!preview) return null;
  return (
    <div className="preview-banner" data-testid="ai-preview">
      <strong>Previewing: {preview.label}</strong>
      <button className="btn" onClick={() => aiActions.setDemo(!demo)}>{demo ? 'Stop motion' : 'Play motion'}</button>
      <button className="btn" onClick={aiActions.discard} data-testid="ai-discard">Discard</button>
      <button className="btn primary" onClick={aiActions.keep} data-testid="ai-keep">Keep</button>
    </div>
  );
}

export function AnalyzerPanel() {
  const findings = useAi((s) => s.findings);
  const at = useAi((s) => s.analyzedAt);
  return (
    <div>
      <div className="pad row-flex">
        <button className="btn" onClick={aiActions.analyze}>Analyze rig</button>
        <span className="muted">{at ? `Last run ${at}` : 'Not run yet'}{findings ? ` — ${findings.filter((f) => f.severity === 'error').length} error(s), ${findings.filter((f) => f.severity === 'suggestion').length} suggestion(s)` : ''}</span>
      </div>
      {findings && findings.length > 0 && (
        <table className="report" data-testid="analyzer"><tbody>
          {findings.map((f, i) => (
            <tr key={i} className="clickable" onClick={() => aiActions.focusFinding(f)} title={f.at ? `Click to select and jump to ${Object.entries(f.at).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'Click to select'}>
              <td className={f.severity === 'error' ? 'sev error' : 'sev warn'}>{f.severity}</td>
              <td className="code">{f.kind}</td>
              <td>{f.targetName ?? ''}</td>
              <td>{f.message}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
