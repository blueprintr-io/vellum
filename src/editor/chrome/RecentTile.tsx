import { useEffect, useState } from 'react';
import type { RecentEntry } from '@/store/editor';
import { useEditor } from '@/store/editor';
import { isMonochromeSvg } from '@/icons/recolorable';

/** A tile in the Recent tab — works in both MoreShapesPopover and LibraryPanel.
 *  Discriminated on `entry.source.kind` so the drag payload matches whatever
 *  picker originally produced the item:
 *    - 'library' → application/x-vellum-library
 *    - 'vendor' / 'iconify' → application/x-vellum-icon
 *
 *  Drag binding: React `onDragStart` (synthetic). Earlier revisions used a
 *  native `addEventListener('dragstart', …)` from a `useEffect` ref. That
 *  was the actual cause of the "doesn't work after refresh" report — `useEffect`
 *  fires AFTER the browser paints, but the JSX `draggable` attribute is live
 *  the moment React commits. After a refresh the editor's full mount queues a
 *  lot of effects; the button is draggable for several frames before its
 *  native listener attaches, and any drag started in that window has an empty
 *  dataTransfer. The synthetic `onDragStart` is wired into React's event-
 *  delegation root at `createRoot` time, so it's hot before the component
 *  ever paints. Inner `<img>`/`<svg>` getting `draggable={false}` plus a
 *  preventDefault is what actually keeps them from stealing the drag (matches
 *  the IconResultCard pattern). */
export function RecentTile({
  entry,
  onHover,
}: {
  entry: RecentEntry;
  onHover?: (hovered: boolean) => void;
}) {
  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    if (entry.source.kind === 'library') {
      e.dataTransfer.setData(
        'application/x-vellum-library',
        JSON.stringify({
          id: entry.source.libShapeId,
          label: entry.label,
          glyph: entry.glyph,
          lib: entry.source.libName,
        }),
      );
    } else if (entry.source.kind === 'vendor') {
      e.dataTransfer.setData(
        'application/x-vellum-icon',
        JSON.stringify({
          source: 'vendor',
          iconId: entry.source.iconId,
          vendor: entry.source.vendor,
        }),
      );
    } else {
      e.dataTransfer.setData(
        'application/x-vellum-icon',
        JSON.stringify({
          source: 'iconify',
          iconId: entry.source.iconId,
          prefix: entry.source.prefix,
        }),
      );
    }
    e.dataTransfer.setData('text/plain', entry.label);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      title={`${entry.label} — drag to canvas`}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-grab active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center font-mono text-[10px] font-bold text-accent overflow-hidden">
        <RecentPreview entry={entry} />
      </div>
      <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
        {entry.label}
      </span>
    </button>
  );
}

/** Per-source preview. Iconify gets a real SVG via the public API; vendor
 *  tiles lazy-load the pack and inline the SVG; library tiles fall back to
 *  the glyph shorthand. Inner `<img>` and `<svg>` get `draggable={false}` +
 *  `onDragStart=preventDefault` so the browser doesn't elect them as the
 *  drag source — same trick IconResultCard uses (and the only one that
 *  actually works reliably across refreshes; pointer-events:none did not). */
function RecentPreview({ entry }: { entry: RecentEntry }) {
  // Theme drives the in-tile recolour for monochrome icons — same logic as
  // IconResultCard. The Recent panel previously hard-baked black-on-dark for
  // monochrome iconify and was invisible in dark mode.
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';
  if (entry.source.kind === 'iconify') {
    // Iconify's API accepts `?color=` to override `currentColor` references
    // at render time. Multi-colour icons ignore the param, so it's safe to
    // apply universally — but we only need the recolour in dark mode (light
    // mode's tile background is light, so default-black is already legible).
    const tintParam = dark ? '?color=%23ffffff' : '';
    const url = `https://api.iconify.design/${entry.source.prefix}/${
      entry.source.iconId.split(':')[1] ?? ''
    }.svg${tintParam}`;
    return (
      <img
        src={url}
        alt={entry.label}
        width={28}
        height={28}
        // Critical: `<img>` is natively draggable. Without these two it can
        // win the dragstart race over the parent button after a refresh.
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        loading="lazy"
        className="block"
      />
    );
  }
  if (entry.source.kind === 'vendor') {
    // Lazy-load the vendor pack and render the actual SVG so the recent tile
    // is recognisable instead of a 3-letter glyph. Falls back to glyph if the
    // pack fails to load.
    return <VendorPreview entry={entry} dark={dark} />;
  }
  return <span>{entry.glyph}</span>;
}

function VendorPreview({ entry, dark }: { entry: RecentEntry; dark: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (entry.source.kind !== 'vendor') return;
    let cancelled = false;
    // Dynamic import keeps the recent-tile bundle skinny — most users won't
    // have any vendor entries, no reason to ship the pack loader to them.
    import('@/icons/manifest')
      .then(async (m) => {
        const pack = await m.loadVendorPack(
          (entry.source as { vendor: string }).vendor,
        );
        if (cancelled) return;
        const icon = pack.icons.find(
          (i) => i.id === (entry.source as { iconId: string }).iconId,
        );
        if (icon) setSvg(icon.svg);
      })
      .catch(() => {
        // Stay on the glyph fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);
  if (svg) {
    // Picker-only recolour for monochrome vendor SVGs in dark mode — same
    // safety net as IconResultCard. The on-canvas vendor SVG is unchanged
    // (vendor icons are never recoloured outside the picker).
    const rendered =
      dark && isMonochromeSvg(svg) ? recolorBlackToCurrent(svg) : svg;
    return (
      <span
        className="block w-7 h-7 [&>svg]:w-full [&>svg]:h-full [&_svg]:pointer-events-none"
        style={{ color: 'var(--fg)' }}
        // Inner SVG nodes sit inside the button — pointer-events:none on the
        // svg itself keeps the button as the drag source. (We can't put
        // draggable=false on the dangerouslySetInnerHTML root from out here.)
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
    );
  }
  return <span>{entry.glyph}</span>;
}

/** Picker-only recolour helper — same one IconResultCard uses. Replaces
 *  hard-coded black fills/strokes with `currentColor` so the wrapper's
 *  inline `color` propagates through. Only ever called on already-confirmed
 *  monochrome SVGs, so multi-colour brand assets are untouched. */
function recolorBlackToCurrent(svg: string): string {
  return svg
    .replace(/fill\s*=\s*"(#000|#000000|black)"/gi, 'fill="currentColor"')
    .replace(/fill\s*=\s*'(#000|#000000|black)'/gi, "fill='currentColor'")
    .replace(/stroke\s*=\s*"(#000|#000000|black)"/gi, 'stroke="currentColor"')
    .replace(/stroke\s*=\s*'(#000|#000000|black)'/gi, "stroke='currentColor'");
}
