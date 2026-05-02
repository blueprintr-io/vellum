import { useEffect, useRef } from 'react';
import { useEditor } from '@/store/editor';

/* SettingsDialog (added 2026-04-28).
 *
 * Single home for the per-workspace UI preferences that used to be split
 * across:
 *   - the "Customise canvas…" popover (paper colour, dots, gridlines)
 *   - the hamburger's "Disable / Enable tips" line item
 *   - the new "Edge connector handles" toggle
 *
 * Folding them in one panel matches the user's mental model — they're all
 * "how the canvas behaves for me" — and gives us a place to grow into for
 * future settings without polluting the file menu with a long list of
 * toggles. CanvasCustomize is left in the codebase for now (it still
 * works as a standalone if anything reaches for it), but the hamburger
 * routes here instead.
 */

const PAPER_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Default', value: undefined },
  { label: 'Warm', value: '#f5f2ea' },
  { label: 'White', value: '#ffffff' },
  { label: 'Mint', value: '#e8f4ec' },
  { label: 'Slate', value: '#161a20' },
  { label: 'Black', value: '#0a0c10' },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);
  const hoverEdgeConnectors = useEditor((s) => s.hoverEdgeConnectors);
  const setHoverEdgeConnectors = useEditor((s) => s.setHoverEdgeConnectors);

  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Backdrop-click + Escape close. setTimeout(0) so the click that opened
  // the dialog (in the hamburger menu) doesn't immediately close it via
  // its own bubble.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[6vh] sm:pt-[14vh] px-3"
      style={{
        background: 'rgba(0, 0, 0, 0.18)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        ref={wrapRef}
        className="float w-[min(420px,100%)] max-h-[80vh] sm:max-h-[70vh] overflow-y-auto py-2"
      >
        <div className="px-3 py-1 text-[12px] font-semibold flex items-center justify-between">
          <span>Settings</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="text-fg-muted hover:text-fg text-[14px] leading-none px-1"
          >
            ×
          </button>
        </div>

        <SectionLabel>CANVAS</SectionLabel>
        <Row label="Dots">
          <Toggle on={showDots} onChange={setShowDots} />
        </Row>
        <Row label="Gridlines">
          <Toggle on={showGrid} onChange={setShowGrid} />
        </Row>

        <SectionLabel>PAPER</SectionLabel>
        <div className="px-3 py-1 grid grid-cols-3 gap-2">
          {PAPER_PRESETS.map((p) => {
            const active = (canvasPaper ?? null) === (p.value ?? null);
            return (
              <button
                key={p.label}
                onClick={() => setCanvasPaper(p.value)}
                title={p.label}
                className="flex flex-col items-center gap-1 py-1 rounded-md hover:bg-bg-emphasis"
              >
                <span
                  className="w-12 h-7 rounded border"
                  style={{
                    background: p.value ?? 'var(--paper)',
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
                  }}
                />
                <span className="text-[10px]">{p.label}</span>
              </button>
            );
          })}
        </div>

        <SectionLabel>BEHAVIOUR</SectionLabel>
        <Row
          label="Tips"
          hint="Show contextual nudges during gestures."
        >
          <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
        </Row>
        <Row
          label="Edge connector handles"
          hint="Hover a shape, drag from its edge to start a connector."
        >
          <Toggle
            on={hoverEdgeConnectors}
            onChange={setHoverEdgeConnectors}
          />
        </Row>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 py-2 flex items-start justify-between gap-3 text-[12px]">
      <div className="flex flex-col">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] text-fg-muted leading-tight">{hint}</span>
        )}
      </div>
      <div className="shrink-0 pt-[1px]">{children}</div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-8 h-[18px] rounded-full transition-colors duration-100 ${
        on ? 'bg-accent' : 'bg-bg-emphasis'
      }`}
    >
      <span
        className="absolute top-[2px] w-[14px] h-[14px] rounded-full shadow"
        style={{
          left: on ? 'calc(100% - 16px)' : '2px',
          transition: 'left 100ms',
          background: on ? '#fff' : 'var(--fg)',
        }}
      />
    </button>
  );
}
