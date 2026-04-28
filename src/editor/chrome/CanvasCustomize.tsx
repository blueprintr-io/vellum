import { useEffect, useRef } from 'react';
import { useEditor } from '@/store/editor';

// Order is the user's call: Default ▸ Warm ▸ White first row, the rest below.
// "Cool" was retired (#f7f9fa was visually indistinguishable from Default in
// light mode); pure white is the explicit replacement.
const PAPER_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Default', value: undefined },
  { label: 'Warm', value: '#f5f2ea' },
  { label: 'White', value: '#ffffff' },
  { label: 'Mint', value: '#e8f4ec' },
  { label: 'Slate', value: '#161a20' },
  { label: 'Black', value: '#0a0c10' },
];

/** Modal popover for canvas appearance — toggles dots/grid + paper colour. */
export function CanvasCustomize({ onClose }: { onClose: () => void }) {
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  // Tips toggle — gates the contextual TipToast pill (TipToast.tsx). Persisted
  // through the same store flag the toast reads.
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);
  // Hover-edge connector affordance toggle (added 2026-04-28). Persisted.
  const hoverEdgeConnectors = useEditor((s) => s.hoverEdgeConnectors);
  const setHoverEdgeConnectors = useEditor((s) => s.setHoverEdgeConnectors);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
      ref={wrapRef}
      className="float fixed top-[60px] right-[14px] z-[40] w-[260px] py-2"
    >
      <div className="px-3 py-1 text-[12px] font-semibold">Canvas</div>
      <div className="px-3 py-2 flex items-center justify-between text-[12px]">
        <span>Dots</span>
        <Toggle on={showDots} onChange={setShowDots} />
      </div>
      <div className="px-3 py-2 flex items-center justify-between text-[12px]">
        <span>Gridlines</span>
        <Toggle on={showGrid} onChange={setShowGrid} />
      </div>
      <div className="px-3 py-2 flex items-center justify-between text-[12px]">
        <span>Tips</span>
        <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
      </div>
      <div
        className="px-3 py-2 flex items-center justify-between text-[12px]"
        title="Hover a shape, then drag from its edge to start a connector to another shape."
      >
        <span>Edge connector handles</span>
        <Toggle on={hoverEdgeConnectors} onChange={setHoverEdgeConnectors} />
      </div>
      <div className="my-1 mx-2 border-t border-border" />
      <div className="px-3 pt-2 pb-1 text-[10px] font-mono text-fg-muted tracking-[0.04em]">
        PAPER
      </div>
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
                className="w-9 h-6 rounded border"
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
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-8 h-[18px] rounded-full transition-colors duration-100 ${
        on ? 'bg-accent' : 'bg-bg-emphasis'
      }`}
    >
      <span
        className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-fg shadow"
        style={{
          left: on ? 'calc(100% - 16px)' : '2px',
          transition: 'left 100ms',
          background: on ? '#fff' : 'var(--fg)',
        }}
      />
    </button>
  );
}
