// TRADEMARK-COMPLIANCE: footer mirrors LibraryPanel — "+ Load library"
// opens the Tier 2 import dialog, About / Report an issue open the
// LegalDialog on the right tab.

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { I } from './icons';
import { LIBRARIES, type Library } from './libraries';
import { IconSearchResults } from './icons/IconSearchResults';
import { LibraryShapeTile } from './LibraryShapeTile';
import { RecentTile } from './RecentTile';

export function MoreShapesPopover() {
  const open = useEditor((s) => s.morePopoverOpen);
  const close = useEditor((s) => s.setMorePopoverOpen);
  const personal = useEditor((s) => s.personalLibrary);
  // Recent feed — populated by Canvas drop handlers.
  const recentShapes = useEditor((s) => s.recentShapes);
  const clearRecent = useEditor((s) => s.clearRecent);
  // TRADEMARK-COMPLIANCE — footer-link handlers.
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);
  const [tab, setTab] = useState('recent');
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Build a synthetic Personal library entry from the persisted slice.
  const personalLib: Library = {
    id: 'personal',
    name: 'Personal',
    version: 'local',
    shapes: personal.map((p, i) => ({
      id: `personal-${i}`,
      label: p.label,
      glyph: p.glyph,
    })),
  };
  const allLibraries = [...LIBRARIES, personalLib];

  // Outside-click → close. We listen at the document level on `pointerdown`
  // so the popover dismisses before the click is consumed by another control.
  // The toolbar's "more shapes" button toggles the popover via its own click
  // handler — that click reaches `wrapRef`'s ancestor (not wrapRef itself), so
  // we explicitly skip closing when the target is the toggle button. Otherwise
  // clicking the toggle would close-then-reopen-then-close in a single tick.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      // Skip the toggle button — let its own onClick handle the close.
      if (target instanceof Element && target.closest('[data-more-toggle]')) {
        return;
      }
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  if (!open) return null;

  // Search is across ALL libraries — first-class behaviour, not a tab-restricted lookup.
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
      ref={wrapRef}
      className="float absolute top-[70px] z-[16] w-[360px] max-h-[460px] flex flex-col overflow-hidden"
      style={{
        left: '50%',
        // Aligns roughly under the more-shapes button (right end of the toolbar).
        transform: 'translateX(calc(-50% + 222px))',
      }}
    >
      <div className="relative px-[10px] pt-[10px] pb-[8px] border-b border-border">
        <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none mt-px">
          <I.search />
        </span>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close(false);
          }}
          placeholder="Search shapes across all libraries…"
          className="w-full pl-[30px] pr-[10px] py-[7px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
        />
        <span className="absolute right-[20px] top-1/2 -translate-y-1/2 pointer-events-none mt-px">
          <span className="kbd">Esc</span>
        </span>
      </div>

      <div className="flex gap-[2px] px-2 py-[6px] border-b border-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {allLibraries.map((l) => (
          <button
            key={l.id}
            onClick={() => setTab(l.id)}
            className={`flex-shrink-0 bg-transparent border-none px-[10px] py-[5px] text-[11px] font-medium rounded-[5px] whitespace-nowrap flex items-center gap-[6px] ${
              tab === l.id
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
      </div>

      {/* Result body — library shapes first, then IconSearchResults appends
       *  Vendor + Iconify sections when there's a query. */}
      <div className="p-[10px] overflow-y-auto">
        {/* Recent tab is special-cased: tiles are derived from store activity,
         *  drag handler picks the right MIME based on the entry's source.
         *  Search ignores Recent — when the user is typing they're looking
         *  for something new, and the icon results below cover the icon side. */}
        {tab === 'recent' && !q ? (
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
              <div className="grid grid-cols-4 gap-1">
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
          <div className="grid grid-cols-4 gap-1">
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
          // Empty hint only when the user hasn't typed a query — search has
          // its own per-section empty messages below.
          !q && (
            <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
              empty — drag a shape here to add
            </div>
          )
        )}
        <IconSearchResults query={q} cols={4} />
      </div>

      <div className="border-t border-border">
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-fg-muted">
          <span className="flex items-center gap-[6px] font-mono text-[10px]">
            drag to canvas
          </span>
          <button
            onClick={() => {
              close(false);
              setImportDialogOpen(true);
            }}
            title="Install a third-party icon library"
            className="bg-transparent border-none text-accent text-[11px] font-medium hover:underline cursor-pointer"
          >
            + Load library
          </button>
        </div>
        {/* TRADEMARK-COMPLIANCE: About + Report an issue. */}
        <div className="flex items-center justify-between px-3 py-[5px] border-t border-border text-[9px] font-mono text-fg-muted tracking-[0.04em]">
          <button
            onClick={() => {
              close(false);
              openLegalDialog('credits');
            }}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            About
          </button>
          <button
            onClick={() => {
              close(false);
              openLegalDialog('ip-complaints');
            }}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            Report an issue
          </button>
        </div>
      </div>
    </div>
  );
}
