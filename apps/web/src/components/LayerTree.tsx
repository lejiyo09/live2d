import { memo, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { flattenForTree, isInSubtree, moveNode, renameNode, setNodeProps, siblingsOf, type NodeId, type Project, type SceneNode } from '@l2s/editor-core';
import { editor, useEditor } from '../state/editor.ts';
import { actions } from '../state/actions.ts';
import { DeformerTree } from './DeformerTree.tsx';

type DropPos = 'above' | 'below' | 'inside';

export function LayerTree() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const meshes = project.meshes;
  const rows = useMemo(() => flattenForTree(project), [project]);
  const [drop, setDrop] = useState<{ id: NodeId; pos: DropPos } | null>(null);
  const dragIds = useRef<NodeId[]>([]);
  const selected = useMemo(() => new Set(selection.ids), [selection.ids]);

  const onRowClick = (e: MouseEvent, id: NodeId) => {
    editor.select(id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
  };

  const onDragStart = (e: DragEvent, id: NodeId) => {
    dragIds.current = selected.has(id) ? selection.ids : [id];
    if (!selected.has(id)) editor.select(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-l2s-nodes', dragIds.current.join(','));
  };

  const onDragOver = (e: DragEvent, node: SceneNode) => {
    if (!e.dataTransfer.types.includes('application/x-l2s-nodes')) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const pos: DropPos = node.kind === 'group' && f > 0.3 && f < 0.7 ? 'inside' : f < 0.5 ? 'above' : 'below';
    if (dragIds.current.some((d) => isInSubtree(project, node.id, d))) { setDrop(null); return; }
    e.preventDefault();
    if (drop?.id !== node.id || drop.pos !== pos) setDrop({ id: node.id, pos });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (!drop) return;
    applyDrop(project, dragIds.current, drop.id, drop.pos);
    setDrop(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = selection.ids.at(-1);
    const i = cur ? rows.findIndex((r) => r.node.id === cur) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) editor.select(next.node.id, e.shiftKey ? 'range' : 'replace');
  };

  const leftTab = useEditor((s) => s.leftTab);
  return (
    <section className="panel layer-panel" aria-label="Parts">
      <header className="panel-header tabs">
        <button role="tab" className={leftTab === 'parts' ? 'tab active' : 'tab'} onClick={() => editor.setLeftTab('parts')}>Parts</button>
        <button role="tab" className={leftTab === 'deformers' ? 'tab active' : 'tab'} onClick={() => editor.setLeftTab('deformers')} data-testid="tab-deformers">Deformers</button>
        <span className="spacer" />
        <span className="panel-tools">
          <button title="New group from selection (Ctrl+G)" onClick={actions.groupSelection} disabled={!selection.ids.length}>⊞</button>
          <button title="Delete (Del)" onClick={actions.deleteSelection} disabled={!selection.ids.length}>🗑</button>
        </span>
      </header>
      {leftTab === 'deformers' ? <DeformerTree /> : <div className="tree" role="tree" tabIndex={0} onKeyDown={onKeyDown} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrop(null); }} data-testid="layer-tree">
        {rows.length === 0 && <div className="empty-hint">Open a PSD file to begin<br /><small>File → Open, or drop a file on the canvas</small></div>}
        {rows.map(({ node, depth }) => (
          <TreeRow
            key={node.id}
            node={node}
            hasMesh={!!meshes[node.id]}
            depth={depth}
            selected={selected.has(node.id)}
            hovered={hoverId === node.id}
            dropPos={drop?.id === node.id ? drop.pos : null}
            onClick={onRowClick}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
          />
        ))}
      </div>}
    </section>
  );
}

function applyDrop(project: Project, ids: NodeId[], targetId: NodeId, pos: DropPos) {
  const target = project.nodes[targetId];
  if (!target) return;
  let parentId: NodeId | null;
  let index: number;
  if (pos === 'inside' && target.kind === 'group') {
    parentId = target.id;
    index = target.childIds.length; // top of the group
  } else {
    parentId = target.parentId;
    const sibs = siblingsOf(project, targetId);
    const i = sibs.indexOf(targetId);
    index = pos === 'above' ? i + 1 : i; // UI is top-first, storage is bottom-first
  }
  // Insert in draw order so relative stacking is preserved.
  const order = flattenForTree(project, true).map((r) => r.node.id).reverse();
  const sorted = ids.filter((id) => id !== targetId || pos === 'inside').sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const id of sorted) {
    const p = editor.project;
    const n = p.nodes[id];
    if (!n) continue;
    const before = n.parentId === parentId ? siblingsOf(p, id).indexOf(id) : -1;
    if (!editor.run(moveNode(id, parentId, index))) continue;
    if (!(before >= 0 && before < index)) index++;
  }
}

