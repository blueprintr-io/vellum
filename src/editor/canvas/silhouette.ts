/* Icon silhouette cache — a per-iconId alpha mask used so connectors anchor
 * to the icon's visible shape instead of its bounding box.
 *
 * Why: icons render as nested SVG inside the shape's bbox, but routing.ts only
 * has the bbox to work with. For non-rectangular icons (a circular cloud, an
 * AWS Lambda diamond, a database cylinder) the line visibly stops short or
 * gaps off the side because the bbox edge is past the icon's edge.
 *
 * Approach:
 *   1. Rasterize the icon's SVG into an off-screen canvas at a fixed reference
 *      resolution (SIZE × SIZE).
 *   2. Read the alpha channel into a Uint8Array — 1 = "icon pixel", 0 = empty.
 *   3. routing.ts ray-casts from the centre of the bbox toward the connector's
 *      target point and walks outward through the mask, returning the LAST
 *      filled pixel before exit. That fractional [0..1, 0..1] coord is the
 *      anchor point on the icon's true outline.
 *
 * Cache key is `iconId` (e.g. `aws/ec2`, `mdi:database`) — stable per icon and
 * shared across every instance regardless of size, recolor, or rotation.
 *
 * Async: rasterization round-trips through `URL.createObjectURL` + Image load,
 * so callers receive `null` until the silhouette is ready and then get a
 * subscriber notification so the canvas can re-route.
 *
 * Fallback: if the silhouette never builds (broken SVG, all-transparent
 * recolor, fetch error), `getIconSilhouette` keeps returning null and the
 * caller stays on the bbox-edge math from before this module existed.
 */

/** Square mask resolution. 64 is a good balance — high enough to resolve the
 *  curve of a small icon's edge under sub-pixel ray walking, low enough that
 *  the build cost stays imperceptible (<1ms typical). */
const SIZE = 64;

/** Alpha threshold — pixels above this count as "filled". Anti-aliased edges
 *  fade to ~50/255 on outer rings; 16 keeps the silhouette tight without
 *  losing thin strokes. */
const ALPHA_THRESHOLD = 16;

export type Silhouette = {
  size: number;
  /** Row-major: mask[y * size + x]. 1 = icon, 0 = empty. */
  mask: Uint8Array;
};

const cache = new Map<string, Silhouette>();
const pending = new Set<string>();
const failed = new Set<string>();

/** Subscribers are called with no arguments after each silhouette becomes
 *  ready. Canvas hooks this up to a forceUpdate so connectors re-route. */
const subscribers = new Set<() => void>();

export function subscribeSilhouettes(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Sync access — returns the silhouette if cached, null otherwise. Routing.ts
 *  calls this on every path resolution and falls back to bbox math on null. */
export function getIconSilhouette(iconId: string | undefined): Silhouette | null {
  if (!iconId) return null;
  return cache.get(iconId) ?? null;
}

/** Idempotent kick-off. Called from Shape on icon render — multiple calls for
 *  the same iconId after the first are no-ops. */
export function requestIconSilhouette(
  iconId: string | undefined,
  iconSvg: string | undefined,
): void {
  if (!iconId || !iconSvg) return;
  if (cache.has(iconId) || pending.has(iconId) || failed.has(iconId)) return;
  if (typeof window === 'undefined') return; // SSR guard
  pending.add(iconId);
  void buildSilhouette(iconSvg)
    .then((sil) => {
      pending.delete(iconId);
      if (sil) {
        cache.set(iconId, sil);
        notify();
      } else {
        failed.add(iconId);
      }
    })
    .catch(() => {
      pending.delete(iconId);
      failed.add(iconId);
    });
}

async function buildSilhouette(
  iconSvg: string,
): Promise<Silhouette | null> {
  // Wrap the icon SVG in a standalone document so the browser can load it via
  // <img>. The shape renderer does the same trick at render time but inline;
  // here we need a real SVG document for blob → image-decode.
  const standalone = ensureStandaloneSvg(iconSvg);
  const blob = new Blob([standalone], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Default canvas state composites the icon over transparent — exactly what
    // we want. preserveAspectRatio="xMidYMid meet" is honoured by the browser
    // when drawing an SVG image into a smaller/larger destination.
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const mask = new Uint8Array(SIZE * SIZE);
    let any = false;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const a = data[i * 4 + 3];
      if (a > ALPHA_THRESHOLD) {
        mask[i] = 1;
        any = true;
      }
    }
    if (!any) return null; // empty mask — fall back to bbox forever
    return { size: SIZE, mask };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('icon decode failed'));
    img.src = src;
  });
}

/** Iconify SVGs sometimes arrive without an XML namespace, which makes the
 *  browser refuse to render them as a top-level image. Vendor SVGs already
 *  have one but the second declaration is harmless. */
function ensureStandaloneSvg(markup: string): string {
  if (/xmlns\s*=/.test(markup)) return markup;
  return markup.replace(
    /<svg\b/i,
    '<svg xmlns="http://www.w3.org/2000/svg"',
  );
}

/** Where does a ray from the silhouette's centre toward a target point exit
 *  the icon? Inputs and outputs are in fractional [0..1] silhouette-local
 *  coords — the caller maps them onto the shape's bbox. Returns null if the
 *  ray doesn't cross any filled pixel; the caller then falls back to bbox.
 *
 *  Walking strategy: 0.5-pixel steps from the centre outward. Track the last
 *  filled pixel encountered before we leave the bounds. This handles donut
 *  icons (centre is empty) — we keep walking and pick up the outer ring's
 *  far edge, which is where the connector should attach.
 */
export function silhouetteRayHit(
  sil: Silhouette,
  fxTarget: number,
  fyTarget: number,
): { fx: number; fy: number } | null {
  const { size, mask } = sil;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const tx = fxTarget * (size - 1);
  const ty = fyTarget * (size - 1);
  let dx = tx - cx;
  let dy = ty - cy;
  if (dx === 0 && dy === 0) return { fx: 0.5, fy: 0.5 };
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;

  // Max walk distance — diagonal of the box plus a hair so we don't miss the
  // last pixel due to rounding.
  const maxT = Math.hypot(size, size) + 1;

  let lastX = -1;
  let lastY = -1;
  for (let t = 0; t <= maxT; t += 0.5) {
    const x = cx + dx * t;
    const y = cy + dy * t;
    if (x < 0 || y < 0 || x > size - 1 || y > size - 1) break;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (mask[iy * size + ix]) {
      lastX = x;
      lastY = y;
    }
  }
  if (lastX < 0) return null;
  return { fx: lastX / (size - 1), fy: lastY / (size - 1) };
}

/** Test-only — clears caches between unit tests. Not used by the app. */
export function _resetSilhouetteCacheForTests(): void {
  cache.clear();
  pending.clear();
  failed.clear();
  subscribers.clear();
}
