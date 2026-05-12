// Debounce / polling intervals used across the extension.
//
// VS Code's createFileSystemWatcher has a known double-fire bug: a single
// save can trigger onDidChange twice within ~50ms (FSEvents on macOS,
// inotify recursive watch on Linux). All three watchers below mitigate
// this by debouncing — the windows are tuned to be:
//   - longer than the gap between double-fires,
//   - shorter than perceived input latency, so live-update still feels live.

// Model.json watcher → debounced rerender. 150ms.
//   Big enough that two rapid file-save fires collapse to one rerender.
//   Small enough that the user doesn't notice the diagram lagging behind
//   their text edit.
export const MODEL_WATCHER_DEBOUNCE_MS = 150;

// CC JSONL watcher → debounced processSession. 100ms.
//   JSONL appends arrive in bursts when the agent runs a tool. The 100ms
//   window batches those into one read pass. Shorter than the model watcher
//   because the operation downstream (process N more lines) is much
//   cheaper than re-rendering an SVG.
export const JSONL_WATCHER_DEBOUNCE_MS = 100;

// Diagram panel show → debounced rerender. 80ms.
//   When the panel is revealed (Show Diagram command), we debounce the
//   rerender so rapid "show, then immediately show again" sequences don't
//   double-render. 80ms is the smallest of the three because there's no
//   double-fire to mitigate — it's only collapsing user-initiated repeats.
export const PANEL_SHOW_DEBOUNCE_MS = 80;

// Monitor heartbeat poll interval. 3000ms.
//   The monitor script writes the heartbeat every 2s. We poll every 3s
//   so a single missed write still shows "connected" — only two missed
//   writes (≥5s gap) flip to "disconnected".
export const MONITOR_HEARTBEAT_POLL_MS = 3000;
