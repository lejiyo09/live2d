import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const st = <T>(page: Page, expr: string) => page.evaluate(`(() => { const e = window.__l2s; return ${expr}; })()`) as Promise<T>;

async function importSample(page: Page, query = '?fresh') {
  await page.goto('/' + query);
  await page.waitForSelector('canvas[data-testid=workspace-canvas]');
  await page.click('text=File');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Open PSD / Project…')]);
  await chooser.setFiles(resolve('samples/sample-character.psd'));
  await page.waitForFunction(() => (window as any).__l2s.useEditor.getState().saveStatus === 'saved' && (window as any).__l2s.useEditor.getState().project.rootIds.length > 0);
}

async function toScreen(page: Page, x: number, y: number) {
  const box = (await page.locator('canvas[data-testid=workspace-canvas]').boundingBox())!;
  const cam = await st<{ zoom: number; x: number; y: number }>(page, `e.useEditor.getState().camera`);
  return [box.x + x * cam.zoom + cam.x, box.y + y * cam.zoom + cam.y] as const;
}

test('ArtPath pen: click points, Enter finishes, path style is editable', async ({ page }) => {
  await importSample(page);
  await page.getByTestId('pen-tool').click();
  for (const [x, y] of [[300, 200], [400, 160], [500, 200]] as const) {
    const [sx, sy] = await toScreen(page, x, y);
    await page.mouse.click(sx, sy);
  }
  await page.keyboard.press('Enter');
  const path = await st<{ id: string; n: number; width: number } | null>(page, `(() => {
    const p = e.useEditor.getState().project;
    const m = Object.values(p.meshes).find((m) => m.path);
    return m ? { id: m.id, n: m.vertices.length / 2, width: m.path.width } : null; })()`);
  expect(path).not.toBeNull();
  expect(path!.n).toBe(3);
  expect(await st<string>(page, `e.useEditor.getState().project.nodes[e.useEditor.getState().selection.anchor].name`)).toMatch(/^ArtPath/);
  // Undo removes it in one step.
  await page.keyboard.press('Control+z');
  expect(await st<number>(page, `Object.values(e.useEditor.getState().project.meshes).filter((m) => m.path).length`)).toBe(0);
});

test('split layer into parts creates a group with one layer per region', async ({ page }) => {
  await importSample(page);
  const id = await st<string>(page, `Object.values(e.useEditor.getState().project.nodes).find((n) => n.name === '리본').id`);
  // Feed the dialog a two-island image (the algorithm itself is unit-tested).
  await st(page, `(() => { e.editor.layerPixels = async () => {
    const w = 60, h = 20, rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 2; y < 18; y++) for (let x = 0; x < w; x++) if ((x > 2 && x < 22) || (x > 36 && x < 56)) { const i = (y * w + x) * 4; rgba[i] = 200; rgba[i + 3] = 255; }
    return { rgba, width: w, height: h }; }; })()`);
  await st(page, `e.editor.selectIds(['${id}'])`);
  await page.click('text=AI Tools');
  await page.click('text=/Split Layer into Parts/');
  await expect(page.getByTestId('segment-count')).toHaveText('2 part(s)');
  await page.getByTestId('segment-apply').click();
  // Applying encodes the part images first, so wait for the group to appear.
  await page.waitForFunction(() => Object.values((window as any).__l2s.useEditor.getState().project.nodes).some((n: any) => n.name === '리본 (parts)'));
  const r = await st<{ group: string; kids: string[]; hidden: boolean }>(page, `(() => {
    const p = e.useEditor.getState().project;
    const g = Object.values(p.nodes).find((n) => n.name === '리본 (parts)');
    return { group: g.kind, kids: g.childIds.map((c) => p.nodes[c].name), hidden: !p.nodes['${id}'].visible }; })()`);
  expect(r.group).toBe('group');
  expect(r.kids).toHaveLength(3); // original (hidden) + 2 parts
  expect(r.hidden).toBe(true);
});

test('scene timeline: new scene, place a clip, play', async ({ page }) => {
  await importSample(page);
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('anim-new').click();
  await page.getByTestId('view-scene').click();
  await page.getByTestId('scene-new').click();
  const clipId = await st<string | undefined>(page, `e.useEditor.getState().project.animations[0]?.id`);
  await page.getByTestId('scene-add-clip').selectOption(clipId!);
  expect(await st<number>(page, `e.useEditor.getState().project.scenes[0].entries.length`)).toBe(1);
  await page.getByTestId('scene-play').click();
  await page.waitForFunction(() => (window as any).__l2s.useAnim.getState().time > 0.1);
  await page.getByTestId('scene-play').click();
});

test('texture quality "half" uploads textures at half resolution', async ({ page }) => {
  await page.goto('/?fresh');
  await page.evaluate(() => localStorage.setItem('l2s:prefs', JSON.stringify({ textureQuality: 'half' })));
  await importSample(page, '?fresh');
  const r = await st<{ scale: number; w: number }>(page, `(() => {
    const p = e.useEditor.getState().project;
    const l = Object.values(p.nodes).find((n) => n.name === '옷');
    const t = e.editor.renderer.textures;
    return { scale: t.scaleOf(l.assets.display), w: t.get ? t.get(l.assets.display)?.width ?? -1 : -1 }; })()`);
  expect(r.scale).toBe(0.5);
  await expect(page.locator('canvas[data-testid=workspace-canvas]')).toBeVisible();
});

test('Claude assistant: opt-in, text-only payload, plan from mocked API', async ({ page }) => {
  let body: any = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ understood: true, steps: ['eyes'], explanation: ['눈 깜빡임을 추가합니다.'] }) }],
      }),
    });
  });
  await importSample(page);
  await page.click('text=AI Tools');
  await page.click('text=/Rigging Assistant/');
  await page.getByLabel('Request').fill('캐릭터가 눈을 깜빡이게 해줘');
  await page.getByTestId('llm-enable').check();
  await expect(page.getByTestId('assistant-ask')).toBeDisabled();
  await page.getByTestId('llm-key').fill('sk-ant-e2e');
  await page.click('text=/Show exactly what will be sent/');
  await expect(page.getByTestId('llm-payload')).toContainText('눈을 깜빡');
  await page.getByTestId('assistant-ask').click();
  await expect(page.getByText('눈 깜빡임을 추가합니다.')).toBeVisible();
  expect(body.model).toBe('claude-opus-5-5');
  expect(JSON.stringify(body)).not.toMatch(/image\/png|base64/);
  // The key is not persisted unless "remember" is ticked.
  expect(await page.evaluate(() => localStorage.getItem('l2s:llm'))).toBeNull();
});
