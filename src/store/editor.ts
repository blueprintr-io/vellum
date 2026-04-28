import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type {
  Anchor,
  Connector,
  ConnectorEndpoint,
  DiagramState,
  HotkeyBindings,
  Layer,
  LayerMode,
  Shape,
  ShapeKind,
  TableCell,
  Theme,
  ToolKey,
} from './types';
import { renderPipeline } from '@/fixtures/render-pipeline';
import { isMonochromeSvg } from '@/icons/recolorable';
import {
  measureText,
  TEXT_BOX_PAD_X,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_DEFAULT_FONT_SIZE,
  TEXT_DEFAULT_FONT_WEIGHT,
  TEXT_DEFAULT_WRAP_WIDTH,
  TEXT_MAX_HEIGHT,
} from '@/editor/canvas/measure-text';
// renderPipeline is exposed through the file menu rather than booted by default.
void renderPipeline;

/** Excalidraw-style auto-fit for kind:'text' shapes.
 *
 *  Returns `s` unchanged when:
 *    - kind isn't 'text' (other shapes' bbox is user-driven, not text-driven)
 *    - we're not in a browser (SSR / test environments without DOM)
 *
 *  Otherwise re-measures the text and writes back w/h:
 *    - autoSize !== false → both axes follow content (longest line, line count)
 *    - autoSize === false → width pinned to current s.w; height auto-grows
 *      with wrapping
 *
 *  Called from every mutation path that can change a text shape's geometry
 *  or content: addShape, addShapes, updateShape, updateShapeLive,
 *  updateShapesLive, plus the resize handler in Canvas.tsx (indirectly,
 *  via the same paths). The cost is one offscreen DOM read per text shape
 *  per mutation — cheap and bounded. */
function applyTextAutoFit(s: Shape): Shape {
  if (s.kind !== 'text') return s;
  // Backward compat: legacy text shapes saved before autoSize existed
  // have user-set w/h that we mustn't overwrite. Skip autoFit when the
  // mode marker is missing.
  if (s.autoSize === undefined) return s;
  if (typeof document === 'undefined') return s;
  const fontFamily = s.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY;
  const fontSize = s.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
  const fontWeight = TEXT_DEFAULT_FONT_WEIGHT;
  // body wins over label for inside-text rendering on text shapes (matches
  // Shape.tsx's showBodyInside rule). Both empty → measure ZWSP so the
  // bbox still has a one-line height for the editor caret to sit in.
  const text = s.body ?? s.label ?? '';

  if (s.autoSize === true) {
    // Shrink-wrap: bbox = rendered text size + horizontal padding so a
    // stroke applied to the shape doesn't paint flush against the
    // glyphs. Vertical pad is 0 (line-height already gives headroom).
    const { w, h } = measureText({ text, fontFamily, fontSize, fontWeight });
    const bboxW = w + 2 * TEXT_BOX_PAD_X;
    // Width cap — without this, pasting a paragraph (or typing one long
    // line) grows the bbox off-screen into "no man's land", and the user
    // ends up with a shape they can't see the right edge of. When the
    // shrink-wrapped width hits TEXT_DEFAULT_WRAP_WIDTH, we silently flip
    // the shape to WRAP mode (autoSize:false) at the cap width and let
    // the wrap branch below re-measure for the wrapped height. The user
    // can still resize it back wider via the e/w edge handles afterward.
    if (bboxW > TEXT_DEFAULT_WRAP_WIDTH) {
      const wrap = Math.max(TEXT_DEFAULT_WRAP_WIDTH - 2 * TEXT_BOX_PAD_X, 1);
      const { h: wrappedH } = measureText({
        text,
        fontFamily,
        fontSize,
        fontWeight,
        maxWidth: wrap,
      });
      return {
        ...s,
        autoSize: false,
        w: TEXT_DEFAULT_WRAP_WIDTH,
        h: Math.min(wrappedH, TEXT_MAX_HEIGHT),
      };
    }
    // Height cap — same motivation as the width cap, just for the other
    // axis. A narrow column of newline-separated chars (or a vertical
    // paste) doesn't trip the width threshold but grows the bbox off the
    // bottom of the canvas. When measured h exceeds TEXT_MAX_HEIGHT, flip
    // to WRAP mode at the CURRENT (narrow) width — keeps the visual
    // column the user is composing — and let the wrap renderer's
    // overflow:auto give them a scrollbar inside the shape. They can
    // still resize horizontally via the e/w bars afterward.
    if (h > TEXT_MAX_HEIGHT) {
      return {
        ...s,
        autoSize: false,
        w: bboxW,
        h: TEXT_MAX_HEIGHT,
      };
    }
    return { ...s, w: bboxW, h };
  }

  if (s.autoSize === 'fit') {
    // Fit mode (legacy — new corner-drags now write autoSize:false +
    // explicit fontSize instead, see Canvas.tsx). fontSize is preserved
    // as-is; bbox height TRACKS the wrapped content. Typing a newline
    // doesn't shrink the font (which used to surprise people — adding
    // text shouldn't make the existing text smaller); deleting lines
    // shrinks the box back down. Width still drives wrap.
    const wrap = Math.max(s.w - 2 * TEXT_BOX_PAD_X, fontSize * 2);
    const { h: measured } = measureText({
      text,
      fontFamily,
      fontSize,
      fontWeight,
      maxWidth: wrap,
    });
    return { ...s, h: Math.min(measured, TEXT_MAX_HEIGHT) };
  }

  // autoSize === false → wrap mode. Width is PINNED (set by drag-create
  // or edge-resize); height TRACKS the wrapped content — adding lines
  // grows it, deleting lines shrinks it back. We deliberately don't
  // preserve a high-water "user dragged this tall once" minimum: the
  // dragged height was used at create time to pick fontSize (so a tall
  // drag = big text), and from then on the height should reflect what's
  // actually being rendered. Otherwise pasting + deleting a paragraph
  // leaves a giant empty box behind. Hard cap at TEXT_MAX_HEIGHT — past
  // that the rendered shape would disappear off the bottom of the
  // screen with no scroll affordance, so we stop growing the bbox and
  // let the renderer scroll inside it instead.
  const wrap = Math.max(s.w - 2 * TEXT_BOX_PAD_X, fontSize * 2);
  const { h: measured } = measureText({
    text,
    fontFamily,
    fontSize,
    fontWeight,
    maxWidth: wrap,
  });
  return { ...s, h: Math.min(measured, TEXT_MAX_HEIGHT) };
}

/** Manual-fontSize-on-fit-shape handler.
 *
 *  In `'fit'` mode, fontSize is normally DERIVED from the bbox by
 *  applyTextAutoFit. But the user can also manually pick a fontSize
 *  (inspector field, +/- buttons, preset dropdown). Without a hook,
 *  applyTextAutoFit re-derives fontSize from the unchanged bbox and
 *  overwrites the user's choice.
 *
 *  This helper detects "patch is JUST a fontSize change on a fit
 *  shape" and resizes the bbox to match the new fontSize. Then
 *  applyTextAutoFit converges with scale=1 (bbox already fits text at
 *  fontSize=v) and the user's pick survives. */
function applyManualFontSizeOnFit(
  merged: Shape,
  patch: Partial<Shape>,
): Shape {
  if (
    merged.kind !== 'text' ||
    merged.autoSize !== 'fit' ||
    patch.fontSize === undefined ||
    patch.w !== undefined ||
    patch.h !== undefined
  ) {
    return merged;
  }
  if (typeof document === 'undefined') return merged;
  const text = merged.body ?? merged.label ?? '';
  const ref = measureText({
    text,
    fontFamily: merged.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY,
    fontSize: merged.fontSize ?? TEXT_DEFAULT_FONT_SIZE,
    fontWeight: TEXT_DEFAULT_FONT_WEIGHT,
  });
  return { ...merged, w: ref.w + 2 * TEXT_BOX_PAD_X, h: ref.h };
}

/** Default hotkey bindings — fixed mapping. The user can no longer rebind
 *  these slots (the rebind affordance was removed once the slot count grew
 *  to cover everything we surface in the toolbar). */
