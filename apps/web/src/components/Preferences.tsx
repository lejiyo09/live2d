import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { SHORTCUTS, defaultKeys, formatKeys, keysOfEvent, rebind, resetBindings } from '../state/shortcuts.ts';
import { log } from '../state/editor.ts';

/** Readable names for actions in the shortcut editor. */
const LABELS: Record<string, string> = {
  open: 'Open file', save: 'Save', export: 'Export package', projects: 'Recent projects', undo: 'Undo', redo: 'Redo', redoAlt: 'Redo (alt)',
  selectAll: 'Select all', deselect: 'Deselect / exit mode', meshEdit: 'Mesh edit tool', selectTool: 'Select tool', autoMesh: 'Auto mesh',
  nudgeL: 'Nudge left', nudgeR: 'Nudge right', nudgeU: 'Nudge up', nudgeD: 'Nudge down', nudgeL10: 'Nudge left ×10', nudgeR10: 'Nudge right ×10', nudgeU10: 'Nudge up ×10', nudgeD10: 'Nudge down ×10',
  deform: 'Deform tool', copyKeyform: 'Copy keyform', pasteKeyform: 'Paste keyform', resetParams: 'Reset parameter values', keyAnim: 'Key changed parameters',
  prevFrame: 'Previous frame', nextFrame: 'Next frame', meshConnect: 'Mesh: connect', meshFlip: 'Mesh: remove/flip edge', meshTriangle: 'Mesh: triangle',
  meshDeleteTris: 'Mesh: delete triangles', meshUv: 'Mesh: UV mode', bezier: 'Deform: Bézier warp editing', pen: 'ArtPath pen', penFinish: 'Pen: finish path', group: 'Group', ungroup: 'Ungroup', delete: 'Delete', deleteAlt: 'Delete (alt)',
  forward: 'Bring forward', backward: 'Send backward', hide: 'Toggle visibility', lock: 'Toggle lock', fit: 'Fit to window', zoom100: 'Zoom 100%', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
};

interface PrefState { open: boolean; uiScale: number; reduceMotion: boolean; textureQuality: 'auto' | 'full' | 'half' | 'quarter' }
function loadPrefs(): Pick<PrefState, 'uiScale' | 'reduceMotion' | 'textureQuality'> {
  const d = { uiScale: 1, reduceMotion: false, textureQuality: 'auto' as const };
  try { return { ...d, ...JSON.parse(localStorage.getItem('l2s:prefs') ?? '{}') }; } catch { return d; }
}
export const usePrefs = create<PrefState>(() => ({ open: false, ...loadPrefs() }));
usePrefs.subscribe((s) => {
  try { localStorage.setItem('l2s:prefs', JSON.stringify({ uiScale: s.uiScale, reduceMotion: s.reduceMotion, textureQuality: s.textureQuality })); } catch { /* ignore */ }
  applyPrefs();
});
export function applyPrefs() {
  const { uiScale, reduceMotion } = usePrefs.getState();
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  document.documentElement.classList.toggle('reduce-motion', reduceMotion);
}

export function PreferencesDialog() {
  const { open, uiScale, reduceMotion, textureQuality } = usePrefs();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const k = keysOfEvent(e);
      if (!k) return;
      const conflict = rebind(capturing, k);
      if (conflict) log('warn', `${formatKeys(k)} was used by "${LABELS[conflict] ?? conflict}"; that action is now unbound.`);
      setCapturing(null);
      force((x) => x + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && usePrefs.setState({ open: false })}>
      <div className="modal wide" role="dialog" aria-label="Preferences">
        <header><h3>Preferences</h3><button onClick={() => usePrefs.setState({ open: false })} aria-label="Close">✕</button></header>
        <h4>Accessibility</h4>
        <div className="form-grid">
          <label htmlFor="ui-scale">Interface size</label>
          <select id="ui-scale" value={uiScale} onChange={(e) => usePrefs.setState({ uiScale: Number(e.target.value) })}>
            {[0.9, 1, 1.15, 1.3, 1.5].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
          </select>
          <label htmlFor="reduce-motion">Reduce motion</label>
          <input id="reduce-motion" type="checkbox" checked={reduceMotion} onChange={(e) => usePrefs.setState({ reduceMotion: e.target.checked })} />
        </div>
        <h4>Performance</h4>
        <div className="form-grid">
          <label htmlFor="tex-q">Texture quality</label>
          <select id="tex-q" value={textureQuality} onChange={(e) => usePrefs.setState({ textureQuality: e.target.value as PrefState['textureQuality'] })} aria-label="Texture quality">
            <option value="auto">Auto (fit device memory)</option><option value="full">Full</option><option value="half">Half (½ memory per side)</option><option value="quarter">Quarter</option>
          </select>
        </div>
        <p className="muted small">Applies when a project is opened or imported. Originals are always kept at full resolution.</p>
        <h4>Keyboard shortcuts</h4>
        <p className="muted small">Click a shortcut, then press the new key combination (Esc cancels). Mesh, deform and nudge keys only act in their modes.</p>
        <table className="report shortcuts" data-testid="shortcut-table"><tbody>
          {Object.entries(SHORTCUTS).map(([id, s]) => (
            <tr key={id}>
              <td>{LABELS[id] ?? id}</td>
              <td>
                <button className={capturing === id ? 'btn small primary' : 'btn small'} onClick={() => setCapturing(id)} data-shortcut={id} aria-label={`Change shortcut for ${LABELS[id] ?? id}`}>
                  {capturing === id ? 'Press keys…' : s.keys ? formatKeys(s.keys) : '—'}
                </button>
              </td>
              <td>{s.keys !== defaultKeys(id) && <button className="btn small" onClick={() => { rebind(id, defaultKeys(id)!); force((x) => x + 1); }}>Default</button>}</td>
            </tr>
          ))}
        </tbody></table>
        <footer className="dialog-actions">
          <button onClick={() => { resetBindings(); force((x) => x + 1); }}>Reset all shortcuts</button>
          <button className="primary" onClick={() => usePrefs.setState({ open: false })}>Done</button>
        </footer>
      </div>
    </div>
  );
}
