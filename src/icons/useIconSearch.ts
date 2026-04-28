/* The single hook the IconSearchPanel binds to.
 *
 * Three parallel searches:
 *   - `vendor` runs synchronously against the in-memory manifest on every
 *     keystroke. Sub-5ms at our catalog size.
 *   - `vendorStencils` runs synchronously against the static vendor-keyword
 *     catalog (vendor-stencils.ts) on every keystroke; identifies queries
 *     like "aws" / "amazon web services" / "fortinet" and surfaces a card
 *     leading to either the loaded library or the official stencil pack.
 *   - `iconify` is debounced 300ms, AbortController-cancellable, and degrades
 *     to a distinct 'offline' state when navigator.onLine is false (different
 *     from a generic error so the UI can render it differently).
 *
 * The hook owns the debouncer + abort controller so the panel doesn't need
 * to. Manifest loading is fired on mount; if it's still pending the vendor
 * results are empty, which the panel renders as a tiny skeleton.
 *
 * NOTE: This hook is intentionally not memoised across panel mounts. The
 * panel is opened/closed often; re-running search on remount is cheaper than
 * keeping a stale debouncer alive. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { getManifest, loadManifest, searchManifest } from './manifest';
import { searchIconify } from './iconify';
import { matchVendors, type VendorStencilEntry } from './vendor-stencils';
import type {
  IconifyResult,
  ManifestEntry,
  ManifestVendor,
} from './types';

export type IconifyStatus = 'idle' | 'loading' | 'error' | 'offline';

export type VendorRow = { entry: ManifestEntry; vendor: ManifestVendor };

/** Vendor stencil pack match. `loaded` means the bundled manifest already
 *  contains a pack for this vendor (so the UI can offer "Open library"
 *  instead of "Download stencil pack"). The `manifestKey` is the vendor's
 *  key within the manifest — undefined when `loaded` is false. */
export type VendorStencilMatch = {
  entry: VendorStencilEntry;
  loaded: boolean;
  manifestKey?: string;
};

const ICONIFY_DEBOUNCE_MS = 300;
const ICONIFY_MIN_QUERY = 2;

export function useIconSearch(query: string) {
  const [vendor, setVendor] = useState<VendorRow[]>([]);
  const [iconify, setIconify] = useState<IconifyResult[]>([]);
  const [iconifyStatus, setIconifyStatus] = useState<IconifyStatus>('idle');
  const [manifestReady, setManifestReady] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Vendor stencil matches — synchronous, derived from the static keyword
  // catalog. Re-evaluates whenever the query OR the manifest readiness
  // flips (the `loaded` flag depends on the manifest). Cheap enough to
  // recompute every render via useMemo — no state needed.
  const vendorStencils = useMemo<VendorStencilMatch[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const hits = matchVendors(q);
    if (hits.length === 0) return [];
    const m = manifestReady ? getManifest() : null;
    return hits.map((entry) => {
      const manifestKey = m ? findManifestVendorKey(m.vendors, entry) : undefined;
      return { entry, loaded: !!manifestKey, manifestKey };
    });
    // FUTURE(shape-name → vendor): when the manifest search returns hits,
    // walk the vendor keys of those hits and merge them into this list so
    // a "transit gateway" query also surfaces an AWS stencil card. Keep
    // dedup on entry.id and prefer the keyword-matched entry's loaded flag.
  }, [query, manifestReady]);

  // Kick the manifest fetch on first mount. Idempotent — repeat mounts hit
  // the cache.
  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then(() => {
        if (!cancelled) setManifestReady(true);
      })
      .catch(() => {
        if (!cancelled) setManifestReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Local search — synchronous, every keystroke.
  useEffect(() => {
    if (!manifestReady) {
      setVendor([]);
      return;
    }
    const q = query.trim();
    if (!q) {
      setVendor([]);
      return;
    }
    // Limit was 24 when the bundled catalog was a single ~300-icon AWS pack.
    // After the AWS pack split into four collapsible sub-packs (service /
    // resource / group / category — total ~810 icons), 24 was too tight: a
    // search for "ec2" landed maybe 6 results in each of the two relevant
    // sub-packs and silently truncated the rest. Bumped to 80 so each
    // sub-pack typically has room to show its full match list. The
    // collapsible bands in IconSearchResults keep the long lists out of the
    // way when the user only cares about one pack.
    setVendor(searchManifest(q, 80));
  }, [query, manifestReady]);

  // Iconify search — debounced + cancellable.
  useEffect(() => {
    const q = query.trim();
    if (q.length < ICONIFY_MIN_QUERY) {
      setIconify([]);
      setIconifyStatus('idle');
      return;
    }

    setIconifyStatus('loading');
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const t = window.setTimeout(async () => {
      try {
        const results = await searchIconify(q, 32, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setIconify(results);
        setIconifyStatus('idle');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setIconifyStatus(navigator.onLine ? 'error' : 'offline');
      }
    }, ICONIFY_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  return { vendor, vendorStencils, iconify, iconifyStatus, manifestReady };
}

/** Resolve a VendorStencilEntry to a manifest vendor key, if one exists.
 *
 *  The vendor-stencils catalog uses our own short ids ("aws", "fortinet").
 *  The manifest's vendor keys are independent — they're whatever the build
 *  script emits. Match strategy, in order:
 *    1. exact id match against a manifest vendor key (case-insensitive)
 *    2. exact name match against ManifestVendor.name (case-insensitive)
 *    3. any vendor-stencil keyword equals a manifest key (case-insensitive)
 *    4. PREFIX match — e.g. the AWS stencil entry has id "aws" but the
 *       bundled catalog now ships four sub-packs ("aws-service",
 *       "aws-resource", "aws-group", "aws-category"). Without this rule a
 *       user searching "aws" would get the "download the stencil pack"
 *       card even though one of the sub-packs is already loaded. The first
 *       prefix-matching key wins; in practice that's "aws-service" because
 *       the build script emits in alphabetical order.
 *
 *  Returns the matching manifest key, or undefined for "not loaded". */
function findManifestVendorKey(
  vendors: Record<string, ManifestVendor>,
  entry: VendorStencilEntry,
): string | undefined {
  const keys = Object.keys(vendors);
  const idLc = entry.id.toLowerCase();
  const nameLc = entry.name.toLowerCase();

  for (const k of keys) {
    if (k.toLowerCase() === idLc) return k;
  }
  for (const k of keys) {
    if (vendors[k].name.toLowerCase() === nameLc) return k;
  }
  const kwSet = new Set(entry.keywords.map((s) => s.toLowerCase()));
  for (const k of keys) {
    if (kwSet.has(k.toLowerCase())) return k;
  }
  // Hyphenated sub-pack prefix match (`aws` → `aws-service`).
  const hyphenPrefix = idLc + '-';
  for (const k of keys) {
    if (k.toLowerCase().startsWith(hyphenPrefix)) return k;
  }
  return undefined;
}
