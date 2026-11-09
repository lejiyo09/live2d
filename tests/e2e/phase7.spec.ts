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

test('mesh edges, triangles and UVs from the mesh tool', async ({ page }) => {
  await importSample(page);
  await page.locator('[data-node-id]').filter({ hasText: /^.*얼굴Face\.Base$/ }).last().click();
  await page.keyboard.press('m');
  await expect(page.getByTestId('mesh-banner')).toBeVisible();
  const id = await st<string>(page, `e.useMesh.getState().editLayerId`);
  const tris0 = await st<number>(page, `e.useEditor.getState().project.meshes['${id}'].triangles.length`);
  // Select the corners of the first triangle and delete it (Shift+Delete).
  await st(page, `e.useMesh.setState({ selectedVertices: e.useEditor.getState().project.meshes['${id}'].triangles.slice(0, 3) })`);
  await page.keyboard.press('Shift+Delete');
  expect(await st<number>(page, `e.useEditor.getState().project.meshes['${id}'].triangles.length`)).toBe(tris0 - 3);
  await page.click('text=/^Restore 1$/');
  expect(await st<number>(page, `e.useEditor.getState().project.meshes['${id}'].triangles.length`)).toBe(tris0);
  // UV mode: dragging moves UVs, not vertices.
  await page.keyboard.press('u');
  await expect(page.getByTestId('uv-mode')).toHaveClass(/primary/);
  const v0 = await st<number[]>(page, `Array.from(e.useEditor.getState().project.meshes['${id}'].vertices.slice(0, 2))`);
  const uv0 = await st<number[]>(page, `Array.from(e.useEditor.getState().project.meshes['${id}'].uvs.slice(0, 2))`);
  const box = (await page.locator('canvas[data-testid=workspace-canvas]').boundingBox())!;
  const cam = await st<{ zoom: number; x: number; y: number }>(page, `e.useEditor.getState().camera`);
  const [sx, sy] = [box.x + v0[0]! * cam.zoom + cam.x, box.y + v0[1]! * cam.zoom + cam.y];
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 20, sy, { steps: 4 }); await page.mouse.up();
  const v1 = await st<number[]>(page, `Array.from(e.useEditor.getState().project.meshes['${id}'].vertices.slice(0, 2))`);
  const uv1 = await st<number[]>(page, `Array.from(e.useEditor.getState().project.meshes['${id}'].uvs.slice(0, 2))`);
  expect(v1).toEqual(v0);
  expect(uv1[0]).toBeLessThan(uv0[0]!);
});

test('blend shape: add, edit with the deform tool, evaluate additively', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools'); await page.click('text=Auto Rig…'); await page.getByTestId('rig-apply').click();
  const mouth = await st<string>(page, `Object.values(e.useEditor.getState().project.deformers).find((d) => d.name === 'Mouth').id`);
  await st(page, `e.editor.selectIds(['${mouth}'])`);
  // A dedicated parameter for the blend shape.
  await st(page, `e.editor.run(e.deformerEngine.addParameter({ id: 'ParamCheekPuff', name: 'Puff', min: 0, max: 1, default: 0 }))`);
  await page.getByTestId('tab-params').click();
  await page.getByTestId('blend-ParamCheekPuff').click();
  expect(await st<number>(page, `e.useEditor.getState().project.deformers['${mouth}'].blendShapes.length`)).toBe(1);
  await st(page, `e.editor.setParam('ParamCheekPuff', 1)`);
  await page.keyboard.press('d');
  await expect(page.getByTestId('deform-key')).toContainText('Blend shape Puff = 1');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Shift+ArrowDown'); // nudge all points 10 px down
  const rest = await st<number[]>(page, `(() => { const s = e.useEditor.getState(); return Array.from(e.deformerEngine.evaluateModel(s.project, {}).deformers.get('${mouth}').points.slice(0, 2)); })()`);
  const both = await st<number[]>(page, `(() => { const s = e.useEditor.getState(); return Array.from(e.deformerEngine.evaluateModel(s.project, { ParamCheekPuff: 1, ParamMouthOpenY: 1 }).deformers.get('${mouth}').points.slice(0, 2)); })()`);
  const openOnly = await st<number[]>(page, `(() => { const s = e.useEditor.getState(); return Array.from(e.deformerEngine.evaluateModel(s.project, { ParamMouthOpenY: 1 }).deformers.get('${mouth}').points.slice(0, 2)); })()`);
  // The blend shape adds the same 10 px on top of whatever the keyforms produce.
  expect(both[1]! - openOnly[1]!).toBeCloseTo(10, 0);
  expect(openOnly[1]! - rest[1]!).toBeGreaterThanOrEqual(0);
});

