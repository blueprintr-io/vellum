/* Vellum types.
 *
 * RULE: in-memory state === serialised state.
 * No DTOs. No toJSON(). The Zustand store holds shapes that match the YAML/JSON
 * structure exactly. Save = yaml.stringify(state.diagram). Load = state.diagram = yaml.parse(file).
 *
 * Connectors store NO waypoints — paths are derived in render every frame from
 * current shape positions. Manual waypoints only when explicitly added.
 */

export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'service'
  | 'group'
  | 'container'
  | 'note'
  | 'text'
  | 'image'
  | 'freehand'
  | 'icon'
  | 'table';

/** Provenance + license metadata attached to a `kind: 'icon'` shape. We embed
 *  this on the shape (rather than looking it up from the catalog at render
 *  time) because:
 *    1. The diagram file must remain self-attributing — exporting a .vellum
 *       to someone else shouldn't depend on them having the same icon packs.
 *    2. Iconify icons may live in a collection that isn't bundled at all.
 *    3. The AttributionsPanel walks the document; it shouldn't need to resolve
 *       catalog entries to know what notices to render. */
export type IconAttribution = {
  /** 'vendor' icons are immutable trademarks (AWS, GCP, etc).
   *  'iconify' icons follow their collection's license — usually permissive. */
  source: 'vendor' | 'iconify';
  /** Stable id within the source — `aws/ec2` for vendor, `mdi:database` for iconify. */
  iconId: string;
  /** Human-readable rights holder shown in the AttributionsPanel. */
  holder: string;
  /** SPDX id ("Apache-2.0", "MIT") for iconify, or "Trademark" for vendor. */
  license: string;
  /** Where the asset originally came from — official asset page or icon-set repo. */
  sourceUrl: string;
  /** Vendor-only — link to brand guidelines so users can verify usage rules. */
  guidelinesUrl?: string;
};

/** Transform locks enforced by the canvas reducers. Vendor icons set all three;
 *  Iconify icons typically only lock aspect (most permissive licenses allow
 *  recolor + rotation). */
export type IconConstraints = {
  lockColors: boolean;
  lockAspect: boolean;
  lockRotation: boolean;
};

export type Layer = 'notes' | 'blueprint';

/** Where text sits inside (or relative to) a bounding box.
 *
 *  Two parallel families — pick a 3×3 grid cell, then pick whether it sits
 *  inside or outside the bbox:
 *   - INSIDE 3×3 grid (text tucks INTO the box):
 *       `top-left` `inside-top` `top-right`
 *       `inside-left` `center` `inside-right`
 *       `bottom-left` `inside-bottom` `bottom-right`
 *   - OUTSIDE 3×3 grid (text hangs off the box — no inside-center
 *     equivalent because that's just `center`):
 *       `outside-top-left` `above` `outside-top-right`
 *       `left` ▢ `right`
 *       `outside-bottom-left` `below` `outside-bottom-right`
 *
 *  `right-of-icon` is container-only — it sits to the right of the
 *  container's anchor icon child rather than the bbox.
 *
 *  Why two families? Body-bearing kinds (rect/ellipse/diamond/note/service)
 *  read inside-* as "align body inside" and outside-* / cardinal as "label
 *  outside, body stays centred". Without the explicit inside variants users
 *  couldn't pin body text to the top edge inside the shape — picking 'above'
 *  moved the label outside but left the body stranded in the middle.
 *
 *  Tables reuse this enum for `cellAnchor` (table-default cell alignment)
 *  AND for `TableCell.anchor` (per-cell override). Outside-* anchors don't
 *  make sense inside a cell (text can't hang outside a cell wall) so the
 *  table renderer collapses them to `center` for cells. */
export type LabelAnchor =
  | 'center'
  | 'below'
  | 'above'
  | 'left'
  | 'right'
  | 'right-of-icon'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'inside-top'
  | 'inside-bottom'
  | 'inside-left'
  | 'inside-right'
  | 'outside-top-left'
  | 'outside-top-right'
  | 'outside-bottom-left'
  | 'outside-bottom-right';

/** A single cell in a `kind: 'table'` shape.
 *
 *  Sparse-friendly: a missing cell (or a cell that is `null` / `undefined` in
 *  `cells[r]`) renders as empty. We keep this object — instead of just a
 *  string — so each cell can hold its own anchor + lightweight typography
 *  overrides without bloating Shape with one field per axis. */
