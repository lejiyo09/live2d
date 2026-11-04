import { useState } from 'react';
import { zip } from 'fflate';
import { BufferTarget, CanvasSource, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } from 'mediabunny';
import { simulateClip } from '@l2s/animation-engine';
import { evaluateModel } from '@l2s/deformer-engine';
import { editor, log } from '../state/editor.ts';
import { activeClip, animActions, useAnim } from '../state/anim.ts';

type Format = 'png' | 'webm';

/** Render the active animation to an image sequence or video (spec §9.3). */
export function ExportDialog() {
  const open = useAnim((s) => s.exportOpen);
  const exporting = useAnim((s) => s.exporting);
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(0.5);
  const [transparent, setTransparent] = useState(true);
  const [bg, setBg] = useState('#ffffff');
  const [physics, setPhysics] = useState(true);
  const [useRange, setUseRange] = useState(true);
  const clip = activeClip();
  if (!open || !clip) return null;
  const p = editor.project;
  const w = Math.round(p.canvas.width * scale), h = Math.round(p.canvas.height * scale);
  const start = useRange && clip.range ? clip.range.start : 0, end = useRange && clip.range ? clip.range.end : clip.duration;
  const frames = Math.round((end - start) * clip.fps) + 1;

  const run = async () => {
    const r = editor.renderer;
    if (!r) return;
    animActions.pause();
    animActions.setPhysics(false);
    const values = simulateClip(p, clip, { physics, warmup: physics ? 1 : 0 });
    const first = Math.round(start * clip.fps);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const draw = (f: number) => {
      const model = evaluateModel(p, values[first + f]!);
      r.sync(p, model);
      const art = r.extractArtwork(scale);
      ctx.clearRect(0, 0, w, h);
      if (!transparent) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
      if (art) ctx.drawImage(art, 0, 0, w, h);
    };
    useAnim.setState({ exporting: { done: 0, total: frames } });
    try {
      const base = `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}_${clip.name.replace(/[\\/:*?"<>|]+/g, '_')}`;
      if (format === 'png') {
        const files: Record<string, Uint8Array> = {};
        for (let f = 0; f < frames; f++) {
          draw(f);
          const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
          files[`${base}_${String(f).padStart(4, '0')}.png`] = new Uint8Array(await blob.arrayBuffer());
          useAnim.setState({ exporting: { done: f + 1, total: frames } });
        }
        const data = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 0 }, (e, d) => (e ? rej(e) : res(d))));
        download(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${base}_png.zip`);
      } else {
        const codec = (await canEncodeVideo('vp9', { width: w, height: h })) ? 'vp9' : (await canEncodeVideo('vp8', { width: w, height: h })) ? 'vp8' : null;
        if (!codec) throw new Error('This browser cannot encode WebM video (WebCodecs VP8/VP9). Use the PNG sequence instead.');
        const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
        const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH, ...(transparent ? { alpha: 'keep' as const } : {}) });
        output.addVideoTrack(source, { frameRate: clip.fps });
        await output.start();
        for (let f = 0; f < frames; f++) {
          draw(f);
          await source.add(f / clip.fps, 1 / clip.fps);
          useAnim.setState({ exporting: { done: f + 1, total: frames } });
        }
        await output.finalize();
        const buf = (output.target as BufferTarget).buffer!;
        download(new Blob([buf], { type: 'video/webm' }), `${base}.webm`);
      }
      log('info', `Exported ${frames} frame(s) of "${clip.name}" as ${format === 'png' ? 'PNG sequence' : 'WebM'} (${w}×${h}${transparent ? ', transparent' : ''}${physics ? ', with physics' : ''}).`);
      animActions.openExport(false);
    } catch (e) {
      log('error', `Export failed: ${(e as Error).message}`);
    } finally {
      useAnim.setState({ exporting: null });
      editor.setDriven(null);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !exporting && animActions.openExport(false)}>
      <div className="modal" role="dialog" aria-label="Export animation">
        <header><h3>Export “{clip.name}”</h3></header>
        <div className="form-grid">
          <label>Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} aria-label="Format"><option value="png">PNG sequence (.zip)</option><option value="webm">Video (WebM)</option></select>
          <label>Resolution</label>
          <span className="range-row"><select value={scale} onChange={(e) => setScale(Number(e.target.value))} aria-label="Scale">{[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{Math.round(s * 100)}%</option>)}</select><span className="muted">{w}×{h}px</span></span>
          <label>Frame rate</label><span>{clip.fps} fps · {frames} frames</span>
          <label>Transparent</label><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} aria-label="Transparent background" />
          {!transparent && <><label>Background</label><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} aria-label="Background colour" /></>}
          <label>Physics</label><input type="checkbox" checked={physics} onChange={(e) => setPhysics(e.target.checked)} aria-label="Simulate physics" />
          {clip.range && <><label>Work range only</label><input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} /></>}
        </div>
        {format === 'webm' && transparent && <p className="muted small">Transparency in WebM needs VP9 alpha support in the player.</p>}
        {exporting && <progress max={exporting.total} value={exporting.done} style={{ width: '100%' }} />}
        <footer className="dialog-actions">
          <button disabled={!!exporting} onClick={() => animActions.openExport(false)}>Cancel</button>
          <button className="primary" disabled={!!exporting} onClick={() => void run()} data-testid="export-run">Export</button>
        </footer>
      </div>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
