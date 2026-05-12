import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDiagram, mutateLayout } from '../src/diagram/storage';
import { renderDiagram } from '../src/diagram/render';


const RAW_FIXTURE = require('./fixtures/pin_flow_model.json');
const { layout: FIXTURE_LAYOUT, ...FIXTURE } = RAW_FIXTURE;

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) { await cleanup(); cleanup = undefined; }
});

async function setup(): Promise<{ root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-chaos-'));
  await fsp.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fsp.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify(FIXTURE, null, 2), 'utf8');
  if (FIXTURE_LAYOUT && Object.keys(FIXTURE_LAYOUT).length > 0) {
    await fsp.writeFile(path.join(root, '.oxford', 'layout.json'), JSON.stringify(FIXTURE_LAYOUT, null, 2), 'utf8');
  }
  cleanup = async () => fsp.rm(root, { recursive: true, force: true });
  return { root };
}

async function pin(root: string, id: string, x: number, y: number, w?: number, h?: number): Promise<void> {
  const diagram = await readDiagram(root);
  const componentIds = diagram ? new Set(Object.keys(diagram.components)) : new Set<string>();
  await mutateLayout(root, (layout) => {
    const components = layout.components ?? {};
    const existing = components[id];
    const rounded = {
      x: Math.round(x), y: Math.round(y),
      w: Math.round(w ?? existing?.w ?? 220),
      h: Math.round(h ?? existing?.h ?? 80),
    };
    const parentId = diagram?.components?.[id]?.parent;
    if (parentId && components[parentId]) {
      rounded.x -= components[parentId].x;
      rounded.y -= components[parentId].y;
    }
    components[id] = rounded;
    layout.components = components;
  }, componentIds);
}

async function render(root: string): Promise<{ svg: string }> {
  const diagram = await readDiagram(root);
  assert.ok(diagram);
  const output = await renderDiagram(diagram);
  await mutateLayout(root, (layout) => {
    const elkRelative = output.layout.components ?? {};
    const saved = layout.components ?? {};
    const merged = { ...elkRelative, ...saved };

    if (diagram) {
      for (const [id, comp] of Object.entries(diagram.components)) {
        if (!comp.parent) continue;
        const parentSaved = saved[comp.parent];
        const parentElk = elkRelative[comp.parent];
        if (parentSaved && parentElk) {
          const dx = parentSaved.x - parentElk.x;
          const dy = parentSaved.y - parentElk.y;
          if ((dx !== 0 || dy !== 0) && elkRelative[id]) {
            merged[id] = { ...elkRelative[id], x: elkRelative[id].x + dx, y: elkRelative[id].y + dy };
          }
        }
      }
    }

    layout.canvasWidth = output.layout.canvasWidth;
    layout.canvasHeight = output.layout.canvasHeight;
    layout.components = merged;
  });
  return { svg: output.svg };
}

function extractRect(svg: string, componentId: string): { x: number; y: number } | null {
  const groupRe = new RegExp(`<g[^>]*data-component-id="${componentId}"[^>]*>([\\s\\S]*?)</g>`);
  const groupMatch = svg.match(groupRe);
  if (!groupMatch) return null;
  const rectRe = /<rect[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"/;
  const m = groupMatch[1].match(rectRe);
  if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  const ellipseRe = /cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*rx="([^"]+)"[^>]*ry="([^"]+)"/;
  const em = groupMatch[1].match(ellipseRe);
  if (em) {
    return { x: parseFloat(em[1]) - parseFloat(em[3]), y: parseFloat(em[2]) - parseFloat(em[4]) };
  }
  return null;
}

// --- Chaos tests ---

test('chaos: 20 rapid small moves on one component', async () => {
  const { root } = await setup();
  let x = 100, y = 100;

  for (let i = 0; i < 20; i++) {
    x += (i % 2 === 0 ? 7 : -3);
    y += (i % 3 === 0 ? 5 : -2);
    await pin(root, 'web_server', x, y);
  }

  const result = await render(root);
  const rect = extractRect(result.svg, 'web_server');
  assert.ok(rect);
  assert.equal(rect.x, x, 'final x matches after 20 moves');
  assert.equal(rect.y, y, 'final y matches after 20 moves');
});

test('chaos: large cross-canvas jump and back', async () => {
  const { root } = await setup();

  await pin(root, 'cache', 0, 0);
  let result = await render(root);
  let rect = extractRect(result.svg, 'cache');
  assert.ok(rect);
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 0);

  await pin(root, 'cache', 5000, 5000);
  result = await render(root);
  rect = extractRect(result.svg, 'cache');
  assert.ok(rect);
  assert.equal(rect.x, 5000);
  assert.equal(rect.y, 5000);

  await pin(root, 'cache', 0, 0);
  result = await render(root);
  rect = extractRect(result.svg, 'cache');
  assert.ok(rect);
  assert.equal(rect.x, 0, 'returned to origin x');
  assert.equal(rect.y, 0, 'returned to origin y');
});

test('chaos: pin child, pin parent, pin child again', async () => {
  const { root } = await setup();

  await pin(root, 'auth_svc', 200, 400);
  let result = await render(root);
  let rect = extractRect(result.svg, 'auth_svc');
  assert.ok(rect);
  assert.equal(rect.x, 200, 'child at 200 after first pin');

  await pin(root, 'backend', 300, 500);
  result = await render(root);

  await pin(root, 'auth_svc', 350, 550);
  result = await render(root);
  rect = extractRect(result.svg, 'auth_svc');
  assert.ok(rect);
  assert.equal(rect.x, 350, 'child at 350 after re-pin over moved parent');
  assert.equal(rect.y, 550, 'child at 550 after re-pin over moved parent');
});

