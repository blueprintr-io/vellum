import { useEffect, useRef, useState } from 'react';
import {
  FILL_SWATCHES,
  STROKE_SWATCHES,
  resolveSwatchColor,
  shadeLadder,
  SHADE_RUNGS,
} from '@/editor/swatches';

/** Shared appearance controls used by ShapeInspector and ConnectorInspector.
 *
 *  The contract for both controls: passing `undefined` means "fall back to the
 *  fidelity-driven default at render time." That's distinct from `'transparent'`
 *  / `'none'`, which is an explicit user choice. Keeping these two states
 *  separate matters because:
 *    - Default tracks fidelity, sketch/refined toggling, and theme.
 *    - Explicit `transparent` does not — the user chose nothing, and we honour it.
 */

// Stroke + fill share column positions so the user can pick e.g. red stroke
// over red fill from the same column. Every named-colour cell uses the
// swatch palette's `cssVar` form so it autoswitches on theme toggle (see
// editor/swatches.ts) — the only literal-hex values left here are the
// theme-aware var() pairs (--ink, --paper, --mono).
//
// `--mono` is the OPPOSITE-of-ink swatch (black in dark mode, white in light
// mode — see tokens.css). Pairing it with `--ink` guarantees the row offers
// exactly one black + one white in both themes, regardless of which way the
// canvas is flipped.
/** Each preset can advertise a `shadeKey` — when set, right-clicking the
 *  cell (or clicking its chevron) opens the 5-rung shade picker for that
 *  named colour. ink/paper/mono have no shade ladder so they leave it
 *  undefined; the named-colour swatches all participate. */
type Preset = { label: string; value: string; shadeKey?: string };

const STROKE_PRESETS: Preset[] = [
  { label: 'ink', value: 'var(--ink)' },
  ...STROKE_SWATCHES.map((s) => ({
    label: s.label,
    value: s.cssVar,
    shadeKey: s.id,
  })),
  { label: 'mono', value: 'var(--mono)' },
];

// Why fill carries BOTH `paper` and `ink` (stroke/text only need `ink`):
//
// `mono` is the opposite-of-ink contrast swatch — black in dark mode, white
// in light mode. On its own it covers exactly ONE extreme of the canvas.
// Stroke + text pair it with `ink` (which flips: near-white in dark,
// near-black in light), so those rows always have access to both pure-black
// AND pure-white regardless of theme.
//
// Fill used to pair `mono` with `paper`. But `paper` doesn't flip the same
// way: in dark mode it's the dark canvas slate, in light mode it's near-white
// — so the dark-mode fill row offered slate + black (no white), and the
// light-mode fill row offered near-white + white (no black). The user
// couldn't paint a white fill on a dark canvas, or a black fill on a light
// canvas, without dropping into the custom colour picker.
//
// Keeping `paper` is still useful — it's the "blend with the canvas"
// semantic, distinct from `transparent` because paper paints over whatever
// is underneath. Adding `ink` alongside it gives fill the same pure-black
// + pure-white guarantee that stroke/text already have.
const FILL_PRESETS: Preset[] = [
  { label: 'paper', value: 'var(--paper)' },
  { label: 'ink', value: 'var(--ink)' },
  ...FILL_SWATCHES.map((s) => ({
    label: s.label,
    value: s.cssVar,
    shadeKey: s.id,
  })),
  { label: 'mono', value: 'var(--mono)' },
];

/** Reverse-lookup: stored `var(--{kind}-{colour}-{rung})` → its base
 *  swatch id, so the SwatchRow can highlight the right base cell when the
 *  user has picked a non-base shade. */
function shadeBaseFor(kind: SwatchKind, value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(new RegExp(`^var\\(--${kind}-([a-z]+)-(\\d{3})\\)$`));
  if (!m) return null;
  return m[1];
}

type SwatchKind = 'stroke' | 'fill';

