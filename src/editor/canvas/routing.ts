/* Connector routing — anchor resolution + path computation.
 *
 * RULE: connectors store no waypoints by default. Paths are computed every
 * frame from current shape positions. If the user manually bends a connector,
 * we DO store explicit waypoints and the renderer threads them.
 *
 * v1 routing: straight (direct), curved (cubic Bezier), orthogonal (elbow).
 *
 * Elbow routing notes — the contract enforced by `buildOrthogonalPolyline`:
 *   1. Each endpoint exits/enters along its anchor's edge normal (so the
 *      line meets the shape perpendicular to its edge, like draw.io).
 *   2. Segments are strictly axis-aligned (no diagonals).
 *   3. The line never re-enters its own source/target shape — when the two
 *      anchor directions are parallel, we extend past both endpoints before
 *      bending so the path always exits cleanly.
 *   4. The polyline is collapsed to remove collinear midpoints and zero-
 *      length segments before being handed to the renderer / hit-tester. */

import type {
  Anchor,
  Connector,
  ConnectorEndpoint,
  Shape,
} from '@/store/types';
import { getIconSilhouette, silhouetteRayHit } from './silhouette';

export type ResolvedAnchor = Exclude<Anchor, 'auto'>;

/** Rotate a point around a center by `deg` degrees (clockwise positive — the
 *  same convention SVG's `rotate(deg cx cy)` uses). All rotation math in this
 *  module funnels through here so the sign convention can never drift. */
function rotatePoint(
  p: { x: number; y: number },
  c: { x: number; y: number },
  deg: number,
): { x: number; y: number } {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Classify an anchor as horizontal-axis (left/right) or vertical-axis
 *  (top/bottom) for routing decisions. Cardinal anchors are obvious;
 *  fractional anchors are classified by whichever component sits on the
 *  shape's edge (fx == 0 or 1 → horizontal; fy == 0 or 1 → vertical).
 *
 *  When the shape has been rotated, the *world-space* axis the anchor exits
 *  along has rotated with it. We snap the rotated exit direction back to the
 *  nearest cardinal axis so the curve / elbow router still has a clean
 *  horizontal-or-vertical answer to bias against. (45°-rotated shapes pick
 *  whichever axis comes out marginally larger after rotation; that's
 *  arbitrary but stable.) */
export function anchorAxis(
  a: ResolvedAnchor,
  rotation = 0,
): 'horizontal' | 'vertical' | 'unknown' {
  const dir = anchorOutDir(a, rotation);
  if (!dir) return 'unknown';
  return Math.abs(dir[0]) >= Math.abs(dir[1]) ? 'horizontal' : 'vertical';
}

export function shapeAnchorPoint(
  shape: Shape,
  anchor: ResolvedAnchor,
): [number, number] {
  const { x, y, w, h } = shape;
  if (Array.isArray(anchor)) {
    // Fractional anchors are computed against the actual shape outline so
    // ellipses and diamonds anchor on their curve, not on the bbox.
    const fx = anchor[0];
    const fy = anchor[1];
    if (shape.kind === 'icon') {
      // Icons aren't rectangular — push the anchor onto the rasterized
      // silhouette so connectors meet the visible glyph, not the bbox edge.
      // While the silhouette is still building (first paint after drop) we
      // fall through to the bbox and re-route on the subscriber notify.
      const sil = getIconSilhouette(shape.iconAttribution?.iconId);
      if (sil) {
        const hit = silhouetteRayHit(sil, fx, fy);
        if (hit) return [x + hit.fx * w, y + hit.fy * h];
      }
    }
    if (shape.kind === 'ellipse') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      // Direction from centre to bbox-position.
      const tx = x + fx * w;
      const ty = y + fy * h;
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) return [cx, cy];
      // Scale onto the ellipse: solve t such that (dx*t/rx)^2 + (dy*t/ry)^2 = 1.
      const k = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      if (k === 0) return [cx, cy];
      return [cx + dx / k, cy + dy / k];
    }
    if (shape.kind === 'diamond') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const tx = x + fx * w;
      const ty = y + fy * h;
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) return [cx, cy];
      // Diamond outline: |dx|/(w/2) + |dy|/(h/2) = 1.
      const k = Math.abs(dx) / (w / 2) + Math.abs(dy) / (h / 2);
      if (k === 0) return [cx, cy];
      return [cx + dx / k, cy + dy / k];
    }
    return [x + fx * w, y + fy * h];
  }
  // Cardinal anchors on non-rect shapes also need outline coercion. The
  // simplest path is to translate to a fractional anchor and reuse the
  // outline math above.
  const cardinal: Record<Exclude<ResolvedAnchor & string, never>, [number, number]> = {
    top: [0.5, 0],
    right: [1, 0.5],
    bottom: [0.5, 1],
    left: [0, 0.5],
  };
  if (shape.kind === 'ellipse' || shape.kind === 'diamond' || shape.kind === 'icon') {
    return shapeAnchorPoint(shape, cardinal[anchor as 'top']);
  }
  switch (anchor) {
    case 'top':
      return [x + w / 2, y];
    case 'right':
      return [x + w, y + h / 2];
    case 'bottom':
      return [x + w / 2, y + h];
    case 'left':
      return [x, y + h / 2];
  }
}

