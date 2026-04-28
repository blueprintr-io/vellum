import { useEditor } from '@/store/editor';

/** Bottom-right undo/redo cluster. Sits left of the tips button + zoom dock —
 *  the gap to its right (`right-[136px]`) is occupied by `TipsButton`. The
 *  buttons disable when there's nothing on their respective stacks so a
 *  user-visible affordance shows up only when it'd actually do something. */
export function UndoDock() {
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);

  return (
    <div className="float absolute bottom-[14px] right-[182px] z-[15] flex items-stretch h-9 overflow-hidden">
      <button
        onClick={undo}
        disabled={!canUndo}
        title="Undo (⌘Z)"
        className="w-9 flex items-center justify-center bg-transparent border-none text-fg-muted hover:bg-bg-emphasis hover:text-fg disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <path
            d="M3 5.5h7a3 3 0 010 6H5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.5 3L3 5.5L5.5 8"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title="Redo (⇧⌘Z)"
        className="w-9 flex items-center justify-center bg-transparent border-none text-fg-muted hover:bg-bg-emphasis hover:text-fg border-l border-border disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <path
            d="M13 5.5H6a3 3 0 000 6h5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10.5 3L13 5.5L10.5 8"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
