import type { Command } from './history.ts';
import { newId, type BlendMode, type GroupNode, type NodeId, type PartTag, type Project } from './model.ts';
import { childIdsOf, getNode, isInSubtree, subtreeIds } from './tree.ts';

export interface EditableNodeProps {
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  partTag: PartTag | undefined;
  collapsed: boolean;
}

function touch(d: Project) {
  d.updatedAt = new Date().toISOString();
}

export function setNodeProps(ids: NodeId[], props: Partial<EditableNodeProps>, opts: { label?: string; mergeKey?: string } = {}): Command {
  return {
    label: opts.label ?? `Set ${Object.keys(props).join(', ')}`,
    mergeKey: opts.mergeKey,
    apply(d) {
      let changed = false;
      for (const id of ids) {
        const n = getNode(d, id) as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(props)) {
          if (k === 'collapsed' && n.kind !== 'group') continue;
          if (k === 'opacity') {
            const c = Math.min(1, Math.max(0, v as number));
            if (n[k] !== c) { n[k] = c; changed = true; }
            continue;
          }
          if (k === 'partTag' && v === undefined) {
            if ('partTag' in n) { delete n.partTag; changed = true; }
            continue;
          }
          if (n[k] !== v) { n[k] = v; changed = true; }
        }
      }
      // Collapsing is a view-state change; it is recorded but does not dirty the document timestamp.
      if (changed && !(Object.keys(props).length === 1 && 'collapsed' in props)) touch(d);
    },
  };
}

export function renameNode(id: NodeId, name: string): Command {
  return setNodeProps([id], { name: name.trim() || 'Untitled' }, { label: 'Rename' });
}

/**
 * Move a node to `parentId` at `index` (draw-order index, 0 = bottom, clamped).
 * Moving a group into its own subtree is rejected.
 */
export function moveNode(id: NodeId, parentId: NodeId | null, index: number): Command {
  return {
    label: 'Move',
    apply(d) {
      if (parentId !== null) {
        if (isInSubtree(d, parentId, id)) throw new Error('Cannot move a node into its own subtree');
        if (getNode(d, parentId).kind !== 'group') throw new Error('Target is not a group');
      }
      const node = getNode(d, id);
      const from = childIdsOf(d, node.parentId);
      const fromIdx = from.indexOf(id);
      from.splice(fromIdx, 1);
      const to = childIdsOf(d, parentId);
      let at = index;
      if (node.parentId === parentId && fromIdx < index) at -= 1; // account for removal
      at = Math.max(0, Math.min(to.length, at));
      to.splice(at, 0, id);
      node.parentId = parentId;
      touch(d);
    },
  };
}

/** Move one step up (+1) or down (-1) in draw order among siblings. */
export function reorderNode(id: NodeId, delta: 1 | -1): Command {
  return {
    label: delta > 0 ? 'Bring Forward' : 'Send Backward',
    apply(d) {
      const node = getNode(d, id);
      const sibs = childIdsOf(d, node.parentId);
      const i = sibs.indexOf(id);
      const j = i + delta;
      if (j < 0 || j >= sibs.length) return;
      [sibs[i], sibs[j]] = [sibs[j]!, sibs[i]!];
      touch(d);
    },
  };
}

/**
 * Wrap nodes in a new group. The group is inserted where the top-most of the
 * nodes sat; nodes keep their relative draw order. Returns the command and
 * the id the group will receive.
 */
export function groupNodes(ids: NodeId[], name = 'Group'): { command: Command; groupId: NodeId } {
  const groupId = newId('grp');
  return {
    groupId,
    command: {
      label: 'Group',
      apply(d) {
        if (ids.length === 0) return;
        // Drop ids whose ancestor is also selected.
        const roots = ids.filter((id) => !ids.some((o) => o !== id && isInSubtree(d, id, o)));
        const first = getNode(d, roots[0]!);
        const parentId = first.parentId;
        const target = childIdsOf(d, parentId);
        // Order by global draw order to keep relative stacking.
        const order = globalOrder(d);
        roots.sort((a, b) => order.get(a)! - order.get(b)!);
        const topIdx = Math.max(...roots.filter((r) => getNode(d, r).parentId === parentId).map((r) => target.indexOf(r)), 0);
        const group: GroupNode = {
          id: groupId, kind: 'group', name, parentId, visible: true, locked: false, opacity: 1,
          blendMode: 'pass-through', childIds: [], collapsed: false,
        };
        d.nodes[groupId] = group;
        let insertAt = topIdx + 1;
        for (const r of roots) {
          const n = getNode(d, r);
          const sibs = childIdsOf(d, n.parentId);
          const i = sibs.indexOf(r);
          sibs.splice(i, 1);
          if (n.parentId === parentId && i < insertAt) insertAt--;
          n.parentId = groupId;
          (d.nodes[groupId] as GroupNode).childIds.push(r);
        }
        childIdsOf(d, parentId).splice(insertAt, 0, groupId);
        touch(d);
      },
    },
  };
}

