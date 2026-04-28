/* Screen ↔ world projection + hit-test helpers.
 *
 * The canvas renders shapes/connectors inside a transform group:
 *    <g transform="translate(panX panY) scale(zoom)">…world content…</g>
 *
 * Pointer events arrive in CLIENT coordinates. We translate them through the
 * SVG element's bounding rect to get pixel-relative coords, then unproject to
 * world coords with the inverse transform. Keep both sides pure — Canvas owns
 * pan/zoom and just hands them in.
 */

import type { Connector, LabelAnchor, Shape } from '@/store/types';

export type Pt = { x: number; y: number };
export type ViewportTransform = { pan: Pt; zoom: number };

export function clientToScreen(
  e: { clientX: number; clientY: number },
  rect: DOMRect,
): Pt {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function screenToWorld(p: Pt, t: ViewportTransform): Pt {
  return { x: (p.x - t.pan.x) / t.zoom, y: (p.y - t.pan.y) / t.zoom };
}

export function worldToScreen(p: Pt, t: ViewportTransform): Pt {
  return { x: p.x * t.zoom + t.pan.x, y: p.y * t.zoom + t.pan.y };
}

/** Quantize the angle of the vector `from → to` to the nearest multiple of
 *  `stepDeg`, preserving its length. Used by the line/arrow tools when the
 *  user holds cmd/ctrl: the cursor's distance from the start is kept, but the
 *  bearing is locked onto a 5°/15°/45° grid so axis-aligned and isometric
 *  lines come out exactly straight. Returns `to` unchanged if the vector has
 *  zero length (would otherwise produce NaN from atan2). */
export function snapPointToAngle(from: Pt, to: Pt, stepDeg: number): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return to;
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: from.x + dist * Math.cos(snapped),
    y: from.y + dist * Math.sin(snapped),
  };
}

/** Axis-aligned bounding-box for a shape. Notes/diamonds/ellipses all share
 *  the same x/y/w/h envelope — selection / marquee hit-test uses the AABB. */
