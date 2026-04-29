// TRADEMARK-COMPLIANCE: footer now exposes "About" (library credits),
// "Report an issue" (IP complaints), and "+ Load" (Tier 2 import) links.
// All three are user-visible compliance surfaces required by the spec.

import { useState } from 'react';
import { useEditor } from '@/store/editor';
import { I } from './icons';
import { LIBRARIES, type Library } from './libraries';
import { IconSearchResults } from './icons/IconSearchResults';
import { IconPacksBrowser } from './IconPacksBrowser';
import { LibraryShapeTile } from './LibraryShapeTile';
import { RecentTile } from './RecentTile';

/** Sentinel tab id for the Icon Packs browser. Mirrors MoreShapesPopover so
 *  the two surfaces use the same magic id — pulled inline (rather than
 *  exported from a shared module) since it's two lines and exporting one
 *  string for two callers is more ceremony than it earns. */
const ICON_PACKS_TAB = '__iconpacks__';

/** Persistent left-rail library card. Surfaces the same catalog as
 *  MoreShapesPopover but as a tall, dwellable panel — the muscle memory is
 *  draw.io's left sidebar, while the popover stays for quick "1-key, drop"
 *  flows. Toggled from the Brand expand button.
 *
 *  Implementation choices:
 *  - Tabs at the top (scrolls horizontally) match the popover so users don't
 *    relearn library navigation when they move between surfaces.
 *  - 3-column grid below — the panel's narrower than the popover, but the
 *    extra height earns more rows so the tradeoff is fine.
 *  - Drag payloads are byte-identical to the popover's so existing onDrop
 *    handlers in Canvas don't need a new branch. */