/** Auto-anchor: where on the shape's edge should this connector attach so the
 *  line points at the other endpoint. Returns a fractional anchor `[fx, fy]`
 *  computed by intersecting the centre→target ray with the shape's bounding
 *  box — the result is a continuous point on the edge rather than a snap to
 *  one of four cardinals.
 *
 *  Library shapes that declare anchor points should clamp `auto` to the
 *  declared set — v2 refinement.
 */
export function autoAnchor(
  from: Shape,
  toCenter: { x: number; y: number },
): ResolvedAnchor {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  // The bbox-edge ray test below operates in the shape's LOCAL (un-rotated)
  // frame because the bbox itself is stored axis-aligned. When the shape has
  // been rotated, the world target has to be un-rotated by the same amount
  // around the bbox center before we can ask "which edge would this ray
  // exit." Without this, autoAnchor on a rotated shape always anchored to
  // the wrong edge — visible as connectors snapping to the BACK side of a
  // 90°-rotated rect when the user clearly aimed at the front.
  const rot = from.rotation ?? 0;
  const local = rot
    ? rotatePoint(toCenter, { x: fcx, y: fcy }, -rot)
    : toCenter;
  const dx = local.x - fcx;
  const dy = local.y - fcy;
  if (dx === 0 && dy === 0) return 'right';

  // Icons: ray-cast through the rasterized silhouette so the auto anchor
  // lands on the visible glyph rather than the bbox edge. Project the target
  // direction onto a unit-square target point on the bbox edge first, then
  // hand that fractional coord to the silhouette walker — same shape of
  // input shapeAnchorPoint takes.
  if (from.kind === 'icon') {
    const sil = getIconSilhouette(from.iconAttribution?.iconId);
    if (sil) {
      // Project the ray onto the bbox edge to get an [0..1] target coord.
      const hxBbox = from.w / 2;
      const hyBbox = from.h / 2;
      const txT = dx === 0 ? Infinity : (dx > 0 ? hxBbox : -hxBbox) / dx;
      const tyT = dy === 0 ? Infinity : (dy > 0 ? hyBbox : -hyBbox) / dy;
      const tEdge = Math.min(txT, tyT);
      const fxTarget = (dx * tEdge + hxBbox) / from.w;
      const fyTarget = (dy * tEdge + hyBbox) / from.h;
      const hit = silhouetteRayHit(sil, fxTarget, fyTarget);
      if (hit) {
        return [
          Math.max(0, Math.min(1, hit.fx)),
          Math.max(0, Math.min(1, hit.fy)),
        ] as ResolvedAnchor;
      }
    }
    // Silhouette not ready (or no hit) — fall through to bbox math below.
  }

  // Half-extents from the shape's centre. We intersect the ray from the
  // centre out toward `toCenter` with the bounding box's four edges and pick
  // the smallest positive `t` — that's where the line exits the shape.
  const hx = from.w / 2;
  const hy = from.h / 2;

  // Ray: (fcx, fcy) + t * (dx, dy). Find smallest t > 0 such that the point
  // lies on the box boundary.
  const tx = dx === 0 ? Infinity : (dx > 0 ? hx : -hx) / dx;
  const ty = dy === 0 ? Infinity : (dy > 0 ? hy : -hy) / dy;
  const t = Math.min(tx, ty);

  // Hit point relative to centre.
  const hitX = dx * t;
  const hitY = dy * t;

  // Convert to fractional [0..1, 0..1] anchor coords.
  const fx = (hitX + hx) / from.w;
  const fy = (hitY + hy) / from.h;
  // Clamp to [0..1] — guards against floating-point overshoot on perfectly
  // axis-aligned rays.
  const cfx = Math.max(0, Math.min(1, fx));
  const cfy = Math.max(0, Math.min(1, fy));
  return [cfx, cfy] as ResolvedAnchor;
}

/** Compute a connector endpoint's world position. Bound endpoints anchor to
 *  the shape; floating endpoints are returned as-is. The opposite endpoint is
 *  needed so we can resolve `auto` anchors.
 *
 *  Rotation: anchors are stored in the shape's LOCAL (un-rotated) frame —
 *  rotation is a separate transform applied at render time so the bbox stays
 *  axis-aligned. To make a bound endpoint glue to the rotated edge in world
 *  space, we resolve the anchor point in local coords (existing math) and
 *  then rotate that point around the bbox center by the shape's rotation.
 *  Without this, connectors visibly detached from a shape the moment its
 *  rotation handle was used. The `rotation` field is propagated up through
 *  `resolveConnectorPath` so the elbow / curve routers can also rotate their
 *  exit-direction guesses (anchorOutDir / anchorAxis take a rotation arg). */