test('onion skin, grid and shortcut rebinding', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools'); await page.click('text=Auto Rig…'); await page.getByTestId('rig-apply').click();
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('anim-new').click();
  await st(page, `(() => { e.animActions.scrub(0); e.editor.setParam('ParamAngleX', -30); e.animActions.keyCurrent(['ParamAngleX']); e.animActions.scrub(2); e.editor.setParam('ParamAngleX', 30); e.animActions.keyCurrent(['ParamAngleX']); e.animActions.scrub(1); })()`);
  await page.getByTestId('onion').check();
  expect(await st<boolean>(page, `e.useAnim.getState().onion`)).toBe(true);
  await page.click('text=View'); await page.click('text=Grid 32 px');
  expect(await st<number>(page, `e.useEditor.getState().grid`)).toBe(32);

  // Rebind "Deform tool" from D to J.
  await page.click('text=Settings'); await page.click('text=Preferences…');
  await page.locator('[data-shortcut=deform]').click();
  await page.keyboard.press('j');
  await expect(page.locator('[data-shortcut=deform]')).toHaveText('J');
  await page.click('text=Done');
  await page.keyboard.press('j');
  expect(await st<string>(page, `e.useMesh.getState().mode`)).toBe('deform');
  await page.keyboard.press('Escape');
  // Persisted across reloads.
  await page.reload();
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=Settings'); await page.click('text=Preferences…');
  await expect(page.locator('[data-shortcut=deform]')).toHaveText('J');
  await page.click('text=Reset all shortcuts');
  await expect(page.locator('[data-shortcut=deform]')).toHaveText('D');
});

test('bezier warp editing, draw-order keyforms, split view and canvas resize', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools'); await page.click('text=Auto Rig…'); await page.getByTestId('rig-apply').click();
  const face = await st<string>(page, `Object.values(e.useEditor.getState().project.deformers).find((d) => d.name === 'Face XY').id`);
  await st(page, `e.editor.selectIds(['${face}'])`);
  await st(page, `e.editor.setParams({ ParamAngleX: 30, ParamAngleY: 0 })`);
  await page.keyboard.press('d');
  await page.getByTestId('bezier-toggle').click();
  const before = await st<number[]>(page, `Array.from(e.useEditor.getState().model.deformers.get('${face}').points)`);
  // Select an inner handle (index 5 of the 4×4 net) and nudge it 10 px right.
  await st(page, `e.useRig.setState({ deformSelected: [5] })`);
  await page.keyboard.press('Shift+ArrowRight');
  const after = await st<number[]>(page, `Array.from(e.useEditor.getState().model.deformers.get('${face}').points)`);
  const moved = after.map((v, i) => v - before[i]!).filter((d, i) => i % 2 === 0);
  expect(moved[0]).toBeCloseTo(0, 6); // corner untouched
  expect(Math.max(...moved)).toBeGreaterThan(0.5); // interior moved smoothly…
  expect(Math.max(...moved)).toBeLessThan(10); // …but less than the handle itself
  expect(moved.filter((d) => d > 0.01).length).toBeGreaterThan(4);
  await page.keyboard.press('Escape');

  // Draw order keyform: the closed mouth goes above the open mouth at MouthOpenY = 1.
  const mc = await st<string>(page, `Object.values(e.useEditor.getState().project.nodes).find((n) => n.name === '입_닫힘').id`);
  await st(page, `(() => { const p = e.useEditor.getState().project; const m = p.meshes['${mc}']; const i = m.form.bindings[0].keys.indexOf(1); e.editor.run(e.deformerEngine.setMeshKeyform('${mc}', i, { drawOrder: 1000 })); })()`);
  const order = await st<number>(page, `e.deformerEngine.evaluateModel(e.useEditor.getState().project, { ParamMouthOpenY: 1 }).meshes.get('${mc}').drawOrder`);
  expect(order).toBe(1000);

  // Split view shows a second canvas; the main canvas shrinks to half and follows the panel size.
  const w0 = (await page.locator('canvas[data-testid=workspace-canvas]').first().boundingBox())!.width;
  await page.click('text=View'); await page.click('text=Split View (compare default pose)');
  await expect(page.getByTestId('split-view')).toBeVisible();
  await page.waitForTimeout(400);
  const canvases = page.locator('canvas[data-testid=workspace-canvas]');
  await expect(canvases).toHaveCount(2);
  const w1 = (await canvases.first().boundingBox())!.width;
  expect(w1).toBeLessThan(w0 * 0.6);
});

