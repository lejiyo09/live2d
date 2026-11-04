import { editor } from './editor.ts';
import { actions } from './actions.ts';
import { meshActions, useMesh } from './mesh.ts';
import { moveVertices } from '@l2s/mesh-engine';
import { activeObjectId, rigActions, useRig } from './rig.ts';
import { commitDeform, deformPoints, moveBezierHandles } from '../tools/deformTool.ts';
import { activeClip, animActions, useAnim } from './anim.ts';
import { cancelPen, finishPen } from '../tools/penTool.ts';

function stepFrame(d: number) {
  const c = activeClip();
  if (c) animActions.scrub(useAnim.getState().time + d / c.fps);
}

const inMesh = () => useMesh.getState().mode === 'mesh';
const inDeform = () => useMesh.getState().mode === 'deform';
const inPointMode = () => inMesh() || inDeform();
function nudge(dx: number, dy: number) {
  if (inDeform()) {
    const id = activeObjectId();
    const pts = id ? deformPoints(id) : null;
    const sel = useRig.getState().deformSelected;
    if (id && pts && sel.length && !moveBezierHandles(id, sel, dx, dy, 'nudge')) commitDeform(id, pts.points, sel, dx, dy, 'nudge');
    return;
  }
  const { editLayerId, selectedVertices } = useMesh.getState();
  if (editLayerId && selectedVertices.length) editor.run(moveVertices(editLayerId, selectedVertices, dx, dy, 'nudge'));
}
function selectAllPoints() {
  const id = activeObjectId();
  const pts = id ? deformPoints(id) : null;
  if (pts && pts.kind !== 'rotation') useRig.setState({ deformSelected: [...Array(pts.points.length / 2).keys()] });
}

export interface Shortcut {
  /** e.g. "Mod+Shift+Z" — Mod = Ctrl (Cmd on macOS). */
  keys: string;
  run: () => void;
  allowInInputs?: boolean;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatKeys(keys: string) {
  return keys.replace('Mod', isMac ? '⌘' : 'Ctrl').replace(/\+/g, isMac ? '' : '+');
}

export const SHORTCUTS: Record<string, Shortcut> = {
  open: { keys: 'Mod+O', run: () => actions.openFileDialog() },
  save: { keys: 'Mod+S', run: () => void editor.save({ thumbnail: true }), allowInInputs: true },
  export: { keys: 'Mod+Shift+E', run: () => void editor.exportPackage() },
  projects: { keys: 'Mod+Shift+O', run: () => editor.openProjectDialog(true) },
  undo: { keys: 'Mod+Z', run: () => editor.undo() },
  redo: { keys: 'Mod+Shift+Z', run: () => editor.redo() },
  redoAlt: { keys: 'Mod+Y', run: () => editor.redo() },
  selectAll: { keys: 'Mod+A', run: () => (inMesh() ? meshActions.selectAllVertices() : inDeform() ? selectAllPoints() : editor.selectAll()) },
  deselect: { keys: 'Escape', run: () => (useMesh.getState().mode === 'pen' ? cancelPen() : inMesh() ? meshActions.exitMeshEdit() : inDeform() ? meshActions.toggleDeform() : editor.select(null)) },
  deform: { keys: 'D', run: () => meshActions.toggleDeform() },
  copyKeyform: { keys: 'Mod+Shift+C', run: () => rigActions.copyKeyform() },
  pasteKeyform: { keys: 'Mod+Shift+V', run: () => rigActions.pasteKeyform() },
  resetParams: { keys: 'Mod+Shift+R', run: () => editor.resetParams() },
  keyAnim: { keys: 'K', run: () => animActions.keyCurrent() },
  meshConnect: { keys: 'E', run: () => inMesh() && meshActions.connect() },
  meshFlip: { keys: 'F', run: () => inMesh() && meshActions.removeEdge() },
  meshTriangle: { keys: 'T', run: () => inMesh() && meshActions.triangle() },
  meshDeleteTris: { keys: 'Shift+Delete', run: () => inMesh() && meshActions.deleteTriangles() },
  meshUv: { keys: 'U', run: () => inMesh() && meshActions.toggleUvMode() },
  bezier: { keys: 'B', run: () => inDeform() && rigActions.toggleBezier() },
  pen: { keys: 'P', run: () => meshActions.togglePen() },
  penFinish: { keys: 'Enter', run: () => { if (useMesh.getState().mode === 'pen') finishPen(); } },
  prevFrame: { keys: ',', run: () => stepFrame(-1) },
  nextFrame: { keys: '.', run: () => stepFrame(1) },
  meshEdit: { keys: 'M', run: () => meshActions.toggleMeshEdit() },
  selectTool: { keys: 'V', run: () => { if (inMesh()) meshActions.exitMeshEdit(); else if (inDeform()) meshActions.toggleDeform(); } },
  autoMesh: { keys: 'Mod+Shift+M', run: () => meshActions.openAutoMesh(true) },
  nudgeL: { keys: 'ArrowLeft', run: () => nudge(-1, 0) },
  nudgeR: { keys: 'ArrowRight', run: () => nudge(1, 0) },
  nudgeU: { keys: 'ArrowUp', run: () => nudge(0, -1) },
  nudgeD: { keys: 'ArrowDown', run: () => nudge(0, 1) },
  nudgeL10: { keys: 'Shift+ArrowLeft', run: () => nudge(-10, 0) },
  nudgeR10: { keys: 'Shift+ArrowRight', run: () => nudge(10, 0) },
  nudgeU10: { keys: 'Shift+ArrowUp', run: () => nudge(0, -10) },
  nudgeD10: { keys: 'Shift+ArrowDown', run: () => nudge(0, 10) },
  group: { keys: 'Mod+G', run: () => actions.groupSelection() },
  ungroup: { keys: 'Mod+Shift+G', run: () => actions.ungroupSelection() },
  delete: { keys: 'Delete', run: () => (inMesh() ? meshActions.deleteSelectedVertices() : inDeform() ? undefined : actions.deleteSelection()) },
  deleteAlt: { keys: 'Backspace', run: () => (inMesh() ? meshActions.deleteSelectedVertices() : inDeform() ? undefined : actions.deleteSelection()) },
  forward: { keys: 'Mod+]', run: () => actions.reorder(1) },
  backward: { keys: 'Mod+[', run: () => actions.reorder(-1) },
  hide: { keys: 'Mod+,', run: () => actions.toggleVisibility() },
  lock: { keys: 'Mod+L', run: () => actions.toggleLock() },
  fit: { keys: 'Mod+0', run: () => editor.fitView() },
  zoom100: { keys: 'Mod+1', run: () => editor.setZoom(1) },
  zoomIn: { keys: 'Mod+=', run: () => editor.zoomBy(1.25) },
  zoomOut: { keys: 'Mod+-', run: () => editor.zoomBy(0.8) },
};

function eventKeys(e: KeyboardEvent) {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === '+') k = '=';
  if (k === '_') k = '-';
  if (k === '}') k = ']';
  if (k === '{') k = '[';
  if (k === '<') k = ',';
  if (k === ' ') k = 'Space';
  parts.push(k);
  return parts.join('+');
}

