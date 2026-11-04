import { create } from 'zustand';
import {
  CommandHistory, applySelection, createEmptyProject, emptySelection, flattenForTree, newId, pruneSelection, referencedAssetIds,
  type Command, type HistoryState, type NodeId, type Project, type SelectMode, type Selection,
} from '@l2s/editor-core';
import { PACKAGE_EXTENSION, ProjectStore, checkIntegrity, readPackage, writePackage, type ProjectSummary, type StoredAsset } from '@l2s/project-format';
import type { ImportWarning } from '@l2s/psd-importer';
import type { StudioRenderer, CameraState, Pose } from '@l2s/rendering-engine';
import { evaluateModel, type EvaluatedModel } from '@l2s/deformer-engine';
import { applyExpressions, defaultValues, normalizeValue, resolveValues, type ParameterValues } from '@l2s/parameter-engine';
import { importPsdInWorker, type ImportHandle, type ImportProgress } from './psdImport.ts';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry { id: number; time: string; level: LogLevel; message: string }

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'unsaved-new';

export interface ImportState {
  fileName: string;
  phase: ImportProgress['phase'] | 'read' | 'store' | 'upload';
  done: number;
  total: number;
}

export interface EditorState {
  project: Project;
  history: HistoryState;
  undoLabels: string[];
  redoLabels: string[];
  selection: Selection;
  hoverId: NodeId | null;
  cursor: { x: number; y: number } | null;
  camera: CameraState;
  importing: ImportState | null;
  importWarnings: ImportWarning[];
  logs: LogEntry[];
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  projects: ProjectSummary[];
  projectDialogOpen: boolean;
  showBounds: boolean;
  showMeshes: boolean;
  grid: number;
  guides: boolean;
  bottomTab: 'report' | 'history' | 'console' | 'mesh' | 'params' | 'analyzer' | 'timeline' | 'curves' | 'physics';
  /** Current parameter values (view state, not part of the document). */
  paramValues: ParameterValues;
  /** Model evaluated at `paramValues`. */
  model: EvaluatedModel;
  /** Left panel tab. */
  leftTab: 'parts' | 'deformers';
  /** Expressions previewed on top of the parameter values (spec §7.3 presets). */
  activeExpressions: string[];
}

const store = new ProjectStore();
const history = new CommandHistory(createEmptyProject('Untitled'));
let renderer: StudioRenderer | null = null;
let currentImport: ImportHandle | null = null;
let logSeq = 0;

export const useEditor = create<EditorState>(() => ({
  project: history.project,
  history: history.state,
  undoLabels: [],
  redoLabels: [],
  selection: emptySelection,
  hoverId: null,
  cursor: null,
  camera: { zoom: 1, x: 0, y: 0 },
  importing: null,
  importWarnings: [],
  logs: [],
  saveStatus: 'unsaved-new',
  lastSavedAt: null,
  projects: [],
  projectDialogOpen: false,
  showBounds: false,
  showMeshes: true,
  grid: 0,
  guides: false,
  bottomTab: 'report',
  paramValues: {},
  model: evaluateModel(history.project, {}),
  leftTab: 'parts',
  activeExpressions: [],
}));

const set = useEditor.setState;
const get = useEditor.getState;

// ------------------------------------------------------------------ history

let suppressDirty = false;
/** Layer drawn at its rest pose (mesh topology editing). */
let restOverride: NodeId | null = null;

function poseFor(project: Project, model: EvaluatedModel): Pose {
  if (!restOverride || !project.meshes[restOverride]) return model;
  const meshes = new Map(model.meshes);
  const cur = meshes.get(restOverride);
  meshes.set(restOverride, { positions: Float32Array.from(project.meshes[restOverride]!.vertices), opacity: cur?.opacity ?? 1 });
  return { ...model, meshes };
}

/**
 * Values produced by the runtime (animation playback + physics). When set,
 * they drive the pose instead of the user's slider values.
 */
