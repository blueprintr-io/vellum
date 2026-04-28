/* Mini icon-search flyout for the container "+" affordance.
 *
 * Click the "+" on an empty selected container → this flyout opens anchored
 * to the click point, the user types/picks an icon, and we attach the icon
 * as the container's anchored child in one history step.
 *
 * Two design notes:
 *
 * 1. Click-to-pick semantics. The general icon library (LibraryPanel,
 *    MoreShapesPopover, IconSearchResults / IconResultCard) is drag-and-drop
 *    only — that's the right default for free placement on the canvas. But
 *    inside a container, the destination is unambiguous: the icon goes in
 *    THIS container. Drag would be busywork; click is the natural verb.
 *    We render our own simplified result tiles here rather than threading
 *    a pick-callback through IconResultCard, since the visual treatment is
 *    different (smaller, no license badges — those live on the container's
 *    inspector once the icon is attached).
 *
 * 2. Portal + fixed positioning. Shape lives inside the canvas SVG, where
 *    we can't render HTML chrome. The flyout portals to document.body and
 *    positions itself in screen-space at the click coords (clamped to the
 *    viewport so it never spills off-screen). */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, newId } from '@/store/editor';
import { useIconSearch } from '@/icons/useIconSearch';
import { resolveIcon } from '@/icons/resolve';
import { loadVendorPack } from '@/icons/manifest';
import { isMonochromeSvg } from '@/icons/recolorable';
import type { IconDragPayload } from '@/icons/types';
import type { Shape } from '@/store/types';
import { I } from '../icons';

const FLYOUT_W = 300;
const FLYOUT_H = 360;
const VIEWPORT_PAD = 8;

type Props = {
  containerId: string;
  /** Anchor point in screen coords (clientX/clientY of the "+" click). */
  anchor: { x: number; y: number };
  onClose: () => void;
};

