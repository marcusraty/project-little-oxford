import type { AuditEntry, ToolUseContent } from './types';

const BASH_WRITE_PATTERN = /(?:^|[;&|]\s*)(?:sed\s+-i|rm\s|mv\s|cp\s|chmod\s|touch\s|tee\s)|(?:[^2]>|^>)|>>|:\s*>/;

function isBashWrite(command: string): boolean {
  const stripped = command.replace(/\d*>\s*\/dev\/null/g, '');
  return BASH_WRITE_PATTERN.test(stripped);
}

export function routeActivityPaths(entries: AuditEntry[]): {
  readPaths: string[]; readTimestamp: string;
  editPaths: string[]; editTimestamp: string;
} {
  const readPaths: string[] = [];
  const editPaths: string[] = [];
  let readTimestamp = '';
  let editTimestamp = '';

  for (const entry of entries) {
    if (entry.kind !== 'tool_use') continue;
    const tc = entry.content as unknown as ToolUseContent;
    if (!tc.touched_paths?.length) continue;

    let isEdit = tc.tool_name === 'Edit' || tc.tool_name === 'Write';
    if (!isEdit && tc.tool_name === 'Bash' && tc.input) {
      const cmd = (tc.input as Record<string, unknown>).command as string ?? '';
      isEdit = isBashWrite(cmd);
    }

    if (isEdit) {
      editPaths.push(...tc.touched_paths);
      if (entry.timestamp > editTimestamp) editTimestamp = entry.timestamp;
    } else {
      readPaths.push(...tc.touched_paths);
      if (entry.timestamp > readTimestamp) readTimestamp = entry.timestamp;
    }
  }

  return { readPaths, readTimestamp, editPaths, editTimestamp };
}