test('chaos: pin every component to random positions', async () => {
  const { root } = await setup();
  const ids = ['web_server', 'api_gateway', 'cache', 'database'];
  const positions: Record<string, { x: number; y: number }> = {};

  for (const id of ids) {
    const x = Math.round(Math.random() * 3000);
    const y = Math.round(Math.random() * 2000);
    positions[id] = { x, y };
    await pin(root, id, x, y);
  }

  const result = await render(root);
  for (const id of ids) {
    const rect = extractRect(result.svg, id);
    assert.ok(rect, `${id} found in SVG`);
    assert.equal(rect.x, positions[id].x, `${id} x matches`);
    assert.equal(rect.y, positions[id].y, `${id} y matches`);
  }
});

test('chaos: 10 round trips between two positions', async () => {
  const { root } = await setup();
  const posA = { x: 100, y: 100 };
  const posB = { x: 800, y: 600 };

  for (let i = 0; i < 10; i++) {
    const target = i % 2 === 0 ? posA : posB;
    await pin(root, 'api_gateway', target.x, target.y);
  }

  const result = await render(root);
  const rect = extractRect(result.svg, 'api_gateway');
  assert.ok(rect);
  assert.equal(rect.x, posB.x, 'ends at posB after even number of trips');
  assert.equal(rect.y, posB.y, 'ends at posB y');
});

test('chaos: concurrent pins on different components', async () => {
  const { root } = await setup();

  await Promise.all([
    pin(root, 'web_server', 50, 50),
    pin(root, 'api_gateway', 300, 50),
    pin(root, 'cache', 550, 50),
    pin(root, 'database', 800, 50),
    pin(root, 'router', 1050, 50),
  ]);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  assert.equal(layout.components.web_server.x, 50, 'web_server persisted');
  assert.equal(layout.components.api_gateway.x, 300, 'api_gateway persisted');
  assert.equal(layout.components.cache.x, 550, 'cache persisted');
  assert.equal(layout.components.database.x, 800, 'database persisted');
  assert.equal(layout.components.router.x, 1050, 'router persisted');
});

test('chaos: pin to negative coordinates', async () => {
  const { root } = await setup();

  await pin(root, 'web_server', -100, -50);
  const result = await render(root);
  const rect = extractRect(result.svg, 'web_server');
  assert.ok(rect);
  assert.equal(rect.x, -100, 'negative x renders');
  assert.equal(rect.y, -50, 'negative y renders');
});

test('chaos: pin parent, verify children shift by same delta', async () => {
  const { root } = await setup();

  let result = await render(root);
  const authBefore = extractRect(result.svg, 'auth_svc');
  const userBefore = extractRect(result.svg, 'user_svc');
  const backendBefore = extractRect(result.svg, 'backend');
  assert.ok(authBefore && userBefore && backendBefore);

  const dx = 100, dy = 50;
  await pin(root, 'backend', backendBefore.x + dx, backendBefore.y + dy);
  result = await render(root);

  const backendAfter = extractRect(result.svg, 'backend');
  const authAfter = extractRect(result.svg, 'auth_svc');
  const userAfter = extractRect(result.svg, 'user_svc');
  assert.ok(authAfter && userAfter && backendAfter);

  assert.equal(authAfter.x - authBefore.x, dx, 'auth_svc x shifted by parent dx');
  assert.equal(authAfter.y - authBefore.y, dy, 'auth_svc y shifted by parent dy');
  assert.equal(userAfter.x - userBefore.x, dx, 'user_svc x shifted by parent dx');
  assert.equal(userAfter.y - userBefore.y, dy, 'user_svc y shifted by parent dy');
});

test('chaos: interleave pins and renders 10 times', async () => {
  const { root } = await setup();

  for (let i = 0; i < 10; i++) {
    const x = 100 + i * 50;
    const y = 100 + i * 30;
    await pin(root, 'web_server', x, y);
    const result = await render(root);
    const rect = extractRect(result.svg, 'web_server');
    assert.ok(rect, `round ${i}: web_server in SVG`);
    assert.equal(rect.x, x, `round ${i}: x=${x}`);
    assert.equal(rect.y, y, `round ${i}: y=${y}`);
  }
});

test('chaos: pin children then move parent, delta preserved', async () => {
  const { root } = await setup();

  await pin(root, 'auth_svc', 150, 350);
  await pin(root, 'user_svc', 400, 350);
  let result = await render(root);

  const authBefore = extractRect(result.svg, 'auth_svc');
  const userBefore = extractRect(result.svg, 'user_svc');
  const backendBefore = extractRect(result.svg, 'backend');
  assert.ok(authBefore && userBefore && backendBefore);

  const dx = 200, dy = 100;
  await pin(root, 'backend', backendBefore.x + dx, backendBefore.y + dy);
  result = await render(root);

  const auth = extractRect(result.svg, 'auth_svc');
  const user = extractRect(result.svg, 'user_svc');
  assert.ok(auth && user);
  assert.equal(auth.x - authBefore.x, dx, 'auth_svc x delta matches parent dx');
  assert.equal(user.x - userBefore.x, dx, 'user_svc x delta matches parent dx');
  assert.equal(auth.y - authBefore.y, dy, 'auth_svc y delta matches parent dy');
  assert.equal(user.y - userBefore.y, dy, 'user_svc y delta matches parent dy');
});