export function resolveEndpointPoint(
  ep: ConnectorEndpoint,
  other: ConnectorEndpoint,
  shapes: Shape[],
): {
  x: number;
  y: number;
  anchor: ResolvedAnchor | null;
  rotation: number;
} | null {
  if ('shape' in ep) {
    const sh = shapes.find((s) => s.id === ep.shape);
    if (!sh) return null;
    let anchor = ep.anchor;
    if (anchor === 'auto') {
      const otherCenter = endpointCenter(other, shapes);
      // autoAnchor is rotation-aware internally — pass world-space center.
      if (!otherCenter) anchor = 'right';
      else anchor = autoAnchor(sh, otherCenter);
    }
    const [lx, ly] = shapeAnchorPoint(sh, anchor as ResolvedAnchor);
    const rot = sh.rotation ?? 0;
    const cx = sh.x + sh.w / 2;
    const cy = sh.y + sh.h / 2;
    const world = rot
      ? rotatePoint({ x: lx, y: ly }, { x: cx, y: cy }, rot)
      : { x: lx, y: ly };
    return { x: world.x, y: world.y, anchor: anchor as ResolvedAnchor, rotation: rot };
  }
  return { x: ep.x, y: ep.y, anchor: null, rotation: 0 };
}

function endpointCenter(
  ep: ConnectorEndpoint,
  shapes: Shape[],
): { x: number; y: number } | null {
  if ('shape' in ep) {
    const sh = shapes.find((s) => s.id === ep.shape);
    if (!sh) return null;
    return { x: sh.x + sh.w / 2, y: sh.y + sh.h / 2 };
  }
  return { x: ep.x, y: ep.y };
}

/** Resolve both endpoints of a connector, returning their world coords + the
 *  resolved anchors (null for floating endpoints).
 *
 *  Note on elbow stability: we DO NOT snap the endpoint POINT to the cardinal
 *  edge midpoint here, even for orthogonal routing. The elbow router
 *  (`buildOrthogonalPolyline`) already uses `anchorOutDir` to derive a
 *  cardinal exit direction from a fractional anchor — that's enough to keep
 *  the bend topology stable. Snapping the POINT additionally would cause the
 *  visible endpoint to JUMP to the edge midpoint every time the cursor
 *  crosses a 45° boundary while dragging a connected shape; the line would
 *  visibly "tick" between two positions on the shape edge. Keeping the
 *  fractional point lets the line slide smoothly along the edge while the
 *  elbow direction stays cardinal-stable. */
export function resolveConnectorPath(
  conn: Connector,
  shapes: Shape[],
  fromSetback = 0,
  toSetback = 0,
): {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  fromAnchor: ResolvedAnchor | null;
  toAnchor: ResolvedAnchor | null;
  /** Rotation (degrees) of the shape each endpoint is bound to, or 0 for
   *  floating endpoints. The router uses these to rotate anchor exit
   *  directions back into world space. */
  fromRot: number;
  toRot: number;
} | null {
  const fp = resolveEndpointPoint(conn.from, conn.to, shapes);
  const tp = resolveEndpointPoint(conn.to, conn.from, shapes);
  if (!fp || !tp) return null;

  let fx = fp.x;
  let fy = fp.y;
  let tx = tp.x;
  let ty = tp.y;

  if (fromSetback > 0 || toSetback > 0) {
    const dxRaw = tx - fx;
    const dyRaw = ty - fy;
    const distRaw = Math.sqrt(dxRaw * dxRaw + dyRaw * dyRaw);

    let fDir = anchorOutDir(fp.anchor, fp.rotation);
    let tDir = anchorOutDir(tp.anchor, tp.rotation);

    if (conn.routing === 'straight' || conn.routing == null) {
      if (distRaw > 0) {
        fDir = [dxRaw / distRaw, dyRaw / distRaw];
        tDir = [-dxRaw / distRaw, -dyRaw / distRaw];
      }
    }

    if (fromSetback > 0) {
      if (fDir) {
        fx += fDir[0] * fromSetback;
        fy += fDir[1] * fromSetback;
      } else if (distRaw > fromSetback) {
        fx += (dxRaw / distRaw) * fromSetback;
        fy += (dyRaw / distRaw) * fromSetback;
      }
    }

    if (toSetback > 0) {
      if (tDir) {
        tx += tDir[0] * toSetback;
        ty += tDir[1] * toSetback;
      } else if (distRaw > toSetback) {
        tx -= (dxRaw / distRaw) * toSetback;
        ty -= (dyRaw / distRaw) * toSetback;
      }
    }
  }

  return {
    fx,
    fy,
    tx,
    ty,
    fromAnchor: fp.anchor,
    toAnchor: tp.anchor,
    fromRot: fp.rotation,
    toRot: tp.rotation,
  };
}

