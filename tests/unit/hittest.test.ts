import { describe, expect, it } from 'vitest';
import { hitTestAll, pick } from '../../packages/rendering-engine/src/hittest.ts';
import { fit, zoomAt, screenToWorld } from '../../packages/rendering-engine/src/camera.ts';
import { createEmptyProject, type LayerNode } from '@l2s/editor-core';

function project() {
  const p = createEmptyProject('h', 100, 100);
  const mk = (id: string, x: number, locked = false): LayerNode => ({
    id, kind: 'layer', name: id, parentId: null, visible: true, locked, opacity: 1, blendMode: 'normal',
    bounds: { x, y: 0, width: 10, height: 10 }, assets: { original: id, display: id }, clipping: false, sourcePath: [],
  });
  p.nodes.bottom = mk('bottom', 0);
  p.nodes.top = mk('top', 5);
  p.rootIds = ['bottom', 'top'];
  return p;
}

// `top` is transparent in its left half.
const sample = (asset: string, x: number) => (asset === 'top' && x < 5 ? 0 : 255);

describe('hit testing', () => {
  it('respects pixel alpha and stacking', () => {
    const p = project();
    expect(hitTestAll(p, sample, 7, 5)).toEqual(['bottom']); // top transparent here
    expect(hitTestAll(p, sample, 12, 5)).toEqual(['top']);
    expect(hitTestAll(p, sample, 50, 50)).toEqual([]);
  });
  it('cycles through overlapping layers with alt-click', () => {
    const p = project();
    const s = () => 255;
    expect(pick(p, s, 7, 5)).toBe('top');
    expect(pick(p, s, 7, 5, { cycleFrom: 'top' })).toBe('bottom');
    expect(pick(p, s, 7, 5, { cycleFrom: 'bottom' })).toBe('top');
  });
  it('ignores hidden and locked layers', () => {
    const p = project();
    p.nodes.top!.locked = true;
    expect(hitTestAll(p, () => 255, 7, 5)).toEqual(['bottom']);
    p.nodes.bottom!.visible = false;
    expect(hitTestAll(p, () => 255, 7, 5)).toEqual([]);
  });
});

describe('camera', () => {
  it('zooms around the cursor', () => {
    const c = zoomAt({ zoom: 1, x: 0, y: 0 }, 100, 50, 2);
    expect(screenToWorld(c, 100, 50)).toEqual({ x: 100, y: 50 });
  });
  it('fits content', () => {
    const c = fit(1000, 500, 200, 200, 0);
    expect(c.zoom).toBe(2.5);
    expect(c.x).toBe(250);
  });
});