export type TableCell = {
  /** Plain text content. Multi-line not currently supported (cells are
   *  single-line input boxes); a `\n` would render as a literal character. */
  text?: string;
  /** Per-cell text anchor override. Falls back to `Shape.cellAnchor`, which
   *  itself falls back to `'center'`. Outside-* anchors collapse to
   *  `'center'` at render time — see LabelAnchor's notes. */
  anchor?: LabelAnchor;
  /** Per-cell text colour. Cell renderer uses this; falls back to the
   *  table's `textColor`/`stroke`/layer-default. */
  textColor?: string;
  /** Per-cell font family override. */
  fontFamily?: string;
  /** Per-cell font size override (px in world coords). */
  fontSize?: number;
  /** Per-cell fill colour. Painted as a rect inside the cell behind the
   *  text — independent of the table's overall fill. */
  fill?: string;
};

/** Anchor on a shape:
 *  - `'auto'`  → resolved at render to the cardinal edge facing the other endpoint
 *  - `'top' | 'right' | 'bottom' | 'left'` → fixed cardinal
 *  - `[fx, fy]` → fractional [0..1, 0..1] in shape-local coords (library shapes
 *                 declare these for service-specific anchor points)
 */
export type Anchor =
  | 'auto'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | [number, number];

export type Shape = {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  sublabel?: string;
  /** 3-letter glyph for service tiles (`λ`, `RDS`, etc.) */
  icon?: string;
  layer: Layer;
  /** Legacy/optional. The fidelity UX has been removed; the field is kept
   *  optional so existing files load. New shapes don't set it. */
  fidelity?: number;
  /** Stable seed for the sketchy treatment (notes only nowadays). */
  seed?: number;
  /** For `kind === 'image'` — base64 data URL or remote src. */
  src?: string;
  /** For `kind === 'image'` — preset visual filter applied at render time.
   *  `none` (default) shows the image as-is. */
  imageFilter?: 'none' | 'grayscale' | 'sepia' | 'invert' | 'blur';
  /** For `kind === 'image'` — duotone-style tint colour. When set, the
   *  renderer composes a feColorMatrix filter that maps the image's
   *  luminance onto a gradient from black → tint, producing a coloured
   *  silhouette / wash. Stacks with `imageFilter` (the chained CSS filter
   *  runs first, then the tint matrix). Undefined / 'none' / 'transparent'
   *  → no tint, image renders unchanged. Added 2026-04-28. */
  imageTint?: string;
  /** For `kind === 'freehand'` — points relative to the shape origin (x, y).
   *  The polyline is rendered as a smooth path; w/h is the bounding box. */
  points?: { x: number; y: number }[];
  /** For `kind === 'table'` — number of rows. Defaults to 3 at creation; the
   *  field is required at render time but typed optional because Shape unions
   *  every kind. */
  rows?: number;
  /** For `kind === 'table'` — number of columns. Defaults to 3. */
  cols?: number;
  /** For `kind === 'table'` — cells addressed as `cells[row][col]`. Sparse:
   *  a missing row or cell renders as empty. Each cell carries its own text
   *  + anchor + light typography overrides — see `TableCell`. The legacy
   *  `string[][]` shape is migrated on parse so older save files load. */
  cells?: (TableCell | null)[][];
  /** For `kind === 'table'` — default text anchor for cells that don't
   *  override via `cell.anchor`. Defaults to `'center'` at render. Distinct
   *  axis from `labelAnchor` (which applies to the shape's own optional
   *  title — though tables don't currently render their `label`). */
  cellAnchor?: LabelAnchor;
  /** For `kind === 'table'` — render the first row with header treatment
   *  (bold + slight bg shade). Default false. */
  headerRow?: boolean;
  /** For `kind === 'table'` — render the first column with header treatment.
   *  Default false. */
  headerCol?: boolean;
  /** For `kind === 'table'` — relative row weights. Length should match
   *  `rows`; sparse / missing entries are treated as 1. Renderer normalises
   *  by sum so absolute units don't matter — `[2,1,1]` and `[200,100,100]`
   *  produce the same layout. Undefined = equal-weight rows. Survives
   *  shape resize because weights are fractional. */
  rowHeights?: number[];
  /** For `kind === 'table'` — relative column weights. Same shape as
   *  `rowHeights` but along the x axis. */
  colWidths?: number[];
  /** Group membership. When set, this shape belongs to the group with this id;
   *  selecting a member selects its top-level ancestor group, dragging the
   *  group drags all members. The group itself is a `kind: 'group'` shape with
   *  this field unset (or pointing at a parent group for nested groups). */
  parent?: string;
  /** For `kind === 'container'` — the id of the shape that the container's
   *  label anchors to (the original wrapped child). Stamped at creation by
   *  `makeContainer`; subsequent shapes adopted into the container are
   *  siblings, not anchors. Without this stamp, label positioning would
   *  re-pick whichever child happens to be earliest in the shape array,
   *  which shifts as adoption changes membership. */
  anchorId?: string;
  /** Stroke colour override. CSS colour string (`#1f6feb`, `transparent`,
   *  `var(--ink)`). When undefined the renderer picks based on fidelity/layer. */
  stroke?: string;
  /** Fill colour override. CSS colour string. `'none'` / `'transparent'` are both
   *  honoured for "no fill". Undefined = fidelity-driven default. */
  fill?: string;
  /** Stroke width in px. Undefined = fidelity-driven default (1.25–1.4). */
  strokeWidth?: number;
  /** Solid vs dashed vs dotted line treatment for the body outline. Same axis
   *  as Connector.style. Undefined = `'solid'`. */
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  /** Corner radius in user-space px applied to `kind: 'rect'` (and `'service'`)
   *  on the Blueprint layer. Undefined = the kind's default (4 for rect, 8 for
   *  service). The renderer clamps to `min(w, h) / 2` so dragging the slider
   *  high never produces a malformed shape — at the cap, a square reads as a
   *  pill / circle which matches user expectation. Notes-layer rects keep their
   *  baked-in chunky 10 regardless of this field, since the sticker-paper look
   *  doesn't take a clean radius parameter. */
  cornerRadius?: number;
  /** Body text — the wrapping interior text of a shape, distinct from `label`
   *  which is the anchor-positioned heading. When set, body always renders
   *  centred + word-wrapped inside the shape's bbox; `label` keeps its anchor
   *  position. For backwards compat with shapes that use `label` as the
   *  inside text, body falls back to label when undefined. */
  body?: string;
  /** Optional CSS font-family for the label. One of the curated picker
   *  presets, or any custom value. Undefined = the kind's default. */
  fontFamily?: string;
  /** Optional font-size in px applied to the label / body text. Undefined =
   *  the kind's default (18 for sketchy/notes, 13 elsewhere). Set via the
   *  inline-editor flyout while editing a label. */
  fontSize?: number;
  /** Horizontal alignment of label / body text inside the shape. Undefined =
   *  the kind's default — 'center' for `kind === 'text'` (so typed lines look
   *  balanced inside the bbox without the user having to reach for an align
   *  button) and unset (renderer-default 'center') for body-bearing kinds.
   *  Drives both the rendered text-anchor / textAlign in Shape.tsx AND the
   *  inline editor's textAlign in InlineLabelEditor, so commit doesn't visibly
   *  jump. Surfaced via the alignment toggle in FloatingTextToolbar. */
  textAlign?: 'left' | 'center' | 'right';
  /** Where the label sits relative to the shape's body. Undefined = the
   *  kind's default — `below` for icon/image, `right-of-icon` for container,
   *  `center` for everything else. The on-canvas inline editor reads this
   *  field too, so the typing position mirrors the committed position.
   *
   *  See `LabelAnchor` below for the full mapping rationale. */
  labelAnchor?: LabelAnchor;
  /** For `kind === 'container'` only — where the anchor icon child sits
   *  inside the container frame. Parallel axis to `labelAnchor` for icons
   *  (added 2026-04-28, Josh's request: "looks and works identically to the
   *  text anchor"). Honoured at container resize time and on first set:
   *  changing this in the inspector re-positions the anchor child to the
   *  matching corner / edge / centre cell. Undefined = legacy `top-left`.
   *
   *  Only the inside 9-grid subset of `LabelAnchor` is meaningful here —
   *  outside-* / cardinal positions don't apply (an icon can't sit OUTSIDE
   *  the container that owns it). The renderer + inspector clamp anything
   *  else to `top-left`. */
  iconAnchor?: LabelAnchor;
  /** For `kind === 'text'` only — three ways the bbox + fontSize relate:
   *
   *    `true` (or undefined): SHRINK-WRAP mode. Bbox follows the rendered
   *      text exactly (longest line × line count). No wrap; user types
   *      \n to break a line. fontSize is user-set or default. Created by
   *      bare-clicking the text tool.
   *
   *    `false`: WRAP mode. Width is pinned (set by edge-dragging the
   *      shape); text wraps to that width; height auto-grows with the
   *      wrapped content. fontSize is user-set or default. Created by
   *      drag-creating the text shape, or by edge-dragging an existing
   *      text shape.
   *
   *    `'fit'`: FIT mode. Both axes are user-set (the bbox is whatever
   *      the user dragged); fontSize is auto-DERIVED from the bbox to
   *      make the text fill the box while preserving text aspect ratio.
   *      "Box drives font, not the other way around." Created by
   *      corner-dragging a text shape. The bbox stays put even as the
   *      user types more text — fontSize shrinks to keep text fitting.
   *
   *  See Canvas.tsx resize handlers + applyTextAutoFit for the modes. */
  autoSize?: boolean | 'fit';
  /** Opacity 0..1. Undefined = fully opaque. Applied as the SVG `opacity`
   *  attribute on the shape's group, so it cascades to body, label, and any
   *  embedded icon together. */
  opacity?: number;
  /** Fill-only opacity 0..1. Undefined = the fill is fully opaque (modulo
   *  whatever the parent `opacity` cascades). Distinct from `opacity` —
   *  `opacity` fades the entire shape including stroke + label, whereas
   *  `fillOpacity` only attenuates the body fill so a user can wash out a
   *  rectangle's interior while keeping the outline + text crisp. Composed
   *  multiplicatively with the parent `opacity` per the SVG spec. */
  fillOpacity?: number;
  /** Unified z-order. Higher = drawn on top. Auto-assigned on creation from a
   *  monotonic counter so the most-recently-drawn item naturally sits above
   *  everything else. Send-to-front / send-to-back manipulate this. */
  z?: number;
  /** Label / text colour. Distinct from `stroke` (which is a body outline)
   *  so labelled rectangles can have one outline colour and another text
   *  colour. Undefined = the kind's default. */
  textColor?: string;
  /** For `kind === 'icon'` — raw `<svg>` markup, embedded so the diagram
   *  remains portable + offline-renderable without requiring the icon pack to
   *  be re-fetched on load. Sanitized at ingest time (stripped of <script>,
   *  external refs, event handlers). */
  iconSvg?: string;
  /** For `kind === 'icon'` — provenance + license (see `IconAttribution`).
   *  Required when kind is 'icon'; the canvas reducers and AttributionsPanel
   *  both rely on it. Optional in the type only because Shape unions all kinds. */
  iconAttribution?: IconAttribution;
  /** For `kind === 'icon'` — transform locks. Read by every transform reducer
   *  before applying ops; missing = behave like a regular shape (escape hatch
   *  for icons users have explicitly unlocked, future feature). */
  iconConstraints?: IconConstraints;
  /** Rotation in degrees, applied at render time as a transform around the
   *  shape's center. Currently only honoured for `kind: 'icon'` shapes (the
   *  rotation handle is only drawn on icons whose `iconConstraints.lockRotation`
   *  is not true), but stored on the base Shape so future shape kinds can opt
   *  in without a schema change. Undefined / 0 = no rotation. The bbox
   *  (x/y/w/h) stays AXIS-ALIGNED — rotation only spins the contents inside
   *  it. This deliberately keeps the selection halo and resize handles
   *  predictable: a rotated AWS icon still has a square selection box you can
   *  drag to resize, instead of a tilted oriented bbox that would have to
   *  re-derive aspect math at every angle. */
  rotation?: number;
  meta?: Record<string, unknown>;
};

