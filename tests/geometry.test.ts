// Tests for src/diagram/geometry.ts — the pure math shared between the
// renderer (SVG-build time) and the webview (live update during drag).
//
// Single source of truth for edge geometry means the in-flight drag visual
// matches what the next full render would produce, so the drop doesn't
// produce a visible snap.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  clipRayToBox,
  computeEdgeEndpoints,
  perpendicularLabelPos,
} from '../src/diagram/geometry';

test('clipRayToBox: horizontal ray right clips at right edge', () => {
  // Box (0,0,100,50), center (50,25), ray towards (200,25). The ray exits
  // through the right edge at x=100, same y.
  const [x, y] = clipRayToBox(50, 25, 200, 25, { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(x, 100);
  assert.equal(y, 25);
});

test('clipRayToBox: horizontal ray left clips at left edge', () => {
  const [x, y] = clipRayToBox(50, 25, -100, 25, { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(x, 0);
  assert.equal(y, 25);
});

test('clipRayToBox: vertical ray down clips at bottom edge', () => {
  const [x, y] = clipRayToBox(50, 25, 50, 200, { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(x, 50);
  assert.equal(y, 50);
});

test('clipRayToBox: zero direction returns source center', () => {
  // Same point on both ends — no direction to clip along; helper must not
  // divide by zero.
  const [x, y] = clipRayToBox(50, 25, 50, 25, { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(x, 50);
  assert.equal(y, 25);
});

test('computeEdgeEndpoints: two horizontally adjacent boxes', () => {
  // a center (50,25), b center (250,25). Ray a→b clips a at right edge
  // (100,25); ray b→a clips b at left edge (200,25).
  const e = computeEdgeEndpoints(
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 200, y: 0, w: 100, h: 50 },
  );
  assert.deepEqual(e, { x1: 100, y1: 25, x2: 200, y2: 25 });
});

test('computeEdgeEndpoints: two vertically stacked boxes', () => {
  // a center (50,25), b center (50,225). Ray a→b clips a at bottom (50,50);
  // ray b→a clips b at top (50,200).
  const e = computeEdgeEndpoints(
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 0, y: 200, w: 100, h: 50 },
  );
  assert.deepEqual(e, { x1: 50, y1: 50, x2: 50, y2: 200 });
});

test('perpendicularLabelPos: horizontal line offsets vertically', () => {
  // Line (0,0)→(100,0). Midpoint (50,0). Perpendicular CW with offset 10
  // lands at (50, -10).
  const pos = perpendicularLabelPos(0, 0, 100, 0, 10);
  assert.deepEqual(pos, { x: 50, y: -10 });
});

test('perpendicularLabelPos: vertical line offsets horizontally', () => {
  // Line (0,0)→(0,100). Midpoint (0,50). Perpendicular CW with offset 10
  // lands at (10, 50).
  const pos = perpendicularLabelPos(0, 0, 0, 100, 10);
  assert.deepEqual(pos, { x: 10, y: 50 });
});

test('perpendicularLabelPos: zero-length line yields finite numbers', () => {
  // Two coincident points — no direction. Must not produce NaN.
  const pos = perpendicularLabelPos(0, 0, 0, 0, 10);
  assert.ok(Number.isFinite(pos.x));
  assert.ok(Number.isFinite(pos.y));
});
