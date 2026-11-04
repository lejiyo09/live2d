import { describe, expect, it } from 'vitest';
import {
  CommandHistory, createEmptyProject, deleteNodes, flattenForTree, groupNodes, moveNode, reorderNode, resolveDrawOrder,
  setNodeProps, ungroup, type LayerNode, type Project, applySelection, emptySelection,
} from '@l2s/editor-core';

function makeProject(): Project {
  const p = createEmptyProject('t', 100, 100);
  const mk = (id: string): LayerNode => ({
    id, kind: 'layer', name: id, parentId: null, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    bounds: { x: 0, y: 0, width: 10, height: 10 }, assets: { original: `a_${id}`, display: `a_${id}` }, clipping: false, sourcePath: [],
  });
  for (const id of ['a', 'b', 'c']) { p.nodes[id] = mk(id); p.rootIds.push(id); }
  return p;
}

describe('CommandHistory', () => {
  it('undoes and redoes property changes', () => {
    const h = new CommandHistory(makeProject());
    h.execute(setNodeProps(['a'], { visible: false }));
    expect(h.project.nodes.a!.visible).toBe(false);
    h.undo();
    expect(h.project.nodes.a!.visible).toBe(true);
    h.redo();
    expect(h.project.nodes.a!.visible).toBe(false);
  });

  it('does not record no-op commands', () => {
    const h = new CommandHistory(makeProject());
    expect(h.execute(setNodeProps(['a'], { visible: true }))).toBe(false);
    expect(h.state.canUndo).toBe(false);
  });

  it('merges commands with the same mergeKey', () => {
    let t = 0;
    const h = new CommandHistory(makeProject(), { now: () => t });
    for (const o of [0.9, 0.8, 0.5]) { t += 100; h.execute(setNodeProps(['a'], { opacity: o }, { mergeKey: 'op' })); }
    expect(h.labels.undo).toHaveLength(1);
    h.undo();
    expect(h.project.nodes.a!.opacity).toBe(1);
  });

  it('keeps previous revisions untouched (structural sharing)', () => {
    const h = new CommandHistory(makeProject());
    const before = h.project;
    h.execute(setNodeProps(['b'], { name: 'B' }));
    expect(before.nodes.b!.name).toBe('b');
    expect(h.project.nodes.a).toBe(before.nodes.a);
  });
});

describe('structure commands', () => {
  it('groups, keeps draw order, ungroups', () => {
    const h = new CommandHistory(makeProject());
    const { command, groupId } = groupNodes(['c', 'a']);
    h.execute(command);
    expect(h.project.rootIds).toEqual(['b', groupId]);
    expect((h.project.nodes[groupId] as { childIds: string[] }).childIds).toEqual(['a', 'c']);
    expect(resolveDrawOrder(h.project).map((r) => r.node.id)).toEqual(['b', 'a', 'c']);
    h.execute(ungroup(groupId));
    expect(h.project.rootIds).toEqual(['b', 'a', 'c']);
    h.undo(); h.undo();
    expect(h.project.rootIds).toEqual(['a', 'b', 'c']);
  });

  it('moves between parents and rejects cycles', () => {
    const h = new CommandHistory(makeProject());
    const { command, groupId } = groupNodes(['a']);
    h.execute(command);
    h.execute(moveNode('c', groupId, 0));
    expect(h.project.nodes.c!.parentId).toBe(groupId);
    expect(() => h.execute(moveNode(groupId, groupId, 0))).toThrow();
  });

  it('reorders within siblings', () => {
    const h = new CommandHistory(makeProject());
    h.execute(reorderNode('a', 1));
    expect(h.project.rootIds).toEqual(['b', 'a', 'c']);
    expect(h.execute(reorderNode('c', 1))).toBe(false);
  });

  it('deletes subtrees and restores them on undo', () => {
    const h = new CommandHistory(makeProject());
    const { command, groupId } = groupNodes(['a', 'b']);
    h.execute(command);
    h.execute(deleteNodes([groupId, 'a']));
    expect(Object.keys(h.project.nodes)).toEqual(['c']);
    h.undo();
    expect(Object.keys(h.project.nodes).sort()).toEqual(['a', 'b', 'c', groupId].sort());
  });

  it('flattens tree top-first and selects ranges', () => {
    const p = makeProject();
    expect(flattenForTree(p).map((r) => r.node.id)).toEqual(['c', 'b', 'a']);
    let s = applySelection(p, emptySelection, 'c', 'replace');
    s = applySelection(p, s, 'a', 'range');
    expect(s.ids).toEqual(['c', 'b', 'a']);
  });

  it('hides clipped layers whose base is hidden', () => {
    const p = makeProject();
    (p.nodes.b as LayerNode).clipping = true;
    p.nodes.a!.visible = false;
    const r = resolveDrawOrder(p);
    expect(r[1]!.clipBaseId).toBe('a');
    expect(r[1]!.effectiveVisible).toBe(false);
  });
});
