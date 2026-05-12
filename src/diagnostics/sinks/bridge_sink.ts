// little-oxford — postMessage bridge sink.
//
// Used inside the webview. Wraps each event in `{ type: '__diag', event }`
// and posts it across the iframe boundary to the extension host. The host
// listens for this message type and feeds the payload back into ITS
// recorder via `recorder.ingest(event)` — preserving the original
// timestamp and traceId.
//
// `__diag` is namespaced to avoid colliding with the panel's other message
// types (ready, pin, open-anchor).

import type { DiagEvent, Sink } from '../types';

export const DIAG_MESSAGE_TYPE = '__diag';

export interface DiagBridgeMessage {
  type: typeof DIAG_MESSAGE_TYPE;
  event: DiagEvent;
}

export function bridgeSink(post: (msg: unknown) => void): Sink {
  return {
    write(e: DiagEvent): void {
      const msg: DiagBridgeMessage = { type: DIAG_MESSAGE_TYPE, event: e };
      post(msg);
    },
  };
}
