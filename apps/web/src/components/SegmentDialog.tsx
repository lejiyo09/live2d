import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { newId, type GroupNode, type LayerNode } from '@l2s/editor-core';
import { regionPixels, segmentLayer, type Region } from '@l2s/ai-engine';
import { editor, log, useEditor } from '../state/editor.ts';

export const useSegment = create<{ open: boolean }>(() => ({ open: false }));

/**
 * AI Tools → Split Layer into Parts (spec §10.2). Classical segmentation
 * (alpha islands or colour regions) — no learned model is involved.
 */
export function SegmentDialog() {
  const open = useSegment((s) => s.open);
  const sel = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const [mode, setMode] = useState<'islands' | 'colors'>('islands');
  const [k, setK] = useState(3);
  const [src, setSrc] = useState<{ id: string; rgba: Uint8ClampedArray; width: number; height: number } | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = sel.anchor && project.nodes[sel.anchor]?.kind === 'layer' ? (project.nodes[sel.anchor] as LayerNode) : null;

  useEffect(() => {
    if (!open || !layer || layer.assets.display.startsWith('builtin:')) { setSrc(null); return; }
    let alive = true;
    void editor.layerPixels(layer.id).then((p) => { if (alive && p) setSrc({ id: layer.id, ...p }); });
    return () => { alive = false; };
  }, [open, layer?.id]);

  useEffect(() => {
    if (!src) { setRegions([]); return; }
    const r = segmentLayer(src.rgba, src.width, src.height, { mode, clusters: k });
    setRegions(r);
    const c = canvas.current;
    if (!c) return;
    const s = Math.min(1, 260 / Math.max(src.width, src.height));
    c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
    const g = c.getContext('2d')!;
    const img = g.createImageData(src.width, src.height);
    r.forEach((reg, i) => {
      const hue = (i * 137.5) % 360, [cr, cg, cb] = hsl(hue, 0.7, 0.55);
      for (let y = 0; y < reg.height; y++) for (let x = 0; x < reg.width; x++) {
        const a = reg.mask[y * reg.width + x]!;
        if (a) img.data.set([cr, cg, cb, a], ((reg.y + y) * src.width + reg.x + x) * 4);
      }
    });
    const tmp = new OffscreenCanvas(src.width, src.height);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(tmp, 0, 0, c.width, c.height);
  }, [src, mode, k]);

  if (!open) return null;
  const apply = async () => {
    if (!src || !layer || regions.length < 2) return;
    const items = regions.map((r) => ({ id: newId('ast'), region: r, rgba: regionPixels(src.rgba, src.width, r) }));
    await editor.addLayerAssets(items.map((it) => ({ id: it.id, rgba: it.rgba, width: it.region.width, height: it.region.height })));
    const groupId = newId('grp');
    editor.run({
      label: 'Split Layer into Parts',
      apply(d) {
        const orig = d.nodes[layer.id] as LayerNode;
        const siblings = orig.parentId ? (d.nodes[orig.parentId] as GroupNode).childIds : d.rootIds;
        const at = siblings.indexOf(orig.id);
        const group: GroupNode = { id: groupId, kind: 'group', name: `${orig.name} (parts)`, parentId: orig.parentId, visible: true, locked: false, opacity: 1, blendMode: 'pass-through', childIds: [], collapsed: false };
        d.nodes[groupId] = group;
        siblings.splice(at, 1, groupId);
        // Keep the original (hidden) at the bottom of the new folder.
        orig.parentId = groupId; orig.visible = false; group.childIds.push(orig.id);
        items.slice().reverse().forEach((it, i) => {
          const id = newId('lyr');
          d.nodes[id] = {
            id, kind: 'layer', name: `${orig.name} part ${items.length - i}`, parentId: groupId, visible: true, locked: false, opacity: orig.opacity, blendMode: orig.blendMode,
            bounds: { x: orig.bounds.x + it.region.x, y: orig.bounds.y + it.region.y, width: it.region.width, height: it.region.height },
            assets: { original: it.id, display: it.id }, clipping: false, sourcePath: [...orig.sourcePath],
          } satisfies LayerNode;
          group.childIds.push(id);
        });
        d.updatedAt = new Date().toISOString();
      },
    });
    editor.selectIds([groupId]);
    log('info', `Split "${layer.name}" into ${regions.length} part layers (${mode === 'islands' ? 'alpha islands' : `${k} colour clusters`}); the original is kept hidden.`);
    useSegment.setState({ open: false });
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && useSegment.setState({ open: false })}>
      <div className="modal" role="dialog" aria-label="Split Layer into Parts">
        <header><h3>Split Layer into Parts</h3><button onClick={() => useSegment.setState({ open: false })} aria-label="Close">✕</button></header>
        {!layer ? <p className="muted">Select a layer first.</p> : (
          <>
            <p className="muted small">Classical segmentation (no learned model): separate <strong>alpha islands</strong>, or <strong>colour regions</strong> within the layer. Hidden/occluded art is not reconstructed — touch it up afterwards. The original layer is kept, hidden.</p>
            <div className="form-grid">
              <label>Layer</label><span>{layer.name}</span>
              <label>Method</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'islands' | 'colors')} aria-label="Split method"><option value="islands">Alpha islands</option><option value="colors">Colour regions</option></select>
              {mode === 'colors' && <><label>Colours</label><input type="number" min={2} max={8} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Colour clusters" /></>}
              <label>Result</label><span data-testid="segment-count">{src ? `${regions.length} part(s)` : 'Loading…'}</span>
            </div>
            <canvas ref={canvas} className="segment-preview" />
          </>
        )}
        <footer className="dialog-actions">
          <button onClick={() => useSegment.setState({ open: false })}>Cancel</button>
          <button className="primary" disabled={regions.length < 2} onClick={() => void apply()} data-testid="segment-apply">Split into {regions.length} layers</button>
        </footer>
      </div>
    </div>
  );
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
