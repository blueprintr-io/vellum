import { useEffect, useRef, useState } from 'react';
import { I } from './icons';

/** A curated list of "things you might not know about Vellum". Order matters
 *  — the first few should be the highest-value tips so users can absorb the
 *  panel even if they only skim it. Keep tips terse + action-oriented:
 *  "do X to Y", not "X is also possible".
 *
 *  When you add a tip, add it here — the panel renders the array verbatim.
 *  Grouped by surface (canvas, connectors, selection, file) but rendered as
 *  a flat list so users don't have to navigate sections. */
const TIPS: { kbd: string; body: string }[] = [
  {
    kbd: '⌘ / Ctrl + drag',
    body: 'Drag a connector free of any shape — no auto-snap to whatever is under the cursor.',
  },
  {
    kbd: 'Right-click bend',
    body: 'Right-click a waypoint on a connector to delete that bend.',
  },
  {
    kbd: 'Shift + click',
    body: 'Add the clicked shape to your current selection (or remove it if it was already selected).',
  },
  {
    kbd: 'Drag from edge',
    body: 'Hover a shape, then drag from its edge to draw a connector to another shape.',
  },
  {
    kbd: 'Q',
    body: 'Toggle tool lock — keeps a drawing tool active after each shape so you can drop several in a row without re-selecting.',
  },
  {
    kbd: '⇧ ⌘ P',
    body: 'Promote the selected Notes-layer items to the Blueprint layer (turn a sticky into a real shape).',
  },
  {
    kbd: '8',
    body: "Container tool — drop a frame, then draw or drag shapes into it. They'll move with the frame.",
  },
  {
    kbd: '9',
    body: 'Freehand pen — annotate over the canvas without disturbing the underlying shapes.',
  },
  {
    kbd: 'L',
    body: 'Laser pointer — your cursor leaves a fading trail. Great for screen-shares and walking someone through a diagram.',
  },
  {
    kbd: 'Tab',
    body: 'Reverse the direction of the selected connector (swap from and to).',
  },
  {
    kbd: '⌘ K',
    body: 'Search every shape, icon, and command — the universal launcher.',
  },
  {
    kbd: 'Drag .svg in',
    body: 'Drop SVG files from your computer onto the canvas to add them as icons (and to your personal library).',
  },
];

/** "?" affordance — opens a popover full of tips. Lives at bottom-right,
 *  wedged between the undo/redo pill and the zoom pill. */
export function TipsButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="absolute bottom-[14px] right-[136px] z-[15]"
    >
      <button
        title="Tips & shortcuts"
        aria-label="Tips & shortcuts"
        onClick={() => setOpen((o) => !o)}
        className={`w-9 h-9 rounded-full flex items-center justify-center border transition-colors duration-100 ${
          open
            ? 'bg-bg-emphasis border-accent text-fg'
            : 'bg-bg/[0.92] border-border text-fg-muted hover:bg-bg-emphasis hover:text-fg'
        } backdrop-blur-chrome shadow-[0_2px_8px_rgb(0_0_0_/_0.12)]`}
      >
        <I.helpCircle />
      </button>
      {open && (
        <div className="float absolute bottom-[44px] right-0 z-[40] w-[340px] max-h-[60vh] overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-fg">
              Tips & shortcuts
            </span>
            <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em] uppercase">
              {TIPS.length}
            </span>
          </div>
          <ul className="flex flex-col gap-[10px]">
            {TIPS.map((t, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="kbd shrink-0 mt-[1px]">{t.kbd}</span>
                <span className="text-[11px] text-fg leading-relaxed">
                  {t.body}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
