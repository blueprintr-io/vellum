// TRADEMARK-COMPLIANCE: iconify results are stamped with `branded` /
// `brandHolder` at search time so the picker can render the two-line
// "SVG: <license> · Brand: <holder>®" badge for vendor logos. Detection
// uses the wholesale-brand collection list + namespace prefixes in
// src/lib/branded-icon-namespaces.ts.

/* Iconify API wrapper.
 *
 * The public API at https://api.iconify.design — no auth, fair-use rate
 * limits, wide-open CORS. We hit two endpoints:
 *
 *   GET /search?query=...&limit=...    — icon search. Critically, the response
 *                                        includes a top-level `collections`
 *                                        block with license metadata for every
 *                                        prefix that appears in the results.
 *                                        We pull license info from THAT — no
 *                                        second HTTP call needed.
 *   GET /<prefix>/<name>.svg           — fetched at drop time only.
 *
 * Caching:
 *   - Search results: in-memory only. localStorage was tempting but added bug
 *     surface — collections need to be re-derived on cold replays, and the
 *     search endpoint is fast and free anyway. Re-add it later if profiling
 *     shows we're hammering the API.
 *   - Collection metadata: in-memory, persists for the session. Each search
 *     refreshes / fills it from the inline `collections` block.
 *   - SVG bytes: in-memory, populated at drop time. */

import type { IconifyCollection, IconifyResult } from './types';
import { detectBranded } from '@/lib/branded-icon-namespaces';

const SEARCH_URL = 'https://api.iconify.design/search';
const ICON_BASE = 'https://api.iconify.design';

/** Network defaults for the iconify fetch path. iconify.design is a third-
 *  party trust boundary; cap response size and time so a slow / hostile
 *  endpoint can't tie up resources or exhaust memory. */
const FETCH_TIMEOUT_MS = 8000;
const MAX_SVG_BYTES = 256 * 1024; // 256 KiB — well above any legitimate icon
const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MiB — search responses can be big

const _searchMem = new Map<string, IconifyResult[]>();
const _collectionMem = new Map<string, IconifyCollection>();
const _svgMem = new Map<string, string>();

/** Fetch with a hard timeout. Composes the caller's signal with a timeout
 *  signal so either trigger aborts the request. */
async function fetchWithTimeout(
  url: string,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  const onCallerAbort = () => ctrl.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Read a Response body as text, rejecting if it exceeds `maxBytes`. */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxBytes) {
    throw new Error(`response too large: ${cl} > ${maxBytes}`);
  }
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`response too large: ${text.length} > ${maxBytes}`);
  }
  return text;
}

/** Shape of the /search response. Iconify's TS bindings exist in
 *  @iconify/types but adding the dep just for this isn't worth it. The
 *  fields we read are stable and have been since v3 of the API. */
type SearchResponse = {
  icons: string[];
  total: number;
  limit: number;
  start: number;
  collections: Record<string, RawCollection>;
};

type RawCollection = {
  name: string;
  total?: number;
  version?: string;
  author?: { name?: string; url?: string } | string;
  license?: { title?: string; spdx?: string; url?: string };
};

export async function searchIconify(
  query: string,
  limit = 32,
  signal?: AbortSignal,
): Promise<IconifyResult[]> {
  const key = `${query}::${limit}`;
  const memHit = _searchMem.get(key);
  if (memHit) return memHit;

  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetchWithTimeout(url, signal);
  if (!res.ok) throw new Error(`iconify search failed: ${res.status}`);
  const text = await readTextCapped(res, MAX_JSON_BYTES);
  const data = JSON.parse(text) as Partial<SearchResponse>;

  // Hydrate the collection cache from the inline `collections` block. If
  // it's missing for some reason, every row will fall back to a synthetic
  // "Unknown" collection rather than being dropped — that way the user can
  // still see / use the icon and we don't silently filter results.
  if (data.collections) {
    for (const [prefix, raw] of Object.entries(data.collections)) {
      _collectionMem.set(prefix, normalizeCollection(prefix, raw));
    }
  }

  const ids = data.icons ?? [];
  const out: IconifyResult[] = [];
  for (const id of ids) {
    const [prefix, name] = id.split(':');
    if (!prefix || !name) continue;
    const collection = _collectionMem.get(prefix) ?? unknownCollection(prefix);
    const verdict = detectBranded({
      id,
      name,
      tags: [collection.name],
      iconifyPrefix: prefix,
    });
    out.push({
      id,
      prefix,
      name,
      collection,
      branded: verdict.branded,
      brandHolder: verdict.holder,
    });
  }

  _searchMem.set(key, out);
  return out;
}

