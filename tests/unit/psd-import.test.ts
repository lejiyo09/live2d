import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { encodePng, importPsd, suggestPartTag } from '@l2s/psd-importer';
import { resolveDrawOrder, type GroupNode, type LayerNode } from '@l2s/editor-core';
import { buildPsd, layer } from '../helpers.ts';

describe('importPsd', () => {
  it('preserves tree, order, visibility, opacity, blend and bounds', () => {
    const bytes = buildPsd({
      width: 64, height: 48,
      children: [
        layer('얼굴', 4, 4, 30, 30, [255, 220, 200, 255]),
        { name: '머리', opened: true, children: [
          layer('뒷머리', 0, 0, 20, 10, [40, 30, 30, 255], { hidden: true }),
          layer('앞머리_좌', 10, 2, 12, 8, [50, 40, 40, 255], { opacity: 0.5, blendMode: 'multiply' }),
        ] },
      ],
    });
    const { project, stats, warnings } = importPsd(bytes, { fileName: 'test.psd', sourceAssetId: 'src' });
    expect(stats).toMatchObject({ layers: 3, groups: 1, width: 64, height: 48 });
    expect(warnings).toEqual([]);
    expect(project.canvas).toEqual({ width: 64, height: 48 });
    const [face, hair] = project.rootIds.map((id) => project.nodes[id]!);
    expect(face!.name).toBe('얼굴');
    expect(hair!.kind).toBe('group');
    const g = hair as GroupNode;
    expect(g.blendMode).toBe('pass-through');
    const [back, front] = g.childIds.map((id) => project.nodes[id] as LayerNode);
    expect(back!.visible).toBe(false);
    expect(front!.opacity).toBeCloseTo(0.5, 2);
    expect(front!.blendMode).toBe('multiply');
    expect(front!.bounds).toEqual({ x: 10, y: 2, width: 12, height: 8 });
    expect(front!.partTag?.category).toBe('Hair.Front.Left');
    expect(resolveDrawOrder(project).map((r) => r.node.name)).toEqual(['얼굴', '뒷머리', '앞머리_좌']);
  });

  it('turns clipping into a runtime mask reference (pixels stay unclipped)', () => {
    const bytes = buildPsd({
      width: 20, height: 20,
      children: [
        layer('base', 0, 0, 10, 10, [255, 0, 0, 255]),
        layer('clip', 5, 5, 10, 10, [0, 0, 255, 255], { clipping: true }),
      ],
    });
    const { project, assets } = importPsd(bytes, { fileName: 'c.psd', sourceAssetId: 's' });
    const base = project.nodes[project.rootIds[0]!] as LayerNode;
    const clip = project.nodes[project.rootIds[1]!] as LayerNode;
    expect(clip.clipping).toBe(true);
    expect(clip.clipMask).toEqual({ ids: [base.id], inverted: false });
    expect(clip.assets.display).toBe(clip.assets.original);
    const disp = assets.find((a) => a.id === clip.assets.display)!.pixels;
    expect(disp.data[(7 * 10 + 7) * 4 + 3]).toBe(255); // outside the base, still opaque in the texture
  });

  it('bakes layer masks', () => {
    const mask = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const v = x < 5 ? 255 : 0;
      mask.data.set([v, v, v, 255], (y * 10 + x) * 4);
    }
    const bytes = buildPsd({
      width: 10, height: 10,
      children: [layer('m', 0, 0, 10, 10, [0, 255, 0, 255], { mask: { left: 0, top: 0, right: 10, bottom: 10, defaultColor: 0, imageData: mask } })],
    });
    const { project, assets } = importPsd(bytes, { fileName: 'm.psd', sourceAssetId: 's' });
    const n = project.nodes[project.rootIds[0]!] as LayerNode;
    expect(n.assets.mask).toBeDefined();
    const disp = assets.find((a) => a.id === n.assets.display)!.pixels;
    expect(disp.data[(5 * 10 + 2) * 4 + 3]).toBe(255);
    expect(disp.data[(5 * 10 + 7) * 4 + 3]).toBe(0);
  });

  it('skips empty layers with a warning', () => {
    const bytes = buildPsd({ width: 10, height: 10, children: [layer('empty', 0, 0, 4, 4, [0, 0, 0, 0]), layer('ok', 0, 0, 4, 4, [1, 2, 3, 255])] });
    const { project, warnings } = importPsd(bytes, { fileName: 'e.psd', sourceAssetId: 's' });
    expect(project.rootIds).toHaveLength(1);
    expect(warnings.map((w) => w.code)).toContain('empty-layer-skipped');
  });
});

describe('encodePng', () => {
  it('produces a lossless PNG stream', () => {
    const w = 3, h = 2;
    const px = new Uint8Array([1, 2, 3, 4, 250, 9, 8, 7, 0, 0, 0, 0, 10, 20, 30, 40, 5, 5, 5, 1, 255, 255, 255, 255]);
    const png = encodePng(w, h, px);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // Locate IDAT and undo the Up filter.
    const dv = new DataView(png.buffer);
    const idatLen = dv.getUint32(33);
    const raw = unzlibSync(png.subarray(41, 41 + idatLen));
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w * 4; x++) {
      const v = raw[y * (w * 4 + 1) + 1 + x]!;
      out[y * w * 4 + x] = y === 0 ? v : (v + out[(y - 1) * w * 4 + x]!) & 0xff;
    }
    expect([...out]).toEqual([...px]);
  });
});

describe('suggestPartTag', () => {
  it.each([
    ['앞머리_우', 'Hair.Front.Right'],
    ['흰자_좌', 'Eye.White.Left'],
    ['홍채_우', 'Eye.Iris.Right'],
    ['얼굴', 'Face.Base'],
    ['입_열림', 'Mouth.Open'],
    ['前髪', 'Hair.Front'],
    ['eye_white_L', 'Eye.White.Left'],
  ])('%s → %s', (name, cat) => {
    expect(suggestPartTag(name)?.category).toBe(cat);
  });
  it('returns undefined for unknown names', () => {
    expect(suggestPartTag('레이어 1')).toBeUndefined();
  });
});
