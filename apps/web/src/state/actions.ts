import { deleteNodes, groupNodes, reorderNode, setNodeProps, siblingsOf, ungroup } from '@l2s/editor-core';
import { editor, useEditor } from './editor.ts';
import { deleteDeformers } from '@l2s/deformer-engine';
import { openFilePicker } from './filePicker.ts';

/** User-level actions shared by menus, toolbar and keyboard shortcuts. */
export const actions = {
  openFileDialog(accept = '.psd,.psb,.l2studio') {
    openFilePicker({ accept }, (files) => { const f = files[0]; if (f) void editor.openFile(f); });
  },
  groupSelection() {
    const ids = useEditor.getState().selection.ids.filter((id) => editor.project.nodes[id]);
    if (!ids.length) return;
    const { command, groupId } = groupNodes(ids, 'Group');
    if (editor.run(command)) editor.selectIds([groupId]);
  },
  ungroupSelection() {
    const p = editor.project;
    const groups = useEditor.getState().selection.ids.filter((id) => p.nodes[id]?.kind === 'group');
    for (const g of groups) editor.run(ungroup(g));
  },
  deleteSelection() {
    const p = editor.project;
    const ids = useEditor.getState().selection.ids;
    const defs = ids.filter((id) => p.deformers[id]);
    const nodes = ids.filter((id) => p.nodes[id]);
    if (defs.length) editor.run(deleteDeformers(defs));
    if (nodes.length) editor.run(deleteNodes(nodes));
  },
  toggleVisibility() {
    const p = editor.project;
    const ids = useEditor.getState().selection.ids.filter((id) => p.nodes[id]);
    if (!ids.length) return;
    const anyVisible = ids.some((id) => p.nodes[id]?.visible);
    editor.run(setNodeProps(ids, { visible: !anyVisible }, { label: anyVisible ? 'Hide' : 'Show' }));
  },
  toggleLock() {
    const p = editor.project;
    const ids = useEditor.getState().selection.ids.filter((id) => p.nodes[id]);
    if (!ids.length) return;
    const anyUnlocked = ids.some((id) => !p.nodes[id]?.locked);
    editor.run(setNodeProps(ids, { locked: anyUnlocked }, { label: anyUnlocked ? 'Lock' : 'Unlock' }));
  },
  reorder(delta: 1 | -1) {
    const p = editor.project;
    const ids = useEditor.getState().selection.ids.filter((id) => p.nodes[id]);
    const idx = (id: string) => siblingsOf(p, id).indexOf(id);
    // Move the leading item first so a contiguous block keeps its spacing.
    ids.sort((a, b) => (delta > 0 ? idx(b) - idx(a) : idx(a) - idx(b)));
    for (const id of ids) editor.run(reorderNode(id, delta));
  },
};
