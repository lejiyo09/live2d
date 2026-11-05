import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

type W = { __l2s: { useEditor: { getState(): any }; useMesh: { getState(): any } } };
const ed = <T>(page: Page, fn: (w: W, arg: any) => T, arg?: unknown) => page.evaluate(([f, a]) => new Function('w', 'a', `return (${f})(w, a)`)(window, a), [fn.toString(), arg] as const) as Promise<T>;

async function importSample(page: Page) {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => {
    const s = (window as unknown as W).__l2s.useEditor.getState();
    return s.saveStatus === 'saved' && s.project.rootIds.length > 0;
  });
}

test('auto-mesh all layers, edit vertices, undo, persist', async ({ page }) => {
  await importSample(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+M');
  await page.getByTestId('automesh-run').click();
  await page.waitForFunction(() => Object.keys((window as unknown as W).__l2s.useEditor.getState().project.meshes).length === 22);
  // Mesh check runs automatically and finds no problems on the sample.
  await expect(page.locator('text=no problems found')).toBeVisible();

  await page.locator('[data-node-id]').filter({ hasText: /^.*얼굴Face\.Base$/ }).last().click();
  await page.keyboard.press('m');
  await expect(page.getByTestId('mesh-banner')).toBeVisible();

  const info = await ed(page, (w) => {
    const s = w.__l2s.useEditor.getState();
    const id = s.selection.ids[0];
    return { id, mesh: s.project.meshes[id], cam: s.camera };
  });
  const box = (await page.locator('canvas[data-testid=workspace-canvas]').boundingBox())!;
  const at = (x: number, y: number) => [box.x + x * info.cam.zoom + info.cam.x, box.y + y * info.cam.zoom + info.cam.y] as const;
  const v0 = info.mesh.boundary[0][0];
  const [vx, vy] = at(info.mesh.vertices[v0 * 2], info.mesh.vertices[v0 * 2 + 1]);

  // Drag a vertex: one merged undo step.
  await page.mouse.move(vx, vy);
  await page.mouse.down();
  await page.mouse.move(vx + 15, vy + 5, { steps: 6 });
  await page.mouse.up();
  const undo = await ed(page, (w) => w.__l2s.useEditor.getState().undoLabels.at(-1));
  expect(undo).toBe('Move Vertices');

  // Alt+click adds a vertex, Delete removes it.
  const n = info.mesh.vertices.length / 2;
  await page.keyboard.down('Alt');
  await page.mouse.click(...at(405, 470));
  await page.keyboard.up('Alt');
  expect(await ed(page, (w, id) => w.__l2s.useEditor.getState().project.meshes[id].vertices.length / 2, info.id)).toBe(n + 1);
  await page.keyboard.press('Delete');
  expect(await ed(page, (w, id) => w.__l2s.useEditor.getState().project.meshes[id].vertices.length / 2, info.id)).toBe(n);

  // Undo everything back to the generated mesh.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  expect(await ed(page, (w, id) => JSON.stringify(w.__l2s.useEditor.getState().project.meshes[id]), info.id)).toBe(JSON.stringify(info.mesh));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mesh-banner')).toHaveCount(0);

  // Meshes survive autosave + reload.
  await expect(page.getByTestId('save-status')).toHaveText('Saved locally', { timeout: 10_000 });
  await page.goto('/');
  await page.waitForFunction(() => Object.keys((window as unknown as W).__l2s.useEditor.getState().project.meshes).length === 22);
});
