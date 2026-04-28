// TRADEMARK-COMPLIANCE: vendor + branded-iconify cards now render the
// two-line "SVG: <license> · Brand: <holder>®" badge through
// IconLicenseBadge. Generic iconify rows keep the single-license chip.

/* Single result card — drag source for both vendor and iconify rows.
 *
 * The drag payload is a tiny IconDragPayload (id + source); the canvas drop
 * handler resolves the actual SVG bytes via `resolveIcon`. This keeps the
 * dataTransfer payload small and lets us share one drop branch across all
 * icon sources.
 *
 * Two visual treatments:
 *   - vendor cards get a small ™ chip with the vendor short name; the chip
 *     links to brand guidelines.
 *   - iconify cards get an SPDX chip linking to the license.
 *
 * For the preview we render the SVG via dangerouslySetInnerHTML inside a
 * fixed-size frame. Vendor SVGs are sanitized at build time; iconify SVGs
 * are sanitized in `resolveIcon` before they're embedded on the canvas.
 * Search-time previews come from /api.iconify.design/<prefix>/<name>.svg
 * via the ICONIFY_PREVIEW_URL helper — fetched once and inlined as an <img>
 * (img tag prevents script execution by spec, so we don't need a sanitizer
 * for the preview specifically). */

import type { IconifyResult } from '@/icons/types';
import type { ManifestEntry, ManifestVendor } from '@/icons/types';
import { useEditor } from '@/store/editor';
import { isMonochromeSvg } from '@/icons/recolorable';
import { IconLicenseBadge } from './IconLicenseBadge';

type VendorProps = {
  source: 'vendor';
  entry: ManifestEntry;
  vendor: ManifestVendor;
  /** Resolved SVG markup for the preview. Optional — until the pack is
   *  loaded we render a glyph placeholder (vendor short + name initial). */
  previewSvg?: string;
};

type IconifyProps = {
  source: 'iconify';
  result: IconifyResult;
};

type Props = (VendorProps | IconifyProps) & {
  /** Optional callback for hover — used by the parent to show a tooltip /
   *  enable a 1–9 binding hotkey, mirroring LibraryPanel's pattern. */
  onHover?: (hovered: boolean) => void;
};

