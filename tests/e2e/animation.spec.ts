import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

const st = <T>(page: Page, expr: string) => page.evaluate(`(() => { const e = window.__l2s; return ${expr}; })()`) as Promise<T>;

async function riggedSample(page: Page) {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().saveStatus === 'saved' && (window as any).__l2s.useEditor.getState().project.rootIds.length > 0);
  await page.click('text=AI Tools');
  await page.click('text=Auto Rig…');
  await page.getByTestId('rig-apply').click();
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().project.physics.settings.length === 2);
}

test('keyframe a motion, play it with physics, bake, edit the curve, export', async ({ page }) => {
  await riggedSample(page);
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('anim-new').click();

  // Key AngleX: 0 at t=0, 30 at t=1, 0 at t=2.
  await st(page, `e.editor.setParam('ParamAngleX', 0)`);
  await page.locator('select[aria-label="Add track"]').selectOption('ParamAngleX');
  await st(page, `e.animActions.scrub(1)`);
  await st(page, `e.editor.setParam('ParamAngleX', 30)`);
  await page.keyboard.press('k');
  await st(page, `e.animActions.scrub(2)`);
  await st(page, `e.editor.setParam('ParamAngleX', 0)`);
  await page.getByTestId('anim-key').click();
  const keys = await st<number[]>(page, `e.useEditor.getState().project.animations[0].tracks[0].keyframes.map((k) => k.t)`);
  expect(keys).toEqual([0, 1, 2]);
  // Scrubbing drives the sliders.
  await st(page, `e.animActions.scrub(0.5)`);
  const half = await st<number>(page, `e.useEditor.getState().paramValues.ParamAngleX`);
  expect(half).toBeGreaterThan(5);
  expect(half).toBeLessThan(25);

  // Play with realtime physics: time advances and the hair sway parameter moves.
  await page.getByTestId('physics-toggle').check();
  await page.getByTestId('anim-play').click();
  // Track the peak sway during playback (a single sample can land on a zero crossing).
  const sway = await page.evaluate(() => new Promise<number>((res) => {
    const e = (window as any).__l2s;
    let peak = 0;
    const iv = setInterval(() => { peak = Math.max(peak, Math.abs(e.useEditor.getState().model.values.ParamHairFront ?? 0)); }, 16);
    setTimeout(() => { clearInterval(iv); res(peak); }, 1200);
  }));
  expect(sway).toBeGreaterThan(0.05);
  const t = await st<number>(page, `e.useAnim.getState().time`);
  expect(t).toBeGreaterThan(0.3);
  await page.getByTestId('anim-play').click(); // pause
  await page.getByTestId('physics-toggle').uncheck();

  // Bake physics into keys.
  await page.click('text=Bake physics');
  const baked = await st<string[]>(page, `e.useEditor.getState().project.animations[0].tracks.map((t) => t.parameterId).sort()`);
  expect(baked).toEqual(['ParamAngleX', 'ParamHairBack', 'ParamHairFront']);

  // Curve editor: select the 1s key and make it ease-in-out.
  await page.getByTestId('tab-curves').click();
  await st(page, `e.animActions.setCurveTrack('ParamAngleX')`);
  await st(page, `e.animActions.selectKeys([{ parameterId: 'ParamAngleX', t: 0 }])`);
  await page.locator('[data-preset=easeInOut]').click();
  const k0 = await st<{ interp: string; out: number[] }>(page, `e.useEditor.getState().project.animations[0].tracks.find((t) => t.parameterId === 'ParamAngleX').keyframes[0]`);
  expect(k0.interp).toBe('bezier');
  expect(k0.out).toEqual([0.42, 0]);
  await expect(page.getByTestId('curve-svg')).toBeVisible();

  // Export PNG sequence (25% scale to keep it quick).
  await st(page, `e.animActions.openExport(true)`);
  await page.locator('select[aria-label=Scale]').selectOption('0.25');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-run').click()]);
  const zipPath = test.info().outputPath('frames.zip');
  await dl.saveAs(zipPath);
  const files = Object.keys(unzipSync(new Uint8Array(readFileSync(zipPath))));
  expect(files.length).toBe(91); // 3 s × 30 fps + 1
  expect(files[0]).toMatch(/_0000\.png$/);

  // Export WebM.
  await st(page, `e.animActions.openExport(true)`);
  await page.locator('select[aria-label=Format]').selectOption('webm');
  await page.locator('select[aria-label=Scale]').selectOption('0.25');
  const [vid] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('export-run').click()]);
  const vidPath = test.info().outputPath('motion.webm');
  await vid.saveAs(vidPath);
  const head = readFileSync(vidPath).subarray(0, 4);
  expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML / WebM magic

  // Undo-able and persisted.
  await expect(page.getByTestId('save-status')).toHaveText('Saved locally', { timeout: 10_000 });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().project.animations.length === 1);
});