/** Edge-normal direction for a resolved anchor — the unit vector pointing OUT
 *  of the shape at that anchor, in world space. Cardinal anchors are obvious;
 *  fractional anchors pick whichever cardinal axis they're closest to (the
 *  "dominant" edge), which lines up with how `auto` anchors are computed.
 *
 *  When the shape has been rotated, the world-space exit direction is the
 *  shape-local cardinal direction rotated by `rotation` degrees and then
 *  *snapped back* to the nearest cardinal axis — the elbow router is
 *  axis-aligned in WORLD space, so a 45°-rotated diamond's "right" edge has
 *  to commit to either right or down (whichever the rotation pushes it
 *  closer to). 0° rotation passes through unchanged.
 *
 *  Returns `null` for floating endpoints — the orthogonal router falls back
 *  to a target-direction guess in that case. */
function anchorOutDir(
  anchor: ResolvedAnchor | null,
  rotation = 0,
): [number, number] | null {
  if (anchor == null) return null;
  let dx: number;
  let dy: number;
  if (anchor === 'top') {
    dx = 0;
    dy = -1;
  } else if (anchor === 'bottom') {
    dx = 0;
    dy = 1;
  } else if (anchor === 'right') {
    dx = 1;
    dy = 0;
  } else if (anchor === 'left') {
    dx = -1;
    dy = 0;
  } else {
    // Fractional — pick whichever axis the anchor is closer to an edge on.
    const [fx, fy] = anchor;
    const distLeft = fx;
    const distRight = 1 - fx;
    const distTop = fy;
    const distBottom = 1 - fy;
    const minH = Math.min(distLeft, distRight);
    const minV = Math.min(distTop, distBottom);
    if (minH <= minV) {
      dx = distLeft <= distRight ? -1 : 1;
      dy = 0;
    } else {
      dx = 0;
      dy = distTop <= distBottom ? -1 : 1;
    }
  }
  if (!rotation) return [dx, dy];
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wx = dx * cos - dy * sin;
  const wy = dx * sin + dy * cos;
  // Snap the rotated direction back to the nearest cardinal so the elbow
  // router (which assumes pure horizontal/vertical exits) keeps a clean
  // single-axis decision.
  if (Math.abs(wx) >= Math.abs(wy)) {
    return [wx >= 0 ? 1 : -1, 0];
  }
  return [0, wy >= 0 ? 1 : -1];
}

/** Stub distance — how far the path travels OUT from each anchor before it's
 *  allowed to bend. Big enough that arrowheads have clearance and the user
 *  can read the elbow as "this came out of that side"; small enough that
 *  short lines don't loop around. 18 is the same number draw.io uses. */
const ELBOW_STUB = 18;

/** Build a strict orthogonal polyline from `from` to `to` using the anchor
 *  exit directions to dictate the bend pattern. Returns the points only —
 *  the caller turns them into either an SVG path or a hit-test polyline.
 *
 *  Cases handled:
 *    1. Perpendicular exits (one horiz, one vert): single L-bend.
 *    2. Anti-parallel exits (e.g. right + left, target on the right):
 *       midpoint split on the relevant axis.
 *    3. Parallel exits (both right, both bottom, etc.): extend past both
 *       endpoints in the exit direction before bending — a staple-shape that
 *       guarantees the line never re-enters its own source/target shape.
 *    4. Anti-parallel exits but target is "behind" the source in the exit
 *       direction (e.g., from-right pointing at a shape to its left):
 *       loop around via a midline on the opposite axis. */
