import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auditSetupSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'audit_setup.ts'),
  'utf8',
);

// The rules-status chip is hidden by default in the HTML and only becomes
// visible when a `rules-reloaded` message arrives. To make it always
// visible (showing the initial rule count from extension activation
// rather than only after a watcher-triggered reload), audit_setup.ts
// must fire notifyRulesReloaded once after the engine is initialised.

test('audit_setup.ts calls notifyRulesReloaded after initial rule load', () => {
  assert.match(auditSetupSource, /auditView\.notifyRulesReloaded\(/);
});

test('audit_setup.ts wires notifyRulesReloaded with the current rule count', () => {
  // The call should reference the rule engine's count, not a magic number.
  assert.match(
    auditSetupSource,
    /notifyRulesReloaded\(\s*(state\.ruleEngine[^)]*getRules\(\)\.length|userRules\.length|[a-zA-Z_]+\.length)/,
  );
});
