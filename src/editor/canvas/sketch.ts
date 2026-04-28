/* Sketchy primitives — placeholder for rough.js.
 *
 * v1 keeps the mock's hand-rolled jitter so we can ship the editor shell without
 * a rough.js dependency. The visual TARGET (orange #c83e1d strokes, double-stroked
 * outlines, slight wobble) is locked. Swap to real rough.js with seed-stable strokes
 * once the editor lifecycle is solid — this module is the seam.
 */

/** Mulberry32 — simple seedable PRNG so sketch shapes are stable across renders.
 *  Each shape carries a `seed` so the wobble doesn't dance on re-render. */
export function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two-pass jittered rect — same look as rough.js default `roughness: 1`. */
export function jitterRect(
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
  amp = 1.5,
): string[] {
  const r = mulberry32(seed);
  const j = () => (r() - 0.5) * amp * 2;
  const sides: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const ox = j();
    const oy = j();
    const x1 = x + ox,
      y1 = y + oy;
    const x2 = x + w + j(),
      y2 = y + oy;
    const x3 = x + w + j(),
      y3 = y + h + j();
    const x4 = x1 + j(),
      y4 = y + h + j();
    sides.push(
      `M ${x1} ${y1} Q ${(x1 + x2) / 2 + j()} ${y1 + j()} ${x2} ${y2} ` +
        `Q ${x2 + j()} ${(y2 + y3) / 2 + j()} ${x3} ${y3} ` +
        `Q ${(x3 + x4) / 2 + j()} ${y3 + j()} ${x4} ${y4} ` +
        `Q ${x4 + j()} ${(y4 + y1) / 2 + j()} ${x1} ${y1}`,
    );
  }
  return sides;
}

/** Two-pass jittered ROUNDED rect — wobbly outline with arc-cut corners. Used
 *  on the Notes layer so rect / service / container shapes read as a marker
 *  pass on a sticker rather than a sharp-edged technical drawing. The arcs
 *  use Q-curves (control point at the would-be corner) — close enough to a
 *  circular arc at this jitter amplitude, and dependency-free. */
export function jitterRoundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  seed = 1,
  amp = 1.5,
): string[] {
  // Clamp r so it never overruns the bbox — a 20×20 sticker shouldn't try to
  // round a 10px corner with r=14 and end up inverting the path.
  const rad = Math.max(0, Math.min(r, w / 2 - 1, h / 2 - 1));
  const rng = mulberry32(seed);
  const j = () => (rng() - 0.5) * amp * 2;
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    // Anchor points along each edge where the corner arc starts/ends, plus
    // the corner control points (the would-be sharp vertex). All jittered
    // independently each pass for the double-stroked feel.
    const tlEnd: [number, number] = [x + j(), y + rad + j()];
    const tlCtrl: [number, number] = [x + j(), y + j()];
    const tlStart: [number, number] = [x + rad + j(), y + j()];
    const trStart: [number, number] = [x + w - rad + j(), y + j()];
    const trCtrl: [number, number] = [x + w + j(), y + j()];
    const trEnd: [number, number] = [x + w + j(), y + rad + j()];
    const brStart: [number, number] = [x + w + j(), y + h - rad + j()];
    const brCtrl: [number, number] = [x + w + j(), y + h + j()];
    const brEnd: [number, number] = [x + w - rad + j(), y + h + j()];
    const blStart: [number, number] = [x + rad + j(), y + h + j()];
    const blCtrl: [number, number] = [x + j(), y + h + j()];
    const blEnd: [number, number] = [x + j(), y + h - rad + j()];

    let d = `M ${tlStart[0]} ${tlStart[1]}`;
    // top edge with mid-jitter
    d += ` Q ${(tlStart[0] + trStart[0]) / 2 + j()} ${tlStart[1] + j()} ${trStart[0]} ${trStart[1]}`;
    // top-right corner
    d += ` Q ${trCtrl[0]} ${trCtrl[1]} ${trEnd[0]} ${trEnd[1]}`;
    // right edge
    d += ` Q ${trEnd[0] + j()} ${(trEnd[1] + brStart[1]) / 2 + j()} ${brStart[0]} ${brStart[1]}`;
    // bottom-right corner
    d += ` Q ${brCtrl[0]} ${brCtrl[1]} ${brEnd[0]} ${brEnd[1]}`;
    // bottom edge
    d += ` Q ${(brEnd[0] + blStart[0]) / 2 + j()} ${brEnd[1] + j()} ${blStart[0]} ${blStart[1]}`;
    // bottom-left corner
    d += ` Q ${blCtrl[0]} ${blCtrl[1]} ${blEnd[0]} ${blEnd[1]}`;
    // left edge
    d += ` Q ${blEnd[0] + j()} ${(blEnd[1] + tlEnd[1]) / 2 + j()} ${tlEnd[0]} ${tlEnd[1]}`;
    // top-left corner — closes the loop
    d += ` Q ${tlCtrl[0]} ${tlCtrl[1]} ${tlStart[0]} ${tlStart[1]}`;
    out.push(d);
  }
  return out;
}