export function buildOrthogonalPolyline(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  fromRot = 0,
  toRot = 0,
): { x: number; y: number }[] {
  const fDir = anchorOutDir(fromAnchor, fromRot) ?? [
    Math.sign(tx - fx) || 1,
    0,
  ];
  const tDir = anchorOutDir(toAnchor, toRot) ?? [
    Math.sign(fx - tx) || -1,
    0,
  ];
  const fStub = { x: fx + fDir[0] * ELBOW_STUB, y: fy + fDir[1] * ELBOW_STUB };
  const tStub = { x: tx + tDir[0] * ELBOW_STUB, y: ty + tDir[1] * ELBOW_STUB };

  const fHoriz = fDir[0] !== 0;
  const tHoriz = tDir[0] !== 0;

  const mid: { x: number; y: number }[] = [];

  // Detour rail offset for the "target behind exit direction" loop. Big
  // enough to clear typical shape bodies (~80x60 to ~150x100) — the router
  // doesn't have shape bounds, so we err on the side of "definitely clears."
  // Smaller offsets used to drop the rail INTO the shape's body.
  const RAIL_OFFSET = ELBOW_STUB * 4;

  if (fHoriz && tHoriz) {
    // Both horizontal — connect via a vertical midline.
    const sameDir = Math.sign(fDir[0]) === Math.sign(tDir[0]);
    const exitsForward = (tStub.x - fStub.x) * fDir[0] > 0;
    if (sameDir) {
      // Parallel exits (both 'right' or both 'left'). When target's stub
      // sits further along the exit direction than source's, a simple staple
      // clears both shapes. When target is BEHIND source along the exit,
      // we'd cross source's body — loop around via top/bottom instead.
      const targetAhead =
        fDir[0] > 0 ? tStub.x >= fStub.x : tStub.x <= fStub.x;
      if (targetAhead) {
        const farX =
          fDir[0] > 0
            ? Math.max(fStub.x, tStub.x)
            : Math.min(fStub.x, tStub.x);
        mid.push({ x: farX, y: fStub.y });
        mid.push({ x: farX, y: tStub.y });
      } else {
        // Bias the rail to whichever side puts it FURTHER from target so
        // the loop doesn't double back over the goal.
        const railY =
          fStub.y < tStub.y
            ? fStub.y - RAIL_OFFSET
            : fStub.y + RAIL_OFFSET;
        mid.push({ x: fStub.x, y: railY });
        mid.push({ x: tStub.x, y: railY });
      }
    } else if (exitsForward) {
      // Anti-parallel and target in front of source — clean midpoint split.
      const midX = (fStub.x + tStub.x) / 2;
      mid.push({ x: midX, y: fStub.y });
      mid.push({ x: midX, y: tStub.y });
    } else {
      // Anti-parallel but target sits "behind" the exit direction (e.g.,
      // from-right pointing at a shape on the LEFT). A midpoint split would
      // backtrack through the source. Loop around via the perpendicular
      // axis, with enough offset to clear typical shape bodies.
      const railY =
        fStub.y <= tStub.y
          ? Math.min(fStub.y, tStub.y) - RAIL_OFFSET
          : Math.max(fStub.y, tStub.y) + RAIL_OFFSET;
      mid.push({ x: fStub.x, y: railY });
      mid.push({ x: tStub.x, y: railY });
    }
  } else if (!fHoriz && !tHoriz) {
    // Both vertical — symmetric to the all-horizontal case, axes swapped.
    const sameDir = Math.sign(fDir[1]) === Math.sign(tDir[1]);
    const exitsForward = (tStub.y - fStub.y) * fDir[1] > 0;
    if (sameDir) {
      const targetAhead =
        fDir[1] > 0 ? tStub.y >= fStub.y : tStub.y <= fStub.y;
      if (targetAhead) {
        const farY =
          fDir[1] > 0
            ? Math.max(fStub.y, tStub.y)
            : Math.min(fStub.y, tStub.y);
        mid.push({ x: fStub.x, y: farY });
        mid.push({ x: tStub.x, y: farY });
      } else {
        const railX =
          fStub.x < tStub.x
            ? fStub.x - RAIL_OFFSET
            : fStub.x + RAIL_OFFSET;
        mid.push({ x: railX, y: fStub.y });
        mid.push({ x: railX, y: tStub.y });
      }
    } else if (exitsForward) {
      const midY = (fStub.y + tStub.y) / 2;
      mid.push({ x: fStub.x, y: midY });
      mid.push({ x: tStub.x, y: midY });
    } else {
      const railX =
        fStub.x <= tStub.x
          ? Math.min(fStub.x, tStub.x) - RAIL_OFFSET
          : Math.max(fStub.x, tStub.x) + RAIL_OFFSET;
      mid.push({ x: railX, y: fStub.y });
      mid.push({ x: railX, y: tStub.y });
    }
  } else if (fHoriz && !tHoriz) {
    // Perpendicular: from horizontal, to vertical. One bend at (tStub.x, fStub.y).
    mid.push({ x: tStub.x, y: fStub.y });
  } else {
    // Perpendicular: from vertical, to horizontal. One bend at (fStub.x, tStub.y).
    mid.push({ x: fStub.x, y: tStub.y });
  }

  const pts: { x: number; y: number }[] = [
    { x: fx, y: fy },
    fStub,
    ...mid,
    tStub,
    { x: tx, y: ty },
  ];
  return collapseCollinear(pts);
}

