import { useEditor, type PersonalLibraryEntry } from '@/store/editor';
import { LibraryTilePreview } from './LibraryTilePreview';

/** A tile for a library shape — used in both MoreShapesPopover and
 *  LibraryPanel. Routes the right drag MIME based on whether this is a
 *  built-in catalog entry (Personal-bundle vs glyph-library) and renders
 *  a real preview of saved bundles instead of just a 3-letter glyph.
 *
 *  Drag binding: React `onDragStart` (synthetic). The previous revision used a
 *  native `addEventListener('dragstart', …)` from a `useEffect` ref, on the
 *  theory that synthetic events were losing a race with descendant SVG/img
 *  elements. The actual cause of the "doesn't work after refresh" report was
 *  the opposite: `useEffect` fires AFTER paint, so on a refresh the button is
 *  visibly draggable for the time it takes to flush the editor's mount-time
 *  effect queue. Any drag started in that window had an empty dataTransfer
 *  and silently no-op'd on drop. React's synthetic delegation is wired into
 *  the root at `createRoot` time, so it's live the moment the button paints.
 *  Inner SVG/img keep `draggable={false}` + preventDefault so they can't
 *  become the drag source themselves. */
export function LibraryShapeTile({
  shapeId,
  label,
  glyph,
  libName,
  isPersonal,
  personalIdx,
}: {
  shapeId: string;
  label: string;
  glyph: string;
  libName: string;
  isPersonal: boolean;
  /** Index into `state.personalLibrary` — only meaningful when isPersonal. */
  personalIdx: number;
}) {
  // We pull personal + remover lazily so the closure resolves the latest
  // entry at drag time (don't capture the array on render).
  const personalLibrary = useEditor((s) => s.personalLibrary);
  const removeFromLibrary = useEditor((s) => s.removeFromLibrary);

  const personalEntry: PersonalLibraryEntry | undefined = isPersonal
    ? personalLibrary[personalIdx]
    : undefined;

  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    if (isPersonal && personalEntry) {
      // Personal bundle — full shape/connector payload preserved from when
      // the user added it. Canvas's onDrop branch on
      // 'application/x-vellum-bundle' re-ids and re-anchors at cursor.
      e.dataTransfer.setData(
        'application/x-vellum-bundle',
        JSON.stringify(personalEntry),
      );
    } else {
      // Built-in catalog tile — small payload, canvas resolves the
      // service-tile defaults at drop time.
      e.dataTransfer.setData(
        'application/x-vellum-library',
        JSON.stringify({
          id: shapeId,
          label,
          glyph,
          lib: libName,
        }),
      );
    }
    e.dataTransfer.setData('text/plain', label);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      title={
        isPersonal
          ? `${label} — drag to canvas (right-click to remove)`
          : `${label} — drag to canvas`
      }
      onContextMenu={(e) => {
        if (!isPersonal) return;
        e.preventDefault();
        if (window.confirm(`Remove "${label}" from your library?`)) {
          removeFromLibrary(personalIdx);
        }
      }}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-grab active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center font-mono text-[10px] font-bold text-accent overflow-hidden">
        {isPersonal && personalEntry ? (
          <LibraryTilePreview entry={personalEntry} size={32} />
        ) : (
          glyph
        )}
      </div>
      <span className="text-[10px] leading-[1.1] text-center">{label}</span>
    </button>
  );
}
