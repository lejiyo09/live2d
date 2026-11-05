import type { CanvasTool, ToolPointerEvent } from '@l2s/rendering-engine';
import { createArtPath } from '@l2s/mesh-engine';
import { editor, log, useEditor } from '../state/editor.ts';
import { useMesh } from '../state/mesh.ts';

/** Pen tool for ArtPaths: click to add points, double-click / Enter to finish, Esc to cancel. */
export const pen = { points: [] as number[], hover: null as [number, number] | null, onChange: () => {} };

export function finishPen() {
  const pts = pen.points;
  pen.points = [];
  pen.hover = null;
  pen.onChange();
  useMesh.setState({ mode: 'select' });
  if (pts.length < 4) { if (pts.length) log('warn', 'An ArtPath needs at least two points.'); return; }
  // Put the path into the folder of the active layer (if any).
  const s = useEditor.getState();
  const anchor = s.selection.anchor ? s.project.nodes[s.selection.anchor] : undefined;
  const parentId = anchor?.kind === 'group' ? anchor.id : anchor?.parentId ?? null;
  const n = Object.values(s.project.nodes).filter((x) => x.name.startsWith('ArtPath')).length + 1;
  const { command, id } = createArtPath(pts, { name: `ArtPath ${n}`, parentId });
  if (editor.run(command)) editor.selectIds([id]);
}

export function cancelPen() {
  pen.points = [];
  pen.hover = null;
  pen.onChange();
  useMesh.setState({ mode: 'select' });
}

export function createPenTool(): CanvasTool {
  return {
    cursor: 'crosshair',
    onPointerDown(e: ToolPointerEvent) {
      if (e.detail >= 2) { finishPen(); return false; }
      pen.points.push(e.world.x, e.world.y);
      pen.onChange();
      return false;
    },
    onPointerMove(e: ToolPointerEvent) {
      pen.hover = [e.world.x, e.world.y];
      pen.onChange();
    },
    onPointerUp() {},
  };
}