interface RowProps {
  node: SceneNode;
  hasMesh: boolean;
  depth: number;
  selected: boolean;
  hovered: boolean;
  dropPos: DropPos | null;
  onClick: (e: MouseEvent, id: NodeId) => void;
  onDragStart: (e: DragEvent, id: NodeId) => void;
  onDragOver: (e: DragEvent, node: SceneNode) => void;
  onDrop: (e: DragEvent) => void;
}

const TreeRow = memo(function TreeRow({ node, hasMesh, depth, selected, hovered, dropPos, onClick, onDragStart, onDragOver, onDrop }: RowProps) {
  const [editing, setEditing] = useState(false);
  const cls = ['tree-row', selected && 'selected', hovered && 'hovered', dropPos && `drop-${dropPos}`, !node.visible && 'hidden-node'].filter(Boolean).join(' ');
  const isGroup = node.kind === 'group';
  return (
    <div
      className={cls}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={isGroup ? !node.collapsed : undefined}
      data-node-id={node.id}
      style={{ paddingLeft: 4 + depth * 14 }}
      draggable={!editing}
      onClick={(e) => onClick(e, node.id)}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).classList.contains('name')) setEditing(true); }}
      onPointerEnter={() => editor.setHover(node.id)}
      onPointerLeave={() => editor.setHover(null)}
      onDragStart={(e) => onDragStart(e, node.id)}
      onDragOver={(e) => onDragOver(e, node)}
      onDrop={onDrop}
    >
      <button
        className="icon-btn"
        title={node.visible ? 'Hide' : 'Show'}
        aria-label={node.visible ? 'Hide' : 'Show'}
        onClick={(e) => { e.stopPropagation(); editor.run(setNodeProps([node.id], { visible: !node.visible }, { label: node.visible ? 'Hide' : 'Show' })); }}
      >
        {node.visible ? '👁' : '—'}
      </button>
      <button
        className={node.locked ? 'icon-btn on' : 'icon-btn dim'}
        title={node.locked ? 'Unlock' : 'Lock'}
        aria-label={node.locked ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); editor.run(setNodeProps([node.id], { locked: !node.locked }, { label: node.locked ? 'Unlock' : 'Lock' })); }}
      >
        {node.locked ? '🔒' : '🔓'}
      </button>
      {isGroup ? (
        <button
          className="twisty"
          aria-label={node.collapsed ? 'Expand' : 'Collapse'}
          onClick={(e) => { e.stopPropagation(); editor.run(setNodeProps([node.id], { collapsed: !node.collapsed }, { label: node.collapsed ? 'Expand' : 'Collapse' })); }}
        >
          {node.collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className="twisty">{node.clipping ? '↳' : ''}</span>
      )}
      <span className={isGroup ? 'kind folder' : hasMesh ? 'kind mesh' : 'kind layer'} aria-hidden title={hasMesh ? 'ArtMesh' : undefined}>{isGroup ? '📁' : hasMesh ? '◭' : '▢'}</span>
      {editing ? (
        <input
          className="rename"
          autoFocus
          defaultValue={node.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { editor.run(renameNode(node.id, e.currentTarget.value)); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className="name" title={node.name}>{node.name}</span>
      )}
      {node.partTag && (
        <span className={`tag tag-${node.partTag.source}`} title={`${node.partTag.category} (${node.partTag.source}, ${Math.round(node.partTag.confidence * 100)}%)`}>
          {node.partTag.category}
        </span>
      )}
      {node.blendMode !== 'normal' && node.blendMode !== 'pass-through' && <span className="blend-badge" title={node.blendMode}>{node.blendMode}</span>}
      {node.opacity < 1 && <span className="opacity-badge">{Math.round(node.opacity * 100)}%</span>}
    </div>
  );
});
