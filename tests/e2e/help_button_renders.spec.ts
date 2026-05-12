import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The harness is generated from panelBody() / buildHtml() (the same code
// production uses). These tests prove that the help affordances actually
// render in real Chromium AND are reachable by a user (not occluded).
//
// `toBeVisible()` alone is insufficient — Playwright considers an element
// "visible" if it has size and isn't display:none, even when another
// element is painted on top of it. To catch occlusion bugs we either
// click the element (Playwright's actionability check refuses to click
// an obstructed element) or hit-test with document.elementFromPoint.

const diagramFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixture_render.json'), 'utf8'),
);

async function loadDiagramAtRest(page: import('@playwright/test').Page) {
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
  }, diagramFixture);
  await page.waitForSelector('#stage svg');
}

test('diagram: help button is in the DOM and visible', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'harness.html')}`);
  const help = page.locator('#help-button');
  await expect(help).toHaveCount(1);
  await expect(help).toBeVisible();
});

test('diagram: help button shows "Help" text', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'harness.html')}`);
  const help = page.locator('#help-button');
  await expect(help).toContainText(/help/i);
});

test('diagram: help button is the topmost element at its centre (not occluded) — empty diagram', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'harness.html')}`);
  const help = page.locator('#help-button');
  const box = await help.boundingBox();
  if (!box) throw new Error('help-button has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const topId = await page.evaluate(([x, y]: [number, number]) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.id : null;
  }, [cx, cy] as [number, number]);
  expect(topId).toBe('help-button');
});

test('diagram: help button is the topmost element at its centre AFTER the diagram loads', async ({ page }) => {
  await loadDiagramAtRest(page);
  const help = page.locator('#help-button');
  const box = await help.boundingBox();
  if (!box) throw new Error('help-button has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const topId = await page.evaluate(([x, y]: [number, number]) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.id : null;
  }, [cx, cy] as [number, number]);
  expect(topId).toBe('help-button');
});

test('diagram: help button is actionable (Playwright .click() succeeds) after diagram loads', async ({ page }) => {
  await loadDiagramAtRest(page);
  const help = page.locator('#help-button');
  // Default .click() runs Playwright's actionability check:
  // scrolled into view + element is the hit target + not covered.
  // If `mode-toggle` (or anything else) is painted on top, this throws.
  await help.click({ timeout: 2000 });
  // Confirm the click was received by the webview (postMessage captured).
  const messages = await page.evaluate(() => (window as any).__messages);
  expect(messages.some((m: any) => m.type === 'open-help')).toBe(true);
});

test('audit: help-link is in the DOM and visible', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'audit_harness.html')}`);
  const help = page.locator('#help-link');
  await expect(help).toHaveCount(1);
  await expect(help).toBeVisible();
});

test('audit: rules-status chip is in the DOM (hidden until reload)', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'audit_harness.html')}`);
  const chip = page.locator('#rules-status');
  await expect(chip).toHaveCount(1);
  // Starts hidden — no reload event has fired yet.
  await expect(chip).toBeHidden();
});

test('audit: rules-status becomes visible after a rules-reloaded message', async ({ page }) => {
  await page.goto(`file://${path.join(__dirname, 'audit_harness.html')}`);
  await page.evaluate(() => {
    (window as any).__postToAuditView({
      type: 'rules-reloaded',
      timestamp: Date.now(),
      count: 8,
    });
  });
  const chip = page.locator('#rules-status');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/rules/);
  await expect(chip).toContainText(/just reloaded|s ago/);
});
