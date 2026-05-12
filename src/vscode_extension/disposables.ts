// little-oxford — small helper that bundles event-listener attachments
// so they can be removed as a group.
//
// Used by webview.ts to make `wireDrag` re-entrant: each render replaces
// the SVG element, but the drag handlers attach to `window` (not the SVG)
// to keep tracking the cursor when it leaves the canvas. Without an
// explicit teardown, every rerender adds a fresh pair of `mousemove` /
// `mouseup` listeners to `window` and the previous pair stays bound —
// they leak forever.

// Loose enough to accept Window, Element, EventTarget, and the Node test
// environment's polyfill alike. The handler shape mirrors the DOM's
// EventListener signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (e: any) => void;
export interface Listener {
  addEventListener(type: string, handler: Handler): void;
  removeEventListener(type: string, handler: Handler): void;
}

export class Disposables {
  private fns: Array<() => void> = [];

  on(target: Listener, type: string, handler: Handler): void {
    target.addEventListener(type, handler);
    this.fns.push(() => target.removeEventListener(type, handler));
  }

  // Idempotent: callers in the webview path may dispose during teardown
  // and again on next attach; we drain the queue on the first call.
  dispose(): void {
    while (this.fns.length) {
      const fn = this.fns.pop()!;
      try {
        fn();
      } catch {
        // never let cleanup throw; one stuck listener must not block the others
      }
    }
  }
}
