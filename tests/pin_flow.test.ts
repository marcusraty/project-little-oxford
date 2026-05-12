import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDiagram, mutateLayout, readLayout, writeLayout } from '../src/diagram/storage';
import { renderDiagram } from '../src/diagram/render';
import { readActivity } from '../src/diagram/activity';

const RAW_FIXTURE = require('./fixtures/pin_flow_model.json');
const { layout: FIXTURE_LAYOUT, ...FIXTURE } = RAW_FIXTURE;

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function setup(): Promise<{ root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-pin-'));
  await fsp.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fsp.writeFile(
    path.join(root, '.oxford', 'model.json'),
    JSON.stringify(FIXTURE, null, 2),
    'utf8',
  );
  if (FIXTURE_LAYOUT && Object.keys(FIXTURE_LAYOUT).length > 0) {
    await fsp.writeFile(
      path.join(root, '.oxford', 'layout.json'),
      JSON.stringify(FIXTURE_LAYOUT, null, 2),
      'utf8',
    );
  }

  cleanup = async () => {
    await fsp.rm(root, { recursive: true, force: true });
  };

  return { root };
}

async function pin(root: string, id: string, x: number, y: number, w: number, h: number): Promise<void> {
  const rounded = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  const diagram = await readDiagram(root);
  const componentIds = diagram ? new Set(Object.keys(diagram.components)) : new Set<string>();
  await mutateLayout(root, (layout) => {
    const components = layout.components ?? {};
    const parentId = diagram?.components?.[id]?.parent;
    if (parentId && components[parentId]) {
      const parent = components[parentId];
      rounded.x -= parent.x;
      rounded.y -= parent.y;
    }
    components[id] = rounded;
    layout.components = components;
  }, componentIds);
}

