import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const ev = <T>(page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => new Function('a', `const e = window.__l2s; return (${f})(a)`)(a), [fn, arg] as const) as Promise<T>;

test('warp + rotation rig: keys, deform tool drag, interpolation, mirror, undo, persistence', async ({ page }) => {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().saveStatus === 'saved' && (window as any).__l2s.useEditor.getState().project.rootIds.length > 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+M');
  await page.getByTestId('automesh-run').click();
  await page.waitForFunction(() => Object.keys((window as any).__l2s.useEditor.getState().project.meshes).length === 22);
  await page.getByTestId('tab-params').click();
  await page.click('text=Add Standard Parameters');

  const face = await ev<string>(page, `() => Object.values(e.useEditor.getState().project.nodes).find((n) => n.name === '얼굴' && n.kind === 'group').id`);
  await ev(page, `(id) => e.editor.selectIds([id])`, face);
  await page.click('text=Deform');
  await page.click('text=Create Warp Deformer…');
  await page.fill('[aria-label="Deformer name"]', 'Face X');
  await page.getByTestId('deformer-create').click();
  const warp = await ev<string>(page, `() => e.useEditor.getState().selection.ids[0]`);
  await page.locator('[data-param=ParamAngleX]').getByText('3 keys').click();
  await ev(page, `() => e.editor.setParam('ParamAngleX', 30)`);
  await page.keyboard.press('d');
  await expect(page.getByTestId('deform-key')).toContainText('= 30');
  await page.keyboard.press('Control+a');

  const box = (await page.locator('canvas[data-testid=workspace-canvas]').boundingBox())!;
  const before = await ev<number[]>(page, `(id) => Array.from(e.useEditor.getState().model.deformers.get(id).points)`, warp);
  const cam = await ev<{ zoom: number; x: number; y: number }>(page, `() => e.useEditor.getState().camera`);
  const sx = box.x + before[18 * 2]! * cam.zoom + cam.x, sy = box.y + before[18 * 2 + 1]! * cam.zoom + cam.y;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 30 * cam.zoom, sy, { steps: 6 });
  await page.mouse.up();
  const after = await ev<number[]>(page, `(id) => Array.from(e.useEditor.getState().model.deformers.get(id).points)`, warp);
  expect(after[0]! - before[0]!).toBeCloseTo(30, 1);

  // Between keys: interpolated and not editable.
  await ev(page, `() => e.editor.setParam('ParamAngleX', 15)`);
  await expect(page.getByTestId('deform-key')).toContainText('Between keys');
  const mid = await ev<number[]>(page, `(id) => Array.from(e.useEditor.getState().model.deformers.get(id).points)`, warp);
  expect(mid[0]! - before[0]!).toBeCloseTo(15, 1);

  // Mirror onto -30.
  await ev(page, `() => e.editor.setParam('ParamAngleX', -30)`);
  await page.keyboard.press('Escape');
  await page.click('text=Mirror AngleX');
  const m30 = await ev<number[]>(page, `(id) => Array.from(e.useEditor.getState().model.deformers.get(id).points)`, warp);
  expect(m30[0]! - before[0]!).toBeCloseTo(-30, 1);

  // Undo the mirror and the drag.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await ev(page, `() => e.editor.setParam('ParamAngleX', 30)`);
  const undone = await ev<number[]>(page, `(id) => Array.from(e.useEditor.getState().model.deformers.get(id).points)`, warp);
  expect(undone[0]).toBeCloseTo(before[0]!, 3);

  // Deformer tree shows the hierarchy; reload keeps it.
  await page.getByTestId('tab-deformers').click();
  await expect(page.locator(`[data-deformer-id="${warp}"]`)).toContainText('Face X');
  await expect(page.getByTestId('save-status')).toHaveText('Saved locally', { timeout: 10_000 });
  await page.goto('/');
  await page.waitForFunction(() => Object.keys((window as any).__l2s.useEditor.getState().project.deformers).length === 1);
});
