import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const st = <T>(page: Page, expr: string) => page.evaluate(`(() => { const e = window.__l2s; return ${expr}; })()`) as Promise<T>;

async function importSample(page: Page) {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().saveStatus === 'saved' && (window as any).__l2s.useEditor.getState().project.rootIds.length > 0);
}

test('auto rig: preview with motion, discard, apply, analyzer clean', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools');
  await page.click('text=Recognize Parts…');
  await page.getByTestId('recognize-apply').click();
  await page.click('text=AI Tools');
  await page.click('text=Auto Rig…');
  await expect(page.locator('[data-step=headZ]')).toBeChecked();
  await page.getByTestId('rig-preview').click();
  await expect(page.getByTestId('ai-preview')).toBeVisible();
  expect(await st<number>(page, 'Object.keys(e.useEditor.getState().project.deformers).length')).toBe(9);
  // Demo motion animates parameters.
  await page.waitForTimeout(400);
  expect(Math.abs(await st<number>(page, 'e.useEditor.getState().paramValues.ParamAngleX'))).toBeGreaterThan(0.5);
  await page.getByTestId('ai-discard').click();
  expect(await st<number>(page, 'Object.keys(e.useEditor.getState().project.deformers).length')).toBe(0);
  // Apply for real.
  await page.click('text=AI Tools');
  await page.click('text=Auto Rig…');
  await page.getByTestId('rig-apply').click();
  expect(await st<number>(page, 'Object.keys(e.useEditor.getState().project.deformers).length')).toBe(9);
  await expect(page.getByTestId('analyzer')).toBeVisible();
  expect(await st<number>(page, 'e.useAi.getState().findings.filter((f) => f.severity === "error").length')).toBe(0);
  expect(await st<string>(page, 'e.useEditor.getState().undoLabels.at(-1)')).toBe('AI Auto Rig');
});

test('assistant: spec example request → plan → apply', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools');
  await page.click('text=Rigging Assistant…');
  await page.fill('[aria-label=Request]', '앞머리가 머리 회전에 맞춰 자연스럽게 움직이도록 해줘.');
  await page.getByTestId('assistant-ask').click();
  await expect(page.locator('[data-step=hairFront]')).toBeChecked();
  await expect(page.locator('[data-step=faceXY]')).toBeChecked();
  await expect(page.locator('[data-step=eyes]')).not.toBeChecked();
  await page.getByTestId('rig-apply').click();
  const names = await st<string[]>(page, 'Object.values(e.useEditor.getState().project.deformers).map((d) => d.name).sort()');
  expect(names).toEqual(['Face XY', 'Hair Front']);
  await page.keyboard.press('Control+z');
  expect(await st<number>(page, 'Object.keys(e.useEditor.getState().project.deformers).length')).toBe(0);
});
