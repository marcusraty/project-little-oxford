import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { serializeRulesForScript } from '../src/audit/rule_serialize';

test('serializeRulesForScript: no literal </script> in output even when rule contains it', () => {
  const rules = [
    { id: 'X1', name: '</script><script>alert(1)</script>', kinds: ['text'], action: 'log', severity: 'info' },
  ];
  const out = serializeRulesForScript(rules);
  assert.ok(!out.includes('</script>'), `output must not contain literal </script>: ${out}`);
});

test('serializeRulesForScript: also escapes <!-- and <script>', () => {
  // Defense in depth: <!-- begins HTML comments which can also break out of
  // <script> blocks in some parsers.
  const rules = [
    { id: 'X1', name: '<!--', kinds: ['text'], action: 'log', severity: 'info' },
    { id: 'X2', name: '<script>', kinds: ['text'], action: 'log', severity: 'info' },
  ];
  const out = serializeRulesForScript(rules);
  // The output should still be valid JSON to JSON.parse, but should not
  // contain raw <!-- or <script>.
  assert.ok(!out.includes('<!--'));
  assert.ok(!out.includes('<script>'));
  // It should round-trip after unescaping U+003C back to <
  const parsed = JSON.parse(out.replace(/\\u003c/g, '<'));
  assert.equal(parsed[0].name, '<!--');
  assert.equal(parsed[1].name, '<script>');
});

test('serializeRulesForScript: ordinary rules survive untouched', () => {
  const rules = [
    { id: 'F4', name: 'Shortcut language', kinds: ['text'], pattern: 'just wire', action: 'hook', severity: 'warning' },
  ];
  const out = serializeRulesForScript(rules);
  const parsed = JSON.parse(out);
  assert.equal(parsed[0].id, 'F4');
  assert.equal(parsed[0].pattern, 'just wire');
});