export function ContainerIconFlyout({ containerId, anchor, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape to close. Defer attaching by a tick so the click
  // that opened us doesn't immediately close us via outside-click on its own
  // bubble path.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp the flyout into the viewport. We anchor below+right of the click
  // point by default; if that runs off-screen, flip to the opposite side.
  const position = useMemo(() => {
    if (typeof window === 'undefined') return { left: anchor.x, top: anchor.y };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y + 12;
    if (left + FLYOUT_W + VIEWPORT_PAD > vw) {
      left = Math.max(VIEWPORT_PAD, vw - FLYOUT_W - VIEWPORT_PAD);
    }
    if (top + FLYOUT_H + VIEWPORT_PAD > vh) {
      // Not enough room below — flip above the anchor.
      top = Math.max(VIEWPORT_PAD, anchor.y - FLYOUT_H - 12);
    }
    return { left, top };
  }, [anchor]);

  const pick = async (payload: IconDragPayload, label: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveIcon(payload);
      const state = useEditor.getState();
      const container = state.diagram.shapes.find((s) => s.id === containerId);
      if (!container) {
        throw new Error('Container missing — was it deleted?');
      }

      // Two paths: REPLACE if the container already has an anchor icon
      // (this is the double-click-the-icon flow), ADD otherwise (the +
      // affordance on an empty container). Replace-in-place preserves
      // the existing icon's id, position, size, and any per-shape
      // overrides the user has set — only the iconSvg + attribution +
      // constraints change. That keeps connectors bound to the icon
      // intact and avoids re-laying-out the container's interior just
      // because the user wanted to swap the glyph.
      if (container.anchorId) {
        const existing = state.diagram.shapes.find(
          (s) => s.id === container.anchorId,
        );
        if (existing && existing.kind === 'icon') {
          state.updateShape(existing.id, {
            iconSvg: resolved.svg,
            iconAttribution: resolved.attribution,
            iconConstraints: resolved.constraints,
            // Reset stroke if the new icon's licence forbids recolouring
            // (vendor → lockColors=true). Leaving the prior tint would
            // be a quiet trademark violation, since vendor icons are
            // supposed to render in their baked-in colours.
            stroke:
              resolved.constraints.lockColors === true
                ? undefined
                : existing.stroke,
          });
          // Skip the recordRecent at the bottom of `pick` for replace —
          // the user is iterating on a single container, not adopting
          // a new icon onto the canvas, so polluting the Recent feed
          // with every iteration would be noise.
          onClose();
          setBusy(false);
          return;
        }
        // Anchor pointed at something we can't repaint (deleted, or a
        // non-icon shape). Fall through to ADD so the user gets a
        // working result instead of a silent no-op.
      }

      // Match `makeContainer` (in store/editor.ts) so the visual result of
      // "+ icon → flyout" is identical to "icon already on canvas →
      // wrapped in a container":
      //   - 40×40 anchor size for icons (ANCHOR_ICON_SIZE)
      //   - 12px padding from the container's top-left corner (PAD)
      // Centring the icon mid-container looked floaty and didn't leave
      // room for the label or any subsequent drop-ins; pinning to the
      // top-left mirrors what the user already sees when they convert
      // an existing icon into a container.
      const ANCHOR_ICON_SIZE = 40;
      const PAD = 12;
      const iconShape: Shape = {
        id: newId('icon'),
        kind: 'icon',
        x: container.x + PAD,
        y: container.y + PAD,
        w: ANCHOR_ICON_SIZE,
        h: ANCHOR_ICON_SIZE,
        layer: container.layer,
        parent: containerId,
        iconSvg: resolved.svg,
        iconAttribution: resolved.attribution,
        iconConstraints: resolved.constraints,
      };
      state.addShape(iconShape);
      // Pin the new icon as the container's anchor — this is what controls
      // label positioning and tells `containerAddIcon` to disappear, so the
      // user sees the "+" replaced with their chosen icon immediately.
      state.updateShape(containerId, { anchorId: iconShape.id });
      // Stamp the Recent feed so the icon shows up in the user's recent tab —
      // mirrors the canvas-drop path.
      const tail =
        payload.source === 'vendor'
          ? payload.iconId.split('/').pop() ?? payload.iconId
          : payload.iconId.split(':').pop() ?? payload.iconId;
      state.recordRecent({
        key:
          payload.source === 'vendor'
            ? `vendor:${payload.iconId}`
            : `iconify:${payload.iconId}`,
        label: label || tail,
        glyph: tail.slice(0, 3).toUpperCase(),
        source:
          payload.source === 'vendor'
            ? { kind: 'vendor', iconId: payload.iconId, vendor: payload.vendor }
            : {
                kind: 'iconify',
                iconId: payload.iconId,
                prefix: payload.prefix,
              },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load icon.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={wrapRef}
      className="float fixed z-[60] flex flex-col overflow-hidden"
      style={{
        left: position.left,
        top: position.top,
        width: FLYOUT_W,
        maxHeight: FLYOUT_H,
      }}
      onPointerDown={(e) => {
        // Don't let pointer events bubble up to the canvas — without this
        // the canvas treats the flyout interaction as a marquee start and
        // clears the container's selection out from under us.
        e.stopPropagation();
      }}
    >
      <div className="relative px-[10px] pt-[10px] pb-[8px] border-b border-border">
        <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none mt-px">
          <I.search />
        </span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search icons (aws, mdi, kubernetes…)"
          className="w-full pl-[30px] pr-[10px] py-[7px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-[8px] py-[8px]">
        <FlyoutResults query={query} onPick={pick} busy={busy} />
      </div>
      {error && (
        <div className="px-[10px] py-[6px] border-t border-sketch/40 bg-bg-subtle text-[11px] text-fg leading-snug">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Result grid — slim version of IconSearchResults. We render small click-to-
 *  pick tiles for vendor + iconify hits. No license badges (they live on the
 *  container's inspector once the icon is attached) and no vendor-stencil
 *  cards (the user already has a container; they want an icon NOW, not a
 *  detour to import a stencil pack). */
function FlyoutResults({
  query,
  onPick,
  busy,
}: {
  query: string;
  onPick: (payload: IconDragPayload, label: string) => void;
  busy: boolean;
}) {
  const { vendor, iconify, iconifyStatus, manifestReady } = useIconSearch(query);
  const previews = useVendorPreviews(vendor);
  // Theme-aware monochrome recolor — same trick IconResultCard uses for the
  // big library panel. Without this, monochrome SVGs (which paint in pure
  // black for vendor packs, or via `currentColor` for Iconify) render
  // black-on-dark in the picker tiles and become invisible. Vendor: swap
  // hard-coded black for `currentColor` only on confirmed-monochrome SVGs.
  // Iconify: pass `?color=` to its SVG endpoint so the server pre-tints
  // currentColor references for us. Multi-colour assets ignore both
  // transforms — the recolor regex only touches black, and Iconify's
  // colour param is a no-op for SVGs that don't reference currentColor.
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';

  if (!query.trim()) {
    return (
      <div className="px-2 py-6 text-center text-fg-muted text-[11px] leading-relaxed">
        Type to search vendor icons + Iconify.
        <br />
        <span className="text-[10px]">
          Picked icon attaches to this container.
        </span>
      </div>
    );
  }

  const hasResults = vendor.length > 0 || iconify.length > 0;
  // Iconify's per-icon SVG endpoint accepts a `color` query param that
  // recolours `currentColor` references at render time. Multi-colour
  // icons ignore it. We only override in dark mode — the default render
  // (black) is fine on the light tile background.
  const iconifyTintParam = dark ? '?color=%23ffffff' : '';

  return (
    <>
      {vendor.length > 0 && (
        <Section title="Vendor" count={vendor.length}>
          <div className="grid grid-cols-4 gap-1">
            {vendor.map(({ entry, vendor: v }) => {
              const rawSvg = previews.get(entry.id);
              const renderedSvg =
                rawSvg && dark && isMonochromeSvg(rawSvg)
                  ? recolorBlackToCurrent(rawSvg)
                  : rawSvg;
              return (
                <ResultTile
                  key={entry.id}
                  title={entry.n}
                  disabled={busy}
                  onClick={() =>
                    onPick(
                      { source: 'vendor', iconId: entry.id, vendor: entry.v },
                      entry.n,
                    )
                  }
                >
                  {renderedSvg ? (
                    <span
                      className="block w-7 h-7 [&>svg]:w-full [&>svg]:h-full"
                      style={{ color: 'var(--fg)' }}
                      dangerouslySetInnerHTML={{ __html: renderedSvg }}
                    />
                  ) : (
                    <span className="font-mono text-[10px] font-bold text-accent">
                      {v.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                </ResultTile>
              );
            })}
          </div>
        </Section>
      )}
      {iconify.length > 0 && (
        <Section title="Iconify" count={iconify.length}>
          <div className="grid grid-cols-4 gap-1">
            {iconify.map((r) => (
              <ResultTile
                key={r.id}
                title={`${r.name} — ${r.collection.name}`}
                disabled={busy}
                onClick={() =>
                  onPick(
                    { source: 'iconify', iconId: r.id, prefix: r.prefix },
                    r.name,
                  )
                }
              >
                <img
                  src={`https://api.iconify.design/${r.prefix}/${r.name}.svg${iconifyTintParam}`}
                  alt=""
                  width={24}
                  height={24}
                  loading="lazy"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              </ResultTile>
            ))}
          </div>
        </Section>
      )}
      {!hasResults && (
        <div className="px-2 py-6 text-center text-fg-muted text-[10px] font-mono">
          {iconifyStatus === 'loading' || !manifestReady
            ? 'searching…'
            : 'no matches'}
        </div>
      )}
    </>
  );
}

/** Picker-only recolour helper: swap hard-coded black fills/strokes with
 *  currentColor so the wrapper's `style={{ color: ... }}` reaches them.
 *  Mirrors the helper in IconResultCard — keeping a local copy avoids
 *  exporting a tiny sibling utility. Only called on already-confirmed
 *  monochrome SVGs (via isMonochromeSvg) so multi-colour brand assets
 *  are never touched. The original SVG (and the on-canvas drop) are
 *  untouched — this string is throwaway. */
function recolorBlackToCurrent(svg: string): string {
  return svg
    .replace(/fill\s*=\s*"(#000|#000000|black)"/gi, 'fill="currentColor"')
    .replace(/fill\s*=\s*'(#000|#000000|black)'/gi, "fill='currentColor'")
    .replace(/stroke\s*=\s*"(#000|#000000|black)"/gi, 'stroke="currentColor"')
    .replace(/stroke\s*=\s*'(#000|#000000|black)'/gi, "stroke='currentColor'");
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-[6px]">
      <div className="flex items-baseline justify-between px-[2px] pb-[4px]">
        <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
          {title}
        </span>
        <span className="text-[9px] font-mono text-fg-muted">{count}</span>
      </div>
      {children}
    </div>
  );
}

function ResultTile({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-[2px] py-[6px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 disabled:opacity-50 disabled:cursor-wait"
    >
      <div className="w-8 h-8 rounded-md bg-bg-subtle border border-border flex items-center justify-center overflow-hidden">
        {children}
      </div>
    </button>
  );
}

/** Lazy-loads vendor packs so the result tiles can render real previews. Tiny
 *  inline copy of IconSearchResults' helper — keeping it local avoids a wider
 *  refactor for what is one extra consumer. */
function useVendorPreviews(rows: { entry: { id: string; v: string } }[]) {
  const [packs, setPacks] = useState<Map<string, Map<string, string>>>(
    new Map(),
  );
  const neededVendors = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.entry.v);
    return [...s];
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    for (const v of neededVendors) {
      if (packs.has(v)) continue;
      loadVendorPack(v)
        .then((pack) => {
          if (cancelled) return;
          setPacks((prev) => {
            const next = new Map(prev);
            const m = new Map<string, string>();
            for (const ic of pack.icons) m.set(ic.id, ic.svg);
            next.set(v, m);
            return next;
          });
        })
        .catch(() => {
          /* fall back to glyph */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [neededVendors.join('|')]);

  return useMemo(() => {
    const out = new Map<string, string>();
    for (const m of packs.values()) {
      for (const [id, svg] of m) out.set(id, svg);
    }
    return out;
  }, [packs]);
}
