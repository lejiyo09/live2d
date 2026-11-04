import type { AutoMeshSettings } from '@l2s/editor-core';
import { AUTO_MESH_PRESETS } from '@l2s/mesh-engine';
import { meshActions, useMesh } from '../state/mesh.ts';
import { useEditor } from '../state/editor.ts';

const FIELDS: Array<{ key: keyof AutoMeshSettings; label: string; hint: string; min: number; max: number; step: number }> = [
  { key: 'alphaThreshold', label: 'Boundary opacity', hint: 'Pixels at or above this alpha (0–255) count as drawing', min: 1, max: 255, step: 1 },
  { key: 'outerMargin', label: 'Outer margin (px)', hint: 'Outline distance outside the drawing', min: 0, max: 64, step: 1 },
  { key: 'innerMargin', label: 'Inner margin (px)', hint: 'Second ring inside the drawing (0 = none)', min: 0, max: 64, step: 1 },
  { key: 'outerSpacing', label: 'Outline spacing (px)', hint: 'Point spacing along the outline', min: 4, max: 200, step: 1 },
  { key: 'innerSpacing', label: 'Interior spacing (px)', hint: 'Maximum spacing of interior points (thin areas get denser automatically)', min: 4, max: 400, step: 1 },
  { key: 'detailFactor', label: 'Detail parts factor', hint: 'Spacing multiplier for eyes / brows / mouth (< 1 = denser)', min: 0.2, max: 1, step: 0.05 },
];

export function AutoMeshDialog() {
  const open = useMesh((s) => s.autoMeshOpen);
  const settings = useMesh((s) => s.settings);
  const preset = useMesh((s) => s.preset);
  useEditor((s) => s.selection); // re-render target count on selection change
  if (!open) return null;
  const targets = meshActions.selectedLayers();
  const run = () => { meshActions.openAutoMesh(false); void meshActions.runAutoMesh(); };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && meshActions.openAutoMesh(false)}>
      <div className="modal" role="dialog" aria-label="Auto Generate ArtMesh">
        <header><h3>Auto Generate ArtMesh</h3><button onClick={() => meshActions.openAutoMesh(false)} aria-label="Close">✕</button></header>
        <div className="form-grid">
          <label>Preset</label>
          <select
            value={preset}
            aria-label="Preset"
            onChange={(e) => {
              const k = e.target.value as keyof typeof AUTO_MESH_PRESETS;
              if (k in AUTO_MESH_PRESETS) meshActions.setSettings(AUTO_MESH_PRESETS[k], k);
            }}
          >
            <option value="standard">Standard</option>
            <option value="fine">Fine</option>
            <option value="coarse">Coarse</option>
            {preset === 'custom' && <option value="custom">Custom</option>}
          </select>
          {FIELDS.map((f) => (
            <FieldRow key={f.key} f={f} value={settings[f.key]} onChange={(v) => meshActions.setSettings({ ...settings, [f.key]: v }, 'custom')} />
          ))}
        </div>
        <p className="muted small">
          Target: {targets.length ? `${targets.length} selected layer(s)` : 'all layers'}. Existing meshes on the targets are replaced (one undo step).
          Eyes, brows and mouth (by part category) and thin areas such as hair tips get denser meshes.
        </p>
        <footer className="dialog-actions">
          <button onClick={() => meshActions.openAutoMesh(false)}>Cancel</button>
          <button className="primary" onClick={run} data-testid="automesh-run">Generate</button>
        </footer>
      </div>
    </div>
  );
}

function FieldRow({ f, value, onChange }: { f: (typeof FIELDS)[number]; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <label title={f.hint}>{f.label}</label>
      <span className="range-row">
        <input type="range" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={f.label} />
        <input type="number" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(f.max, Math.max(f.min, n))); }} />
      </span>
    </>
  );
}