test('expressions (parameter presets) and parameter groups', async ({ page }) => {
  await importSample(page);
  await page.click('text=AI Tools'); await page.click('text=Auto Rig…'); await page.getByTestId('rig-apply').click();
  await page.getByTestId('tab-params').click();
  // Smile = mouth form + half-closed eyes, captured from current values.
  await st(page, `e.editor.setParams({ ParamMouthForm: 1, ParamEyeLOpen: 0.6, ParamEyeROpen: 0.6 })`);
  page.once('dialog', (d) => d.accept('Smile'));
  await page.getByTestId('expr-save').click();
  const ex = await st<{ name: string; parameters: Array<{ parameterId: string; value: number; blend: string }> }>(page, `e.useEditor.getState().project.expressions[0]`);
  expect(ex.name).toBe('Smile');
  expect(ex.parameters.map((p) => p.parameterId).sort()).toEqual(['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm']);
  // Values were reset; previewing applies the expression on top.
  expect(await st<number>(page, `e.useEditor.getState().model.values.ParamMouthForm`)).toBe(0);
  await page.locator('[data-expr=Smile]').click();
  expect(await st<number>(page, `e.useEditor.getState().model.values.ParamMouthForm`)).toBeCloseTo(1);
  expect(await st<number>(page, `e.useEditor.getState().model.values.ParamEyeLOpen`)).toBeCloseTo(0.6);
  // Switch one entry to Overwrite.
  await page.locator('select[aria-label="Blend of ParamMouthForm"]').selectOption('Overwrite');
  await page.locator('input[aria-label="Value of ParamMouthForm"]').fill('-1');
  expect(await st<number>(page, `e.useEditor.getState().model.values.ParamMouthForm`)).toBeCloseTo(-1);
  await page.locator('[data-expr=Smile]').click(); // preview off

  // Parameter groups.
  page.once('dialog', (d) => d.accept('Face'));
  await page.getByTestId('group-new').click();
  const gid = await st<string>(page, `e.useEditor.getState().project.parameterGroups.find((g) => g.name === 'Face').id`);
  await page.locator('select[aria-label="Group of ParamAngleX"]').selectOption(gid);
  await expect(page.locator(`[data-group="${gid}"] [data-param=ParamAngleX]`)).toBeVisible();

  // Exported in the Cubism JSON bundle.
  await page.click('text=Export');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Cubism JSON (physics3 / motion3 / exp3 / cdi3)…')]);
  const path = test.info().outputPath('bundle.zip');
  await dl.saveAs(path);
  const { unzipSync, strFromU8 } = await import('fflate');
  const { readFileSync } = await import('node:fs');
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  expect(Object.keys(files)).toContain('expressions/Smile.exp3.json');
  const cdi = JSON.parse(strFromU8(files['sample-character.cdi3.json']!));
  expect(cdi.ParameterGroups).toContainEqual({ Id: gid, GroupId: '', Name: 'Face' });
  expect(cdi.Parameters.find((p: { Id: string }) => p.Id === 'ParamAngleX').GroupId).toBe(gid);
});
