// Project Viewer — diagnostics public surface.
//
// Universal exports only. Anything importable from BOTH the extension host
// (Node) and the webview (browser) lives here. Sinks that depend on a
// platform are imported directly from their file (e.g. fileSink from
// `./sinks/file_sink` — Node only).

export type { DiagEvent, DiagScope, Recorder, Sink } from './types';
export { recorder, installRecorder, uninstallRecorder, noopRecorder } from './recorder';
export { bridgeSink, DIAG_MESSAGE_TYPE, type DiagBridgeMessage } from './sinks/bridge_sink';