let driven: ParameterValues | null = null;

/** Slider values with the previewed expressions applied (motion → expression → physics, as in Cubism). */
export function withExpressions(project: Project, values: ParameterValues): ParameterValues {
  const ids = get().activeExpressions;
  if (!ids.length) return values;
  const active = project.expressions.filter((e) => ids.includes(e.id)).map((expression) => ({ expression, weight: 1 }));
  return applyExpressions(resolveValues(project, values), active, project.parameters);
}

function reevaluate(project: Project, values: ParameterValues) {
  const model = evaluateModel(project, driven ?? withExpressions(project, values));
  set({ model, paramValues: resolveValues(project, values) });
  renderer?.sync(project, poseFor(project, model));
}

history.subscribe((project) => {
  const sel = pruneSelection(project, get().selection);
  const model = evaluateModel(project, driven ?? withExpressions(project, get().paramValues));
  set({
    model,
    paramValues: resolveValues(project, get().paramValues),
    project,
    history: history.state,
    undoLabels: history.labels.undo,
    redoLabels: history.labels.redo,
    selection: sel,
    ...(suppressDirty ? {} : { saveStatus: 'dirty' as const }),
  });
  renderer?.sync(project, poseFor(project, model));
  renderer?.setSelection(sel.ids);
  if (!suppressDirty) scheduleAutosave();
});

export function log(level: LogLevel, message: string) {
  const entry: LogEntry = { id: ++logSeq, time: new Date().toLocaleTimeString(), level, message };
  set((s) => ({ logs: [...s.logs.slice(-499), entry] }));
  if (level === 'error') console.error(message);
}

function resetDocument(project: Project) {
  suppressDirty = true;
  try {
    history.reset(project);
  } finally {
    suppressDirty = false;
  }
  set({ selection: emptySelection, hoverId: null });
  reevaluate(project, defaultValues(project));
  renderer?.setSelection([]);
}

// ------------------------------------------------------------------ actions