/** Drop redundant points: zero-length segments and collinear midpoints. The
 *  router builds an over-specified polyline (always 5–6 points) so the
 *  topology is uniform regardless of which case fired; this collapse step
 *  hands the renderer / hit-tester a tight version with no useless joins.
 *
 *  `keepIdx` (optional) marks indices that MUST be preserved even if they
 *  look collinear — used to protect user-placed waypoints from being
 *  collapsed. Without this, a waypoint dragged off-axis can land between
 *  two synthetic bends at the same coordinate; collapseCollinear sees the
 *  two bends as collinear with the waypoint and drops the waypoint itself,
 *  leaving the rendered line going through the bends with the waypoint dot
 *  floating in empty space. */
function collapseCollinear(
  pts: { x: number; y: number }[],
  keepIdx?: ReadonlySet<number>,
): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const EPS = 0.5;
  const out: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    // Drop zero-length steps.
    if (Math.abs(cur.x - last.x) < EPS && Math.abs(cur.y - last.y) < EPS) continue;
    const protectedPoint = keepIdx?.has(i);
    if (!protectedPoint) {
      const lcHoriz = Math.abs(cur.y - last.y) < EPS;
      const cnHoriz = Math.abs(next.y - cur.y) < EPS;
      const lcVert = Math.abs(cur.x - last.x) < EPS;
      const cnVert = Math.abs(next.x - cur.x) < EPS;
      if ((lcHoriz && cnHoriz) || (lcVert && cnVert)) continue;
    }
    out.push(cur);
  }
  const last = out[out.length - 1];
  const tail = pts[pts.length - 1];
  if (Math.abs(tail.x - last.x) >= EPS || Math.abs(tail.y - last.y) >= EPS) {
    out.push(tail);
  }
  return out;
}

export function buildPath(
  routing: Connector['routing'],
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints?: { x: number; y: number }[],
  fromRot = 0,
  toRot = 0,
): string {
  // Manual waypoints win — thread the line through them in order.
  if (waypoints && waypoints.length > 0) {
    const pts = [{ x: fx, y: fy }, ...waypoints, { x: tx, y: ty }];
    if (routing === 'orthogonal') {
      // Make every segment axis-aligned by inserting an extra elbow between
      // adjacent waypoints whose dx and dy are both non-zero. Plus a
      // perpendicular kick at each endpoint so the line still leaves/enters
      // along the anchor's exit normal.
      const fDir = anchorOutDir(fromAnchor, fromRot);
      const tDir = anchorOutDir(toAnchor, toRot);
      const ortho = orthogonalThroughWaypoints(pts, fDir, tDir);
      return polylineToPath(ortho);
    }
    if (routing === 'curved') {
      return catmullRomToBezier(pts);
    }
    // straight = polyline
    return polylineToPath(pts);
  }

  if (routing === 'orthogonal') {
    const pts = buildOrthogonalPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      fromRot,
      toRot,
    );
    return polylineToPath(pts);
  }
  if (routing === 'curved') {
    // Without waypoints a "curved" line only really has one tangent to choose;
    // bias the control points along the from/to anchor axes so the curve
    // leaves and enters the shape edges naturally.
    const fromHoriz =
      fromAnchor == null || anchorAxis(fromAnchor, fromRot) !== 'vertical';
    const toHoriz =
      toAnchor == null || anchorAxis(toAnchor, toRot) !== 'vertical';
    const dx = (tx - fx) * 0.5;
    const dy = (ty - fy) * 0.5;
    const c1 = fromHoriz ? `${fx + dx} ${fy}` : `${fx} ${fy + dy}`;
    const c2 = toHoriz ? `${tx - dx} ${ty}` : `${tx} ${ty - dy}`;
    return `M ${fx} ${fy} C ${c1}, ${c2}, ${tx} ${ty}`;
  }
  return `M ${fx} ${fy} L ${tx} ${ty}`;
}

/** Build the polyline points the renderer would draw for this connector at
 *  the given resolved endpoints / anchors. Same routing decisions as
 *  `buildPath`, but returned as discrete (x, y) vertices instead of an SVG
 *  path string — so hit-testers and label positioners can do arclength /
 *  point-projection math against the actual rendered geometry.
 *
 *  Kept thin: it dispatches to `buildOrthogonalPolyline` /
 *  `buildOrthogonalThroughWaypoints` / `sampleCurvedPolyline` /
 *  straight-with-waypoints. Any future routing mode (e.g. spline) gets one
 *  extra branch here and label/drag math updates for free. */
