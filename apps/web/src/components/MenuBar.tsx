import { useEffect, useRef, useState } from 'react';
import { APP_NAME, editor, useEditor } from '../state/editor.ts';
import { actions } from '../state/actions.ts';
import { SHORTCUTS, formatKeys } from '../state/shortcuts.ts';
import { meshActions, useMesh } from '../state/mesh.ts';
import { rigActions, activeObjectId } from '../state/rig.ts';
import { aiActions } from '../state/ai.ts';
import { exportCubismJson, importCubismJson, moc3Actions } from '../state/moc3.ts';
import { openFilePicker } from '../state/filePicker.ts';
import { usePrefs } from './Preferences.tsx';
import { useSplit } from './SplitView.tsx';
import { useSegment } from './SegmentDialog.tsx';
import { animActions, useAnim } from '../state/anim.ts';
import { bakePhysics } from '@l2s/animation-engine';

interface Item {
  label: string;
  run?: () => void;
  shortcut?: keyof typeof SHORTCUTS;
  disabled?: boolean;
  /** Shown for features scheduled in later phases. */
  phase?: string;
  checked?: boolean;
}
type Entry = Item | 'sep';

function useMenus(): Array<{ name: string; items: Entry[] }> {
  const s = useEditor();
  const meshMode = useMesh((m) => m.mode === 'mesh');
  const deformMode = useMesh((m) => m.mode === 'deform');
  const physicsOn = useAnim((a) => a.physicsOn);
  const clipId = useAnim((a) => a.clipId);
  const onionOn = useAnim((a) => a.onion);
  const splitOn = useSplit((x) => x.on);
  const hasSel = s.selection.ids.length > 0;
  const selLayers = meshActions.selectedLayers();
  const anyMesh = selLayers.some((l) => s.project.meshes[l.id]);
  const active = meshActions.activeLayer();
  const hasDoc = s.project.rootIds.length > 0;
  return [
    { name: 'File', items: [
      { label: 'New Project', run: () => void editor.newProject() },
      { label: 'Open PSD / Project…', run: () => actions.openFileDialog(), shortcut: 'open' },
      { label: 'Open Sample Character', run: () => void editor.openSample() },
      { label: 'Recent Projects…', run: () => editor.openProjectDialog(true), shortcut: 'projects' },
      { label: 'Import Cubism JSON (motion3 / physics3 / exp3)…', run: () => pickFiles('.json', (f) => void importCubismJson(f)), disabled: !hasDoc },
      { label: 'Preview MOC3 Model…', run: () => moc3Actions.setOpen(true) },
      'sep',
      { label: 'Save', run: () => void editor.save(), shortcut: 'save', disabled: !hasDoc },
      { label: 'Export .l2studio Package…', run: () => void editor.exportPackage(), shortcut: 'export', disabled: !hasDoc },
    ] },
    { name: 'Edit', items: [
      { label: s.history.undoLabel ? `Undo ${s.history.undoLabel}` : 'Undo', run: editor.undo, shortcut: 'undo', disabled: !s.history.canUndo },
      { label: s.history.redoLabel ? `Redo ${s.history.redoLabel}` : 'Redo', run: editor.redo, shortcut: 'redo', disabled: !s.history.canRedo },
      'sep',
      { label: 'Select All', run: editor.selectAll, shortcut: 'selectAll', disabled: !hasDoc },
      { label: 'Deselect', run: () => editor.select(null), shortcut: 'deselect', disabled: !hasSel },
      'sep',
      { label: 'Delete', run: actions.deleteSelection, shortcut: 'delete', disabled: !hasSel },
    ] },
    { name: 'View', items: [
      { label: 'Fit to Window', run: editor.fitView, shortcut: 'fit' },
      { label: 'Actual Size (100%)', run: () => editor.setZoom(1), shortcut: 'zoom100' },
      { label: 'Zoom In', run: () => editor.zoomBy(1.25), shortcut: 'zoomIn' },
      { label: 'Zoom Out', run: () => editor.zoomBy(0.8), shortcut: 'zoomOut' },
      'sep',
      { label: 'Show Layer Bounds', run: editor.toggleBounds, checked: s.showBounds },
      { label: 'Show Mesh of Selection', run: editor.toggleMeshes, checked: s.showMeshes },
      { label: 'Grid 32 px', run: () => editor.setGrid(s.grid === 32 ? 0 : 32), checked: s.grid === 32 },
      { label: 'Grid 64 px', run: () => editor.setGrid(s.grid === 64 ? 0 : 64), checked: s.grid === 64 },
      { label: 'Centre / Thirds Guides', run: editor.toggleGuides, checked: s.guides },
      { label: 'Split View (compare default pose)', run: () => useSplit.setState({ on: !splitOn }), checked: splitOn, disabled: !hasDoc },
      { label: 'Onion Skin (animation)', run: animActions.toggleOnion, checked: onionOn, disabled: !s.project.animations.length },
    ] },
    { name: 'Model', items: [
      { label: 'Group', run: actions.groupSelection, shortcut: 'group', disabled: !hasSel },
      { label: 'Ungroup', run: actions.ungroupSelection, shortcut: 'ungroup', disabled: !hasSel },
      'sep',
      { label: 'Bring Forward', run: () => actions.reorder(1), shortcut: 'forward', disabled: !hasSel },
      { label: 'Send Backward', run: () => actions.reorder(-1), shortcut: 'backward', disabled: !hasSel },
      'sep',
      { label: 'Toggle Visibility', run: actions.toggleVisibility, shortcut: 'hide', disabled: !hasSel },
      { label: 'Toggle Lock', run: actions.toggleLock, shortcut: 'lock', disabled: !hasSel },
    ] },
    { name: 'Modeling', items: [
      { label: 'Auto Generate ArtMesh…', run: () => meshActions.openAutoMesh(true), shortcut: 'autoMesh', disabled: !hasDoc },
      { label: 'Edit Mesh', run: meshActions.toggleMeshEdit, shortcut: 'meshEdit', checked: meshMode, disabled: !active && !meshMode },
      { label: 'Create Rectangle Mesh', run: meshActions.createRectMesh, disabled: !active },
      { label: 'New ArtPath (Pen)', run: meshActions.togglePen, shortcut: 'pen', disabled: !hasDoc },
      'sep',
      { label: 'Retriangulate', run: meshActions.retriangulate, disabled: !anyMesh },
      { label: 'Copy Mesh from Active to Selected', run: () => meshActions.copyFromActive(false), disabled: selLayers.length < 2 },
      { label: 'Mirror Mesh from Active to Selected', run: () => meshActions.copyFromActive(true), disabled: selLayers.length < 2 },
      { label: 'Delete Mesh', run: meshActions.deleteMeshes, disabled: !anyMesh },
      'sep',
      { label: 'Mesh Quality Check', run: () => meshActions.runCheck(), disabled: Object.keys(s.project.meshes).length === 0 },
      { label: 'Edge / Triangle Editing', phase: 'Phase 2b' },
      { label: 'UV Editing', phase: 'Phase 2b' },
      { label: 'Masks (ArtMesh clipping)', phase: 'Phase 2b' },
    ] },
    { name: 'Deform', items: [
      { label: 'Create Warp Deformer…', run: () => rigActions.openDeformerDialog('warp'), disabled: !hasSel },
      { label: 'Create Rotation Deformer…', run: () => rigActions.openDeformerDialog('rotation'), disabled: !hasSel },
      { label: 'Delete Deformer', run: rigActions.deleteSelectedDeformers, disabled: !s.selection.ids.some((id) => s.project.deformers[id]) },
      'sep',
      { label: 'Deform Tool (edit keyform)', run: meshActions.toggleDeform, shortcut: 'deform', checked: deformMode },
      { label: 'Show Deformer Tree', run: () => editor.setLeftTab('deformers') },
      { label: 'Bezier Warp Editing', phase: 'Phase 7' },
    ] },
    { name: 'Parameters', items: [
      { label: 'Parameter Panel', run: () => editor.setBottomTab('params') },
      { label: 'New Parameter…', run: () => { editor.setBottomTab('params'); rigActions.openParamDialog({ mode: 'new' }); } },
      { label: 'Add Standard Parameters', run: rigActions.addStandard },
      { label: 'Reset Parameter Values', run: editor.resetParams, shortcut: 'resetParams' },
      'sep',
      { label: 'Copy Keyform', run: rigActions.copyKeyform, shortcut: 'copyKeyform', disabled: !activeObjectId() },
      { label: 'Paste Keyform', run: rigActions.pasteKeyform, shortcut: 'pasteKeyform', disabled: !activeObjectId() },
      { label: 'Mirror Keyform (opposite key)', run: () => rigActions.mirrorKeyform(), disabled: !activeObjectId() },
      { label: 'Blend Shapes', phase: 'Phase 7' },
    ] },
    { name: 'Physics', items: [
      { label: 'Physics Settings', run: () => editor.setBottomTab('physics') },
      { label: 'Realtime Physics Preview', run: () => animActions.setPhysics(!physicsOn), checked: physicsOn },
      { label: 'Reset Simulation', run: animActions.resetPhysics },
      { label: 'Bake Physics into Animation', run: () => { const c = s.project.animations.find((x) => x.id === clipId) ?? s.project.animations[0]; if (c) editor.run(bakePhysics(c.id)); }, disabled: !s.project.animations.length || !s.project.physics.settings.length },
    ] },
    { name: 'Animation', items: [
      { label: 'Timeline', run: () => editor.setBottomTab('timeline') },
      { label: 'Curve Editor', run: () => editor.setBottomTab('curves') },
      'sep',
      { label: 'New Animation', run: animActions.newClip, disabled: !hasDoc },
      { label: 'Play / Pause', run: animActions.toggle, disabled: !s.project.animations.length },
      { label: 'Key Changed Parameters', run: () => animActions.keyCurrent(), shortcut: 'keyAnim', disabled: !s.project.animations.length },
      { label: 'Onion Skin', run: animActions.toggleOnion, checked: onionOn },
    ] },
    { name: 'AI Tools', items: [
      { label: 'Recognize Parts…', run: aiActions.openRecognize, disabled: !hasDoc },
      { label: 'Auto Rig…', run: aiActions.openAutoRig, disabled: !hasDoc },
      { label: 'Rigging Assistant…', run: () => aiActions.openAssistant(true), disabled: !hasDoc },
      { label: 'Rig Quality Analyzer', run: aiActions.analyze, disabled: !hasDoc },
      'sep',
      { label: 'Split Layer into Parts… (classical segmentation)', run: () => useSegment.setState({ open: true }), disabled: !hasDoc },
      { label: 'Image Classifier (ONNX)', phase: 'needs model' },
    ] },
    { name: 'Export', items: [
      { label: '.l2studio Package…', run: () => void editor.exportPackage(), disabled: !hasDoc },
      { label: 'Cubism JSON (physics3 / motion3 / exp3 / cdi3)…', run: () => void exportCubismJson(), disabled: !hasDoc },
      { label: 'MOC3 (requires authorized export path)', phase: 'not available' },
      { label: 'Video / Image Sequence…', run: () => animActions.openExport(true), disabled: !s.project.animations.length },
    ] },
    { name: 'Settings', items: [{ label: 'Preferences…', run: () => usePrefs.setState({ open: true }) }] },
  ];
}

