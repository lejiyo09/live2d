import type { GroupNode, LayerNode, NodeId, Project, SceneNode } from './model.ts';

export function getNode(project: Project, id: NodeId): SceneNode {
  const node = project.nodes[id];
  if (!node) throw new Error(`Unknown node: ${id}`);
  return node;
}

/** Sibling list (draw order) that contains `id`. */
export function siblingsOf(project: Project, id: NodeId): NodeId[] {
  const node = getNode(project, id);
  if (node.parentId === null) return project.rootIds;
  const parent = getNode(project, node.parentId);
  if (parent.kind !== 'group') throw new Error(`Parent of ${id} is not a group`);
  return parent.childIds;
}

export function childIdsOf(project: Project, parentId: NodeId | null): NodeId[] {
  if (parentId === null) return project.rootIds;
  const parent = getNode(project, parentId);
  if (parent.kind !== 'group') throw new Error(`${parentId} is not a group`);
  return parent.childIds;
}

export function ancestorsOf(project: Project, id: NodeId): GroupNode[] {
  const out: GroupNode[] = [];
  let cur = getNode(project, id).parentId;
  while (cur !== null) {
    const n = getNode(project, cur);
    if (n.kind !== 'group') break;
    out.push(n);
    cur = n.parentId;
  }
  return out;
}

/** True if `id` is `ancestorId` or lies inside its subtree. */
export function isInSubtree(project: Project, id: NodeId, ancestorId: NodeId): boolean {
  let cur: NodeId | null = id;
  while (cur !== null) {
    if (cur === ancestorId) return true;
    cur = getNode(project, cur).parentId;
  }
  return false;
}

export function subtreeIds(project: Project, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (nid: NodeId) => {
    out.push(nid);
    const n = getNode(project, nid);
    if (n.kind === 'group') n.childIds.forEach(walk);
  };
  walk(id);
  return out;
}

export interface ResolvedLayer {
  node: LayerNode;
  /** Visible itself and all ancestors visible. */
  effectiveVisible: boolean;
  /** Locked itself or any ancestor locked. */
  effectiveLocked: boolean;
  /** Product of own and ancestor opacity. */
  effectiveOpacity: number;
  /** Index in global draw order (0 = bottom). */
  drawIndex: number;
  /** For PSD clipping layers: the base layer they are clipped to (null if base is a group / missing). */
  clipBaseId: NodeId | null;
}

/** All layers in global draw order (bottom → top) with inherited state resolved. */
export function resolveDrawOrder(project: Project, drawOrderOf?: (id: NodeId) => number | undefined): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  const walk = (ids0: NodeId[], visible: boolean, locked: boolean, opacity: number) => {
    let base: ResolvedLayer | null = null;
    // Keyed draw order reorders siblings (stable: equal values keep tree order).
    const ids = drawOrderOf ? ids0.map((id, i) => ({ id, i, o: drawOrderOf(id) ?? 500 })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.id) : ids0;
    for (const id of ids) {
      const n = getNode(project, id);
      let v = visible && n.visible;
      const l = locked || n.locked;
      const o = opacity * n.opacity;
      if (n.kind === 'group') {
        walk(n.childIds, v, l, o);
        if (!n.clipping) base = null;
        continue;
      }
      // Photoshop hides clipped layers when their base layer is hidden.
      if (n.clipping && base) v = v && base.effectiveVisible;
      const r: ResolvedLayer = {
        node: n, effectiveVisible: v, effectiveLocked: l, effectiveOpacity: o, drawIndex: out.length,
        clipBaseId: n.clipping && base ? base.node.id : null,
      };
      out.push(r);
      if (!n.clipping) base = r;
    }
  };
  walk(project.rootIds, true, false, 1);
  return out;
}

/** Depth-first list in UI order (top → bottom), honoring collapsed groups. */
export interface TreeRow {
  node: SceneNode;
  depth: number;
}
export function flattenForTree(project: Project, includeCollapsed = false): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (ids: NodeId[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = getNode(project, ids[i]!);
      rows.push({ node: n, depth });
      if (n.kind === 'group' && (includeCollapsed || !n.collapsed)) walk(n.childIds, depth + 1);
    }
  };
  walk(project.rootIds, 0);
  return rows;
}

/** Union bounds of all layers in the given nodes' subtrees. */
export function boundsOf(project: Project, ids: NodeId[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    if (!project.nodes[id]) continue; // deformer ids etc.
    for (const sid of subtreeIds(project, id)) {
      const n = getNode(project, sid);
      if (n.kind !== 'layer' || n.bounds.width === 0 || n.bounds.height === 0) continue;
      minX = Math.min(minX, n.bounds.x);
      minY = Math.min(minY, n.bounds.y);
      maxX = Math.max(maxX, n.bounds.x + n.bounds.width);
      maxY = Math.max(maxY, n.bounds.y + n.bounds.height);
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Assets referenced by the project (for garbage collection on save). */
export function referencedAssetIds(project: Project): Set<string> {
  const ids = new Set<string>();
  if (project.source) ids.add(project.source.assetId);
  for (const n of Object.values(project.nodes)) {
    if (n.kind !== 'layer') continue;
    ids.add(n.assets.original);
    ids.add(n.assets.display);
    if (n.assets.mask) ids.add(n.assets.mask);
  }
  for (const id of [...ids]) if (id.startsWith('builtin:')) ids.delete(id);
  return ids;
}
