import type { AuditEntry } from '../audit/types';
import { MAX_AUDIT_EVENTS as MAX_EVENTS, AUDIT_TRUNCATE_LEN as TRUNCATE_LEN } from './constants';
import { escapeHtml } from '../audit/html_escape';

const KIND_ICONS: Record<string, string> = {
  user_prompt: '\u{1F4AC}',
  thinking:    '\u{1F9E0}',
  text:        '\u{1F4DD}',
  tool_use:    '\u{1F527}',
  system:      '\u{2699}\u{FE0F}',
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function summaryText(entry: AuditEntry): string {
  const c = entry.content as Record<string, unknown>;
  switch (entry.kind) {
    case 'user_prompt': return truncate(String(c.text ?? ''), TRUNCATE_LEN);
    case 'thinking':    return truncate(String(c.text ?? ''), TRUNCATE_LEN);
    case 'text':        return truncate(String(c.text ?? ''), TRUNCATE_LEN);
    case 'tool_use': {
      const name = String(c.tool_name ?? '');
      const input = c.input as Record<string, unknown> | undefined;
      const filePath = input?.file_path ?? input?.path ?? input?.command ?? '';
      return `${name}${filePath ? ' — ' + truncate(String(filePath), 80) : ''}`;
    }
    case 'system': return truncate(String(c.text ?? ''), TRUNCATE_LEN);
    default: return entry.kind;
  }
}

export function renderEventRow(entry: AuditEntry): string {
  const icon = KIND_ICONS[entry.kind] ?? '•';
  const time = formatTimestamp(entry.timestamp);
  const summary = escapeHtml(summaryText(entry));

  return `<div class="audit-row" data-kind="${escapeHtml(entry.kind)}">` +
    `<span class="audit-icon">${icon}</span>` +
    `<span class="audit-time">${escapeHtml(time)}</span>` +
    `<span class="audit-summary">${summary}</span>` +
    `</div>`;
}

export class AuditEventList {
  private entries: AuditEntry[] = [];
  private container: HTMLElement | null = null;

  mount(el: HTMLElement): void {
    this.container = el;
    this.render();
  }

  push(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_EVENTS) {
      this.entries = this.entries.slice(-MAX_EVENTS);
    }
    this.appendRow(entry);
  }

  private render(): void {
    if (!this.container) return;
    this.container.innerHTML = this.entries.map(renderEventRow).join('');
    this.scrollToBottom();
  }

  private appendRow(entry: AuditEntry): void {
    if (!this.container) return;
    while (this.container.children.length >= MAX_EVENTS && this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
    this.container.insertAdjacentHTML('beforeend', renderEventRow(entry));
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    if (!this.container) return;
    this.container.scrollTop = this.container.scrollHeight;
  }

  get count(): number {
    return this.entries.length;
  }
}
