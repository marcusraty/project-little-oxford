import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDiagramHarness, generateAuditHarness } from '../scripts/build-harness';

// When tests run, this file is bundled into dist/tests.js, so __dirname is dist/.
// Resolve relative to the project root.
const HARNESS_DIR = join(__dirname, '..', 'tests', 'e2e');

// The Playwright harness files are generated from the same panelBody() /
// buildHtml() that production uses. These tests catch drift: if anyone
// hand-edits the harness, or forgets to run `npm run build:harness`
// after changing the body markup, the test fails with a message that
// points to the regen command.

test('tests/e2e/harness.html matches generateDiagramHarness() output', () => {
  const onDisk = readFileSync(join(HARNESS_DIR, 'harness.html'), 'utf8');
  const fresh = generateDiagramHarness();
  assert.equal(
    onDisk,
    fresh,
    'harness.html is out of date. Run `npm run build:harness` to regenerate.',
  );
});

test('tests/e2e/audit_harness.html matches generateAuditHarness() output', () => {
  const onDisk = readFileSync(join(HARNESS_DIR, 'audit_harness.html'), 'utf8');
  const fresh = generateAuditHarness();
  assert.equal(
    onDisk,
    fresh,
    'audit_harness.html is out of date. Run `npm run build:harness` to regenerate.',
  );
});

test('the diagram harness contains every element ID from panelBody()', () => {
  const onDisk = readFileSync(join(HARNESS_DIR, 'harness.html'), 'utf8');
  // Sanity check beyond strict equality: every id="X" from production
  // must appear in the harness, in case the generator ever post-processes.
  for (const id of ['stage', 'help-button', 'settings-button', 'reset-button', 'session-button', 'model-picker']) {
    assert.match(onDisk, new RegExp(`id="${id}"`), `${id} present in harness.html`);
  }
});

test('the audit harness contains the rules-status and help-link elements', () => {
  const onDisk = readFileSync(join(HARNESS_DIR, 'audit_harness.html'), 'utf8');
  assert.match(onDisk, /id="rules-status"/);
  assert.match(onDisk, /id="help-link"/);
});
