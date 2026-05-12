// Type guards for messages received from the diagram webview. Webview
// messages cross a trust boundary (postMessage from untrusted DOM) so each
// field is validated before reaching the host-side handlers in panel.ts.

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'pin'; id: string; x: number; y: number; w: number; h: number; traceId?: string; parentRelative: boolean }
  | { type: 'open-anchor'; value: string }
  | { type: 'reset-layout' }
  | { type: 'open-settings' }
  | { type: 'open-help' }
  | { type: 'set-active-model'; name: string }
  | { type: 'diag'; event: unknown };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function parsePanelMessage(raw: unknown, diagMessageType: string): PanelMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'pin':
      if (typeof m.id !== 'string' || !m.id) return undefined;
      if (!isFiniteNumber(m.x) || !isFiniteNumber(m.y)) return undefined;
      if (!isFiniteNumber(m.w) || !isFiniteNumber(m.h)) return undefined;
      return {
        type: 'pin', id: m.id, x: m.x, y: m.y, w: m.w, h: m.h,
        traceId: typeof m.traceId === 'string' ? m.traceId : undefined,
        parentRelative: m.parentRelative === true,
      };
    case 'open-anchor':
      if (typeof m.value !== 'string' || !m.value) return undefined;
      return { type: 'open-anchor', value: m.value };
    case 'reset-layout':
      return { type: 'reset-layout' };
    case 'open-settings':
      return { type: 'open-settings' };
    case 'open-help':
      return { type: 'open-help' };
    case 'set-active-model':
      if (typeof m.name !== 'string' || !m.name) return undefined;
      return { type: 'set-active-model', name: m.name };
    default:
      if (m.type === diagMessageType) return { type: 'diag', event: m.event };
      return undefined;
  }
}
