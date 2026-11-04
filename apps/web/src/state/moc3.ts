import { create } from 'zustand';
import { unzipSync } from 'fflate';
import type { AnimationClip, Expression, Parameter, PhysicsRig } from '@l2s/editor-core';
import { applyExpressions } from '@l2s/parameter-engine';
import {
  CoreLoadError, getCore, exp3ToExpression, loadCoreScript, loadMoc, motion3ToClip, openBundle, physics3ToRig, updateFrame, buildInteropBundle,
  type BundleIssue, type DrawableFrame, type LoadedModel, type ModelInfo,
} from '@l2s/cubism-adapter';
import { DrawableRenderer } from '@l2s/rendering-engine';
import { PhysicsSimulator } from '@l2s/physics-engine';
import { addClip, clipTime, sampleClip } from '@l2s/animation-engine';
import { addExpression, addParameter } from '@l2s/deformer-engine';
import { setPhysicsGlobals } from '@l2s/physics-engine';
import { editor, log } from './editor.ts';

export interface Moc3State {
  open: boolean;
  coreVersion: string | null;
  loading: string | null;
  info: ModelInfo | null;
  issues: BundleIssue[];
  values: Record<string, number>;
  motions: Array<{ group: string; name: string; clip: AnimationClip }>;
  expressions: Expression[];
  expression: string | null;
  playing: string | null;
  physics: boolean;
  hasPhysics: boolean;
  modelName: string | null;
}

export const useMoc3 = create<Moc3State>(() => ({
  open: false, coreVersion: getCore() ? 'loaded' : null, loading: null, info: null, issues: [], values: {}, motions: [], expressions: [], expression: null, playing: null, physics: false, hasPhysics: false, modelName: null,
}));
const set = useMoc3.setState;
const get = useMoc3.getState;

let renderer: DrawableRenderer | null = null;
let previewEl: HTMLDivElement | null = null;
let loaded: LoadedModel | null = null;
let sim: PhysicsSimulator | null = null;
let raf = 0, last = 0, t = 0;

function params(): Parameter[] {
  return (get().info?.parameters ?? []).map((p) => ({ id: p.id, name: p.id, min: p.min, max: p.max, default: p.default, repeat: p.repeat }));
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!loaded || !renderer) { raf = 0; return; }
  let values = { ...get().values };
  const playing = get().motions.find((m) => m.name === get().playing);
  if (playing) { t += dt; values = { ...values, ...sampleClip(playing.clip, clipTime(playing.clip, t)) }; }
  const ex = get().expressions.find((x) => x.name === get().expression);
  if (ex) values = applyExpressions(values, [{ expression: ex, weight: 1 }], params());
  if (get().physics && sim) values = sim.evaluate(values, dt);
  const f: DrawableFrame[] = updateFrame(loaded, values);
  renderer.render(f);
  if (get().open) raf = requestAnimationFrame(frame);
  else raf = 0;
}

function ensureLoop() {
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

async function filesFromInput(list: FileList | File[]): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  for (const f of Array.from(list)) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [k, v] of Object.entries(z)) if (!k.endsWith('/')) out.set(k, new Blob([v as Uint8Array<ArrayBuffer>]));
    } else {
      out.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f);
    }
  }
  return out;
}

