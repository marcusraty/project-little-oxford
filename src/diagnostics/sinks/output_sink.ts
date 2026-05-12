import type { DiagEvent, Sink } from '../types';

export function outputSink(log: (msg: string) => void): Sink {
  return {
    write(e: DiagEvent): void {
      const ts = new Date(e.t).toLocaleTimeString();
      const trace = e.traceId ? ` [${e.traceId.slice(0, 8)}]` : '';
      const data = e.data && typeof e.data === 'object' && Object.keys(e.data as Record<string, unknown>).length > 0
        ? ' ' + JSON.stringify(e.data)
        : '';
      log(`[${ts}] ${e.scope}/${e.stage}${trace}${data}`);
    },
  };
}
