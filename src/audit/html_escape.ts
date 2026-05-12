// Shared HTML/attribute escape used by both the host code that builds webview
// HTML and the webview script that interpolates incoming data into innerHTML.
// Five characters covered: & < > " '. Amp first to avoid double-encoding.

const ENTITY: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ENTITY[c]);
}

// In current browsers, the set of characters needing escape in an attribute
// (with quoted values) is the same as the body context. We keep them as
// separate names so callers signal intent and we can tighten attr-context
// rules later without touching call sites.
export const escapeAttr = escapeHtml;
