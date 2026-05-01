// Project Viewer — JSONL file sink.
//
// Appends each event as a single JSON line. Writes are queued through one
// awaiting promise chain so concurrent emit() calls don't interleave bytes.
// The parent directory is created on first write (mkdir -p) so the sink is
// drop-in: pass a path, it Just Works.
//
// Host-only: imports node:fs / node:path. Don't import this from webview.ts.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DiagEvent, Sink } from '../types';

export function fileSink(filePath: string): Sink {
  let queue: Promise<void> = Promise.resolve();
  let dirEnsured = false;

  const ensureDir = async (): Promise<void> => {
    if (dirEnsured) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    dirEnsured = true;
  };

  return {
    write(e: DiagEvent): void {
      const line = JSON.stringify(e) + '\n';
      queue = queue
        .then(async () => {
          await ensureDir();
          await fs.appendFile(filePath, line, 'utf8');
        })
        .catch(() => {
          // Drop the event silently — never let logging break the app.
        });
    },
    async flush(): Promise<void> {
      await queue.catch(() => {});
    },
  };
}