export function shapeAABB(s: Shape): { x: number; y: number; w: number; h: number } {
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

/** Point inside a shape's AABB (world coords). For ellipse / diamond we accept
 *  the AABB as the hit zone — Excalidraw does the same and the cost of perfect
 *  hit-test isn't worth it at v1. */
export function pointInShape(p: Pt, s: Shape): boolean {
  return p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
}

/** Width of the edge-snap band, in world units. Used by the connector tools:
 *  a pointer-down inside the band counts as "drawing from the edge" and
 *  binds the from-side to the shape; a click deeper inside (in the
 *  interior, beyond the band) draws an orphaned line over the shape with
 *  no source snap.
 *
 *  Sized to 14 world units — comfortable to hit at default zoom (≈ a fat
 *  finger on a tooled handle) but doesn't swallow the entire interior of
 *  small shapes. The interior fallback (`pointInShapeInterior`) clamps
 *  the band so it never collapses an inset rectangle into a negative
 *  size — small shapes effectively ARE all edge, and there's no
 *  "interior" to draw an orphaned line over. */
export const EDGE_SNAP_BAND = 14;

/** True when `p` lies within `band` units of any edge of `s` and inside
 *  the AABB. Used for from-side snap on connector tools so the user has
 *  to grab the shape's outline to bind, not just any pixel inside. */
export function pointInShapeEdgeBand(p: Pt, s: Shape, band: number): boolean {
  if (!pointInShape(p, s)) return false;
  // Min width / height — shapes smaller than 2*band on either axis are
  // entirely "edge" by definition; pretend the interior is empty so the
  // user can still bind to a small shape by clicking anywhere inside it.
  if (s.w < band * 2 || s.h < band * 2) return true;
  return (
    p.x - s.x <= band ||
    s.x + s.w - p.x <= band ||
    p.y - s.y <= band ||
    s.y + s.h - p.y <= band
  );
}

/** Distance-based "near centre" test for the fightable target-snap. The
 *  user can drag into the shape's middle to bind the connector's
 *  destination at the centre anchor `[0.5, 0.5]` instead of the auto
 *  perimeter anchor.
 *
 *  The centre zone is sized AS A FRACTION OF THE SHAPE'S DIMENSIONS — a
 *  small target around the geometric centre, not "everything that isn't
 *  edge". A previous implementation shrank the AABB by `EDGE_SNAP_BAND` on
 *  every side, which made the centre zone swallow nearly the entire body
 *  of any reasonably-sized shape and caused connectors drawn over a box to
 *  slam into the centre anchor whenever the cursor wandered inside.
 *  Sizing relative to the shape means tiny shapes get a tiny centre target
 *  (and large shapes a larger but still bounded one), so the user has to
 *  deliberately aim for the middle to invoke the centre snap.
 *
 *  - `CENTER_FRACTION` = half-extent as a fraction of each side. 0.18
 *    → centre target spans ~36% of the shape's width/height.
 *  - `CENTER_MIN` = floor in world units, so usable on shapes that are
 *    just barely big enough to have a centre zone at all.
 *  - `CENTER_MAX` = ceiling, so a 1000-wide container's centre zone stays
 *    a manageable target instead of growing without bound.
 *
 *  Returns false when the centre half-extent can't fit inside `band` of
 *  the shape's edge — those shapes are "all edge" and have no separate
 *  centre zone, matching `pointInShapeEdgeBand`'s small-shape rule. */
export function pointInShapeCenterZone(p: Pt, s: Shape, band: number): boolean {
  const CENTER_FRACTION = 0.18;
  const CENTER_MIN = 10;
  const CENTER_MAX = 40;
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  const halfW = Math.min(CENTER_MAX, Math.max(CENTER_MIN, w * CENTER_FRACTION));
  const halfH = Math.min(CENTER_MAX, Math.max(CENTER_MIN, h * CENTER_FRACTION));
  // Keep the centre zone strictly inside the edge band — otherwise a
  // pointer hovering near the perimeter of a small shape would qualify as
  // BOTH edge and centre and the ordering between them would matter.
  if (halfW > w / 2 - band || halfH > h / 2 - band) return false;
  const cx = s.x + w / 2;
  const cy = s.y + h / 2;
  return Math.abs(p.x - cx) <= halfW && Math.abs(p.y - cy) <= halfH;
}

/** Marquee rect → set of shape ids whose AABB is *fully contained* in the rect.
 *  This is draw.io's rule, not Excalidraw's. Partial overlap does NOT select.
 *
 *  Reason: Vellum targets dense, overlapping-container diagrams. Partial-overlap
 *  selection silently grabs parent containers and makes "marquee + delete"
 *  destructive in surprising ways. Fully-contained makes the marquee a precise
 *  tool — you have to enclose what you want. */
export function shapesInMarquee(
  rect: { x: number; y: number; w: number; h: number },
  shapes: Shape[],
): string[] {
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  return shapes
    .filter((s) => {
      // Normalise the shape's AABB in case w/h are transiently negative
      // mid-resize.
      const sx1 = Math.min(s.x, s.x + s.w);
      const sy1 = Math.min(s.y, s.y + s.h);
      const sx2 = Math.max(s.x, s.x + s.w);
      const sy2 = Math.max(s.y, s.y + s.h);
      return sx1 >= x1 && sy1 >= y1 && sx2 <= x2 && sy2 <= y2;
    })
    .map((s) => s.id);
}

/** Marquee rect → set of connector ids that are fully captured.
 *
 *  A connector is "captured" only if every point it materially depends on is
 *  inside the rect:
 *   - For each endpoint:
 *     - bound endpoint  → the bound shape must itself be in `containedShapeIds`
 *       (i.e. the shape was fully contained — we ride along with it)
 *     - floating endpoint → the literal point must be inside the rect
 *   - Every user waypoint must be inside the rect
 *
 *  Rationale: this keeps "marquee + delete" predictable. If you fully enclose
 *  two shapes, the connector between them comes along. If you only enclose
 *  one end, the connector stays — you didn't ask for it. */
export function connectorsInMarquee(
  rect: { x: number; y: number; w: number; h: number },
  connectors: Connector[],
  containedShapeIds: ReadonlySet<string>,
): string[] {
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  const ptInside = (p: { x: number; y: number }) =>
    p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  const endpointInside = (
    ep: Connector['from'],
  ): boolean => {
    if ('shape' in ep) return containedShapeIds.has(ep.shape);
    return ptInside(ep);
  };
  return connectors
    .filter((c) => {
      if (!endpointInside(c.from)) return false;
      if (!endpointInside(c.to)) return false;
      if (c.waypoints) {
        for (const w of c.waypoints) {
          if (!ptInside(w)) return false;
        }
      }
      return true;
    })
    .map((c) => c.id);
}

/** Distance from point to a path's polyline approximation. v1 just checks AABB
 *  inflated by hit-radius — accurate enough for connector picking when paired
 *  with the fat-stroke hit target the connector renders. */
export function nearSegment(
  p: Pt,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  threshold: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - ax;
    const ddy = p.y - ay;
    return ddx * ddx + ddy * ddy <= threshold * threshold;
  }
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= threshold * threshold;
}

