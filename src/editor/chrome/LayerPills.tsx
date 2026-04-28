import { useEditor } from '@/store/editor';
import type { LayerMode } from '@/store/types';

/** Bottom-left layer pills. Three-state segmented control: Notes / Both /
 *  Blueprint. Layers are categorical; fidelity is gradual — the two complement
 *  each other. */
export function LayerPills() {
  const value = useEditor((s) => s.layerMode);
  const onChange = useEditor((s) => s.setLayerMode);

  return (
    <div className="float flex p-1 gap-[2px]">
      <Pill active={value === 'notes'} onClick={() => onChange('notes')}>
        {/* Yellow dot brands the Notes layer — matches --notes-ink and the
         *  contextual sticky-note button up in the FloatingToolbar. */}
        <span className="w-[6px] h-[6px] rounded-full bg-notes-ink" />
        Notes
      </Pill>
      <Pill active={value === 'both'} onClick={() => onChange('both')}>
        {/* Half-yellow / half-blue circle — left half is the Notes layer
         *  (yellow `--notes-ink`, same swatch as the Notes pill's dot),
         *  right half is the Blueprint layer (`--accent`). Composes the
         *  two single-layer dots into one glyph so "both" reads as "both
         *  at once" instead of needing its own unrelated symbol.
         *  Implemented via a conic-gradient with a single hard stop at
         *  the 12-o'clock → 6-o'clock vertical seam. */}
        <span
          className="w-[6px] h-[6px] rounded-full"
          style={{
            // from 270deg starts the sweep at 12 o'clock and walks clockwise.
            //   first 180° (12 → 3 → 6) paints the RIGHT half (Blueprint blue)
            //   second 180° (6 → 9 → 12) paints the LEFT half (Notes yellow)
            background:
              'conic-gradient(from 270deg, var(--accent) 0deg 180deg, var(--notes-ink) 180deg 360deg)',
          }}
        />
        Both
      </Pill>
      <Pill active={value === 'blueprint'} onClick={() => onChange('blueprint')}>
        <span className="w-[6px] h-[6px] rounded-full bg-accent" />
        Blueprint
      </Pill>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`bg-transparent border-none px-[11px] py-[5px] text-[11px] font-medium rounded-[5px] flex items-center gap-[6px] ${
        active ? 'bg-bg-emphasis text-fg' : 'text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

export type { LayerMode };
