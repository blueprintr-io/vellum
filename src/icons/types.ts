// TRADEMARK-COMPLIANCE: ManifestEntry now carries optional `b` (isBrandedIcon)
// + `bh` (brand holder display name) so the picker can render the two-line
// "SVG: <license> · Brand: <vendor>®" badge instead of the single license
// label. Detection lives in src/lib/branded-icon-namespaces.ts; the manifest
// loader stamps each entry on first read.

/* Icon catalog types — separate from the diagram shape types.
 *
 * Two domains:
 *   - Vendor icons live in /public/icons/manifest.json (lightweight index) and
 *     /public/icons/packs/<vendor>.json (full data, lazy-loaded).
 *   - Iconify results are fetched at search time and never persisted at rest;
 *     the only thing we cache is the per-collection license metadata.
 *
 * Re IconAttribution: the canonical home is src/store/types.ts (it's part of
 * the diagram file format). We re-import it here so callers don't reach across
 * the store boundary just to talk about an icon's license. */

import type { IconAttribution, IconConstraints } from '@/store/types';

export type { IconAttribution, IconConstraints };

/* Manifest entry: one row per icon in the master index
 *
 *
 * Field names are kept terse on purpose — at 5,000+ entries the manifest is
 * the largest JSON the client downloads at boot, and these short keys add up.
 * Don't expand them without compressing the manifest first. */
export type ManifestEntry = {
  /** "<vendor>/<slug>" — globally unique within the vendor namespace. */
  id: string;
  /** Vendor key — joins back to `Manifest.vendors[v]`. */
  v: string;
  /** Display name shown in result cards. */
  n: string;
  /** Category ("compute", "storage"...) — not yet exposed in the UI but
   *  reserved for category facets (future). */
  c: string;
  /** Search keywords — exact-match boost terms ("ec2", "vm", "instance"). */
  k: string[];
  /** True if this icon depicts a vendor brand / trademark (AWS service icon,
   *  Kubernetes wheel, etc.) and the picker should render the two-line
   *  "SVG: <license> · Brand: <holder>®" badge. Filled in by the manifest
   *  loader from the namespace detector — manifests can also set it
   *  explicitly to override. */
  b?: boolean;
  /** Display holder name for the "Brand: <holder>®" line. Filled in by the
   *  manifest loader if missing. */
  bh?: string;
};

/** A vendor pack as registered in the manifest. SVG bytes live in `packUrl`,
 *  fetched lazily on first use. */
export type ManifestVendor = {
  /** Display name ("Amazon Web Services"). */
  name: string;
  /** Icon-set version surfaced in the UI ("v2.18"). Lets users tell at a
   *  glance whether a refresh has happened. */
  version: string;
  /** URL of the per-vendor pack JSON, served from /public/icons/packs/. */
  packUrl: string;
  /** Trademark / usage notice — displayed in AttributionsPanel and stamped
   *  onto each shape's IconAttribution at drop time. */
  trademark: {
    holder: string;
    notice: string;
    guidelinesUrl: string;
  };
};

export type Manifest = {
  /** Build version — bump this in the build script so clients can invalidate
   *  the cache when the catalog changes. */
  version: string;
  vendors: Record<string, ManifestVendor>;
  icons: ManifestEntry[];
};

/* Per-vendor pack: full data, fetched on first use
 *
 *
 * Bytes are inlined as SVG strings. We do this at build time (sanitized) so
 * the runtime never has to parse arbitrary user SVGs. */
export type VendorIcon = {
  id: string;
  vendor: string;
  name: string;
  category: string;
  keywords: string[];
  /** Sanitized `<svg>...</svg>` markup, ready to embed in the canvas. */
  svg: string;
  /** Optional theme variants — light/dark backgrounds. The renderer picks one
   *  based on the canvas paper colour at drop time. */
  variants?: { light?: string; dark?: string };
};

export type VendorPack = {
  vendor: string;
  version: string;
  icons: VendorIcon[];
};

/* Iconify
 *
 *
 * Per-icon results from /search; collection metadata fetched separately and
 * cached for the session. */
export type IconifyCollection = {
  prefix: string;
  name: string;
  author: string;
  license: { spdx: string; url: string };
};

export type IconifyResult = {
  /** "prefix:name" — the canonical Iconify id we use to fetch the SVG. */
  id: string;
  prefix: string;
  name: string;
  collection: IconifyCollection;
  /** TRADEMARK-COMPLIANCE: True when the icon depicts a vendor brand and the
   *  picker should render the two-line "SVG: <license> · Brand: <holder>®"
   *  badge. Stamped at search time by the namespace detector — see
   *  src/lib/branded-icon-namespaces.ts. */
  branded?: boolean;
  /** Holder name for the "Brand: <holder>®" line. */
  brandHolder?: string;
};

/* Combined search row used by the UI
 *
 *
 * Discriminated by `source` so the UI can decide:
 *   - which section to render under
 *   - whether to show a license badge
 *   - what attribution to stamp on the shape at drop time
 */
export type SearchRow =
  | { source: 'vendor'; entry: ManifestEntry; vendor: ManifestVendor }
  | { source: 'iconify'; result: IconifyResult };

/** Drop-time payload — minimal so it fits in the dataTransfer. The canvas
 *  drop handler resolves the actual SVG bytes via `resolveIcon`. */
export type IconDragPayload =
  | { source: 'vendor'; iconId: string; vendor: string }
  | { source: 'iconify'; iconId: string; prefix: string };

/** Resolved icon ready to construct an IconShape from. */
export type ResolvedIcon = {
  svg: string;
  attribution: IconAttribution;
  constraints: IconConstraints;
  /** Default w/h for the dropped shape. Vendor icons are usually square at
   *  64px; Iconify icons get the same to stay consistent. */
  defaultSize: { w: number; h: number };
};