export function IconResultCard(props: Props) {
  // Theme drives the in-tile recolour for monochrome icons. The picker tile
  // is on a dark `bg-bg-subtle` (≈#161b22) in dark mode — black-on-black
  // monochrome icons render essentially invisible. We push currentColor /
  // tile-fg into the SVG so the user can actually see what they're picking.
  // (This is purely a *picker* visibility tweak — once the icon is dropped on
  // the canvas the normal vendor-never / iconify-monochrome-only colour
  // rules in Shape.tsx still apply.)
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';

  const onDragStart = (e: React.DragEvent) => {
    if (props.source === 'vendor') {
      const payload = {
        source: 'vendor' as const,
        iconId: props.entry.id,
        vendor: props.entry.v,
      };
      e.dataTransfer.setData(
        'application/x-vellum-icon',
        JSON.stringify(payload),
      );
      e.dataTransfer.setData('text/plain', props.entry.n);
    } else {
      const payload = {
        source: 'iconify' as const,
        iconId: props.result.id,
        prefix: props.result.prefix,
      };
      e.dataTransfer.setData(
        'application/x-vellum-icon',
        JSON.stringify(payload),
      );
      e.dataTransfer.setData('text/plain', props.result.name);
    }
    e.dataTransfer.effectAllowed = 'copy';
  };

  if (props.source === 'vendor') {
    const { entry, vendor, previewSvg } = props;
    // Monochrome vendor SVGs (e.g. plain logo glyphs) are usually painted with
    // hard-coded black — invisible in dark mode. Repaint them with the tile's
    // foreground colour for the *picker only* by swapping black fills/strokes
    // to currentColor before injection. Multi-colour vendor icons are left
    // alone so brand colours stay intact. The drag payload + on-canvas SVG
    // resolution path is unchanged — this is purely cosmetic for the tile.
    const renderedSvg =
      previewSvg && dark && isMonochromeSvg(previewSvg)
        ? recolorBlackToCurrent(previewSvg)
        : previewSvg;
    return (
      <button
        draggable
        onDragStart={onDragStart}
        onMouseEnter={() => props.onHover?.(true)}
        onMouseLeave={() => props.onHover?.(false)}
        title={`${entry.n} — drag to canvas`}
        className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-grab active:cursor-grabbing"
      >
        <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center overflow-hidden">
          {renderedSvg ? (
            <span
              className="block w-7 h-7 [&>svg]:w-full [&>svg]:h-full"
              style={{ color: 'var(--fg)' }}
              // Pack SVGs are sanitized at build time before reaching here.
              dangerouslySetInnerHTML={{ __html: renderedSvg }}
            />
          ) : (
            <span className="font-mono text-[10px] font-bold text-accent">
              {vendor.name.slice(0, 1)}
            </span>
          )}
        </div>
        <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
          {entry.n}
        </span>
        <IconLicenseBadge
          tone="vendor"
          short={shortVendorName(vendor.name)}
          guidelinesUrl={vendor.trademark.guidelinesUrl}
          size="xs"
        />
      </button>
    );
  }

  const { result } = props;
  // Iconify hosts a per-icon SVG endpoint we can use as a preview src — the
  // <img> wrapper prevents script execution by spec.
  //
  // Dark-mode visibility: most Iconify monochrome icons paint with
  // `currentColor`, which the standalone <img> resolves to its own default
  // (black) — invisible on the dark tile. The Iconify API accepts a `?color=`
  // query parameter that recolours `currentColor` references at render time.
  // Multi-colour icons (icons that don't reference currentColor) ignore the
  // param, so it's safe to apply universally.
  const tintParam = dark ? '?color=%23ffffff' : '';
  const previewUrl = `https://api.iconify.design/${result.prefix}/${result.name}.svg${tintParam}`;
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onMouseEnter={() => props.onHover?.(true)}
      onMouseLeave={() => props.onHover?.(false)}
      title={`${result.name} — ${result.collection.name}`}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-grab active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center overflow-hidden">
        <img
          src={previewUrl}
          alt={result.name}
          width={28}
          height={28}
          // Iconify previews are remote — drop the drag of the <img> itself
          // so only the parent card's drag fires.
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          loading="lazy"
          className="block"
        />
      </div>
      <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
        {result.name}
      </span>
      <IconLicenseBadge
        tone="iconify"
        spdx={result.collection.license.spdx}
        url={result.collection.license.url}
        branded={result.branded}
        brandHolder={result.brandHolder}
        size="xs"
      />
    </button>
  );
}

/** Picker-only recolour helper: swap hard-coded black fills/strokes with
 *  currentColor so the wrapper's `style={{ color: ... }}` reaches them. We
 *  ONLY call this on already-isMonochromeSvg-confirmed markup, so we don't
 *  trample multi-colour brand assets. The original SVG (and the on-canvas
 *  drop) are untouched — this string is throwaway and never persisted. */
function recolorBlackToCurrent(svg: string): string {
  return svg
    .replace(/fill\s*=\s*"(#000|#000000|black)"/gi, 'fill="currentColor"')
    .replace(/fill\s*=\s*'(#000|#000000|black)'/gi, "fill='currentColor'")
    .replace(/stroke\s*=\s*"(#000|#000000|black)"/gi, 'stroke="currentColor"')
    .replace(/stroke\s*=\s*'(#000|#000000|black)'/gi, "stroke='currentColor'");
}

/** Crude vendor-name short form. Beats threading another field through the
 *  manifest just for chip text. */
function shortVendorName(full: string): string {
  if (full.startsWith('Amazon Web Services')) return 'AWS';
  if (full.startsWith('Google Cloud')) return 'GCP';
  if (full.startsWith('Microsoft Azure')) return 'Azure';
  // Fallback: first letter of each word, max 4 chars.
  return full
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 4)
    .toUpperCase();
}
