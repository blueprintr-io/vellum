import { useEditor } from '@/store/editor';
import { I } from './icons';
import type { ToolKey } from '@/store/types';

const TOOL_ORDER: ToolKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const ICON_FOR_TOOL: Record<string, () => React.ReactNode> = {
  cursor: I.cursor,
  rect: I.rect,
  ellipse: I.ellipse,
  diamond: I.diamond,
  arrow: I.arrow,
  line: I.line,
  text: I.text,
  laser: I.laser,
  pen: I.pen,
  container: I.container,
  empty: I.empty,
  note: I.note,
  table: I.table,
};

export function FloatingToolbar() {
  const activeTool = useEditor((s) => s.activeTool);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  const toolLock = useEditor((s) => s.toolLock);
  const toggleLock = useEditor((s) => s.toggleLock);
  const libraryPanelOpen = useEditor((s) => s.libraryPanelOpen);
  const toggleLibraryPanel = useEditor((s) => s.toggleLibraryPanel);
  const bindings = useEditor((s) => s.hotkeyBindings);
  const layerMode = useEditor((s) => s.layerMode);
  // Sticky-note button is contextual to the Notes layer being editable. Show
  // it whenever Notes is the focus ('notes') OR both layers are visible
  // ('both'); hide it when only Blueprint is shown so Blueprint-only diagrams
  // don't get a stray red button. Lives outside the rebindable 1–9 slot row
  // because it's a layer affordance, not a user-rebindable tool.
  const notesButtonVisible = layerMode === 'notes' || layerMode === 'both';

  return (
    <div className="float absolute top-[14px] left-1/2 -translate-x-1/2 z-[15] flex gap-[2px] p-[5px]">
      <ToolButton
        title={
          toolLock
            ? 'Tool lock ON — drawing tool stays active after use (press Q to release)'
            : 'Tool lock OFF — drawing tool reverts to select after use (press Q to lock)'
        }
        onClick={toggleLock}
        active={toolLock}
        muted={!toolLock}
      >
        <I.lock />
        {toolLock && (
          <span className="absolute top-[3px] right-[4px] w-[5px] h-[5px] rounded-full bg-accent" />
        )}
      </ToolButton>
      <Divider />
      {TOOL_ORDER.map((k) => {
        const def = bindings[k];
        const IconFn = ICON_FOR_TOOL[def.icon];
        return (
          <ToolButton
            key={k}
            title={`${def.label} — ${k}`}
            onClick={() => setActiveTool(k)}
            active={activeTool === k}
          >
            {IconFn?.()}
            <span
              className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                activeTool === k ? 'text-accent opacity-85' : 'text-fg-muted'
              }`}
            >
              {k}
            </span>
          </ToolButton>
        );
      })}
      <Divider />
      {/* Laser pointer — outside the 1–9 row because it's a presentation-mode
       *  tool, not a shape tool. Bound to L. */}
      {(() => {
        const def = bindings['l'];
        if (!def) return null;
        const IconFn = ICON_FOR_TOOL[def.icon];
        return (
          <ToolButton
            title={`${def.label} — L`}
            onClick={() => setActiveTool('l')}
            active={activeTool === 'l'}
          >
            {IconFn?.()}
            <span
              className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                activeTool === 'l' ? 'text-accent opacity-85' : 'text-fg-muted'
              }`}
            >
              L
            </span>
          </ToolButton>
        );
      })()}
      {/* Table — also outside the 1–9 row. Sits next to the laser slot since
       *  both are letter-bound auxiliary tools. */}
      {(() => {
        const def = bindings['t'];
        if (!def) return null;
        const IconFn = ICON_FOR_TOOL[def.icon];
        return (
          <ToolButton
            title={`${def.label} — T`}
            onClick={() => setActiveTool('t')}
            active={activeTool === 't'}
          >
            {IconFn?.()}
            <span
              className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                activeTool === 't' ? 'text-accent opacity-85' : 'text-fg-muted'
              }`}
            >
              T
            </span>
          </ToolButton>
        );
      })()}
      <Divider />
      {/* Toolbar shapes button toggles the persistent left LibraryPanel. The
       *  floating MoreShapesPopover still exists for the ⌘K-style quick pick,
       *  but its dedicated trigger lives over there now — this slot is the
       *  dwellable surface. */}
      <ToolButton
        title="Shapes & icons (toggle library panel)"
        onClick={toggleLibraryPanel}
        active={libraryPanelOpen}
      >
        <I.more />
      </ToolButton>
      {/* Notes-layer contextual button. Slides in next to the toolbar whenever
       *  the Notes layer is in scope. Tinted to match Notes-layer ink so it
       *  reads as "the red layer's tool" without yelling. */}
      {notesButtonVisible && (
        <>
          <Divider />
          <ToolButton
            title="Sticky note — N"
            onClick={() => setActiveTool('n')}
            active={activeTool === 'n'}
          >
            <I.note />
            <span
              className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                activeTool === 'n' ? 'opacity-85' : 'text-fg-muted'
              }`}
              style={activeTool === 'n' ? { color: 'var(--notes-ink)' } : undefined}
            >
              N
            </span>
            <span
              className="absolute top-[3px] right-[4px] w-[4px] h-[4px] rounded-full"
              style={{ background: 'var(--notes-ink)' }}
            />
          </ToolButton>
        </>
      )}
    </div>
  );
}

function Divider() {
  return <div className="w-px my-[6px] mx-1 bg-border" />;
}

type ToolButtonProps = {
  active?: boolean;
  muted?: boolean;
  accentBgOnly?: boolean;
  title?: string;
  onClick?: () => void;
  /** Attaches `data-${dataAttr}` to the button. Lets outside-click handlers
   *  identify "this is the toggle that opens me, ignore the click." */
  dataAttr?: string;
  children: React.ReactNode;
};

function ToolButton({
  active,
  muted,
  accentBgOnly,
  title,
  onClick,
  dataAttr,
  children,
}: ToolButtonProps) {
  const baseColour = muted ? 'text-fg-muted' : 'text-fg';
  const activeStyles = accentBgOnly
    ? 'bg-accent/[0.12] text-accent border-transparent'
    : 'bg-accent/[0.18] text-accent border-accent/35';
  return (
    <button
      title={title}
      onClick={onClick}
      {...(dataAttr ? { [`data-${dataAttr}`]: true } : {})}
      className={`relative w-9 h-9 flex items-center justify-center rounded-md border transition-[background,color,border-color] duration-100 ${
        active
          ? activeStyles
          : `bg-transparent border-transparent ${baseColour} hover:bg-bg-emphasis`
      }`}
    >
      {children}
    </button>
  );
}