export const moc3Actions = {
  setOpen(v: boolean) {
    set({ open: v });
    if (v) ensureLoop();
  },
  async attach(host: HTMLElement | null) {
    // One long-lived renderer, moved between hosts and paused when hidden (see StudioRenderer.setActive).
    if (!host) { renderer?.setActive(false); previewEl?.remove(); return; }
    if (!previewEl) previewEl = Object.assign(document.createElement('div'), { className: 'moc3-host' });
    host.appendChild(previewEl);
    if (!renderer) { renderer = new DrawableRenderer(); await renderer.init(previewEl); if (loaded) await moc3Actions.reloadTextures(); }
    renderer.setActive(true);
    ensureLoop();
  },
  async loadCore(file: File) {
    try {
      set({ loading: 'Loading Cubism Core…' });
      const core = await loadCoreScript(file);
      const v = core.Version.csmGetVersion();
      set({ coreVersion: `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${v & 0xffff}` });
      log('info', `Cubism Core ${get().coreVersion} loaded from ${file.name} (stays in this browser tab only).`);
    } catch (e) {
      log('error', (e as Error).message);
      if (!(e instanceof CoreLoadError)) throw e;
    } finally {
      set({ loading: null });
    }
  },
  textures: [] as Blob[],
  async reloadTextures() {
    if (!renderer || !loaded) return;
    const imgs: OffscreenCanvas[] = [];
    for (const b of moc3Actions.textures) {
      const bmp = await createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      imgs.push(c);
    }
    renderer.setTextures(imgs, loaded.info.canvas);
  },
  async loadModel(list: FileList | File[]) {
    const core = getCore();
    if (!core) { log('warn', 'Load the Cubism Core (live2dcubismcore.js) first.'); return; }
    set({ loading: 'Reading model…', issues: [] });
    try {
      const { bundle, issues } = await openBundle(await filesFromInput(list));
      set({ issues });
      if (!bundle) return;
      loaded?.release();
      loaded = null;
      const refs = bundle.model3.FileReferences;
      moc3Actions.textures = refs.Textures.map((p) => bundle.resolve(p)!);
      loaded = loadMoc(core, await bundle.resolve(refs.Moc)!.arrayBuffer(), refs.Textures.length);
      const info = loaded.info;
      // Physics and motions through Live2D Studio's own engines (validates our physics3/motion3 readers).
      let rig: PhysicsRig | null = null;
      if (refs.Physics && bundle.resolve(refs.Physics)) {
        try { rig = physics3ToRig(JSON.parse(await bundle.resolve(refs.Physics)!.text())).rig; }
        catch (e) { issues.push({ severity: 'warning', message: `physics3.json: ${(e as Error).message}` }); }
      }
      const motions: Moc3State['motions'] = [];
      for (const [group, list2] of Object.entries(refs.Motions ?? {})) {
        for (const m of list2) {
          const b = bundle.resolve(m.File);
          if (!b) continue;
          try { motions.push({ group, name: m.File.split('/').pop()!.replace(/\.motion3\.json$/i, ''), clip: motion3ToClip(JSON.parse(await b.text()), m.File).clip }); }
          catch (e) { issues.push({ severity: 'warning', message: `${m.File}: ${(e as Error).message}` }); }
        }
      }
      const expressions: Expression[] = [];
      for (const e of refs.Expressions ?? []) {
        const b = bundle.resolve(e.File);
        if (!b) { issues.push({ severity: 'warning', message: `Expression not found: ${e.File}` }); continue; }
        try { expressions.push(exp3ToExpression(JSON.parse(await b.text()), e.Name)); }
        catch (err) { issues.push({ severity: 'warning', message: `${e.File}: ${(err as Error).message}` }); }
      }
      set({ expressions, expression: null, info, issues: [...issues], values: Object.fromEntries(info.parameters.map((p) => [p.id, p.default])), motions, playing: null, physics: false, hasPhysics: !!rig?.settings.length, modelName: bundle.model3Path.split('/').pop()!.replace(/\.model3\.json$/i, '') });
      sim = rig ? new PhysicsSimulator(rig, params()) : null;
      await moc3Actions.reloadTextures();
      ensureLoop();
      log('info', `MOC3 preview: ${get().modelName} — ${info.drawables} drawables, ${info.parameters.length} parameters, moc3 v${info.mocVersion}.`);
    } catch (e) {
      set({ issues: [...get().issues, { severity: 'error', message: (e as Error).message }] });
      log('error', `MOC3 preview: ${(e as Error).message}`);
    } finally {
      set({ loading: null });
    }
  },
  setValue(id: string, v: number) { set({ values: { ...get().values, [id]: v } }); },
  reset() { set({ values: Object.fromEntries((get().info?.parameters ?? []).map((p) => [p.id, p.default])) }); sim?.reset(); },
  play(name: string | null) { t = 0; set({ playing: name }); },
  setExpression(name: string | null) { set({ expression: name }); },
  setPhysics(v: boolean) { sim?.reset(); set({ physics: v }); },
  fit() { renderer?.fit(); },
};