function normalizeCollection(prefix: string, raw: RawCollection): IconifyCollection {
  const author =
    typeof raw.author === 'string'
      ? raw.author
      : raw.author?.name ?? 'Unknown';
  return {
    prefix,
    name: raw.name,
    author,
    license: {
      spdx: raw.license?.spdx ?? raw.license?.title ?? 'Unknown',
      url: raw.license?.url ?? '',
    },
  };
}

function unknownCollection(prefix: string): IconifyCollection {
  return {
    prefix,
    name: prefix,
    author: 'Unknown',
    license: { spdx: 'Unknown', url: '' },
  };
}

/** Fetch the SVG bytes for one Iconify icon. Cached for the session. */
export async function fetchIconifySvg(id: string): Promise<string> {
  const cached = _svgMem.get(id);
  if (cached) return cached;
  const [prefix, name] = id.split(':');
  if (!prefix || !name) throw new Error(`bad iconify id: ${id}`);
  // Cheap shape check before hitting the network — keeps junk ids from
  // touching the API and short-circuits some path-traversal-ish payloads.
  if (!/^[a-z0-9-]+$/i.test(prefix) || !/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`bad iconify id: ${id}`);
  }
  const url = `${ICON_BASE}/${prefix}/${name}.svg`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`iconify svg fetch failed: ${res.status}`);
  const svg = await readTextCapped(res, MAX_SVG_BYTES);
  _svgMem.set(id, svg);
  return svg;
}

/** Cached collection lookup — populated by `searchIconify`. Used by
 *  AttributionsPanel and resolveIcon. Returns undefined if the prefix
 *  hasn't been seen via search yet. Callers that NEED a result (e.g. drop-
 *  time icon resolution from Recent after a refresh, when the search cache
 *  hasn't been rehydrated) should use `ensureCollection` instead. */
export function getCollection(prefix: string): IconifyCollection | undefined {
  return _collectionMem.get(prefix);
}

/** In-flight de-dup for `ensureCollection` so concurrent drops on the same
 *  prefix only fire one network request. */
const _collectionInFlight = new Map<string, Promise<IconifyCollection>>();

/** Cache-or-fetch collection metadata. Used at icon-drop time so that
 *  dragging a Recent iconify entry after a refresh works without requiring
 *  the user to search the same collection again first.
 *
 *  Strategy:
 *   1. Hot cache (populated by `searchIconify`) → return immediately.
 *   2. Otherwise hit `/collection?prefix=<x>` to fetch metadata for just
 *      this collection (cheap; single small JSON response). On success,
 *      cache + return.
 *   3. On network failure or unknown prefix, return a synthetic
 *      "Unknown"-attribution collection so the drop still completes.
 *      Attribution is degraded but the user gets their icon, which is
 *      what they actually asked for. */
export async function ensureCollection(prefix: string): Promise<IconifyCollection> {
  const cached = _collectionMem.get(prefix);
  if (cached) return cached;
  const inflight = _collectionInFlight.get(prefix);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<IconifyCollection> => {
    try {
      const url = `${ICON_BASE}/collection?prefix=${encodeURIComponent(prefix)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`collection fetch ${prefix}: ${res.status}`);
      // The /collection endpoint returns a richer payload than the inline
      // `collections` block from /search, but the fields we need (name,
      // author, license) live at the same top-level keys.
      const text = await readTextCapped(res, MAX_JSON_BYTES);
      const raw = JSON.parse(text) as RawCollection & {
        name?: string;
      };
      const normalized = normalizeCollection(prefix, raw);
      _collectionMem.set(prefix, normalized);
      return normalized;
    } catch {
      // Anything goes wrong — fall back to Unknown. Don't cache so a future
      // attempt has a chance to succeed once the network recovers.
      return unknownCollection(prefix);
    } finally {
      _collectionInFlight.delete(prefix);
    }
  })();

  _collectionInFlight.set(prefix, fetchPromise);
  return fetchPromise;
}