export const editor = {
  get project() { return history.project; },
  get renderer() { return renderer; },

  attachRenderer(r: StudioRenderer | null) {
    renderer = r;
    if (r) {
      r.sync(history.project, poseFor(history.project, get().model));
      r.setSelection(get().selection.ids);
      r.setOverlayOptions({ showBounds: get().showBounds, grid: get().grid, guides: get().guides });
    }
  },

  run(cmd: Command): boolean {
    try {
      return history.execute(cmd);
    } catch (e) {
      log('error', `${cmd.label}: ${(e as Error).message}`);
      return false;
    }
  },
  sealHistoryStep() { history.sealLastStep(); },
  undo() { history.undo(); },
  redo() { history.redo(); },

  select(id: NodeId | null, mode: SelectMode = 'replace') {
    const sel = applySelection(history.project, get().selection, id, mode);
    set({ selection: sel });
    renderer?.setSelection(sel.ids);
  },
  selectIds(ids: NodeId[]) {
    const sel = { ids, anchor: ids.at(-1) ?? null };
    set({ selection: sel });
    renderer?.setSelection(ids);
  },
  selectAll() {
    editor.selectIds(flattenForTree(history.project, true).map((r) => r.node.id));
  },
  setHover(id: NodeId | null) {
    if (get().hoverId !== id) set({ hoverId: id });
    renderer?.setHover(id);
  },
  setCursor(c: { x: number; y: number } | null) { set({ cursor: c }); },
  setCamera(c: CameraState) { set({ camera: c }); },
  fitView() { renderer?.fitToView(); },
  zoomBy(f: number) { renderer?.zoomBy(f); },
  setZoom(z: number) { renderer?.setZoom(z); },
  toggleBounds() {
    const v = !get().showBounds;
    set({ showBounds: v });
    renderer?.setOverlayOptions({ showBounds: v });
  },
  setGrid(n: number) {
    set({ grid: n });
    renderer?.setOverlayOptions({ grid: n });
  },
  toggleGuides() {
    const v = !get().guides;
    set({ guides: v });
    renderer?.setOverlayOptions({ guides: v });
  },
  toggleMeshes() {
    const v = !get().showMeshes;
    set({ showMeshes: v });
    renderer?.setOverlayOptions({ showMeshes: v });
  },
  // -------------------------------------------------------------- parameters (view state)

  setParam(id: string, value: number) {
    const p = history.project.parameters.find((x) => x.id === id);
    if (!p) return;
    reevaluate(history.project, { ...get().paramValues, [id]: normalizeValue(p, value) });
  },
  setParams(values: ParameterValues) {
    reevaluate(history.project, { ...get().paramValues, ...values });
  },
  resetParams() {
    reevaluate(history.project, defaultValues(history.project));
  },
  /** Runtime-driven values (null = follow the sliders). */
  setDriven(values: ParameterValues | null) {
    driven = values;
    reevaluate(history.project, get().paramValues);
  },
  setRestOverride(id: NodeId | null) {
    restOverride = id;
    renderer?.sync(history.project, poseFor(history.project, get().model));
  },
  setLeftTab(t: EditorState['leftTab']) { set({ leftTab: t }); },
  toggleExpression(id: string) {
    const cur = get().activeExpressions;
    set({ activeExpressions: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    reevaluate(history.project, get().paramValues);
  },

  /** Decode the project's display textures into another renderer (split view). */
  async loadTexturesInto(r: StudioRenderer) {
    const project = history.project;
    const ids = new Set<string>();
    for (const n of Object.values(project.nodes)) if (n.kind === 'layer') ids.add(n.assets.display);
    const assets = await store.getAssets(project.id, ids);
    for (let i = 0; i < assets.length; i += 8) await Promise.all(assets.slice(i, i + 8).map((a) => r.textures.addFromBlob(a.id, a.blob)));
    r.sync(history.project, get().model);
  },

  setBottomTab(t: EditorState['bottomTab']) { set({ bottomTab: t }); },

  // -------------------------------------------------------------- files

  async newProject() {
    if (!(await confirmDiscard())) return;
    currentImport?.cancel();
    renderer?.textures.clear();
    resetDocument(createEmptyProject('Untitled'));
    set({ saveStatus: 'unsaved-new', importWarnings: [], lastSavedAt: null });
    log('info', 'New project');
  },

  async importPsd(file: File) {
    if (!(await confirmDiscard())) return;
    currentImport?.cancel();
    const fileName = file.name;
    set({ importing: { fileName, phase: 'read', done: 0, total: 1 }, importWarnings: [] });
    const t0 = performance.now();
    try {
      const buffer = await file.arrayBuffer();
      const sourceAssetId = newId('ast');
      const handle = importPsdInWorker(buffer, fileName, sourceAssetId, (p) =>
        set({ importing: { fileName, phase: p.phase, done: p.done, total: p.total } }),
      );
      currentImport = handle;
      const result = await handle.promise;
      currentImport = null;
      const tWorker = performance.now();

      set({ importing: { fileName, phase: 'store', done: 0, total: 1 } });
      const assets: StoredAsset[] = [
        { id: sourceAssetId, kind: 'source-psd', mime: 'image/vnd.adobe.photoshop', blob: new Blob([buffer], { type: 'image/vnd.adobe.photoshop' }) },
        ...result.assets.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, blob: new Blob([a.png as Uint8Array<ArrayBuffer>], { type: a.mime }) })),
      ];
      await store.putAssets(result.project.id, assets);
      const tStore = performance.now();

      set({ importing: { fileName, phase: 'upload', done: 0, total: result.displays.length } });
      renderer?.textures.clear();
      // Upload in small batches and yield, so the UI keeps painting on large PSDs.
      for (let i = 0; i < result.displays.length; i += 12) {
        const batch = result.displays.slice(i, i + 12);
        for (const d of batch) renderer?.textures.add(d.id, d.bitmap, d.alpha);
        renderer?.preloadTextures(batch.map((d) => d.id));
        set({ importing: { fileName, phase: 'upload', done: Math.min(result.displays.length, i + 12), total: result.displays.length } });
        await nextFrame();
      }
      const tUpload = performance.now();
      resetDocument(result.project);
      await nextFrame();
      const tSync = performance.now();
      if (result.thumbnail) { lastThumbAt = Date.now(); lastThumbProject = result.project.id; }
      await editor.save({ thumbnailBlob: result.thumbnail });
      const tSave = performance.now();
      const ms = Math.round(performance.now() - t0);
      log('info', `Import timing: worker ${Math.round(tWorker - t0)} ms · store ${Math.round(tStore - tWorker)} ms · upload ${Math.round(tUpload - tStore)} ms · first render ${Math.round(tSync - tUpload)} ms · save ${Math.round(tSave - tSync)} ms`);
      const s = result.stats;
      log('info', `Imported ${fileName}: ${s.width}×${s.height}, ${s.layers} layers, ${s.groups} groups, ${s.skipped} skipped (${ms} ms)`);
      for (const w of result.warnings) log('warn', `${w.layerName ? `[${w.layerName}] ` : ''}${w.message}`);
      set({ importWarnings: result.warnings, bottomTab: 'report' });
    } catch (e) {
      if ((e as Error).name === 'AbortError') log('info', 'Import cancelled');
      else log('error', `PSD import failed: ${(e as Error).message}`);
    } finally {
      set({ importing: null });
    }
  },

  cancelImport() {
    currentImport?.cancel();
    currentImport = null;
  },

  /** Save to IndexedDB. The thumbnail (a full render) is refreshed at most once a minute unless `thumbnail` is forced. */
  async save(opts: { thumbnail?: boolean; thumbnailBlob?: Blob } = {}) {
    const project = history.project;
    if (project.rootIds.length === 0 && !project.source) return;
    set({ saveStatus: 'saving' });
    try {
      const wantThumb = !opts.thumbnailBlob && (opts.thumbnail || Date.now() - lastThumbAt > 60_000 || lastThumbProject !== project.id);
      const thumb = opts.thumbnailBlob ?? (wantThumb ? (await renderer?.snapshot(256).catch(() => null)) ?? undefined : undefined);
      if (thumb) { lastThumbAt = Date.now(); lastThumbProject = project.id; }
      await store.saveProject(project, thumb);
      // Only mark saved if nothing changed while saving.
      if (history.project === project) set({ saveStatus: 'saved' });
      else set({ saveStatus: 'dirty' });
      set({ lastSavedAt: new Date().toISOString() });
    } catch (e) {
      set({ saveStatus: 'error' });
      log('error', `Save failed: ${(e as Error).message}`);
    }
  },

  async refreshProjectList() {
    set({ projects: await store.list() });
  },

  openProjectDialog(open: boolean) {
    set({ projectDialogOpen: open });
    if (open) void editor.refreshProjectList();
  },

  async openStoredProject(id: string) {
    if (!(await confirmDiscard())) return;
    try {
      const loaded = await store.loadProject(id);
      if (!loaded) throw new Error('Project not found');
      await loadTextures(loaded.project);
      resetDocument(loaded.project);
      set({ saveStatus: loaded.recovered ? 'dirty' : 'saved', projectDialogOpen: false, importWarnings: [] });
      const issues = checkIntegrity(loaded.project);
      for (const i of issues) log(i.severity === 'error' ? 'error' : 'warn', `Integrity: ${i.message}`);
      log('info', `Opened project "${loaded.project.name}"${loaded.recovered ? ' (recovered unsaved changes)' : ''}`);
      localStorage.setItem('l2s:lastProject', id);
    } catch (e) {
      log('error', `Open failed: ${(e as Error).message}`);
    }
  },

  async deleteStoredProject(id: string) {
    await store.deleteProject(id);
    await editor.refreshProjectList();
  },

  async exportPackage() {
    const project = history.project;
    try {
      await editor.save();
      const ids = referencedAssetIds(project);
      const assets = await store.getAssets(project.id, ids);
      const thumbnail = (await renderer?.snapshot(512).catch(() => null)) ?? undefined;
      const bytes = await writePackage(project, assets, { thumbnail });
      downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${safeName(project.name)}${PACKAGE_EXTENSION}`);
      log('info', `Exported ${project.name}${PACKAGE_EXTENSION} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    } catch (e) {
      log('error', `Export failed: ${(e as Error).message}`);
    }
  },

  async openPackage(file: File) {
    if (!(await confirmDiscard())) return;
    try {
      const { project, assets } = await readPackage(new Uint8Array(await file.arrayBuffer()));
      const issues = checkIntegrity(project, new Set(assets.map((a) => a.id)));
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length) throw new Error(`Package failed integrity check: ${errors.map((e) => e.message).join('; ')}`);
      await store.putAssets(project.id, assets);
      await loadTextures(project, assets);
      resetDocument(project);
      await editor.save();
      log('info', `Opened package ${file.name}`);
    } catch (e) {
      log('error', `Open failed: ${(e as Error).message}`);
    }
  },

  async openFile(file: File) {
    const n = file.name.toLowerCase();
    if (n.endsWith('.psd') || n.endsWith('.psb')) return editor.importPsd(file);
    if (n.endsWith(PACKAGE_EXTENSION)) return editor.openPackage(file);
    log('error', `Unsupported file type: ${file.name}`);
  },

  async restoreLastSession() {
    const id = localStorage.getItem('l2s:lastProject');
    const list = await store.list().catch(() => []);
    set({ projects: list });
    const target = list.find((p) => p.id === id) ?? list[0];
    if (target) await editor.openStoredProject(target.id);
  },
};