export function LibraryPanel() {
  const open = useEditor((s) => s.libraryPanelOpen);
  const setOpen = useEditor((s) => s.setLibraryPanelOpen);
  const personal = useEditor((s) => s.personalLibrary);
  // Recent feed — populated by Canvas drop handlers.
  const recentShapes = useEditor((s) => s.recentShapes);
  const clearRecent = useEditor((s) => s.clearRecent);
  // TRADEMARK-COMPLIANCE — footer-link handlers.
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);

  const [tab, setTab] = useState('recent');
  const [q, setQ] = useState('');

  // Synthetic Personal lib derived from persisted slice (same shape as the
  // popover so the search-across-libs path stays consistent).
  // version is intentionally blank — the "local" badge was redundant chrome
  // (everything Personal is local) and consumed tab-strip width that's now
  // needed for the Icon Packs entry.
  const personalLib: Library = {
    id: 'personal',
    name: 'Personal',
    version: '',
    shapes: personal.map((p, i) => ({
      id: `personal-${i}`,
      label: p.label,
      glyph: p.glyph,
    })),
  };
  const allLibraries = [...LIBRARIES, personalLib];

  if (!open) return null;

  const lib = allLibraries.find((l) => l.id === tab) ?? allLibraries[0];
  const shapes = (
    q
      ? allLibraries.flatMap((l) =>
        l.shapes.map((s) => ({ ...s, _lib: l.name })),
      )
      : lib.shapes.map((s) => ({ ...s, _lib: lib.name }))
  ).filter((s) => s.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div
      // top: under the Brand card; bottom: above the global dock row.
      // 240px wide is enough for a 3-col tile grid plus padding.
      className="float absolute left-[14px] top-[70px] bottom-[70px] z-[15] w-[240px] flex flex-col overflow-hidden"
    >
      {/* Header — title + collapse button. The collapse target is the same
       *  Brand-side toggle, so users have two equivalent ways to dismiss. */}
      <div className="flex items-center justify-between px-[10px] py-[8px] border-b border-border">
        <span className="text-[11px] font-mono text-fg-muted tracking-[0.04em]">
          LIBRARIES
        </span>
        <button
          onClick={() => setOpen(false)}
          title="Collapse library panel"
          className="bg-transparent border-none text-fg-muted hover:text-fg p-[2px] rounded"
        >
          {/* Caret-left glyph — collapse direction matches the panel edge. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 4l-4 4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Search across ALL libraries — first-class, not tab-restricted. */}
      <div className="relative px-[10px] pt-[8px] pb-[8px] border-b border-border">
        <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none mt-px">
          <I.search />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
          placeholder="Search shapes & icons…"
          className="w-full pl-[26px] pr-[10px] py-[6px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
        />
      </div>

      {/* Library tabs — horizontal scroll if they overflow. */}
      <div className="flex gap-[2px] px-2 py-[6px] border-b border-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {allLibraries.map((l) => (
          <button
            key={l.id}
            onClick={() => setTab(l.id)}
            className={`flex-shrink-0 bg-transparent border-none px-[8px] py-[4px] text-[11px] font-medium rounded-[5px] whitespace-nowrap flex items-center gap-[6px] ${tab === l.id && !q
                ? 'text-fg bg-bg-emphasis'
                : 'text-fg-muted hover:text-fg hover:bg-bg-emphasis'
              }`}
          >
            {l.name}
            {l.version && (
              <span className="font-mono text-[8px] text-fg-muted font-normal">
                {l.version}
              </span>
            )}
          </button>
        ))}
        {/* Icon Packs lives at the end of the tab strip — the existing tabs
         *  are user-shape libraries; this one is a vendor catalogue browser
         *  with its own pin/drill UX, hence the dedicated entry. */}
        <button
          key={ICON_PACKS_TAB}
          onClick={() => setTab(ICON_PACKS_TAB)}
          className={`flex-shrink-0 bg-transparent border-none px-[8px] py-[4px] text-[11px] font-medium rounded-[5px] whitespace-nowrap flex items-center gap-[6px] ${tab === ICON_PACKS_TAB && !q
              ? 'text-fg bg-bg-emphasis'
              : 'text-fg-muted hover:text-fg hover:bg-bg-emphasis'
            }`}
        >
          Icon Packs
        </button>
      </div>

      {/* Tile grid — 3 columns to fit the narrower panel. When the user is
       *  searching, IconSearchResults appends Vendor + Iconify sections below
       *  the library shapes so a single search hits all three sources. */}
      <div className="p-[8px] overflow-y-auto flex-1">
        {/* Icon Packs — dedicated browse surface (mirrors MoreShapesPopover).
         *  Hidden during active search so the user's query still resolves
         *  through the cross-library scan instead of being trapped in this
         *  view. */}
        {tab === ICON_PACKS_TAB && !q ? (
          <IconPacksBrowser cols={3} />
        ) : /* Recent tab — render from store. Search bypasses Recent so the
         *  user's typing only matches the static catalog + Iconify results. */
        tab === 'recent' && !q ? (
          recentShapes.length > 0 ? (
            <>
              <div className="flex items-center justify-between mb-[6px] px-1">
                <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em]">
                  recently used
                </span>
                <button
                  onClick={clearRecent}
                  className="bg-transparent border-none text-fg-muted hover:text-fg text-[10px] font-mono cursor-pointer"
                  title="Clear recent activity"
                >
                  clear
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {recentShapes.map((entry) => (
                  <RecentTile key={entry.key} entry={entry} />
                ))}
              </div>
            </>
          ) : (
            <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
              recent shapes will appear here
            </div>
          )
        ) : shapes.length > 0 ? (
          <div className="grid grid-cols-3 gap-1">
            {shapes.map((s) => {
              const isPersonal = s._lib === 'Personal';
              const personalIdx = isPersonal
                ? Number(s.id.split('-')[1])
                : -1;
              return (
                <LibraryShapeTile
                  key={`${s._lib}-${s.id}`}
                  shapeId={s.id}
                  label={s.label}
                  glyph={s.glyph}
                  libName={s._lib}
                  isPersonal={isPersonal}
                  personalIdx={personalIdx}
                />
              );
            })}
          </div>
        ) : (
          // Only show the empty hint when the user isn't searching. Search
          // results live below — they have their own empty messages per
          // section, so showing "no matches" here while icon sections are
          // about to render misleads.
          !q && (
            <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
              empty — drag a shape here to add
            </div>
          )
        )}
        <IconSearchResults query={q} cols={3} />
      </div>

      {/* Footer — top row keeps the drag/bind hint and the "+ Load"
       *  affordance for the Tier 2 import flow. Bottom row (legal) holds
       *  the "About" (credits) + "Report an issue" (IP-complaints) links
       *  required by the trademark-compliance spec. The two rows are
       *  separated visually so the legal links don't compete with the
       *  primary picker affordance. */}
      <div className="border-t border-border">
        <div className="flex items-center justify-between px-[10px] py-[6px] text-[11px] text-fg-muted">
          <span className="font-mono text-[9px]">drag to canvas</span>
          <button
            onClick={() => setImportDialogOpen(true)}
            title="Install a third-party icon library"
            className="bg-transparent border-none text-accent text-[10px] font-medium hover:underline cursor-pointer"
          >
            + Load
          </button>
        </div>
        {/* TRADEMARK-COMPLIANCE: About + Report an issue. */}
        <div className="flex items-center justify-between px-[10px] py-[5px] border-t border-border text-[9px] font-mono text-fg-muted tracking-[0.04em]">
          <button
            onClick={() => openLegalDialog('credits')}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            About
          </button>
          <button
            onClick={() => openLegalDialog('ip-complaints')}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            Report an issue
          </button>
        </div>
      </div>
    </div>
  );
}

