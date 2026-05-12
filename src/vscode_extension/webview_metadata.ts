// Pure functions that render relationship-metadata into HTML for the
// diagram webview's edge popovers. No DOM dependency — just value → string.
// Lifted out of webview.ts so the bulk of that file can stay focused on
// the d3-bound drag / pan / zoom / tooltip orchestration.

import { escapeHtml } from '../audit/html_escape';

export function renderMetadataValue(v: unknown): string {
  if (typeof v === 'string') return escapeHtml(v);
  if (Array.isArray(v)) {
    const allShort = v.every((item) => String(item).length < 30);
    if (allShort) return v.map((item) => escapeHtml(String(item))).join(', ');
    return v
      .map((item) => `<div style="padding:1px 0">${escapeHtml(String(item))}</div>`)
      .join('');
  }
  if (v && typeof v === 'object') return renderMetadataTable(v as Record<string, unknown>, true);
  return escapeHtml(String(v));
}

export function renderMetadataTable(metadata: Record<string, unknown>, nested = false): string {
  const tdKeyStyle = nested
    ? 'vertical-align:top;padding:1px 8px 1px 0;color:#64748b;white-space:nowrap;font-size:10px;font-weight:600;letter-spacing:0.3px'
    : 'vertical-align:top;padding:2px 10px 2px 0;color:#64748b;white-space:nowrap;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px';
  const tdValStyle = nested
    ? 'vertical-align:top;padding:1px 0;color:#94a3b8'
    : 'vertical-align:top;padding:2px 0;color:#cbd5e1';
  const rows = Object.entries(metadata)
    .map(
      ([k, v]) =>
        `<tr><td style="${tdKeyStyle}">${escapeHtml(k)}</td><td style="${tdValStyle}">${renderMetadataValue(v)}</td></tr>`,
    )
    .join('');
  const margin = nested ? '2px 0 2px 0' : '8px 0 0 0';
  const border = nested ? 'border-left:2px solid #334155;padding-left:8px' : '';
  const wrapper = nested ? `style="margin:${margin};${border}"` : `style="margin:${margin}"`;
  return `<div ${wrapper}><table style="font-size:11px;border-collapse:collapse;width:100%">${rows}</table></div>`;
}
