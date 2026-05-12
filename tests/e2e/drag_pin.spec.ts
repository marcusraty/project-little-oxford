import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixture_render.json'), 'utf8'),
);

test.beforeEach(async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'harness.html')}`);
  await page.waitForFunction(() => (window as any).__messages?.length > 0);
});

async function postSvg(page: any) {
  await page.evaluate((f: any) => {
    (window as any).__postToWebview({
      type: 'svg',
      svg: f.svg,
      diagram: f.diagram,
      diagnostics: f.diagnostics,
      availableModels: [],
      activeModel: 'model.json',
    });
  }, fixture);
  await page.waitForSelector('#stage svg');
}

function getMessages(page: any): Promise<any[]> {
  return page.evaluate(() => (window as any).__messages);
}

function getPinMessages(page: any): Promise<any[]> {
  return page.evaluate(() =>
    (window as any).__messages.filter((m: any) => m.type === 'pin'),
  );
}

async function getZoom(page: any): Promise<number> {
  const text = await page.locator('#zoom-label').textContent();
  return parseFloat(text ?? '100') / 100;
}

async function getScale(page: any, componentId = 'web_server'): Promise<number> {
  return page.evaluate((id: string) => {
    const g = document.querySelector(`[data-component-id="${id}"]`) as SVGGraphicsElement;
    return g?.getScreenCTM()?.a ?? 1;
  }, componentId);
}

async function getSvgAttr(page: any, componentId: string, attr: string): Promise<number> {
  const val = await page.locator(`[data-component-id="${componentId}"] rect`).first().getAttribute(attr);
  return parseFloat(val ?? '0');
}

async function dragComponent(page: any, componentId: string, screenDx: number, screenDy: number) {
  const group = page.locator(`[data-component-id="${componentId}"]`);
  const box = await group.boundingBox();
  expect(box).toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + screenDx, cy + screenDy, { steps: 5 });
  await page.mouse.up();
}

async function getGroupBBox(page: any, componentId: string) {
  return page.locator(`[data-component-id="${componentId}"]`).boundingBox();
}

// --- Original tests (P1-P14) ---

test('P1: webview loads and sends ready message', async ({ page }) => {
  const msgs = await getMessages(page);
  expect(msgs.some((m: any) => m.type === 'ready')).toBe(true);
});

test('P2: SVG appears after postMessage', async ({ page }) => {
  await postSvg(page);
  const svgExists = await page.locator('#stage svg').count();
  expect(svgExists).toBe(1);
  const emptyHidden = await page.locator('#empty').evaluate((el: HTMLElement) =>
    el.classList.contains('hidden'),
  );
  expect(emptyHidden).toBe(true);
});

test('P3: edit mode activates on button click', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');
  const mode = await page.evaluate(() => document.body.dataset.mode);
  expect(mode).toBe('edit');
});

test('P4: drag top-level component emits pin with correct coordinates', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const initX = await getSvgAttr(page, 'web_server', 'x');
  const initY = await getSvgAttr(page, 'web_server', 'y');
  const scale = await getScale(page, 'web_server');

  const box = await page.locator('[data-component-id="web_server"] rect').first().boundingBox();
  expect(box).toBeTruthy();

  const screenDx = 50;
  const screenDy = 30;
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + screenDx, cy + screenDy, { steps: 5 });
  await page.mouse.up();

  const pins = await getPinMessages(page);
  expect(pins.length).toBeGreaterThanOrEqual(1);
  const pin = pins[pins.length - 1];
  expect(pin.id).toBe('web_server');
  expect(pin.x).toBeCloseTo(initX + screenDx / scale, 0);
  expect(pin.y).toBeCloseTo(initY + screenDy / scale, 0);
  expect(pin.w).toBe(220);
  expect(pin.h).toBe(80);
});

test('P5: sub-threshold drag does not emit pin', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const box = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box).toBeTruthy();

  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  const pinsBefore = await getPinMessages(page);
  const countBefore = pinsBefore.length;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 0.3, cy + 0.3);
  await page.mouse.up();

  const pinsAfter = await getPinMessages(page);
  expect(pinsAfter.length).toBe(countBefore);
});

test('P6: edges update during drag', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const edgePath = page.locator('[data-from="web_server"][data-to="api_gateway"] .pv-edge-line').first();
  const pathBefore = await edgePath.getAttribute('d');
  expect(pathBefore).toBeTruthy();

  const box = await page.locator('[data-component-id="api_gateway"] rect').first().boundingBox();
  expect(box).toBeTruthy();

  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 80, { steps: 5 });

  const pathDuring = await edgePath.getAttribute('d');
  expect(pathDuring).not.toBe(pathBefore);

  await page.mouse.up();
});

test('P7: multiple drags produce separate pin messages', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const box1 = await page.locator('[data-component-id="web_server"] rect').first().boundingBox();
  expect(box1).toBeTruthy();
  await page.mouse.move(box1!.x + box1!.width / 2, box1!.y + box1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box1!.x + box1!.width / 2 + 40, box1!.y + box1!.height / 2 + 40, { steps: 3 });
  await page.mouse.up();

  const box2 = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box2).toBeTruthy();
  await page.mouse.move(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2!.x + box2!.width / 2 + 30, box2!.y + box2!.height / 2 + 30, { steps: 3 });
  await page.mouse.up();

  const pins = await getPinMessages(page);
  expect(pins.length).toBeGreaterThanOrEqual(2);

  const ids = pins.map((p: any) => p.id);
  expect(ids).toContain('web_server');
  expect(ids).toContain('cache');
});

test('P8: pin message includes traceId', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const box = await page.locator('[data-component-id="web_server"] rect').first().boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2 + 50, { steps: 3 });
  await page.mouse.up();

  const pins = await getPinMessages(page);
  expect(pins.length).toBeGreaterThanOrEqual(1);
  expect(typeof pins[pins.length - 1].traceId).toBe('string');
  expect(pins[pins.length - 1].traceId.length).toBeGreaterThan(0);
});

test('P9: drag container child emits pin with PARENT-RELATIVE coordinates', async ({ page }) => {
  // Per the issue #2 fix: nested-component pins are now posted in
  // parent-relative coords (with `parentRelative: true`). Previously they
  // were posted as absolute and the host tried to convert — which broke
  // when the parent wasn't yet pinned.
  await postSvg(page);
  await page.click('#mode-edit');

  // Fixture: backend container at SVG (100, 300), auth_svc at SVG (140, 360)
  // so auth_svc's parent-relative position before drag is (40, 60).
  const initX = await getSvgAttr(page, 'auth_svc', 'x');
  const initY = await getSvgAttr(page, 'auth_svc', 'y');
  const parentX = await getSvgAttr(page, 'backend', 'x');
  const parentY = await getSvgAttr(page, 'backend', 'y');
  const scale = await getScale(page, 'auth_svc');

  const box = await page.locator('[data-component-id="auth_svc"] rect').first().boundingBox();
  expect(box).toBeTruthy();

  const screenDx = 60;
  const screenDy = 40;
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + screenDx, cy + screenDy, { steps: 5 });
  await page.mouse.up();

  const pins = await getPinMessages(page);
  const pin = pins.find((p: any) => p.id === 'auth_svc');
  expect(pin).toBeTruthy();
  expect(pin.parentRelative).toBe(true);
  // New absolute = init + drag/scale. Pin coords = new absolute - parent absolute.
  const expectedRelX = (initX - parentX) + screenDx / scale;
  const expectedRelY = (initY - parentY) + screenDy / scale;
  expect(pin.x).toBeCloseTo(expectedRelX, 0);
  expect(pin.y).toBeCloseTo(expectedRelY, 0);
  expect(pin.w).toBe(220);
  expect(pin.h).toBe(80);
});

test('P10: zoom factor divides out of drag delta', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const initX = parseFloat(await page.locator('[data-component-id="cache"] rect').first().getAttribute('x') ?? '0');
  const screenDrag = 80;

  await page.evaluate(() => { (window as any).__messages = []; });
  const box1 = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box1).toBeTruthy();
  await page.mouse.move(box1!.x + box1!.width / 2, box1!.y + box1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box1!.x + box1!.width / 2 + screenDrag, box1!.y + box1!.height / 2, { steps: 5 });
  await page.mouse.up();

  const pins1 = await getPinMessages(page);
  expect(pins1.length).toBeGreaterThanOrEqual(1);
  const delta1 = pins1[pins1.length - 1].x - initX;
  expect(delta1).toBeGreaterThan(0);

  await postSvg(page);
  await page.click('#mode-edit');

  const box2 = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box2).toBeTruthy();
  const cx2 = box2!.x + box2!.width / 2;
  const cy2 = box2!.y + box2!.height / 2;

  await page.mouse.move(cx2, cy2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);

  await page.evaluate(() => { (window as any).__messages = []; });

  const box2z = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box2z).toBeTruthy();
  await page.mouse.move(box2z!.x + box2z!.width / 2, box2z!.y + box2z!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2z!.x + box2z!.width / 2 + screenDrag, box2z!.y + box2z!.height / 2, { steps: 5 });
  await page.mouse.up();

  const pins2 = await getPinMessages(page);
  expect(pins2.length).toBeGreaterThanOrEqual(1);
  const delta2 = pins2[pins2.length - 1].x - initX;
  expect(delta2).toBeGreaterThan(0);

  expect(delta2).toBeLessThan(delta1);
});

test('P11: container drag emits pin for the container, not children', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');
  await page.evaluate(() => { (window as any).__messages = []; });

  const container = page.locator('[data-component-id="backend"]');
  const containerBox = await container.boundingBox();
  expect(containerBox).toBeTruthy();

  const cx = containerBox!.x + 20;
  const cy = containerBox!.y + 10;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 40, { steps: 5 });
  await page.mouse.up();

  const pins = await getPinMessages(page);
  const containerPin = pins.find((p: any) => p.id === 'backend');
  expect(containerPin).toBeTruthy();
  const childPins = pins.filter((p: any) => p.id === 'auth_svc' || p.id === 'user_svc');
  expect(childPins.length).toBe(0);
});

test('P12: reset-layout button posts reset-layout message', async ({ page }) => {
  await postSvg(page);

  const resetBtn = page.locator('#reset-button');
  await expect(resetBtn).toBeVisible();

  await resetBtn.click();

  const modal = page.locator('#modal-backdrop');
  await expect(modal).not.toHaveClass(/hidden/);

  await page.click('#modal-ok');

  const msgs = await getMessages(page);
  const resetMsg = msgs.find((m: any) => m.type === 'reset-layout');
  expect(resetMsg).toBeTruthy();
});

test('P13: model picker posts set-active-model message', async ({ page }) => {
  await page.evaluate((f: any) => {
    (window as any).__postToWebview({
      type: 'svg',
      svg: f.svg,
      diagram: f.diagram,
      diagnostics: f.diagnostics,
      availableModels: ['model.json', 'sequence.json', 'future_model.json'],
      activeModel: 'model.json',
    });
  }, fixture);
  await page.waitForSelector('#stage svg');

  const picker = page.locator('#model-picker');
  await expect(picker).toBeVisible();

  await picker.selectOption('sequence.json');

  const msgs = await getMessages(page);
  const switchMsg = msgs.find((m: any) => m.type === 'set-active-model');
  expect(switchMsg).toBeTruthy();
  expect(switchMsg.name).toBe('sequence.json');
});

test('P14: drag after panning produces correct SVG coordinates', async ({ page }) => {
  await postSvg(page);
  await page.click('#mode-edit');

  const initX = await getSvgAttr(page, 'cache', 'x');
  const initY = await getSvgAttr(page, 'cache', 'y');
  const zoom = await getZoom(page);
  const screenDx = 60;
  const screenDy = 40;

  await page.evaluate(() => { (window as any).__messages = []; });
  const box1 = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box1).toBeTruthy();
  await page.mouse.move(box1!.x + box1!.width / 2, box1!.y + box1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box1!.x + box1!.width / 2 + screenDx, box1!.y + box1!.height / 2 + screenDy, { steps: 5 });
  await page.mouse.up();
  const pins1 = await getPinMessages(page);
  expect(pins1.length).toBeGreaterThanOrEqual(1);
  const baselineDx = pins1[pins1.length - 1].x - initX;
  const baselineDy = pins1[pins1.length - 1].y - initY;

  await postSvg(page);

  await page.click('#mode-pan');
  const stage = page.locator('#stage');
  const stageBox = await stage.boundingBox();
  expect(stageBox).toBeTruthy();
  await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox!.x + stageBox!.width / 2 - 150, stageBox!.y + stageBox!.height / 2 - 100, { steps: 5 });
  await page.mouse.up();

  await page.click('#mode-edit');
  await page.evaluate(() => { (window as any).__messages = []; });
  const box2 = await page.locator('[data-component-id="cache"] rect').first().boundingBox();
  expect(box2).toBeTruthy();
  await page.mouse.move(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2!.x + box2!.width / 2 + screenDx, box2!.y + box2!.height / 2 + screenDy, { steps: 5 });
  await page.mouse.up();
  const pins2 = await getPinMessages(page);
  expect(pins2.length).toBeGreaterThanOrEqual(1);
  const pannedDx = pins2[pins2.length - 1].x - initX;
  const pannedDy = pins2[pins2.length - 1].y - initY;

  expect(pannedDx).toBeCloseTo(baselineDx, 0);
  expect(pannedDy).toBeCloseTo(baselineDy, 0);
});

// --- Chaos tests ---

test.describe('chaos', () => {

  test('C1: cylinder stays intact after drag — ellipses and path move together', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const group = page.locator('[data-component-id="database"]');
    const boxBefore = await group.boundingBox();
    expect(boxBefore).toBeTruthy();

    await dragComponent(page, 'database', 80, 60);

    const boxAfter = await group.boundingBox();
    expect(boxAfter).toBeTruthy();

    const ellipses = group.locator('ellipse');
    const ellipseCount = await ellipses.count();
    expect(ellipseCount).toBe(2);

    const cx1 = parseFloat(await ellipses.nth(0).getAttribute('cx') ?? '0');
    const cx2 = parseFloat(await ellipses.nth(1).getAttribute('cx') ?? '0');
    expect(cx1).toBeCloseTo(cx2, 0);

    expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThan(8);
    expect(Math.abs(boxAfter!.height - boxBefore!.height)).toBeLessThan(8);
  });

  test('C2: text label stays centered in box after drag', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    await dragComponent(page, 'web_server', 100, 70);

    const group = page.locator('[data-component-id="web_server"]');
    const groupBox = await group.boundingBox();
    expect(groupBox).toBeTruthy();

    const textEl = group.locator('text');
    const textBox = await textEl.boundingBox();
    expect(textBox).toBeTruthy();

    const groupCx = groupBox!.x + groupBox!.width / 2;
    const groupCy = groupBox!.y + groupBox!.height / 2;
    const textCx = textBox!.x + textBox!.width / 2;
    const textCy = textBox!.y + textBox!.height / 2;

    expect(textCx).toBeCloseTo(groupCx, 0);
    expect(textCy).toBeCloseTo(groupCy, -1);
  });

  test('C3: cylinder text stays centered after drag', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    await dragComponent(page, 'database', 120, -50);

    const group = page.locator('[data-component-id="database"]');
    const groupBox = await group.boundingBox();
    expect(groupBox).toBeTruthy();

    const textEl = group.locator('text');
    const textBox = await textEl.boundingBox();
    expect(textBox).toBeTruthy();

    const groupCx = groupBox!.x + groupBox!.width / 2;
    const textCx = textBox!.x + textBox!.width / 2;

    expect(textCx).toBeCloseTo(groupCx, 0);
  });

  test('C4: 10 rapid drags on one component — final position consistent', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    for (let i = 0; i < 10; i++) {
      const dx = (i % 2 === 0 ? 15 : -10);
      const dy = (i % 3 === 0 ? 10 : -5);
      await dragComponent(page, 'api_gateway', dx, dy);
    }

    const pins = await getPinMessages(page);
    const apiPins = pins.filter((p: any) => p.id === 'api_gateway');
    expect(apiPins.length).toBe(10);

    const group = page.locator('[data-component-id="api_gateway"]');
    const box = await group.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(20);
  });

  test('C5: drag every component once — all emit valid pins', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');
    await page.evaluate(() => { (window as any).__messages = []; });

    const ids = ['web_server', 'api_gateway', 'cache', 'router'];
    for (const id of ids) {
      await dragComponent(page, id, 30, 20);
    }

    const pins = await getPinMessages(page);
    const pinIds = new Set(pins.map((p: any) => p.id));
    for (const id of ids) {
      expect(pinIds.has(id)).toBe(true);
    }

    for (const pin of pins) {
      expect(typeof pin.x).toBe('number');
      expect(typeof pin.y).toBe('number');
      expect(pin.w).toBeGreaterThan(0);
      expect(pin.h).toBeGreaterThan(0);
      expect(Number.isFinite(pin.x)).toBe(true);
      expect(Number.isFinite(pin.y)).toBe(true);
    }
  });

  test('C6: drag child, then drag parent — both emit separate pins', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');
    await page.evaluate(() => { (window as any).__messages = []; });

    await dragComponent(page, 'auth_svc', 40, 30);

    const container = page.locator('[data-component-id="backend"]');
    const containerBox = await container.boundingBox();
    expect(containerBox).toBeTruthy();
    const cx = containerBox!.x + 15;
    const cy = containerBox!.y + 8;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 50, cy + 50, { steps: 5 });
    await page.mouse.up();

    const pins = await getPinMessages(page);
    const childPin = pins.find((p: any) => p.id === 'auth_svc');
    const parentPin = pins.find((p: any) => p.id === 'backend');
    expect(childPin).toBeTruthy();
    expect(parentPin).toBeTruthy();
  });

  test('C7: dragging container visually moves children during drag', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const authBefore = await getGroupBBox(page, 'auth_svc');
    const userBefore = await getGroupBBox(page, 'user_svc');
    expect(authBefore && userBefore).toBeTruthy();

    const container = page.locator('[data-component-id="backend"]');
    const containerBox = await container.boundingBox();
    expect(containerBox).toBeTruthy();

    const screenDx = 80;
    const screenDy = 60;
    const cx = containerBox!.x + 15;
    const cy = containerBox!.y + 8;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + screenDx, cy + screenDy, { steps: 5 });

    const authDuring = await getGroupBBox(page, 'auth_svc');
    const userDuring = await getGroupBBox(page, 'user_svc');
    expect(authDuring && userDuring).toBeTruthy();

    expect(Math.abs((authDuring!.x - authBefore!.x) - screenDx)).toBeLessThan(5);
    expect(Math.abs((authDuring!.y - authBefore!.y) - screenDy)).toBeLessThan(5);
    expect(Math.abs((userDuring!.x - userBefore!.x) - screenDx)).toBeLessThan(5);
    expect(Math.abs((userDuring!.y - userBefore!.y) - screenDy)).toBeLessThan(5);

    await page.mouse.up();
  });

  test('C8: edges connected to children update when dragging container', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const childEdge = page.locator('[data-from="auth_svc"][data-to="database"] .pv-edge-line').first();
    const childEdgeCount = await childEdge.count();
    expect(childEdgeCount).toBe(1);
    const pathBefore = await childEdge.getAttribute('d');
    expect(pathBefore).toBeTruthy();

    const container = page.locator('[data-component-id="backend"]');
    const containerBox = await container.boundingBox();
    expect(containerBox).toBeTruthy();

    const cx = containerBox!.x + 15;
    const cy = containerBox!.y + 8;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 60, { steps: 5 });

    const pathDuring = await childEdge.getAttribute('d');
    expect(pathDuring).not.toBe(pathBefore);

    await page.mouse.up();
  });

  test('C9: large jump — component stays visually intact', async ({ page }) => {

    await postSvg(page);
    await page.click('#mode-edit');

    const groupBefore = await getGroupBBox(page, 'cache');
    expect(groupBefore).toBeTruthy();
    const wBefore = groupBefore!.width;
    const hBefore = groupBefore!.height;

    await dragComponent(page, 'cache', 400, 300);

    const groupAfter = await getGroupBBox(page, 'cache');
    expect(groupAfter).toBeTruthy();
    expect(groupAfter!.width).toBeCloseTo(wBefore, 0);
    expect(groupAfter!.height).toBeCloseTo(hBefore, 0);
  });

  test('C10: drag in negative direction — pin has correct negative delta', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const zoom = await getZoom(page);
    const initX = await getSvgAttr(page, 'api_gateway', 'x');

    await page.evaluate(() => { (window as any).__messages = []; });
    await dragComponent(page, 'api_gateway', -100, -80);

    const pins = await getPinMessages(page);
    const pin = pins.find((p: any) => p.id === 'api_gateway');
    expect(pin).toBeTruthy();
    expect(pin.x).toBeLessThan(initX);
  });

  test('C11: diamond shape stays intact after drag', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const group = page.locator('[data-component-id="router"]');
    const boxBefore = await group.boundingBox();
    expect(boxBefore).toBeTruthy();

    await dragComponent(page, 'router', 60, 40);

    const boxAfter = await group.boundingBox();
    expect(boxAfter).toBeTruthy();
    expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThan(8);
    expect(Math.abs(boxAfter!.height - boxBefore!.height)).toBeLessThan(8);

    const textEl = group.locator('text');
    const textBox = await textEl.boundingBox();
    expect(textBox).toBeTruthy();
    const groupCx = boxAfter!.x + boxAfter!.width / 2;
    const textCx = textBox!.x + textBox!.width / 2;
    expect(Math.abs(textCx - groupCx)).toBeLessThan(8);
  });

  test('C12: cylinder height preserved across 5 drags', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');
    await page.evaluate(() => { (window as any).__messages = []; });

    for (let i = 0; i < 5; i++) {
      await dragComponent(page, 'database', 20, 15);
    }

    const pins = await getPinMessages(page);
    const dbPins = pins.filter((p: any) => p.id === 'database');
    expect(dbPins.length).toBe(5);

    const firstH = dbPins[0].h;
    for (let i = 1; i < dbPins.length; i++) {
      expect(dbPins[i].h).toBeCloseTo(firstH, 1);
    }
  });

  test('C13: component tracks mouse exactly during drag', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const group = page.locator('[data-component-id="web_server"]');
    const boxBefore = await group.boundingBox();
    expect(boxBefore).toBeTruthy();

    const cx = boxBefore!.x + boxBefore!.width / 2;
    const cy = boxBefore!.y + boxBefore!.height / 2;
    const screenDx = 150;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + screenDx, cy, { steps: 10 });

    const boxDuring = await group.boundingBox();
    expect(boxDuring).toBeTruthy();
    const actualScreenDx = boxDuring!.x - boxBefore!.x;
    expect(Math.abs(actualScreenDx - screenDx)).toBeLessThan(3);

    await page.mouse.up();
  });

  // Issue #6 on public repo: editing the diagram resets zoom.
  // Verify that posting a fresh SVG (which is what happens on model edit)
  // preserves the user's current zoom transform.
  test('Z1: rerender after model edit preserves zoom level', async ({ page }) => {
    await postSvg(page);

    // Zoom in via the + button a few times.
    await page.click('#zoom-in');
    await page.click('#zoom-in');
    await page.click('#zoom-in');
    const zoomAfterZoomIn = await getZoom(page);
    expect(zoomAfterZoomIn).toBeGreaterThan(1.2);

    // Simulate model edit → rerender (same SVG content posted again).
    await postSvg(page);

    const zoomAfterRerender = await getZoom(page);
    expect(zoomAfterRerender).toBeCloseTo(zoomAfterZoomIn, 2);
  });

  // The bug behind issue #6 is that the window-resize handler always
  // re-fits the diagram, overriding the user's zoom. Verify the handler
  // preserves zoom on resize.
  test('Z2: resize event does not reset zoom to fit', async ({ page }) => {
    await postSvg(page);

    await page.click('#zoom-in');
    await page.click('#zoom-in');
    const zoomBefore = await getZoom(page);
    expect(zoomBefore).toBeGreaterThan(1.1);

    // Trigger a resize event (the same kind VS Code fires when the audit
    // panel pops up or the editor splits).
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(50);

    const zoomAfter = await getZoom(page);
    expect(zoomAfter).toBeCloseTo(zoomBefore, 2);
  });

  // Issue #2 on public repo: moving a nested component breaks rerender.
  // Root cause: when the parent has no saved layout entry, panel.applyPin
  // could not subtract parent.x/y, so the child's pin was stored as if it
  // were absolute, then re-applied on rerender as parent-relative — putting
  // the child in the wrong place.
  // Fix: webview computes parent-relative coords using the parent's current
  // rendered box and posts them directly, so the host doesn't need to know
  // whether the parent is "saved" yet.
  test('N1: dragging a nested component posts parent-relative coords', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    // Fixture: backend container at SVG x=100; auth_svc inside it at SVG x=140
    // (parent-relative x = 40). After drag of +50 horizontal, parent-relative x
    // should be ~90. If the bug were still present, pin.x would be ~190
    // (absolute SVG coords).
    await page.evaluate(() => { (window as any).__messages = []; });
    await dragComponent(page, 'auth_svc', 50, 30);

    const pins = await getPinMessages(page);
    const pin = pins.find((p: any) => p.id === 'auth_svc');
    expect(pin).toBeTruthy();
    expect(pin.parentRelative).toBe(true);
    // Parent-relative x is ~90 (40 starting + 50 drag). Absolute would be ~190.
    expect(pin.x).toBeLessThan(150);
    expect(pin.x).toBeGreaterThan(50);
  });

  test('C14: two drags on same component without rerender — no double-shift', async ({ page }) => {
    await postSvg(page);
    await page.click('#mode-edit');

    const scale = await getScale(page, 'web_server');
    const initX = await getSvgAttr(page, 'web_server', 'x');
    const screenDx1 = 40;
    const screenDx2 = 30;

    await page.evaluate(() => { (window as any).__messages = []; });
    await dragComponent(page, 'web_server', screenDx1, 0);
    await dragComponent(page, 'web_server', screenDx2, 0);

    const pins = await getPinMessages(page);
    const wsPins = pins.filter((p: any) => p.id === 'web_server');
    expect(wsPins.length).toBe(2);

    const totalExpectedDx = (screenDx1 + screenDx2) / scale;
    const finalX = wsPins[wsPins.length - 1].x;
    expect(finalX).toBeCloseTo(initX + totalExpectedDx, 0);
  });

  test('C15: staleness dot follows the component box after drag', async ({ page }) => {
    // RED: writeBox() in webview.ts updates rect/ellipse/path/text but
    // never touches `.pv-staleness-dot`. So when the box moves, the dot
    // stays at its original (cx, cy) and visually drifts off the
    // component. Reported visually by the user; this test catches it.

    await postSvg(page);
    await page.click('#mode-edit');

    // The fixture doesn't carry staleness activity, so no dot is rendered
    // by the production pipeline. Inject one at the renderer's exact
    // position (top-right of the box, 10px in from the right edge,
    // 10px down from the top) so we're testing the same surface.
    await page.evaluate(() => {
      const g = document.querySelector('[data-component-id="web_server"]') as SVGGElement | null;
      if (!g) throw new Error('web_server group missing');
      const rect = g.querySelector('rect') as SVGRectElement | null;
      if (!rect) throw new Error('web_server rect missing');
      const x = parseFloat(rect.getAttribute('x') || '0');
      const y = parseFloat(rect.getAttribute('y') || '0');
      const w = parseFloat(rect.getAttribute('width') || '0');
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'pv-staleness-dot');
      dot.setAttribute('cx', String(x + w - 10));
      dot.setAttribute('cy', String(y + 10));
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', '#ef4444');
      g.appendChild(dot);
    });

    function offsetFromBoxTopRight() {
      return page.evaluate(() => {
        const g = document.querySelector('[data-component-id="web_server"]') as SVGGElement;
        const rect = g.querySelector('rect') as SVGRectElement;
        const dot = g.querySelector('.pv-staleness-dot') as SVGCircleElement;
        const rx = parseFloat(rect.getAttribute('x') || '0');
        const ry = parseFloat(rect.getAttribute('y') || '0');
        const rw = parseFloat(rect.getAttribute('width') || '0');
        const dx = parseFloat(dot.getAttribute('cx') || '0');
        const dy = parseFloat(dot.getAttribute('cy') || '0');
        return { offsetX: dx - (rx + rw), offsetY: dy - ry };
      });
    }

    const before = await offsetFromBoxTopRight();
    await dragComponent(page, 'web_server', 120, 80);
    const after = await offsetFromBoxTopRight();

    // The dot's offset from the box's top-right corner should be stable
    // across a drag. If writeBox forgets to update the dot, the box moves
    // by (120, 80) screen px / scale and the offset drifts.
    expect(after.offsetX).toBeCloseTo(before.offsetX, 0);
    expect(after.offsetY).toBeCloseTo(before.offsetY, 0);
  });

});