export function ungroup(groupId: NodeId): Command {
  return {
    label: 'Ungroup',
    apply(d) {
      const g = getNode(d, groupId);
      if (g.kind !== 'group') return;
      const sibs = childIdsOf(d, g.parentId);
      const i = sibs.indexOf(groupId);
      sibs.splice(i, 1, ...g.childIds);
      for (const c of g.childIds) getNode(d, c).parentId = g.parentId;
      delete d.nodes[groupId];
      touch(d);
    },
  };
}

export function deleteNodes(ids: NodeId[]): Command {
  return {
    label: 'Delete',
    apply(d) {
      for (const id of ids) {
        if (!d.nodes[id]) continue; // already removed as part of another subtree
        const n = getNode(d, id);
        const sibs = childIdsOf(d, n.parentId);
        sibs.splice(sibs.indexOf(id), 1);
        for (const sid of subtreeIds(d, id)) {
          delete d.nodes[sid];
          delete d.meshes[sid];
        }
        for (const other of Object.values(d.nodes)) {
          if (other.kind !== 'layer' || !other.clipMask) continue;
          other.clipMask.ids = other.clipMask.ids.filter((m) => d.nodes[m]);
          if (!other.clipMask.ids.length) delete other.clipMask;
        }
      }
      touch(d);
    },
  };
}

/** Move layers (and everything inside groups) by a pixel offset. */
export function translateNodes(ids: NodeId[], dx: number, dy: number, opts: { mergeKey?: string } = {}): Command {
  return {
    label: 'Move Position',
    mergeKey: opts.mergeKey,
    apply(d) {
      if (dx === 0 && dy === 0) return;
      const done = new Set<NodeId>();
      for (const id of ids) {
        for (const sid of subtreeIds(d, id)) {
          if (done.has(sid)) continue;
          done.add(sid);
          const n = getNode(d, sid);
          if (n.kind !== 'layer') continue;
          n.bounds.x += dx;
          n.bounds.y += dy;
          if (n.mask) { n.mask.bounds.x += dx; n.mask.bounds.y += dy; }
          const m = d.meshes[sid];
          if (m) {
            for (let i = 0; i < m.vertices.length; i += 2) { m.vertices[i]! += dx; m.vertices[i + 1]! += dy; }
            // Root-level keyforms are in canvas space and move along; under a deformer, move the deformer instead.
            if (m.form && !m.parentId) for (const kf of m.form.keyforms) for (let i = 0; i < kf.positions.length; i += 2) { kf.positions[i]! += dx; kf.positions[i + 1]! += dy; }
          }
        }
      }
      touch(d);
    },
  };
}

/** Set (or clear with `null`) the mask references of layers. */
export function setClipMask(layerIds: NodeId[], mask: { ids: NodeId[]; inverted: boolean } | null): Command {
  return {
    label: mask ? 'Set Clipping Mask' : 'Clear Clipping Mask',
    apply(d) {
      for (const id of layerIds) {
        const n = getNode(d, id);
        if (n.kind !== 'layer') continue;
        if (mask && mask.ids.filter((m) => m !== id && d.nodes[m]?.kind === 'layer').length) n.clipMask = { ids: mask.ids.filter((m) => m !== id && d.nodes[m]?.kind === 'layer'), inverted: mask.inverted };
        else delete n.clipMask;
      }
      touch(d);
    },
  };
}

export function renameProject(name: string): Command {
  return { label: 'Rename Project', apply(d) { d.name = name; touch(d); } };
}

function globalOrder(p: Project): Map<NodeId, number> {
  const m = new Map<NodeId, number>();
  let i = 0;
  const walk = (ids: NodeId[]) => {
    for (const id of ids) {
      m.set(id, i++);
      const n = getNode(p, id);
      if (n.kind === 'group') walk(n.childIds);
    }
  };
  walk(p.rootIds);
  return m;
}