// ------------------------------------------------------------------ user key bindings (Settings → Preferences)

const DEFAULT_KEYS: Record<string, string> = Object.fromEntries(Object.entries(SHORTCUTS).map(([id, s]) => [id, s.keys]));

function loadOverrides(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('l2s:keys') ?? '{}') as Record<string, string>; } catch { return {}; }
}

function applyOverrides(o: Record<string, string>) {
  for (const [id, s] of Object.entries(SHORTCUTS)) s.keys = o[id] ?? DEFAULT_KEYS[id]!;
}
applyOverrides(loadOverrides());

export function defaultKeys(id: string) { return DEFAULT_KEYS[id]; }

/** Rebind an action ('' clears it). Returns the id of an action that already used these keys, if any (it gets unbound). */
export function rebind(id: string, keys: string): string | null {
  const o = loadOverrides();
  let conflict: string | null = null;
  if (keys) {
    for (const [other, s] of Object.entries(SHORTCUTS)) {
      if (other !== id && s.keys.toUpperCase() === keys.toUpperCase()) { conflict = other; o[other] = ''; }
    }
  }
  o[id] = keys;
  try { localStorage.setItem('l2s:keys', JSON.stringify(o)); } catch { /* storage unavailable */ }
  applyOverrides(o);
  rebuild();
  return conflict;
}

export function resetBindings() {
  try { localStorage.removeItem('l2s:keys'); } catch { /* ignore */ }
  applyOverrides({});
  rebuild();
}

/** Key combination of a keyboard event in the same notation as SHORTCUTS ("Mod+Shift+Z"). */
export function keysOfEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  return eventKeys(e);
}

let byKeys = new Map<string, Shortcut>();
function rebuild() {
  byKeys = new Map(Object.values(SHORTCUTS).filter((s) => s.keys).map((s) => [s.keys.toUpperCase(), s]));
}
rebuild();

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const s = byKeys.get(eventKeys(e).toUpperCase());
    if (!s || (typing && !s.allowInInputs)) return;
    if (e.key.startsWith('Arrow') && !inPointMode()) return;
    if (e.target instanceof HTMLElement && e.target.closest('[role=tree]') && e.key.startsWith('Arrow')) return;
    e.preventDefault();
    s.run();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
