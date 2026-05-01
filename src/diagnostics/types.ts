// Project Viewer — diagnostics types.
//
// Pure types only. No runtime, no IO, no platform deps. Imported by every
// process (extension host, webview) and by every layer (storage, render,
// vscode_extension), so it MUST stay free of side effects.
//
// The recorder is intentionally tiny: emit, ingest, use. Anything richer
// (filtering, sampling, batching) is built as a Sink decorator.

export type DiagScope = 'webview' | 'host' | 'storage' | 'render';

// One entry in the diagnostic log. JSON-serializable so it can survive the
// webview ↔ host postMessage hop and the file write hop without extra
// adapters.
export interface DiagEvent {
  t: number;            // ms epoch — set once, at emit time
  scope: DiagScope;     // which layer emitted it
  stage: string;        // free-form tag, e.g. "drag-start", "elk-input"
  traceId?: string;     // correlates a single user action across layers
  data: unknown;        // opaque payload
}

// Sinks consume events. Anything that writes events to a destination
// (file, IPC channel, OutputChannel, in-memory ring) implements this.
export interface Sink {
  write(e: DiagEvent): void;
  flush?(): Promise<void> | void;
  dispose?(): void;
}

// The recorder fan-outs events to its sinks. It owns no destination of its
// own — purely a multiplexer.
//
// `emit` stamps a fresh timestamp (used by code that originates events).
// `ingest` accepts an already-formed event without restamping (used by the
// host when forwarding events that crossed the postMessage bridge from the
// webview — the original `t` is the truth).
export interface Recorder {
  emit(scope: DiagScope, stage: string, data: unknown, traceId?: string): void;
  ingest(e: DiagEvent): void;
  use(sink: Sink): () => void;  // returns a disposer
}