async function render(root: string, filename?: string): Promise<{ svg: string; diagram: unknown; diagnostics: unknown[]; activity: unknown }> {
  const diagram = await readDiagram(root, filename);
  assert.ok(diagram, 'diagram readable');
  const output = await renderDiagram(diagram);
  await mutateLayout(root, (layout) => {
    const elkRelative = output.layout.components ?? {};
    const saved = layout.components ?? {};
    const merged = { ...elkRelative, ...saved };

    if (diagram) {
      const comps = (diagram as { components: Record<string, { parent?: string | null }> }).components;
      for (const [id, comp] of Object.entries(comps)) {
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
  const activity = await readActivity(root);
  return { svg: output.svg, diagram, diagnostics: output.diagnostics, activity };
}

function extractRect(svg: string, componentId: string): { x: number; y: number; w: number; h: number } | null {
  const groupRe = new RegExp(`<g[^>]*data-component-id="${componentId}"[^>]*>([\\s\\S]*?)</g>`);
  const groupMatch = svg.match(groupRe);
  if (!groupMatch) return null;
  const inner = groupMatch[1];

  const rectRe = /x="([^"]+)"[^>]*y="([^"]+)"[^>]*width="([^"]+)"[^>]*height="([^"]+)"/;
  const rectMatch = inner.match(rectRe);
  if (rectMatch) {
    return { x: parseFloat(rectMatch[1]), y: parseFloat(rectMatch[2]), w: parseFloat(rectMatch[3]), h: parseFloat(rectMatch[4]) };
  }

  const ellipseRe = /cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*rx="([^"]+)"/;
  const ellipseMatch = inner.match(ellipseRe);
  if (ellipseMatch) {
    const cx = parseFloat(ellipseMatch[1]);
    const cy = parseFloat(ellipseMatch[2]);
    const rx = parseFloat(ellipseMatch[3]);
    return { x: cx - rx, y: cy - rx, w: rx * 2, h: 0 };
  }

  const pathRe = /d="M([^,]+),([^ ]+)/;
  const pathMatch = inner.match(pathRe);
  if (pathMatch) {
    return { x: parseFloat(pathMatch[1]), y: parseFloat(pathMatch[2]), w: 0, h: 0 };
  }

  return null;
}

function hasDataAttr(svg: string, attr: string, value: string): boolean {
  return svg.includes(`${attr}="${value}"`);
}

// --- Tests ---

test('pin-flow: baseline render has all components at pinned positions', async () => {
  const { root } = await setup();
  const result = await render(root);

  const authRect = extractRect(result.svg, 'auth_svc');
  assert.ok(authRect, 'auth_svc found in SVG');
  assert.equal(authRect.x, 140, 'auth_svc absolute x = backend.x + child.x');
  assert.equal(authRect.y, 360, 'auth_svc absolute y = backend.y + child.y');

  const webRect = extractRect(result.svg, 'web_server');
  assert.ok(webRect);
  assert.equal(webRect.x, 100);
  assert.equal(webRect.y, 100);
});

test('pin-flow: pin top-level component, others unchanged', async () => {
  const { root } = await setup();
  await pin(root, 'web_server', 300, 200, 220, 80);

  const result = await render(root);
  const webRect = extractRect(result.svg, 'web_server');
  assert.ok(webRect);
  assert.equal(webRect.x, 300, 'web_server moved to new x');
  assert.equal(webRect.y, 200, 'web_server moved to new y');

  const apiRect = extractRect(result.svg, 'api_gateway');
  assert.ok(apiRect);
  assert.equal(apiRect.x, 400, 'api_gateway unchanged');
  assert.equal(apiRect.y, 100, 'api_gateway unchanged');
});

test('pin-flow: pin unconnected component, no side effects', async () => {
  const { root } = await setup();
  await pin(root, 'cache', 1200, 500, 220, 80);

  const result = await render(root);
  const cacheRect = extractRect(result.svg, 'cache');
  assert.ok(cacheRect);
  assert.equal(cacheRect.x, 1200);
  assert.equal(cacheRect.y, 500);

  const webRect = extractRect(result.svg, 'web_server');
  assert.ok(webRect);
  assert.equal(webRect.x, 100);
});

test('pin-flow: pin connected component, edges have endpoints', async () => {
  const { root } = await setup();
  await pin(root, 'api_gateway', 500, 200, 220, 80);

  const result = await render(root);
  assert.ok(hasDataAttr(result.svg, 'data-from', 'web_server'), 'edge from web_server exists');
  assert.ok(hasDataAttr(result.svg, 'data-to', 'api_gateway'), 'edge to api_gateway exists');
});

test('pin-flow: pin container child stores parent-relative coords', async () => {
  const { root } = await setup();
  await pin(root, 'auth_svc', 200, 400, 220, 80);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  const stored = layout.components.auth_svc;

  assert.equal(stored.x, 100, 'stored x should be parent-relative: absolute(200) - backend.x(100)');
  assert.equal(stored.y, 100, 'stored y should be parent-relative: absolute(400) - backend.y(300)');

  const result = await render(root);
  const authRect = extractRect(result.svg, 'auth_svc');
  assert.ok(authRect);
  assert.equal(authRect.x, 200, 'renders at absolute x=200');
  assert.equal(authRect.y, 400, 'renders at absolute y=400');
});

test('pin-flow: pin container, children shift with it', async () => {
  const { root } = await setup();

  const before = await render(root);
  const authBefore = extractRect(before.svg, 'auth_svc');
  const userBefore = extractRect(before.svg, 'user_svc');
  assert.ok(authBefore && userBefore);

  await pin(root, 'backend', 150, 400, 500, 250);

  const after = await render(root);
  const authAfter = extractRect(after.svg, 'auth_svc');
  const userAfter = extractRect(after.svg, 'user_svc');
  assert.ok(authAfter && userAfter);

  assert.equal(authAfter.x, authBefore.x + 50, 'auth_svc x shifted by container delta');
  assert.equal(authAfter.y, authBefore.y + 100, 'auth_svc y shifted by container delta');
  assert.equal(userAfter.x, userBefore.x + 50, 'user_svc x shifted by container delta');
  assert.equal(userAfter.y, userBefore.y + 100, 'user_svc y shifted by container delta');
});

test('pin-flow: pin diamond-shaped component', async () => {
  const { root } = await setup();
  await pin(root, 'router', 800, 200, 220, 80);

  const result = await render(root);
  assert.ok(result.svg.includes('data-component-id="router"'), 'router in SVG');
});

test('pin-flow: pin cylinder-shaped component', async () => {
  const { root } = await setup();
  await pin(root, 'database', 900, 500, 220, 80);

  const result = await render(root);
  assert.ok(result.svg.includes('data-component-id="database"'), 'database in SVG');
});

test('pin-flow: multiple sequential pins all persist', async () => {
  const { root } = await setup();

  await pin(root, 'web_server', 50, 50, 220, 80);
  await pin(root, 'api_gateway', 350, 50, 220, 80);
  await pin(root, 'cache', 650, 50, 220, 80);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  assert.deepEqual(layout.components.web_server, { x: 50, y: 50, w: 220, h: 80 });
  assert.deepEqual(layout.components.api_gateway, { x: 350, y: 50, w: 220, h: 80 });
  assert.deepEqual(layout.components.cache, { x: 650, y: 50, w: 220, h: 80 });
});

test('pin-flow: fractional coordinates are rounded', async () => {
  const { root } = await setup();
  await pin(root, 'web_server', 155.7, 99.3, 220, 80);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  assert.deepEqual(layout.components.web_server, { x: 156, y: 99, w: 220, h: 80 });
});

test('pin-flow: SVG has data attributes for all components and edges', async () => {
  const { root } = await setup();
  const result = await render(root);

  for (const id of ['web_server', 'api_gateway', 'backend', 'auth_svc', 'user_svc', 'database', 'router', 'cache']) {
    assert.ok(hasDataAttr(result.svg, 'data-component-id', id), `${id} has data-component-id`);
  }
  assert.ok(hasDataAttr(result.svg, 'data-container', '1'), 'backend has data-container');
  assert.ok(result.svg.includes('data-relationship-group'), 'edges have relationship groups');
  assert.ok(hasDataAttr(result.svg, 'data-from', 'web_server'), 'edge from web_server');
  assert.ok(hasDataAttr(result.svg, 'data-to', 'database'), 'edge to database');
});

test('pin-flow: pin nonexistent component is cleaned up by GC', async () => {
  const { root } = await setup();
  await pin(root, 'does_not_exist', 999, 999, 220, 80);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  assert.equal(layout.components?.does_not_exist, undefined, 'orphan entry cleaned up by GC');

  const result = await render(root);
  assert.ok(result.svg.includes('<svg'), 'SVG is valid');
});

test('pin-flow: pin both children independently, then verify both positions', async () => {
  const { root } = await setup();

  await pin(root, 'auth_svc', 200, 400, 220, 80);
  await pin(root, 'user_svc', 400, 400, 220, 80);

  const layout = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'layout.json'), 'utf8'));
  assert.deepEqual(layout.components.auth_svc, { x: 100, y: 100, w: 220, h: 80 });
  assert.deepEqual(layout.components.user_svc, { x: 300, y: 100, w: 220, h: 80 });

  const result = await render(root);
  const authRect = extractRect(result.svg, 'auth_svc');
  const userRect = extractRect(result.svg, 'user_svc');
  assert.ok(authRect && userRect);
  assert.equal(authRect.x, 200, 'auth_svc renders at absolute x=200');
  assert.equal(userRect.x, 400, 'user_svc renders at absolute x=400');
});

test('pin-flow: concurrent pin and render does not corrupt', async () => {
  const { root } = await setup();

  const [, renderResult] = await Promise.all([
    pin(root, 'web_server', 250, 150, 220, 80),
    render(root),
  ]);
  assert.ok(renderResult);

  const after = await render(root);
  const webRect = extractRect(after.svg, 'web_server');
  assert.ok(webRect);
  assert.equal(webRect.x, 250);
  assert.equal(webRect.y, 150);
});

test('pin-flow: render non-default file merges layout.json', async () => {
  const { root } = await setup();

  const modelContent = await fsp.readFile(path.join(root, '.oxford', 'model.json'), 'utf8');
  await fsp.writeFile(path.join(root, '.oxford', 'alternate.json'), modelContent, 'utf8');

  await pin(root, 'web_server', 700, 300, 220, 80);

  const result = await render(root, 'alternate.json');
  const webRect = extractRect(result.svg, 'web_server');
  assert.ok(webRect, 'web_server found in alternate.json SVG');
  assert.equal(webRect.x, 700, 'pin persists when rendering non-default file');
  assert.equal(webRect.y, 300, 'pin persists when rendering non-default file');
});
