import { expect, test, type Page } from '@playwright/test';
import { resolve, join, relative } from 'node:path';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync, zipSync } from 'fflate';

const st = <T>(page: Page, expr: string) => page.evaluate(`(() => { const e = window.__l2s; return ${expr}; })()`) as Promise<T>;

async function importSample(page: Page) {
  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().saveStatus === 'saved' && (window as any).__l2s.useEditor.getState().project.rootIds.length > 0);
}

test('Cubism JSON export then import round trip', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools');
  await page.click('text=Auto Rig…');
  await page.getByTestId('rig-apply').click();
  await st(page, `(() => { e.animActions.newClip(); e.editor.setParam('ParamAngleX', 30); e.animActions.scrub(1); e.animActions.keyCurrent(['ParamAngleX']); })()`);
  await page.click('text=Export');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Cubism JSON (physics3 / motion3 / exp3 / cdi3)…')]);
  const zipPath = test.info().outputPath('cubism.zip');
  await dl.saveAs(zipPath);
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const names = Object.keys(files).sort();
  expect(names).toEqual(['README.txt', 'motions/Motion_1.motion3.json', 'sample-character.cdi3.json', 'sample-character.physics3.json']);
  const physics = JSON.parse(strFromU8(files['sample-character.physics3.json']!));
  expect(physics.Meta.PhysicsSettingCount).toBe(2);

  // Re-import into a fresh project: parameters are created, physics and motion arrive intact.
  const dir = test.info().outputPath('json');
  const p1 = join(dir, '..', 'x.physics3.json'), m1 = join(dir, '..', 'Motion_1.motion3.json');
  writeFileSync(p1, files['sample-character.physics3.json']!);
  writeFileSync(m1, files['motions/Motion_1.motion3.json']!);
  await importSample(page);
  await page.click('text=File');
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Import Cubism JSON (motion3 / physics3 / exp3)…')]);
  await ch.setFiles([p1, m1]);
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().project.animations.length === 1);
  const p = await st<{ phys: number; params: string[]; keys: number[][] }>(page, `(() => { const p = e.useEditor.getState().project; return { phys: p.physics.settings.length, params: p.parameters.map((x) => x.id).sort(), keys: p.animations[0].tracks[0].keyframes.map((k) => [k.t, k.v]) }; })()`);
  expect(p.phys).toBe(2);
  // A fresh import already has the default list; physics adds the hair parameters it drives.
  expect(p.params).toEqual(expect.arrayContaining(['ParamAngleX', 'ParamAngleZ', 'ParamHairBack', 'ParamHairFront']));
  // A single key is written as a held segment (motion3 curves can't be one point): 30 from t=1 to the end.
  expect(p.keys).toEqual([[1, 30], [3, 30]]);
});

test('MOC3 preview with a Core test double: loads bundle, renders, masks, motion', async ({ page }) => {
  // Bundle the fixture folder as a zip (as a user would drop a model folder).
  const root = resolve('tests/fixtures/mock-model');
  const z: Record<string, Uint8Array> = {};
  const walk = (d: string) => { for (const f of readdirSync(d)) { const pth = join(d, f); if (statSync(pth).isDirectory()) walk(pth); else z[`Mock/${relative(root, pth)}`] = new Uint8Array(readFileSync(pth)); } };
  walk(root);
  const zipPath = test.info().outputPath('mock-model.zip');
  writeFileSync(zipPath, zipSync(z));

  await page.goto('/?fresh');
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  await page.click('text=Preview MOC3 Model…');
  await page.getByTestId('core-input').setInputFiles(resolve('tests/fixtures/mock-cubism-core.js'));
  await page.waitForFunction(() => (window as any).__l2s.useMoc3.getState().coreVersion === '5.0.0');
  await page.getByTestId('model-input').setInputFiles(zipPath);
  await expect(page.getByTestId('moc3-info')).toContainText('2 drawables (1 masked)');
  await expect(page.getByTestId('moc3-info')).toContainText('moc3 version 4');

  const canvas = page.getByTestId('moc3-canvas');
  const sample = async (cx: number, cy: number) => {
    const box = (await canvas.boundingBox())!;
    // fit(): 400×400 model canvas centred in the view
    const zoom = Math.min((box.width - 64) / 400, (box.height - 64) / 400);
    const x = box.x + (box.width - 400 * zoom) / 2 + cx * zoom, y = box.y + (box.height - 400 * zoom) / 2 + cy * zoom;
    const shot = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ shot, x, y }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + shot; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
    }, { shot, x, y });
  };
  await page.waitForTimeout(300);
  expect(await sample(200, 200)).toEqual([40, 80, 230]); // iris (blue) at the centre
  expect(await sample(150, 150)).toEqual([230, 60, 60]); // face (red)
  // Move the iris right by 100 px: inside the face it shows, outside the face it is masked away.
  await st(page, `e.moc3Actions.setValue('ParamEyeBallX', 1)`);
  await page.waitForTimeout(200);
  expect(await sample(278, 200)).toEqual([40, 80, 230]); // iris now spans 276..324; 276..280 is still inside the face
  const outside = await sample(310, 200);
  expect(outside).not.toEqual([40, 80, 230]); // clipped by the mask
  // Motion from motion3.json drives the parameter.
  await page.click('text=Idle: look');
  await page.waitForTimeout(400);
  expect(await st<string | null>(page, `e.useMoc3.getState().playing`)).toBe('look');
});
