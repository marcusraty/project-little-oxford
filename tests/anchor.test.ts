// Tests for src/vscode_extension/anchor.ts — focused on the path-safety
// invariant.
//
// The bug under test: openAnchor() did `path.join(root, relFile)` with no
// containment check. A model.json anchor of "../../etc/hosts" would resolve
// outside the workspace and the editor would happily open it.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveAnchor } from '../src/vscode_extension/anchor';

const ROOT = path.resolve('/work/repo');

test('resolveAnchor: rejects parent-traversal', () => {
  const r = resolveAnchor(ROOT, '../../../etc/hosts');
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
});

test('resolveAnchor: rejects absolute path outside root', () => {
  const r = resolveAnchor(ROOT, '/etc/hosts');
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
});

test('resolveAnchor: accepts a clean relative path', () => {
  const r = resolveAnchor(ROOT, 'src/extension.ts');
  assert.ok(!('error' in r), `expected ok, got ${JSON.stringify(r)}`);
  const ok = r as { absPath: string; symbol?: string };
  assert.equal(ok.absPath, path.join(ROOT, 'src/extension.ts'));
  assert.equal(ok.symbol, undefined);
});

test('resolveAnchor: separates symbol on first colon', () => {
  const r = resolveAnchor(ROOT, 'src/extension.ts:activate');
  assert.ok(!('error' in r));
  const ok = r as { absPath: string; symbol?: string };
  assert.equal(ok.absPath, path.join(ROOT, 'src/extension.ts'));
  assert.equal(ok.symbol, 'activate');
});

test('resolveAnchor: rejects empty value', () => {
  const r = resolveAnchor(ROOT, '');
  assert.ok('error' in r);
});

test('resolveAnchor: dot-segments that stay inside root are accepted', () => {
  const r = resolveAnchor(ROOT, './src/./extension.ts');
  assert.ok(!('error' in r));
  const ok = r as { absPath: string; symbol?: string };
  assert.equal(ok.absPath, path.join(ROOT, 'src/extension.ts'));
});