export const DEFAULT_BINDINGS: HotkeyBindings = {
  '1': { tool: 'select', label: 'Select', icon: 'cursor' },
  '2': { tool: 'rect', label: 'Rectangle', icon: 'rect' },
  '3': { tool: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
  '4': { tool: 'diamond', label: 'Diamond', icon: 'diamond' },
  '5': { tool: 'arrow', label: 'Arrow', icon: 'arrow' },
  '6': { tool: 'line', label: 'Line', icon: 'line' },
  '7': { tool: 'text', label: 'Text', icon: 'text' },
  // 8 = container frame, 9 = freehand pen.
  '8': { tool: 'container', label: 'Container', icon: 'container' },
  '9': { tool: 'pen', label: 'Freehand pen', icon: 'pen' },
  // L = laser pointer (was K). The 'k' slot retained for back-compat —
  // useKeybindings still routes it to the laser tool, but the chrome
  // surfaces the L key instead.
  'l': { tool: 'laser', label: 'Laser pointer', icon: 'laser' },
  // T = basic table. Lives outside the fixed 1–9 row alongside L (laser) —
  // tables are a niche-but-handy shape kind that didn't earn a digit slot.
  't': { tool: 'table', label: 'Table', icon: 'table' },
  // 'n' surfaces only on the Notes layer — see FloatingToolbar's conditional
  // render. The tool itself is the existing 'note' (sticky-note) shape.
  'n': { tool: 'note', label: 'Sticky note', icon: 'note' },
};

/** Maximum number of undo states retained. Past 100, drops the oldest. */
const HISTORY_LIMIT = 100;

/** Discriminated key for the contextual tip-toast (TipToast.tsx). The set is
 *  closed: TipToast.tsx owns the user-facing copy + the ⌘/Ctrl substitution,
 *  and the canvas just publishes whichever key matches the gesture in flight.
 *
 *  When you add a tip:
 *    1. Add a TipKey here.
 *    2. Add the body string to TIP_BODIES in TipToast.tsx (use {{ctrl}} for
 *       the modifier-key placeholder — TipToast renders ⌘ on Mac, Ctrl
 *       elsewhere).
 *    3. Publish the key from wherever the gesture lives — usually
 *       `setActiveTipKey(...)` from Canvas.tsx's setInteraction. */
export type TipKey =
  | 'shift-perfect-square'
  | 'shift-perfect-circle'
  | 'shift-perfect-diamond'
  | 'shift-disable-snap'
  | 'cmd-disable-snap'
  | 'ctrl-align'
  | 'ctrl-snap-rotate'
  | 'right-click-delete-bend'
  | 'dblclick-group-select';

/** Internal clipboard payload — independent of the OS clipboard. Shapes cloned
 *  with new ids on paste, plus any connectors whose endpoints both land in the
 *  pasted set. */
type ClipboardPayload = {
  shapes: Shape[];
  connectors: Connector[];
};

export type EditorState = {
  // file
  diagram: DiagramState;
  filePath: string | null;
  dirty: boolean;
  /** Wall-clock time of the last successful save (`Date.now()`); null if never
   *  saved this session. Drives the brand pill's "autosaved Ns ago" copy. */
  lastSavedAt: number | null;

  // viewport
  zoom: number;
  pan: { x: number; y: number };

  // selection
  selectedIds: string[];
  /** A group the user has "entered" via double-click. While set, hit-testing
   *  inside this group resolves to the group's members instead of the group
   *  itself — mirrors Figma / Keynote "enter group" behaviour. Cleared by
   *  Escape, by clicking outside the group's subtree, by ungroup/delete of
   *  the group, and by file open / undo. */
  focusedGroupId: string | null;

  // tooling
  activeTool: ToolKey;
  toolLock: boolean;
  hotkeyBindings: HotkeyBindings;

  // view
  layerMode: LayerMode;
  theme: Theme;

  // overlays
  morePopoverOpen: boolean;
  cmdkOpen: boolean;
  saveDialogOpen: boolean;
  /** Persistent left-side library card. Toggled from the Brand expand button.
   *  Independent of `morePopoverOpen` (which is the floating quick-pick) so the
   *  user can have both surfaces open if they want — different muscle memory.
   *  Hosts inline vendor + Iconify search when the user types a query. */
  libraryPanelOpen: boolean;
  /** TRADEMARK-COMPLIANCE: hamburger → "Legal" dialog state. The library
   *  picker also opens it via "Report an issue" / "About" links, so it
   *  needs to be store-scoped, not local to the menu. */
  legalDialogOpen: boolean;
  legalDialogTab: 'ip-complaints' | 'credits' | 'terms';
  /** TRADEMARK-COMPLIANCE: Tier 2 import-library dialog state. Stubbed —
   *  the actual import pipeline is a future iteration. */
  importDialogOpen: boolean;
  /** Right-side inspector visibility when nothing is selected. The inspector
   *  always renders for an active selection; this flag lets the user pin it
   *  open with an empty selection so they can pre-configure the default
   *  styles (`lastStyles` / `lastConnectorStyle`) before drawing. */
  inspectorOpen: boolean;

  // history (kept on the same store so all atomic mutations route through it)
  past: DiagramState[];
  future: DiagramState[];

  // clipboard (in-memory, session only — OS clipboard is a v2 concern)
  clipboard: ClipboardPayload | null;

  // —— actions ——

  // tool / overlay
  setActiveTool: (k: ToolKey) => void;
  toggleLock: () => void;
  setLayerMode: (m: LayerMode) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  toggleMorePopover: () => void;
  setMorePopoverOpen: (open: boolean) => void;
  toggleCmdk: () => void;
  setCmdkOpen: (open: boolean) => void;
  setSaveDialogOpen: (open: boolean) => void;
  toggleLibraryPanel: () => void;
  setLibraryPanelOpen: (open: boolean) => void;
  /** TRADEMARK-COMPLIANCE — open Legal dialog on a specific tab. */
  openLegalDialog: (tab?: 'ip-complaints' | 'credits' | 'terms') => void;
  closeLegalDialog: () => void;
  /** TRADEMARK-COMPLIANCE — open/close Tier 2 import-library dialog. */
  setImportDialogOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  /** Currently-editing shape id (the one whose label/body the inline editor
   *  is showing). Lives on the store rather than as InlineLabelEditor's
   *  local state so Shape.tsx can read it and suppress its own label/body
   *  during edit — the inline editor renders transparently over the shape,
   *  so leaving the underlying text painted produced a ghosted-double of
   *  the typing position. */
  editingShapeId: string | null;
  setEditingShapeId: (id: string | null) => void;
  /** Connector currently being label-edited inline. Mirrors editingShapeId
   *  but for connectors — Connector.tsx reads it to suppress the rendered
   *  label while ConnectorLabelEditor overlays its contenteditable. Mutually
   *  exclusive with editingShapeId / editingCell. */
  editingConnectorId: string | null;
  setEditingConnectorId: (id: string | null) => void;
  /** Cell-edit pointer for table shapes. When set, InlineCellEditor opens
   *  a contenteditable over `cells[row][col]` of the named shape. Distinct
   *  from `editingShapeId` because cell-editing has its own navigation
   *  semantics (Tab/Enter walk the grid) and the renderer needs to suppress
   *  exactly one cell, not the whole shape. */
  editingCell: { shapeId: string; row: number; col: number } | null;
  setEditingCell: (loc: { shapeId: string; row: number; col: number } | null) => void;
  /** Cell-select pointer — set on a single click of a cell within an
   *  already-selected table. The inspector reads it to surface per-cell
   *  options without forcing the user to enter edit mode. Cleared when
   *  the table is no longer selected. */
  selectedCell: { shapeId: string; row: number; col: number } | null;
  setSelectedCell: (loc: { shapeId: string; row: number; col: number } | null) => void;
  /** Atomic per-cell mutations — each snapshots history once. */
  setCellText: (shapeId: string, row: number, col: number, text: string) => void;
  setCellPatch: (shapeId: string, row: number, col: number, patch: Partial<TableCell>) => void;
  /** Insert a row at `index` (0..rows). Cells are shifted down; new row is
   *  blank. Snapshots history. */
  insertTableRow: (shapeId: string, index: number) => void;
  /** Insert a column at `index` (0..cols). Cells are shifted right; new
   *  column is blank. */
  insertTableCol: (shapeId: string, index: number) => void;
  /** Delete the row at `index`. No-op if rows would drop below 1. */
  deleteTableRow: (shapeId: string, index: number) => void;
  /** Delete the column at `index`. No-op if cols would drop below 1. */
  deleteTableCol: (shapeId: string, index: number) => void;
  closeAllOverlays: () => void;

  // selection
  setSelected: (ids: string[] | string | null) => void;
  toggleSelected: (id: string) => void;
  addToSelection: (ids: string[]) => void;
  /** Enter / exit a focused group. Pass `null` to exit. The caller is
   *  responsible for selection — this action only flips the focus pointer. */
  setFocusedGroup: (id: string | null) => void;

  // viewport
  setZoom: (v: number) => void;
  zoomBy: (factor: number, around?: { x: number; y: number }) => void;
  setPan: (p: { x: number; y: number }) => void;
  panBy: (dx: number, dy: number) => void;
  fitToContent: (viewportWidth: number, viewportHeight: number) => void;
  resetView: () => void;

  // diagram mutation (each calls _snapshot() first; live drags skip history
  //                  by calling the *Live variants and committing once on up)
  addShape: (sh: Shape) => void;
  addShapes: (shs: Shape[]) => void;
  addConnector: (c: Connector) => void;
  updateShape: (id: string, patch: Partial<Shape>) => void;
  updateShapeLive: (id: string, patch: Partial<Shape>) => void;
  updateShapesLive: (patches: { id: string; patch: Partial<Shape> }[]) => void;
  /** Like updateShapeLive but BYPASSES the text-shape autoFit. Used during
   *  a corner-resize drag on kind:'text' so the bbox tracks the cursor
   *  exactly (Excalidraw-style) instead of snapping to the measured text
   *  size on every frame. The resize commit (pointer-up) calls
   *  updateShape with the final patch, which DOES re-fit and snaps the
   *  bbox to the rendered text. */
  updateShapeLiveRaw: (id: string, patch: Partial<Shape>) => void;
  /** Apply a style/content patch to every currently-selected shape AND
   *  connector, with cross-type translation. The inspector previously only
   *  acted on `selectedIds[0]` — picking 5 shapes and changing fill only
   *  changed the first. This routes the full selection.
   *
   *  Cross-type translation rules (so "user intent" survives mixed selection):
   *    - For a recolorable monochrome icon shape, `fill` and `stroke` both
   *      map to the icon's tint (which lives in `shape.stroke`). Changing
   *      "fill to red" with an icon + a rectangle selected paints the icon
   *      red AND fills the rectangle red.
   *    - For an icon that isn't recolorable (vendor or multi-colour iconify),
   *      colour patches are dropped — the asset's licence forbids tinting,
   *      and silently noop'ing is right.
   *    - For images, only `opacity` + `imageFilter` apply.
   *    - For connectors, `stroke`, `strokeWidth`, `opacity` apply directly;
   *      `strokeStyle` (the shape field) maps to connector `style`. Other
   *      fields are dropped — connectors don't have fill or fonts.
   *
   *  Snapshots once for the whole batch so undo restores everything in a
   *  single step. Mirrors lastStyles + lastConnectorStyle so the next-drawn
   *  shape inherits the choice. */
  updateSelection: (patch: Partial<Shape> & Partial<Connector>) => void;
  updateConnector: (id: string, patch: Partial<Connector>) => void;
  /** Mutate a connector without snapshotting — for waypoint dragging. The
   *  caller commits a single history step at gesture end via `commitHistory`. */
  updateConnectorLive: (id: string, patch: Partial<Connector>) => void;
  setShapeLayer: (id: string, layer: Layer) => void;
  /** Move every selected shape to `layer`. Multi-select friendly — the
   *  per-shape `setShapeLayer` only operates on the one id passed in, which
   *  surprises users when the inspector pretends to act on the whole
   *  selection. This action snapshots once and mutates the lot. */
  setSelectionLayer: (layer: Layer) => void;
  promoteSelection: () => void;
  deleteSelection: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  flipSelection: (axis: 'horizontal' | 'vertical') => void;
  /** Translate the current selection by `(dx, dy)` in world units. Mirrors the
   *  drag flow: expands selected groups/containers to their descendants, moves
   *  every shape's `x`/`y`, and carries connector waypoints + free-floating
   *  endpoints by the same delta (bound endpoints follow shapes naturally).
   *
   *  When `mode === 'estimate'`, `dx`/`dy` are interpreted as a *direction*
   *  (sign matters, magnitude doesn't) and the actual translation distance is
   *  derived from the gap to the nearest neighbour shape in that direction —
   *  or the median gap between non-selected shapes when there's no neighbour
   *  to dock onto. Lets Cmd+Arrow reflow a card into evenly-spaced rows.
   *
   *  Snapshots once per call, so each keypress is a single undo step. Holding
   *  the arrow key down emits autorepeat events; users will undo a sustained
   *  nudge one tap at a time. Acceptable trade-off — collapsing repeats into
   *  one history entry across an unbounded time window is a separate feature. */
  nudgeSelection: (
    dx: number,
    dy: number,
    mode?: 'fixed' | 'estimate',
  ) => void;
  /** Wrap the current multi-selection in a `group` shape that bounds them all,
   *  then select the group. No-op for single-selections. */
  groupSelection: () => void;
  /** If a group is selected, ungroup it (remove the group, keep its children). */
  ungroupSelection: () => void;

  // history seam — public so live-drag handlers can commit a single history
  // step at the end of a gesture
  commitHistory: () => void;
  /** Discard any in-flight live mutations *without* committing — currently the
   *  same as commitHistory(); wired separately so cancel paths stay obvious. */
  cancelHistory: () => void;
  undo: () => void;
  redo: () => void;

  // clipboard
  copySelection: () => void;
  cutSelection: () => void;
  /** Paste from internal clipboard. If `at` is provided (world coords), the
   *  pasted bundle is centred there instead of offset from the originals. */
  paste: (at?: { x: number; y: number }) => void;
  duplicateSelection: () => void;

  // file
  setFilePath: (path: string | null) => void;
  setDirty: (d: boolean) => void;
  markSaved: () => void;
  loadDiagram: (d: DiagramState, path: string | null) => void;
  newDiagram: () => void;
  setTitle: (t: string) => void;

  // tool bindings (Checkpoint D — drop on 1–9)
  bindHotkey: (key: ToolKey, def: HotkeyBindings[ToolKey]) => void;
  resetBindings: () => void;

  // canvas appearance (persisted with theme)
  canvasPaper?: string;     // CSS colour override for the canvas paper
  showDots: boolean;
  showGrid: boolean;        // major gridlines instead of dots
  setCanvasPaper: (c: string | undefined) => void;
  setShowDots: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;

  // contextual tip-toast (TipToast.tsx). `tipsEnabled` is the user-facing
  // master switch (CanvasCustomize ▸ Tips); persisted so the choice survives
  // reloads. `activeTipKey` is the *currently-displayed* tip — session-only,
  // pushed by gesture handlers (Canvas.tsx) and cleared on idle.
  tipsEnabled: boolean;
  setTipsEnabled: (v: boolean) => void;
  activeTipKey: TipKey | null;
  setActiveTipKey: (k: TipKey | null) => void;

  /** Hover-edge connector creation (added 2026-04-28). When enabled, hovering
   *  a shape in select mode renders 4 dot affordances on its cardinal edges;
   *  dragging from a dot starts a connector to the cursor's drop target.
   *  Persisted per-workspace alongside the other UI prefs so the choice
   *  survives reloads. Defaults to `true` — the affordance is only visible
   *  on hover (no chrome cost when not hovering) and matches draw.io's muscle
   *  memory; users who prefer Excalidraw-style "draw a line, snap to shape"
   *  can disable it from the canvas customise panel. */
  hoverEdgeConnectors: boolean;
  setHoverEdgeConnectors: (v: boolean) => void;

  // pen tool settings (session-scoped)
  penColor: string;
  penWidth: number;
  setPenColor: (c: string) => void;
  setPenWidth: (w: number) => void;

  // last-used style defaults — captured automatically whenever the user edits
  // a style on any shape (stroke, fill, font, line width, text colour). Newly
  // created shapes inherit these so the user doesn't have to re-pick the same
  // styles repeatedly. Persisted across sessions.
  lastStyles: LastStyles;
  setLastStyles: (patch: Partial<LastStyles>) => void;

  // Same idea, parallel slot for connectors. Mirrored from updateConnector
  // whenever the user touches stroke / strokeWidth / dash style; the canvas's
  // connector-creation path reads this so the next arrow or line they draw
  // inherits whatever they last picked. Routing + endpoint markers stay
  // tool-driven (arrow vs line) — those carry semantic meaning, where stroke
  // colour / width / dash are pure appearance.
  lastConnectorStyle: LastConnectorStyle;
  setLastConnectorStyle: (patch: Partial<LastConnectorStyle>) => void;

  // container actions — wrap a selected non-basic shape in a container frame
  // so the user can group related items below/around it.
  makeContainer: (id: string) => void;
  /** Auto-adopt a freshly-dropped shape into the topmost container its centre
   *  lands inside. No-op if the shape is already a child or no container is
   *  under the centre. */
  adoptIntoContainer: (id: string) => void;

  // personal shape library (persisted per-workspace via localStorage)
  personalLibrary: PersonalLibraryEntry[];
  addToLibrary: (label: string, ids: string[]) => void;
  removeFromLibrary: (index: number) => void;

  // Recent-tab feed — the user-activity log surfaced in MoreShapesPopover and
  // LibraryPanel. Populated whenever a library shape, vendor icon, or iconify
  // icon is dropped onto the canvas. Persisted so the list survives reloads —
  // "recent" is meaningless if it resets every session.
  recentShapes: RecentEntry[];
  recordRecent: (entry: RecentEntry) => void;
  clearRecent: () => void;
};

/** Persisted slice — hotkey bindings, theme, and the user's personal shape
 *  library. Per the handoff, these live per-workspace; localStorage is the v1
 *  home, server-side once Blueprintr account-sync lands.
 *
 *  We also persist the *current* diagram + filePath. Refresh used to wipe the
 *  canvas; users assumed autosave was a thing (it's a basic browser-app
 *  expectation). The FSA file-handle isn't stored here — those aren't
 *  structured-cloneable; getActiveHandle() in persist.ts owns it for the
 *  session and the user re-opens via File ▸ Open after a hard refresh. */
type PersistedSlice = Pick<
  EditorState,
  | 'hotkeyBindings'
  | 'theme'
  | 'personalLibrary'
  | 'canvasPaper'
  | 'showDots'
  | 'showGrid'
  | 'libraryPanelOpen'
  | 'lastStyles'
  | 'lastConnectorStyle'
  | 'recentShapes'
  | 'diagram'
  | 'filePath'
  | 'inspectorOpen'
  | 'tipsEnabled'
  | 'hoverEdgeConnectors'
>;

/** A user-saved shape (or group) ready to drop back onto a future canvas. */
export type PersonalLibraryEntry = {
  /** Display label in the library popover. */
  label: string;
  /** Glyph shown on the tile (3-char fallback if user doesn't pick one). */
  glyph: string;
  /** A self-contained bundle: shapes + connectors. Coordinates are normalised
   *  so the bundle's bbox sits at (0,0) — drop-in adds the cursor offset. */
  shapes: Shape[];
  connectors: Connector[];
};

/** The "last touched" style values. defaultShapeFromTool reads these so newly
 *  drawn shapes inherit whatever the user most recently chose. Each field is
 *  optional — undefined just means "no override, use the kind's default." */
export type LastStyles = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  /** Corner radius (rects only at render time). Persisted across sessions
   *  alongside the other sticky styles, AND surfaced in the Defaults flyout
   *  as the global default that newly-drawn rectangles inherit. */
  cornerRadius?: number;
};