/** Resize-handle hit zones: 4 corners + 4 edge midpoints. Edge handles let the
 *  user resize along a single axis (drag the right edge to widen, etc.). They
 *  pair naturally with corner handles — a corner moves both axes, an edge
 *  moves only one. */
export type Handle =
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se'
  | 'n'
  | 's'
  | 'e'
  | 'w';
export const HANDLE_KINDS: Handle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

export function handlePosition(s: Shape, h: Handle): Pt {
  switch (h) {
    case 'nw':
      return { x: s.x, y: s.y };
    case 'ne':
      return { x: s.x + s.w, y: s.y };
    case 'sw':
      return { x: s.x, y: s.y + s.h };
    case 'se':
      return { x: s.x + s.w, y: s.y + s.h };
    case 'n':
      return { x: s.x + s.w / 2, y: s.y };
    case 's':
      return { x: s.x + s.w / 2, y: s.y + s.h };
    case 'e':
      return { x: s.x + s.w, y: s.y + s.h / 2 };
    case 'w':
      return { x: s.x, y: s.y + s.h / 2 };
  }
}

/** True for the 4 edge midpoint handles. Used to suppress them when uniform-
 *  scale is forced (icons with locked aspect can't resize on a single axis). */
export function isEdgeHandle(h: Handle): boolean {
  return h === 'n' || h === 's' || h === 'e' || h === 'w';
}

/** Apply a corner- or edge-handle drag to a shape's geometry. The grabbed
 *  corner / edge moves with the cursor; the opposite side stays fixed.
 *  Negative w/h is allowed during drag and normalised on commit. */
export function applyHandleDrag(
  s: Shape,
  h: Handle,
  worldDx: number,
  worldDy: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h: H } = s;
  if (h === 'nw') {
    x += worldDx;
    y += worldDy;
    w -= worldDx;
    H -= worldDy;
  } else if (h === 'ne') {
    y += worldDy;
    w += worldDx;
    H -= worldDy;
  } else if (h === 'sw') {
    x += worldDx;
    w -= worldDx;
    H += worldDy;
  } else if (h === 'se') {
    w += worldDx;
    H += worldDy;
  } else if (h === 'n') {
    y += worldDy;
    H -= worldDy;
  } else if (h === 's') {
    H += worldDy;
  } else if (h === 'e') {
    w += worldDx;
  } else if (h === 'w') {
    x += worldDx;
    w -= worldDx;
  }
  return { x, y, w, h: H };
}

/** Normalise a possibly-negative geometry to positive w/h with adjusted x/y. */
export function normalizeRect(g: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = g;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, w, h };
}

