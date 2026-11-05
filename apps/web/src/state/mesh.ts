import { create } from 'zustand';
import type { ArtMesh, AutoMeshSettings, LayerNode, NodeId } from '@l2s/editor-core';
import {
  AUTO_MESH_PRESETS, checkMeshQuality, copyMesh, deleteVertices, generateAutoMesh, rectMesh, retriangulate, setMesh, setMeshes,
  connectVertices, removeEdge, createTriangle, deleteTriangles, restoreTriangles, resetUVs,
  type MeshIssue,
} from '@l2s/mesh-engine';
import { editor, log, useEditor } from './editor.ts';
import { generateMeshesInWorkers } from './meshPool.ts';

export type ToolMode = 'select' | 'mesh' | 'deform' | 'pen';

export interface MeshCheckRow {
  layerId: NodeId;
  layerName: string;
  issue: MeshIssue;
}

export interface MeshState {
  mode: ToolMode;
  /** Layer being mesh-edited. */
  editLayerId: NodeId | null;
  selectedVertices: number[];
  /** Mesh edit: drag moves texture coordinates instead of vertices (spec §5.2 UV editing). */
  uvMode: boolean;
  autoMeshOpen: boolean;
  settings: AutoMeshSettings;
  preset: keyof typeof AUTO_MESH_PRESETS | 'custom';
  running: { done: number; total: number } | null;
  checkRows: MeshCheckRow[] | null;
  checkedAt: string | null;
}

function loadSettings(): Pick<MeshState, 'settings' | 'preset'> {
  try {
    const s = JSON.parse(localStorage.getItem('l2s:automesh') ?? 'null');
    if (s?.settings) return s;
  } catch { /* ignore */ }
  return { settings: AUTO_MESH_PRESETS.standard, preset: 'standard' };
}

export const useMesh = create<MeshState>(() => ({
  mode: 'select',
  editLayerId: null,
  selectedVertices: [],
  uvMode: false,
  autoMeshOpen: false,
  running: null,
  checkRows: null,
  checkedAt: null,
  ...loadSettings(),
}));

const set = useMesh.setState;
const get = useMesh.getState;

function selectedLayers(): LayerNode[] {
  const p = editor.project;
  const ids = useEditor.getState().selection.ids;
  const out = new Map<NodeId, LayerNode>();
  const walk = (id: NodeId) => {
    const n = p.nodes[id];
    if (!n) return;
    if (n.kind === 'layer') out.set(n.id, n);
    else n.childIds.forEach(walk);
  };
  ids.forEach(walk);
  return [...out.values()];
}

/** Layer the mesh tools act on: the active (last clicked) selected layer. */
function activeLayer(): LayerNode | null {
  const p = editor.project;
  const sel = useEditor.getState().selection;
  const id = sel.anchor && sel.ids.includes(sel.anchor) ? sel.anchor : sel.ids.at(-1);
  const n = id ? p.nodes[id] : undefined;
  return n?.kind === 'layer' ? n : null;
}