// ------------------------------------------------------------------ helpers

let lastThumbAt = 0;
let lastThumbProject: string | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let journalTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutosave() {
  // Cheap JSON-only journal first, so a crash between edits and the full save loses almost nothing.
  if (journalTimer) clearTimeout(journalTimer);
  journalTimer = setTimeout(() => {
    const p = history.project;
    if (p.rootIds.length || p.source) void store.writeRecovery(p).catch(() => undefined);
  }, 300);
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void editor.save(), 1500);
}

async function confirmDiscard(): Promise<boolean> {
  // Edits autosave, so there is nothing to discard except an in-flight save.
  if (get().saveStatus === 'dirty' || get().saveStatus === 'saving') await editor.save();
  return true;
}

async function loadTextures(project: Project, provided?: StoredAsset[]) {
  const ids = new Set<string>();
  for (const n of Object.values(project.nodes)) if (n.kind === 'layer') ids.add(n.assets.display);
  const assets = provided ? provided.filter((a) => ids.has(a.id)) : await store.getAssets(project.id, ids);
  renderer?.textures.clear();
  let done = 0;
  set({ importing: { fileName: project.name, phase: 'upload', done, total: assets.length } });
  try {
    // Decode in small batches to bound peak memory on low-end devices.
    for (let i = 0; i < assets.length; i += 8) {
      await Promise.all(assets.slice(i, i + 8).map((a) => renderer?.textures.addFromBlob(a.id, a.blob)));
      done = Math.min(assets.length, i + 8);
      set({ importing: { fileName: project.name, phase: 'upload', done, total: assets.length } });
    }
  } finally {
    set({ importing: null });
  }
}

function nextFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeName(n: string) {
  return n.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}

if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  (globalThis as Record<string, unknown>).__l2s = { editor, useEditor, history };
}