/** Cursor for a corner or edge handle, accounting for negative-w/h flips. NW
 *  becomes NE if width has gone negative, etc. Edge handles only flip across
 *  their relevant axis. */
/** The 9 inside-grid anchor positions valid for a container's iconAnchor.
 *  Keeping the type narrow at the helper level catches outside-* / cardinal
 *  values that would otherwise silently fall through to the top-left
 *  fallback. The inspector picker only emits these. */
export type IconAnchorPosition =
  | 'top-left'
  | 'inside-top'
  | 'top-right'
  | 'inside-left'
  | 'center'
  | 'inside-right'
  | 'bottom-left'
  | 'inside-bottom'
  | 'bottom-right';

/** Padding between the container frame and its anchor icon. Matches
 *  Shape.tsx's PAD constant for the right-of-icon label slot — keep them
 *  numerically synced so a top-left icon doesn't sit in a different inset
 *  than the legacy default. */
export const CONTAINER_ICON_PAD = 12;

/** Compute world-space (x, y) for a container's anchor child given the
 *  container's bbox + the requested icon anchor + the child's own size.
 *  Honours the 12px CONTAINER_ICON_PAD inset on every side so the icon
 *  doesn't touch the frame border. Centred anchors don't get the inset
 *  applied to the secondary axis (e.g. 'top' centres horizontally, but
 *  pads from the top edge).
 *
 *  Used at:
 *    - container resize (translate the anchor child to maintain its slot)
 *    - inspector iconAnchor change (re-snap the child to the new slot)
 *    - container creation if `iconAnchor` is provided up front (currently
 *      undefined → legacy top-left). */
export function computeContainerIconPosition(
  container: { x: number; y: number; w: number; h: number },
  child: { w: number; h: number },
  anchor: LabelAnchor | undefined,
): { x: number; y: number } {
  const PAD = CONTAINER_ICON_PAD;
  const innerLeft = container.x + PAD;
  const innerTop = container.y + PAD;
  const innerRight = container.x + container.w - PAD - child.w;
  const innerBottom = container.y + container.h - PAD - child.h;
  const innerCenterX = container.x + (container.w - child.w) / 2;
  const innerCenterY = container.y + (container.h - child.h) / 2;
  // Map outside / cardinal anchors to top-left — they're meaningless for an
  // INSIDE-the-container icon and the user shouldn't be able to pick them
  // via the inspector either, but defensive fallback.
  switch (anchor) {
    case 'inside-top':
      return { x: innerCenterX, y: innerTop };
    case 'top-right':
      return { x: innerRight, y: innerTop };
    case 'inside-left':
      return { x: innerLeft, y: innerCenterY };
    case 'center':
      return { x: innerCenterX, y: innerCenterY };
    case 'inside-right':
      return { x: innerRight, y: innerCenterY };
    case 'bottom-left':
      return { x: innerLeft, y: innerBottom };
    case 'inside-bottom':
      return { x: innerCenterX, y: innerBottom };
    case 'bottom-right':
      return { x: innerRight, y: innerBottom };
    case 'top-left':
    default:
      return { x: innerLeft, y: innerTop };
  }
}

export function cursorForHandle(h: Handle, w: number, H: number): string {
  if (h === 'n' || h === 's') return 'ns-resize';
  if (h === 'e' || h === 'w') return 'ew-resize';
  const flipX = w < 0;
  const flipY = H < 0;
  let key: Handle = h;
  if (flipX) {
    if (key === 'nw') key = 'ne';
    else if (key === 'ne') key = 'nw';
    else if (key === 'sw') key = 'se';
    else key = 'sw';
  }
  if (flipY) {
    if (key === 'nw') key = 'sw';
    else if (key === 'sw') key = 'nw';
    else if (key === 'ne') key = 'se';
    else key = 'ne';
  }
  return key === 'nw' || key === 'se' ? 'nwse-resize' : 'nesw-resize';
}
