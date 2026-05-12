import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const FEED_FILE = '.oxford/.monitor_feed';
const HEARTBEAT_FILE = '.oxford/.monitor_heartbeat';

export const MONITOR_COPY_TEXT = `Use the Monitor tool to stream output from the little-oxford audit monitor.

1. Run \`.oxford/monitor.sh\` in the background (Bash with run_in_background: true).
2. Attach the Monitor tool to that process — each stdout line is a notification.

What it streams: rule matches the VS Code extension's audit engine writes to .oxford/.monitor_feed (behavioral filters F4–F10, companion rules, etc). A heartbeat is written to .oxford/.monitor_heartbeat every 2s so the extension knows the monitor is alive.

Leave it running for the session.

Heads up before you start: each event arrives as a notification in your conversation, so streaming the monitor increases context usage and consumes your LLM subscription's per-message quota faster than a normal session. Worth it during active development when behavioural signals matter; stop the background process when you're done.`;

export async function writeMonitorMessage(root: string, message: string): Promise<void> {
  const fp = path.join(root, FEED_FILE);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.appendFile(fp, message + '\n', 'utf8');
}

export async function readHeartbeat(root: string): Promise<number | null> {
  try {
    const content = await fsp.readFile(path.join(root, HEARTBEAT_FILE), 'utf8');
    const ts = parseInt(content.trim(), 10);
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

export async function isMonitorRunning(root: string): Promise<boolean> {
  const ts = await readHeartbeat(root);
  if (ts === null) return false;
  const now = Math.floor(Date.now() / 1000);
  return (now - ts) < 5;
}
