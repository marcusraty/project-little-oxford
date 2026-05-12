// Formats an AuditEntry into the compact `WebviewEvent` shape that the
// audit panel webview renders. Two variants:
//   - toWebviewEventSync: pure, no I/O, used when loading historical
//     events from audit.jsonl in a batch.
//   - toWebviewEvent: async, reads the touched file to compute a
//     percentage-of-file line count for Read/Edit events. Used for live
//     incoming events where the file is still around.

import type { AuditEntry } from '../audit/types';

export interface WebviewEvent {
  id: string;
  time: string;
  kind: string;
  badge: string;
  content: string;
  ruleId?: string;
  ruleName?: string;
  sessionId: string;
  lineNumber?: number;
}

export function shortPath(fp: string): string {
  const parts = fp.split('/');
  if (parts.length <= 3) return fp;
  return '.../' + parts.slice(-3).join('/');
}

async function getFileLineCount(filePath: string): Promise<number | null> {
  try {
    const fsp = await import('node:fs/promises');
    const content = await fsp.readFile(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return null;
  }
}

export function toWebviewEventSync(entry: AuditEntry): WebviewEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = entry.content as any;
  let badge = '';
  let content = '';

  switch (entry.kind) {
    case 'text':
    case 'thinking':
      content = c.text ?? '';
      break;
    case 'tool_use': {
      const rawTool = c.tool_name ?? 'tool';
      const input = c.input ?? {};
      let toolName = rawTool;
      if (rawTool === 'Bash') {
        const cmd = (input.command ?? '') as string;
        const first = cmd.trimStart().split(/[\s|&;]/)[0].split('/').pop() ?? '';
        if (first && first !== 'npm' && first !== 'node' && first !== 'npx') toolName = first;
        content = cmd.slice(0, 200);
      } else if (rawTool === 'Read') {
        const fp = shortPath(input.file_path ?? '');
        const limit = input.limit as number | undefined;
        content = `${fp} — ${limit ?? 2000} lines`;
      } else if (rawTool === 'Edit') {
        const fp = shortPath(input.file_path ?? '');
        const oldLines = ((input.old_string ?? '') as string).split('\n').length;
        const newLines = ((input.new_string ?? '') as string).split('\n').length;
        const delta = newLines - oldLines;
        const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';
        content = `${fp} — ${deltaStr} lines`;
      } else if (rawTool === 'Write') {
        const fp = shortPath(input.file_path ?? '');
        const lines = ((input.content ?? '') as string).split('\n').length;
        content = `${fp} — ${lines} lines`;
      } else {
        content = c.touched_paths?.join(', ') || JSON.stringify(input).slice(0, 120);
      }
      badge = toolName;
      break;
    }
    case 'user_prompt':
    case 'system':
      content = c.text ?? '';
      break;
  }

  return {
    id: entry.id,
    time: new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false }),
    kind: entry.kind,
    badge,
    content: content.slice(0, 200),
    sessionId: entry.session_id,
  };
}

export async function toWebviewEvent(entry: AuditEntry): Promise<WebviewEvent> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = entry.content as any;
  let badge = '';
  let content = '';

  switch (entry.kind) {
    case 'text':
    case 'thinking':
      content = c.text ?? '';
      break;
    case 'tool_use': {
      const rawTool = c.tool_name ?? 'tool';
      const input = c.input ?? {};
      let toolName = rawTool;
      if (rawTool === 'Bash') {
        const cmd = (input.command ?? '') as string;
        const first = cmd.trimStart().split(/[\s|&;]/)[0].split('/').pop() ?? '';
        if (first && first !== 'npm' && first !== 'node' && first !== 'npx') toolName = first;
        content = cmd.slice(0, 200);
      } else if (rawTool === 'Read') {
        const fp = shortPath(input.file_path ?? '');
        const fullPath = (input.file_path ?? '') as string;
        const limit = input.limit as number | undefined;
        const linesRead = limit ?? 2000;
        const totalLines = await getFileLineCount(fullPath);
        const pct = totalLines ? Math.min(100, Math.round((linesRead / totalLines) * 100)) : null;
        const pctStr = pct != null ? ` ${pct}%` : '';
        content = `${fp} — ${linesRead} lines${pctStr}`;
      } else if (rawTool === 'Edit') {
        const fp = shortPath(input.file_path ?? '');
        const fullPath = (input.file_path ?? '') as string;
        const old_s = (input.old_string ?? '') as string;
        const new_s = (input.new_string ?? '') as string;
        const oldLines = old_s.split('\n').length;
        const newLines = new_s.split('\n').length;
        const delta = newLines - oldLines;
        const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';
        const totalLines = await getFileLineCount(fullPath);
        const pct = totalLines ? Math.round((Math.max(oldLines, newLines) / totalLines) * 100) : null;
        const pctStr = pct != null ? ` ${pct}%` : '';
        content = `${fp} — ${deltaStr} lines${pctStr}`;
      } else if (rawTool === 'Write') {
        const fp = shortPath(input.file_path ?? '');
        const lines = ((input.content ?? '') as string).split('\n').length;
        content = `${fp} — ${lines} lines`;
      } else {
        content = c.touched_paths?.join(', ') || JSON.stringify(input).slice(0, 120);
      }
      badge = toolName;
      break;
    }
    case 'user_prompt':
    case 'system':
      content = c.text ?? '';
      break;
  }

  return {
    id: entry.id,
    time: new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false }),
    kind: entry.kind,
    badge,
    content: content.slice(0, 200),
    sessionId: entry.session_id,
  };
}

export function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