export function MenuBar() {
  const menus = useMenus();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <nav className="menubar" ref={ref} role="menubar">
      <span className="brand" title="Unofficial tool — not affiliated with or endorsed by Live2D Inc.">{APP_NAME}</span>
      {menus.map((m) => (
        <div key={m.name} className="menu">
          <button
            role="menuitem"
            className={open === m.name ? 'menu-title open' : 'menu-title'}
            onClick={() => setOpen(open === m.name ? null : m.name)}
            onPointerEnter={() => open && setOpen(m.name)}
          >
            {m.name}
          </button>
          {open === m.name && (
            <div className="menu-dropdown" role="menu">
              {m.items.map((it, i) =>
                it === 'sep' ? <div key={i} className="menu-sep" /> : (
                  <button
                    key={i}
                    role="menuitem"
                    className="menu-item"
                    disabled={it.disabled || !!it.phase}
                    title={it.phase ? `Planned: ${it.phase}` : undefined}
                    onClick={() => { setOpen(null); it.run?.(); }}
                  >
                    <span className="check">{it.checked ? '✓' : ''}</span>
                    <span className="label">{it.label}</span>
                    <span className="hint">{it.phase ?? (it.shortcut ? formatKeys(SHORTCUTS[it.shortcut]!.keys) : '')}</span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

function pickFiles(accept: string, cb: (files: FileList) => void) {
  openFilePicker({ accept, multiple: true }, cb);
}