export function connectorPolyline(
  conn: Connector,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  fromRot = 0,
  toRot = 0,
): { x: number; y: number }[] {
  const wp = conn.waypoints;
  if (conn.routing === 'orthogonal') {
    return wp && wp.length > 0
      ? buildOrthogonalThroughWaypoints(
          fx,
          fy,
          tx,
          ty,
          fromAnchor,
          toAnchor,
          wp,
          fromRot,
          toRot,
        )
      : buildOrthogonalPolyline(
          fx,
          fy,
          tx,
          ty,
          fromAnchor,
          toAnchor,
          fromRot,
          toRot,
        );
  }
  if (conn.routing === 'curved') {
    return sampleCurvedPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      wp,
      fromRot,
      toRot,
    );
  }
  // straight: from → optional waypoints → to.
  return [{ x: fx, y: fy }, ...(wp ?? []), { x: tx, y: ty }];
}

/** Per-segment + cumulative arclengths for a polyline. Used by both the
 *  point-at-fraction lookup and the nearest-fraction-to-point projection so
 *  they agree on what "halfway" means even for very short segments. */
function polylineMetrics(pts: { x: number; y: number }[]): {
  segLen: number[];
  cumLen: number[];
  total: number;
} {
  const segLen: number[] = [];
  const cumLen: number[] = [0];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const d = Math.hypot(dx, dy);
    segLen.push(d);
    total += d;
    cumLen.push(total);
  }
  return { segLen, cumLen, total };
}

/** Point on a polyline at fraction `f` of total arclength (clamped to
 *  [0, 1]). Degenerate polylines (length 0 or 1, or zero total length)
 *  fall back to the first vertex so callers always get a finite point. */
export function pointAtFraction(
  pts: { x: number; y: number }[],
  f: number,
): { x: number; y: number } {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  const { segLen, cumLen, total } = polylineMetrics(pts);
  if (total === 0) return pts[0];
  const target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < segLen.length; i++) {
    // First segment whose end-arclength is past the target wins. Equality
    // is OK — t collapses to 1.0 and we return that vertex exactly.
    if (cumLen[i + 1] >= target) {
      const t = segLen[i] === 0 ? 0 : (target - cumLen[i]) / segLen[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
  }
  return pts[pts.length - 1];
}

/** Project world point `p` onto the closest segment of `pts` and return
 *  the fraction of total arclength at the projection. Used to translate
 *  "the user dragged the label here" into a stored `labelPosition`. */
export function nearestFractionOnPolyline(
  pts: { x: number; y: number }[],
  p: { x: number; y: number },
): number {
  if (pts.length < 2) return 0;
  const { segLen, cumLen, total } = polylineMetrics(pts);
  if (total === 0) return 0;
  let bestDist = Infinity;
  let bestFrac = 0;
  for (let i = 0; i < segLen.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // Classic point-on-segment projection clamped to [0, 1] of the segment.
    const t =
      len2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
          );
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestDist) {
      bestDist = d;
      bestFrac = (cumLen[i] + t * segLen[i]) / total;
    }
  }
  return bestFrac;
}

function polylineToPath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Same as the private waypoint-expansion routine, exposed so the canvas hit
 *  layer can build the same axis-aligned polyline the renderer draws. Walks
 *  start → waypoints → end and inserts an L-bend between any adjacent pair
 *  with both dx and dy nonzero. */
export function buildOrthogonalThroughWaypoints(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints: { x: number; y: number }[],
  fromRot = 0,
  toRot = 0,
): { x: number; y: number }[] {
  return orthogonalThroughWaypoints(
    [{ x: fx, y: fy }, ...waypoints, { x: tx, y: ty }],
    anchorOutDir(fromAnchor, fromRot),
    anchorOutDir(toAnchor, toRot),
  );
}

/** Manual-waypoint orthogonal path. Inserts an axis-aligned bend between any
 *  adjacent points whose delta is diagonal so the rendered path is strictly
 *  axis-aligned even for waypoints the user dragged off-axis. The endpoint
 *  exit directions decide which axis the first/last bend uses.
 *
 *  Tracks which output indices correspond to USER WAYPOINTS (i.e. the input
 *  pts at indices 1..pts.length-2 — the endpoints are first and last) so
 *  the collinear-collapse pass at the end doesn't drop them. Off-axis
 *  waypoints commonly produce a "spike" shape — bend, waypoint, bend back —
 *  where the two synthetic bends sit at the same coordinate and the
 *  waypoint sits between them on a single axis. Without protection, the
 *  collapse step would correctly identify the waypoint as collinear with
 *  its neighbours and drop it, leaving the line skipping the waypoint
 *  while the waypoint DOT (rendered separately at the stored position)
 *  remains floating in empty space. */
