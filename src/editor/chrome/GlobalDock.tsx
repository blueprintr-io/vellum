import { LayerPills } from './LayerPills';
import { AttributionsButton } from './icons/AttributionsButton';

/** Bottom-left: layer pills + attributions chip. The "?" tips button used to
 *  live here too, but now sits at bottom-right between the undo/redo pill and
 *  the zoom pill (see `TipsButton` and `Editor.tsx`). */
export function GlobalDock() {
  return (
    <div className="absolute bottom-[6px] left-[14px] z-[15] flex gap-2 items-start">
      <div className="flex flex-col items-center gap-[2px]">
        <LayerPills />
        <span className="text-[9px] text-fg-muted/70 tracking-[0.02em] select-none">
          <a
            href="https://github.com/blueprintr-io/vellum"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg hover:underline underline-offset-[2px]"
          >
            source-available
          </a>
          &nbsp;diagraming tool by{' '}
          <a
            href="https://blueprintr.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg hover:underline underline-offset-[2px]"
          >
            blueprintr.io
          </a>
        </span>
      </div>
      <AttributionsButton />
    </div>
  );
}
