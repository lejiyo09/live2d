import type { CanvasTool, ToolPointerEvent } from '@l2s/rendering-engine';
import { addVertex, hitVertex, moveUVs, moveVertices, verticesInRect } from '@l2s/mesh-engine';
import type { Rect } from '@l2s/editor-core';
import { editor } from '../state/editor.ts';
import { useMesh } from '../state/mesh.ts';

const HIT_RADIUS_PX = 7;

/**
 * Mesh-edit tool (spec §5.2):
 *  click vertex = select (Shift add, Ctrl toggle) · drag = move selected
 *  drag empty = box select · Alt+click / double-click = add vertex
 */
export function createMeshEditTool(onOverlay: (o: { hover: number; box: Rect | null }) => void): CanvasTool {
  let drag: { last: { x: number; y: number }; key: string; moved: boolean } | null = null;
  let box: { start: { x: number; y: number }; cur: { x: number; y: number }; additive: boolean } | null = null;
  let hover = -1;
  let seq = 0;

  const mesh = () => {
    const id = useMesh.getState().editLayerId;
    return id ? { id, m: editor.project.meshes[id] } : null;
  };
  const rectOf = (b: NonNullable<typeof box>): Rect => ({
    x: Math.min(b.start.x, b.cur.x), y: Math.min(b.start.y, b.cur.y),
    width: Math.abs(b.cur.x - b.start.x), height: Math.abs(b.cur.y - b.start.y),
  });

  return {
    cursor: 'crosshair',
    onPointerDown(e: ToolPointerEvent) {
      const cur = mesh();
      if (!cur?.m) return false;
      const { id, m } = cur;
      const sel = useMesh.getState().selectedVertices;
      const hit = hitVertex(m, e.world.x, e.world.y, HIT_RADIUS_PX / e.zoom);

      if (hit < 0 && (e.alt || e.detail >= 2)) {
        const index = m.vertices.length / 2;
        if (editor.run(addVertex(id, e.world.x, e.world.y))) useMesh.setState({ selectedVertices: [index] });
        return false;
      }
      if (hit >= 0) {
        let next = sel;
        if (e.ctrl) next = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
        else if (e.shift) next = sel.includes(hit) ? sel : [...sel, hit];
        else if (!sel.includes(hit)) next = [hit];
        useMesh.setState({ selectedVertices: next });
        if (!next.includes(hit)) return false;
        drag = { last: e.world, key: `mesh-drag:${++seq}`, moved: false };
        return true;
      }
      box = { start: e.world, cur: e.world, additive: e.shift || e.ctrl };
      return true;
    },
    onPointerMove(e: ToolPointerEvent, captured: boolean) {
      const cur = mesh();
      if (!cur?.m) return;
      if (captured && drag) {
        const dx = e.world.x - drag.last.x, dy = e.world.y - drag.last.y;
        if (dx || dy) {
          const sel = useMesh.getState().selectedVertices;
          editor.run(useMesh.getState().uvMode ? moveUVs(cur.id, sel, dx, dy, drag.key) : moveVertices(cur.id, sel, dx, dy, drag.key));
          drag.last = e.world;
          drag.moved = true;
        }
        return;
      }
      if (captured && box) {
        box.cur = e.world;
        onOverlay({ hover, box: rectOf(box) });
        return;
      }
      const h = hitVertex(cur.m, e.world.x, e.world.y, HIT_RADIUS_PX / e.zoom);
      if (h !== hover) { hover = h; onOverlay({ hover, box: null }); }
    },
    onPointerUp() {
      const cur = mesh();
      if (drag) {
        editor.sealHistoryStep();
        drag = null;
      }
      if (box && cur?.m) {
        const r = rectOf(box);
        const inBox = r.width * r.height > 0 ? verticesInRect(cur.m, r) : [];
        const sel = useMesh.getState().selectedVertices;
        useMesh.setState({ selectedVertices: box.additive ? [...new Set([...sel, ...inBox])] : inBox });
        box = null;
        onOverlay({ hover, box: null });
      }
    },
  };
}
