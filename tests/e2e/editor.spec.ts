import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const SAMPLE = resolve('samples/sample-character.psd');

type L2S = { useEditor: { getState(): any } };

async function openFile(page: Page, path: string) {
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(path);
}

async function importSample(page: Page) {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await openFile(page, SAMPLE);
  await page.waitForFunction(() => {
    const s = (window as unknown as { __l2s: L2S }).__l2s.useEditor.getState();
    return s.saveStatus === 'saved' && s.project.rootIds.length > 0;
  });
}

const get = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __l2s: L2S }).__l2s.useEditor.getState();
  const byName = (n: string) => Object.values<any>(s.project.nodes).find((x) => x.name === n);
  return {
    selected: s.selection.ids.map((id: string) => s.project.nodes[id].name),
    camera: s.camera,
    nodeCount: Object.keys(s.project.nodes).length,
    mouthParent: s.project.nodes[byName('입_닫힘')?.parentId]?.name,
    faceVisible: byName('얼굴') && Object.values<any>(s.project.nodes).filter((x) => x.name === '얼굴' && x.kind === 'layer')[0].visible,
  };
});

test('imports PSD, keeps structure and selects by pixel', async ({ page }) => {
  await importSample(page);
  await expect(page.locator('[data-node-id]')).toHaveCount(28 - 3); // 몸 group is collapsed (3 children hidden)
  const box = (await page.locator('canvas[data-testid=workspace-canvas]').boundingBox())!;
  const { camera } = await get(page);
  const at = (x: number, y: number) => [box.x + x * camera.zoom + camera.x, box.y + y * camera.zoom + camera.y] as const;
  await page.mouse.click(...at(320, 422));
  expect((await get(page)).selected).toEqual(['홍채_좌']);
  // Alt-click walks down the stack.
  await page.keyboard.down('Alt');
  await page.mouse.click(...at(320, 422));
  await page.keyboard.up('Alt');
  expect((await get(page)).selected).toEqual(['흰자_좌']);
  await page.mouse.click(...at(5, 5));
  expect((await get(page)).selected).toEqual([]);
});

test('undo/redo, tree drag & drop, autosave and restore', async ({ page }) => {
  await importSample(page);
  await page.locator('[data-node-id]').filter({ hasText: /^.*얼굴Face\.Base$/ }).last().click();
  await page.keyboard.press('Control+Comma');
  expect((await get(page)).faceVisible).toBe(false);
  await page.keyboard.press('Control+z');
  expect((await get(page)).faceVisible).toBe(true);

  await page.locator('[data-node-id]').filter({ hasText: '입_닫힘' }).dragTo(
    page.locator('[data-node-id]').filter({ hasText: '앞머리_좌' }), { targetPosition: { x: 60, y: 3 } },
  );
  expect((await get(page)).mouthParent).toBe('앞머리');

  await expect(page.getByTestId('save-status')).toHaveText('Saved locally', { timeout: 10_000 });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __l2s: L2S }).__l2s.useEditor.getState().project.rootIds.length > 0);
  expect((await get(page)).mouthParent).toBe('앞머리');
});

test('exports and re-opens a .l2studio package', async ({ page }, info) => {
  await importSample(page);
  await page.click('text=File');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Export .l2studio Package…')]);
  expect(dl.suggestedFilename()).toBe('sample-character.l2studio');
  const path = info.outputPath('pkg.l2studio');
  await dl.saveAs(path);
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await openFile(page, path);
  await page.waitForFunction(() => (window as unknown as { __l2s: L2S }).__l2s.useEditor.getState().project.rootIds.length > 0);
  expect((await get(page)).nodeCount).toBe(28);
});
