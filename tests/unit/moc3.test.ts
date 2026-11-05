import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInThisContext } from 'node:vm';
import { getCore, loadMoc, openBundle, updateFrame, normalizePath, MocError } from '@l2s/cubism-adapter';

const DIR = 'tests/fixtures/mock-model';
function files(): Map<string, Blob> {
  const out = new Map<string, Blob>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(`Mock/${relative(DIR, p)}`, new Blob([readFileSync(p)]));
    }
  };
  walk(DIR);
  return out;
}

beforeAll(() => {
  // Test double for the proprietary Core (see the file header).
  runInThisContext(readFileSync('tests/fixtures/mock-cubism-core.js', 'utf8'));
});

describe('model3 bundle', () => {
  it('resolves references relative to the model3.json and reports missing files', async () => {
    const f = files();
    const { bundle, issues } = await openBundle(f);
    expect(issues).toEqual([]);
    expect(bundle!.model3Path).toBe('Mock/mock.model3.json');
    expect(bundle!.resolve('textures/texture_00.png')).toBeDefined();
    f.delete('Mock/textures/texture_00.png');
    const broken = await openBundle(f);
    expect(broken.bundle).toBeNull();
    expect(broken.issues[0]!.message).toMatch(/Texture 0 not found/);
    expect(normalizePath('a/./b/../c.png')).toBe('a/c.png');
  });
});

describe('Core adapter (with the test double)', () => {
  it('loads, validates and converts drawables to canvas pixels', async () => {
    const core = getCore()!;
    const { bundle } = await openBundle(files());
    const bytes = await bundle!.resolve(bundle!.model3.FileReferences.Moc)!.arrayBuffer();
    const lm = loadMoc(core, bytes, 1);
    expect(lm.info.coreVersion).toBe('5.0.0');
    expect(lm.info.parameters.map((p) => p.id)).toEqual(['ParamAngleX', 'ParamEyeBallX']);
    expect(lm.info.maskedDrawables).toBe(1);
    const f0 = updateFrame(lm, {});
    // Face: ±0.2 units at PPU 400 around origin (200,200) → 120..280 px; model y-up → canvas y-down.
    expect(Array.from(f0[0]!.positions.slice(0, 2))).toEqual([120, 120]);
    expect(Array.from(f0[0]!.uvs.slice(0, 2))).toEqual([0, 0]); // v flipped
    expect(f0[1]!.masks).toEqual([0]);
    const f1 = updateFrame(lm, { ParamEyeBallX: 1 });
    expect(f1[1]!.positions[0]! - f0[1]!.positions[0]!).toBeCloseTo(100); // 0.25 units × 400
    lm.release();
  });

  it('rejects invalid and too-new moc files', () => {
    const core = getCore()!;
    expect(() => loadMoc(core, new TextEncoder().encode('nope').buffer as ArrayBuffer, 0)).toThrow(MocError);
    const newer = new TextEncoder().encode('MOCK' + JSON.stringify({ version: 99 })).buffer as ArrayBuffer;
    expect(() => loadMoc(core, newer, 0)).toThrow(/newer than the loaded Core/);
  });
});