/** Sticky-note silhouette: rectangle with the top-left corner peeled back.
 *  Path traces the page edge starting after the fold, going clockwise, ending
 *  at the diagonal crease. Used by the note-kind shape — the body fill follows
 *  the same path so the corner shows the underlying canvas / fold flap. */
export function jitterFoldedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fold: number,
  seed = 1,
  amp = 1.2,
): string[] {
  const rng = mulberry32(seed);
  const j = () => (rng() - 0.5) * amp * 2;
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const p1: [number, number] = [x + fold + j(), y + j()];      // top edge start (after fold)
    const p2: [number, number] = [x + w + j(), y + j()];          // top-right
    const p3: [number, number] = [x + w + j(), y + h + j()];      // bottom-right
    const p4: [number, number] = [x + j(), y + h + j()];          // bottom-left
    const p5: [number, number] = [x + j(), y + fold + j()];       // left edge end (above fold)
    let d = `M ${p1[0]} ${p1[1]}`;
    d += ` Q ${(p1[0] + p2[0]) / 2 + j()} ${p1[1] + j()} ${p2[0]} ${p2[1]}`;
    d += ` Q ${p2[0] + j()} ${(p2[1] + p3[1]) / 2 + j()} ${p3[0]} ${p3[1]}`;
    d += ` Q ${(p3[0] + p4[0]) / 2 + j()} ${p3[1] + j()} ${p4[0]} ${p4[1]}`;
    d += ` Q ${p4[0] + j()} ${(p4[1] + p5[1]) / 2 + j()} ${p5[0]} ${p5[1]}`;
    // Diagonal crease back to p1 — also jittered so it doesn't read as a
    // perfectly-straight CAD line cutting through a hand-drawn shape.
    d += ` Q ${(p1[0] + p5[0]) / 2 + j()} ${(p1[1] + p5[1]) / 2 + j()} ${p1[0]} ${p1[1]}`;
    out.push(d);
  }
  return out;
}

/** Two-pass jittered diamond — same wobble treatment as jitterRect, around the
 *  diamond's four vertices. Used by the Notes-layer render path so diamonds on
 *  Notes have the same hand-drawn feel as rects + ellipses. */
export function jitterDiamond(
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
  amp = 1.5,
): string[] {
  const r = mulberry32(seed);
  const j = () => (r() - 0.5) * amp * 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const top: [number, number] = [cx + j(), y + j()];
    const right: [number, number] = [x + w + j(), cy + j()];
    const bot: [number, number] = [cx + j(), y + h + j()];
    const left: [number, number] = [x + j(), cy + j()];
    out.push(
      `M ${top[0]} ${top[1]} ` +
        `Q ${(top[0] + right[0]) / 2 + j()} ${(top[1] + right[1]) / 2 + j()} ${right[0]} ${right[1]} ` +
        `Q ${(right[0] + bot[0]) / 2 + j()} ${(right[1] + bot[1]) / 2 + j()} ${bot[0]} ${bot[1]} ` +
        `Q ${(bot[0] + left[0]) / 2 + j()} ${(bot[1] + left[1]) / 2 + j()} ${left[0]} ${left[1]} ` +
        `Q ${(left[0] + top[0]) / 2 + j()} ${(left[1] + top[1]) / 2 + j()} ${top[0]} ${top[1]}`,
    );
  }
  return out;
}

/** Hand-drawn ellipse outline. Earlier versions chained L commands between
 *  jittered points around the perimeter — visible as a dodecagon at typical
 *  sizes. This version walks the perimeter sampling endpoints, then draws each
 *  segment as a quadratic Bézier whose control sits on the un-jittered ellipse
 *  at the angular midpoint of the segment. Result: actually-curved arcs with
 *  organic wobble at the joins, not a polygon. Each pass starts at a random
 *  angle so the two passes don't overlap their seams. */
export function jitterEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed = 1,
  amp = 1.2,
): string[] {
  const r = mulberry32(seed);
  const j = () => (r() - 0.5) * amp * 2;
  // 12 segments × 30° each — quadratic curves through the segment midpoint
  // produce a near-perfect arc per segment, so 12 is plenty for a smooth
  // circle. Fewer segments = more "drawn casually" character; more = closer
  // to a CAD ellipse.
  const segs = 12;
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const startA = r() * Math.PI * 2;
    // Pre-sample endpoint coords + angles so we can derive the control points
    // from the angular midpoint of each segment.
    const pts: { x: number; y: number; a: number }[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = startA + (i / segs) * Math.PI * 2;
      pts.push({
        x: cx + Math.cos(a) * rx + j(),
        y: cy + Math.sin(a) * ry + j(),
        a,
      });
    }
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const aMid = (pts[i - 1].a + pts[i].a) / 2;
      // Control point on the un-jittered ellipse at the segment midpoint —
      // tiny extra jitter (× 0.5) keeps the arc shape honest while still
      // breathing a little.
      const ctrlX = cx + Math.cos(aMid) * rx + j() * 0.5;
      const ctrlY = cy + Math.sin(aMid) * ry + j() * 0.5;
      d += ` Q ${ctrlX} ${ctrlY} ${pts[i].x} ${pts[i].y}`;
    }
    out.push(d);
  }
  return out;
}