/** Curated font picker — five Google Fonts plus the body default. */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'Default', value: 'var(--font-body)' },
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Lora', value: "'Lora', Georgia, serif" },
  { label: 'JetBrains', value: "'JetBrains Mono', ui-monospace, monospace" },
  { label: 'Patrick', value: "'Patrick Hand', cursive" },
  { label: 'Architect', value: "'Architects Daughter', cursive" },
];

/** Connector endpoint — either bound to a shape (with an anchor) OR a free
 *  floating world-space point (when the line was drawn into empty canvas). */
export type ConnectorEndpoint =
  | { shape: string; anchor: Anchor }
  | { x: number; y: number };

/** What the connector renders at each end:
 *  - `none`    = bare line (line tool default)
 *  - `arrow`   = solid filled triangle (arrow tool default)
 *  - `dot`     = small filled circle
 *  - `circle`  = small open circle
 *  - `diamond` = filled diamond (UML-ish aggregation)
 */
export type EndpointMarker = 'none' | 'arrow' | 'dot' | 'circle' | 'diamond';

export type Connector = {
  id: string;
  from: ConnectorEndpoint;
  to: ConnectorEndpoint;
  /** Layer membership — same axis as Shape.layer. A connector with no layer
   *  field (legacy diagrams) defaults to 'blueprint' at render time so old
   *  files don't accidentally render on the Notes layer. New connectors
   *  inherit the active layer at creation time, which matches user mental
   *  model: drawing arrows while in Notes mode produces Notes arrows. */
  layer?: Layer;
  /** `straight` = direct line, `orthogonal` = elbow, `curved` = soft S-curve.
   *  When `waypoints` are set, the path bends through them in order. */
  routing: 'straight' | 'curved' | 'orthogonal';
  /** Optional user-added bend points (excalidraw-style). Path is rendered
   *  from-side → ...waypoints → to-side. */
  waypoints?: { x: number; y: number }[];
  /** Endpoint markers. Defaults: `from = none`, `to = arrow` for arrow tool;
   *  both `none` for line tool. */
  fromMarker?: EndpointMarker;
  toMarker?: EndpointMarker;
  /** Endpoint marker size in user-space (canvas) pixels — independent of
   *  `strokeWidth`. Undefined = "auto", which falls back to the legacy
   *  strokeWidth-relative sizing (so old diagrams render unchanged). The
   *  inspector exposes one slider per end so the user can have e.g. a small
   *  dot on the from-side and a large arrowhead on the to-side without
   *  inflating the line itself. */
  fromMarkerSize?: number;
  toMarkerSize?: number;
  label?: string;
  /** Where along the rendered path the label sits, as a fraction in [0..1]
   *  of the polyline's arclength. Undefined defaults to 0.5 (the midpoint).
   *  Set by drag-the-label interactions; persists with the connector. */
  labelPosition?: number;
  /** Solid vs dashed vs dotted line treatment. */
  style?: 'solid' | 'dashed' | 'dotted';
  /** Stroke colour override; arrowhead fill follows. Undefined = fidelity-driven. */
  stroke?: string;
  /** Stroke width in px. Undefined = fidelity-driven default (1.25–1.4). */
  strokeWidth?: number;
  /** Opacity 0..1. Undefined = fully opaque. Applied as the SVG `opacity`
   *  attribute on the connector's group so it cascades to line + endpoints
   *  + label together. */
  opacity?: number;
  /** Unified z-order — same axis as Shape.z. */
  z?: number;
  meta?: Record<string, unknown>;
};

