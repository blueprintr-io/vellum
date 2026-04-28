// Excalidraw-style text-shape measurement.
//
// A `kind: 'text'` shape's bounding box always shrink-wraps to its rendered
// text. There are two modes:
//
//   1. autoSize=true (default after a bare-click drop) — both axes follow
//      content. Width = longest line; height = lines × lineHeight. No wrap;
//      explicit `\n` is the only line break.
//
//   2. autoSize=false (after the user drags the left/right edge to set a
//      wrap width) — width is pinned to shape.w; height auto-grows as the
//      text wraps to fit. Top/bottom edges become no-ops because the only
//      way to "shorten" text is to delete some.
//
// Corner-resize on a text shape is a special handler in Canvas.tsx — it
// scales fontSize, then this measurer computes the new w/h. We don't track
// fontSize separately from the bbox; the bbox is always derived.
//
// Implementation: a single offscreen <div> per page, mutated in place. We
// match the renderer's font setup (fontFamily, fontSize, fontWeight,
// lineHeight 1.2) so measureText agrees with what Shape.tsx will paint.

let _measureEl: HTMLDivElement | null = null;

function getMeasureEl(): HTMLDivElement {
  if (_measureEl && document.body.contains(_measureEl)) return _measureEl;
  if (typeof document === 'undefined') {
    throw new Error('measureText: no DOM (called from a non-browser context)');
  }
  const el = document.createElement('div');
  // Off-screen but rendered (display:none would not lay out, so dimensions
  // would all read 0). visibility:hidden + position:absolute keeps it out
  // of pointer hit-testing and accessibility tree without breaking layout.
  Object.assign(el.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    top: '0',
    left: '0',
    // Box sizing: the editor renders the text in a div with no padding
    // outside its outline; we mirror exactly so screen-space math agrees.
    padding: '0',
    margin: '0',
    border: '0',
    // contenteditable's default is white-space: pre-wrap. For autoSize=true
    // we override to `pre` (no wrap). Set per-call.
    boxSizing: 'content-box',
  });
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  _measureEl = el;
  return el;
}

export type MeasureInput = {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** When set: max-width in CSS px; text wraps to fit. Undefined = no wrap
   *  (autoSize mode), longest line drives width. */
  maxWidth?: number;
};

export type MeasureResult = {
  /** Required width (px) — at least 1 so an empty text shape still has
   *  a non-degenerate bbox. */
  w: number;
  /** Required height (px) — fontSize × lineHeight × line count, at minimum
   *  one line worth. */
  h: number;
};

/** Measure a text run as it would render in the inline editor + Shape.tsx
 *  text path. Returns the bounding box the shape should adopt. */
export function measureText(input: MeasureInput): MeasureResult {
  const el = getMeasureEl();
  el.style.fontFamily = input.fontFamily;
  el.style.fontSize = `${input.fontSize}px`;
  el.style.fontWeight = String(input.fontWeight);
  el.style.lineHeight = '1.2';
  if (input.maxWidth !== undefined && input.maxWidth > 0) {
    el.style.whiteSpace = 'pre-wrap';
    el.style.wordBreak = 'break-word';
    el.style.maxWidth = `${input.maxWidth}px`;
    el.style.width = `${input.maxWidth}px`;
  } else {
    el.style.whiteSpace = 'pre';
    el.style.wordBreak = 'normal';
    el.style.maxWidth = 'none';
    el.style.width = 'auto';
  }
  // Empty text still needs a one-line-tall box so the editor caret has a
  // visible target. A zero-width-space gives the box height without a
  // visible glyph; on commit InlineLabelEditor strips it before writing.
  el.textContent = input.text === '' ? '​' : input.text;
  const w = Math.max(1, el.offsetWidth);
  const h = Math.max(Math.ceil(input.fontSize * 1.2), el.offsetHeight);
  return { w, h };
}

/** Default font metrics for a `kind: 'text'` shape — mirrored exactly in
 *  InlineLabelEditor and Shape.tsx so the measurement, the editor, and the
 *  committed render agree. Update all three in lockstep if defaults change.
 *
 *  TEXT_DEFAULT_FONT_SIZE stays at 13 because it's the fallback fontSize
 *  for body text on rect/ellipse/diamond/note/service shapes too — a global
 *  bump would make every existing diagram's interior text resize. The text
 *  TOOL itself drops shapes with an explicit `fontSize` attached at creation
 *  time (28 for bare click, derived-from-height for drag-create) so the
 *  text-tool default is bigger without disturbing other kinds. */
export const TEXT_DEFAULT_FONT_FAMILY = 'var(--font-body)';
export const TEXT_DEFAULT_FONT_SIZE = 13;
export const TEXT_DEFAULT_FONT_WEIGHT = 500;

/** Default fontSize for a bare-click text-tool drop. Larger than the body-
 *  text default because text shapes are usually annotations / headings, not
 *  inline body copy. Drag-created text shapes derive their fontSize from
 *  the dragged box height instead. */
export const TEXT_DEFAULT_TOOL_FONT_SIZE = 28;

/** Cap on the auto-grown width of a SHRINK-WRAP (autoSize=true) text shape.
 *  Without a cap, pasting a paragraph (or just typing a long uninterrupted
 *  line) lets the bbox grow off the side of the canvas into "no man's
 *  land" — applyTextAutoFit detects this exceedance and flips the shape to
 *  WRAP mode (autoSize=false) at this width so the text wraps instead.
 *
 *  World units (CSS px at 1× zoom). 480 is wide enough that ordinary
 *  one-line annotations never trip it, narrow enough that a paragraph
 *  hits the cap before the user has scrolled. */
export const TEXT_DEFAULT_WRAP_WIDTH = 480;

/** Cap on the auto-grown height of a WRAP-mode (autoSize=false) text shape.
 *  Same motivation as the width cap — pasting a wall of text into an
 *  unconstrained box used to push the bbox off the bottom of the screen
 *  with no way to scroll back to the controls. The shape's bbox stops
 *  growing at this height; rendering switches to overflow:auto so the
 *  user can scroll inside the shape to read the rest. */
export const TEXT_MAX_HEIGHT = 800;

/** Horizontal breathing room between the bbox edge and the rendered glyphs.
 *  Without this gap, applying a stroke to a text shape paints the outline
 *  flush against the letters. Vertical pad stays at 0 because the line-
 *  height multiplier (1.2) already gives glyphs visual headroom. World
 *  units (CSS px at 1× zoom) — the renderer divides by zoom for screen-
 *  consistent visuals.
 *
 *  Honoured by:
 *    - applyTextAutoFit (bbox = text + 2×pad in shrink-wrap mode; fontSize
 *      derives from bbox MINUS 2×pad in fit/wrap modes).
 *    - Shape.tsx text rendering (foreignObject inset by pad).
 *    - InlineLabelEditor (contenteditable inset by pad). */
export const TEXT_BOX_PAD_X = 4;
