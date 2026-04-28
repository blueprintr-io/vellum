// TRADEMARK-COMPLIANCE: manifest loader now stamps every entry with the
// branded-icon verdict (b / bh) and filters out denied bundled brand
// wordmarks (BUNDLED_BRAND_DENYLIST). See src/lib/branded-icon-namespaces.ts.

/* Vendor manifest loader + in-memory search index.
 *
 * Lifecycle:
 *   1. App boot kicks off `loadManifest()` (fire-and-forget); the panel
 *      subscribes via `useManifest()`.
 *   2. Search runs synchronously against the in-memory index — no network.
 *   3. Pack JSON is fetched lazily on first use via `loadVendorPack(vendor)`,
 *      cached forever per session.
 *
 * Search ranking:
 *   We don't depend on Fuse.js / MiniSearch — at our catalog size (a few
 *   thousand entries) a hand-rolled scorer is faster, smaller, and easier to
 *   tune. Score buckets, in priority order:
 *     - exact id match            (boost 1000)
 *     - exact name match          (boost 500)
 *     - exact keyword match       (boost 200)
 *     - name startsWith query     (boost 100)
 *     - keyword startsWith query  (boost 50)
 *     - name contains query       (boost 25)
 *     - keyword contains query    (boost 10)
 *   Within a bucket, ties break on shorter name (more specific). */

import type { Manifest, ManifestEntry, ManifestVendor, VendorPack } from './types';
import {
  detectBranded,
  isDeniedBundledBrand,
} from '@/lib/branded-icon-namespaces';
import { sanitizeSvg } from '@/lib/sanitize-svg';

const MANIFEST_URL = '/icons/manifest.json';

/** Cap responses from the same-origin manifest/pack endpoints. These ship
 *  from the deployment's own static bundle, but defense-in-depth applies
 *  to "what if a future feature points this at a remote URL" too. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024; // 16 MiB

async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxBytes) {
    throw new Error(`manifest response too large: ${cl} > ${maxBytes}`);
  }
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`manifest response too large: ${text.length} > ${maxBytes}`);
  }
  return JSON.parse(text) as T;
}

let _manifest: Manifest | null = null;
let _manifestPromise: Promise<Manifest> | null = null;
const _packCache = new Map<string, Promise<VendorPack>>();

/** Idempotent loader. First caller kicks off the fetch; subsequent callers
 *  await the same promise. Returns the cached manifest after first resolve. */
export async function loadManifest(): Promise<Manifest> {
  if (_manifest) return _manifest;
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = fetch(MANIFEST_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
      return readJsonCapped<Manifest>(r, MAX_MANIFEST_BYTES);
    })
    .then((m) => {
      // TRADEMARK-COMPLIANCE: post-load pass — drop any standalone brand
      // wordmarks/logos that slipped through the build, and stamp every
      // surviving entry with `b`/`bh` so the picker can render the
      // two-line license badge without re-running detection per render.
      const filtered: ManifestEntry[] = [];
      for (const entry of m.icons) {
        if (isDeniedBundledBrand(entry.id)) {
          if (typeof console !== 'undefined') {
            console.info(
              `[icons] dropped denied brand wordmark from bundled set: ${entry.id}`,
            );
          }
          continue;
        }
        if (entry.b === undefined) {
          const verdict = detectBranded({
            id: entry.id,
            name: entry.n,
            tags: entry.k,
          });
          entry.b = verdict.branded;
          if (verdict.branded && verdict.holder && !entry.bh) {
            // Prefer the vendor's manifest-declared holder name when
            // available — it's authoritative and tracks the trademark
            // notice text. Fall back to the detector's guess.
            const v = m.vendors[entry.v];
            entry.bh = v?.trademark.holder
              ? shortHolder(v.trademark.holder)
              : verdict.holder;
          }
        }
        filtered.push(entry);
      }
      m.icons = filtered;
      _manifest = m;
      return m;
    })
    .catch((err) => {
      // Reset so a later retry can re-fetch instead of returning the failed
      // promise forever.
      _manifestPromise = null;
      console.warn('icon manifest load failed', err);
      throw err;
    });
  return _manifestPromise;
}

