/* Vendor stencil pack hit — rendered when a query matches the vendor-keyword
 * catalog (see src/icons/vendor-stencils.ts).
 *
 * Two states, branched on `loaded`:
 *
 *   loaded: true  → "Already in your library" badge, no action.
 *                   Phase 2: hook this up to switch the LibraryPanel tab to
 *                   the vendor's library when clicked.
 *
 *   loaded: false → "Download stencil pack" CTA opening the official source
 *                   in a new tab. Phase 2: when import is wired, this becomes
 *                   a one-click "fetch + import" instead of a hand-off.
 *
 * Visually distinct from icon result cards (full-width row, not a grid tile)
 * so the user reads it as a different KIND of result — a place to go, not a
 * shape to drag onto the canvas. */

import type { VendorStencilMatch } from '@/icons/useIconSearch';

type Props = {
  match: VendorStencilMatch;
};

export function VendorStencilCard({ match }: Props) {
  const { entry, loaded } = match;

  if (loaded) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-[7px] rounded-md border border-border bg-bg-subtle"
        title={`${entry.name} stencils are already loaded`}
      >
        <VendorMonogram name={entry.name} />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-fg leading-tight truncate">
            {entry.name}
          </div>
          <div className="text-[10px] text-fg-muted leading-tight">
            Already in your library
          </div>
        </div>
        <span className="text-[9px] font-mono text-accent tracking-[0.04em] uppercase shrink-0">
          ✓ loaded
        </span>
      </div>
    );
  }

  // Not loaded → CTA out to the official stencil page.
  const href = entry.stencilUrl;
  const className =
    'flex items-center gap-2 px-2 py-[7px] rounded-md border border-border bg-bg-subtle hover:bg-bg-emphasis hover:border-accent/40 transition-colors duration-100';

  const body = (
    <>
      <VendorMonogram name={entry.name} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-fg leading-tight truncate">
          {entry.name}
        </div>
        <div className="text-[10px] text-fg-muted leading-tight">
          {href ? 'Download official stencil pack' : 'Stencil pack — source TBD'}
        </div>
      </div>
      <span className="text-[9px] font-mono text-fg-muted tracking-[0.04em] uppercase shrink-0">
        {href ? '↗ open' : '—'}
      </span>
    </>
  );

  if (!href) {
    return (
      <div className={className} title={`${entry.name} — no stencil URL on file`}>
        {body}
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={`${entry.name} — open official stencil pack page`}
    >
      {body}
    </a>
  );
}

/** Square monogram used as a placeholder vendor mark. We deliberately don't
 *  render the vendor's actual logo here — that's a trademark surface we
 *  don't want to ship inline. The first 1–2 chars of the vendor name read
 *  fine and stay legally neutral. */
function VendorMonogram({ name }: { name: string }) {
  const mono = monogramOf(name);
  return (
    <div className="w-7 h-7 rounded-md bg-bg border border-border flex items-center justify-center shrink-0">
      <span className="font-mono text-[10px] font-bold text-accent">{mono}</span>
    </div>
  );
}

function monogramOf(name: string): string {
  // Special-cases for hyperscalers everyone reads at-a-glance.
  if (/^amazon web services/i.test(name)) return 'AWS';
  if (/^microsoft azure/i.test(name)) return 'AZ';
  if (/^google cloud/i.test(name)) return 'GC';
  if (/^oracle cloud/i.test(name)) return 'OCI';
  if (/^ibm cloud/i.test(name)) return 'IBM';
  if (/^alibaba cloud/i.test(name)) return 'ALI';
  // Generic fallback: first letter of each word, max 3 chars.
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
}