// ------------------------------------------------------------------ Cubism JSON export / import (editor project)

export async function exportCubismJson() {
  const p = editor.project;
  const { zip, report } = await buildInteropBundle(p);
  const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}_cubism_json.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  log('info', `Cubism JSON export: ${report.files.filter((f) => f.endsWith('.json')).join(', ')} (no .moc3 — see README.txt).`);
  for (const w of report.warnings) log('warn', w);
}

/** Import motion3.json / physics3.json files into the current project. Missing parameters are created. */
export async function importCubismJson(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    try {
      const json = JSON.parse(await f.text());
      const p = editor.project;
      if (f.name.toLowerCase().endsWith('.motion3.json')) {
        const { clip, skipped } = motion3ToClip(json, f.name.replace(/\.motion3\.json$/i, ''));
        editor.run({
          label: `Import ${f.name}`,
          apply(d) {
            for (const tr of clip.tracks) {
              if (d.parameters.some((x) => x.id === tr.parameterId)) continue;
              const vs = tr.keyframes.map((k) => k.v);
              const lo = Math.min(0, ...vs), hi = Math.max(1, ...vs);
              addParameter({ id: tr.parameterId, name: tr.parameterId, min: lo, max: hi, default: Math.min(hi, Math.max(lo, 0)) }).apply(d);
            }
            addClip(clip).apply(d);
          },
        });
        const created = clip.tracks.filter((tr) => !p.parameters.some((x) => x.id === tr.parameterId)).length;
        log('info', `Imported motion ${f.name}: ${clip.tracks.length} curve(s)${created ? `, ${created} new parameter(s)` : ''}${skipped.length ? `; skipped ${skipped.length} non-parameter curve(s)` : ''}.`);
      } else if (f.name.toLowerCase().endsWith('.exp3.json')) {
        const ex = exp3ToExpression(json, f.name.replace(/\.exp3\.json$/i, ''));
        const missing = ex.parameters.filter((ep) => !p.parameters.some((x) => x.id === ep.parameterId)).map((ep) => ep.parameterId);
        editor.run(addExpression(ex));
        log('info', `Imported expression ${f.name}: ${ex.parameters.length} parameter(s)${missing.length ? `; not in this project: ${missing.join(', ')}` : ''}.`);
      } else if (f.name.toLowerCase().endsWith('.physics3.json')) {
        const { rig, notes } = physics3ToRig(json);
        editor.run({
          label: `Import ${f.name}`,
          apply(d) {
            const ids = new Set(rig.settings.flatMap((s) => [...s.inputs.map((i) => i.parameterId), ...s.outputs.map((o) => o.parameterId)]));
            for (const id of ids) if (!d.parameters.some((x) => x.id === id)) addParameter({ id, name: id, min: -1, max: 1, default: 0 }).apply(d);
            d.physics.settings.push(...rig.settings);
            setPhysicsGlobals({ fps: rig.fps || d.physics.fps }).apply(d);
          },
        });
        log('info', `Imported physics ${f.name}: ${rig.settings.length} group(s).`);
        for (const n of notes) log('info', n);
      } else {
        log('warn', `${f.name}: only .motion3.json, .physics3.json and .exp3.json can be imported into a project.`);
      }
    } catch (e) {
      log('error', `Import ${f.name}: ${(e as Error).message}`);
    }
  }
}

if (import.meta.env.DEV) {
  const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
  if (g.__l2s) Object.assign(g.__l2s, { useMoc3, moc3Actions, importCubismJson });
}
