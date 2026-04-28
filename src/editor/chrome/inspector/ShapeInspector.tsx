import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '@/store/editor';
import { type Layer, type Shape } from '@/store/types';
import { isMonochromeSvg } from '@/icons/recolorable';
import { computeContainerIconPosition } from '@/editor/canvas/projection';
import { I } from '../icons';
import { FontPicker } from './FontPicker';
import {
  CornerRadiusField,
  FontSizeField,
  OpacityField,
  StrokeWidthField,
  SwatchRow,
} from './StyleControls';

/** Body field is only meaningful where the renderer paints body text — every
 *  other kind would silently store the string with no visible effect. Mirrors
 *  Shape.tsx's `showBodyInside` check so the inspector and the renderer
 *  agree about which kinds carry body content. */
const BODY_BEARING_KINDS = new Set<Shape['kind']>([
  'rect',
  'ellipse',
  'diamond',
  'note',
  'service',
  'text',
]);

/** Default font size per kind — mirrors the renderer's per-kind fallback so
 *  the FontSizeField doesn't lie about what's painting when no override is
 *  set. Kept here (not in StyleControls) because the per-kind defaults are
 *  inspector-shape semantics, not generic style-control concern. */
const DEFAULT_FONT_SIZE_BY_KIND: Partial<Record<Shape['kind'], number>> = {
  note: 18,
};
function defaultFontSizeFor(kind: Shape['kind']): number {
  return DEFAULT_FONT_SIZE_BY_KIND[kind] ?? 13;
}

/** Kinds eligible to be wrapped in a container. Basic shapes (rect, ellipse,
 *  diamond, text, note) are excluded — the user spec calls for containerising
 *  icons / images / service tiles so the visual sits in the top-left corner
 *  of a frame the user can drop more stuff into. Wrapping a basic shape in a
 *  container would just be redundant with making a group. */
const CONTAINERISABLE_KINDS = new Set<Shape['kind']>([
  'icon',
  'image',
  'service',
]);

/** Shape inspector — layer pill, label, appearance, freeform metadata.
 *  All fields commit on blur or Enter so history tracks one step per logical
 *  edit (not per keystroke).
 *
 *  Multi-selection contract:
 *    - STYLE fields (stroke/fill/font/opacity/etc) go through
 *      `updateSelection`, which fans out to every selected shape AND every
 *      selected connector with cross-type translation (icon tint, image
 *      opacity, connector strokeStyle→style). One inspector edit, all
 *      selected items updated, single undo step.
 *    - PER-SHAPE fields (label, body, anchor, layer wrapping) stay on
 *      `updateShape(shape.id, ...)` — multi-editing a label across N shapes
 *      doesn't have a sensible meaning.
 *    - LAYER toggle uses `setSelectionLayer`, same pre-existing pattern. */
