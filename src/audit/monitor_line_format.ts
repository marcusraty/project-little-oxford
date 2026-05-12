import type { RuleMatch } from './rules';

export function formatMonitorLine(match: RuleMatch): string {
  const kind = match.entry.kind;
  let context: string = kind;
  if (kind === 'tool_use') {
    const toolName = (match.entry.content as { tool_name?: unknown }).tool_name;
    if (typeof toolName === 'string' && toolName.length > 0) {
      context = `tool_use:${toolName}`;
    }
  }
  const message = match.rule.message ?? '';
  const tail = message ? `: ${message}` : '';
  return `[${match.rule.id}] (${context}) ${match.rule.name}${tail}`;
}