export const meshActions = {
  selectedLayers,
  activeLayer,

  openAutoMesh(open: boolean) { set({ autoMeshOpen: open }); },

  setSettings(settings: AutoMeshSettings, preset: MeshState['preset']) {
    set({ settings, preset });
    try { localStorage.setItem('l2s:automesh', JSON.stringify({ settings, preset })); } catch { /* ignore */ }
  },

  /** Generate meshes for the selected layers (all layers if nothing is selected). One undo step. */
  async runAutoMesh(targets?: LayerNode[]) {
    const p = editor.project;
    const layers = targets ?? (selectedLayers().length ? selectedLayers() : Object.values(p.nodes).filter((n): n is LayerNode => n.kind === 'layer'));
    const textures = editor.renderer?.textures;
    if (!textures || !layers.length) return;
    const settings = get().settings;
    const meshes: ArtMesh[] = [];
    let skipped = 0, unconstrained = 0;
    const t0 = performance.now();
    set({ running: { done: 0, total: layers.length } });
    try {
      const tasks = layers.flatMap((l) => {
        const a = textures.getAlpha(l.assets.display);
        if (!a) { skipped++; return []; }
        return [{ layerId: l.id, alpha: a.alpha, bounds: l.bounds, partCategory: l.partTag?.category }];
      });
      if (typeof Worker !== 'undefined') {
        const out = await generateMeshesInWorkers(tasks, settings, (done) => set({ running: { done, total: layers.length } }));
        for (const r of out) {
          if (r.mesh) meshes.push(r.mesh); else skipped++;
          if (!r.constrained) unconstrained++;
        }
      } else {
        for (const t of tasks) {
          const r = generateAutoMesh({ layerId: t.layerId, alpha: t.alpha, bounds: t.bounds, settings, partCategory: t.partCategory });
          if (r.mesh) meshes.push(r.mesh); else skipped++;
          if (!r.stats.constrained) unconstrained++;
        }
      }
    } finally {
      set({ running: null });
    }
    if (meshes.length) editor.run(setMeshes(meshes, meshes.length === 1 ? 'Auto Mesh' : `Auto Mesh (${meshes.length} layers)`));
    const v = meshes.reduce((s, m) => s + m.vertices.length / 2, 0);
    log('info', `Auto mesh: ${meshes.length} layer(s), ${v} vertices, ${skipped} skipped (${Math.round(performance.now() - t0)} ms)`);
    if (unconstrained) log('warn', `Auto mesh: ${unconstrained} layer(s) had outline constraints that could not be enforced; check them in Mesh Check.`);
    meshActions.runCheck(meshes.map((m) => m.layerId));
  },

  createRectMesh() {
    const l = activeLayer();
    if (!l) return;
    editor.run(setMesh(l.id, rectMesh(l, get().settings.outerMargin), 'Create Mesh'));
  },

  deleteMeshes() {
    for (const l of selectedLayers()) if (editor.project.meshes[l.id]) editor.run(setMesh(l.id, null));
    if (get().editLayerId && !editor.project.meshes[get().editLayerId!]) meshActions.exitMeshEdit();
  },

  retriangulate() {
    for (const l of selectedLayers()) if (editor.project.meshes[l.id]) editor.run(retriangulate(l.id));
  },

  copyFromActive(mirror: boolean) {
    const src = activeLayer();
    if (!src || !editor.project.meshes[src.id]) { log('warn', 'Click the layer whose mesh should be copied last (it becomes the active layer).'); return; }
    const targets = selectedLayers().filter((l) => l.id !== src.id).map((l) => l.id);
    if (!targets.length) { log('warn', 'Select at least one target layer plus the source layer.'); return; }
    editor.run(copyMesh(src.id, targets, mirror));
  },

  // ---------------------------------------------------------- edit mode

  async enterMeshEdit() {
    const l = activeLayer();
    if (!l) { log('warn', 'Select a layer to edit its mesh.'); return; }
    if (!editor.project.meshes[l.id]) {
      await meshActions.runAutoMesh([l]);
      if (!editor.project.meshes[l.id]) editor.run(setMesh(l.id, rectMesh(l, get().settings.outerMargin), 'Create Mesh'));
    }
    editor.selectIds([l.id]);
    // Topology is edited in the rest pose; keyforms follow automatically.
    editor.setRestOverride(l.id);
    set({ mode: 'mesh', editLayerId: l.id, selectedVertices: [] });
  },

  exitMeshEdit() {
    editor.sealHistoryStep();
    editor.setRestOverride(null);
    set({ mode: 'select', editLayerId: null, selectedVertices: [] });
  },

  enterDeform() {
    if (get().mode === 'mesh') meshActions.exitMeshEdit();
    set({ mode: 'deform' });
  },
  togglePen() {
    if (get().mode === 'pen') set({ mode: 'select' });
    else { if (get().mode === 'mesh') meshActions.exitMeshEdit(); set({ mode: 'pen' }); }
  },
  toggleDeform() {
    if (get().mode === 'deform') set({ mode: 'select' });
    else meshActions.enterDeform();
  },

  toggleMeshEdit() {
    if (get().mode === 'mesh') meshActions.exitMeshEdit();
    else void meshActions.enterMeshEdit();
  },

  setSelectedVertices(v: number[]) { set({ selectedVertices: v }); },

  selectAllVertices() {
    const m = get().editLayerId ? editor.project.meshes[get().editLayerId!] : undefined;
    if (m) set({ selectedVertices: [...Array(m.vertices.length / 2).keys()] });
  },

  deleteSelectedVertices() {
    const id = get().editLayerId;
    const sel = get().selectedVertices;
    if (!id || !sel.length) return;
    const m = editor.project.meshes[id]!;
    if (m.vertices.length / 2 - sel.length < 3) { log('warn', 'A mesh needs at least 3 vertices.'); return; }
    editor.run(deleteVertices(id, sel));
    set({ selectedVertices: [] });
  },

  // ---------------------------------------------------------- edges / triangles / UVs (spec §5.2)

  toggleUvMode() { set({ uvMode: !get().uvMode }); },
  connect() {
    const { editLayerId: id, selectedVertices: s } = get();
    if (!id || s.length !== 2) { log('warn', 'Select exactly two vertices to connect.'); return; }
    editor.run(connectVertices(id, s[0]!, s[1]!));
  },
  removeEdge() {
    const { editLayerId: id, selectedVertices: s } = get();
    if (!id || s.length !== 2) { log('warn', 'Select the two vertices of the edge to remove or flip.'); return; }
    if (!editor.run(removeEdge(id, s[0]!, s[1]!))) log('warn', 'That is an outline edge or not an edge; nothing changed.');
  },
  triangle() {
    const { editLayerId: id, selectedVertices: s } = get();
    if (!id || s.length !== 3) { log('warn', 'Select exactly three vertices to create a triangle.'); return; }
    editor.run(createTriangle(id, s[0]!, s[1]!, s[2]!));
  },
  deleteTriangles() {
    const { editLayerId: id, selectedVertices: s } = get();
    if (!id || s.length < 3) { log('warn', 'Select the vertices of the triangles to delete (all three corners of each).'); return; }
    if (!editor.run(deleteTriangles(id, s))) log('warn', 'No triangle has all three corners selected.');
  },
  restoreTriangles() { const id = get().editLayerId; if (id) editor.run(restoreTriangles(id)); },
  resetUVs() { const id = get().editLayerId; if (id) editor.run(resetUVs(id)); },

  // ---------------------------------------------------------- quality

  runCheck(layerIds?: NodeId[]) {
    const p = editor.project;
    const textures = editor.renderer?.textures;
    const ids = layerIds ?? Object.keys(p.meshes);
    const rows: MeshCheckRow[] = [];
    for (const id of ids) {
      const m = p.meshes[id];
      const n = p.nodes[id];
      if (!m || n?.kind !== 'layer') continue;
      const a = textures?.getAlpha(n.assets.display);
      for (const issue of checkMeshQuality(m, n.bounds, { alpha: a?.alpha, alphaThreshold: m.settings?.alphaThreshold })) {
        rows.push({ layerId: id, layerName: n.name, issue });
      }
    }
    const withoutMesh = Object.values(p.nodes).filter((n) => n.kind === 'layer' && !p.meshes[n.id]).length;
    set({ checkRows: rows, checkedAt: new Date().toLocaleTimeString() });
    editor.setBottomTab('mesh');
    log(rows.some((r) => r.issue.severity === 'error') ? 'warn' : 'info',
      `Mesh check: ${ids.length} mesh(es), ${rows.filter((r) => r.issue.severity === 'error').length} error(s), ${rows.filter((r) => r.issue.severity === 'warning').length} warning(s); ${withoutMesh} layer(s) without mesh.`);
  },
};

// Leave mesh-edit mode when its layer disappears (undo of mesh creation, delete layer).
useEditor.subscribe((s) => {
  if (get().mode === 'deform' || get().mode === 'pen') return;
  const id = get().editLayerId;
  if (id && (!s.project.nodes[id] || !s.project.meshes[id])) meshActions.exitMeshEdit();
  else if (id) {
    const n = s.project.meshes[id]!.vertices.length / 2;
    const sel = get().selectedVertices.filter((i) => i < n);
    if (sel.length !== get().selectedVertices.length) set({ selectedVertices: sel });
  }
});

if (import.meta.env.DEV) {
  const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
  if (g.__l2s) g.__l2s.useMesh = useMesh;
}