/** Connector equivalent of LastStyles — the appearance bits the user picks in
 *  ConnectorInspector. Routing / markers are intentionally NOT here: those
 *  carry semantic intent (arrow vs line, elbow vs straight) tied to the tool
 *  they came from. Mirroring them would have a "wait why is my arrow tool
 *  drawing dotted-curve lines now" surprise factor. */
export type LastConnectorStyle = {
  stroke?: string;
  strokeWidth?: number;
  style?: 'solid' | 'dashed' | 'dotted';
  /** Per-end marker size carries forward like strokeWidth so the next arrow
   *  the user draws after sizing one inherits the choice. Asymmetric on
   *  purpose — the user might want big arrowheads on the to-end without
   *  inflating the from-end markers. */
  fromMarkerSize?: number;
  toMarkerSize?: number;
};

/** Connector style fields we mirror onto `lastConnectorStyle` after every
 *  updateConnector — same pattern as STYLE_FIELDS for shapes. */
const CONNECTOR_STYLE_FIELDS: readonly (keyof LastConnectorStyle)[] = [
  'stroke',
  'strokeWidth',
  'style',
  'fromMarkerSize',
  'toMarkerSize',
];

function extractLastConnectorStyle(
  patch: Partial<Connector>,
): Partial<LastConnectorStyle> | null {
  let out: Partial<LastConnectorStyle> | null = null;
  for (const k of CONNECTOR_STYLE_FIELDS) {
    if (k in patch) {
      if (!out) out = {};
      (out as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  return out;
}

/** Recent-tab entries — items the user has actually placed on the canvas.
 *  Discriminated by `source` so the panel knows which dataTransfer MIME to
 *  emit when the user drags one back to canvas:
 *    - 'library' → application/x-vellum-library (existing service-tile path)
 *    - 'vendor'  → application/x-vellum-icon, vendor payload
 *    - 'iconify' → application/x-vellum-icon, iconify payload
 *  We dedup by `key`, prepend on each new use, and cap at RECENT_LIMIT. */
export type RecentEntry = {
  /** Stable dedup key. */
  key: string;
  label: string;
  /** 3-char glyph used as the tile fallback when no preview SVG is available. */
  glyph: string;
  source:
    | { kind: 'library'; libShapeId: string; libName: string }
    | { kind: 'vendor'; iconId: string; vendor: string }
    | { kind: 'iconify'; iconId: string; prefix: string };
};

const RECENT_LIMIT = 24;

/** Style fields we mirror onto `lastStyles` when an updateShape patch touches
 *  them. Centralised so the store and the UI share one definition. */
const STYLE_FIELDS: readonly (keyof LastStyles)[] = [
  'fill',
  'stroke',
  'strokeWidth',
  'fontFamily',
  'fontSize',
  'textColor',
  'cornerRadius',
];

/** Local helper — flag a colour value as a "real" choice the user could
 *  reasonably want to splash onto an icon's tint. We treat undefined / 'none'
 *  / 'transparent' as semantically "no override" rather than colour intent.
 *  Used by the cross-type fill→tint mapping in updateSelection. */
function _isMeaningfulColor(v: string | undefined): v is string {
  if (v == null) return false;
  const t = v.toLowerCase();
  return t !== 'transparent' && t !== 'none';
}

/** Mirror the inspector's "show .tint row?" gate — monochrome AND not
 *  vendor-locked. Multi-colour SVGs are skipped because writing stroke
 *  onto them would no-op visually (the wrapper colour can't reach the
 *  painted pixels) — silently letting the user think they tinted a
 *  multi-colour brand asset is the wrong UX. */
function _isIconRecolorable(sh: Shape): boolean {
  if (sh.kind !== 'icon') return false;
  if (sh.iconConstraints?.lockColors === true) return false;
  return isMonochromeSvg(sh.iconSvg);
}

/** Translate a Shape patch into the patch that should actually be applied
 *  to a specific shape, given that shape's kind. The shape inspector emits
 *  patches in "rectangle vocabulary" (fill / stroke / fontSize / …); icons
 *  and images need different fields, and we'd rather the user's intent
 *  ("paint everything red") survive mixed selection than have them open
 *  three inspectors in series. */
function _translateShapePatch(
  sh: Shape,
  patch: Partial<Shape>,
): Partial<Shape> {
  if (sh.kind === 'icon') {
    if (!_isIconRecolorable(sh)) {
      // Vendor / locked icon — only opacity is honoured. Trademark holders
      // explicitly forbid recolour; silently dropping fill/stroke is the
      // right move.
      const out: Partial<Shape> = {};
      if ('opacity' in patch) out.opacity = patch.opacity;
      return out;
    }
    const out: Partial<Shape> = {};
    // Fill OR stroke maps to the icon's tint (which lives in shape.stroke
    // for icons). Stroke "wins" if both are set in the same patch — same
    // ordering as the inspector's .tint row, which writes to stroke.
    if ('stroke' in patch && _isMeaningfulColor(patch.stroke)) {
      out.stroke = patch.stroke;
    } else if ('fill' in patch && _isMeaningfulColor(patch.fill)) {
      out.stroke = patch.fill;
    } else if ('stroke' in patch && patch.stroke === undefined) {
      // Reset-to-default click in the .tint row should reset the icon's
      // tint too (don't leak the previous override).
      out.stroke = undefined;
    }
    if ('opacity' in patch) out.opacity = patch.opacity;
    return out;
  }
  if (sh.kind === 'image') {
    const out: Partial<Shape> = {};
    if ('opacity' in patch) out.opacity = patch.opacity;
    if ('imageFilter' in patch) out.imageFilter = patch.imageFilter;
    if ('imageTint' in patch) out.imageTint = patch.imageTint;
    // Roundiness rides on `cornerRadius` — images can be rounded just like
    // rects, and using the same field keeps the renderer's clip math
    // consistent. Without forwarding here, "set radius on a multi-selection"
    // (image + rect together) would skip the image silently.
    if ('cornerRadius' in patch) out.cornerRadius = patch.cornerRadius;
    return out;
  }
  // Everything else uses the patch as-is.
  return patch;
}

/** Translate a shape-vocabulary style patch into the matching connector
 *  patch. Connector field names diverge in one place (`strokeStyle` →
 *  `style`); fill / fontFamily / fontSize / textColor have no connector
 *  equivalent and get dropped.
 *
 *  Connector-only fields (`fromMarker`, `toMarker`, `fromMarkerSize`,
 *  `toMarkerSize`) ride on the same patch object — the connector inspector
 *  passes them so a marker change with multiple connectors selected applies
 *  to the lot (the original "only the first connector got the new arrowhead"
 *  bug came from per-connector calls instead of routing through here). They
 *  pass straight through; pure-shape patches never set them so this is a
 *  no-op for shape-only callers. */
function _shapePatchToConnectorPatch(
  patch: Partial<Shape> & Partial<Connector>,
): Partial<Connector> {
  const out: Partial<Connector> = {};
  if ('stroke' in patch) out.stroke = patch.stroke;
  if ('strokeWidth' in patch) out.strokeWidth = patch.strokeWidth;
  if ('opacity' in patch) out.opacity = patch.opacity;
  if ('strokeStyle' in patch) out.style = patch.strokeStyle;
  // Connector-only fields below — only present when the caller is the
  // connector inspector. _translateShapePatch ignores them on the shape side.
  if ('fromMarker' in patch) out.fromMarker = patch.fromMarker;
  if ('toMarker' in patch) out.toMarker = patch.toMarker;
  if ('fromMarkerSize' in patch) out.fromMarkerSize = patch.fromMarkerSize;
  if ('toMarkerSize' in patch) out.toMarkerSize = patch.toMarkerSize;
  if ('routing' in patch) out.routing = patch.routing;
  if ('layer' in patch) out.layer = patch.layer;
  return out;
}

/** Pull the style fields from a shape patch. Returns null if the patch doesn't
 *  touch any style — saves a setState call on geometry-only edits. */
function extractLastStyles(patch: Partial<Shape>): Partial<LastStyles> | null {
  let out: Partial<LastStyles> | null = null;
  for (const k of STYLE_FIELDS) {
    if (k in patch) {
      if (!out) out = {};
      // Cast: each STYLE_FIELDS key is a Shape key, and the corresponding
      // value type matches LastStyles[k] (optional + same primitive).
      (out as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  return out;
}

/** Estimate a nudge distance for Cmd+Arrow.
 *
 *  Two-tier strategy, in priority order:
 *
 *    1. Dock to neighbour. If there's a shape on the side the user is moving
 *       toward, return the *gap* (axis-aligned distance, edge to edge) so the
 *       selection lands flush against it. This matches the user's intuition
 *       of "snap me to the next thing".
 *
 *    2. Match existing rhythm. Otherwise, return the median gap between
 *       neighbouring non-selected shapes along the same axis — useful when
 *       the user is laying out a new card next to a row of evenly-spaced
 *       siblings and there's no shape on the receiving side yet.
 *
 *  Returns `null` when no estimate is available; the caller falls back to the
 *  raw dx/dy. Magnitude only — sign is applied by the caller.
 *
 *  `sx`/`sy` are direction signs (`-1`/`0`/`+1`); exactly one is non-zero in
 *  practice (arrow-key driven). `ref` is the selection bbox. */
function _estimateNudgeDistance(
  ref: { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number },
  others: readonly Shape[],
  sx: number,
  sy: number,
): number | null {
  const horizontal = sx !== 0;
  const axisRange = horizontal
    ? { lo: ref.minY, hi: ref.maxY }
    : { lo: ref.minX, hi: ref.maxX };

  // Tier 1: dock to nearest neighbour in the direction of travel whose
  // perpendicular projection overlaps the selection bbox. Without the overlap
  // gate, "right arrow" would dock onto a shape that's high above the
  // selection, which doesn't match what the user sees when they look at the
  // diagram.
  let bestGap = Infinity;
  for (const o of others) {
    const oLo = horizontal ? o.y : o.x;
    const oHi = horizontal ? o.y + o.h : o.x + o.w;
    if (oHi < axisRange.lo || oLo > axisRange.hi) continue;
    let gap: number | null = null;
    if (sx > 0) gap = o.x - ref.maxX;
    else if (sx < 0) gap = ref.minX - (o.x + o.w);
    else if (sy > 0) gap = o.y - ref.maxY;
    else if (sy < 0) gap = ref.minY - (o.y + o.h);
    if (gap == null || gap <= 0) continue;
    if (gap < bestGap) bestGap = gap;
  }
  if (isFinite(bestGap)) return bestGap;

  // Tier 2: median pairwise gap across non-selected shapes along the active
  // axis. Sort by leading edge and walk the list — captures the rhythm of an
  // existing column/row even when nothing sits in the user's path.
  if (others.length < 2) return null;
  const sorted = [...others].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const gap = horizontal
      ? b.x - (a.x + a.w)
      : b.y - (a.y + a.h);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/** Empty diagram skeleton — file format-shaped, no DTOs. */
const EMPTY_DIAGRAM: DiagramState = {
  version: '1.0',
  meta: { title: 'untitled', defaults: { fidelity: 1 } },
  shapes: [],
  connectors: [],
  annotations: [],
};

/** Approximate world coords for a connector endpoint. Floating endpoints
 *  pass through; bound endpoints resolve their anchor against the shape.
 *  Used by the clipboard path so a connector copied without its endpoint
 *  shapes can be stored as a fully-detached free-floating line.
 *
 *  `'auto'` collapses to the shape's centre — we don't have the opposite
 *  endpoint in this purely-clipboard context, and a centre point is a
 *  reasonable starting position for the user to drag from after paste. */
function endpointToFloating(
  ep: ConnectorEndpoint,
  shapes: readonly Shape[],
): { x: number; y: number } | null {
  if (!('shape' in ep)) return { x: ep.x, y: ep.y };
  const sh = shapes.find((s) => s.id === ep.shape);
  if (!sh) return null;
  const w = Math.abs(sh.w);
  const h = Math.abs(sh.h);
  const a: Anchor = ep.anchor;
  if (Array.isArray(a)) {
    return { x: sh.x + a[0] * w, y: sh.y + a[1] * h };
  }
  switch (a) {
    case 'top':
      return { x: sh.x + w / 2, y: sh.y };
    case 'bottom':
      return { x: sh.x + w / 2, y: sh.y + h };
    case 'left':
      return { x: sh.x, y: sh.y + h / 2 };
    case 'right':
      return { x: sh.x + w, y: sh.y + h / 2 };
    case 'auto':
    default:
      return { x: sh.x + w / 2, y: sh.y + h / 2 };
  }
}

/** Walk a connector's endpoints and rewrite any bound-to-unselected-shape
 *  endpoint as a floating world coord. Used at copy/duplicate time so a
 *  user who selected just a connector (not its endpoint shapes) gets a
 *  free-floating duplicate they can position, instead of one bound to
 *  the original shapes that paste invisibly on top of the source line.
 *
 *  Exported so Canvas's OS-clipboard `buildEnvelope` can apply the same
 *  rule — both routes (internal `copySelection` and the native `copy`
 *  event) MUST agree on what comes across, otherwise the OS-clipboard
 *  branch silently overwrites the internal clipboard on paste with a
 *  payload missing the user's lone-connector selection. */
export function detachUnselectedEndpoints(
  c: Connector,
  selectedShapeIds: ReadonlySet<string>,
  shapes: readonly Shape[],
): Connector {
  const fix = (ep: ConnectorEndpoint): ConnectorEndpoint => {
    if (!('shape' in ep)) return ep;
    if (selectedShapeIds.has(ep.shape)) return ep;
    const f = endpointToFloating(ep, shapes);
    return f ?? ep;
  };
  return { ...c, from: fix(c.from), to: fix(c.to) };
}

/** Compute the next z value: 1 + the current max across shapes+connectors.
 *  Used so freshly-added items always render on top, without having to walk
 *  the whole array on every read. */
function nextZ(s: EditorState): number {
  let max = 0;
  for (const sh of s.diagram.shapes) {
    if (typeof sh.z === 'number' && sh.z > max) max = sh.z;
  }
  for (const c of s.diagram.connectors) {
    if (typeof c.z === 'number' && c.z > max) max = c.z;
  }
  return max + 1;
}

/** Z-order helper used by bringForward/sendBackward/bringToFront/sendToBack.
 *  Expands any selected groups to include their descendants, then assigns new
 *  z values so the selection sits above (or below) every other item. Both
 *  shapes AND connectors share the same axis. */
function _zOrderMove(
  get: () => EditorState,
  snapshot: () => void,
  mutate: (next: Partial<DiagramState>) => void,
  edge: 'front' | 'back',
) {
  const sel = new Set(get().selectedIds);
  if (sel.size === 0) return;
  const shapes = get().diagram.shapes;
  const connectors = get().diagram.connectors;
  // Expand groups to include children.
  const expanded = new Set<string>(sel);
  for (const id of sel) {
    const sh = shapes.find((s) => s.id === id);
    if (sh?.kind === 'group') {
      for (const m of shapes) {
        if (m.parent === id) expanded.add(m.id);
      }
    }
  }
  let minZ = Infinity;
  let maxZ = 0;
  for (const sh of shapes) {
    if (typeof sh.z === 'number') {
      minZ = Math.min(minZ, sh.z);
      maxZ = Math.max(maxZ, sh.z);
    }
  }
  for (const c of connectors) {
    if (typeof c.z === 'number') {
      minZ = Math.min(minZ, c.z);
      maxZ = Math.max(maxZ, c.z);
    }
  }
  if (!isFinite(minZ)) minZ = 0;

  let counter = edge === 'front' ? maxZ + 1 : minZ - 1;
  const step = edge === 'front' ? 1 : -1;
  snapshot();
  mutate({
    shapes: shapes.map((sh) => {
      if (!expanded.has(sh.id)) return sh;
      const z = counter;
      counter += step;
      return { ...sh, z };
    }),
    connectors: connectors.map((c) => {
      if (!expanded.has(c.id)) return c;
      const z = counter;
      counter += step;
      return { ...c, z };
    }),
  });
}

/** Pull a stable ish-unique id. Crypto.randomUUID is fine in modern browsers;
 *  fall back to a counter for SSR / older envs. The collision risk for a v1
 *  in-memory editor is effectively zero with either. */
let _idCounter = 0;
export function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${(++_idCounter).toString(36)}`;
}

export const useEditor = create<EditorState>()(
  persist(
    (set, get) => {
      // internal helpers

      /** Capture the current diagram and push it to `past`, clearing `future`.
       *  Call this BEFORE mutating diagram to make the operation undoable. */
      const _snapshot = () => {
        const cur = get().diagram;
        const past = get().past;
        const next = past.length >= HISTORY_LIMIT ? past.slice(1) : past.slice();
        next.push(cur);
        set({ past: next, future: [] });
      };

      /** Re-calculate the bounding box of groups based on their children.
       *  Ensures the group frame expands dynamically if a member is dragged outside. */
      const _recalculateGroupBounds = (shapes: Shape[]): Shape[] => {
        let changed = false;
        const nextShapes = shapes.slice();
        
        const groups = nextShapes.filter((s) => s.kind === 'group');
        if (groups.length === 0) return shapes;
        
        const getDepth = (id: string): number => {
          const s = nextShapes.find((x) => x.id === id);
          if (!s || !s.parent) return 0;
          return 1 + getDepth(s.parent);
        };
        
        // Process deepest groups first just in case
        groups.sort((a, b) => getDepth(b.id) - getDepth(a.id));
        
        for (const group of groups) {
          const members = nextShapes.filter(
            (s) => s.parent === group.id && s.kind !== 'group'
          );
          if (members.length === 0) continue;
          
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const m of members) {
            minX = Math.min(minX, m.x);
            minY = Math.min(minY, m.y);
            maxX = Math.max(maxX, m.x + m.w);
            maxY = Math.max(maxY, m.y + m.h);
          }
          
          if (minX === Infinity) continue;
          
          const pad = 12;
          const nx = minX - pad;
          const ny = minY - pad;
          const nw = maxX - minX + pad * 2;
          const nh = maxY - minY + pad * 2;
          
          if (group.x !== nx || group.y !== ny || group.w !== nw || group.h !== nh) {
            const idx = nextShapes.findIndex((s) => s.id === group.id);
            if (idx !== -1) {
              nextShapes[idx] = { ...group, x: nx, y: ny, w: nw, h: nh };
              changed = true;
            }
          }
        }
        
        return changed ? nextShapes : shapes;
      };

      /** Live-mutate without snapshotting — for pointermove drag updates. The
       *  caller commits a single history step at gesture end via commitHistory. */
      const _mutate = (next: Partial<DiagramState>) => {
        let finalShapes = next.shapes;
        if (finalShapes) {
          finalShapes = _recalculateGroupBounds(finalShapes);
        }
        set((s) => ({
          diagram: {
            ...s.diagram,
            ...next,
            ...(finalShapes ? { shapes: finalShapes } : {}),
          },
          dirty: true,
        }));
      };

      /** Merge `patch` into table cell `[row][col]`. Allocates rows/cells
       *  lazily so sparse tables stay sparse on disk. If the merged cell ends
       *  up empty (no text + no overrides) we drop the cell to null so an
       *  edit-then-clear cycle doesn't leave behind stub objects. */
      const _writeCell = (
        sh: Shape,
        row: number,
        col: number,
        patch: Partial<TableCell>,
      ): Shape['cells'] => {
        if (sh.kind !== 'table') return sh.cells;
        const rows = Math.max(1, Math.floor(sh.rows ?? 3));
        const cols = Math.max(1, Math.floor(sh.cols ?? 3));
        if (row < 0 || row >= rows || col < 0 || col >= cols) return sh.cells;
        const next = (sh.cells ?? []).slice() as (TableCell | null)[][];
        while (next.length <= row) next.push([]);
        const r = (next[row] ?? []).slice();
        while (r.length <= col) r.push(null);
        const cur = r[col] ?? {};
        const merged: TableCell = { ...cur, ...patch };
        // Drop empty/blank cells back to null so sparse storage stays sparse.
        const isEmpty =
          (merged.text === undefined || merged.text === '') &&
          merged.anchor === undefined &&
          merged.textColor === undefined &&
          merged.fontFamily === undefined &&
          merged.fontSize === undefined &&
          merged.fill === undefined;
        r[col] = isEmpty ? null : merged;
        next[row] = r;
        return next;
      };

      return {
        // Boot blank — the demo fixture (`renderPipeline`) is available via
        // the file menu so users can load it on demand without it ambushing
        // their first impression.
        diagram: { ...EMPTY_DIAGRAM, shapes: [], connectors: [], annotations: [] },
        filePath: null,
        dirty: false,
        lastSavedAt: null,

        zoom: 1,
        pan: { x: 0, y: 0 },

        selectedIds: [],
        focusedGroupId: null,

        activeTool: '1',
        toolLock: false,
        hotkeyBindings: DEFAULT_BINDINGS,

        layerMode: 'both',
        theme: 'dark',

        canvasPaper: undefined,
        showDots: true,
        showGrid: false,

        // Tips on by default — once the user knows the keystroke, they flip
        // it off in Customise canvas. activeTipKey is session-scoped so the
        // toast doesn't ghost-render on reload.
        tipsEnabled: true,
        activeTipKey: null,
        // Default ON — discoverable on hover, no chrome cost when not.
        hoverEdgeConnectors: true,

        penColor: 'var(--ink)',
        penWidth: 3,

        lastStyles: {},
        lastConnectorStyle: {},

        morePopoverOpen: false,
        cmdkOpen: false,
        saveDialogOpen: false,
        libraryPanelOpen: false,
        legalDialogOpen: false,
        legalDialogTab: 'ip-complaints',
        importDialogOpen: false,
        inspectorOpen: false,
        editingShapeId: null,
        editingConnectorId: null,
        editingCell: null,
        selectedCell: null,

        past: [],
        future: [],
        clipboard: null,

        // tool / overlay
        setActiveTool: (k) => set({ activeTool: k, morePopoverOpen: false }),
        toggleLock: () => set((s) => ({ toolLock: !s.toolLock })),
        setLayerMode: (m) => set({ layerMode: m }),
        setTheme: (t) => set({ theme: t }),
        toggleTheme: () =>
          set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
        toggleMorePopover: () =>
          set((s) => ({ morePopoverOpen: !s.morePopoverOpen, cmdkOpen: false })),
        setMorePopoverOpen: (open) => set({ morePopoverOpen: open }),
        toggleCmdk: () =>
          set((s) => ({ cmdkOpen: !s.cmdkOpen, morePopoverOpen: false })),
        setCmdkOpen: (open) => set({ cmdkOpen: open }),
        setSaveDialogOpen: (open) => set({ saveDialogOpen: open }),
        toggleLibraryPanel: () =>
          set((s) => ({ libraryPanelOpen: !s.libraryPanelOpen })),
        setLibraryPanelOpen: (open) => set({ libraryPanelOpen: open }),
        openLegalDialog: (tab = 'ip-complaints') =>
          set({ legalDialogOpen: true, legalDialogTab: tab }),
        closeLegalDialog: () => set({ legalDialogOpen: false }),
        setImportDialogOpen: (open) => set({ importDialogOpen: open }),
        toggleInspector: () =>
          set((s) => ({ inspectorOpen: !s.inspectorOpen })),
        setInspectorOpen: (open) => set({ inspectorOpen: open }),
        setEditingShapeId: (id) =>
          // Mutually exclusive with cell-edit and connector-edit — opening
          // one closes the others so a stray contenteditable from a previous
          // gesture can't linger over the new edit target.
          set({
            editingShapeId: id,
            editingCell: id ? null : get().editingCell,
            editingConnectorId: id ? null : get().editingConnectorId,
          }),
        setEditingConnectorId: (id) =>
          set({
            editingConnectorId: id,
            editingShapeId: id ? null : get().editingShapeId,
            editingCell: id ? null : get().editingCell,
          }),
        setEditingCell: (loc) =>
          set({
            editingCell: loc,
            editingShapeId: loc ? null : get().editingShapeId,
            // Entering cell-edit on a different cell promotes that cell to
            // the selected cell too, so the CELL inspector section stays
            // visible after the user commits and exits.
            selectedCell: loc ?? get().selectedCell,
          }),
        setSelectedCell: (loc) => set({ selectedCell: loc }),
        setCellText: (shapeId, row, col, text) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === shapeId
                ? { ...sh, cells: _writeCell(sh, row, col, { text: text || undefined }) }
                : sh,
            ),
          });
        },
        setCellPatch: (shapeId, row, col, patch) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === shapeId
                ? { ...sh, cells: _writeCell(sh, row, col, patch) }
                : sh,
            ),
          });
        },
        insertTableRow: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              const at = Math.max(0, Math.min(rows, index));
              const cells = sh.cells ?? [];
              const next = [...cells];
              // Pad sparse rows to `at` so insertion lands at the right index.
              while (next.length < at) next.push([]);
              next.splice(at, 0, []);
              // If the user had custom row weights, splice in an entry for
              // the new row at the same index. Pick the average of existing
              // weights so the new row reads as "a normal-sized row" instead
              // of getting shrunk by all the heavy ones around it. If
              // rowHeights is absent, leave it absent — the renderer treats
              // missing as all-equal and the user's "I never resized" intent
              // is preserved.
              let newHeights: number[] | undefined = undefined;
              if (sh.rowHeights && sh.rowHeights.length > 0) {
                const avg =
                  sh.rowHeights.reduce((a, b) => a + b, 0) /
                  sh.rowHeights.length;
                newHeights = [...sh.rowHeights];
                newHeights.splice(at, 0, avg);
              }
              return {
                ...sh,
                rows: rows + 1,
                cells: next,
                // Grow the bbox proportionally so cell sizes stay constant.
                h: sh.h * ((rows + 1) / rows),
                cols,
                rowHeights: newHeights,
              };
            }),
          });
        },
        insertTableCol: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              const at = Math.max(0, Math.min(cols, index));
              const cells = sh.cells ?? [];
              const next = cells.map((row) => {
                const r = row ? [...row] : [];
                while (r.length < at) r.push(null);
                r.splice(at, 0, null);
                return r;
              });
              let newWidths: number[] | undefined = undefined;
              if (sh.colWidths && sh.colWidths.length > 0) {
                const avg =
                  sh.colWidths.reduce((a, b) => a + b, 0) /
                  sh.colWidths.length;
                newWidths = [...sh.colWidths];
                newWidths.splice(at, 0, avg);
              }
              return {
                ...sh,
                cols: cols + 1,
                cells: next,
                w: sh.w * ((cols + 1) / cols),
                rows,
                colWidths: newWidths,
              };
            }),
          });
        },
        deleteTableRow: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              if (rows <= 1) return sh;
              const at = Math.max(0, Math.min(rows - 1, index));
              const cells = sh.cells ?? [];
              const next = [...cells];
              if (next.length > at) next.splice(at, 1);
              let newHeights: number[] | undefined = undefined;
              if (sh.rowHeights && sh.rowHeights.length > 0) {
                newHeights = [...sh.rowHeights];
                if (newHeights.length > at) newHeights.splice(at, 1);
              }
              return {
                ...sh,
                rows: rows - 1,
                cells: next,
                h: sh.h * ((rows - 1) / rows),
                rowHeights: newHeights,
              };
            }),
          });
        },
        deleteTableCol: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              if (cols <= 1) return sh;
              const at = Math.max(0, Math.min(cols - 1, index));
              const cells = sh.cells ?? [];
              const next = cells.map((row) => {
                if (!row) return row;
                if (row.length <= at) return row;
                const r = [...row];
                r.splice(at, 1);
                return r;
              });
              let newWidths: number[] | undefined = undefined;
              if (sh.colWidths && sh.colWidths.length > 0) {
                newWidths = [...sh.colWidths];
                if (newWidths.length > at) newWidths.splice(at, 1);
              }
              return {
                ...sh,
                cols: cols - 1,
                cells: next,
                w: sh.w * ((cols - 1) / cols),
                colWidths: newWidths,
              };
            }),
          });
        },
        closeAllOverlays: () =>
          set({
            morePopoverOpen: false,
            cmdkOpen: false,
            saveDialogOpen: false,
            legalDialogOpen: false,
            importDialogOpen: false,
            editingCell: null,
            // Esc through closeAllOverlays also exits "focused group" mode.
            // Pairs with the explicit setSelected(null) the keybinding does.
            focusedGroupId: null,
          }),

        // selection
        setSelected: (ids) =>
          set((s) => {
            const next = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
            // Drop selectedCell when its host table is no longer selected.
            // The cell inspector section keys on selectedCell.shapeId being
            // in selectedIds; without this clear, picking another shape
            // would leave a dangling cell pointer.
            const sc = s.selectedCell;
            const keepCell = sc ? next.includes(sc.shapeId) : true;
            return {
              selectedIds: next,
              selectedCell: keepCell ? sc : null,
              editingCell: keepCell ? s.editingCell : null,
            };
          }),
        toggleSelected: (id) =>
          set((s) => ({
            selectedIds: s.selectedIds.includes(id)
              ? s.selectedIds.filter((x) => x !== id)
              : [...s.selectedIds, id],
          })),
        addToSelection: (ids) =>
          set((s) => {
            const set_ = new Set(s.selectedIds);
            ids.forEach((i) => set_.add(i));
            return { selectedIds: Array.from(set_) };
          }),
        setFocusedGroup: (id) =>
          set((s) => {
            // Defensive guard: refuse to focus an id that doesn't resolve to a
            // group shape. A stale id (e.g. one that survived a delete) would
            // freeze the editor in a "focus" mode that has nothing to focus.
            if (id != null) {
              const sh = s.diagram.shapes.find((x) => x.id === id);
              if (!sh || sh.kind !== 'group') return { focusedGroupId: null };
            }
            return { focusedGroupId: id };
          }),

        // viewport
        setZoom: (v) => set({ zoom: Math.max(0.1, Math.min(8, v)) }),
        zoomBy: (factor, around) =>
          set((s) => {
            const next = Math.max(0.1, Math.min(8, s.zoom * factor));
            const ratio = next / s.zoom;
            if (!around) return { zoom: next };
            // Anchor zoom around a screen point: world point under the cursor
            // stays put. New pan = around - (around - pan) * ratio.
            return {
              zoom: next,
              pan: {
                x: around.x - (around.x - s.pan.x) * ratio,
                y: around.y - (around.y - s.pan.y) * ratio,
              },
            };
          }),
        setPan: (p) => set({ pan: p }),
        panBy: (dx, dy) =>
          set((s) => ({ pan: { x: s.pan.x + dx, y: s.pan.y + dy } })),
        fitToContent: (vw, vh) => {
          const { shapes } = get().diagram;
          if (shapes.length === 0) {
            set({ zoom: 1, pan: { x: 0, y: 0 } });
            return;
          }
          let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
          for (const sh of shapes) {
            minX = Math.min(minX, sh.x);
            minY = Math.min(minY, sh.y);
            maxX = Math.max(maxX, sh.x + sh.w);
            maxY = Math.max(maxY, sh.y + sh.h);
          }
          const w = maxX - minX;
          const h = maxY - minY;
          const pad = 80;
          const zx = (vw - pad * 2) / w;
          const zy = (vh - pad * 2) / h;
          const z = Math.max(0.1, Math.min(4, Math.min(zx, zy)));
          set({
            zoom: z,
            pan: {
              x: vw / 2 - (minX + w / 2) * z,
              y: vh / 2 - (minY + h / 2) * z,
            },
          });
        },
        resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),

        // diagram mutation
        addShape: (sh) => {
          _snapshot();
          set((s) => {
            const z = nextZ(s);
            return {
              diagram: {
                ...s.diagram,
                shapes: [
                  ...s.diagram.shapes,
                  applyTextAutoFit({ ...sh, z: sh.z ?? z }),
                ],
              },
              dirty: true,
              selectedIds: [sh.id],
            };
          });
        },
        addShapes: (shs) => {
          _snapshot();
          set((s) => {
            let z = nextZ(s);
            const stamped = shs.map((sh) =>
              applyTextAutoFit({ ...sh, z: sh.z ?? z++ }),
            );
            return {
              diagram: {
                ...s.diagram,
                shapes: [...s.diagram.shapes, ...stamped],
              },
              dirty: true,
              selectedIds: shs.map((sh) => sh.id),
            };
          });
        },
        addConnector: (c) => {
          _snapshot();
          set((s) => {
            const z = nextZ(s);
            return {
              diagram: {
                ...s.diagram,
                connectors: [...s.diagram.connectors, { ...c, z: c.z ?? z }],
              },
              dirty: true,
              selectedIds: [c.id],
            };
          });
        },

        updateShape: (id, patch) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id
                ? applyTextAutoFit(
                    applyManualFontSizeOnFit({ ...sh, ...patch }, patch),
                  )
                : sh,
            ),
          });
          // Mirror style fields onto lastStyles so the next freshly-created
          // shape inherits whatever the user just chose. Geometry-only edits
          // skip the setState (extractLastStyles returns null).
          const sticky = extractLastStyles(patch);
          if (sticky) {
            set((s) => ({ lastStyles: { ...s.lastStyles, ...sticky } }));
          }
        },
        updateShapeLive: (id, patch) => {
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id
                ? applyTextAutoFit(
                    applyManualFontSizeOnFit({ ...sh, ...patch }, patch),
                  )
                : sh,
            ),
          });
        },
        updateShapeLiveRaw: (id, patch) => {
          // Same as updateShapeLive minus the autoFit. Required by the
          // text-shape corner-resize handler so the cursor visibly
          // controls the bbox during the drag; commit re-runs autoFit.
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id ? { ...sh, ...patch } : sh,
            ),
          });
        },
        updateShapesLive: (patches) => {
          const map = new Map(patches.map((p) => [p.id, p.patch]));
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              const p = map.get(sh.id);
              if (!p) return sh;
              return applyTextAutoFit(
                applyManualFontSizeOnFit({ ...sh, ...p }, p),
              );
            }),
          });
        },
        updateSelection: (patch) => {
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          // Single-shape inspector edit on a single-shape selection is the
          // overwhelmingly common case — fall through to updateShape so we
          // don't disturb its existing semantics (snapshot, lastStyles
          // mirroring, identical history shape). Cross-type translation
          // only matters when the selection spans kinds, so the single
          // case can shortcut.
          if (sel.size === 1) {
            const onlyId = sel.values().next().value as string;
            const allShapes = get().diagram.shapes;
            const allConns = get().diagram.connectors;
            const onlyShape = allShapes.find((sh) => sh.id === onlyId);
            if (onlyShape) {
              get().updateShape(onlyId, patch);
              return;
            }
            const onlyConn = allConns.find((c) => c.id === onlyId);
            if (onlyConn) {
              const cp = _shapePatchToConnectorPatch(patch);
              if (Object.keys(cp).length > 0) get().updateConnector(onlyId, cp);
              return;
            }
            return;
          }
          _snapshot();
          // Build per-shape patches with cross-type translation.
          const shapes = get().diagram.shapes;
          const conns = get().diagram.connectors;
          const nextShapes = shapes.map((sh) => {
            if (!sel.has(sh.id)) return sh;
            const sp = _translateShapePatch(sh, patch);
            return Object.keys(sp).length === 0 ? sh : { ...sh, ...sp };
          });
          const cp = _shapePatchToConnectorPatch(patch);
          const nextConns =
            Object.keys(cp).length === 0
              ? conns
              : conns.map((c) =>
                  sel.has(c.id) ? { ...c, ...cp } : c,
                );
          _mutate({ shapes: nextShapes, connectors: nextConns });
          // Mirror onto lastStyles / lastConnectorStyle so next-drawn shapes
          // inherit the choice the user just made — same contract as the
          // single-shape updateShape / updateConnector paths.
          const sticky = extractLastStyles(patch);
          if (sticky) {
            set((s) => ({ lastStyles: { ...s.lastStyles, ...sticky } }));
          }
          const stickyConn = extractLastConnectorStyle(cp);
          if (stickyConn) {
            set((s) => ({
              lastConnectorStyle: { ...s.lastConnectorStyle, ...stickyConn },
            }));
          }
        },
        updateConnector: (id, patch) => {
          _snapshot();
          _mutate({
            connectors: get().diagram.connectors.map((c) =>
              c.id === id ? { ...c, ...patch } : c,
            ),
          });
          // Mirror appearance fields onto lastConnectorStyle so the next
          // arrow/line the user draws inherits them. Geometry-only patches
          // (waypoint drag, endpoint reanchor) skip the setState — same
          // shortcut as updateShape's lastStyles mirroring.
          const sticky = extractLastConnectorStyle(patch);
          if (sticky) {
            set((s) => ({
              lastConnectorStyle: { ...s.lastConnectorStyle, ...sticky },
            }));
          }
        },
        updateConnectorLive: (id, patch) => {
          _mutate({
            connectors: get().diagram.connectors.map((c) =>
              c.id === id ? { ...c, ...patch } : c,
            ),
          });
        },
        setShapeLayer: (id, layer) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id ? { ...sh, layer } : sh,
            ),
          });
        },
        setSelectionLayer: (layer) => {
          // Multi-select layer toggle. Snapshot once for the whole batch so
          // undo restores all shapes in one step. We also pull along children
          // of selected groups/containers — flipping a group's layer without
          // its members would split the visual treatment.
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          const all = get().diagram.shapes;
          const allConns = get().diagram.connectors;
          // Expand groups + containers to their descendants (recursive).
          const expanded = new Set<string>(sel);
          let added = true;
          while (added) {
            added = false;
            for (const sh of all) {
              if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
                expanded.add(sh.id);
                added = true;
              }
            }
          }
          _snapshot();
          _mutate({
            shapes: all.map((sh) =>
              expanded.has(sh.id) ? { ...sh, layer } : sh,
            ),
            // Pull along directly-selected connectors AND any connector whose
            // endpoints both land on shapes that just moved layer — keeps
            // related geometry on a single layer without orphaning lines.
            connectors: allConns.map((c) => {
              if (sel.has(c.id)) return { ...c, layer };
              const f = 'shape' in c.from ? c.from.shape : null;
              const t = 'shape' in c.to ? c.to.shape : null;
              if (f && t && expanded.has(f) && expanded.has(t)) {
                return { ...c, layer };
              }
              return c;
            }),
          });
        },
        promoteSelection: () => {
          // ⇧⌘P — Notes-layer shapes in selection move to Blueprint. Geometry
          // untouched. (Fidelity bookkeeping was removed when the fidelity
          // axis was retired.)
          const ids = new Set(get().selectedIds);
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (!ids.has(sh.id)) return sh;
              if (sh.layer !== 'notes') return sh;
              return { ...sh, layer: 'blueprint' as Layer };
            }),
          });
        },
        deleteSelection: () => {
          const ids = new Set(get().selectedIds);
          if (ids.size === 0) return;
          // Expand groups and containers to include their (recursive)
          // descendants. Deleting a group used to leave the children behind
          // — visually nothing changed because the group frame was invisible,
          // and the user thought delete had silently failed. Treat
          // delete-on-frame as "delete the frame and everything in it"; if
          // the user wants to keep the children, Cmd+Shift+G ungroups first.
          const all = get().diagram.shapes;
          const expanded = new Set<string>(ids);
          let added = true;
          while (added) {
            added = false;
            for (const sh of all) {
              if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
                expanded.add(sh.id);
                added = true;
              }
            }
          }
          _snapshot();
          _mutate({
            shapes: all.filter((sh) => !expanded.has(sh.id)),
            // Kill connectors whose endpoints reference removed shapes OR
            // that are themselves in the original selection. Keeps the
            // diagram referentially consistent.
            connectors: get().diagram.connectors.filter((c) => {
              if (ids.has(c.id)) return false;
              const fromShape = 'shape' in c.from ? c.from.shape : null;
              const toShape = 'shape' in c.to ? c.to.shape : null;
              if (fromShape && expanded.has(fromShape)) return false;
              if (toShape && expanded.has(toShape)) return false;
              return true;
            }),
          });
          // If the focused group was just deleted (directly or because its
          // ancestor frame was), drop the focus pointer.
          const fg = get().focusedGroupId;
          set({
            selectedIds: [],
            focusedGroupId: fg && expanded.has(fg) ? null : fg,
          });
        },
        bringForward: () => {
          // Z-order is array order. Move selected shapes (and their group
          // descendants) to the end (rendered last == on top).
          _zOrderMove(get, _snapshot, _mutate, 'front');
        },
        sendBackward: () => {
          _zOrderMove(get, _snapshot, _mutate, 'back');
        },
        bringToFront: () => {
          _zOrderMove(get, _snapshot, _mutate, 'front');
        },
        sendToBack: () => {
          _zOrderMove(get, _snapshot, _mutate, 'back');
        },
        flipSelection: (axis) => {
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          // Compute combined bbox so we mirror around the centre of the
          // selection (not each shape's own centre).
          const shapes = get().diagram.shapes;
          const targets = shapes.filter((s) => sel.has(s.id));
          if (targets.length === 0) return;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const s of targets) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x + s.w);
            maxY = Math.max(maxY, s.y + s.h);
          }
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          _snapshot();
          _mutate({
            shapes: shapes.map((s) => {
              if (!sel.has(s.id)) return s;
              if (axis === 'horizontal') {
                return { ...s, x: 2 * cx - (s.x + s.w) };
              }
              return { ...s, y: 2 * cy - (s.y + s.h) };
            }),
          });
        },
        nudgeSelection: (dx, dy, mode = 'fixed') => {
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          const allShapes = get().diagram.shapes;
          const allConns = get().diagram.connectors;

          // Expand groups + containers to descendants — same rule the drag
          // flow uses. Without this, nudging a group would move the frame
          // out from under its children.
          const moveShapes = new Set<string>();
          for (const id of sel) {
            const sh = allShapes.find((s) => s.id === id);
            if (sh) moveShapes.add(id);
          }
          let added = true;
          while (added) {
            added = false;
            for (const sh of allShapes) {
              if (
                sh.parent &&
                moveShapes.has(sh.parent) &&
                !moveShapes.has(sh.id)
              ) {
                const parent = allShapes.find((p) => p.id === sh.parent);
                if (parent?.kind === 'group' || parent?.kind === 'container') {
                  moveShapes.add(sh.id);
                  added = true;
                }
              }
            }
          }
          if (moveShapes.size === 0) return;

          // Selection bbox — needed for both estimate-mode distance picking
          // and to identify which connectors are "in" the selection for
          // waypoint translation.
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const id of moveShapes) {
            const sh = allShapes.find((s) => s.id === id);
            if (!sh) continue;
            minX = Math.min(minX, sh.x);
            minY = Math.min(minY, sh.y);
            maxX = Math.max(maxX, sh.x + sh.w);
            maxY = Math.max(maxY, sh.y + sh.h);
          }
          if (!isFinite(minX)) return;

          let stepX = dx;
          let stepY = dy;
          if (mode === 'estimate') {
            // Direction-only — pick the dominant axis the user pressed.
            const sx = Math.sign(dx);
            const sy = Math.sign(dy);
            const horizontal = sx !== 0 && sy === 0;
            const vertical = sy !== 0 && sx === 0;
            const ref = {
              minX, minY, maxX, maxY,
              cx: (minX + maxX) / 2,
              cy: (minY + maxY) / 2,
            };
            // Candidates: every shape NOT being moved, and that isn't a
            // group/container (those are layout frames — measuring to their
            // edges produces results that don't match what the user sees).
            const others = allShapes.filter(
              (s) =>
                !moveShapes.has(s.id) &&
                s.kind !== 'group' &&
                s.kind !== 'container',
            );
            const dist = _estimateNudgeDistance(ref, others, sx, sy);
            if (dist != null && dist > 0) {
              if (horizontal) stepX = sx * dist;
              else if (vertical) stepY = sy * dist;
              else {
                // Diagonal — apply along whichever axis has a hit and let the
                // other axis fall back to the literal sign. (Arrow keys are
                // never diagonal in the keymap, but defend the entry point.)
                if (sx !== 0) stepX = sx * dist;
                if (sy !== 0) stepY = sy * dist;
              }
            }
            // Otherwise (no reference geometry) fall through to the literal
            // dx/dy — better to nudge by the raw delta than freeze.
          }

          if (stepX === 0 && stepY === 0) return;

          _snapshot();
          const nextShapes = allShapes.map((sh) =>
            moveShapes.has(sh.id)
              ? { ...sh, x: sh.x + stepX, y: sh.y + stepY }
              : sh,
          );
          // Connectors: ride-along when both endpoints are bound to moved
          // shapes (already follow their shapes, so nothing to patch on the
          // line itself BUT waypoints are world-space and would lag behind
          // unless we translate them). Directly-selected connectors with
          // floating endpoints get those endpoints translated too.
          const nextConns = allConns.map((c) => {
            const fromShape = 'shape' in c.from ? c.from.shape : null;
            const toShape = 'shape' in c.to ? c.to.shape : null;
            const directlySelected = sel.has(c.id);
            const rideAlong =
              fromShape != null &&
              toShape != null &&
              moveShapes.has(fromShape) &&
              moveShapes.has(toShape);
            if (!directlySelected && !rideAlong) return c;
            const patch: Partial<Connector> = {};
            if (directlySelected) {
              if (!('shape' in c.from)) {
                patch.from = { x: c.from.x + stepX, y: c.from.y + stepY };
              }
              if (!('shape' in c.to)) {
                patch.to = { x: c.to.x + stepX, y: c.to.y + stepY };
              }
            }
            if ((rideAlong || directlySelected) && c.waypoints?.length) {
              patch.waypoints = c.waypoints.map((w) => ({
                x: w.x + stepX,
                y: w.y + stepY,
              }));
            }
            return Object.keys(patch).length === 0 ? c : { ...c, ...patch };
          });
          _mutate({ shapes: nextShapes, connectors: nextConns });
        },
        groupSelection: () => {
          const ids = new Set(get().selectedIds);
          const members = get().diagram.shapes.filter(
            (s) => ids.has(s.id) && s.kind !== 'group',
          );
          if (members.length < 2) return;
          // Compute the group's bounding box with a little padding.
          const pad = 12;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const s of members) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x + s.w);
            maxY = Math.max(maxY, s.y + s.h);
          }
          const groupId = newId('group');
          const group: Shape = {
            id: groupId,
            kind: 'group',
            x: minX - pad,
            y: minY - pad,
            w: maxX - minX + pad * 2,
            h: maxY - minY + pad * 2,
            label: '',
            layer: 'blueprint',
          };
          _snapshot();
          // Insert the group BEFORE its members so it renders behind them.
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: [
                group,
                ...s.diagram.shapes.map((sh) =>
                  ids.has(sh.id) ? { ...sh, parent: groupId } : sh,
                ),
              ],
            },
            dirty: true,
            selectedIds: [groupId],
          }));
        },
        ungroupSelection: () => {
          const sel = new Set(get().selectedIds);
          // Treat containers as ungroupable too — same operation: drop the
          // frame, free the children. Means Cmd+Shift+G is a one-stroke
          // "remove container" alongside "ungroup".
          const groups = get().diagram.shapes.filter(
            (s) =>
              sel.has(s.id) && (s.kind === 'group' || s.kind === 'container'),
          );
          if (groups.length === 0) return;
          const groupIds = new Set(groups.map((g) => g.id));
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: s.diagram.shapes
                // Drop the group shapes themselves.
                .filter((sh) => !groupIds.has(sh.id))
                // Strip parent on any shape pointing at one of the killed
                // groups.
                .map((sh) =>
                  sh.parent && groupIds.has(sh.parent)
                    ? { ...sh, parent: undefined }
                    : sh,
                ),
            },
            dirty: true,
            selectedIds: get().diagram.shapes
              .filter((sh) => sh.parent && groupIds.has(sh.parent))
              .map((sh) => sh.id),
            // If the group the user was "inside" just got dissolved, exit
            // focus mode. Without this clear, focusedGroupId would point at
            // a shape that no longer exists and shapeUnder's focus-aware
            // branches would silently treat all clicks as "unrelated to the
            // missing group" (which is fine) but the visual focus halo
            // would also vanish into nothing — confusing state.
            focusedGroupId: groupIds.has(s.focusedGroupId ?? '')
              ? null
              : s.focusedGroupId,
          }));
        },

        // history seams
        commitHistory: () => _snapshot(),
        cancelHistory: () => _snapshot(),
        undo: () => {
          const past = get().past;
          if (past.length === 0) return;
          const prev = past[past.length - 1];
          set((s) => ({
            past: past.slice(0, -1),
            future: [s.diagram, ...s.future],
            diagram: prev,
            dirty: true,
            selectedIds: [],
            // History travel can dissolve the focused group out from under
            // the user; clear focus to avoid pointing at a vanished id.
            focusedGroupId: null,
          }));
        },
        redo: () => {
          const future = get().future;
          if (future.length === 0) return;
          const nxt = future[0];
          set((s) => ({
            future: future.slice(1),
            past: [...s.past, s.diagram],
            diagram: nxt,
            dirty: true,
            selectedIds: [],
            focusedGroupId: null,
          }));
        },

        // clipboard
        copySelection: () => {
          const ids = new Set(get().selectedIds);
          if (ids.size === 0) return;
          const all = get().diagram.shapes;
          const allConns = get().diagram.connectors;
          // Expand selected groups / containers to include their descendants —
          // otherwise copy/paste of a group would copy just the empty frame
          // and lose the children. Walk the tree so nested groups also bring
          // along their children.
          const expanded = new Set<string>(ids);
          let added = true;
          while (added) {
            added = false;
            for (const sh of all) {
              if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
                expanded.add(sh.id);
                added = true;
              }
            }
          }
          const shapes = all.filter((s) => expanded.has(s.id));
          // Connectors come in via two routes:
          //   (a) ride-along: BOTH endpoints in the expanded shape selection.
          //       The endpoints stay bound and are remapped at paste time.
          //   (b) directly selected: the user picked the line/arrow itself.
          //       Any endpoint that isn't bound to an in-selection shape is
          //       resolved to its current world position and stored as
          //       floating, so the pasted copy lands somewhere visible
          //       instead of overlapping the original.
          const connectors = allConns
            .filter((c) => {
              const f = 'shape' in c.from ? c.from.shape : null;
              const t = 'shape' in c.to ? c.to.shape : null;
              const rideAlong =
                f != null && t != null && expanded.has(f) && expanded.has(t);
              return rideAlong || ids.has(c.id);
            })
            .map((c) => detachUnselectedEndpoints(c, expanded, all));
          // Bail only if NEITHER shapes nor connectors made it across — a
          // lone-connector selection is a valid copy.
          if (shapes.length === 0 && connectors.length === 0) return;
          set({
            clipboard: {
              shapes: structuredClone(shapes),
              connectors: structuredClone(connectors),
            },
          });
        },
        cutSelection: () => {
          get().copySelection();
          get().deleteSelection();
        },
        paste: (at) => {
          const cb = get().clipboard;
          if (!cb || (cb.shapes.length === 0 && cb.connectors.length === 0)) {
            return;
          }
          // Compute the bundle's bounding box so we can recentre it on `at`.
          // Shapes contribute their full AABB; connectors contribute via
          // floating endpoints + waypoints. Bound endpoints reference shapes
          // either inside the bundle (already counted) or in the existing
          // diagram (not moved by paste), so we ignore them here.
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const sh of cb.shapes) {
            minX = Math.min(minX, sh.x);
            minY = Math.min(minY, sh.y);
            maxX = Math.max(maxX, sh.x + sh.w);
            maxY = Math.max(maxY, sh.y + sh.h);
          }
          for (const cc of cb.connectors) {
            if (!('shape' in cc.from)) {
              minX = Math.min(minX, cc.from.x);
              minY = Math.min(minY, cc.from.y);
              maxX = Math.max(maxX, cc.from.x);
              maxY = Math.max(maxY, cc.from.y);
            }
            if (!('shape' in cc.to)) {
              minX = Math.min(minX, cc.to.x);
              minY = Math.min(minY, cc.to.y);
              maxX = Math.max(maxX, cc.to.x);
              maxY = Math.max(maxY, cc.to.y);
            }
            for (const wp of cc.waypoints ?? []) {
              minX = Math.min(minX, wp.x);
              minY = Math.min(minY, wp.y);
              maxX = Math.max(maxX, wp.x);
              maxY = Math.max(maxY, wp.y);
            }
          }
          // If the bundle is shape-less AND every connector is bound to an
          // existing diagram shape, we have no positions to compute a bbox
          // from — fall back to a 24px nudge (legacy duplicate offset).
          const haveBox = Number.isFinite(minX);
          const cx = haveBox ? (minX + maxX) / 2 : 0;
          const cy = haveBox ? (minY + maxY) / 2 : 0;
          // If `at` is given, translate so the bundle's centre lands on it.
          // Otherwise nudge by 24px (legacy duplicate-style offset).
          const dx = at && haveBox ? at.x - cx : 24;
          const dy = at && haveBox ? at.y - cy : 24;
          const idMap = new Map<string, string>();
          const newShapes: Shape[] = cb.shapes.map((sh) => {
            const id = newId(sh.kind);
            idMap.set(sh.id, id);
            return {
              ...structuredClone(sh),
              id,
              x: sh.x + dx,
              y: sh.y + dy,
              seed: Math.floor(Math.random() * 1e6),
            };
          });
          // Pass-2: remap intra-bundle shape-id references to the new ids so
          // structural relationships survive the paste. Two fields carry such
          // references today:
          //   - `parent` (group/container membership) — without this remap,
          //     pasted groups visually appear but their children behave as
          //     ungrouped (drag detaches them, group resize doesn't scale, etc.).
          //   - `anchorId` (container → its anchored child icon) — without this
          //     remap, the pasted container's icon picker writes back through
          //     the original's anchorId and updates the *original* container's
          //     icon instead of the pasted copy's.
          for (const ns of newShapes) {
            if (ns.parent && idMap.has(ns.parent)) {
              ns.parent = idMap.get(ns.parent);
            } else if (ns.parent && !idMap.has(ns.parent)) {
              // Parent wasn't included — drop the dangling reference.
              ns.parent = undefined;
            }
            if (ns.anchorId && idMap.has(ns.anchorId)) {
              ns.anchorId = idMap.get(ns.anchorId);
            } else if (ns.anchorId && !idMap.has(ns.anchorId)) {
              // Anchor child wasn't included (cross-doc / partial paste) —
              // drop the dangling ref so subsequent edits don't bleed into
              // a shape from another document.
              ns.anchorId = undefined;
            }
          }
          // Endpoint remap: floating endpoints translate by (dx, dy); bound
          // endpoints either remap to the cloned shape (when the original
          // came along) or keep their original ref (cross-document paste).
          // copySelection writes floating endpoints for any bound endpoint
          // whose shape didn't make it into the bundle, so by the time we
          // get here a bound endpoint is reliably one we want to remap.
          const remapEndpoint = (ep: ConnectorEndpoint): ConnectorEndpoint => {
            if ('shape' in ep) {
              return { ...ep, shape: idMap.get(ep.shape) ?? ep.shape };
            }
            return { x: ep.x + dx, y: ep.y + dy };
          };
          const newConnectors: Connector[] = cb.connectors.map((c) => {
            const cloned = structuredClone(c);
            return {
              ...cloned,
              id: newId('c'),
              from: remapEndpoint(cloned.from),
              to: remapEndpoint(cloned.to),
              waypoints: cloned.waypoints?.map((wp) => ({
                x: wp.x + dx,
                y: wp.y + dy,
              })),
            };
          });
          _snapshot();
          set((s) => {
            // Re-stamp z so the new bundle lands ON TOP of whatever's already
            // on the canvas. structuredClone preserves the originals' z, which
            // is wrong if those were drawn before later items.
            let topZ = 0;
            for (const sh of s.diagram.shapes) {
              if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
            }
            for (const cc of s.diagram.connectors) {
              if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
            }
            const stampedShapes = newShapes.map((sh) => ({ ...sh, z: ++topZ }));
            const stampedConns = newConnectors.map((cc) => ({ ...cc, z: ++topZ }));
            // Select shapes when present; fall back to connectors so a
            // lone-connector paste still leaves the new line selected and
            // visible to the user.
            const newSel =
              stampedShapes.length > 0
                ? stampedShapes.map((ss) => ss.id)
                : stampedConns.map((cc) => cc.id);
            return {
              diagram: {
                ...s.diagram,
                shapes: [...s.diagram.shapes, ...stampedShapes],
                connectors: [...s.diagram.connectors, ...stampedConns],
              },
              dirty: true,
              selectedIds: newSel,
            };
          });
        },
        duplicateSelection: () => {
          // Copy + paste in one shot — keeps the existing clipboard untouched.
          const ids = new Set(get().selectedIds);
          if (ids.size === 0) return;
          // Expand groups / containers to descendants — same rule as
          // copySelection so duplicating a group gets its kids.
          const all = get().diagram.shapes;
          const allConns = get().diagram.connectors;
          const expanded = new Set<string>(ids);
          let added = true;
          while (added) {
            added = false;
            for (const sh of all) {
              if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
                expanded.add(sh.id);
                added = true;
              }
            }
          }
          const shapes = all.filter((s) => expanded.has(s.id));
          // Connectors come along by ride-along (both endpoints in expanded
          // shapes) OR direct selection (the user picked the line itself).
          // Detach any unselected-shape endpoints to floating world coords
          // — same rule as copySelection — so a lone-connector duplicate
          // lands offset from the source instead of stacked on top.
          const connectors = allConns
            .filter((c) => {
              const f = 'shape' in c.from ? c.from.shape : null;
              const t = 'shape' in c.to ? c.to.shape : null;
              const rideAlong =
                f != null && t != null && expanded.has(f) && expanded.has(t);
              return rideAlong || ids.has(c.id);
            })
            .map((c) => detachUnselectedEndpoints(c, expanded, all));
          if (shapes.length === 0 && connectors.length === 0) return;
          const idMap = new Map<string, string>();
          const offset = 24;
          const newShapes: Shape[] = shapes.map((sh) => {
            const id = newId(sh.kind);
            idMap.set(sh.id, id);
            return {
              ...structuredClone(sh),
              id,
              x: sh.x + offset,
              y: sh.y + offset,
              seed: Math.floor(Math.random() * 1e6),
            };
          });
          // Same parent-remap pass as paste(): if the parent shape was
          // duplicated too, point at the clone; if not, drop the link.
          for (const ns of newShapes) {
            if (ns.parent && idMap.has(ns.parent)) {
              ns.parent = idMap.get(ns.parent);
            } else if (ns.parent && !idMap.has(ns.parent)) {
              ns.parent = undefined;
            }
          }
          const remapEndpoint = (ep: ConnectorEndpoint): ConnectorEndpoint => {
            if ('shape' in ep) {
              return { ...ep, shape: idMap.get(ep.shape) ?? ep.shape };
            }
            return { x: ep.x + offset, y: ep.y + offset };
          };
          const newConnectors: Connector[] = connectors.map((c) => {
            const cloned = structuredClone(c);
            return {
              ...cloned,
              id: newId('c'),
              from: remapEndpoint(cloned.from),
              to: remapEndpoint(cloned.to),
              waypoints: cloned.waypoints?.map((wp) => ({
                x: wp.x + offset,
                y: wp.y + offset,
              })),
            };
          });
          _snapshot();
          set((s) => {
            // Re-stamp z so the new bundle lands ON TOP of whatever's already
            // on the canvas. structuredClone preserves the originals' z, which
            // is wrong if those were drawn before later items.
            let topZ = 0;
            for (const sh of s.diagram.shapes) {
              if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
            }
            for (const cc of s.diagram.connectors) {
              if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
            }
            const stampedShapes = newShapes.map((sh) => ({ ...sh, z: ++topZ }));
            const stampedConns = newConnectors.map((cc) => ({ ...cc, z: ++topZ }));
            const newSel =
              stampedShapes.length > 0
                ? stampedShapes.map((ss) => ss.id)
                : stampedConns.map((cc) => cc.id);
            return {
              diagram: {
                ...s.diagram,
                shapes: [...s.diagram.shapes, ...stampedShapes],
                connectors: [...s.diagram.connectors, ...stampedConns],
              },
              dirty: true,
              selectedIds: newSel,
            };
          });
        },

        // file
        setFilePath: (path) => set({ filePath: path }),
        setDirty: (d) => set({ dirty: d }),
        markSaved: () => set({ dirty: false, lastSavedAt: Date.now() }),
        loadDiagram: (d, path) =>
          set({
            diagram: d,
            filePath: path,
            dirty: false,
            lastSavedAt: Date.now(),
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
          }),
        newDiagram: () => {
          set({
            diagram: { ...EMPTY_DIAGRAM, shapes: [], connectors: [], annotations: [] },
            filePath: null,
            dirty: false,
            lastSavedAt: null,
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
            zoom: 1,
            pan: { x: 0, y: 0 },
          });
        },
        setTitle: (t: string) => {
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              meta: { ...s.diagram.meta, title: t || 'untitled' },
            },
            dirty: true,
          }));
        },

        // hotkey rebind
        bindHotkey: (key, def) =>
          set((s) => ({
            hotkeyBindings: { ...s.hotkeyBindings, [key]: def },
          })),
        resetBindings: () => set({ hotkeyBindings: DEFAULT_BINDINGS }),

        // canvas appearance
        setCanvasPaper: (c) => set({ canvasPaper: c }),
        setShowDots: (v) => set({ showDots: v }),
        setShowGrid: (v) => set({ showGrid: v }),

        setTipsEnabled: (v) =>
          // Flipping the master switch off also clears whatever's currently
          // showing — otherwise a toast that was visible at toggle time
          // would freeze on screen until the next interaction.
          set({ tipsEnabled: v, activeTipKey: v ? get().activeTipKey : null }),
        setActiveTipKey: (k) => set({ activeTipKey: k }),

        setHoverEdgeConnectors: (v) => set({ hoverEdgeConnectors: v }),

        // pen settings
        setPenColor: (c) => set({ penColor: c }),
        setPenWidth: (w) => set({ penWidth: w }),

        // sticky last-used styles
        setLastStyles: (patch) =>
          set((s) => ({ lastStyles: { ...s.lastStyles, ...patch } })),
        setLastConnectorStyle: (patch) =>
          set((s) => ({
            lastConnectorStyle: { ...s.lastConnectorStyle, ...patch },
          })),

        // containers
        // Wrap a single non-basic shape in a container frame. The shape stays
        // anchored at the top-left of the container; the container extends
        // right + down so the user has space to drop additional members in.
        // Containers behave like groups for drag (children come along) but
        // resize differently — see the resize handler in Canvas which scales
        // group children but leaves container children pinned.
        makeContainer: (id) => {
          const sh = get().diagram.shapes.find((s) => s.id === id);
          if (!sh) return;
          // Already containerised — no-op.
          if (sh.parent) {
            const parent = get().diagram.shapes.find((p) => p.id === sh.parent);
            if (parent?.kind === 'container') return;
          }
          // Containers are about identifying a region, not displaying a giant
          // glyph. Shrink the anchor child to a small default — 40px square
          // for icon/image (square assets), 56px-tall for service tiles
          // (which carry a 3-letter glyph that needs reading room). Other
          // kinds keep their existing dims.
          const ANCHOR_ICON_SIZE = 40;
          const ANCHOR_SERVICE_W = 96;
          const ANCHOR_SERVICE_H = 56;
          const isIconish = sh.kind === 'icon' || sh.kind === 'image';
          const isService = sh.kind === 'service';
          const childW = isIconish
            ? ANCHOR_ICON_SIZE
            : isService
              ? ANCHOR_SERVICE_W
              : sh.w;
          const childH = isIconish
            ? ANCHOR_ICON_SIZE
            : isService
              ? ANCHOR_SERVICE_H
              : sh.h;
          // Padding so the anchor child doesn't sit flush against the frame's
          // top-left edge. Subtle (12px) — enough to read as breathing room
          // without making tiny containers feel sparse.
          const PAD = 12;
          // Frame leaves room for a label to the right of the child + a
          // drop area below. Min dims keep the frame readable for tiny
          // anchor shapes.
          const frameW = Math.max(childW + 200, 260);
          const frameH = Math.max(childH + 120, 160);
          const containerId = newId('container');
          const container: Shape = {
            id: containerId,
            kind: 'container',
            // Shift the frame up + left by PAD so the anchor child stays put
            // (selecting + tweaking the icon doesn't surprise the user) but
            // gains visible padding inside the container.
            x: sh.x - PAD,
            y: sh.y - PAD,
            w: frameW,
            h: frameH,
            label: '',
            layer: sh.layer,
            // Pin the label to THIS shape — the original wrapped child.
            // Subsequent drop-ins are siblings; without this pin, label
            // positioning re-picks by array order and shifts with adoption.
            anchorId: sh.id,
          };
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              // Insert container BEFORE the anchor so it renders behind it.
              // Group-frame ordering (Canvas renders kind: 'group' first) is
              // separate; containers sit in normal z order.
              shapes: [
                container,
                ...s.diagram.shapes.map((x) =>
                  x.id === sh.id
                    ? { ...x, parent: containerId, w: childW, h: childH }
                    : x,
                ),
              ],
            },
            dirty: true,
            selectedIds: [containerId],
          }));
        },

        adoptIntoContainer: (id) => {
          const sh = get().diagram.shapes.find((s) => s.id === id);
          if (!sh) return;
          const all = get().diagram.shapes;
          // Group membership is sticky — selecting a group child has its own
          // contract (the whole group drags together). Don't auto-release
          // group members as containers do. This guard fires for *children*
          // of a group; the group itself is allowed to enter a container
          // (parenting is the same `parent` field for both kinds, and the
          // drag/resize code walks the parent chain transitively).
          if (sh.parent) {
            const currentParent = all.find((p) => p.id === sh.parent);
            if (currentParent?.kind === 'group') return;
          }
          // Containment rule (Vellum bug list 13): a shape is "in" a
          // container only if more than half of its bbox area overlaps the
          // container. Centre-point was too eager — a long rectangle that
          // mostly stuck out got swallowed because its midpoint happened to
          // fall inside.
          const shArea = Math.max(0, Math.abs(sh.w)) * Math.max(0, Math.abs(sh.h));
          if (shArea === 0) return;
          // Forbid container-into-self / descendant cycle — a container can
          // be adopted by an ANCESTOR container but never by a child.
          const isDescendantOf = (candidate: string, ancestor: string): boolean => {
            let cur = all.find((x) => x.id === candidate);
            while (cur?.parent) {
              if (cur.parent === ancestor) return true;
              cur = all.find((x) => x.id === cur!.parent);
            }
            return false;
          };
          const overlapFrac = (c: Shape) => {
            const ix1 = Math.max(sh.x, c.x);
            const iy1 = Math.max(sh.y, c.y);
            const ix2 = Math.min(sh.x + sh.w, c.x + c.w);
            const iy2 = Math.min(sh.y + sh.h, c.y + c.h);
            const iw = Math.max(0, ix2 - ix1);
            const ih = Math.max(0, iy2 - iy1);
            return (iw * ih) / shArea;
          };
          const candidates = all
            .filter((c) => c.kind === 'container' && c.id !== id)
            // Don't adopt a frame (container or group) into one of its own
            // descendants — that would create a parent-chain cycle. Plain
            // shapes have no descendants so the check is a cheap no-op for
            // them, but we run it unconditionally to keep the rule simple.
            .filter((c) => !isDescendantOf(c.id, id))
            .map((c) => ({ c, frac: overlapFrac(c) }))
            .filter(({ frac }) => frac > 0.5)
            // Walk in reverse z order — the front-most qualifying container
            // wins so dropping into a nested container picks the inner one.
            .sort((a, b) => (b.c.z ?? 0) - (a.c.z ?? 0));
          const target = candidates[0]?.c;
          // Re-evaluate parent unconditionally on every drop. Three outcomes:
          //   1. New target found → adopt (set parent, possibly re-parent
          //      from container A to container B).
          //   2. No target AND current parent is a container → release
          //      (drag-out unbinds, the bug fix).
          //   3. No change needed → bail without writing.
          // `target?.id` of undefined means "no parent" (clean release).
          const nextParent = target?.id;
          if (nextParent === sh.parent) return;
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: s.diagram.shapes.map((x) =>
                x.id === id ? { ...x, parent: nextParent } : x,
              ),
            },
            dirty: true,
          }));
        },

        // recent activity
        recentShapes: [],
        recordRecent: (entry) =>
          set((s) => {
            // Dedup by key — the most recent occurrence wins and floats to the
            // top. Without dedup the list would degenerate into N copies of
            // the user's favourite shape after a few uses.
            const filtered = s.recentShapes.filter((r) => r.key !== entry.key);
            return {
              recentShapes: [entry, ...filtered].slice(0, RECENT_LIMIT),
            };
          }),
        clearRecent: () => set({ recentShapes: [] }),

        // personal library
        personalLibrary: [],
        addToLibrary: (label, ids) => {
          const sel = new Set(ids);
          const shapes = get().diagram.shapes.filter((s) => sel.has(s.id));
          if (shapes.length === 0) return;
          // Include group descendants automatically.
          const expand = new Set<string>(sel);
          for (const s of shapes) {
            if (s.kind === 'group') {
              for (const m of get().diagram.shapes) {
                if (m.parent === s.id) expand.add(m.id);
              }
            }
          }
          const all = get().diagram.shapes.filter((s) => expand.has(s.id));
          // Connectors that have both ends inside the bundle.
          const connectors = get().diagram.connectors.filter((c) => {
            const f = 'shape' in c.from ? c.from.shape : null;
            const t = 'shape' in c.to ? c.to.shape : null;
            return f != null && t != null && expand.has(f) && expand.has(t);
          });
          // Normalise to (0, 0) origin so drop-in is easier.
          let minX = Infinity, minY = Infinity;
          for (const s of all) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
          }
          const normShapes: Shape[] = all.map((s) =>
            structuredClone({ ...s, x: s.x - minX, y: s.y - minY }),
          );
          const normConnectors: Connector[] = connectors.map((c) => structuredClone(c));
          // Glyph: first three chars of the label, uppercased.
          const glyph = label.slice(0, 3).toUpperCase() || 'SHP';
          set((s) => ({
            personalLibrary: [
              ...s.personalLibrary,
              { label, glyph, shapes: normShapes, connectors: normConnectors },
            ],
          }));
        },
        removeFromLibrary: (index) =>
          set((s) => ({
            personalLibrary: s.personalLibrary.filter((_, i) => i !== index),
          })),
      };
    },
    {
      name: 'vellum.editor',
      storage: createJSONStorage(() => localStorage),
      partialize: (s): PersistedSlice => ({
        hotkeyBindings: s.hotkeyBindings,
        theme: s.theme,
        personalLibrary: s.personalLibrary,
        canvasPaper: s.canvasPaper,
        showDots: s.showDots,
        showGrid: s.showGrid,
        libraryPanelOpen: s.libraryPanelOpen,
        lastStyles: s.lastStyles,
        lastConnectorStyle: s.lastConnectorStyle,
        recentShapes: s.recentShapes,
        diagram: s.diagram,
        filePath: s.filePath,
        inspectorOpen: s.inspectorOpen,
        tipsEnabled: s.tipsEnabled,
        hoverEdgeConnectors: s.hoverEdgeConnectors,
      }),
      // Bindings are no longer user-rebindable, so we ignore any stored
      // hotkeyBindings and always boot with the current DEFAULT_BINDINGS.
      // This prevents legacy persisted slots (e.g. user-bound 8/9 from when
      // those were rebindable, or the old `b` pen binding) from polluting
      // the new fixed layout.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice>;
        const merged: typeof current = {
          ...current,
          ...p,
          hotkeyBindings: DEFAULT_BINDINGS,
        };
        return merged;
      },
    },
  ),
);

/** Selectors — keep tight, the canvas re-renders on every diagram change. */
export const selectVisibleShapes = (s: EditorState) =>
  s.diagram.shapes.filter((sh) => {
    if (s.layerMode === 'both') return true;
    return sh.layer === s.layerMode;
  });

/** Factory for newly-created shapes from the toolbar. Centralised here so the
 *  default geometry / layer is one place to change.
 *
 *  Style inheritance: pulls `lastStyles` off the store and applies whichever
 *  fields are set so new shapes inherit the user's most-recent style choices
 *  (fill, stroke, font, line width, text colour). Notes are exempt — the
 *  sticky-note look depends on its baked-in palette and a user-picked stroke
 *  override would clash with that. */
export function defaultShapeFromTool(
  toolKey: ToolKey,
  toolName: string,
  x: number,
  y: number,
  w: number,
  h: number,
  glyph?: string,
  label?: string,
): Shape | null {
  const seed = Math.floor(Math.random() * 1e6);
  const id = newId(toolName);

  const kindMap: Record<string, ShapeKind> = {
    rect: 'rect',
    ellipse: 'ellipse',
    diamond: 'diamond',
    text: 'text',
    note: 'note',
  };

  // The user's current layer pill drives where new shapes land. `both` falls
  // back to Blueprint so the obvious default never produces a hidden shape.
  const layerMode = useEditor.getState().layerMode;
  const defaultLayer: Layer =
    layerMode === 'notes' ? 'notes' : 'blueprint';

  // Pull sticky styles. Notes intentionally skip these.
  const ls = useEditor.getState().lastStyles;
  const stickyStyles = (kind: ShapeKind): Partial<Shape> => {
    if (kind === 'note') return {};
    const out: Partial<Shape> = {};
    if (ls.fill !== undefined) out.fill = ls.fill;
    if (ls.stroke !== undefined) out.stroke = ls.stroke;
    if (ls.strokeWidth !== undefined) out.strokeWidth = ls.strokeWidth;
    if (ls.fontFamily !== undefined) out.fontFamily = ls.fontFamily;
    if (ls.textColor !== undefined) out.textColor = ls.textColor;
    // Corner radius is rect / service / container only at render time; only
    // stamp it on those kinds so an ellipse/diamond doesn't carry a
    // meaningless field.
    if (
      ls.cornerRadius !== undefined &&
      (kind === 'rect' || kind === 'service' || kind === 'container')
    ) {
      out.cornerRadius = ls.cornerRadius;
    }
    return out;
  };

  if (toolName === 'rect' || toolName === 'ellipse' || toolName === 'diamond') {
    return {
      id,
      kind: kindMap[toolName],
      x,
      y,
      w,
      h,
      label: '',
      layer: defaultLayer,
      seed,
      ...stickyStyles(kindMap[toolName]),
    };
  }
  if (toolName === 'container') {
    // Drawing a fresh container with the 8 hotkey — frame with empty
    // anchor. The "add icon" affordance lives in the inspector + the
    // canvas-side top-left + button on a hovered/selected container.
    //
    // Containers deliberately don't inherit the full sticky-style set
    // (the dashed-frame identity should win over a leftover stroke /
    // fill choice), but cornerRadius IS a useful sticky default for
    // them — the user wants their preferred frame radius to persist.
    // Only stamp it when the user has actually saved a value.
    const containerSticky: Partial<Shape> = {};
    if (ls.cornerRadius !== undefined) {
      containerSticky.cornerRadius = ls.cornerRadius;
    }
    return {
      id,
      kind: 'container',
      x,
      y,
      w,
      h,
      label: '',
      layer: defaultLayer,
      seed,
      strokeStyle: 'dashed',
      ...containerSticky,
    };
  }
  if (toolName === 'text') {
    return {
      id,
      kind: 'text',
      x,
      y,
      w,
      h,
      label: 'text',
      layer: defaultLayer,
      seed,
      ...stickyStyles('text'),
    };
  }
  if (toolName === 'note') {
    // Note-kind shapes always live in the Notes layer (the sticky-note metaphor).
    return {
      id,
      kind: 'note',
      x,
      y,
      w,
      h,
      label: '',
      layer: 'notes',
      seed,
    };
  }
  if (toolName === 'table') {
    // Default 3×3 grid. Cells start unallocated — render fills them as empty
    // strings, and the file stays compact ("absent cells" beats "rows of empty
    // strings" on disk). Min size guard ensures dragging out a tiny rectangle
    // still produces a readable grid.
    const tableW = Math.max(w, 120);
    const tableH = Math.max(h, 60);
    return {
      id,
      kind: 'table',
      x,
      y,
      w: tableW,
      h: tableH,
      layer: defaultLayer,
      rows: 3,
      cols: 3,
      ...stickyStyles('rect' as ShapeKind),
    };
  }
  // Library / custom-bound tools: drop a service tile with the glyph + label.
  // The toolName is the library shape id (e.g. "lambda", "s3").
  if (glyph || label) {
    return {
      id,
      kind: 'service',
      x,
      y,
      w,
      h,
      label: label ?? '',
      icon: glyph,
      layer: defaultLayer,
      ...stickyStyles('service'),
    };
  }
  void toolKey;
  return null;
}

/** Centralised resolver for whether the current activeTool produces a shape on
 *  pointer drag. Tools 5/6 (arrow, line) draw connectors instead — handled
 *  separately in the canvas interaction module. */
export function toolCreatesShape(toolName: string): boolean {
  return [
    'rect',
    'ellipse',
    'diamond',
    'text',
    'note',
    'container',
    'table',
  ].includes(toolName);
}

export function toolCreatesConnector(toolName: string): boolean {
  return ['arrow', 'line'].includes(toolName);
}
