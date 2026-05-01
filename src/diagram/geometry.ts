// Project Viewer — pure geometry helpers shared between renderer and webview.
//
// The renderer uses these to lay out edges at SVG-build time. The webview
// re-uses them during drag to recompute the same endpoints / label / badge
// positions live, so edges follow the dragged box instead of disconnecting
// until drop. Single source of truth for the math means the live update
// matches what the next full render would produce — no visible snap when
// the drag finishes.

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Given a ray from (cx, cy) toward (tx, ty), returns the point where it
// first exits the rectangle `box`. Used to land arrowheads exactly on the
// box edge instead of inside it.
//
// Math: parameterize the ray as (cx + t*dx, cy + t*dy) for t ≥ 0. The ray
// exits the box when |t*dx| = box.w/2 or |t*dy| = box.h/2 — whichever
// comes first. We pick the smaller t.
//
// Guards: if both dx and dy are 0 (centers coincide — e.g. a self-loop or
// two boxes pinned at the same point), there's no direction to clip along,
// so we return the source center. If only one of dx/dy is 0, that axis
// can't bound the ray, so we treat its "time to exit" as infinite — the
// other axis decides.
export function clipRayToBox(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  box: BoxRect,
): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const tToXEdge = dx === 0 ? Infinity : Math.abs(box.w / 2 / dx);
  const tToYEdge = dy === 0 ? Infinity : Math.abs(box.h / 2 / dy);
  const scale = Math.min(tToXEdge, tToYEdge);
  return [cx + dx * scale, cy + dy * scale];
}

// Endpoints for a straight edge between two box centers, clipped to land
// on each box's edge (where the arrowhead expects to render).
export function computeEdgeEndpoints(from: BoxRect, to: BoxRect): EdgeEndpoints {
  const ax = from.x + from.w / 2;
  const ay = from.y + from.h / 2;
  const bx = to.x + to.w / 2;
  const by = to.y + to.h / 2;
  const [x1, y1] = clipRayToBox(ax, ay, bx, by, from);
  const [x2, y2] = clipRayToBox(bx, by, ax, ay, to);
  return { x1, y1, x2, y2 };
}

// A point sitting `offset` pixels off to one side of an edge's midpoint —
// used to place the kind label so it sits beside the line, not on it.
// Rotation is 90° clockwise of the edge direction: (dy, -dx)/len.
//
// Zero-length guard: when the two endpoints coincide there's no direction;
// we fall back to placing the label at the midpoint with no offset,
// keeping the result finite.
export function perpendicularLabelPos(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  offset = 12,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  if (len === 0) return { x: mx, y: my };
  return {
    x: mx + (dy / len) * offset,
    y: my + (-dx / len) * offset,
  };
}