export function ShapeInspector({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  const updateSelection = useEditor((s) => s.updateSelection);
  // Layer toggle reads the *selection*, not just the inspected shape, so a
  // multi-select Notes→Blueprint flip works in both directions. The single-
  // shape `setShapeLayer` is still on the store but the inspector goes
  // through `setSelectionLayer` so the act-on-selection contract is one
  // place.
  const setSelectionLayer = useEditor((s) => s.setSelectionLayer);
  const selectionCount = useEditor((s) => s.selectedIds.length);
  const promote = useEditor((s) => s.promoteSelection);
  const makeContainer = useEditor((s) => s.makeContainer);
  // Detect if the shape is already inside a container — if so, hide the
  // "Make container" button so the user doesn't double-wrap.
  const parent = useEditor((s) =>
    shape.parent
      ? s.diagram.shapes.find((p) => p.id === shape.parent) ?? null
      : null,
  );
  const alreadyInContainer = parent?.kind === 'container';

  const showBody = BODY_BEARING_KINDS.has(shape.kind);
  // Tables don't render the shape-level label or body — the cells ARE the
  // content. Hide the LABEL section to avoid a phantom field that wouldn't
  // paint anywhere; the table's own header / cell anchors live in the
  // dedicated TABLE section below.
  const showLabel = shape.kind !== 'table';

  // Header preview: the shape's label IS the entire content for a text shape,
  // so a pasted paragraph used to render here as a wall of text and push the
  // kind chip off the row. Truncate to a single line with ellipsis. Newlines
  // collapse to a space first so a multi-line label still fits on one row.
  // Keep the full text in `title` so hovering surfaces the original.
  const HEADER_PREVIEW_MAX = 40;
  const fullHeader = shape.label || titleCase(shape.kind);
  const headerSingleLine = fullHeader.replace(/\s*\n\s*/g, ' ').trim();
  const headerPreview =
    headerSingleLine.length > HEADER_PREVIEW_MAX
      ? `${headerSingleLine.slice(0, HEADER_PREVIEW_MAX - 1)}…`
      : headerSingleLine;

  return (
    <div className="float absolute top-[70px] right-[14px] z-[14] w-[280px] max-h-[calc(100vh-100px)] overflow-y-auto">
      <div className="px-[14px] py-[10px] border-b border-border flex items-center justify-between gap-2">
        <div
          className="text-[12px] font-semibold flex items-center gap-2 min-w-0"
          title={fullHeader}
        >
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{
              background:
                shape.layer === 'notes'
                  ? 'var(--sketch)'
                  : 'var(--accent)',
            }}
          />
          <span className="truncate">{headerPreview}</span>
        </div>
        <span className="font-mono text-[9px] text-fg-muted px-[6px] py-[2px] bg-bg-emphasis rounded-[3px]">
          {shape.kind}
        </span>
      </div>

      {/* APPEARANCE — moved to the top of the panel (was buried under LABEL /
       *  BODY / LAYER / GROUPING). The user reaches for stroke/fill/font far
       *  more often than for the meta sections; pushing them above the fold
       *  removes the constant scroll. The kind branches keep their per-kind
       *  field set; OPACITY is folded in as a `.opacity` row so the panel
       *  doesn't grow a second appearance section.
       *
       *  Container & connector inspectors read from this same module; the
       *  re-ordering only moves the JSX slots — nothing about the shape
       *  schema or update calls changed. */}
      {shape.kind === 'image' ? (
        <Section title="APPEARANCE">
          <Field label=".filter">
            <div className="seg">
              {(
                [
                  ['none', 'none'],
                  ['grayscale', 'B&W'],
                  ['sepia', 'sepia'],
                  ['invert', 'invert'],
                  ['blur', 'blur'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={(shape.imageFilter ?? 'none') === v ? 'active' : ''}
                  onClick={() =>
                    updateSelection({
                      imageFilter: v === 'none' ? undefined : v,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {/* Tint — duotone-style luminance mapping. Re-uses SwatchRow
           *  because the user's stroke palette is the right vocabulary for
           *  picking a wash colour, and the swatch resolver theme-flips it
           *  for free. `none` cell maps to undefined → no tint applied
           *  (image renders at its native colour). */}
          <Field label=".tint">
            <SwatchRow
              kind="stroke"
              value={shape.imageTint}
              onChange={(v) => updateSelection({ imageTint: v })}
              allowNone={true}
            />
          </Field>
          {/* Roundiness — shares the schema field with rect's cornerRadius
           *  (renderer clamps to min(w,h)/2). 16 px is the same default the
           *  rect inspector uses for the slider's auto thumb so multi-
           *  selecting an image + rect and dragging the slider lands the
           *  same effective radius on both. */}
          <Field label=".radius">
            <CornerRadiusField
              value={shape.cornerRadius}
              defaultDisplay={shape.cornerRadius ?? 0}
              onChange={(v) => updateSelection({ cornerRadius: v })}
            />
          </Field>
          <Field label=".opacity">
            <OpacityField
              value={shape.opacity}
              onChange={(v) => updateSelection({ opacity: v })}
            />
          </Field>
        </Section>
      ) : shape.kind === 'icon' ? (
        // Icon shapes intentionally don't expose fill / font / stroke-width —
        // those would let the user violate the asset's licensing constraints.
        // We DO expose a tint when (a) the icon's licence allows recolouring
        // (`lockColors !== true` — Iconify, never vendor) AND (b) the SVG is
        // actually monochrome. Multi-colour SVGs ignore the wrapper `color`
        // rule, so showing the swatch on them would be a lie. The tint maps
        // to `shape.stroke`, which the canvas pipes into the SVG wrapper as a
        // CSS `color` so any `currentColor` reference in the icon body picks
        // it up.
        <IconBranch shape={shape} updateSelection={updateSelection} />
      ) : (
        <Section title="APPEARANCE">
          <Field label=".stroke">
            <SwatchRow
              kind="stroke"
              value={shape.stroke}
              onChange={(v) => updateSelection({ stroke: v })}
            />
          </Field>
          <Field label=".fill">
            <SwatchRow
              kind="fill"
              value={shape.fill}
              onChange={(v) => updateSelection({ fill: v })}
            />
          </Field>
          {/* Fill alpha — sub-control of .fill, sits directly under the
           *  swatch row so the user reads it as "this fill, but how
           *  opaque". Distinct from the .opacity row below (which fades
           *  the whole shape including stroke + label). Reuses
           *  OpacityField — same slider track + double-click-to-reset
           *  semantics — so the two controls feel consistent. */}
          <Field label=".fill α">
            {/* Containers paint a 5% wash by default (see Shape.tsx); pass
             *  that as the slider's "auto" position so the thumb sits at
             *  5% when the user hasn't overridden, and the % readout
             *  doesn't lie about the effective opacity. */}
            <OpacityField
              value={shape.fillOpacity}
              defaultDisplay={shape.kind === 'container' ? 0.05 : 1}
              onChange={(v) => updateSelection({ fillOpacity: v })}
            />
          </Field>
          <Field label=".text">
            <SwatchRow
              kind="stroke"
              value={shape.textColor}
              onChange={(v) => updateSelection({ textColor: v })}
            />
          </Field>
          <Field label=".line">
            <StrokeWidthField
              value={shape.strokeWidth}
              onChange={(v) => updateSelection({ strokeWidth: v })}
            />
          </Field>
          <Field label=".dash">
            {/* Stroke style — same axis as the connector inspector. Container
             *  shapes default to dashed (their identity); other kinds default
             *  to solid. The displayed-active value mirrors the renderer's
             *  default so flipping back to "default" looks right.
             *
             *  We always write a concrete strokeStyle (even when it matches
             *  the kind default) so the user's choice survives through other
             *  edits — without that, a click on "dashed" for a container
             *  would no-op visually because it's already the default. */}
            <div className="seg">
              {(() => {
                const containerDefault = shape.kind === 'container';
                const effective =
                  shape.strokeStyle ?? (containerDefault ? 'dashed' : 'solid');
                return (['solid', 'dashed', 'dotted'] as const).map((s) => (
                  <button
                    key={s}
                    className={effective === s ? 'active' : ''}
                    onClick={() => updateSelection({ strokeStyle: s })}
                    title={s}
                  >
                    {s}
                  </button>
                ));
              })()}
            </div>
          </Field>
          {/* Corner radius — rect / service / container only at render time,
           *  and only the Blueprint layer honours it (Notes-layer rects use
           *  the baked-in chunky 10 sticker-paper treatment regardless). Hide
           *  the field on kinds / layers that would silently ignore it so the
           *  inspector doesn't expose a control with no visible effect. The
           *  per-kind defaults mirror the renderer fallbacks (rect = 4,
           *  service = 8, container = 6) so the slider's "auto" thumb sits
           *  where the canvas is actually painting. */}
          {(shape.kind === 'rect' ||
            shape.kind === 'service' ||
            shape.kind === 'container') &&
            shape.layer !== 'notes' && (
              <Field label=".roundness">
                <CornerRadiusField
                  value={shape.cornerRadius}
                  defaultDisplay={
                    shape.kind === 'service'
                      ? 8
                      : shape.kind === 'container'
                        ? 6
                        : 4
                  }
                  onChange={(v) => updateSelection({ cornerRadius: v })}
                />
              </Field>
            )}
          <Field label=".font">
            <FontPicker
              value={shape.fontFamily}
              onChange={(v) => updateSelection({ fontFamily: v })}
            />
          </Field>
          {/* Font size — added per the user's "text size slider when
           *  selecting a shape" request. Uses the same Google-Docs-style
           *  control the inline editor's toolbar uses, so size feels
           *  identical whether you adjust it from the inspector or from
           *  the in-place editing toolbar. The `defaultSize` mirrors the
           *  renderer's per-kind fallback so the field doesn't lie when
           *  no override is set. */}
          <Field label=".size">
            <FontSizeField
              value={shape.fontSize}
              defaultSize={defaultFontSizeFor(shape.kind)}
              onChange={(v) => updateSelection({ fontSize: v })}
            />
          </Field>
          <Field label=".opacity">
            <OpacityField
              value={shape.opacity}
              onChange={(v) => updateSelection({ opacity: v })}
            />
          </Field>
        </Section>
      )}

      {showLabel && (
      <Section title="LABEL">
        <CommitInput
          value={shape.label ?? ''}
          placeholder="(no label)"
          onCommit={(v) => update(shape.id, { label: v || undefined })}
        />
        {/* Label anchor — picker for where the label sits relative to the
         *  shape body. Two parallel 3×3 grids: INSIDE (label tucks into the
         *  bbox at the matching cell) and OUTSIDE (label hangs off the bbox
         *  at the matching cell). Each grid cell is a tiny SVG showing a
         *  rectangle + a dot at the indicated position — which makes "top-
         *  left inside" vs "top-left outside" read at a glance without
         *  cluttering the panel with text labels.
         *
         *  Mappings to the labelAnchor enum:
         *    Inside grid → top-left, inside-top, top-right
         *                  inside-left, center, inside-right
         *                  bottom-left, inside-bottom, bottom-right
         *    Outside grid → outside-top-left, above, outside-top-right
         *                   left, ▢, right
         *                   outside-bottom-left, below, outside-bottom-right
         *
         *  `right-of-icon` is container-specific — we show it as a separate
         *  pill below the grids when the inspected shape is a container.
         */}
        <div className="mt-2">
          <span className="field-label block mb-1">.anchor</span>
          <AnchorPicker
            shape={shape}
            onChange={(v) => update(shape.id, { labelAnchor: v })}
          />
        </div>
        {/* Container-only: where the anchor icon child sits inside the
         *  frame. Mirrors the text-anchor picker (same 3×3 grid, no
         *  outside variant — an icon doesn't sit OUTSIDE its own
         *  container). On change, also re-snap the anchor child so the
         *  picker reflects the live state immediately rather than only
         *  taking effect on the next resize. Added 2026-04-28. */}
        {shape.kind === 'container' && (
          <div className="mt-3">
            <span className="field-label block mb-1">.icon position</span>
            <IconAnchorPicker
              container={shape}
              onChange={(v) => {
                // Two writes batched into one call: set the anchor field
                // AND reposition the anchor child. updateShape doesn't
                // accept multi-shape patches, so we do them in sequence —
                // updateShape snapshots once per call, so undo will revert
                // both in two steps. Acceptable cost for a rare action.
                update(shape.id, { iconAnchor: v });
                if (shape.anchorId) {
                  // Read the latest container state so position math sees
                  // the just-written iconAnchor (not strictly necessary
                  // here since computeContainerIconPosition takes anchor
                  // explicitly, but matches the resize handler's pattern).
                  const child = useEditor
                    .getState()
                    .diagram.shapes.find((s) => s.id === shape.anchorId);
                  if (child) {
                    const pos = computeContainerIconPosition(
                      shape,
                      { w: child.w, h: child.h },
                      v,
                    );
                    update(child.id, { x: pos.x, y: pos.y });
                  }
                }
              }}
            />
          </div>
        )}
      </Section>
      )}

      {/* Body text — the wrapping interior text of a shape. Distinct from
       *  LABEL (which sits at the anchor). Multi-line input so users can
       *  type paragraphs; commits on blur. Hidden for kinds where the
       *  renderer wouldn't paint body anyway — typing into a phantom field
       *  is a clutter cost without any visible reward. Mirrors Shape.tsx's
       *  `showBodyInside` set. */}
      {showBody && (
        <Section title="BODY">
          <CommitTextarea
            value={shape.body ?? ''}
            placeholder="(no body text)"
            onCommit={(v) => update(shape.id, { body: v || undefined })}
          />
        </Section>
      )}

      <Section title="LAYER">
        <div className="seg">
          {(['notes', 'blueprint'] as Layer[]).map((l) => (
            <button
              key={l}
              className={shape.layer === l ? 'active' : ''}
              onClick={() => setSelectionLayer(l)}
              title={
                selectionCount > 1
                  ? `Move all ${selectionCount} selected to ${l}`
                  : `Move to ${l}`
              }
            >
              {l}
            </button>
          ))}
        </div>
        {shape.layer === 'notes' && (
          <button
            className="mt-2 w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
            onClick={promote}
          >
            <I.promote />
            Promote to Blueprint
          </button>
        )}
      </Section>

      {CONTAINERISABLE_KINDS.has(shape.kind) && !alreadyInContainer && (
        <Section title="GROUPING">
          <button
            className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
            onClick={() => makeContainer(shape.id)}
            title="Wrap this shape in a container — it stays anchored at the top-left and you can drop other shapes inside the frame to group them."
          >
            Make container
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
            Wraps this shape in a frame. Drop other shapes into the frame to
            group them — they'll move together when you drag the container.
          </p>
        </Section>
      )}

      {shape.kind === 'container' && (
        <ContainerIconSection shape={shape} />
      )}

      {shape.kind === 'table' && <TableSection shape={shape} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // Vertical padding tightened from py-3 (12px) → py-[10px] so the panel
  // doesn't run off the bottom of the viewport on smaller laptops, and the
  // user sees more sections without scrolling.
  return (
    <div className="px-[14px] py-[10px] border-b border-border last:border-b-0">
      <h4 className="font-mono text-[9px] font-medium text-fg-muted mb-[8px] tracking-[0.04em]">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function CommitInput({
  value,
  placeholder,
  onCommit,
  className = 'field-input',
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  className?: string;
}) {
  // Track an internal draft so typing doesn't clobber the store on every key.
  // Re-sync when value changes externally (undo) but only if the field isn't
  // currently focused — otherwise external writes would clobber typing.
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement?.tagName === 'INPUT') return;
    setDraft(value);
  }, [value]);
  return (
    <input
      className={className}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Multiline body-text input. Same commit-on-blur semantics as CommitInput
 *  (so undo logs one history step per logical edit). Cmd/Ctrl+Enter commits
 *  early; Escape reverts. Plain Enter inserts a newline so paragraphs work. */
function CommitTextarea({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement?.tagName === 'TEXTAREA') return;
    setDraft(value);
  }, [value]);
  return (
    <textarea
      className="field-input"
      placeholder={placeholder}
      value={draft}
      rows={3}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      style={{ resize: 'vertical', minHeight: 60 }}
    />
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 3×3 cell coordinate within the picker grid. */
type Cell = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

/** Map (cell × inside/outside) → labelAnchor. The outside-c cell is null —
 *  there is no "centred outside" semantic; that's just `center` from the
 *  inside grid. */
const ANCHOR_MAP: Record<
  'inside' | 'outside',
  Record<Cell, NonNullable<Shape['labelAnchor']> | null>
> = {
  inside: {
    tl: 'top-left',
    t: 'inside-top',
    tr: 'top-right',
    l: 'inside-left',
    c: 'center',
    r: 'inside-right',
    bl: 'bottom-left',
    b: 'inside-bottom',
    br: 'bottom-right',
  },
  outside: {
    tl: 'outside-top-left',
    t: 'above',
    tr: 'outside-top-right',
    l: 'left',
    c: null,
    r: 'right',
    bl: 'outside-bottom-left',
    b: 'below',
    br: 'outside-bottom-right',
  },
};

/** Two 3×3 grids stacked horizontally — Inside | Outside. Each cell renders
 *  a tiny SVG diagram of "rectangle + dot at this position" so the user
 *  reads inside/outside variants visually without label text. The center
 *  cell of the OUTSIDE grid is intentionally rendered as a disabled
 *  placeholder — there's no centred-outside anchor (that's just `center`
 *  from the inside grid). */
function AnchorPicker({
  shape,
  onChange,
}: {
  shape: Shape;
  onChange: (v: NonNullable<Shape['labelAnchor']>) => void;
}) {
  const cur =
    shape.labelAnchor ??
    (shape.kind === 'icon' || shape.kind === 'image'
      ? 'below'
      : shape.kind === 'container'
        ? 'right-of-icon'
        : 'center');

  return (
    <>
      <AnchorGrid
        value={cur}
        onChange={onChange}
        showOutside
      />
      {/* Container-specific anchor — pinned to the right of the icon child.
       *  Surfaced as a separate pill so it doesn't disrupt the symmetry of
       *  the two grids. */}
      {shape.kind === 'container' && (
        <div className="mt-2">
          <button
            onClick={() => onChange('right-of-icon')}
            title="Anchor label to the right of the container's icon"
            className={`px-2 py-[5px] rounded border text-[10px] font-mono ${
              cur === 'right-of-icon'
                ? 'border-accent text-fg bg-bg-emphasis'
                : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
            }`}
          >
            icon →
          </button>
        </div>
      )}
    </>
  );
}

/** Container-only icon-position picker. Mirrors AnchorPicker visually but
 *  emits a constrained subset of LabelAnchor (the inside 3×3) and reads
 *  shape.iconAnchor as its source of truth. The outside grid is suppressed
 *  — an icon child can't live OUTSIDE its container — so this widget is
 *  AnchorGrid with `showOutside={false}` plus a header label. Added
 *  2026-04-28 (Josh: "Icon position anchor that looks and works
 *  identically to the text anchor"). */
function IconAnchorPicker({
  container,
  onChange,
}: {
  container: Shape;
  onChange: (v: NonNullable<Shape['iconAnchor']>) => void;
}) {
  const cur = container.iconAnchor ?? 'top-left';
  return <AnchorGrid value={cur} onChange={onChange} showOutside={false} />;
}

/** Generic anchor picker — value-in / value-out, no shape coupling. The
 *  table cell anchors and the shape label anchor share this widget. With
 *  `showOutside={false}` only the inside 3×3 renders (cell anchors don't
 *  support outside positions — text can't sit outside a cell wall). */
function AnchorGrid({
  value,
  onChange,
  showOutside,
}: {
  value: NonNullable<Shape['labelAnchor']>;
  onChange: (v: NonNullable<Shape['labelAnchor']>) => void;
  showOutside: boolean;
}) {
  const Cell3x3 = ({ side }: { side: 'inside' | 'outside' }) => {
    const cells: Cell[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
    return (
      <div className="grid grid-cols-3 gap-[2px]">
        {cells.map((cell) => {
          const v = ANCHOR_MAP[side][cell];
          if (!v) {
            return (
              <span
                key={cell}
                aria-hidden
                className="block w-[22px] h-[22px] rounded border border-dashed border-border opacity-30"
              />
            );
          }
          const active = value === v;
          return (
            <button
              key={cell}
              onClick={() => onChange(v)}
              title={`Anchor: ${side} ${cell}`}
              className={`w-[22px] h-[22px] rounded border flex items-center justify-center ${
                active
                  ? 'border-accent text-fg bg-bg-emphasis'
                  : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
              }`}
            >
              <AnchorGlyph cell={cell} side={side} />
            </button>
          );
        })}
      </div>
    );
  };
  return (
    <div className="flex gap-3 items-start">
      <div>
        {showOutside && (
          <div className="font-mono text-[9px] text-fg-muted mb-1 tracking-[0.04em]">
            INSIDE
          </div>
        )}
        <Cell3x3 side="inside" />
      </div>
      {showOutside && (
        <div>
          <div className="font-mono text-[9px] text-fg-muted mb-1 tracking-[0.04em]">
            OUTSIDE
          </div>
          <Cell3x3 side="outside" />
        </div>
      )}
    </div>
  );
}

/** Tiny SVG glyph: a rectangle with a single dot at the indicated cell.
 *  inside ⇒ dot lives inside the rect; outside ⇒ dot lives just past the
 *  rect at the same cell. Reads at a glance — much more legible than a
 *  text label like "top-left" once the user knows the convention. */
function AnchorGlyph({ cell, side }: { cell: Cell; side: 'inside' | 'outside' }) {
  // 14×14 viewport. Body rect is 10×10 centred (covers 2..12 on both axes).
  // Inside dots sit at +/- 3.5 from centre (within the rect); outside dots
  // sit at +/- 6 from centre (just beyond the rect's edge).
  const inset = side === 'inside' ? 3.5 : 6;
  const cx = cell.includes('l') ? 7 - inset : cell.includes('r') ? 7 + inset : 7;
  const cy = cell.startsWith('t') ? 7 - inset : cell.startsWith('b') ? 7 + inset : 7;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <rect
        x={2}
        y={2}
        width={10}
        height={10}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.6}
      />
      <circle cx={cx} cy={cy} r={1.4} fill="currentColor" />
    </svg>
  );
}

/** ICON section inside a container's inspector. Two states:
 *    - container has an icon child → "Change icon" + open the picker flyout
 *      pinned to the button's screen position (same flyout used by the on-
 *      canvas double-click and "+" affordances).
 *    - container has no icon child → "Add icon" — same picker.
 *
 *  Was originally just an "Add icon" button that opened the LibraryPanel;
 *  funneling to the inline ContainerIconFlyout via the existing
 *  `vellum:open-icon-picker` event keeps the swap UX consistent across
 *  entry points (canvas dblclick, canvas +, inspector). */
/** Table inspector section. Always renders structural controls (rows /
 *  cols / default cell anchor / header toggles). When `editingCell` points
 *  at this table, also renders a CELL sub-section: per-cell anchor (which
 *  overrides the table default), insert/delete-around-this-cell buttons,
 *  and a clear-cell action. The cell sub-section keeps the user in
 *  context — they can pick a per-cell alignment without leaving the cell
 *  they're typing into. */
function TableSection({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  const editingCell = useEditor((s) => s.editingCell);
  const selectedCell = useEditor((s) => s.selectedCell);
  const setEditingCell = useEditor((s) => s.setEditingCell);
  const setSelectedCell = useEditor((s) => s.setSelectedCell);
  const setCellPatch = useEditor((s) => s.setCellPatch);
  const insertTableRow = useEditor((s) => s.insertTableRow);
  const insertTableCol = useEditor((s) => s.insertTableCol);
  const deleteTableRow = useEditor((s) => s.deleteTableRow);
  const deleteTableCol = useEditor((s) => s.deleteTableCol);

  const rows = Math.max(1, Math.floor(shape.rows ?? 3));
  const cols = Math.max(1, Math.floor(shape.cols ?? 3));
  const cellAnchor = shape.cellAnchor ?? 'center';

  // CELL section appears when EITHER edit OR select points at this table —
  // `editingCell` wins so the section reflects exactly what the user is
  // actively interacting with. Single-clicking a cell sets selectedCell;
  // double-clicking sets editingCell. Either is enough to surface
  // per-cell options.
  const cellEdit =
    (editingCell && editingCell.shapeId === shape.id ? editingCell : null) ??
    (selectedCell && selectedCell.shapeId === shape.id ? selectedCell : null);
  const cellAt = cellEdit ? shape.cells?.[cellEdit.row]?.[cellEdit.col] ?? null : null;
  // Per-cell anchor — picker shows the cell's own override if set, else the
  // table default so the picker doesn't lie.
  const cellAnchorValue = cellAt?.anchor ?? cellAnchor;

  return (
    <>
      <Section title="TABLE">
        {/* Rows/cols stack vertically — Field's flex layout gets crammed and
         *  labels overlap the steppers when squeezed into grid-cols-2. One
         *  per line keeps the labels readable and the steppers comfortable. */}
        <Field label=".rows">
          <NumberStepper
            value={rows}
            min={1}
            max={50}
            onChange={(v) => {
              if (v > rows) {
                for (let i = 0; i < v - rows; i++) insertTableRow(shape.id, rows);
              } else if (v < rows) {
                for (let i = 0; i < rows - v; i++) deleteTableRow(shape.id, rows - 1 - i);
              }
            }}
          />
        </Field>
        <Field label=".cols">
          <NumberStepper
            value={cols}
            min={1}
            max={50}
            onChange={(v) => {
              if (v > cols) {
                for (let i = 0; i < v - cols; i++) insertTableCol(shape.id, cols);
              } else if (v < cols) {
                for (let i = 0; i < cols - v; i++) deleteTableCol(shape.id, cols - 1 - i);
              }
            }}
          />
        </Field>
        <div className="mt-2 flex flex-col gap-[6px]">
          <CheckRow
            label=".header row"
            checked={!!shape.headerRow}
            onChange={(v) => update(shape.id, { headerRow: v || undefined })}
          />
          <CheckRow
            label=".header col"
            checked={!!shape.headerCol}
            onChange={(v) => update(shape.id, { headerCol: v || undefined })}
          />
        </div>
        <div className="mt-3">
          <span className="field-label block mb-1">.cell anchor</span>
          <AnchorGrid
            value={cellAnchor}
            onChange={(v) => update(shape.id, { cellAnchor: v })}
            showOutside={false}
          />
          <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
            Default alignment for every cell. Per-cell overrides win when
            set — double-click a cell to edit it and override here.
          </p>
        </div>
      </Section>
      {cellEdit && (
        <Section title={`CELL · row ${cellEdit.row + 1}, col ${cellEdit.col + 1}`}>
          <div>
            <span className="field-label block mb-1">.anchor</span>
            <AnchorGrid
              value={cellAnchorValue}
              onChange={(v) =>
                setCellPatch(shape.id, cellEdit.row, cellEdit.col, { anchor: v })
              }
              showOutside={false}
            />
            {cellAt?.anchor !== undefined && (
              <button
                onClick={() =>
                  setCellPatch(shape.id, cellEdit.row, cellEdit.col, {
                    anchor: undefined,
                  })
                }
                className="mt-2 px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
                title="Clear per-cell anchor — fall back to the table default"
              >
                use default
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => insertTableRow(shape.id, cellEdit.row)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a row above this cell"
            >
              ↑ row above
            </button>
            <button
              onClick={() => insertTableRow(shape.id, cellEdit.row + 1)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a row below this cell"
            >
              ↓ row below
            </button>
            <button
              onClick={() => insertTableCol(shape.id, cellEdit.col)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a column to the left of this cell"
            >
              ← col left
            </button>
            <button
              onClick={() => insertTableCol(shape.id, cellEdit.col + 1)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a column to the right of this cell"
            >
              → col right
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                if (rows <= 1) return;
                deleteTableRow(shape.id, cellEdit.row);
                // Move whichever pointer is active to the row that took this
                // row's place, clamped to the last valid index. If the user
                // is editing, keep them in edit mode; otherwise keep them in
                // selection mode (so the inspector section stays open).
                const nextRow = Math.min(rows - 2, cellEdit.row);
                const target = { shapeId: shape.id, row: nextRow, col: cellEdit.col };
                if (editingCell?.shapeId === shape.id) setEditingCell(target);
                else setSelectedCell(target);
              }}
              disabled={rows <= 1}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              title={rows <= 1 ? 'Cannot delete the only row' : 'Delete this row'}
            >
              delete row
            </button>
            <button
              onClick={() => {
                if (cols <= 1) return;
                deleteTableCol(shape.id, cellEdit.col);
                const nextCol = Math.min(cols - 2, cellEdit.col);
                const target = { shapeId: shape.id, row: cellEdit.row, col: nextCol };
                if (editingCell?.shapeId === shape.id) setEditingCell(target);
                else setSelectedCell(target);
              }}
              disabled={cols <= 1}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              title={cols <= 1 ? 'Cannot delete the only column' : 'Delete this column'}
            >
              delete col
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

/** Compact ± stepper for integer fields. Used by TableSection's row/col
 *  count controls. */
function NumberStepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-stretch gap-[2px]">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-6 h-7 border border-border bg-bg-subtle text-fg hover:bg-bg-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[12px] leading-none"
        title={`Decrease (min ${min})`}
      >
        −
      </button>
      <span className="flex-1 inline-flex items-center justify-center px-2 h-7 border border-border rounded font-mono text-[12px] bg-bg-subtle text-fg">
        {value}
      </span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-6 h-7 border border-border bg-bg-subtle text-fg hover:bg-bg-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[12px] leading-none"
        title={`Increase (max ${max})`}
      >
        +
      </button>
    </div>
  );
}

/** Compact toggle for boolean table options. */
function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`px-2 py-[5px] rounded border text-[10px] font-mono ${
        checked
          ? 'border-accent text-fg bg-bg-emphasis'
          : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
      }`}
      title={`${checked ? 'Disable' : 'Enable'} ${label}`}
    >
      {checked ? '✓ ' : ''}
      {label}
    </button>
  );
}

function ContainerIconSection({ shape }: { shape: Shape }) {
  // Look up whether there's actually an icon-kind child anchored to this
  // container. `anchorId` is the explicit pin (newer containers); legacy
  // diagrams fall back to "first child by parent". Either way we only count
  // it as "has an icon" when the resolved child is `kind: 'icon'` —
  // otherwise child containers / images / nested groups would falsely
  // report "icon present" and flip the button label.
  const hasIcon = useEditor((s) => {
    if (shape.anchorId !== undefined) {
      const a = s.diagram.shapes.find((sh) => sh.id === shape.anchorId);
      // Strict: anchorId is the source of truth once stamped. If it's stale
      // (anchored icon was deleted), report `false` so the inspector's
      // button reads "Add icon" — matching what the user expects after
      // deleting the anchor. Falling back to "any icon-by-parent" would
      // mis-report "Change icon" while the actual icon picker (which keys
      // off anchorId) would be in the ADD path, and the canvas label would
      // render in the no-anchor slot. All three signals would disagree.
      return !!(a && a.parent === shape.id && a.kind === 'icon');
    }
    // Legacy fallback for diagrams pre-anchorId.
    return s.diagram.shapes.some(
      (sh) => sh.parent === shape.id && sh.kind === 'icon',
    );
  });
  const verb = hasIcon ? 'Change' : 'Add';
  return (
    <Section title="ICON">
      <button
        className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
        onClick={(e) => {
          // Pin the flyout to the inspector button's screen position. The
          // canvas listens for `vellum:open-icon-picker` and opens the
          // ContainerIconFlyout at the supplied (x, y). Reusing the
          // event keeps the picker UI consistent across all three entry
          // points (canvas dblclick, on-canvas "+" button, inspector).
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          window.dispatchEvent(
            new CustomEvent('vellum:open-icon-picker', {
              detail: {
                containerId: shape.id,
                x: r.left,
                y: r.bottom,
              },
            }),
          );
        }}
        title={
          hasIcon
            ? 'Swap this container’s anchored icon for another.'
            : 'Pick an icon to anchor at this container’s top-left.'
        }
      >
        <I.plusCircle /> {verb} icon
      </button>
      <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
        {hasIcon
          ? 'Swapping replaces the icon in place — geometry, connectors, and any per-shape tint stay put.'
          : 'Containers can carry an optional anchor icon in the top-left.'}
      </p>
    </Section>
  );
}

/** Icon-shape inspector body. Two stacked sections:
 *    - APPEARANCE — tint swatch, only shown for licence-permitted, actually
 *                   monochrome icons. Hidden for vendor (locked) and for
 *                   multi-colour iconify (the tint would do nothing visible).
 *    - ICON       — attribution + constraint readout. Always visible.
 *
 *  Style fields go through `updateSelection` so multi-select works (e.g.
 *  selecting two recolorable icons + a rectangle and changing fill paints
 *  all three the same colour, with the icons getting tinted via the
 *  cross-type translation in the store action). */
function IconBranch({
  shape,
  updateSelection,
}: {
  shape: Shape;
  updateSelection: (patch: Partial<Shape>) => void;
}) {
  // The SVG markup is part of the diagram so this is stable across re-renders;
  // memoise on the markup so we don't re-scan for every keystroke elsewhere.
  const monochrome = useMemo(
    () => isMonochromeSvg(shape.iconSvg),
    [shape.iconSvg],
  );
  const recolorable =
    shape.iconConstraints?.lockColors !== true && monochrome;

  return (
    <>
      {/* APPEARANCE for icons. Always rendered (even for non-recolorable
       *  vendor icons) so .opacity stays reachable — the previous gate hid
       *  the whole section for vendor logos, which meant the user couldn't
       *  fade them. The .tint row is still gated on recolorability so we
       *  don't lie about a swatch that wouldn't visibly do anything. */}
      <Section title="APPEARANCE">
        {recolorable && (
          <Field label=".tint">
            <SwatchRow
              kind="stroke"
              value={shape.stroke}
              onChange={(v) => updateSelection({ stroke: v })}
            />
          </Field>
        )}
        <Field label=".opacity">
          <OpacityField
            value={shape.opacity}
            onChange={(v) => updateSelection({ opacity: v })}
          />
        </Field>
      </Section>
      <Section title="ICON">
        {shape.iconAttribution ? (
          <div className="text-[11px] text-fg-muted leading-relaxed">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] text-fg">
                {shape.iconAttribution.iconId}
              </span>
              <span
                className="font-mono text-[9px] px-[5px] py-[1px] rounded-[3px] bg-bg-emphasis text-fg"
                title={
                  shape.iconAttribution.source === 'vendor'
                    ? 'Vendor trademark'
                    : `${shape.iconAttribution.license} licensed`
                }
              >
                {shape.iconAttribution.source === 'vendor'
                  ? '™'
                  : shape.iconAttribution.license}
              </span>
            </div>
            <div>{shape.iconAttribution.holder}</div>
            <div className="mt-2 flex gap-3">
              <a
                href={shape.iconAttribution.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent text-[10px]"
              >
                Source
              </a>
              {shape.iconAttribution.guidelinesUrl && (
                <a
                  href={shape.iconAttribution.guidelinesUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent text-[10px]"
                >
                  Brand guidelines
                </a>
              )}
            </div>
            {shape.iconConstraints && (
              <div className="mt-3 pt-2 border-t border-border text-[10px] font-mono text-fg-muted leading-relaxed">
                {shape.iconConstraints.lockColors && <div>· colors locked</div>}
                {shape.iconConstraints.lockAspect && <div>· aspect locked</div>}
                {shape.iconConstraints.lockRotation && (
                  <div>· rotation locked</div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-fg-muted font-mono">
            no attribution metadata
          </div>
        )}
      </Section>
    </>
  );
}
