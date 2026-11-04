import type { NodeId, Project } from './model.ts';
import { flattenForTree } from './tree.ts';

export type SelectMode = 'replace' | 'toggle' | 'add' | 'range';

export interface Selection {
  ids: NodeId[];
  /** Anchor for shift-range selection in the tree. */
  anchor: NodeId | null;
}

export const emptySelection: Selection = { ids: [], anchor: null };

export function applySelection(project: Project, sel: Selection, id: NodeId | null, mode: SelectMode): Selection {
  if (id === null) return mode === 'replace' ? emptySelection : sel;
  switch (mode) {
    case 'replace':
      return { ids: [id], anchor: id };
    case 'add':
      return sel.ids.includes(id) ? sel : { ids: [...sel.ids, id], anchor: id };
    case 'toggle':
      return sel.ids.includes(id)
        ? { ids: sel.ids.filter((x) => x !== id), anchor: sel.anchor === id ? null : sel.anchor }
        : { ids: [...sel.ids, id], anchor: id };
    case 'range': {
      if (!sel.anchor || !project.nodes[sel.anchor]) return { ids: [id], anchor: id };
      const rows = flattenForTree(project).map((r) => r.node.id);
      const a = rows.indexOf(sel.anchor);
      const b = rows.indexOf(id);
      if (a < 0 || b < 0) return { ids: [id], anchor: id };
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return { ids: rows.slice(lo, hi + 1), anchor: sel.anchor };
    }
  }
}

/** Remove ids that no longer exist (after undo/delete). */
export function pruneSelection(project: Project, sel: Selection): Selection {
  const exists = (id: NodeId) => !!project.nodes[id] || !!project.deformers?.[id];
  const ids = sel.ids.filter(exists);
  if (ids.length === sel.ids.length && (!sel.anchor || exists(sel.anchor))) return sel;
  return { ids, anchor: sel.anchor && exists(sel.anchor) ? sel.anchor : null };
}
