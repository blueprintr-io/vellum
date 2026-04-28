/* Drop-time icon resolver.
 *
 * The drag payload only carries an id; the actual SVG bytes (and the
 * attribution metadata to stamp onto the shape) get resolved here. The split
 * keeps the dataTransfer payload tiny and lets the same `IconDragPayload`
 * shape be used for any future drag source (cmd-K palette, AI suggest, etc.).
 *
 * Vendor side:
 *   - Ensures the vendor pack is loaded (lazy fetch + cache).
 *   - Looks up the icon, builds the IconAttribution from the pack's trademark
 *     block, applies VENDOR_CONSTRAINTS.
 *
 * Iconify side:
 *   - Fetches the SVG bytes via /<prefix>/<name>.svg.
 *   - Reads collection metadata from the iconify cache (populated during
 *     search hydration). If a user somehow drops an icon whose collection we
 *     never fetched (cache invalidated mid-flight), we re-fetch.
 *   - Applies ICONIFY_CONSTRAINTS — aspect-locked, but recolor + rotation are
 *     fine for typical permissive licenses.
 *
 * Both paths sanitize SVGs at the boundary before embedding. The build script
 * sanitizes vendor SVGs at build time, but we still defensively pass them
 * through the same sanitizer here so anything malformed in the pack JSON
 * can't escape. */

import type {
  IconAttribution,
  IconConstraints,
} from '@/store/types';
import type { IconDragPayload, ResolvedIcon } from './types';
import { fetchIconifySvg, ensureCollection } from './iconify';
import { getManifest, loadVendorPack } from './manifest';
import { sanitizeSvg } from '@/lib/sanitize-svg';

// Vendor icons keep their colours and aspect ratio — that's the trademark
// safety contract. But rotation is a layout choice (think: an arrow flipped
// to point the other way, an arch icon laid on its side inside a sectional
// diagram), not a brand modification, so we leave it open. The user wanted
// to be able to spin AWS icons to fit awkward corners of an architecture
// diagram without unlocking the trademark colours or distorting the icon's
// aspect; this constraint set is the single source of truth for that
// trade-off.
const VENDOR_CONSTRAINTS: IconConstraints = {
  lockColors: true,
  lockAspect: true,
  lockRotation: false,
};

const ICONIFY_CONSTRAINTS: IconConstraints = {
  lockColors: false,
  lockAspect: true,
  lockRotation: false,
};

const DEFAULT_SIZE = { w: 64, h: 64 };

export async function resolveIcon(payload: IconDragPayload): Promise<ResolvedIcon> {
  if (payload.source === 'vendor') {
    return resolveVendor(payload.iconId, payload.vendor);
  }
  return resolveIconify(payload.iconId, payload.prefix);
}

async function resolveVendor(iconId: string, vendorKey: string): Promise<ResolvedIcon> {
  const pack = await loadVendorPack(vendorKey);
  const icon = pack.icons.find((i) => i.id === iconId);
  if (!icon) throw new Error(`vendor icon not found: ${iconId}`);
  const manifest = getManifest();
  const vendor = manifest?.vendors[vendorKey];
  if (!vendor) throw new Error(`vendor not in manifest: ${vendorKey}`);

  const attribution: IconAttribution = {
    source: 'vendor',
    iconId,
    holder: vendor.trademark.holder,
    license: 'Trademark',
    sourceUrl: vendor.trademark.guidelinesUrl,
    guidelinesUrl: vendor.trademark.guidelinesUrl,
  };

  return {
    svg: sanitizeSvg(icon.svg),
    attribution,
    constraints: VENDOR_CONSTRAINTS,
    defaultSize: DEFAULT_SIZE,
  };
}

async function resolveIconify(iconId: string, prefix: string): Promise<ResolvedIcon> {
  // `ensureCollection` is async — hits the in-memory search cache first, then
  // the per-collection endpoint, and finally falls back to a synthetic
  // "Unknown" collection. Either way it always returns something, so a drop
  // from Recent right after a refresh (when the search cache is empty) still
  // succeeds. Previously this was `getCollection` (sync, in-memory only) and
  // any cold prefix threw, which silently aborted the drop.
  const [svg, collection] = await Promise.all([
    fetchIconifySvg(iconId),
    ensureCollection(prefix),
  ]);

  const attribution: IconAttribution = {
    source: 'iconify',
    iconId,
    holder: collection.author,
    license: collection.license.spdx,
    sourceUrl: collection.license.url || `https://icon-sets.iconify.design/${prefix}/`,
  };

  return {
    svg: sanitizeSvg(svg),
    attribution,
    constraints: ICONIFY_CONSTRAINTS,
    defaultSize: DEFAULT_SIZE,
  };
}

// SVG sanitization moved to src/lib/sanitize-svg.ts (DOMPurify-backed). The
// previous regex sanitizer here had multiple bypasses (foreignObject,
// unquoted on* handlers, slash-as-separator, SMIL animate). Anything that
// resolves an icon goes through `sanitizeSvg` from that module — and so do
// the file-load / paste / drop boundaries, which the old regex never
// touched. Re-export here so existing callers keep working.
export { sanitizeSvg } from '@/lib/sanitize-svg';