export type Annotation = {
  id: string;
  kind: 'comment' | 'todo';
  shape?: string;
  text: string;
  meta?: Record<string, unknown>;
};

/** This is the file shape verbatim. yaml.stringify(diagram) → .vellum. */
export type DiagramState = {
  version: '1.0';
  meta: {
    title?: string;
    defaults?: { fidelity?: number; cornerRadius?: number };
  };
  shapes: Shape[];
  connectors: Connector[];
  annotations: Annotation[];
};

export type ToolKey =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'  // container
  | '9'  // freehand pen
  | 'l'  // laser pointer (rebound from K → L 2026-04-27)
  | 't'  // table — basic grid shape, out-of-band like L/N
  | 'n'; // sticky-note (contextual — only surfaced when Notes layer is active)

export type ToolDef = {
  /** Stable internal id (e.g. 'select', 'rect', 'aws-lambda'). */
  tool: string;
  /** Display label for tooltips. */
  label: string;
  /** Built-in icon name OR a custom-glyph token. */
  icon: string;
  /** True when the slot is a user binding (rebound from the default). */
  custom?: boolean;
};

export type LayerMode = 'notes' | 'both' | 'blueprint';

export type Theme = 'dark' | 'light';

export type HotkeyBindings = Record<ToolKey, ToolDef>;