export function SwatchRow({
  kind,
  value,
  onChange,
  allowNone = true,
}: {
  kind: SwatchKind;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  /** Connectors don't really want a "none stroke" but shapes might. */
  allowNone?: boolean;
}) {
  const presets = kind === 'stroke' ? STROKE_PRESETS : FILL_PRESETS;
  const isNone = value === 'transparent' || value === 'none';
  const isDefault = value === undefined;
  // Normalise the incoming value through the swatch resolver so a legacy
  // hex (e.g. saved "#fee2e2") still highlights its cssVar swatch cell.
  // resolveSwatchColor returns the input unchanged for non-palette values
  // (including custom colours), so this is a safe pass-through for those.
  const normalisedValue = resolveSwatchColor(value, kind);
  // If the user has picked a shade rung (e.g. var(--fill-red-400)), badge
  // the matching base cell as active. The shade picker re-opens preselecting
  // the rung the user previously chose.
  const shadeBase = shadeBaseFor(kind, normalisedValue);
  const matchedPreset = presets.find(
    (p) => p.value === normalisedValue || p.shadeKey === shadeBase,
  );
  const customValue =
    !isDefault && !isNone && !matchedPreset ? value : undefined;
  // Which swatch's shade picker is open. Set by left-click on the chevron
  // OR by right-click on the cell — both gestures route here.
  const [shadePickerFor, setShadePickerFor] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Outside-click closes the shade picker. Pointer-down catches the start
  // of a press elsewhere — feels right for a popover that we don't want
  // hanging around when the user clicks back into the canvas.
  useEffect(() => {
    if (!shadePickerFor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (wrapperRef.current?.contains(t)) return;
      setShadePickerFor(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [shadePickerFor]);

  // Hidden native color input — fires onInput live during drag of the OS
  // picker, so we get a snappy preview. We commit on `change` (close).
  const colorRef = useRef<HTMLInputElement>(null);

  return (
    // Grid (not flex-wrap) so every cell occupies a deterministic column
    // slot. With flex-wrap, row 1 ends mid-row at whatever cell happens to
    // hit the container edge, and row 2's cells pack left from x=0 — the
    // result is row 2 columns drift left of row 1 columns by however much
    // gap-padding+leading-cell the row 1 prefix consumed. CSS grid pins
    // every cell to a fixed 20px column track, so row N column M always
    // sits at the same x as row N+1 column M — within a row pair AND
    // across the .stroke / .fill rows of the same surface. The
    // `auto-fill` keeps the responsive wrap-on-narrow-panel behaviour the
    // old flex layout had.
    <div
      ref={wrapperRef}
      className="grid items-center gap-[3px]"
      style={{ gridTemplateColumns: 'repeat(auto-fill, 20px)' }}
    >
      {/* Auto/default cell — `A` for "auto". The "A" uses text-fg (not
       *  text-fg-muted) so it stays legible regardless of what colour the
       *  kind happens to put next to it. */}
      <SwatchCell
        title="default (auto)"
        active={isDefault}
        onClick={() => onChange(undefined)}
      >
        <span className="font-mono text-[10px] text-fg leading-none">A</span>
      </SwatchCell>
      {/* Phantom cell — fill has `paper` here, stroke does not. Rendering
       *  an empty grid item in stroke's `paper` slot keeps the colour
       *  columns perfectly aligned between the .stroke and .fill rows
       *  (so red-stroke and red-fill share a column, as the file-header
       *  comment promises). The cell is invisible and skipped for tab /
       *  pointer navigation. */}
      {kind === 'stroke' && (
        <span aria-hidden style={{ width: 20, height: 20 }} />
      )}
      {presets.map((p) => (
        <SwatchCellWithShades
          key={p.value}
          preset={p}
          kind={kind}
          activeBase={
            !isDefault &&
            (normalisedValue === p.value || shadeBase === p.shadeKey)
          }
          activeRungValue={
            normalisedValue && p.shadeKey && shadeBase === p.shadeKey
              ? normalisedValue
              : null
          }
          shadePickerOpen={shadePickerFor === p.shadeKey}
          onOpenShadePicker={(open) =>
            setShadePickerFor(open && p.shadeKey ? p.shadeKey : null)
          }
          onPickBase={() =>
            onChange(normalisedValue === p.value ? undefined : p.value)
          }
          onPickShade={(rungVar) => {
            onChange(rungVar);
            setShadePickerFor(null);
          }}
        />
      ))}
      {allowNone && (
        <SwatchCell
          title="none"
          active={isNone}
          onClick={() => onChange(isNone ? undefined : 'transparent')}
        >
          {/* Diagonal slash through a transparent square — universal "none" idiom. */}
          <svg width={14} height={14} viewBox="0 0 14 14">
            <rect
              x={1}
              y={1}
              width={12}
              height={12}
              rx={2}
              fill="transparent"
              stroke="var(--fg-muted)"
              strokeWidth={1}
            />
            <line
              x1={1}
              y1={13}
              x2={13}
              y2={1}
              stroke="#c83e1d"
              strokeWidth={1.4}
            />
          </svg>
        </SwatchCell>
      )}
      <SwatchCell
        title={customValue ? `custom (${customValue})` : 'custom…'}
        active={!!customValue}
        onClick={() => colorRef.current?.click()}
      >
        <span
          className="block w-[14px] h-[14px] rounded-[3px]"
          style={{
            background: customValue
              ? customValue
              : 'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
          }}
        />
      </SwatchCell>
      <input
        ref={colorRef}
        type="color"
        // Native colour input requires a #rrggbb-shaped value; if the user
        // currently has a non-hex value (e.g. transparent) we seed with black.
        value={customValue && /^#[0-9a-f]{6}$/i.test(customValue) ? customValue : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        // Keep tab order intact — the visible cell is the focusable target.
        tabIndex={-1}
      />
    </div>
  );
}

function SwatchCell({
  title,
  active,
  onClick,
  onContextMenu,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="inline-flex items-center justify-center w-[20px] h-[20px] rounded-[4px] border"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
        boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
      }}
    >
      {children}
    </button>
  );
}

/** Coloured swatch cell with a chevron + shade-picker popover. The cell
 *  itself paints the base swatch and (on left-click) toggles to it; the
 *  chevron — a small "▾" badge in the bottom-right corner — opens a row
 *  of 5 shade cells (light → deep). Right-clicking the cell also opens
 *  the picker, mirroring "right-click for more options" muscle memory.
 *
 *  When the user has picked a non-base rung, the active swatch in the
 *  picker is highlighted so they can see which shade is in use without
 *  needing to read the cssVar. */
function SwatchCellWithShades({
  preset,
  kind,
  activeBase,
  activeRungValue,
  shadePickerOpen,
  onOpenShadePicker,
  onPickBase,
  onPickShade,
}: {
  preset: Preset;
  kind: 'fill' | 'stroke';
  /** Highlight the base cell as active. True when the stored value matches
   *  either the base swatch OR any of its shade rungs. */
  activeBase: boolean;
  /** The exact rung-value (`var(--fill-red-300)`) the user has picked, or
   *  null if they're on the base. The shade picker uses this to outline the
   *  matching cell. */
  activeRungValue: string | null;
  shadePickerOpen: boolean;
  onOpenShadePicker: (open: boolean) => void;
  onPickBase: () => void;
  onPickShade: (rungCssVar: string) => void;
}) {
  // ink/paper/mono have no shadeKey — they're single-shade tokens. Render
  // the original SwatchCell behaviour for them so right-click doesn't open
  // an empty popover.
  if (!preset.shadeKey) {
    return (
      <SwatchCell
        title={preset.label}
        active={activeBase}
        onClick={onPickBase}
      >
        <span
          className="block w-[14px] h-[14px] rounded-[3px]"
          style={{
            background: preset.value,
            border: '1px solid var(--border)',
          }}
        />
      </SwatchCell>
    );
  }

  const ladder = shadeLadder(kind, preset.shadeKey);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        title={`${preset.label} — right-click or ▾ for shades`}
        onClick={onPickBase}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenShadePicker(!shadePickerOpen);
        }}
        className="inline-flex items-center justify-center w-[20px] h-[20px] rounded-[4px] border"
        style={{
          borderColor: activeBase ? 'var(--accent)' : 'var(--border)',
          background: activeBase ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
          boxShadow: activeBase ? '0 0 0 1px var(--accent) inset' : undefined,
          position: 'relative',
        }}
      >
        <span
          className="block w-[14px] h-[14px] rounded-[3px]"
          style={{
            // When a non-base rung is picked, the cell paints THAT rung so
            // the user sees their actual chosen shade, not the base swatch
            // sitting visually-stale next to the inspector value.
            background: activeRungValue ?? preset.value,
            border: '1px solid var(--border)',
          }}
        />
      </button>
      {/* Tiny chevron — 7px badge in the bottom-right corner. preventDefault
       *  on mousedown stops a focus-shift while the popover is open, so the
       *  shade-cell click doesn't lose its target. */}
      <button
        type="button"
        title="Shades"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenShadePicker(!shadePickerOpen);
        }}
        style={{
          position: 'absolute',
          right: -1,
          bottom: -1,
          width: 9,
          height: 9,
          padding: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: 'var(--fg-muted)',
          fontSize: 7,
          lineHeight: 1,
        }}
      >
        ▾
      </button>
      {shadePickerOpen && (
        <div
          style={{
            position: 'absolute',
            top: 24,
            left: 0,
            zIndex: 60,
            padding: 4,
            borderRadius: 6,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            display: 'flex',
            gap: 3,
          }}
          // Right-click inside the popover shouldn't bubble to the OS menu —
          // we want the user to be able to long-press / right-click the
          // shade cells without surprises.
          onContextMenu={(e) => e.preventDefault()}
        >
          {ladder.map(({ rung, cssVar }) => {
            const active = activeRungValue === cssVar;
            return (
              <button
                key={rung}
                type="button"
                title={`${preset.label}-${rung}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPickShade(cssVar)}
                style={{
                  width: 18,
                  height: 18,
                  padding: 0,
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 4,
                  background: cssVar,
                  cursor: 'pointer',
                  boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
// Keeps the linter happy that SHADE_RUNGS is referenced — the constant is
// exported from swatches.ts and imported here so other call-sites can
// derive ladder lengths without re-reading the array. We don't need it
// directly inside SwatchCellWithShades because shadeLadder() already
// iterates the rungs internally.
void SHADE_RUNGS;

/** Stroke-width control — slider, 0..10 in 0.25 increments. Dragging the
 *  thumb commits live; double-click on the track resets to default
 *  (`undefined`). The visual default value is 1.25 (the renderer's default
 *  fallback) so an unset override sits centre-low on the track.
 */
const SW_MIN = 0;
const SW_MAX = 10;
const SW_DEFAULT_DISPLAY = 1.25;

export function StrokeWidthField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDefault = value === undefined;
  const display = isDefault ? SW_DEFAULT_DISPLAY : value;

  const compute = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return display;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Snap to 0.25 — the same step the old number input used.
    return Math.round((SW_MIN + t * (SW_MAX - SW_MIN)) * 4) / 4;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(compute(e.clientX));
  };

  const pct = ((display - SW_MIN) / (SW_MAX - SW_MIN)) * 100;

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange(undefined)}
        title={isDefault ? 'default — drag to override, double-click to reset' : 'drag to change, double-click to reset to default'}
        className="relative flex-1 h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
      >
        <div
          className="absolute top-0 left-0 h-full rounded-[3px] bg-accent/60"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            opacity: isDefault ? 0.55 : 1,
          }}
        />
      </div>
      <span
        className="font-mono text-[10px] text-fg-muted w-[44px] text-right shrink-0"
        title={isDefault ? 'using fidelity default (1.25)' : ''}
      >
        {isDefault ? 'auto' : display.toFixed(2)}
      </span>
    </div>
  );
}

/** Marker (arrowhead) size control — slider, 2..70 px in 1px increments.
 *  Decoupled from stroke width: the slider value is the rendered marker size
 *  in user-space pixels. Double-click resets to `undefined` ("auto"), which
 *  the renderer interprets as `strokeWidth × kind-default-factor` so legacy
 *  diagrams keep their tightly-coupled look until the user opts out.
 *
 *  Upper bound 70 covers the heaviest "billboard arrow" cases the user
 *  has flagged — beyond that, an arrow is functioning as a shape and the
 *  user should reach for a triangle/diamond shape instead.
 *
 *  `defaultDisplay` should be the size the renderer paints in the unset
 *  state — caller computes it via `resolveMarkerSize(kind, strokeWidth,
 *  undefined)` so the thumb position never lies about the live rendering. */
const MS_MIN = 2;
const MS_MAX = 70;

export function MarkerSizeField({
  value,
  defaultDisplay,
  onChange,
}: {
  value: number | undefined;
  defaultDisplay: number;
  onChange: (v: number | undefined) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDefault = value === undefined;
  // Clamp the auto-state thumb so the slider doesn't pin to either end when
  // the connector's strokeWidth pushes the implicit size out of the visible
  // range.
  const display = isDefault
    ? Math.max(MS_MIN, Math.min(MS_MAX, defaultDisplay))
    : value;

  const compute = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return display;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(MS_MIN + t * (MS_MAX - MS_MIN));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(compute(e.clientX));
  };

  const pct = ((display - MS_MIN) / (MS_MAX - MS_MIN)) * 100;

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange(undefined)}
        title={
          isDefault
            ? `auto (~${defaultDisplay.toFixed(1)}px from stroke width) — drag to override, double-click to reset`
            : 'drag to change, double-click to reset to auto'
        }
        className="relative flex-1 h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
      >
        <div
          className="absolute top-0 left-0 h-full rounded-[3px] bg-accent/60"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            opacity: isDefault ? 0.55 : 1,
          }}
        />
      </div>
      <span
        className="font-mono text-[10px] text-fg-muted w-[44px] text-right shrink-0"
        title={isDefault ? 'auto — follows stroke width' : ''}
      >
        {isDefault ? 'auto' : `${Math.round(display)}px`}
      </span>
    </div>
  );
}

/** Opacity slider — 0..1 in 0.05 steps. Mirrors StrokeWidthField's
 *  pointer-capture pattern so the thumb feels the same as line width.
 *  Double-click resets to default (`undefined`, i.e. fully opaque).
 */
const OP_MIN = 0;
const OP_MAX = 1;
const OP_DEFAULT_DISPLAY = 1;

export function OpacityField({
  value,
  onChange,
  defaultDisplay = OP_DEFAULT_DISPLAY,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** Where the slider thumb sits when `value` is undefined (the
   *  "auto / default" state). Defaults to 1 (fully opaque) — that's the
   *  right reading for whole-shape `opacity` and for fill-opacity on
   *  every kind EXCEPT containers, which paint a 25% wash by default
   *  and need the thumb to reflect that. Pass e.g. `0.25` for the
   *  container .fill α slot so the slider doesn't lie about the
   *  effective opacity in the unset state. */
  defaultDisplay?: number;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDefault = value === undefined;
  const display = isDefault ? defaultDisplay : value;

  const compute = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return display;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Snap to 0.05 — fine enough to fade smoothly, coarse enough to land
    // on round percentages.
    return Math.round((OP_MIN + t * (OP_MAX - OP_MIN)) * 20) / 20;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(compute(e.clientX));
  };

  const pct = ((display - OP_MIN) / (OP_MAX - OP_MIN)) * 100;
  const defaultPct = Math.round(defaultDisplay * 100);

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange(undefined)}
        title={
          isDefault
            ? `default ${defaultPct}% — drag to change, double-click to reset`
            : 'drag to change, double-click to reset to default'
        }
        className="relative flex-1 h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
      >
        <div
          className="absolute top-0 left-0 h-full rounded-[3px] bg-accent/60"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            opacity: isDefault ? 0.55 : 1,
          }}
        />
      </div>
      <span
        className="font-mono text-[10px] text-fg-muted w-[44px] text-right shrink-0"
        title={isDefault ? `using default (${defaultPct}%)` : ''}
      >
        {`${Math.round(display * 100)}%`}
      </span>
    </div>
  );
}

/** Corner-radius slider — 0..40 px in 1px increments. Mirrors StrokeWidthField's
 *  pointer-capture pattern (drag commits live, double-click resets to default).
 *  `defaultDisplay` is the rendered radius when `value` is undefined — the
 *  caller passes the kind's fallback (4 for rect, 8 for service) so the thumb
 *  doesn't lie about what the canvas is actually painting. The renderer
 *  additionally clamps to `min(w,h)/2`, but that's a render-time cap rather
 *  than a slider-side concern: the user should still be able to dial in 40px
 *  on a small shape and have the value persist if the shape later grows. */
const CR_MIN = 0;
const CR_MAX = 40;

export function CornerRadiusField({
  value,
  defaultDisplay,
  onChange,
}: {
  value: number | undefined;
  defaultDisplay: number;
  onChange: (v: number | undefined) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDefault = value === undefined;
  const display = isDefault
    ? Math.max(CR_MIN, Math.min(CR_MAX, defaultDisplay))
    : value;

  const compute = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return display;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(CR_MIN + t * (CR_MAX - CR_MIN));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(compute(e.clientX));
  };

  const pct = ((display - CR_MIN) / (CR_MAX - CR_MIN)) * 100;

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange(undefined)}
        title={
          isDefault
            ? `default ${defaultDisplay}px — drag to override, double-click to reset`
            : 'drag to change, double-click to reset to default'
        }
        className="relative flex-1 h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
      >
        <div
          className="absolute top-0 left-0 h-full rounded-[3px] bg-accent/60"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            opacity: isDefault ? 0.55 : 1,
          }}
        />
      </div>
      <span
        className="font-mono text-[10px] text-fg-muted w-[44px] text-right shrink-0"
        title={isDefault ? `using kind default (${defaultDisplay}px)` : ''}
      >
        {isDefault ? 'auto' : `${Math.round(display)}px`}
      </span>
    </div>
  );
}

/** Google-Docs-style font-size control: `−` / editable number / `+`, plus a
 *  preset dropdown anchored to the number cell. The dropdown's preset ladder
 *  matches the Docs ladder exactly because that's the muscle memory the user
 *  flagged in the screenshot.
 *
 *  `value === undefined` means "no override — show the kind default" — same
 *  contract the rest of the style controls use. The displayed digits in that
 *  state come from `defaultSize`, so the kind-default doesn't lie about what
 *  the renderer is actually painting.
 *
 *  `onChange(undefined)` is reachable by typing a blank value + commit; we
 *  don't surface a separate "auto" button here because the field is shared
 *  with the inline-editor toolbar, where space is tight and the Default
 *  entry already lives inside FontPicker. */
const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 200;

/** Format a fontSize value at most 2 decimal places, trailing zeros
 *  stripped. 13 → "13"; 13.5 → "13.5"; 27.234 → "27.23". The text-shape
 *  resize handler stores fractional values (linear additive scaling
 *  produces decimals like 27.23 from a smooth drag); the field formats
 *  them so the inspector and inline-editor toolbar both read cleanly
 *  whether the value is integer or fractional. parseFloat after toFixed
 *  is the standard trick — `(13).toFixed(2)` → "13.00" → parseFloat →
 *  13 → String → "13". */
function formatFontSize(n: number): string {
  return parseFloat(n.toFixed(2)).toString();
}

export function FontSizeField({
  value,
  defaultSize,
  onChange,
}: {
  value: number | undefined;
  /** Painted-state size when `value` is undefined — should mirror the
   *  renderer's per-kind default so the field doesn't lie. */
  defaultSize: number;
  onChange: (v: number | undefined) => void;
}) {
  // Display format: at most 2 decimal places, trailing zeros trimmed.
  // 13 → "13"; 13.5 → "13.5"; 27.234 → "27.23". This matches how the
  // text-shape resize handler stores values (rounded to 2 decimals on
  // every drag frame), so the field doesn't lie about what's painted.
  const rawValue = value ?? defaultSize;
  const display = Math.round(rawValue * 100) / 100;
  const formatted = formatFontSize(display);
  const [draft, setDraft] = useState(formatted);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // External writes (undo, picker, +/-) update the draft when the input isn't
  // currently being typed in — same pattern as the Inspector's CommitInput so
  // typing isn't clobbered mid-edit.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setDraft(formatted);
  }, [formatted]);

  // Outside-click + Escape close the preset dropdown. Pointer-down (not click)
  // matches the moment the user starts a press elsewhere, which feels right —
  // a click that lands outside is preceded by mousedown there, so we close
  // before the click handler runs and the menu disappears predictably.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
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

  const commitNumber = (n: number) => {
    if (!Number.isFinite(n)) return;
    // Round to 2 decimals so a typed "27.234" stores as 27.23 — same
    // precision the resize-drag uses, so values committed by either
    // path round-trip identically through the field.
    const clamped = Math.max(
      FONT_SIZE_MIN,
      Math.min(FONT_SIZE_MAX, Math.round(n * 100) / 100),
    );
    onChange(clamped);
  };

  // Stepping snaps to whole numbers — +/- buttons and arrow keys are
  // integer-step UX, even when the current value is fractional. So a
  // value of 27.23 + step(1) → 28 (not 28.23). That matches Google
  // Docs, Figma, and what users expect from a stepper.
  const step = (delta: number) => commitNumber(Math.round(display) + delta);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <button
        type="button"
        title="Decrease font size"
        // preventDefault on mousedown keeps the contentEditable focused when
        // this control is rendered inside the inline-editor toolbar — without
        // it, clicking − would blur the editor and commit mid-edit.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-1)}
        style={STEPPER_BTN}
      >
        −
      </button>
      <div
        style={{
          position: 'relative',
          width: 50,
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'var(--bg-subtle)',
          display: 'inline-flex',
          alignItems: 'center',
          paddingRight: 12,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          // Allow digits, a single decimal point, and the leading "."
          // case (".5" → 0.5). Strip everything else so paste of "27pt"
          // becomes "27". Multiple decimal points collapse to the first.
          onChange={(e) => {
            const cleaned = e.target.value
              .replace(/[^0-9.]/g, '')
              .replace(/(\..*)\./g, '$1');
            setDraft(cleaned);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            const n = parseFloat(draft);
            if (draft === '') onChange(undefined);
            else if (Number.isFinite(n) && n > 0) commitNumber(n);
            else setDraft(formatted);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              setDraft(formatted);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          // Don't open the dropdown on every focus — the user might have just
          // tabbed in to type a number. Open on click of the chevron instead
          // (below), which matches Docs.
          style={{
            width: '100%',
            padding: '4px 0 4px 8px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--fg)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            textAlign: 'left',
          }}
        />
        <button
          type="button"
          title="Pick preset size"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            fontSize: 9,
            lineHeight: 1,
          }}
        >
          ▾
        </button>
      </div>
      <button
        type="button"
        title="Increase font size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(1)}
        style={STEPPER_BTN}
      >
        +
      </button>
      {open && (
        <div
          className="float"
          style={{
            position: 'absolute',
            top: '100%',
            left: 27, // line up under the number cell, right of the −
            marginTop: 4,
            width: 56,
            maxHeight: 240,
            overflowY: 'auto',
            padding: '4px 0',
            zIndex: 50,
          }}
          // Stop clicks from bubbling to the editor — the toolbar's onBlur
          // logic already covers this for the toolbar use, but the inspector
          // use renders this dropdown outside the toolbar, and a stray bubble
          // could hit the canvas.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {FONT_SIZE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 8px',
                background: p === display ? 'var(--bg-emphasis)' : 'transparent',
                border: 'none',
                color: 'var(--fg)',
                fontSize: 12,
                fontFamily: 'var(--font-body)',
                textAlign: 'center',
                cursor: 'pointer',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STEPPER_BTN: React.CSSProperties = {
  width: 22,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--fg)',
  fontSize: 14,
  lineHeight: 1,
  flexShrink: 0,
};
