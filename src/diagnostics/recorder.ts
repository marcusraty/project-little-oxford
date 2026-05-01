// Project Viewer — diagnostics recorder.
//
// `recorder` is a stable, exported singleton that consumers import once
// and call into. Internally it delegates to either:
//   - a no-op (default), or
//   - a `RealRecorder` instance attached at activation time.
//
// The proxy indirection serves three purposes:
//   1. Consumers never re-import after activation; they hold one stable
//      reference whose behavior changes when the impl is swapped.
//   2. Avoids relying on live-bound `let` exports, which can be lossy
//      across the boundary between TS source and esbuild bundle outputs
//      (CJS for the host, IIFE for the webview).
//   3. Sink failures are isolated per call so a broken sink can never
//      take down the host or the webview.

import type { DiagEvent, DiagScope, Recorder, Sink } from './types';

const NOOP: Recorder = {
  emit() {},
  ingest() {},
  use() {
    return () => {};
  },
};

class RealRecorder implements Recorder {
  private sinks: Sink[] = [];

  emit(scope: DiagScope, stage: string, data: unknown, traceId?: string): void {
    this.ingest({ t: Date.now(), scope, stage, traceId, data });
  }

  ingest(e: DiagEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.write(e);
      } catch {
        // Diagnostics must never crash the host. Drop the event silently.
      }
    }
  }

  use(sink: Sink): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i >= 0) {
        this.sinks.splice(i, 1);
        sink.dispose?.();
      }
    };
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.flush?.();
      } catch {
        // ignore
      }
    }
  }
}

class RecorderProxy implements Recorder {
  impl: Recorder = NOOP;
  emit(scope: DiagScope, stage: string, data: unknown, traceId?: string): void {
    this.impl.emit(scope, stage, data, traceId);
  }
  ingest(e: DiagEvent): void {
    this.impl.ingest(e);
  }
  use(sink: Sink): () => void {
    return this.impl.use(sink);
  }
}

const proxy = new RecorderProxy();

export const recorder: Recorder = proxy;
export const noopRecorder: Recorder = NOOP;

// Swap in a live recorder. Idempotent — calling twice replaces the impl
// (intended for hot-reload during development).
export function installRecorder(): RealRecorder {
  const real = new RealRecorder();
  proxy.impl = real;
  return real;
}

export function uninstallRecorder(): void {
  proxy.impl = NOOP;
}
