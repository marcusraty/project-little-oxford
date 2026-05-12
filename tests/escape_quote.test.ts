import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { emitSvg, computeLayout } from '../src/diagram/render';
import { renderEventRow } from '../src/ui/components';
import type { Diagram } from '../src/diagram/types';
import type { AuditEntry } from '../src/audit/types';

test("render.esc: single-quote in label is escaped to &#39;", async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: "A'B", parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: { r1: { kind: 'calls', from: 'a', to: 'b' } },
    rules: { component_styles: { service: { symbol: 'rectangle' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  // The label should NOT contain a literal apostrophe — it should be escaped.
  assert.ok(!svg.includes("A'B"), `raw apostrophe must not appear in SVG: ${svg.slice(0, 200)}`);
  assert.ok(svg.includes('A&#39;B'), `expected &#39; escape, got: ${svg.slice(0, 200)}`);
});

test('components.escapeHtml: single-quote in text is escaped', () => {
  const entry: AuditEntry = {
    id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c',
    turn_id: 't', timestamp: '2026-05-11T10:00:00Z', kind: 'text',
    content: { text: "don't" },
  };
  const html = renderEventRow(entry);
  assert.ok(!html.includes("don't"), 'raw apostrophe must not appear in HTML');
  assert.ok(html.includes('don&#39;t'), 'expected &#39; escape');
});