function orthogonalThroughWaypoints(
  pts: { x: number; y: number }[],
  fDir: [number, number] | null,
  tDir: [number, number] | null,
): { x: number; y: number }[] {
  if (pts.length < 2) return pts;
  const out: { x: number; y: number }[] = [pts[0]];
  // Output indices that correspond to original user waypoints (not synthetic
  // bend points). pts[0] and pts[last] are endpoints, not waypoints.
  const userIdx = new Set<number>();
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5) {
      out.push(b);
      // pts[0] is the from endpoint, pts[last] is the to endpoint; everything
      // in between is a user waypoint.
      if (i > 0 && i < pts.length - 1) userIdx.add(out.length - 1);
      continue;
    }
    // Pick which axis to bend on. The first segment respects fDir, the last
    // segment respects tDir, middle segments default to "longer axis first."
    let bendHoriz: boolean;
    if (i === 1 && fDir) {
      bendHoriz = fDir[0] !== 0;
    } else if (i === pts.length - 1 && tDir) {
      bendHoriz = tDir[0] === 0; // approach point's bend is perp to tDir
    } else {
      bendHoriz = Math.abs(dx) >= Math.abs(dy);
    }
    if (bendHoriz) {
      out.push({ x: b.x, y: a.y });
    } else {
      out.push({ x: a.x, y: b.y });
    }
    out.push(b);
    if (i > 0 && i < pts.length - 1) userIdx.add(out.length - 1);
  }
  return collapseCollinear(out, userIdx);
}

/** Sample a curved-routed connector into a polyline for hit-testing. The
 *  rendered path is either a single cubic Bezier (no waypoints) or a Catmull-
 *  Rom spline through waypoints — both reduce to per-segment cubics. We
 *  evaluate each cubic at SAMPLES + 1 points and concatenate. The result is
 *  what the click hit-tester walks: previously it fell back to a straight-
 *  line check, which is why clicking near the bulge of a curved line missed.
 *
 *  SAMPLES = 24 per segment is overkill for crisp clicks at any zoom; the
 *  cost is negligible (we only sample on click, not per frame). */
const CURVE_SAMPLES_PER_SEGMENT = 24;

export function sampleCurvedPolyline(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints: { x: number; y: number }[] | undefined,
  fromRot = 0,
  toRot = 0,
): { x: number; y: number }[] {
  if (waypoints && waypoints.length > 0) {
    // Catmull-Rom segments with doubled endpoints. Same control-point math
    // as catmullRomToBezier; we just sample each cubic instead of emitting
    // SVG path commands.
    const pts = [{ x: fx, y: fy }, ...waypoints, { x: tx, y: ty }];
    if (pts.length === 2) {
      return sampleCubic(
        pts[0],
        { x: pts[0].x + (pts[1].x - pts[0].x) * 0.5, y: pts[0].y },
        { x: pts[1].x - (pts[1].x - pts[0].x) * 0.5, y: pts[1].y },
        pts[1],
      );
    }
    const tension = 0.5;
    const out: { x: number; y: number }[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? pts[i + 1];
      const c1 = {
        x: p1.x + ((p2.x - p0.x) * tension) / 3,
        y: p1.y + ((p2.y - p0.y) * tension) / 3,
      };
      const c2 = {
        x: p2.x - ((p3.x - p1.x) * tension) / 3,
        y: p2.y - ((p3.y - p1.y) * tension) / 3,
      };
      const seg = sampleCubic(p1, c1, c2, p2);
      // First sample of every segment except the first duplicates the previous
      // segment's last sample — skip it to keep the polyline tight.
      for (let j = 1; j < seg.length; j++) out.push(seg[j]);
    }
    return out;
  }
  // Single-segment cubic. Control points biased along anchor exit axes so
  // the curve leaves/enters the shape naturally — same rule the renderer uses.
  const fromHoriz =
    fromAnchor == null || anchorAxis(fromAnchor, fromRot) !== 'vertical';
  const toHoriz =
    toAnchor == null || anchorAxis(toAnchor, toRot) !== 'vertical';
  const dx = (tx - fx) * 0.5;
  const dy = (ty - fy) * 0.5;
  const c1 = fromHoriz
    ? { x: fx + dx, y: fy }
    : { x: fx, y: fy + dy };
  const c2 = toHoriz ? { x: tx - dx, y: ty } : { x: tx, y: ty - dy };
  return sampleCubic({ x: fx, y: fy }, c1, c2, { x: tx, y: ty });
}

function sampleCubic(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= CURVE_SAMPLES_PER_SEGMENT; i++) {
    const t = i / CURVE_SAMPLES_PER_SEGMENT;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
    });
  }
  return out;
}

/** Catmull-Rom spline through `pts`, converted to cubic Bezier segments. The
 *  endpoints are doubled so the curve passes through the first and last point.
 *  Tension 0.5 gives a natural, slightly-loose curve à la excalidraw. */
function catmullRomToBezier(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    // No interior points — fall back to a soft S-curve between the two points
    // so the line still reads as "curved".
    const [a, b] = pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y}, ${b.x - dx * 0.5} ${b.y}, ${b.x} ${b.y}` +
      ` ${dy ? '' : ''}`;
  }
  const tension = 0.5;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
