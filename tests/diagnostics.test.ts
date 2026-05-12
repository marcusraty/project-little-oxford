import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DiagEvent, Sink } from '../src/diagnostics/types';
import { installRecorder, uninstallRecorder, recorder } from '../src/diagnostics/recorder';
import { bridgeSink, DIAG_MESSAGE_TYPE } from '../src/diagnostics/sinks/bridge_sink';

// --- Recorder core ---

test('diagnostics: recorder emits events to sinks', () => {
  const real = installRecorder();
  const events: DiagEvent[] = [];
  const sink: Sink = { write(e) { events.push(e); } };
  real.use(sink);

  recorder.emit('host', 'test-action', { foo: 1 }, 'trace-1');

  assert.equal(events.length, 1);
  assert.equal(events[0].scope, 'host');
  assert.equal(events[0].stage, 'test-action');
  assert.equal(events[0].traceId, 'trace-1');
  assert.deepEqual(events[0].data, { foo: 1 });
  assert.equal(typeof events[0].t, 'number');

  uninstallRecorder();
});

test('diagnostics: recorder fans out to multiple sinks', () => {
  const real = installRecorder();
  const a: DiagEvent[] = [];
  const b: DiagEvent[] = [];
  real.use({ write(e) { a.push(e); } });
  real.use({ write(e) { b.push(e); } });

  recorder.emit('host', 'multi', {});

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  uninstallRecorder();
});

test('diagnostics: sink disposal removes it from the fan-out', () => {
  const real = installRecorder();
  const events: DiagEvent[] = [];
  const dispose = real.use({ write(e) { events.push(e); } });

  recorder.emit('host', 'before', {});
  assert.equal(events.length, 1);

  dispose();
  recorder.emit('host', 'after', {});
  assert.equal(events.length, 1, 'no new events after disposal');

  uninstallRecorder();
});

test('diagnostics: broken sink does not crash the recorder', () => {
  const real = installRecorder();
  const events: DiagEvent[] = [];
  real.use({ write() { throw new Error('boom'); } });
  real.use({ write(e) { events.push(e); } });

  recorder.emit('host', 'survives', {});
  assert.equal(events.length, 1, 'second sink still received the event');

  uninstallRecorder();
});

test('diagnostics: ingest preserves original timestamp', () => {
  const real = installRecorder();
  const events: DiagEvent[] = [];
  real.use({ write(e) { events.push(e); } });

  const original: DiagEvent = { t: 12345, scope: 'webview', stage: 'drag', data: {} };
  recorder.ingest(original);

  assert.equal(events[0].t, 12345, 'timestamp not restamped');

  uninstallRecorder();
});

test('diagnostics: noop recorder after uninstall', () => {
  installRecorder();
  uninstallRecorder();

  // Should not throw
  recorder.emit('host', 'noop', {});
  recorder.ingest({ t: 0, scope: 'host', stage: 'noop', data: {} });
});

// --- Bridge sink ---

test('diagnostics: bridge sink wraps event in postMessage format', () => {
  const messages: unknown[] = [];
  const sink = bridgeSink((msg) => messages.push(msg));

  const event: DiagEvent = { t: 100, scope: 'webview', stage: 'click', data: { x: 10 } };
  sink.write(event);

  assert.equal(messages.length, 1);
  const msg = messages[0] as { type: string; event: DiagEvent };
  assert.equal(msg.type, DIAG_MESSAGE_TYPE);
  assert.deepEqual(msg.event, event);
});

// --- Daemon scope ---

test('diagnostics: daemon scope is accepted', () => {
  const real = installRecorder();
  const events: DiagEvent[] = [];
  real.use({ write(e) { events.push(e); } });

  recorder.emit('daemon', 'pin-received', { id: 'box', x: 100 }, 'trace-pin');

  assert.equal(events.length, 1);
  assert.equal(events[0].scope, 'daemon');
  assert.equal(events[0].stage, 'pin-received');

  uninstallRecorder();
});