/** Returns the loaded manifest synchronously, or null if loading is pending /
 *  failed. The panel uses this to render an empty state without suspending. */
export function getManifest(): Manifest | null {
  return _manifest;
}

/** Lazy per-vendor pack loader. The first call triggers the fetch; later
 *  calls await the cached promise. Failures bubble — caller decides whether
 *  to surface a toast or silently swallow. */
export async function loadVendorPack(vendorKey: string): Promise<VendorPack> {
  const cached = _packCache.get(vendorKey);
  if (cached) return cached;
  const manifest = await loadManifest();
  const vendor = manifest.vendors[vendorKey];
  if (!vendor) throw new Error(`unknown vendor: ${vendorKey}`);
  const promise = fetch(vendor.packUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`pack fetch failed: ${r.status}`);
      return readJsonCapped<VendorPack>(r, MAX_MANIFEST_BYTES);
    })
    .then((pack) => {
      // Defense-in-depth: every SVG in the pack passes through DOMPurify
      // before it reaches the picker tiles (which inline via
      // dangerouslySetInnerHTML). The build script also sanitizes, but a
      // deployment that swaps in a pack JSON it didn't build itself — or
      // a future Tier 2 user-imported pack — bypasses build-time cleaning.
      if (Array.isArray(pack?.icons)) {
        for (const icon of pack.icons) {
          if (typeof icon?.svg === 'string' && icon.svg.length > 0) {
            icon.svg = sanitizeSvg(icon.svg);
          }
        }
      }
      return pack;
    })
    .catch((err) => {
      _packCache.delete(vendorKey);
      throw err;
    });
  _packCache.set(vendorKey, promise);
  return promise;
}

/** Synchronous search against the in-memory manifest. Returns up to `limit`
 *  rows ranked by the scoring rules at the top of this file. */
export function searchManifest(
  query: string,
  limit = 24,
): Array<{ entry: ManifestEntry; vendor: ManifestVendor }> {
  if (!_manifest || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const scored: Array<{
    entry: ManifestEntry;
    vendor: ManifestVendor;
    score: number;
  }> = [];

  for (const entry of _manifest.icons) {
    const score = scoreEntry(entry, q);
    if (score === 0) continue;
    const vendor = _manifest.vendors[entry.v];
    if (!vendor) continue; // orphan entry — skip rather than crash
    scored.push({ entry, vendor, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: shorter names rank higher (more specific).
    return a.entry.n.length - b.entry.n.length;
  });

  return scored.slice(0, limit).map(({ entry, vendor }) => ({ entry, vendor }));
}

/** Compress a long legal-name holder ("Amazon.com, Inc. or its affiliates")
 *  down to a chip-sized display label ("AWS", "Microsoft Azure", "Google
 *  Cloud"). Used by the branded-badge stamp pass — what the legal text
 *  needs and what the chip needs are different things. */
function shortHolder(full: string): string {
  if (/amazon|aws/i.test(full)) return 'AWS';
  if (/google\s*cloud|gcp/i.test(full)) return 'Google Cloud';
  if (/microsoft\s*azure|azure/i.test(full)) return 'Microsoft Azure';
  if (/microsoft/i.test(full)) return 'Microsoft';
  if (/oracle/i.test(full)) return 'Oracle';
  if (/cisco/i.test(full)) return 'Cisco';
  if (/fortinet/i.test(full)) return 'Fortinet';
  if (/red\s*hat/i.test(full)) return 'Red Hat';
  // Fallback: trim corporate suffixes, take first two words.
  return full
    .replace(/,?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|or its affiliates).*$/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

function scoreEntry(entry: ManifestEntry, q: string): number {
  const id = entry.id.toLowerCase();
  const name = entry.n.toLowerCase();

  if (id === q) return 1000;
  if (name === q) return 500;
  for (const k of entry.k) {
    if (k.toLowerCase() === q) return 200;
  }
  if (name.startsWith(q)) return 100;
  for (const k of entry.k) {
    if (k.toLowerCase().startsWith(q)) return 50;
  }
  if (name.includes(q)) return 25;
  for (const k of entry.k) {
    if (k.toLowerCase().includes(q)) return 10;
  }
  return 0;
}
