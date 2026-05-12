import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixture_render.json'), 'utf8'),
);

test('visual: diagram renders and is visible', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'harness.html')}`);
  await page.waitForFunction(() => (window as any).__messages?.length > 0);

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

  await page.screenshot({ path: '/tmp/lo-diagram.png', fullPage: true });

  const svg = page.locator('#stage svg');
  expect(await svg.isVisible()).toBe(true);

  const box = await svg.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);
});
