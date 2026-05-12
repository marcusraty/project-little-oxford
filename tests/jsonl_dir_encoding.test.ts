import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { encodeWorkspaceForCC } from '../src/audit/workspace_encoding';

test('encodeWorkspaceForCC: POSIX paths replace / with -', () => {
  assert.equal(encodeWorkspaceForCC('/Users/marcus/Desktop/proj'), '-Users-marcus-Desktop-proj');
});

test('encodeWorkspaceForCC: POSIX paths with hyphens in components preserved as-is', () => {
  // Matches CC's actual on-disk encoding — ambiguous but consistent.
  assert.equal(encodeWorkspaceForCC('/Users/me/arch-viewer'), '-Users-me-arch-viewer');
});

test('encodeWorkspaceForCC: Windows paths replace \\ with -', () => {
  assert.equal(encodeWorkspaceForCC('C:\\Users\\marcus\\proj'), 'C:-Users-marcus-proj');
});

test('encodeWorkspaceForCC: mixed separators handled', () => {
  // Some Windows tools emit forward slashes inside Windows paths.
  assert.equal(encodeWorkspaceForCC('C:\\Users/marcus\\proj'), 'C:-Users-marcus-proj');
});
