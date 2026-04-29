import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultShapeFromTool,
  detachUnselectedEndpoints,
  newId,
  toolCreatesConnector,
  toolCreatesShape,
  useEditor,
} from '@/store/editor';
import type { Anchor, Connector as ConnectorT, Shape as ShapeT } from '@/store/types';
import { buildSmoothPath, Shape, cellAtPoint } from './Shape';
import { Connector } from './Connector';
import {
  applyHandleDrag,
  clientToScreen,
  connectorsInMarquee,
  cursorForHandle,
  EDGE_SNAP_BAND,
  HANDLE_KINDS,
  Handle,
  handlePosition,
  normalizeRect,
  pointInShape,
  pointInShapeCenterZone,
  pointInShapeEdgeBand,
  Pt,
  screenToWorld,
  shapesInMarquee,
  snapPointToAngle,
} from './projection';
import {
  autoAnchor,
  buildOrthogonalPolyline,
  buildOrthogonalThroughWaypoints,
  buildPath,
  connectorPolyline,
  nearestFractionOnPolyline,
  pointAtFraction,
  resolveConnectorPath,
  resolveEndpointPoint,
  sampleCurvedPolyline,
} from './routing';
import { computeContainerIconPosition } from './projection';
import { mdToPlain } from '@/lib/inline-marks';
import { subscribeSilhouettes } from './silhouette';
import {
  measureText,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_DEFAULT_FONT_SIZE,
  TEXT_DEFAULT_FONT_WEIGHT,
  TEXT_DEFAULT_TOOL_FONT_SIZE,
} from './measure-text';
import { ContextMenu, type ContextMenuTarget } from '../chrome/ContextMenu';
import { resolveIcon } from '@/icons/resolve';
import type { IconDragPayload } from '@/icons/types';
import { parseClipboardEnvelope, parseShapes, parseConnectors } from '@/store/schema';

/** Discriminated interaction state — held in a ref so pointermove doesn't
 *  re-render the world for every motion. The visible "preview" (the rectangle
 *  being drawn, the marquee box, the connector line in flight) is a separate
 *  useState so React can repaint *just* the overlay. */
type Interaction =
  | { kind: 'idle' }
  | { kind: 'creating-shape'; toolName: string; start: Pt; current: Pt }
  | {
      kind: 'creating-connector';
      /** When null, the from-side floats at `fromPoint` (line tool drawn from
       *  empty canvas). Otherwise the connector binds to the shape. */
      fromShape: string | null;
      fromAnchor: Anchor;
      fromPoint: Pt;
      current: Pt;
      /** Shape that was under the click — regardless of whether the from-
       *  side actually bound to it. Tracked so we can suppress the to-side
       *  snap when the user draws an annotation entirely inside one shape:
       *  starting deep in the body, ending deep in the body — neither end
       *  should bind, the line is a free annotation over the shape. The
       *  ordinary edge-band rule on its own snapped the to-side onto the
       *  same shape's perimeter, which felt aggressive.
       *
       *  Distinct from `fromShape`, which is null when the click landed in
       *  the interior outside the edge band. `fromShapeRaw` ignores the
       *  band — any shape under the click counts. */
      fromShapeRaw: string | null;
      toolName: 'arrow' | 'line' | 'select';
    }
  | {
      kind: 'dragging';
      ids: string[];
      pointerStart: Pt;
      worldStart: Map<string, { x: number; y: number }>;
      /** Connectors carried along inside a multi-selection drag. Endpoints
       *  bound to dragged shapes follow naturally (the renderer re-resolves
       *  them from the moved shape positions every frame), but waypoints +
       *  free-floating endpoints live in world-space and must be explicitly
       *  translated by the same dx/dy as the shapes — otherwise bends "stay
       *  behind" while the rest of the selection slides. Shape ids and
       *  connector ids live in different code paths (worldStart only knows
       *  shapes), so we snapshot connectors separately here. */
      connectorTranslates: Array<{
        id: string;
        /** Snapshot of the from-side floating point. Undefined when from is
         *  shape-bound — bound endpoints follow their shape automatically. */
        fromStart?: { x: number; y: number };
        /** Snapshot of the to-side floating point. Same rule as fromStart. */
        toStart?: { x: number; y: number };
        /** Snapshot of every waypoint's world position at drag begin. */
        waypointStarts: { x: number; y: number }[];
      }>;
      moved: boolean;
    }
  | {
      /** Translating a free-floating connector — moves both endpoints + any
       *  waypoints by the drag delta. Only used when both endpoints are
       *  floating; bound endpoints stick to their shapes and use bend instead.
       */
      kind: 'translate-connector';
      connectorId: string;
      pointerStart: Pt;
      fromStart: { x: number; y: number };
      toStart: { x: number; y: number };
      waypointStarts: { x: number; y: number }[];
      moved: boolean;
    }
  | {
      kind: 'resizing';
      id: string;
      handle: Handle;
      pointerStart: Pt;
      /** Geometry snapshot at pointer-down. For text shapes the corner-drag
       *  handler also reads `fontSize` so it can scale the typeface in
       *  proportion to the bbox without the live fontSize value (which is
       *  updated every move) compounding the scale into runaway growth. */
      startGeom: { x: number; y: number; w: number; h: number; fontSize?: number };
      /** When the target is a group OR container, snapshot every descendant's
       *  start geometry so we can rescale (groups) or translate (containers)
       *  them on every move using the original numbers — not the live-updated
       *  ones, which would compound rounding errors. */
      childrenStart?: Map<
        string,
        { x: number; y: number; w: number; h: number }
      >;
      /** 'group'     = scale children proportionally with the bounding box.
       *  'container' = container resize semantics (added 2026-04-28): children
       *                stay put except the container's anchor icon, which
       *                tracks the NW corner. Min-size clamps the bbox so it
       *                always contains its non-anchor children.
       *  undefined   = leaf shape, no child handling. */
      childMode?: 'group' | 'container';
      /** For `childMode === 'container'`: the id of the anchor icon child
       *  (container.anchorId at gesture start). Only this child translates
       *  with the resize — every other member keeps its world position. */
      anchorChildId?: string;
      /** For `childMode === 'container'`: union bbox in world coords of every
       *  non-anchor child at gesture start. The resize handler clamps the new
       *  container bbox to always contain this rectangle so the user can't
       *  shrink the frame past its members. Undefined when the container has
       *  no non-anchor children — no clamp needed in that case. */
      containerMinBox?: { minX: number; minY: number; maxX: number; maxY: number };
    }
  | {
      /** Multi-shape resize. The user grabbed a corner / edge handle on one
       *  of several selected shapes and we treat the gesture as scaling the
       *  whole SELECTION, not just that shape. The dragged handle's name is
       *  applied to the SELECTION'S union bbox (so dragging an outer NW
       *  corner of the selection scales all members from the SE anchor of
       *  the union). Each member's geometry is then re-derived as its
       *  fractional position + size inside the original union, mapped onto
       *  the new union — i.e. proportional scaling. Rotated members aren't
       *  uniformly scaled because the rect→rect mapping doesn't account
       *  for rotation; that's a known limit. */
      kind: 'resizing-multi';
      handle: Handle;
      pointerStart: Pt;
      /** Union bbox of the selection at gesture start. Drives the
       *  applyHandleDrag math in the move handler. */
      startUnion: { x: number; y: number; w: number; h: number };
      /** Per-member geometry at pointer-down. Lookup by id. */
      childrenStart: Map<
        string,
        { x: number; y: number; w: number; h: number; fontSize?: number }
      >;
    }
  | {
      kind: 'marquee';
      start: Pt;
      current: Pt;
      additive: boolean;
    }
  | {
      /** Dragging a real waypoint — moves the existing point. */
      kind: 'drag-waypoint';
      connectorId: string;
      index: number;
      moved: boolean;
    }
  | {
      /** Dragging a *midpoint* — turns into a new waypoint at `insertIndex`
       *  on the first significant move. */
      kind: 'create-waypoint';
      connectorId: string;
      insertIndex: number;
      pointerStart: Pt;
      committed: boolean;
    }
  | {
      /** Dragging a connector's from/to endpoint — releases the binding when
       *  dragged off, snaps to a shape on release if the cursor is over one. */
      kind: 'drag-endpoint';
      connectorId: string;
      side: 'from' | 'to';
      moved: boolean;
    }
  | {
      /** Drawing a freehand path. Points accumulate while pointer is down. */
      kind: 'pen';
      points: { x: number; y: number }[];
    }
  | {
      /** Laser pointer in flight — trails fade out via a useState array. */
      kind: 'laser';
    }
  | {
      /** Rotating an icon shape via the dedicated rotation handle that floats
       *  above the bounding box. We snapshot the start geometry + start
       *  rotation so the live drag can compute an absolute angle from the
       *  shape center to the cursor and offset it by however the pointer was
       *  positioned at pointer-down (i.e. the handle doesn't snap to the
       *  cursor on first move; it follows from wherever the user grabbed it). */
      kind: 'rotating';
      id: string;
      /** Shape center at pointer-down — the pivot we measure angles from.
       *  Snapshotted so a mid-drag re-render that moves the shape by some
       *  other path (none today, but future-proof) can't drift the pivot. */
      cx: number;
      cy: number;
      /** Rotation value the shape had when the drag started. */
      startRotation: number;
      /** Angle from (cx,cy) to the pointer at pointer-down, in degrees. The
       *  delta between this and the live pointer angle is what we add to
       *  startRotation each frame. */
      pointerStartAngle: number;
      /** When the rotated shape is a container, every descendant rotates with
       *  it — orbit each descendant's centre around (cx, cy) by the gesture
       *  delta and add the same delta to its own rotation field. We snapshot
       *  the descendants' start geometry (centre, size, rotation) here so the
       *  live tick is a pure function of (snapshot, delta), free of frame-to-
       *  frame rounding drift. Empty for non-container rotates — the shape
       *  rotates alone, same as before. */
      descendants: {
        id: string;
        /** Centre of the descendant at gesture-start, in world coords. We
         *  rotate this point around (cx, cy) and recover x = newCx - w/2,
         *  y = newCy - h/2 each tick. */
        cx: number;
        cy: number;
        w: number;
        h: number;
        /** rotation field at gesture-start. The live tick writes
         *  `startRotation + delta` (normalised), so re-rotating after a
         *  partial drag stays consistent with how the container's own
         *  rotation is computed. */
        startRotation: number;
      }[];
    }
  | {
      /** Sliding a connector's label along its path. The user grabs the
       *  label rect and the cursor projects onto the polyline frame-by-
       *  frame; the projection's arclength fraction becomes the new
       *  `labelPosition`. We capture the original fraction so the drag
       *  can be undone as a single history step. `moved` gates the
       *  history snapshot — a click that doesn't move shouldn't push an
       *  undo entry, otherwise stray label-clicks litter the history. */
      kind: 'dragging-connector-label';
      connectorId: string;
      startFraction: number;
      moved: boolean;
    }
  | { kind: 'panning'; pointerStart: Pt; panStart: Pt };

/** Pixel distance (in screen pixels — divided by zoom at use site) from the
 *  top edge of the bounding box to the rotation handle's center. Matches
 *  the visual convention in Figma / Excalidraw / draw.io where the rotate
 *  handle floats just above the selection so the corner resize handles
 *  stay reachable. 22px puts it clear of a 6px corner handle plus its 4px
 *  selection halo padding. */
const ROTATE_HANDLE_OFFSET = 22;

/** Snapshot of `Interaction` we mirror into useState for render. Rather than
 *  forcing a reconcile per move, we coalesce moves into a single state object. */
type Preview =
  | null
  | { kind: 'creating-shape'; rect: { x: number; y: number; w: number; h: number }; toolName: string }
  | {
      kind: 'creating-connector';
      from: { x: number; y: number };
      to: { x: number; y: number };
      /** Shape ids the from/to endpoints would bind to if released right now.
       *  Drives the snap-halo render so the user sees what's about to bind. */
      fromShape: string | null;
      toShape: string | null;
    }
  | {
      kind: 'marquee';
      rect: { x: number; y: number; w: number; h: number };
      /** Live "would-select" candidates — recomputed every move. We render
       *  their selection halos in real time so the user sees what the marquee
       *  is about to pick up before releasing. Same fully-contained rule as
       *  commit. */
      shapeIds: string[];
      connectorIds: string[];
    };

/** Number of pixels of pointer travel before a drag is "real" (i.e. moved=true).
 *  Below this, the drag is treated as a click and selection logic runs on up. */
const DRAG_THRESHOLD = 3;

/** Tag we prefix our serialized clipboard payload with so the paste handler
 *  can recognise it on the way back. */
const VELLUM_CLIPBOARD_PREFIX = 'vellum:clipboard:';

/** Visible length of the laser-pointer tail in *screen* pixels. The trail's
 *  per-segment opacity is `1 - cumLen/LASER_MAX_LEN_PX`, so anything past this
 *  cumulative path length is transparent. Screen-space (divided by zoom at
 *  read time) keeps the visual length consistent regardless of canvas zoom.
 *  Kept as a documented constant for tuning even though the current renderer
 *  uses the layered-polyline path that derives length from the trail array. */
const LASER_MAX_LEN_PX = 180;
void LASER_MAX_LEN_PX;

/** After motion stops, how long the entire trail takes to fade out. Applied
 *  as a uniform multiplier on top of the per-segment distance fade. Kept here
 *  for tuning; the live fade lives in the rAF loop further down. */
const LASER_STOP_FADE_MS = 700;
void LASER_STOP_FADE_MS;

/** Compute which container(s) would adopt the currently-dragged shapes if the
 *  pointer were released right now. Mirrors the rule in
 *  store/editor.ts → adoptIntoContainer:
 *    - skip shapes whose parent is a group (group membership is sticky —
 *      a group's *children* don't get adopted out, but the group itself can)
 *    - candidate must be a container with >50% bbox-area overlap on the
 *      tentative post-translation bbox of the dragged shape
 *    - cycle-safe: a frame (container or group) can only be adopted by an
 *      ancestor container, never by one of its own descendants
 *    - front-most z wins so nested containers pick the inner one
 *
 *  Skips containers that would be no-ops (already the shape's parent) and
 *  containers in the dragged set itself (you can't drop a thing into itself).
 *
 *  The returned Set is the union across all dragged shapes — multi-select
 *  drags can target several containers at once, and we want to glow each.
 */
function computeShapeDropTargets(
  draggedIds: string[],
  worldStart: Map<string, { x: number; y: number }>,
  dx: number,
  dy: number,
  allShapes: ShapeT[],
): Set<string> {
  const draggedSet = new Set(draggedIds);
  const out = new Set<string>();
  const isDescendantOf = (candidate: string, ancestor: string): boolean => {
    let cur = allShapes.find((x) => x.id === candidate);
    while (cur?.parent) {
      if (cur.parent === ancestor) return true;
      cur = allShapes.find((x) => x.id === cur!.parent);
    }
    return false;
  };
  for (const id of draggedIds) {
    const sh = allShapes.find((s) => s.id === id);
    if (!sh) continue;
    if (sh.parent) {
      const currentParent = allShapes.find((p) => p.id === sh.parent);
      if (currentParent?.kind === 'group') continue;
    }
    const start = worldStart.get(id);
    if (!start) continue;
    const w = Math.max(0, Math.abs(sh.w));
    const h = Math.max(0, Math.abs(sh.h));
    const area = w * h;
    if (area === 0) continue;
    const x = start.x + dx;
    const y = start.y + dy;
    const candidates = allShapes
      .filter((c) => c.kind === 'container' && c.id !== id)
      .filter((c) => !draggedSet.has(c.id))
      // Cycle guard for frames (container or group). Plain shapes have no
      // descendants, so isDescendantOf is a cheap no-op for them.
      .filter((c) => !isDescendantOf(c.id, id))
      .map((c) => {
        const ix1 = Math.max(x, c.x);
        const iy1 = Math.max(y, c.y);
        const ix2 = Math.min(x + w, c.x + c.w);
        const iy2 = Math.min(y + h, c.y + c.h);
        const iw = Math.max(0, ix2 - ix1);
        const ih = Math.max(0, iy2 - iy1);
        return { c, frac: (iw * ih) / area };
      })
      .filter(({ frac }) => frac > 0.5)
      .sort((a, b) => (b.c.z ?? 0) - (a.c.z ?? 0));
    const target = candidates[0]?.c;
    // Only highlight when adoption would actually move the shape — landing
    // on the current parent again would be a silent no-op, so glowing it
    // would lie. Same gate as adoptIntoContainer's `nextParent === sh.parent`
    // bail.
    if (target && target.id !== sh.parent) {
      out.add(target.id);
    }
  }
  return out;
}

/** Compute which container would auto-bind a fully-orphan connector if the
 *  pointer were released right now. Mirrors the rule in the up-handler's
 *  `translate-connector` branch: front-most container whose bbox contains
 *  BOTH endpoint world points. Returns a Set so the caller can union with
 *  the shape-drop set without branching. */
function computeConnectorDropTarget(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  allShapes: ShapeT[],
): Set<string> {
  const out = new Set<string>();
  const candidates = allShapes
    .filter((s) => s.kind === 'container')
    .filter((s) => {
      const inFx = fromX >= s.x && fromX <= s.x + s.w;
      const inFy = fromY >= s.y && fromY <= s.y + s.h;
      const inTx = toX >= s.x && toX <= s.x + s.w;
      const inTy = toY >= s.y && toY <= s.y + s.h;
      return inFx && inFy && inTx && inTy;
    })
    .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  if (candidates[0]) out.add(candidates[0].id);
  return out;
}

/** Set-equality helper used to skip drop-target re-renders when nothing's
 *  changed between successive pointer-move frames. Without this every move
 *  triggers a fresh setState even when the target set is identical, which
 *  costs a needless reconcile per frame across the entire canvas. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function Canvas() {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const rawShapes = useEditor((s) => s.diagram.shapes);
  const connectors = useEditor((s) => s.diagram.connectors);
  const layerMode = useEditor((s) => s.layerMode);
  const selectedIds = useEditor((s) => s.selectedIds);
  const setSelected = useEditor((s) => s.setSelected);
  const toggleSelected = useEditor((s) => s.toggleSelected);
  const addToSelection = useEditor((s) => s.addToSelection);
  // `focusedGroupId` is the group the user has "entered" via double-click.
  // Subscribed here so the focus halo re-renders when it flips.
  const focusedGroupId = useEditor((s) => s.focusedGroupId);

  const activeTool = useEditor((s) => s.activeTool);
  const toolLock = useEditor((s) => s.toolLock);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  const bindings = useEditor((s) => s.hotkeyBindings);

  const zoom = useEditor((s) => s.zoom);
  const pan = useEditor((s) => s.pan);
  const setPan = useEditor((s) => s.setPan);
  const zoomBy = useEditor((s) => s.zoomBy);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  // Contextual tip-toast (TipToast.tsx). The Canvas owns the gesture-state
  // truth, so it's also responsible for publishing the tip key whenever it
  // enters a gesture that has an associated nudge. Cleared back to null on
  // 'idle'.
  const setActiveTipKey = useEditor((s) => s.setActiveTipKey);
  // Hover-edge connector affordance — drives both the dot rendering on the
  // hovered shape and the pointerdown branch that converts a dot click into
  // a `creating-connector` gesture. Reactive — toggling the setting in
  // CanvasCustomize updates the canvas without a remount.
  const hoverEdgeConnectors = useEditor((s) => s.hoverEdgeConnectors);

  const addShape = useEditor((s) => s.addShape);
  const addConnector = useEditor((s) => s.addConnector);
  const updateShapesLive = useEditor((s) => s.updateShapesLive);
  const updateShapeLive = useEditor((s) => s.updateShapeLive);
  // Used by the resize-commit path on pointer-up to record a single
  // history entry for the gesture (live writes go through Live which
  // doesn't snapshot; commit goes through plain updateShape).
  const updateShape = useEditor((s) => s.updateShape);
  const updateConnectorLive = useEditor((s) => s.updateConnectorLive);
  const commitHistory = useEditor((s) => s.commitHistory);

  // Pen settings — subscribed (not just read on commit) so the in-flight
  // freehand preview repaints when the user toggles colour / thickness in
  // PenPanel mid-stroke or between strokes.
  const penColor = useEditor((s) => s.penColor);
  const penWidth = useEditor((s) => s.penWidth);

  // viewport sizing — track the SVG's pixel dims so we can use them as
  // the viewBox dims (1:1 px↔world, then we scale via the inner <g>).
  const [viewport, setViewport] = useState({ w: 1100, h: 720 });
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setViewport({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // icon silhouettes — connectors anchor to the rasterized icon outline,
  // not the bbox. Silhouette builds are async; subscribe so the canvas re-
  // renders (re-routing every connector) the moment a new mask lands.
  const [, setSilhouetteTick] = useState(0);
  useEffect(() => {
    return subscribeSilhouettes(() => setSilhouetteTick((t) => t + 1));
  }, []);

  // cursor tracker — last pointer position over the canvas in WORLD
  // coords. Used as the paste origin so Cmd+V drops shapes/images where the
  // user is looking instead of the viewport centre.
  const cursorWorldRef = useRef<{ x: number; y: number } | null>(null);

  // Cmd/Ctrl+V routing — handle images from the OS clipboard, then our
  // own JSON envelope (cross-window paste), then fall back to internal
  // clipboard. Skips inputs/textareas so a label-field paste doesn't drop an
  // image on the canvas.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Compute paste origin: prefer the last cursor position over the
      // canvas; otherwise fall back to the viewport centre.
      const rect = svgRef.current?.getBoundingClientRect();
      const vw = rect?.width ?? 800;
      const vh = rect?.height ?? 600;
      const at =
        cursorWorldRef.current ??
        screenToWorld({ x: vw / 2, y: vh / 2 }, { pan, zoom });

      const items = e.clipboardData?.items;
      // 1) Image in OS clipboard?
      let handled = false;
      if (items) {
        for (const it of Array.from(items)) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const file = it.getAsFile();
            if (!file) continue;
            e.preventDefault();
            let dataUrl: string;
            try {
              dataUrl = await fileToDataUrl(file);
            } catch (err) {
              console.warn('image paste rejected', err);
              alert('Image is too large to embed. Save it locally and import a smaller copy.');
              handled = true;
              break;
            }
            const dims = await imageDims(dataUrl);
            const maxW = 480;
            const scale = Math.min(1, maxW / dims.w);
            const w = dims.w * scale;
            const h = dims.h * scale;
            addShape({
              id: newId('img'),
              kind: 'image',
              x: at.x - w / 2,
              y: at.y - h / 2,
              w,
              h,
              src: dataUrl,
              layer: 'blueprint',
            });
            handled = true;
            break;
          }
        }
      }
      // 2) Our own JSON envelope (cross-window or after the user copied a
      //    shape and switched apps and back)?
      //
      //    Security: the envelope JSON is foreign data — even though we wrote
      //    it ourselves moments ago, the OS clipboard is shared and another
      //    app could have substituted a hostile payload. parseClipboardEnvelope
      //    validates the shape and sanitizes any iconSvg fields.
      if (!handled) {
        const text = e.clipboardData?.getData('text/plain');
        if (text && text.startsWith(VELLUM_CLIPBOARD_PREFIX)) {
          try {
            const json = text.slice(VELLUM_CLIPBOARD_PREFIX.length);
            const raw = JSON.parse(json);
            const payload = parseClipboardEnvelope(raw);
            if (payload.shapes.length) {
              // Hydrate into the internal clipboard then paste via the store.
              useEditor.setState({
                clipboard: {
                  shapes: payload.shapes,
                  connectors: payload.connectors,
                },
              });
              useEditor.getState().paste(at);
              e.preventDefault();
              handled = true;
            }
          } catch {
            // Malformed envelope — let it fall through to internal paste.
          }
        }
      }
      // 3) Fall back to internal clipboard.
      if (!handled) {
        useEditor.getState().paste(at);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addShape, pan, zoom]);

  // native copy/cut mirror — write a JSON envelope to the OS clipboard
  // AND populate the internal clipboard. The single source of truth for
  // shape clipboard is now this listener; the keybinding hook intentionally
  // doesn't intercept Cmd+C/X/V so the native events flow through here.
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      return (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      );
    };

    const buildEnvelope = () => {
      const s = useEditor.getState();
      const ids = new Set(s.selectedIds);
      if (ids.size === 0) return null;
      // Walk the parent chains so a selected group / container brings its
      // descendants along — the OS clipboard envelope MUST mirror what the
      // store-level copySelection captures, otherwise the paste handler
      // overwrites the (correct) internal clipboard with a flat-shape-only
      // envelope and the children never make it to the new diagram.
      const all = s.diagram.shapes;
      const allConns = s.diagram.connectors;
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
      const shapes = all.filter((sh) => expanded.has(sh.id));
      // Mirror copySelection: ride-along connectors keep their bound
      // endpoints; directly-selected connectors come along even when the
      // user didn't grab the endpoint shapes, with any unselected-shape
      // endpoint detached to a free-floating world coord. Without this
      // pull, lone-connector copies via cmd-C silently produced an empty
      // envelope and pasted nothing.
      const connectors = allConns
        .filter((c) => {
          const f = 'shape' in c.from ? c.from.shape : null;
          const t = 'shape' in c.to ? c.to.shape : null;
          const rideAlong =
            f != null && t != null && expanded.has(f) && expanded.has(t);
          return rideAlong || ids.has(c.id);
        })
        .map((c) => detachUnselectedEndpoints(c, expanded, all));
      if (shapes.length === 0 && connectors.length === 0) return null;
      return { shapes, connectors };
    };

    const writeOSClipboard = (e: ClipboardEvent, env: { shapes: typeof rawShapes; connectors: typeof connectors }) => {
      e.clipboardData?.setData(
        'text/plain',
        VELLUM_CLIPBOARD_PREFIX + JSON.stringify(env),
      );
      e.preventDefault();
    };

    const onCopy = (e: ClipboardEvent) => {
      if (isFormTarget(e.target)) return;
      const env = buildEnvelope();
      if (!env) return;
      // Internal clipboard (so same-window Cmd+V works without round-tripping
      // through the OS clipboard).
      useEditor.getState().copySelection();
      writeOSClipboard(e, env);
    };

    const onCut = (e: ClipboardEvent) => {
      if (isFormTarget(e.target)) return;
      const env = buildEnvelope();
      if (!env) return;
      useEditor.getState().cutSelection();
      writeOSClipboard(e, env);
    };

    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
    };
  }, []);

  // modifier tracking. `spaceHeldRef` drives space-pan + space-drag-out.
  // `metaHeldRef` is the cmd/ctrl latch the line tools use to disable shape
  // snap. We use a ref because pointer events read this on every move and
  // re-rendering on every keystroke would be wasteful.
  const spaceHeldRef = useRef(false);
  const metaHeldRef = useRef(false);
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
        t.isContentEditable);
    const dn = (e: KeyboardEvent) => {
      if (isFormTarget(e.target)) return;
      if (e.code === 'Space') {
        spaceHeldRef.current = true;
        e.preventDefault();
      }
      if (e.metaKey || e.ctrlKey) metaHeldRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
      if (!e.metaKey && !e.ctrlKey) metaHeldRef.current = false;
    };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    // Browsers can swallow keyup if the window blurs (e.g. user releases cmd
    // outside the tab). Reset on blur to keep the latch honest.
    const onBlur = () => {
      spaceHeldRef.current = false;
      metaHeldRef.current = false;
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // derived render data
  // Fidelity has been retired — render the raw shape list directly.
  const shapes = rawShapes;

  const visibleShapes = useMemo(
    () =>
      shapes.filter((s) => {
        if (layerMode === 'both') return true;
        return s.layer === layerMode;
      }),
    [shapes, layerMode],
  );

  const visibleIds = useMemo(
    () => new Set(visibleShapes.map((s) => s.id)),
    [visibleShapes],
  );

  const visibleConnectors = useMemo(
    () =>
      connectors.filter((c) => {
        // Layer filter: connectors carry their own layer (defaulting to
        // 'blueprint' for legacy diagrams without the field). Hide those
        // that don't belong to the active layer mode — `both` shows
        // everything; `notes` / `blueprint` show only their own.
        const cLayer = c.layer ?? 'blueprint';
        if (layerMode !== 'both' && cLayer !== layerMode) return false;
        // Bound endpoints need their shape visible; floating endpoints always
        // pass. (Either-bound-and-hidden = drop the connector for this layer.)
        const fromOk = !('shape' in c.from) || visibleIds.has(c.from.shape);
        const toOk = !('shape' in c.to) || visibleIds.has(c.to.shape);
        return fromOk && toOk;
      }),
    [connectors, visibleIds, layerMode],
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedShapes = useMemo(
    () => rawShapes.filter((s) => selectedSet.has(s.id)),
    [rawShapes, selectedSet],
  );

  // interaction
  const interactionRef = useRef<Interaction>({ kind: 'idle' });
  const [preview, setPreview] = useState<Preview>(null);
  const pointerDownRef = useRef<number | null>(null);

  // laser-pointer trail state. Points fade by *distance from head* (not
  // age) while moving — head is opaque, tail fades over LASER_MAX_LEN_PX of
  // accumulated path length. When motion stops, the whole trail uniformly
  // fades over LASER_STOP_FADE_MS. The rAF loop below prunes points that are
  // both too old and beyond the visible tail.
  const [laserTrail, setLaserTrail] = useState<
    { x: number; y: number; t: number }[]
  >([]);

  // Live cursor position while the laser button is HELD. Trail points age out
  // after 700ms, so a click-and-hold-without-moving has no fresh trail to
  // anchor the leading dot to — the user would see the laser disappear
  // mid-gesture. This ref tracks the current cursor regardless of trail
  // freshness, and the render below uses it to keep the dot pinned to the
  // pointer for the entire duration of the press. Cleared on pointer-up.
  const laserCursorRef = useRef<{ x: number; y: number } | null>(null);

  // In-flight freehand pen path — repaints as points come in. Cleared on
  // pointer-up after the path is committed as a shape.
  const [penPath, setPenPath] = useState<{ x: number; y: number }[] | null>(
    null,
  );

  // Active snap-to-align guides — populated only while a shape drag is in
  // progress AND cmd/ctrl is held. Each list holds world-space coordinates
  // (vertical guides = world x values; horizontal guides = world y values).
  // Cleared on every drag start, on cmd release mid-drag, and on commit.
  // Rendered as thin accent lines spanning the current viewport.
  const [alignGuides, setAlignGuides] = useState<
    | null
    | {
        vx: number[];
        hy: number[];
      }
  >(null);

  // Containers that would adopt the dragged shape(s) — or auto-bind the
  // dragged orphan connector — if the pointer were released right now. Used
  // to paint a glow halo on those containers so the user gets a "yes, this
  // will bind" cue before they let go. The set is recomputed on every move
  // using the same overlap rule (>50% area for shapes, fully-contained for
  // orphan connectors) the commit-side adoption logic uses; rendering reads
  // straight from this set so the visual is guaranteed to track the actual
  // landing target. Cleared on commit / interaction-end.
  const [dropTargetIds, setDropTargetIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Smooth fade — drive on requestAnimationFrame while the trail is non-
  // empty, so opacity recomputes every paint and the trail melts cleanly
  // instead of step-fading at 60ms intervals. We force a re-render via a
  // monotonically increasing tick so the existing JSX re-evaluates with the
  // current `performance.now()` opacity.
  const [, setLaserTick] = useState(0);
  useEffect(() => {
    if (laserTrail.length === 0) return;
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      let pruned = false;
      setLaserTrail((trail) => {
        const fresh = trail.filter((p) => now - p.t < 700);
        if (fresh.length !== trail.length) {
          pruned = true;
          return fresh;
        }
        return trail;
      });
      // Whether we pruned or not, bump the tick so segment opacity recomputes.
      if (!pruned) setLaserTick((t) => (t + 1) % 100000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [laserTrail.length]);

  // right-click context menu state
  const [contextMenu, setContextMenu] = useState<
    | null
    | {
        x: number;
        y: number;
        target: ContextMenuTarget;
      }
  >(null);

  // hover state — drives cursor + hover ring on shapes/connectors when the
  // user is in select mode and not currently mid-gesture. We track at "what's
  // under the cursor" granularity rather than per-shape onMouseEnter, so the
  // canvas's existing hit-test plumbing is the single source of truth.
  const [hover, setHover] = useState<
    | null
    | { kind: 'shape'; id: string }
    | { kind: 'connector'; id: string }
    | { kind: 'connector-label'; id: string }
    | { kind: 'shape-handle'; id: string; handle: Handle }
    | { kind: 'connector-handle'; id: string }
  >(null);

  // Hover-edge connector affordance state machine (added 2026-04-28 v3 —
  // Josh: subtle, one button, near-edge only, 100ms hover delay, gap to
  // shape, hit zone has to span the button itself). State + refs together
  // implement the rules:
  //   - `hoverEdgeAffordance` (state) = currently visible affordance, or null
  //   - candidate ref tracks the most-recent target so timer fires with the
  //     latest value when the user keeps moving during the wait
  //   - visibleRef mirrors the state without round-tripping through React,
  //     so the updater can read "are we already showing?" synchronously
  //   - timer ref = pending 100ms debounce promotion
  // Switching between sides of the same shape is INSTANT (no second debounce)
  // because the user has already paid the dwell cost; the 100ms gate only
  // applies on first appearance.
  type EdgeAffordance = {
    shapeId: string;
    side: 'top' | 'right' | 'bottom' | 'left';
  };
  const [hoverEdgeAffordance, setHoverEdgeAffordance] =
    useState<EdgeAffordance | null>(null);
  const edgeAffordanceCandidateRef = useRef<EdgeAffordance | null>(null);
  const edgeAffordanceVisibleRef = useRef<EdgeAffordance | null>(null);
  const edgeAffordanceTimerRef = useRef<number | null>(null);

  // Mirror of `interactionRef.current.kind` so the cursor can react without
  // polling — populated by `setInteraction` below.
  const [interactionKind, setInteractionKind] =
    useState<Interaction['kind']>('idle');

  // Cleanup the edge-affordance timer on unmount — without this, a 100ms
  // promotion fired on a dead component would update React state and warn.
  useEffect(() => {
    return () => {
      if (edgeAffordanceTimerRef.current != null) {
        clearTimeout(edgeAffordanceTimerRef.current);
        edgeAffordanceTimerRef.current = null;
      }
    };
  }, []);

  /** Update the edge-affordance pipeline given the current candidate
   *  (or `null` to clear). Runs from pointermove on every frame; idempotent
   *  when the candidate hasn't changed. See the state-machine comment near
   *  the state declarations for the full rules. */
  const updateEdgeAffordance = useCallback(
    (next: EdgeAffordance | null) => {
      if (!next) {
        // Cursor left the band — clear everything immediately. No reverse
        // debounce; the user moving away is unambiguous.
        if (edgeAffordanceTimerRef.current != null) {
          clearTimeout(edgeAffordanceTimerRef.current);
          edgeAffordanceTimerRef.current = null;
        }
        edgeAffordanceCandidateRef.current = null;
        if (edgeAffordanceVisibleRef.current !== null) {
          edgeAffordanceVisibleRef.current = null;
          setHoverEdgeAffordance(null);
        }
        return;
      }
      const c = edgeAffordanceCandidateRef.current;
      if (c && c.shapeId === next.shapeId && c.side === next.side) {
        // Same candidate — nothing to do. Either the timer is still in
        // flight (will fire with this same value) or we're already showing.
        return;
      }
      edgeAffordanceCandidateRef.current = next;
      const visible = edgeAffordanceVisibleRef.current;
      if (visible) {
        // Already visible — react INSTANTLY when the candidate changes
        // (different side, different shape). The user has already paid the
        // dwell cost; making them re-wait when sliding between affordances
        // would feel laggy. Cancel any in-flight timer (defensive — there
        // shouldn't be one when visible is set, but cheap).
        if (edgeAffordanceTimerRef.current != null) {
          clearTimeout(edgeAffordanceTimerRef.current);
          edgeAffordanceTimerRef.current = null;
        }
        edgeAffordanceVisibleRef.current = next;
        setHoverEdgeAffordance(next);
        return;
      }
      // Not visible yet — schedule the 100ms promotion. Restart any
      // previous timer so the dwell measures from the LATEST candidate
      // change, not the very first one (matches Figma / draw.io feel).
      if (edgeAffordanceTimerRef.current != null) {
        clearTimeout(edgeAffordanceTimerRef.current);
      }
      edgeAffordanceTimerRef.current = window.setTimeout(() => {
        const cand = edgeAffordanceCandidateRef.current;
        if (cand) {
          edgeAffordanceVisibleRef.current = cand;
          setHoverEdgeAffordance(cand);
        }
        edgeAffordanceTimerRef.current = null;
      }, 100);
    },
    [],
  );

  /** Set the interaction in the ref AND mirror its kind into state so the
   *  cursor can update without polling. Also derives + publishes the
   *  contextual tip-toast key (see TipToast.tsx) so the bottom-of-canvas
   *  nudge tracks whatever gesture is in flight. Single source of truth for
   *  tip publishing — every gesture transition routes through here, so no
   *  call site has to remember to update the tip independently. */
  const setInteraction = useCallback(
    (i: Interaction) => {
      interactionRef.current = i;
      setInteractionKind(i.kind);
      // Whenever a gesture starts (anything other than `idle`), clear the
      // edge-affordance state machine. The visible "+" should disappear
      // during the gesture (the render gate handles that), and on the
      // following pointerup → idle we want the 100ms first-show debounce
      // to re-apply rather than instantly snapping the affordance back.
      if (i.kind !== 'idle') {
        if (edgeAffordanceTimerRef.current != null) {
          clearTimeout(edgeAffordanceTimerRef.current);
          edgeAffordanceTimerRef.current = null;
        }
        edgeAffordanceCandidateRef.current = null;
        if (edgeAffordanceVisibleRef.current !== null) {
          edgeAffordanceVisibleRef.current = null;
          setHoverEdgeAffordance(null);
        }
      }

      // Map gesture → tip. Only a subset of gestures earn a tip; the rest
      // fall through to null (no toast). When you add a tip, extend either
      // the switch below or its TipKey union in editor.ts.
      let tip: import('@/store/editor').TipKey | null = null;
      switch (i.kind) {
        case 'creating-shape': {
          // Only the basic-shape tools get the perfect-shape tip — text /
          // container / table / note don't have a "perfect" shape concept
          // (or it doesn't help — a perfect text bbox is meaningless).
          if (i.toolName === 'rect') tip = 'shift-perfect-square';
          else if (i.toolName === 'ellipse') tip = 'shift-perfect-circle';
          else if (i.toolName === 'diamond') tip = 'shift-perfect-diamond';
          break;
        }
        case 'creating-connector':
          // Both line + arrow get the disable-snap tip — same modifier
          // semantics apply to both tools mid-draw.
          tip = 'cmd-disable-snap';
          break;
        case 'drag-endpoint':
          // Repositioning an existing endpoint shares the creation flow's
          // Cmd/Ctrl-disables-snap rule — same tip applies. Published on
          // pointerdown rather than first-move because the user has already
          // committed to a gesture by grabbing the endpoint dot; there's no
          // click-to-select branch to confuse with this transition.
          tip = 'cmd-disable-snap';
          break;
        case 'dragging':
        case 'translate-connector':
          // Intentionally NULL here — `dragging` and `translate-connector`
          // start on pointerdown before the user has actually moved (a
          // plain click-to-select transitions through `dragging`). If we
          // published 'ctrl-align' on entry, every click on a shape would
          // pop the toast. The tip is published instead from pointermove
          // at the exact frame `cur.moved` flips false→true (search this
          // file for setActiveTipKey('ctrl-align')). Setting null here
          // also clears any prior tip the previous gesture left visible.
          tip = null;
          break;
        case 'rotating':
          tip = 'ctrl-snap-rotate';
          break;
        case 'create-waypoint':
        case 'drag-waypoint':
          // User is mid-bend — let them know how to remove one. Both
          // creating a fresh waypoint and dragging an existing one share
          // the same delete affordance.
          tip = 'right-click-delete-bend';
          break;
        default:
          tip = null;
      }
      setActiveTipKey(tip);
    },
    [setActiveTipKey],
  );

  const getRect = () =>
    svgRef.current?.getBoundingClientRect() ??
    ({ left: 0, top: 0, width: 0, height: 0 } as DOMRect);

  /** Pull a screen-space pointer into world coords using current pan/zoom. */
  const eventToWorld = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const screen = clientToScreen(e, getRect());
      return screenToWorld(screen, { pan, zoom });
    },
    [pan, zoom],
  );

  // hit testing
  /** Return the topmost shape under a world point. Members of a `group`
   *  resolve to their top-level group ancestor — clicking inside a group
   *  selects the whole thing, not the child. Containers behave differently:
   *  the parent walk stops at containers, so clicking a container's child
   *  selects the child (you can resize the icon in the top-left independently
   *  of the frame). The container itself is selected by clicking its empty
   *  interior.
   *
   *  Two affordances let the user reach IN to a group's members:
   *    1. `bypassGroup` — set true when the user is holding Alt/Option.
   *       Disables the group walk entirely so a click on a member returns
   *       that member, not its group ancestor. Stateless; doesn't enter
   *       any mode.
   *    2. `focusedGroupId` (read from the store) — when the user has
   *       double-clicked a group to "enter" it, the parent walk stops at
   *       that group, AND the group's frame body is excluded from the
   *       fallback frame-hit phase so clicks on its empty interior pass
   *       through to whatever's under (or to null, which the caller treats
   *       as "exit focus"). Mode-ful counterpart to alt-click. */
  const shapeUnder = useCallback(
    (p: Pt, opts?: { bypassGroup?: boolean }): ShapeT | null => {
      const bypassGroup = opts?.bypassGroup === true;
      const focusedGroupId = useEditor.getState().focusedGroupId;
      const findRoot = (sh: ShapeT): ShapeT => {
        let cur = sh;
        while (cur.parent) {
          const parent = visibleShapes.find((x) => x.id === cur.parent);
          if (!parent) break;
          // Stop at containers — children of a container are independently
          // selectable.
          if (parent.kind === 'container') break;
          // If the parent is the group the user has "entered", stop here
          // so the resolved hit is the direct child rather than the
          // focused group itself. Without this, focus mode would still
          // bubble selection up to the group.
          if (parent.kind === 'group' && parent.id === focusedGroupId) break;
          // Alt/Option-click — pierce ALL groups so the deepest member
          // resolves directly. Containers still terminate above.
          if (parent.kind === 'group' && bypassGroup) break;
          cur = parent;
        }
        return cur;
      };
      // Walk shapes in render order so hit-testing agrees with what the
      // user sees. Render sorts by `.z` ascending (see the items.sort below
      // around line ~5350), so the visually topmost shape is the LAST
      // entry in z-ascending order. Iterating raw array order is wrong:
      // bringToFront / sendToBack mutate `.z` but not array position, so
      // a "sent to back" shape is still last in `visibleShapes` and a
      // reverse-array walk wrongly resolves it on top of whatever now
      // visually covers it. Stable tiebreak on original array index keeps
      // the makeContainer-prepends-anchor case (inner container at a
      // lower index than outer) working — same as before.
      const zSorted = visibleShapes
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
          const dz = (a.s.z ?? 0) - (b.s.z ?? 0);
          return dz !== 0 ? dz : a.i - b.i;
        });
      // Topmost non-frame hit (groups and containers are frames — searched
      // last so their bodies don't win over a child sitting on top).
      for (let i = zSorted.length - 1; i >= 0; i--) {
        const s = zSorted[i].s;
        if (s.kind === 'group' || s.kind === 'container') continue;
        if (pointInShape(p, s)) return findRoot(s);
      }
      // Otherwise a frame body itself — container OR group. Picking the
      // smallest-bbox containing frame is what we actually want here: with
      // nested containers, the inner one has the smaller bbox AND is the
      // one the user is reaching for. Tiebreak by z (= top of stack) when
      // two frames are the same size — the normal "newer renders in front"
      // rule, but tracked through `.z` so it survives reorder commands.
      let bestFrame: ShapeT | null = null;
      let bestArea = Infinity;
      let bestZ = -Infinity;
      for (const { s } of zSorted) {
        if (s.kind !== 'group' && s.kind !== 'container') continue;
        if (!pointInShape(p, s)) continue;
        // The focused group's body is "transparent" to hit-testing while
        // the user is inside it: empty interior should not re-hit the
        // group (returning it would break out of the focus invariant).
        // Other groups remain clickable normally — that's how the user
        // exits focus by clicking a sibling group's body.
        if (s.kind === 'group' && s.id === focusedGroupId) continue;
        const area = Math.max(0, s.w) * Math.max(0, s.h);
        const z = s.z ?? 0;
        if (
          area < bestArea ||
          (area === bestArea && z > bestZ)
        ) {
          bestFrame = s;
          bestArea = area;
          bestZ = z;
        }
      }
      return bestFrame ? findRoot(bestFrame) : null;
    },
    [visibleShapes],
  );

  /** Locate a corner-handle hit if the user clicked near a selected shape's
   *  corner. Hits on non-selected shapes' corners do nothing — a shape needs
   *  to be selected before its handles arm.
   *
   *  Rotated shapes: the handle's un-rotated position from `handlePosition`
   *  has to be rotated AROUND THE SHAPE CENTER to land where the user
   *  actually sees it. Without this, a shape rotated 45° would have its
   *  visible NW handle in screen-space top-left but be hittable only in
   *  world-space top-left — the cursor and the handle would be visibly
   *  out of sync. */
  const handleUnder = useCallback(
    (p: Pt): { id: string; handle: Handle } | null => {
      // Hit zone radius scales inverse to zoom so handles stay clickable when
      // zoomed out. 6 world units at 1x = a 12x12 click target.
      const r = 6 / zoom;
      for (const sh of selectedShapes) {
        const rot = ((sh.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const cx = sh.x + sh.w / 2;
        const cy = sh.y + sh.h / 2;
        // Text shapes expose corner handles + the LEFT/RIGHT edge handles
        // (the latter set the wrap width — drag the e/w bar to widen or
        // narrow the box and the text re-flows). Top/bottom (n/s) edges
        // stay hidden because the only way to make a text box shorter is
        // to delete some text; a draggable edge there would lie about
        // what it does. Mirrors the SelectionOverlay filtering.
        const handleSet =
          sh.kind === 'text'
            ? (['nw', 'ne', 'sw', 'se', 'e', 'w'] as Handle[])
            : HANDLE_KINDS;
        for (const h of handleSet) {
          const hp = handlePosition(sh, h);
          // Rotate handle's un-rotated world position around (cx, cy).
          const hx = rot
            ? cx + (hp.x - cx) * cos - (hp.y - cy) * sin
            : hp.x;
          const hy = rot
            ? cy + (hp.x - cx) * sin + (hp.y - cy) * cos
            : hp.y;
          // Text shape e/w bars: the visible affordance is a TALL bar
          // (≈60% of the bbox height — see SelectionOverlay), so the hit
          // zone needs to match or the bar looks draggable end-to-end but
          // only responds in a tiny center cell. Vertical extent matches
          // the bar's height; horizontal stays at the standard radius.
          const isTextHEdge = sh.kind === 'text' && (h === 'e' || h === 'w');
          const ry = isTextHEdge ? Math.max(sh.h * 0.3, 7 / zoom) : r;
          if (
            p.x >= hx - r &&
            p.x <= hx + r &&
            p.y >= hy - ry &&
            p.y <= hy + ry
          ) {
            return { id: sh.id, handle: h };
          }
        }
      }
      return null;
    },
    [selectedShapes, zoom],
  );

  /** Locate a rotation-handle hit. The handle floats ROTATE_HANDLE_OFFSET
   *  screen-pixels above the bounding-box top edge. Visible (and hittable)
   *  for every selected shape kind that doesn't explicitly lock rotation:
   *  vendor icons set lockRotation in iconConstraints (currently false post
   *  the 2026-04-28 unlock — see VENDOR_CONSTRAINTS), and group / freehand
   *  shapes opt out because rotating their bbox doesn't rotate their
   *  un-grouped contents. Everything else — rect, ellipse, diamond, note,
   *  text, image, container, table, icon — gets the affordance.
   *
   *  CRITICAL: when a shape is already rotated, the handle has been visually
   *  rotated WITH the selection box, so its world position is the
   *  axis-aligned top-center rotated AROUND the shape center. The hit-test
   *  has to mirror that rotation or the handle would visually move with the
   *  shape but be hittable only at the un-rotated position. */
  const rotateHandleUnder = useCallback(
    (p: Pt): { id: string } | null => {
      const r = 7 / zoom; // slightly larger target than corner handles
      for (const sh of selectedShapes) {
        if (sh.kind === 'group' || sh.kind === 'freehand') continue;
        if (
          sh.kind === 'icon' &&
          sh.iconConstraints?.lockRotation === true
        ) {
          continue;
        }
        // Un-rotated handle position (top-center, offset above the bbox).
        const hx0 = sh.x + sh.w / 2;
        const hy0 = sh.y - ROTATE_HANDLE_OFFSET / zoom;
        // Shape center — the pivot for the visual rotation transform.
        const cx = sh.x + sh.w / 2;
        const cy = sh.y + sh.h / 2;
        const rot = ((sh.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const hx = cx + (hx0 - cx) * cos - (hy0 - cy) * sin;
        const hy = cy + (hx0 - cx) * sin + (hy0 - cy) * cos;
        if (
          p.x >= hx - r &&
          p.x <= hx + r &&
          p.y >= hy - r &&
          p.y <= hy + r
        ) {
          return { id: sh.id };
        }
      }
      return null;
    },
    [selectedShapes, zoom],
  );

  /** "Key points" polyline — start, waypoints, end (orthogonal also includes
   *  bend joints). Used for handle placement (one midpoint per logical
   *  segment). Curved routing returns just endpoints + waypoints so the
   *  user gets ONE midpoint affordance per section, not one per curve sample. */
  const connectorSegmentPolyline = useCallback(
    (c: ConnectorT): { x: number; y: number }[] | null => {
      const path = resolveConnectorPath(c, rawShapes);
      if (!path) return null;
      const { fx, fy, tx, ty, fromAnchor, toAnchor, fromRot, toRot } = path;
      if (c.routing === 'orthogonal') {
        // For both no-waypoints and waypoints, return the same polyline the
        // renderer draws — including the axis-aligned bends inserted between
        // diagonal waypoints. Without this, midpoint handles drift OFF the
        // visible line whenever the user has dragged a waypoint off-axis.
        if (c.waypoints && c.waypoints.length) {
          return buildOrthogonalThroughWaypoints(
            fx,
            fy,
            tx,
            ty,
            fromAnchor,
            toAnchor,
            c.waypoints,
            fromRot,
            toRot,
          );
        }
        return buildOrthogonalPolyline(
          fx,
          fy,
          tx,
          ty,
          fromAnchor,
          toAnchor,
          fromRot,
          toRot,
        );
      }
      // Curved + straight: one logical segment per gap between waypoints.
      if (c.waypoints && c.waypoints.length) {
        return [{ x: fx, y: fy }, ...c.waypoints, { x: tx, y: ty }];
      }
      return [
        { x: fx, y: fy },
        { x: tx, y: ty },
      ];
    },
    [rawShapes],
  );

  /** Dense hit-test polyline — same as `connectorSegmentPolyline` for orthogonal /
   *  straight, but curved routing fans out into curve samples so a click on
   *  the visible bulge of the line always finds a segment. The previous
   *  hit-tester walked the chord between endpoints (or the orthogonal mid-
   *  elbow for curved routing!) and missed the actual rendered geometry —
   *  that's the "clicking on a curved line is hard" bug. */
  const connectorHitPolyline = useCallback(
    (c: ConnectorT): { x: number; y: number }[] | null => {
      if (c.routing !== 'curved') return connectorSegmentPolyline(c);
      const path = resolveConnectorPath(c, rawShapes);
      if (!path) return null;
      const { fx, fy, tx, ty, fromAnchor, toAnchor, fromRot, toRot } = path;
      return sampleCurvedPolyline(
        fx,
        fy,
        tx,
        ty,
        fromAnchor,
        toAnchor,
        c.waypoints,
        fromRot,
        toRot,
      );
    },
    [connectorSegmentPolyline, rawShapes],
  );

  /** Hit-test connector handles for the *selected* connectors only. Returns
   *  whether the cursor landed on an endpoint, a real waypoint, or a midpoint.
   *  Endpoints are checked FIRST so they win over the connected shape's body
   *  — otherwise the user could never re-grab a bound endpoint. */
  const connectorHandleUnder = useCallback(
    (
      p: Pt,
    ):
      | { kind: 'endpoint'; connectorId: string; side: 'from' | 'to' }
      | { kind: 'waypoint' | 'midpoint'; connectorId: string; index: number }
      | null => {
      const r = 7 / zoom;
      const endR = 9 / zoom; // bigger target — endpoints sit on shape edges
      for (const c of visibleConnectors) {
        if (!selectedSet.has(c.id)) continue;
        // Endpoints — these sit on top of the connected shape's body, so they
        // need top priority in the hit-test stack.
        const path = resolveConnectorPath(c, rawShapes);
        if (path) {
          if (
            p.x >= path.fx - endR &&
            p.x <= path.fx + endR &&
            p.y >= path.fy - endR &&
            p.y <= path.fy + endR
          ) {
            return { kind: 'endpoint', connectorId: c.id, side: 'from' };
          }
          if (
            p.x >= path.tx - endR &&
            p.x <= path.tx + endR &&
            p.y >= path.ty - endR &&
            p.y <= path.ty + endR
          ) {
            return { kind: 'endpoint', connectorId: c.id, side: 'to' };
          }
        }
        // Real waypoints next.
        if (c.waypoints) {
          for (let i = 0; i < c.waypoints.length; i++) {
            const w = c.waypoints[i];
            if (
              p.x >= w.x - r &&
              p.x <= w.x + r &&
              p.y >= w.y - r &&
              p.y <= w.y + r
            ) {
              return { kind: 'waypoint', connectorId: c.id, index: i };
            }
          }
        }
        // Midpoints — derived from the polyline.
        const poly = connectorSegmentPolyline(c);
        if (!poly) continue;
        const midR = 5 / zoom;
        for (let i = 0; i < poly.length - 1; i++) {
          const mx = (poly[i].x + poly[i + 1].x) / 2;
          const my = (poly[i].y + poly[i + 1].y) / 2;
          if (
            p.x >= mx - midR &&
            p.x <= mx + midR &&
            p.y >= my - midR &&
            p.y <= my + midR
          ) {
            const insertIndex = waypointInsertIndex(c, i);
            return { kind: 'midpoint', connectorId: c.id, index: insertIndex };
          }
        }
      }
      return null;
    },
    [visibleConnectors, selectedSet, zoom, connectorSegmentPolyline, rawShapes],
  );

  /** Connector hit test — walks the rendered polyline (curve samples for
   *  curved routing, axis-aligned bends for orthogonal, straight for all
   *  others) and checks each segment against the cursor with a fat tolerance.
   *
   *  Uses the same polyline source as the renderer (`connectorSegmentPolyline`) so
   *  the click target always matches what the user sees. The previous version
   *  hard-coded a midpoint orthogonal split + a straight-line chord for
   *  curved — that's why curved-line clicks were unreliable. */
  const connectorUnder = useCallback(
    (p: Pt): ConnectorT | null => {
      const tol = 10 / zoom;
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        const pts = connectorHitPolyline(c);
        if (!pts || pts.length < 2) continue;
        for (let j = 1; j < pts.length; j++) {
          if (segHit(p, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y, tol)) {
            return c;
          }
        }
      }
      return null;
    },
    [visibleConnectors, connectorHitPolyline, zoom],
  );

  /** Tight-tolerance connector hit-test — used to override shape-vs-connector
   *  z tiebreaks when the click is unambiguously ON the line. The default
   *  `connectorUnder` uses a generous 10px tolerance so far-from-line clicks
   *  in the connector's "near zone" still register as connector clicks; for
   *  the override we want a tighter 4px so the rule reads as "click was
   *  literally on the line." Returns the closest connector (lowest distance)
   *  rather than just any hit, to guarantee the right one wins when several
   *  lines are stacked. */
  const connectorUnderTight = useCallback(
    (p: Pt): ConnectorT | null => {
      const tol = 4 / zoom;
      let best: ConnectorT | null = null;
      let bestD = Infinity;
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        const pts = connectorHitPolyline(c);
        if (!pts || pts.length < 2) continue;
        for (let j = 1; j < pts.length; j++) {
          const d = pointSegDist(p, pts[j - 1], pts[j]);
          if (d <= tol && d < bestD) {
            best = c;
            bestD = d;
          }
        }
      }
      return best;
    },
    [visibleConnectors, connectorHitPolyline, zoom],
  );

  /** Hit-test connector labels — returns the connector whose label rect
   *  contains the cursor. The bbox here is the same one `Connector.tsx`
   *  paints (label.length × 7 + 12 wide, 18 tall, centred on the path
   *  point at `labelPosition`). World coords throughout — no zoom math —
   *  so the hit zone exactly matches the rendered rect at every zoom level.
   *
   *  Walks back-to-front so the topmost label wins when two labels overlap.
   *  Connectors without a label or with empty labels are skipped — there's
   *  nothing to grab. */
  const connectorLabelUnder = useCallback(
    (p: Pt): ConnectorT | null => {
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        if (!c.label) continue;
        // Strip inline-markdown markers from the label before bbox math —
        // the renderer paints the plain form, so the hit area must match.
        const plain = mdToPlain(c.label);
        if (!plain) continue;
        const path = resolveConnectorPath(c, rawShapes);
        if (!path) continue;
        const poly = connectorPolyline(
          c,
          path.fx,
          path.fy,
          path.tx,
          path.ty,
          path.fromAnchor,
          path.toAnchor,
          path.fromRot,
          path.toRot,
        );
        if (poly.length < 2) continue;
        const lp = pointAtFraction(poly, c.labelPosition ?? 0.5);
        const halfW = plain.length * 3.5 + 6;
        const halfH = 9;
        if (
          p.x >= lp.x - halfW &&
          p.x <= lp.x + halfW &&
          p.y >= lp.y - halfH &&
          p.y <= lp.y + halfH
        ) {
          return c;
        }
      }
      return null;
    },
    [visibleConnectors, rawShapes],
  );

  // pointer handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Any pointer-down clears the hover state — otherwise the ring/cursor
      // can linger from before the click while we wait for the next move.
      // Functional form so we don't depend on a possibly-stale `hover` closure.
      setHover((h) => (h ? null : h));
      // Any pointer-down on the canvas dismisses an open context menu, even
      // before we run any tool logic — feels right that left-clicking anywhere
      // closes the menu without also re-running its commands.
      if (contextMenu) {
        setContextMenu(null);
        if (e.button !== 2) return;
      }
      if (e.button !== 0 && e.button !== 1) return;
      // If the inline label/body editor is open, clicking on the canvas should
      // commit-and-close it WITHOUT also starting a marquee, placing a new
      // shape, or beginning any other gesture. The contenteditable's onBlur
      // already commits when focus leaves it, but the SVG isn't focusable in
      // every browser so we proactively blur the active element. Returning
      // here prevents the rest of the tool logic from running on the same
      // pointer-down — the user is exiting the editor, not starting a new
      // interaction.
      if (
        useEditor.getState().editingShapeId ||
        useEditor.getState().editingConnectorId
      ) {
        if (typeof document !== 'undefined') {
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        return;
      }
      const world = eventToWorld(e);
      const additive = e.shiftKey;
      const marqueeModifier = e.metaKey || e.ctrlKey;
      const middleButton = e.button === 1;
      const spaceHeld = spaceHeldRef.current;
      const tool = bindings[activeTool]?.tool ?? 'select';
      // Alt/Option-held click "pierces" groups — a click on a group member
      // resolves to that member instead of bubbling up to the group ancestor.
      // Stateless (no mode), complements the double-click "enter group" path.
      const altPierce = e.altKey;

      // Pan: middle mouse OR space-drag (when not on a selected shape — that
      // path becomes connector drag-out).
      if (middleButton || (spaceHeld && tool === 'select')) {
        // Space + drag from a selected shape → connector creation.
        if (spaceHeld && !middleButton) {
          const hit = shapeUnder(world);
          if (hit && selectedSet.has(hit.id)) {
            const fromPoint = endpointAt(hit, 'auto', world, rawShapes);
            setInteraction({
              kind: 'creating-connector',
              fromShape: hit.id,
              fromAnchor: 'auto',
              fromPoint,
              current: world,
              fromShapeRaw: hit.id,
              toolName: 'select',
            });
            setPreview({
              kind: 'creating-connector',
              from: fromPoint,
              to: world,
              fromShape: hit.id,
              toShape: null,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
        }
        setInteraction({
          kind: 'panning',
          pointerStart: { x: e.clientX, y: e.clientY },
          panStart: pan,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Select tool (1) — hit test in priority: connector labels (drag along
      // line) → connector handles (waypoints, midpoints) → shape handles →
      // connectors → shapes → empty (marquee). Labels go first because they
      // can visually overlap a midpoint handle on a selected connector; the
      // user pointing at the label rect almost certainly wants to slide it,
      // not insert a waypoint.
      //
      // Alt-modifier escape hatch (added 2026-04-28): the label rect would
      // otherwise eat every click in its bbox, leaving no way to add a bend
      // on the segment of line that runs under the label. Holding Alt makes
      // the label transparent to hit-testing for this gesture so the
      // underlying midpoint handle (or fall-through paths) get the click.
      // Discoverable via the existing Alt = "pierce" muscle memory (Alt-click
      // already pierces groups elsewhere).
      if (tool === 'select') {
        // Hover-edge connector affordance hit-test. Reads from REFS / the
        // live store, NOT React state, because this useCallback's deps
        // didn't list the affordance state when this branch was added —
        // the closure would otherwise capture the stale-at-mount null and
        // every click would silently miss. The visible-ref is mutated
        // synchronously from `updateEdgeAffordance` and always reflects
        // what's actually rendered; the setting comes from the live store
        // so toggling it off mid-session takes effect on the next click
        // without needing a callback regeneration. Geometry MUST track
        // the JSX render block — same R / gap / off constants. If they
        // drift, click target and visible button decouple and the
        // affordance becomes unclickable.
        const liveAff = edgeAffordanceVisibleRef.current;
        const settingOn = useEditor.getState().hoverEdgeConnectors;
        if (
          settingOn &&
          liveAff &&
          !selectedSet.has(liveAff.shapeId)
        ) {
          const sh = rawShapes.find((s) => s.id === liveAff.shapeId);
          if (sh && sh.kind !== 'group' && sh.kind !== 'freehand') {
            const R = 6 / zoom;
            const gap = 6 / zoom;
            const off = R + gap;
            // Hit radius slightly bigger than the visible disk so a click
            // near the "+" doesn't feel picky.
            const hitR = 10 / zoom;
            const center = (() => {
              switch (liveAff.side) {
                case 'top':
                  return { cx: sh.x + sh.w / 2, cy: sh.y - off };
                case 'right':
                  return { cx: sh.x + sh.w + off, cy: sh.y + sh.h / 2 };
                case 'bottom':
                  return { cx: sh.x + sh.w / 2, cy: sh.y + sh.h + off };
                case 'left':
                  return { cx: sh.x - off, cy: sh.y + sh.h / 2 };
              }
            })();
            // The visible button is rotated WITH the shape (the JSX block
            // wraps it in `rotate(rotation cx cy)`). Inverse-rotate the
            // cursor into the un-rotated frame instead of rotating the
            // button centre — one trig pass per click.
            const rot = sh.rotation ?? 0;
            let testX = world.x;
            let testY = world.y;
            if (rot && Number.isFinite(rot)) {
              const cx = sh.x + sh.w / 2;
              const cy = sh.y + sh.h / 2;
              const rad = (-rot * Math.PI) / 180;
              const cs = Math.cos(rad);
              const sn = Math.sin(rad);
              const vx = world.x - cx;
              const vy = world.y - cy;
              testX = cx + vx * cs - vy * sn;
              testY = cy + vx * sn + vy * cs;
            }
            const dx = testX - center.cx;
            const dy = testY - center.cy;
            if (dx * dx + dy * dy <= hitR * hitR) {
              const anchor = liveAff.side;
              const fromPoint = endpointAt(sh, anchor, world, rawShapes);
              setInteraction({
                kind: 'creating-connector',
                fromShape: sh.id,
                fromAnchor: anchor,
                fromPoint,
                current: world,
                fromShapeRaw: sh.id,
                // 'select' tool name lets the up-handler reuse the same
                // semantics the space-drag connector path already
                // validated — arrowhead defaults from
                // lastConnectorStyle, no tool switch on commit.
                toolName: 'select',
              });
              setPreview({
                kind: 'creating-connector',
                from: fromPoint,
                to: world,
                fromShape: sh.id,
                toShape: null,
              });
              (e.target as Element).setPointerCapture?.(e.pointerId);
              pointerDownRef.current = e.pointerId;
              return;
            }
          }
        }

        const labelHit = e.altKey ? null : connectorLabelUnder(world);
        if (labelHit) {
          // History is committed at pointerUp on moved — same pattern as
          // drag-waypoint / translate-connector elsewhere in this file —
          // so a click that doesn't actually move the label doesn't dirty
          // the undo stack.
          setInteraction({
            kind: 'dragging-connector-label',
            connectorId: labelHit.id,
            startFraction: labelHit.labelPosition ?? 0.5,
            moved: false,
          });
          // Selecting the connector at the same time so the inspector +
          // selection ring track the user's focus during the drag.
          setSelected(labelHit.id);
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        const wpHit = connectorHandleUnder(world);
        if (wpHit) {
          if (wpHit.kind === 'endpoint') {
            // Drag a connector endpoint — lets the user re-bind it to a
            // different shape or float it free.
            setInteraction({
              kind: 'drag-endpoint',
              connectorId: wpHit.connectorId,
              side: wpHit.side,
              moved: false,
            });
          } else if (wpHit.kind === 'waypoint') {
            // Drag an existing waypoint.
            setInteraction({
              kind: 'drag-waypoint',
              connectorId: wpHit.connectorId,
              index: wpHit.index,
              moved: false,
            });
          } else {
            // Midpoint — defer waypoint creation until the user moves; that
            // way a click on a midpoint doesn't dirty the diagram.
            setInteraction({
              kind: 'create-waypoint',
              connectorId: wpHit.connectorId,
              insertIndex: wpHit.index,
              pointerStart: world,
              committed: false,
            });
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        // Rotation handle takes priority over the resize handles because it
        // sits ABOVE the bounding box — its hit zone never overlaps a corner
        // or edge handle, but checking it first means we never accidentally
        // pick up a resize when the user is clearly aiming for the rotate
        // affordance floating above the icon.
        const rotHit = rotateHandleUnder(world);
        if (rotHit) {
          const sh = rawShapes.find((s) => s.id === rotHit.id);
          if (sh) {
            const cx = sh.x + sh.w / 2;
            const cy = sh.y + sh.h / 2;
            const startAngle =
              (Math.atan2(world.y - cy, world.x - cx) * 180) / Math.PI;
            // For containers, gather every descendant (recursive — a container
            // can hold a group, an inner container, etc., so a single
            // parent === id sweep would miss grand-children) and snapshot its
            // start geometry. The live tick uses these to orbit each
            // descendant's centre around (cx, cy) by the gesture delta and
            // add the same delta to its own rotation field, producing a
            // rigid-body rotation of the whole subtree. Other rotatable kinds
            // (rect, ellipse, icon, etc.) don't host children — empty array.
            const subtreeSnapshot: {
              id: string;
              cx: number;
              cy: number;
              w: number;
              h: number;
              startRotation: number;
            }[] = [];
            if (sh.kind === 'container') {
              const subtreeIds = new Set<string>([sh.id]);
              let added = true;
              while (added) {
                added = false;
                for (const ds of rawShapes) {
                  if (
                    ds.parent &&
                    subtreeIds.has(ds.parent) &&
                    !subtreeIds.has(ds.id)
                  ) {
                    subtreeIds.add(ds.id);
                    added = true;
                  }
                }
              }
              for (const ds of rawShapes) {
                if (ds.id === sh.id) continue; // The container itself —
                // tracked separately via startRotation, not here.
                if (!subtreeIds.has(ds.id)) continue;
                subtreeSnapshot.push({
                  id: ds.id,
                  cx: ds.x + ds.w / 2,
                  cy: ds.y + ds.h / 2,
                  w: ds.w,
                  h: ds.h,
                  startRotation: ds.rotation ?? 0,
                });
              }
            }
            setInteraction({
              kind: 'rotating',
              id: sh.id,
              cx,
              cy,
              startRotation: sh.rotation ?? 0,
              pointerStartAngle: startAngle,
              descendants: subtreeSnapshot,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
        }

        const handleHit = handleUnder(world);
        if (handleHit) {
          // Multi-shape resize branch (added 2026-04-28). When more than
          // one shape is selected, any handle the user grabs scales the
          // whole selection from its union bbox — same scale-all behaviour
          // groups already had, generalised to ad-hoc multi-selection.
          // Single-shape selections fall through to the regular resize
          // path so its existing per-kind specialisations (text-shape
          // wrap/fit modes, container-as-translate, group-as-scale) keep
          // working.
          if (selectedIds.length > 1 && selectedSet.has(handleHit.id)) {
            // Compute union bbox of every selected shape that resolves —
            // marquee selection occasionally points at a stale id post-
            // delete; ignore those rather than crash.
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            const childrenStart = new Map<
              string,
              { x: number; y: number; w: number; h: number; fontSize?: number }
            >();
            for (const id of selectedIds) {
              const m = rawShapes.find((s) => s.id === id);
              if (!m) continue;
              minX = Math.min(minX, m.x);
              minY = Math.min(minY, m.y);
              maxX = Math.max(maxX, m.x + m.w);
              maxY = Math.max(maxY, m.y + m.h);
              childrenStart.set(id, {
                x: m.x,
                y: m.y,
                w: m.w,
                h: m.h,
                fontSize: m.fontSize,
              });
            }
            if (Number.isFinite(minX)) {
              setInteraction({
                kind: 'resizing-multi',
                handle: handleHit.handle,
                pointerStart: world,
                startUnion: {
                  x: minX,
                  y: minY,
                  w: maxX - minX,
                  h: maxY - minY,
                },
                childrenStart,
              });
              (e.target as Element).setPointerCapture?.(e.pointerId);
              pointerDownRef.current = e.pointerId;
              return;
            }
          }
          const sh = rawShapes.find((s) => s.id === handleHit.id)!;
          // For groups + containers, snapshot every descendant's geometry so
          // we can rescale (groups) or translate (containers) them in
          // pointermove without compounding rounding error each frame.
          const childMode: 'group' | 'container' | undefined =
            sh.kind === 'group'
              ? 'group'
              : sh.kind === 'container'
                ? 'container'
                : undefined;
          let childrenStart:
            | Map<string, { x: number; y: number; w: number; h: number }>
            | undefined;
          if (childMode) {
            childrenStart = new Map();
            // Walk descendants — direct children plus children-of-groups.
            // `parent` chains are shallow today (no nested groups in the UI)
            // but the BFS is cheap and stays correct if that changes.
            const open: string[] = [sh.id];
            const seen = new Set<string>([sh.id]);
            while (open.length) {
              const next = open.shift()!;
              for (const c of rawShapes) {
                if (c.parent === next && !seen.has(c.id)) {
                  seen.add(c.id);
                  childrenStart.set(c.id, {
                    x: c.x,
                    y: c.y,
                    w: c.w,
                    h: c.h,
                  });
                  open.push(c.id);
                }
              }
            }
          }
          // For containers, snapshot the anchor child id (translates with
          // resize) and the union bbox of all NON-anchor children (the
          // min-size floor — the container can't shrink past this).
          let anchorChildId: string | undefined;
          let containerMinBox:
            | { minX: number; minY: number; maxX: number; maxY: number }
            | undefined;
          if (childMode === 'container' && childrenStart) {
            anchorChildId = sh.anchorId;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const [cid, cs] of childrenStart) {
              if (cid === anchorChildId) continue;
              minX = Math.min(minX, cs.x);
              minY = Math.min(minY, cs.y);
              maxX = Math.max(maxX, cs.x + cs.w);
              maxY = Math.max(maxY, cs.y + cs.h);
            }
            if (Number.isFinite(minX)) {
              containerMinBox = { minX, minY, maxX, maxY };
            }
          }
          setInteraction({
            kind: 'resizing',
            id: handleHit.id,
            handle: handleHit.handle,
            pointerStart: world,
            // Snapshot fontSize too — text-shape corner-drag scales typeface
            // along with bbox, and reading the live fontSize each move would
            // compound the per-move scale into runaway font growth.
            startGeom: { x: sh.x, y: sh.y, w: sh.w, h: sh.h, fontSize: sh.fontSize },
            childrenStart,
            childMode,
            anchorChildId,
            containerMinBox,
          });
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        // Hit-test both shapes and connectors up front so we can resolve
        // overlap by z-order. The previous "shape always wins" rule made
        // arrows passing through a shape's bbox impossible to grab — the
        // shape would intercept the click even when the cursor was right on
        // the line.
        //
        // Tiebreak rules:
        //   1. If the click is TIGHTLY on the connector (< 4px world units),
        //      the connector wins regardless of z. Elbow connectors hug
        //      shape edges via their stubs, so the first ~18px of the line
        //      is inside the source shape's AABB; without this rule, those
        //      clicks always go to the shape and the line is unselectable
        //      near its endpoints.
        //   2. Otherwise tie-break by z-order — the visually-on-top item
        //      wins (existing behaviour).
        const shapeHit = shapeUnder(world, { bypassGroup: altPierce });
        const tightConnHit = shapeHit ? connectorUnderTight(world) : null;
        const connHitForOverlap = tightConnHit ?? connectorUnder(world);
        // Focus-mode bookkeeping: if the user is "inside" a group and the
        // click resolves to something outside that group's subtree (or to
        // empty canvas), exit focus before running normal selection logic.
        // We compute this once up front so every selection branch below
        // (shape, connector, marquee) inherits the exit behaviour without
        // having to repeat the check.
        const focusedGroupId = useEditor.getState().focusedGroupId;
        if (focusedGroupId) {
          const isInsideFocusedGroup = (id: string | null | undefined) => {
            if (!id) return false;
            if (id === focusedGroupId) return true;
            let cur: ShapeT | undefined = rawShapes.find((s) => s.id === id);
            while (cur?.parent) {
              if (cur.parent === focusedGroupId) return true;
              cur = rawShapes.find((s) => s.id === cur!.parent);
            }
            return false;
          };
          // shapeHit null = empty interior of focused group OR truly empty
          // canvas. Either way, leave focus mode — clicks outside the
          // group's children should feel like a clean exit.
          const hitId = shapeHit?.id ?? null;
          const connId = connHitForOverlap?.id ?? null;
          const stillInside =
            (hitId && isInsideFocusedGroup(hitId)) ||
            // Connector counts as "inside" if either endpoint binds to a
            // shape inside the focused group. Floating-only connectors
            // can't be reasoned about geometrically here without more
            // work, so we treat them as outside (safe default — exits
            // focus, which is the conservative behaviour).
            (connId &&
              (() => {
                const c = visibleConnectors.find((x) => x.id === connId);
                if (!c) return false;
                const fromShape = 'shape' in c.from ? c.from.shape : null;
                const toShape = 'shape' in c.to ? c.to.shape : null;
                return (
                  isInsideFocusedGroup(fromShape) ||
                  isInsideFocusedGroup(toShape)
                );
              })());
          if (!stillInside) {
            useEditor.getState().setFocusedGroup(null);
          }
        }
        if (shapeHit && connHitForOverlap) {
          const sz = shapeHit.z ?? 0;
          const cz = connHitForOverlap.z ?? 0;
          // Tight-hit override: connector ALWAYS wins when the click is
          // unambiguously on the line, even if the shape sits visually
          // above. Otherwise normal z tiebreak.
          if (tightConnHit || cz >= sz) {
            // Connector wins. Run the same selection / drag-or-bend flow as
            // the dedicated connectorUnder branch below.
            const c = connHitForOverlap;
            if (selectedSet.has(c.id)) {
              const fromFloating = !('shape' in c.from);
              const toFloating = !('shape' in c.to);
              if (fromFloating && toFloating) {
                const fromStart = {
                  x: (c.from as { x: number; y: number }).x,
                  y: (c.from as { x: number; y: number }).y,
                };
                const toStart = {
                  x: (c.to as { x: number; y: number }).x,
                  y: (c.to as { x: number; y: number }).y,
                };
                setInteraction({
                  kind: 'translate-connector',
                  connectorId: c.id,
                  pointerStart: world,
                  fromStart,
                  toStart,
                  waypointStarts: (c.waypoints ?? []).map((w) => ({
                    x: w.x,
                    y: w.y,
                  })),
                  moved: false,
                });
                (e.target as Element).setPointerCapture?.(e.pointerId);
                pointerDownRef.current = e.pointerId;
                return;
              }
              const insertIndex = segmentIndexAt(c, world, rawShapes);
              setInteraction({
                kind: 'create-waypoint',
                connectorId: c.id,
                insertIndex,
                pointerStart: world,
                committed: false,
              });
              (e.target as Element).setPointerCapture?.(e.pointerId);
              pointerDownRef.current = e.pointerId;
              return;
            }
            if (additive) {
              toggleSelected(c.id);
            } else {
              setSelected(c.id);
            }
            return;
          }
          // Shape's z is higher than the connector's — the shape is visually
          // on top, so the user wanting to grab the line behind it would be
          // surprising. Fall through to the shape branch below.
        }
        if (shapeHit) {
          // Click selects (or toggles); drag moves all selected.
          let nextSelection = selectedIds;
          // True when the user clicked a frame (container/group) whose
          // body was about to hijack a multi-selection of its
          // descendants. We keep the selection AND make the drag
          // operate on those descendants instead of the frame. See the
          // logic block below where this flips to true.
          let dragOverridesFrame = false;
          if (additive) {
            if (selectedSet.has(shapeHit.id)) {
              nextSelection = selectedIds.filter((i) => i !== shapeHit.id);
            } else {
              nextSelection = [...selectedIds, shapeHit.id];
            }
          } else if (!selectedSet.has(shapeHit.id)) {
            // Don't hijack a multi-selection of this frame's descendants.
            // If the user marquee-selected several children of a container
            // and then clicks the container's body to drag them, the
            // default "click replaces selection" behaviour would wipe the
            // marquee and leave only the container selected — the
            // children couldn't be dragged together. Detect that case
            // (frame hit + non-empty selection + every selected shape is
            // a descendant of this frame) and keep the existing
            // selection so the drag operates on the marquee instead. We
            // only apply this for frames (container/group) — for normal
            // shapes the click-replaces semantics is what users expect.
            const isFrame =
              shapeHit.kind === 'container' || shapeHit.kind === 'group';
            const allSelectedAreDescendants =
              isFrame &&
              selectedIds.length > 0 &&
              selectedIds.every((id) => {
                let cur = rawShapes.find((s) => s.id === id);
                while (cur?.parent) {
                  if (cur.parent === shapeHit.id) return true;
                  cur = rawShapes.find((s) => s.id === cur!.parent);
                }
                return false;
              });
            if (allSelectedAreDescendants) {
              // Stash a flag downstream code (baseDragIds builder) reads
              // to know the drag should run on the preserved selection,
              // not on the frame the click landed on. We can't just
              // check `nextSelection.includes(shapeHit.id)` later
              // because shapeHit (the frame) was deliberately NOT added
              // to the selection.
              dragOverridesFrame = true;
            } else {
              nextSelection = [shapeHit.id];
            }
          }
          if (nextSelection !== selectedIds) {
            setSelected(nextSelection);
          }
          // Build the world-start map from the FINAL selection (after any
          // mutation above) so single-click-and-drag works on a fresh shape.
          // Expand any selected groups OR containers to include their
          // descendant members so dragging a frame drags the children with
          // it. Walk transitively in case a group contains a group/container.
          //
          // Three branches in priority order:
          //   1. Frame click that preserved a descendant selection — drag
          //      runs on the preserved selection (the children the user
          //      marqueed), NOT on the frame they happened to click. The
          //      frame itself isn't in the selection and shouldn't move.
          //   2. shapeHit is in the (post-toggle) selection — drag the
          //      whole selection together.
          //   3. Otherwise — drag just shapeHit (lone replace-click).
          const baseDragIds = dragOverridesFrame
            ? nextSelection
            : nextSelection.includes(shapeHit.id)
              ? nextSelection
              : [shapeHit.id];
          const dragIdSet = new Set<string>(baseDragIds);
          let added = true;
          while (added) {
            added = false;
            for (const m of rawShapes) {
              if (m.parent && dragIdSet.has(m.parent) && !dragIdSet.has(m.id)) {
                const parentShape = rawShapes.find((r) => r.id === m.parent);
                if (
                  parentShape?.kind === 'group' ||
                  parentShape?.kind === 'container'
                ) {
                  dragIdSet.add(m.id);
                  added = true;
                }
              }
            }
          }
          // Filter the drag set to ids that resolve to a real shape. The
          // selection can include connector ids when the marquee captures
          // them alongside their bound shapes — but the shape-drag flow
          // only knows how to translate shapes, and connectors with bound
          // endpoints follow their shapes naturally as those shapes move.
          // Without this filter, `cur.ids` carried connector ids while
          // `cur.worldStart` only had shape entries, so pointermove blew
          // up on `worldStart.get(connectorId)!.x` (undefined.x) on the
          // first connector encountered and the drag silently no-op'd.
          //
          // Connectors aren't translated alongside shapes here, but their
          // waypoints + floating endpoints DO need to be carried by the
          // same dx/dy delta — otherwise bends stay glued to world-space
          // while the rest of the selection slides. Snapshot those here so
          // pointermove can apply the translation each frame.
          const dragShapeIds: string[] = [];
          const startMap = new Map<string, { x: number; y: number }>();
          const connectorTranslates: Array<{
            id: string;
            fromStart?: { x: number; y: number };
            toStart?: { x: number; y: number };
            waypointStarts: { x: number; y: number }[];
          }> = [];
          for (const id of dragIdSet) {
            const s = rawShapes.find((r) => r.id === id);
            if (s) {
              dragShapeIds.push(id);
              startMap.set(id, { x: s.x, y: s.y });
              continue;
            }
            const c = connectors.find((c) => c.id === id);
            if (!c) continue;
            const fromFloating = !('shape' in c.from);
            const toFloating = !('shape' in c.to);
            const wps = c.waypoints ?? [];
            // Bound-only, no-waypoint connectors have nothing to translate;
            // skip the bookkeeping. Their endpoints already follow shapes.
            if (!fromFloating && !toFloating && wps.length === 0) continue;
            connectorTranslates.push({
              id: c.id,
              fromStart: fromFloating
                ? {
                    x: (c.from as { x: number; y: number }).x,
                    y: (c.from as { x: number; y: number }).y,
                  }
                : undefined,
              toStart: toFloating
                ? {
                    x: (c.to as { x: number; y: number }).x,
                    y: (c.to as { x: number; y: number }).y,
                  }
                : undefined,
              waypointStarts: wps.map((w) => ({ x: w.x, y: w.y })),
            });
          }
          setInteraction({
            kind: 'dragging',
            ids: dragShapeIds,
            pointerStart: world,
            worldStart: startMap,
            connectorTranslates,
            moved: false,
          });
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        const connHit = connectorUnder(world);
        if (connHit) {
          if (selectedSet.has(connHit.id)) {
            // Drag on body of a selected connector:
            //   both endpoints floating → TRANSLATE the whole line.
            //   any endpoint shape-bound → BEND at the click position
            //     (translation doesn't make sense when one end is anchored).
            const fromFloating = !('shape' in connHit.from);
            const toFloating = !('shape' in connHit.to);
            if (fromFloating && toFloating) {
              const fromStart = { x: (connHit.from as { x: number; y: number }).x, y: (connHit.from as { x: number; y: number }).y };
              const toStart = { x: (connHit.to as { x: number; y: number }).x, y: (connHit.to as { x: number; y: number }).y };
              setInteraction({
                kind: 'translate-connector',
                connectorId: connHit.id,
                pointerStart: world,
                fromStart,
                toStart,
                waypointStarts: (connHit.waypoints ?? []).map((w) => ({ x: w.x, y: w.y })),
                moved: false,
              });
              (e.target as Element).setPointerCapture?.(e.pointerId);
              pointerDownRef.current = e.pointerId;
              return;
            }
            const insertIndex = segmentIndexAt(connHit, world, rawShapes);
            setInteraction({
              kind: 'create-waypoint',
              connectorId: connHit.id,
              insertIndex,
              pointerStart: world,
              committed: false,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
          if (additive) {
            toggleSelected(connHit.id);
          } else {
            setSelected(connHit.id);
          }
          return;
        }

        // Empty space with the select tool:
        //   left drag                 → marquee select (replace)
        //   shift + drag              → marquee additive
        //   ⌘/⌃ + drag                → marquee additive variant (still
        //                               replaces selection)
        //   middle-mouse              → pan (handled in the middleButton
        //                               branch above)
        void marqueeModifier;
        setInteraction({
          kind: 'marquee',
          start: world,
          current: world,
          additive,
        });
        setPreview({
          kind: 'marquee',
          rect: { x: world.x, y: world.y, w: 0, h: 0 },
          shapeIds: [],
          connectorIds: [],
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Creation tools — rect, ellipse, diamond, text, note.
      // Text supports both bare click (drop a default-sized box and edit) and
      // drag (size a custom box). Both paths use `creating-shape` so pointer-up
      // can decide which one happened based on movement.
      const def = bindings[activeTool];
      const treatAsShape =
        toolCreatesShape(tool) || (def?.custom === true && tool !== 'empty');
      if (treatAsShape) {
        setInteraction({
          kind: 'creating-shape',
          toolName: tool,
          start: world,
          current: world,
        });
        setPreview({
          kind: 'creating-shape',
          rect: { x: world.x, y: world.y, w: 0, h: 0 },
          toolName: tool,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Laser pointer — does NOT write to the diagram. Pointer movement
      // appends to a fading trail in component state.
      if (tool === 'laser') {
        setInteraction({ kind: 'laser' });
        laserCursorRef.current = { x: world.x, y: world.y };
        setLaserTrail((trail) => [...trail, { x: world.x, y: world.y, t: performance.now() }]);
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Freehand pen — collect points; on release, commit as a `freehand`
      // shape with a polyline.
      if (tool === 'pen') {
        setInteraction({ kind: 'pen', points: [{ x: world.x, y: world.y }] });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Connector tools (arrow, line) — drag-to-draw flow (excalidraw style).
      // Pointer down starts the line, pointer move stretches it, pointer up
      // commits. Endpoints can either bind to a shape under the cursor or
      // float free. Holding cmd/ctrl AT THE INITIAL CLICK bypasses the
      // from-side snap so the user can draw lines over a shape without
      // binding to it. (cmd/ctrl is now a *hold* gate at every check, not
      // a sticky latch — releasing it mid-drag re-engages snapping.)
      //
      // Source-snap is *edge-only*: a pointer-down inside the EDGE_SNAP_BAND
      // around any edge of a shape binds the from-side; a click deeper
      // inside the body draws an orphaned line over the shape without
      // binding. This lets the user draw a line through the middle of a
      // shape ("annotate this rect with an arrow that crosses it") without
      // having to hold cmd/ctrl every time. Cmd/ctrl still works as the
      // explicit "no-snap, even on edges" override.
      if (toolCreatesConnector(tool)) {
        // Cmd/Ctrl = disable snapping for line/arrow draws. (Briefly rebound
        // to Shift on 2026-04-28 to avoid the cross-gesture collision with
        // shape-drag align-snap, but reverted the same day: the muscle memory
        // for "Cmd to draw freely over a shape" matters more than the inter-
        // gesture symmetry, and users wanted the same modifier they hold to
        // disable snapping on endpoint-reposition.)
        const noSnap = e.metaKey || e.ctrlKey;
        const candidate = noSnap ? null : shapeUnder(world, { bypassGroup: true });
        const onEdge = candidate
          ? pointInShapeEdgeBand(world, candidate, EDGE_SNAP_BAND)
          : false;
        // From-side fight-snap: clicking dead-centre in a shape's centre
        // zone binds the connector's from-end to that shape's [0.5, 0.5].
        // Mirrors the to-side fight-snap on release. Without this, the
        // user could only start a connector from a perimeter (edge band)
        // — they had to draw inward from the edge, never outward from
        // the centre. Edge-band still wins over centre-zone for the
        // small overlap region near a tiny shape's middle (the centre
        // check itself rejects shapes too small for both zones to coexist).
        const inCenter =
          candidate && !onEdge
            ? pointInShapeCenterZone(world, candidate, EDGE_SNAP_BAND)
            : false;
        const hit = candidate && (onEdge || inCenter) ? candidate : null;
        const fromAnchor: Anchor = hit && inCenter && !onEdge ? [0.5, 0.5] : 'auto';
        const fromShape = hit ? hit.id : null;
        const fromPoint = hit
          ? endpointAt(hit, fromAnchor, world, rawShapes)
          : world;
        // `fromShapeRaw` records the shape under the click even when the
        // edge-band / centre-zone binding declined to fire — used by the
        // to-side snap to recognise an "annotation drawn inside one
        // shape" gesture and skip binding the to-end onto the same shape.
        setInteraction({
          kind: 'creating-connector',
          fromShape,
          fromAnchor,
          fromPoint,
          current: world,
          fromShapeRaw: candidate?.id ?? null,
          toolName: tool === 'line' ? 'line' : 'arrow',
        });
        setPreview({
          kind: 'creating-connector',
          from: fromPoint,
          to: world,
          fromShape,
          toShape: null,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }
    },
    [
      activeTool,
      bindings,
      eventToWorld,
      pan,
      shapeUnder,
      handleUnder,
      connectorUnder,
      rawShapes,
      selectedIds,
      selectedSet,
      setSelected,
      toggleSelected,
      addConnector,
      toolLock,
      setActiveTool,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Always update the cursor tracker so the paste-at-cursor + library-
      // drop logic has a fresh world position even when no gesture is active.
      cursorWorldRef.current = eventToWorld(e);
      const cur = interactionRef.current;
      if (cur.kind === 'idle') {
        // Hover tracking — only meaningful in select mode; other tools have
        // their own affordances (crosshair) and the cursor would conflict.
        const tool = bindings[activeTool]?.tool ?? 'select';
        if (tool !== 'select') {
          // Functional form — `hover` in this closure can be stale because
          // it isn't in the useCallback deps; reading via the setter avoids
          // the "ring stays after switching to a non-select tool" glitch.
          setHover((h) => (h ? null : h));
          updateEdgeAffordance(null);
          return;
        }
        const world = eventToWorld(e);
        // Edge-affordance candidate runs INDEPENDENTLY of the regular hover
        // branches below — the user might be on blank canvas just outside a
        // shape's edge (so no shape hit) and the affordance should still
        // fire. Compute first so the state-machine update isn't bypassed by
        // an early `return` in one of the branches further down.
        if (hoverEdgeConnectors) {
          // Trigger band: how far (perpendicular distance) the cursor can
          // be from an edge before the affordance candidate fires. Has to
          // cover everything from "just inside the edge" to "past the far
          // side of the visible button" so the cursor never escapes the
          // band while moving toward the "+".
          //
          // Geometry: button centre sits at (edge + R + gap) = edge + 12,
          // hit radius extends ±10 around centre, so the cursor reaches up
          // to 22 px from the edge while still inside the click zone. 24
          // px band gives a small forgiveness margin past that.
          //
          // Inside the shape body BEYOND this band → no affordance, which
          // is the user's "near the edge, not on the shape itself" rule.
          // For small shapes (< 48 px on the smaller axis) every interior
          // pixel falls inside the band of some edge — the affordance
          // shows whenever the cursor is over the shape, which is fine
          // because there's no "deep middle" to speak of.
          const band = 24 / zoom;
          let best:
            | {
                shapeId: string;
                side: 'top' | 'right' | 'bottom' | 'left';
                d: number;
              }
            | null = null;
          for (let i = visibleShapes.length - 1; i >= 0; i--) {
            const s = visibleShapes[i];
            if (s.kind === 'group' || s.kind === 'freehand') continue;
            if (selectedSet.has(s.id)) continue;
            // Axis-aligned bbox edges. Clamp the perpendicular axis to the
            // segment span, take the perpendicular distance.
            const cxClamp = Math.max(s.x, Math.min(s.x + s.w, world.x));
            const cyClamp = Math.max(s.y, Math.min(s.y + s.h, world.y));
            const dTop = Math.hypot(world.x - cxClamp, world.y - s.y);
            const dBottom = Math.hypot(
              world.x - cxClamp,
              world.y - (s.y + s.h),
            );
            const dLeft = Math.hypot(world.x - s.x, world.y - cyClamp);
            const dRight = Math.hypot(
              world.x - (s.x + s.w),
              world.y - cyClamp,
            );
            const sides = [
              { side: 'top' as const, d: dTop },
              { side: 'right' as const, d: dRight },
              { side: 'bottom' as const, d: dBottom },
              { side: 'left' as const, d: dLeft },
            ];
            for (const cand of sides) {
              if (cand.d > band) continue;
              if (!best || cand.d < best.d) {
                best = { shapeId: s.id, side: cand.side, d: cand.d };
              }
            }
          }
          updateEdgeAffordance(
            best ? { shapeId: best.shapeId, side: best.side } : null,
          );
        } else {
          // Setting toggled off mid-session — clear stale state.
          updateEdgeAffordance(null);
        }
        const handleHit = handleUnder(world);
        if (handleHit) {
          setHover((h) =>
            h && h.kind === 'shape-handle' && h.id === handleHit.id && h.handle === handleHit.handle
              ? h
              : { kind: 'shape-handle', id: handleHit.id, handle: handleHit.handle },
          );
          return;
        }
        // Connector labels — checked before connector handles to match the
        // pointerdown priority. Without this, hovering over a label that
        // overlaps a midpoint handle would show the handle's grabbing ring
        // even though the imminent click slides the label, not the line.
        const labelHover = connectorLabelUnder(world);
        if (labelHover) {
          setHover((h) =>
            h && h.kind === 'connector-label' && h.id === labelHover.id
              ? h
              : { kind: 'connector-label', id: labelHover.id },
          );
          return;
        }
        const connHandle = connectorHandleUnder(world);
        if (connHandle) {
          setHover((h) =>
            h && h.kind === 'connector-handle' && h.id === connHandle.connectorId
              ? h
              : { kind: 'connector-handle', id: connHandle.connectorId },
          );
          return;
        }
        // Resolve shape vs connector overlap by z-order + tight-hit override
        // — same rule as the pointerdown hit-test. Without this the cursor
        // would say "grab" (shape) even when the user is sitting right on a
        // connector that crosses the shape, and they'd be confused why the
        // click didn't grab the line.
        // Mirror the pointerdown bypass on hover so the ring shows what the
        // imminent click would actually select — Alt-held cursor highlights
        // the deepest member, plain cursor highlights the group.
        const shapeHit = shapeUnder(world, { bypassGroup: e.altKey });
        const tightHover = shapeHit ? connectorUnderTight(world) : null;
        const connHit = tightHover ?? connectorUnder(world);
        if (shapeHit && connHit) {
          const sz = shapeHit.z ?? 0;
          const cz = connHit.z ?? 0;
          if (tightHover || cz >= sz) {
            setHover((h) =>
              h && h.kind === 'connector' && h.id === connHit.id
                ? h
                : { kind: 'connector', id: connHit.id },
            );
            return;
          }
        }
        if (shapeHit) {
          setHover((h) =>
            h && h.kind === 'shape' && h.id === shapeHit.id ? h : { kind: 'shape', id: shapeHit.id },
          );
          return;
        }
        if (connHit) {
          setHover((h) =>
            h && h.kind === 'connector' && h.id === connHit.id ? h : { kind: 'connector', id: connHit.id },
          );
          return;
        }
        // Cursor is over blank canvas — clear any lingering hover. Functional
        // form because `hover` from this closure is stale (not in deps), which
        // is the root cause of the sticky-hover-ring + stuck-cursor bug.
        setHover((h) => (h ? null : h));
        return;
      }

      if (cur.kind === 'panning') {
        const dx = e.clientX - cur.pointerStart.x;
        const dy = e.clientY - cur.pointerStart.y;
        setPan({ x: cur.panStart.x + dx, y: cur.panStart.y + dy });
        return;
      }

      const world = eventToWorld(e);

      if (cur.kind === 'creating-shape') {
        // Shift-constrain — for the primitive shape tools (rect/ellipse/
        // diamond), holding shift locks the drag to a 1:1 aspect ratio so the
        // user gets a perfect square / circle / equilateral diamond. We use
        // the LARGER of |dx|/|dy| so the drag never visually shrinks when the
        // modifier is engaged (matches Illustrator/Figma muscle memory).
        // The unconstrained world point is still stashed so that releasing
        // shift mid-drag returns to free-aspect immediately.
        const constrainSquare =
          e.shiftKey &&
          (cur.toolName === 'rect' ||
            cur.toolName === 'ellipse' ||
            cur.toolName === 'diamond');
        let cx = world.x;
        let cy = world.y;
        if (constrainSquare) {
          const dx = world.x - cur.start.x;
          const dy = world.y - cur.start.y;
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          cx = cur.start.x + (dx >= 0 ? size : -size);
          cy = cur.start.y + (dy >= 0 ? size : -size);
        }
        const r = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cx - cur.start.x,
          h: cy - cur.start.y,
        });
        cur.current = world;
        setPreview({ kind: 'creating-shape', rect: r, toolName: cur.toolName });
        return;
      }

      if (cur.kind === 'creating-connector') {
        cur.current = world;
        // HOLD-only no-snap on Cmd/Ctrl. Releasing the modifier mid-drag
        // immediately re-engages snapping; tapping it briefly doesn't latch.
        const noSnap = e.metaKey || e.ctrlKey;

        // Resolve the live FROM point. While noSnap is held, treat a from-
        // shape as floating so the preview reads true to what'll commit.
        let from: { x: number; y: number };
        if (cur.fromShape && !noSnap) {
          const fromShape = rawShapes.find((s) => s.id === cur.fromShape);
          if (!fromShape) return;
          from = endpointAt(fromShape, cur.fromAnchor, world, rawShapes);
        } else {
          from = cur.fromPoint!;
        }

        // Live snap on the TO end — mirrors the FROM-side treatment so the
        // preview line visually clicks onto the candidate target's edge as
        // the cursor enters it. We pass `world` (the cursor) as the auto-
        // anchor target, NOT `from` — because `from` is itself a resolved
        // edge point that barely moves as the cursor slides around inside
        // the to-shape, which made the to-end feel locked onto an arbitrary
        // point. With cursor as target, the to-anchor slides along whichever
        // edge the cursor's direction-from-centre points toward, mirroring
        // the way the from-side slides as the cursor moves.
        //
        // Fight-snap: when the cursor pulls deep into the centre zone of the
        // candidate target, switch the resolved point to the shape's centre
        // (anchor [0.5, 0.5]) rather than the perimeter. The user can still
        // get the perimeter snap by hovering near the edge — moving the
        // cursor across the shape now visually rides centre ↔ edge instead
        // of always slamming to the perimeter. Edge band stays the default
        // "snap to edge" zone, mirroring the from-side rule.
        const toHit = noSnap ? null : shapeUnder(world, { bypassGroup: true });
        // Skip the to-side snap when the cursor is still over the shape
        // the click started on — that pattern reads as "I'm drawing an
        // annotation inside this shape", and the edge-band perimeter
        // snap was previously grabbing the same shape's edge unbidden.
        // `fromShapeRaw` covers both the bound-from-side case (clicked
        // on edge band) and the orphan-from-side case (clicked deep in
        // the body) — either way, the destination snap stays off until
        // the cursor leaves the original shape.
        const stillOverFromShape =
          !!cur.fromShapeRaw && toHit?.id === cur.fromShapeRaw;
        const toShape =
          toHit && toHit.id !== cur.fromShape && !stillOverFromShape
            ? toHit
            : null;
        const toCenterFight =
          toShape && pointInShapeCenterZone(world, toShape, EDGE_SNAP_BAND);
        // Angle snap when cmd/ctrl is held for the straight-line tools:
        // lock the bearing from `from` onto a 5° grid while preserving the
        // cursor's distance. Skipped for the space-drag-from-select case
        // (orthogonal routing — angle is meaningless there) and skipped if
        // the to-end resolved to a shape (shouldn't happen while noSnap is
        // active, but the guard makes the precedence obvious).
        const angleSnap =
          noSnap && !toShape && cur.toolName !== 'select';
        const to = toShape
          ? toCenterFight
            ? {
                x: toShape.x + Math.abs(toShape.w) / 2,
                y: toShape.y + Math.abs(toShape.h) / 2,
              }
            : endpointAt(toShape, 'auto', world, rawShapes)
          : angleSnap
          ? snapPointToAngle(from, world, 5)
          : world;

        setPreview({
          kind: 'creating-connector',
          from,
          to,
          // While noSnap is held the from-side is treated as floating —
          // mirror that into the preview so the indicator halo doesn't
          // light up on the source shape.
          fromShape: noSnap ? null : cur.fromShape,
          toShape: toShape ? toShape.id : null,
        });
        return;
      }

      if (cur.kind === 'dragging') {
        let dx = world.x - cur.pointerStart.x;
        let dy = world.y - cur.pointerStart.y;
        if (
          !cur.moved &&
          (Math.abs(dx) > DRAG_THRESHOLD / zoom ||
            Math.abs(dy) > DRAG_THRESHOLD / zoom)
        ) {
          cur.moved = true;
          // Tip published HERE rather than in setInteraction so a plain
          // click-to-select doesn't trigger the toast — see the comment
          // on the `dragging` case in setInteraction's switch.
          setActiveTipKey('ctrl-align');
        }
        if (!cur.moved) return;

        // Cmd/Ctrl snap-to-align: when held, find the closest alignment of
        // the drag bbox's left/center/right (and top/center/bottom) edges to
        // any non-dragged shape's matching edges and bend dx/dy by the
        // delta. Threshold is screen-space (8 px) so the felt "stickiness"
        // stays the same regardless of zoom. Only runs while the modifier is
        // currently held — releasing cmd mid-drag returns to free movement.
        const snapEnabled =
          e.metaKey || e.ctrlKey || metaHeldRef.current;
        if (snapEnabled) {
          // Build the union bbox of every dragged shape at its tentative
          // post-translation position. Aligning the bbox (rather than each
          // shape independently) keeps multi-selection drags coherent — the
          // selection moves as a rigid block onto the snap target.
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const id of cur.ids) {
            const sh = rawShapes.find((s) => s.id === id);
            if (!sh) continue;
            const start = cur.worldStart.get(id);
            if (!start) continue;
            const x = start.x + dx;
            const y = start.y + dy;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + sh.w);
            maxY = Math.max(maxY, y + sh.h);
          }
          if (isFinite(minX)) {
            const dragSet = new Set(cur.ids);
            // Exclude descendants of any dragged container/group so the
            // selection doesn't snap to its own children.
            const others = rawShapes.filter((s) => {
              if (dragSet.has(s.id)) return false;
              let walk: ShapeT | undefined = s;
              while (walk?.parent) {
                if (dragSet.has(walk.parent)) return false;
                walk = rawShapes.find((p) => p.id === walk!.parent);
              }
              return true;
            });
            const snap = computeAlignSnap(
              { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
              others,
              8 / zoom,
            );
            dx += snap.dx;
            dy += snap.dy;
            setAlignGuides(
              snap.vx.length || snap.hy.length
                ? { vx: snap.vx, hy: snap.hy }
                : null,
            );
          }
        } else {
          // Modifier was released mid-drag — clear any guides we'd painted.
          // Functional set to avoid a stale closure read of `alignGuides`.
          setAlignGuides((g) => (g ? null : g));
        }

        const patches = cur.ids.map((id) => {
          const start = cur.worldStart.get(id)!;
          return { id, patch: { x: start.x + dx, y: start.y + dy } };
        });
        updateShapesLive(patches);
        // Connectors carried in the multi-selection: translate waypoints and
        // any free-floating endpoints by the same dx/dy. Bound endpoints are
        // intentionally not patched here — they already track their shapes
        // through the renderer. Without this loop, bends drift away from the
        // rest of the selection (the original bug).
        for (const ct of cur.connectorTranslates) {
          const patch: Partial<ConnectorT> = {};
          if (ct.fromStart) {
            patch.from = { x: ct.fromStart.x + dx, y: ct.fromStart.y + dy };
          }
          if (ct.toStart) {
            patch.to = { x: ct.toStart.x + dx, y: ct.toStart.y + dy };
          }
          if (ct.waypointStarts.length > 0) {
            patch.waypoints = ct.waypointStarts.map((w) => ({
              x: w.x + dx,
              y: w.y + dy,
            }));
          }
          // Skip the store call for connectors that had nothing to carry —
          // bound-only no-waypoint connectors were already filtered out at
          // pointerdown, but defend the call in case that ever drifts.
          if (patch.from || patch.to || patch.waypoints) {
            updateConnectorLive(ct.id, patch);
          }
        }
        // Drop-target preview — light up any container that would adopt one
        // of the dragged shapes if released right now. Computed AFTER the
        // snap math so the highlight tracks the same final position the
        // commit-side logic will see, and only set if the target set
        // actually changed (skip the reconcile on identical frames).
        const targets = computeShapeDropTargets(
          cur.ids,
          cur.worldStart,
          dx,
          dy,
          rawShapes,
        );
        setDropTargetIds((prev) => (setsEqual(prev, targets) ? prev : targets));
        return;
      }

      if (cur.kind === 'rotating') {
        // Live rotation: take the angle from the snapshotted shape center to
        // the current pointer, subtract the angle the pointer made at down,
        // and add that delta to the rotation the shape had at down. This way
        // the cursor "stays under the handle" — the visible knob tracks the
        // mouse instead of jumping to it on the first move.
        const liveAngle =
          (Math.atan2(world.y - cur.cy, world.x - cur.cx) * 180) / Math.PI;
        let next = cur.startRotation + (liveAngle - cur.pointerStartAngle);
        // Snap to 15° while shift is held — same modifier used elsewhere for
        // axis-locked drags. Useful for landing icons at 90° / 45° without
        // having to nudge by hand. Outside of shift, leave the angle free.
        if (e.shiftKey) {
          const STEP = 15;
          next = Math.round(next / STEP) * STEP;
        }
        // Normalize to (-180, 180] so persisted rotations don't accumulate
        // unbounded after multiple revolutions (a small thing, but a 7200°
        // rotation field is irritating to read in the inspector).
        next = ((((next + 180) % 360) + 360) % 360) - 180;
        // Container rotation drags every descendant along: orbit each
        // descendant's centre around (cur.cx, cur.cy) by the gesture delta,
        // and add the same delta to its own rotation so it spins on its own
        // axis as well. Working off the gesture-start snapshot (rather than
        // last-frame state) keeps the rotation a pure function of the
        // delta, which avoids cumulative rounding drift over a long drag.
        if (cur.descendants.length > 0) {
          const delta = next - cur.startRotation;
          const rad = (delta * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const patches: { id: string; patch: Partial<ShapeT> }[] = [
            { id: cur.id, patch: { rotation: next } },
          ];
          for (const d of cur.descendants) {
            // Orbit the descendant's centre around the container's pivot.
            const vx = d.cx - cur.cx;
            const vy = d.cy - cur.cy;
            const nx = cur.cx + vx * cos - vy * sin;
            const ny = cur.cy + vx * sin + vy * cos;
            // Same normalisation as the container's own rotation.
            const dr =
              ((((d.startRotation + delta + 180) % 360) + 360) % 360) - 180;
            patches.push({
              id: d.id,
              patch: {
                x: nx - d.w / 2,
                y: ny - d.h / 2,
                rotation: dr,
              },
            });
          }
          updateShapesLive(patches);
        } else {
          updateShapeLive(cur.id, { rotation: next });
        }
        return;
      }

      if (cur.kind === 'resizing-multi') {
        // Multi-shape resize. The handle's name is interpreted against the
        // SELECTION'S union bbox; we apply applyHandleDrag to that and then
        // rescale every member to its fractional position + size in the
        // updated union. Shift-pressed → uniform scale (preserve the union
        // bbox aspect ratio), matching Excalidraw's multi-select drag feel.
        const dx = world.x - cur.pointerStart.x;
        const dy = world.y - cur.pointerStart.y;
        let nextUnion = applyHandleDrag(
          { ...cur.startUnion, kind: 'rect', id: '', layer: 'blueprint' } as ShapeT,
          cur.handle,
          dx,
          dy,
        );
        // Lock aspect: project the cursor displacement onto the diagonal
        // through the dragged corner and re-derive both axes from the same
        // scale factor. Mirrors the text-shape corner-drag logic.
        if (
          e.shiftKey &&
          (cur.handle === 'nw' ||
            cur.handle === 'ne' ||
            cur.handle === 'sw' ||
            cur.handle === 'se')
        ) {
          const oldW = cur.startUnion.w;
          const oldH = cur.startUnion.h;
          const newW = Math.max(1, nextUnion.w);
          const newH = Math.max(1, nextUnion.h);
          const scale = Math.min(newW / oldW, newH / oldH);
          const lockedW = oldW * scale;
          const lockedH = oldH * scale;
          // Re-anchor at the OPPOSITE corner so the locked-aspect bbox
          // pivots off the same point applyHandleDrag picked.
          let nx = cur.startUnion.x;
          let ny = cur.startUnion.y;
          if (cur.handle === 'nw') {
            nx = cur.startUnion.x + cur.startUnion.w - lockedW;
            ny = cur.startUnion.y + cur.startUnion.h - lockedH;
          } else if (cur.handle === 'ne') {
            ny = cur.startUnion.y + cur.startUnion.h - lockedH;
          } else if (cur.handle === 'sw') {
            nx = cur.startUnion.x + cur.startUnion.w - lockedW;
          }
          nextUnion = { x: nx, y: ny, w: lockedW, h: lockedH };
        }
        // Floor each axis to a positive minimum so the user can't yank
        // every member into a singularity. The union's normalisation also
        // catches negative w/h on commit.
        const nu = nextUnion;
        const safeW = Math.max(1, Math.abs(nu.w));
        const safeH = Math.max(1, Math.abs(nu.h));
        const sx = safeW / Math.max(1, cur.startUnion.w);
        const sy = safeH / Math.max(1, cur.startUnion.h);
        // Anchor: the corner of the START union that should stay fixed in
        // world coords. applyHandleDrag's math already keeps that anchor
        // stable, so derive it from the new union's own corners depending
        // on which handle was dragged. (We don't read it from nextUnion
        // because shift-locked aspect re-anchors above.)
        let anchorX = nu.x;
        let anchorY = nu.y;
        if (cur.handle === 'nw') {
          anchorX = nu.x + nu.w;
          anchorY = nu.y + nu.h;
        } else if (cur.handle === 'ne') {
          anchorY = nu.y + nu.h;
        } else if (cur.handle === 'sw') {
          anchorX = nu.x + nu.w;
        } else if (cur.handle === 'n') {
          anchorY = nu.y + nu.h;
        } else if (cur.handle === 'w') {
          anchorX = nu.x + nu.w;
        }
        const startAnchorX =
          cur.handle === 'nw' || cur.handle === 'sw' || cur.handle === 'w'
            ? cur.startUnion.x + cur.startUnion.w
            : cur.startUnion.x;
        const startAnchorY =
          cur.handle === 'nw' || cur.handle === 'ne' || cur.handle === 'n'
            ? cur.startUnion.y + cur.startUnion.h
            : cur.startUnion.y;
        // Edge-only drags constrain one axis. Without this, dragging the
        // 'e' handle would scale Y by 0 because nextUnion.h is unchanged
        // → sy = 1 (correct), but startAnchorY ≠ anchorY mismatch would
        // shift y. We zero out unused-axis scaling by forcing sy = 1 for
        // edge handles whose perpendicular axis didn't move.
        const sxEffective =
          cur.handle === 'n' || cur.handle === 's' ? 1 : sx;
        const syEffective =
          cur.handle === 'e' || cur.handle === 'w' ? 1 : sy;
        const patches: { id: string; patch: Partial<ShapeT> }[] = [];
        for (const [id, start] of cur.childrenStart) {
          const newX =
            anchorX + (start.x - startAnchorX) * sxEffective;
          const newY =
            anchorY + (start.y - startAnchorY) * syEffective;
          const newW = start.w * sxEffective;
          const newH = start.h * syEffective;
          const patch: Partial<ShapeT> = { x: newX, y: newY, w: newW, h: newH };
          // Text shapes need fontSize to track the scale on uniform corner
          // drags, mirroring the single-shape text path. Pick the smaller
          // axis scale so the text never overflows the new bbox.
          if (start.fontSize !== undefined) {
            const fontScale = Math.min(sxEffective, syEffective);
            patch.fontSize = Math.max(
              1,
              Math.round(start.fontSize * fontScale * 100) / 100,
            );
          }
          patches.push({ id, patch });
        }
        if (patches.length > 0) {
          updateShapesLive(patches);
        }
        return;
      }

      if (cur.kind === 'resizing') {
        let dx = world.x - cur.pointerStart.x;
        let dy = world.y - cur.pointerStart.y;
        // Icon shapes with lockAspect (vendor logos) always uniform-scale —
        // the user can't distort a trademark by dragging a corner. Treats
        // those drags as if Shift were held for the whole gesture.
        const target = useEditor
          .getState()
          .diagram.shapes.find((s) => s.id === cur.id);

        // Rotated shapes: the user is dragging in WORLD space, but our
        // applyHandleDrag math operates in the shape's LOCAL (un-rotated)
        // frame — w/h on the shape are local-frame extents. Project the
        // world delta back into local by rotating it by -rotation. Without
        // this, dragging the SE corner of a 90°-rotated rect makes the
        // height grow when the user drags right, because the world dx is
        // mapped onto the wrong axis. The resize then feels gimballed.
        const shapeRotDeg = target?.rotation ?? 0;
        if (shapeRotDeg) {
          const r = (-shapeRotDeg * Math.PI) / 180;
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          const localDx = dx * cos - dy * sin;
          const localDy = dx * sin + dy * cos;
          dx = localDx;
          dy = localDy;
        }

        // Excalidraw-style resize for kind:'text' — three branches based on
        // which handle the user grabbed. Forks BEFORE the standard
        // applyHandleDrag path because text shapes don't have a free w/h
        // axis: w/h are always derived from rendered content, controlled
        // through fontSize and the wrap width.
        if (target?.kind === 'text') {
          const isCorner =
            cur.handle === 'nw' ||
            cur.handle === 'ne' ||
            cur.handle === 'sw' ||
            cur.handle === 'se';
          const isHEdge = cur.handle === 'e' || cur.handle === 'w';

          if (isCorner) {
            // Corner drag → WRAP mode (autoSize:false), ASPECT-LOCKED for
            // the duration of the drag. Both axes scale by the same factor;
            // fontSize scales WITH the box so the text appears to grow /
            // shrink uniformly under the cursor.
            //
            // Scale comes from PROJECTING the cursor's displacement
            // from the anchor onto the outward diagonal direction. So:
            //   - Pulling along the diagonal scales the bbox.
            //   - Pulling PERPENDICULAR to the diagonal does nothing
            //     (no aspect-cheating; box stays put).
            //
            // We write the derived fontSize directly (rather than letting
            // applyTextAutoFit derive it from bbox) so subsequent typing
            // doesn't shrink the font to keep new newlines fitting — wrap
            // mode grows the bbox vertically instead, which is what the
            // user expects from a text editor.

            // Anchor (opposite corner) world position — fixed for the
            // duration of the drag.
            let anchorX = cur.startGeom.x;
            let anchorY = cur.startGeom.y;
            if (cur.handle === 'nw') {
              anchorX += cur.startGeom.w;
              anchorY += cur.startGeom.h;
            } else if (cur.handle === 'ne') {
              anchorY += cur.startGeom.h;
            } else if (cur.handle === 'sw') {
              anchorX += cur.startGeom.w;
            }

            // Outward diagonal: vector from anchor toward the original
            // dragged corner. We normalise it to use as a projection
            // axis. If startGeom is degenerate (oldDiag = 0) fall back
            // to scale=1 (no resize) — caller should never get here
            // anyway since shapes have positive bboxes.
            const outwardX =
              cur.handle === 'ne' || cur.handle === 'se' ? 1 : -1;
            const outwardY =
              cur.handle === 'sw' || cur.handle === 'se' ? 1 : -1;
            const oldOffsetX = cur.startGeom.w * outwardX;
            const oldOffsetY = cur.startGeom.h * outwardY;
            const oldDiag = Math.hypot(oldOffsetX, oldOffsetY);
            if (oldDiag === 0) return;
            const ux = oldOffsetX / oldDiag;
            const uy = oldOffsetY / oldDiag;

            // Project cursor displacement (anchor → cursor) onto the
            // outward direction to get a signed scalar distance. Divide
            // by oldDiag to get scale: 1 = no change, 2 = double, 0.5 =
            // half. Floor at 0.05 so the user can't yank the box to a
            // singular non-positive size in one frame.
            const dvx = world.x - anchorX;
            const dvy = world.y - anchorY;
            const projection = dvx * ux + dvy * uy;
            const scale = Math.max(0.05, projection / oldDiag);

            // Aspect preserved: both axes scale by the same factor.
            const newW = cur.startGeom.w * scale;
            const newH = cur.startGeom.h * scale;

            // Position bbox so the anchor corner stays at (anchorX,
            // anchorY). For SE (anchor=NW), nx=anchorX, ny=anchorY.
            // For NW (anchor=SE), shift by full new w/h.
            let nx = anchorX;
            let ny = anchorY;
            if (cur.handle === 'nw') {
              nx = anchorX - newW;
              ny = anchorY - newH;
            } else if (cur.handle === 'ne') {
              ny = anchorY - newH;
            } else if (cur.handle === 'sw') {
              nx = anchorX - newW;
            }
            // se: anchor at NW already at (anchorX, anchorY), no shift.

            // fontSize scales with the box so corner-drag has the
            // visual feel of "stretching" the text. We start from the
            // shape's CURRENT fontSize (not the start-of-drag size), so
            // multiple incremental moves compose without drifting from
            // round-off. Floor at 1px to avoid a degenerate zero-size
            // typeface that would render as no glyphs.
            const startFs =
              cur.startGeom.fontSize ?? target.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
            const newFontSize = Math.max(1, Math.round(startFs * scale * 100) / 100);

            // Write WRAP mode — applyTextAutoFit will then keep h tall
            // enough for the wrapped content as the user types. Width is
            // pinned to newW.
            updateShapeLive(cur.id, {
              autoSize: false,
              x: nx,
              y: ny,
              w: newW,
              h: newH,
              fontSize: newFontSize,
            });
            return;
          }

          if (isHEdge) {
            // Horizontal edge drag = set wrap width. autoSize=false pins the
            // user's chosen width; the store's autoFit recomputes h on every
            // mutation so the bbox tracks wrapped lines as the user widens
            // or narrows. Min wrap width = fontSize × 2 keeps the box from
            // collapsing into a one-char-per-line stripe.
            const newW =
              cur.handle === 'e'
                ? cur.startGeom.w + dx
                : cur.startGeom.w - dx;
            const newX =
              cur.handle === 'w' ? cur.startGeom.x + dx : cur.startGeom.x;
            const fs = target.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
            const minW = fs * 2;
            if (newW < minW) return;
            // Measure at the new wrap width to compute h up-front; the store
            // will measure again under autoFit but doing it here keeps the
            // single updateShapeLive call atomic.
            const fitted = measureText({
              text: target.body ?? target.label ?? '',
              fontFamily: target.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY,
              fontSize: fs,
              fontWeight: TEXT_DEFAULT_FONT_WEIGHT,
              maxWidth: newW,
            });
            updateShapeLive(cur.id, {
              autoSize: false,
              x: newX,
              w: newW,
              h: fitted.h,
            });
            return;
          }

          // n/s edges are no-ops for text shapes — the only way to make
          // a text box shorter is to delete some text. Returning here
          // (rather than falling through to applyHandleDrag) leaves the
          // shape untouched while the user holds and drags.
          return;
        }

        const forceUniform =
          target?.kind === 'icon' &&
          target.iconConstraints?.lockAspect === true;
        // Shift = uniform scale (preserve aspect ratio). For each corner the
        // sign relationship between dx and dy that *grows* the shape is fixed:
        //   nw: dx & dy both negative → same sign
        //   ne: dx +, dy − → opposite
        //   sw: dx −, dy + → opposite
        //   se: dx +, dy + → same
        // Edge handles only constrain a single axis, so uniform-scale becomes
        // "derive the other axis from the moved one" using the start aspect.
        if (e.shiftKey || forceUniform) {
          const aspect = cur.startGeom.h !== 0 ? cur.startGeom.w / cur.startGeom.h : 1;
          const sameSign = cur.handle === 'nw' || cur.handle === 'se';
          if (cur.handle === 'n' || cur.handle === 's') {
            // Vertical edge — derive dx from dy. Centre the horizontal change
            // by NOT applying it here; the resize math below ignores dx for
            // n/s anyway. Skip the aspect calculation entirely.
            dx = 0;
          } else if (cur.handle === 'e' || cur.handle === 'w') {
            dy = 0;
          } else {
            const adx = Math.abs(dx);
            const ady = Math.abs(dy);
            // Pick whichever axis the user moved further along, then derive
            // the other to match aspect.
            if (adx >= ady * aspect) {
              const mag = adx / aspect;
              dy = sameSign ? Math.sign(dx || 1) * mag : -Math.sign(dx || 1) * mag;
            } else {
              const mag = ady * aspect;
              dx = sameSign ? Math.sign(dy || 1) * mag : -Math.sign(dy || 1) * mag;
            }
          }
        }
        const fakeShape: ShapeT = {
          id: cur.id,
          kind: 'rect',
          x: cur.startGeom.x,
          y: cur.startGeom.y,
          w: cur.startGeom.w,
          h: cur.startGeom.h,
          fidelity: 1,
          layer: 'blueprint',
        };
        let next = applyHandleDrag(fakeShape, cur.handle, dx, dy);
        // Rotated shapes: applyHandleDrag operates in the shape's LOCAL
        // (un-rotated) frame, which keeps the anchor corner stable in
        // local coords. But the rotation pivot is the bbox CENTER, and the
        // center moved when the bbox grew — so when the shape re-renders
        // rotated around the new center, the anchor corner ends up at a
        // different WORLD position from where the user clicked it. The
        // result is a "drifty" feel: the corner you're not dragging slides
        // around as you resize.
        //
        // Correction: compute where the anchor lands in world before vs.
        // after, and translate the new bbox by that delta so the anchor
        // stays exactly where the user expects it.
        if (shapeRotDeg) {
          const anchorLocal = oppositeAnchorLocal(cur.handle, cur.startGeom);
          const startCx = cur.startGeom.x + cur.startGeom.w / 2;
          const startCy = cur.startGeom.y + cur.startGeom.h / 2;
          const newCx = next.x + next.w / 2;
          const newCy = next.y + next.h / 2;
          const θ = (shapeRotDeg * Math.PI) / 180;
          const cosθ = Math.cos(θ);
          const sinθ = Math.sin(θ);
          // World position of the anchor at start, rotating around startCenter.
          const ax0 = anchorLocal.x - startCx;
          const ay0 = anchorLocal.y - startCy;
          const startAx = startCx + ax0 * cosθ - ay0 * sinθ;
          const startAy = startCy + ax0 * sinθ + ay0 * cosθ;
          // Same anchor after the un-translated resize, around newCenter.
          const newAnchorLocal = oppositeAnchorLocal(cur.handle, next);
          const ax1 = newAnchorLocal.x - newCx;
          const ay1 = newAnchorLocal.y - newCy;
          const newAx = newCx + ax1 * cosθ - ay1 * sinθ;
          const newAy = newCy + ax1 * sinθ + ay1 * cosθ;
          // Translation needed so the anchor lands back where it started.
          const tx = startAx - newAx;
          const ty = startAy - newAy;
          next = { ...next, x: next.x + tx, y: next.y + ty };
        }
        // Group + container resize: drive the children from the same drag.
        if (cur.childMode && cur.childrenStart && cur.childrenStart.size > 0) {
          const patches: { id: string; patch: Partial<ShapeT> }[] = [
            { id: cur.id, patch: next },
          ];
          if (cur.childMode === 'group') {
            // Scale children proportionally to the new bbox. Negative w/h is
            // possible mid-drag (the user has dragged through zero); the
            // ratio handles this naturally — children mirror with the parent.
            const sw = cur.startGeom.w === 0 ? 1 : next.w / cur.startGeom.w;
            const sh = cur.startGeom.h === 0 ? 1 : next.h / cur.startGeom.h;
            for (const [cid, cs] of cur.childrenStart) {
              // Position relative to the start NW corner, scaled, then
              // re-anchored to the new NW corner.
              const relX = cs.x - cur.startGeom.x;
              const relY = cs.y - cur.startGeom.y;
              patches.push({
                id: cid,
                patch: {
                  x: next.x + relX * sw,
                  y: next.y + relY * sh,
                  w: cs.w * sw,
                  h: cs.h * sh,
                },
              });
            }
          } else {
            // Container resize semantics (rewritten 2026-04-28 — Josh): the
            // frame's bbox tracks the user's drag, but children DON'T
            // translate. The exception is the container's anchor icon (the
            // child whose id === container.anchorId), which rides the NW
            // corner so the iconic "title chip" stays attached to the
            // top-left of the frame. The label is rendered by Shape.tsx
            // relative to the (resized) container, so it's already correct
            // without translation.
            //
            // Min-size clamp: the container's new bbox must always contain
            // every non-anchor child. We push the dragged corner / edge
            // back outward when it would otherwise crop a member. This is
            // applied to `next` BEFORE pushing the patch, so the on-screen
            // bbox never visibly clips a child mid-drag.
            const min = cur.containerMinBox;
            if (min) {
              // NW corner can't go right of leftmost child / below topmost.
              if (next.x > min.minX) next.x = min.minX;
              if (next.y > min.minY) next.y = min.minY;
              // SE corner can't go left of rightmost / above bottommost.
              if (next.x + next.w < min.maxX) next.w = min.maxX - next.x;
              if (next.y + next.h < min.maxY) next.h = min.maxY - next.y;
            }
            // Re-emit the (possibly clamped) container patch as the first
            // entry so the order matches the live render path: the frame
            // first, then any anchor child.
            patches[0] = { id: cur.id, patch: next };
            // Anchor child position is now driven by the container's
            // iconAnchor (added 2026-04-28) — top-left, top, top-right, left,
            // center, right, bottom-left, bottom, bottom-right. Default
            // ('top-left') matches the legacy NW-translation behaviour for
            // every container that pre-dated this field, so existing diagrams
            // resize unchanged.
            if (cur.anchorChildId) {
              const anchorStart = cur.childrenStart.get(cur.anchorChildId);
              if (anchorStart) {
                const container = useEditor
                  .getState()
                  .diagram.shapes.find((s) => s.id === cur.id);
                const pos = computeContainerIconPosition(
                  next,
                  { w: anchorStart.w, h: anchorStart.h },
                  container?.iconAnchor,
                );
                patches.push({
                  id: cur.anchorChildId,
                  patch: { x: pos.x, y: pos.y },
                });
              }
            }
            // Other children intentionally NOT translated — they stay in
            // world coords. Their `parent` membership keeps them part of
            // the container's selection group; the container just frames
            // them now instead of dragging them along.
          }
          updateShapesLive(patches);
          return;
        }
        updateShapeLive(cur.id, next);
        return;
      }

      if (cur.kind === 'marquee') {
        cur.current = world;
        const liveRect = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: world.x - cur.start.x,
          h: world.y - cur.start.y,
        });
        const liveShapeIds = shapesInMarquee(liveRect, visibleShapes);
        const liveConnectorIds = connectorsInMarquee(
          liveRect,
          visibleConnectors,
          new Set(liveShapeIds),
        );
        setPreview({
          kind: 'marquee',
          rect: {
            x: cur.start.x,
            y: cur.start.y,
            w: world.x - cur.start.x,
            h: world.y - cur.start.y,
          },
          shapeIds: liveShapeIds,
          connectorIds: liveConnectorIds,
        });
        return;
      }

      if (cur.kind === 'drag-waypoint') {
        cur.moved = true;
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn || !conn.waypoints) return;
        const next = conn.waypoints.slice();
        next[cur.index] = { x: world.x, y: world.y };
        updateConnectorLive(cur.connectorId, { waypoints: next });
        return;
      }

      if (cur.kind === 'dragging-connector-label') {
        // Project cursor onto the connector's rendered polyline and use
        // that projection's arclength fraction as the new labelPosition.
        // This means the label slides ALONG the line (not free-floating)
        // — the label point Connector.tsx renders at always matches the
        // last sampled fraction, so commit doesn't visibly jump.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        const path = resolveConnectorPath(conn, rawShapes);
        if (!path) return;
        const poly = connectorPolyline(
          conn,
          path.fx,
          path.fy,
          path.tx,
          path.ty,
          path.fromAnchor,
          path.toAnchor,
          path.fromRot,
          path.toRot,
        );
        if (poly.length < 2) return;
        const fraction = nearestFractionOnPolyline(poly, world);
        // Don't flag moved on micro-jitter — the same threshold the rest
        // of the canvas uses for "the user actually dragged" so a click
        // with a tiny pointer wobble doesn't push an undo entry.
        if (Math.abs(fraction - cur.startFraction) > 0.001) {
          cur.moved = true;
        }
        updateConnectorLive(cur.connectorId, { labelPosition: fraction });
        return;
      }

      if (cur.kind === 'drag-endpoint') {
        cur.moved = true;
        // If the cursor is over a shape (not the connector's other endpoint's
        // shape, since that'd be a self-loop), bind to it. Otherwise float.
        // Holding cmd/ctrl disables snapping entirely so the user can place
        // the endpoint freely even over a shape.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        const otherEp = cur.side === 'from' ? conn.to : conn.from;
        const otherShape = 'shape' in otherEp ? otherEp.shape : null;
        // Cmd/Ctrl = no-snap on endpoint reposition (matches creation flow).
        const noSnap = e.metaKey || e.ctrlKey;
        const hit = noSnap ? null : shapeUnder(world, { bypassGroup: true });
        const targetShape = hit && hit.id !== otherShape ? hit : null;
        // Angle snap on endpoint reposition mirrors the creation flow: when
        // Cmd/Ctrl is held and the moving end isn't binding to a shape,
        // quantize the bearing from the OTHER (stationary) endpoint to a 5°
        // grid. Only applies to straight connectors — orthogonal/curved
        // routing chooses its own bend pattern, so angle constraint is
        // meaningless. The pivot is resolved via `resolveEndpointPoint` so
        // shape-bound stationary endpoints rotate around their actual world
        // position, not the raw stored anchor.
        const angleSnap =
          noSnap && !targetShape && conn.routing === 'straight';
        let cursorWorld = world;
        if (angleSnap) {
          const pivot = resolveEndpointPoint(otherEp, cur.side === 'from' ? conn.from : conn.to, rawShapes);
          if (pivot) {
            cursorWorld = snapPointToAngle(pivot, world, 5);
          }
        }
        // Snapshot the cursor-derived fractional anchor — same math the
        // creation preview uses. Storing `'auto'` here would re-resolve
        // every frame against the OPPOSITE endpoint's centre, which locks
        // the rendered endpoint onto the centre-to-centre ray and makes it
        // ignore cursor position entirely (the "can't slide along the
        // shape" bug). Freezing the fractional anchor lets the user drag
        // the endpoint along the perimeter and have the line track them.
        //
        // Fight-snap parity with the creation flow: dragging the endpoint
        // deep into a candidate target's centre zone binds at [0.5, 0.5]
        // instead of an auto perimeter anchor. Edge band releases keep the
        // existing perimeter snap.
        const fightCenter =
          targetShape &&
          pointInShapeCenterZone(world, targetShape, EDGE_SNAP_BAND);
        const newEp = targetShape
          ? fightCenter
            ? { shape: targetShape.id, anchor: [0.5, 0.5] as Anchor }
            : { shape: targetShape.id, anchor: autoAnchor(targetShape, world) }
          : { x: cursorWorld.x, y: cursorWorld.y };
        updateConnectorLive(cur.connectorId, {
          [cur.side]: newEp,
        } as Partial<ConnectorT>);
        return;
      }

      if (cur.kind === 'translate-connector') {
        const dx = world.x - cur.pointerStart.x;
        const dy = world.y - cur.pointerStart.y;
        if (
          !cur.moved &&
          Math.abs(dx) <= DRAG_THRESHOLD / zoom &&
          Math.abs(dy) <= DRAG_THRESHOLD / zoom
        ) {
          return;
        }
        // First frame past the threshold — publish the move-time tip. Same
        // rationale as the `dragging` branch above: clicking on a connector
        // to select shouldn't pop the toast. We pick the tip based on
        // whether the line is a candidate for container auto-bind: orphan
        // (both ends floating) → 'shift-disable-snap' so the user knows how
        // to drop into a container without auto-binding. Bound connectors
        // get the regular 'ctrl-align' since their shapes-on-rails path
        // doesn't snap.
        if (!cur.moved) {
          const c0 = useEditor
            .getState()
            .diagram.connectors.find((c) => c.id === cur.connectorId);
          const orphan = c0 && !('shape' in c0.from) && !('shape' in c0.to);
          setActiveTipKey(orphan ? 'shift-disable-snap' : 'ctrl-align');
        }
        cur.moved = true;
        updateConnectorLive(cur.connectorId, {
          from: { x: cur.fromStart.x + dx, y: cur.fromStart.y + dy },
          to: { x: cur.toStart.x + dx, y: cur.toStart.y + dy },
          waypoints: cur.waypointStarts.length
            ? cur.waypointStarts.map((w) => ({ x: w.x + dx, y: w.y + dy }))
            : undefined,
        });
        // Drop-target preview for orphan connectors: the up-handler auto-
        // binds a fully-orphan connector when both endpoints land in the
        // same container, so glow that container during the drag. We have
        // to look up the connector's *current* shape — the kind 'translate-
        // connector' only fires for orphan connectors today, but checking
        // the from/to shape-binding here keeps us honest if that ever
        // changes.
        //
        // Shift suppresses the preview AND the up-handler's auto-bind, so
        // the user can move the line over a container without it grabbing.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        let targets: Set<string> = new Set();
        if (
          conn &&
          !('shape' in conn.from) &&
          !('shape' in conn.to) &&
          !e.shiftKey
        ) {
          targets = computeConnectorDropTarget(
            cur.fromStart.x + dx,
            cur.fromStart.y + dy,
            cur.toStart.x + dx,
            cur.toStart.y + dy,
            rawShapes,
          );
        }
        setDropTargetIds((prev) => (setsEqual(prev, targets) ? prev : targets));
        return;
      }

      if (cur.kind === 'laser') {
        laserCursorRef.current = { x: world.x, y: world.y };
        setLaserTrail((trail) => [...trail, { x: world.x, y: world.y, t: performance.now() }]);
        return;
      }

      if (cur.kind === 'pen') {
        cur.points.push({ x: world.x, y: world.y });
        setPenPath(cur.points.slice());
        return;
      }

      if (cur.kind === 'create-waypoint') {
        const dx = world.x - cur.pointerStart.x;
        const dy = world.y - cur.pointerStart.y;
        if (
          !cur.committed &&
          Math.abs(dx) <= DRAG_THRESHOLD / zoom &&
          Math.abs(dy) <= DRAG_THRESHOLD / zoom
        ) {
          return;
        }
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        if (!cur.committed) {
          // First real motion — snapshot history then plant the waypoint.
          // Clamp insertIndex to the existing waypoints length so we never
          // leave a sparse hole in the array (which used to happen when the
          // user clicked on the second/third synthetic-elbow segment of an
          // orthogonal connector with no real waypoints).
          commitHistory();
          const existing = conn.waypoints ?? [];
          const clamped = Math.min(cur.insertIndex, existing.length);
          const insert = existing.slice();
          insert.splice(clamped, 0, { x: world.x, y: world.y });
          // Auto-promote a fresh straight line to curved routing on first bend.
          // Polylines with sharp angles read as accidents; smooth curves match
          // the "bendy line" mental model the user actually has.
          const patch: Partial<typeof conn> = { waypoints: insert };
          if (conn.routing === 'straight' && existing.length === 0) {
            patch.routing = 'curved';
          }
          updateConnectorLive(cur.connectorId, patch);
          cur.insertIndex = clamped;
          cur.committed = true;
          return;
        }
        // Subsequent motion — update the waypoint in place.
        const wps = (conn.waypoints ?? []).slice();
        wps[cur.insertIndex] = { x: world.x, y: world.y };
        updateConnectorLive(cur.connectorId, { waypoints: wps });
        return;
      }
    },
    [
      commitHistory,
      eventToWorld,
      rawShapes,
      setPan,
      shapeUnder,
      updateConnectorLive,
      updateShapeLive,
      updateShapesLive,
      zoom,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const cur = interactionRef.current;
      if (pointerDownRef.current === e.pointerId) {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
        pointerDownRef.current = null;
      }

      if (cur.kind === 'panning') {
        // A bare click on empty space (pan started but no actual movement)
        // should clear selection — that's the muscle memory from every other
        // diagram tool.
        const dx = e.clientX - cur.pointerStart.x;
        const dy = e.clientY - cur.pointerStart.y;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
          setSelected(null);
        }
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'creating-shape') {
        // Mirror the pointer-move shift-constrain so the committed shape
        // matches the preview the user saw at the moment of release. Keying
        // off `e.shiftKey` (rather than a flag stored in interaction state)
        // means that dropping shift on the same tick as releasing the mouse
        // commits a free-aspect shape, which matches what they see.
        const constrainSquare =
          e.shiftKey &&
          (cur.toolName === 'rect' ||
            cur.toolName === 'ellipse' ||
            cur.toolName === 'diamond');
        let cx = cur.current.x;
        let cy = cur.current.y;
        if (constrainSquare) {
          const dx = cur.current.x - cur.start.x;
          const dy = cur.current.y - cur.start.y;
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          cx = cur.start.x + (dx >= 0 ? size : -size);
          cy = cur.start.y + (dy >= 0 ? size : -size);
        }
        const r = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cx - cur.start.x,
          h: cy - cur.start.y,
        });
        // Text tool: bare click → drop a shrink-wrapping text shape and
        // open the inline editor. autoSize=true means the bbox grows as
        // the user types; the seed w/h here is a placeholder one-line box
        // — the store's autoFit overwrites it on insert based on the
        // empty content (zero-width-space measurement gives a one-line
        // tall caret target). fontSize starts at TEXT_DEFAULT_TOOL_FONT_SIZE
        // (28) — text-tool drops are usually annotations / headings, not
        // body copy, so a bigger default reads better as a stand-alone
        // label without the user reaching for the size field.
        // Drag → size a wrap-width text shape (autoSize=false) at the
        // dragged width; fontSize derives from the dragged HEIGHT so a
        // tall box gives big text (the user dragged "this big" and
        // expects the typeface to honour that gesture).
        if (cur.toolName === 'text' && r.w < 4 && r.h < 4) {
          const id = newId('text');
          addShape({
            id,
            kind: 'text',
            x: cur.start.x,
            y: cur.start.y,
            w: 0,
            h: 0,
            label: '',
            autoSize: true,
            fontSize: TEXT_DEFAULT_TOOL_FONT_SIZE,
            layer: 'blueprint',
          });
          useEditor.getState().adoptIntoContainer(id);
          setTimeout(() => {
            const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
            window.dispatchEvent(ev);
          }, 0);
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        if (cur.toolName === 'text') {
          // Drag-create text shape: width is what the user dragged
          // (becomes the wrap width); autoSize=false. fontSize derives
          // from r.h so a tall drag = big text. We assume one line of
          // text fills the dragged height (h ≈ fontSize × line-height,
          // with line-height = 1.2). Floor at 8px so a flicker of a
          // drag still produces readable text. Cap at 200 so a very
          // tall accidental drag doesn't yield gigantic text the user
          // then has to rescale.
          const id = newId('text');
          const derivedFs = Math.max(
            8,
            Math.min(200, Math.round(r.h / 1.2)),
          );
          addShape({
            id,
            kind: 'text',
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            label: '',
            autoSize: false,
            fontSize: derivedFs,
            layer: 'blueprint',
          });
          useEditor.getState().adoptIntoContainer(id);
          setTimeout(() => {
            const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
            window.dispatchEvent(ev);
          }, 0);
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        // No real drag → no shape (everything except text).
        if (r.w < 4 && r.h < 4) {
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        // Tiny but non-zero drag — nudge to a minimum readable size.
        if (r.w < 8) r.w = 8;
        if (r.h < 8) r.h = 8;
        // For custom-bound slots (8/9 etc.), pull the glyph + label out of
        // the binding so the dropped shape carries them.
        const def = bindings[activeTool];
        const sh = defaultShapeFromTool(
          activeTool,
          cur.toolName,
          r.x,
          r.y,
          r.w,
          r.h,
          def?.custom ? def.icon : undefined,
          def?.custom ? def.label : undefined,
        );
        if (sh) {
          addShape(sh);
          // If the user drew the shape inside an existing container, parent
          // it to that container so it moves with the frame. Same logic the
          // drop handlers run for library / icon drops. We skip this for
          // shapes that are themselves containers — auto-adopting would let
          // the user accidentally nest containers when they meant to lay one
          // alongside another (the explicit "drag into" path still works).
          if (sh.kind !== 'container') {
            useEditor.getState().adoptIntoContainer(sh.id);
          }
        }
        setInteraction({ kind: 'idle' });
        setPreview(null);
        if (!toolLock) setActiveTool('1');
        return;
      }

      if (cur.kind === 'creating-connector') {
        const world = eventToWorld(e);
        // HOLD-only no-snap: the user has to be holding Cmd/Ctrl AT RELEASE
        // for the commit to skip binding. A brief tap during the drag no
        // longer permanently disables binding — pointerup carries the live
        // modifier state directly so no held-ref latch is needed.
        const noSnap = e.metaKey || e.ctrlKey;
        const hit = noSnap ? null : shapeUnder(world, { bypassGroup: true });
        const dx = world.x - cur.fromPoint.x;
        const dy = world.y - cur.fromPoint.y;
        const moved =
          Math.abs(dx) > DRAG_THRESHOLD / zoom ||
          Math.abs(dy) > DRAG_THRESHOLD / zoom;

        // No drag → cancel. Don't accidentally drop a 0-length line.
        if (!moved) {
          setInteraction({ kind: 'idle' });
          setPreview(null);
          return;
        }

        // Sticky no-snap also retroactively unbinds the FROM side. The user
        // expectation is "cmd while drawing → no binding, ever" — without
        // this, holding cmd after click-down still leaves the from-end stuck
        // on whatever was under the original click.
        //
        // Anchor-freezing on commit: the preview shows the connector ends
        // sliding along each shape's perimeter as the cursor moves (the
        // pointer-move handler resolves both ends as `auto` against the
        // current cursor position). When the user releases, we snapshot
        // *that exact fractional anchor* into the connector — so what they
        // saw is what they get. Storing `'auto'` here would re-resolve every
        // frame against the OPPOSITE shape's centre, which permanently locks
        // each end to the centre-to-centre ray and discards the user's
        // chosen point on the perimeter.
        // Annotation-inside-one-shape detection: if the cursor was
        // released over the same shape the click started on (regardless
        // of which side actually bound), force both ends to float so the
        // line stays as a free annotation across the shape's interior.
        // Without this rule, the from-side might bind to that shape's
        // edge band on click while the to-side either re-binds to the
        // same shape or perimeter-snaps to whatever it landed on —
        // neither of which matches "I'm drawing inside this thing".
        const insideSingleShape =
          !!cur.fromShapeRaw && hit?.id === cur.fromShapeRaw;

        const fromEp: ConnectorT['from'] = (() => {
          if (!cur.fromShape || noSnap || insideSingleShape) {
            return { x: cur.fromPoint.x, y: cur.fromPoint.y };
          }
          const fromShape = rawShapes.find((s) => s.id === cur.fromShape);
          if (!fromShape) return { x: cur.fromPoint.x, y: cur.fromPoint.y };
          // From-side anchor honours the click-down decision:
          //   - tuple anchor (e.g. [0.5, 0.5]) → user clicked the centre
          //     zone, freeze that point so the connector originates from
          //     the shape's middle and follows it on subsequent moves.
          //   - 'auto' → resolve against the release cursor so the from-
          //     end picks whichever perimeter point faces the to-end.
          //     Same math the preview uses; storing 'auto' would
          //     re-resolve every frame against the OPPOSITE shape's
          //     centre, locking each end onto the centre-to-centre ray.
          if (Array.isArray(cur.fromAnchor)) {
            return { shape: cur.fromShape, anchor: cur.fromAnchor };
          }
          return { shape: cur.fromShape, anchor: autoAnchor(fromShape, world) };
        })();
        // Fight-snap on commit: if the cursor was released in the
        // candidate target's centre zone, store the connector with a
        // fixed centre anchor `[0.5, 0.5]` instead of an auto perimeter
        // anchor. That way "drag deep into the shape's middle" reliably
        // pins the to-end at the centre of the shape — even after the
        // shape moves later, since the anchor follows the shape's
        // geometry. Edge releases keep the existing perimeter snap, so
        // the user retains every option they had before.
        // Mirror the preview's angle snap on commit: when cmd/ctrl is held
        // and the to-end is floating (which it always is under noSnap), drop
        // the cursor onto the same 5°-quantized point the preview was
        // showing. Without this, the released line would jump back to the
        // raw cursor position the moment the user lets go.
        const commitTo =
          noSnap && cur.toolName !== 'select'
            ? snapPointToAngle(cur.fromPoint, world, 5)
            : world;
        const toEp: ConnectorT['to'] =
          hit && hit.id !== cur.fromShape && !insideSingleShape
            ? pointInShapeCenterZone(world, hit, EDGE_SNAP_BAND)
              ? { shape: hit.id, anchor: [0.5, 0.5] as Anchor }
              : { shape: hit.id, anchor: autoAnchor(hit, world) }
            : { x: commitTo.x, y: commitTo.y };

        // Default routing: line/arrow tools = straight; space-drag from
        // select tool = orthogonal (matches the legacy behaviour).
        const routing =
          cur.toolName === 'select' ? 'orthogonal' : 'straight';
        // Endpoint markers default by tool: arrow tool puts an arrowhead at
        // the to-end, line tool stays bare.
        const fromMarker = 'none' as const;
        const toMarker =
          cur.toolName === 'arrow' || cur.toolName === 'select'
            ? ('arrow' as const)
            : ('none' as const);
        // Sticky appearance: stroke / strokeWidth / dash style come from the
        // user's last edit on any connector. Routing + markers stay tool-
        // driven (see comment on LastConnectorStyle in store/editor.ts) — the
        // arrow tool should still draw arrows, even if you last edited a
        // dashed circle→circle line.
        const stickyConn = useEditor.getState().lastConnectorStyle;
        // Layer pick: mirror the shape-creation rule — `both` falls back to
        // Blueprint so the obvious default never produces a hidden line.
        const liveLayerMode = useEditor.getState().layerMode;
        const connLayer = liveLayerMode === 'notes' ? 'notes' : 'blueprint';
        // Container auto-bind on creation: if the user drew a free-floating
        // connector entirely inside a container's bbox, rebind both endpoints
        // to that container with fractional anchors. Mirrors the rule the
        // translate-connector commit branch uses when an orphan line is
        // dragged into a container — without this parity, drawing a line
        // straight into the container left it loose and the user had to
        // draw-then-drag-in to associate it (the original bug).
        //
        // Three guards on top of "both endpoints floating":
        //   1. `noSnap` — user held cmd/ctrl. They've explicitly opted out
        //      of binding semantics for THIS gesture; auto-binding to a
        //      container would override their decision the same way an
        //      auto shape-snap would.
        //   2. `insideSingleShape` — user drew the line entirely inside a
        //      single shape (the "annotation across this thing" case).
        //      The endpoints were forced floating to keep the line as a
        //      free annotation across that shape; binding them to the
        //      surrounding container would leap a level up the parenting
        //      hierarchy past what the user clearly meant.
        //   3. Both endpoints actually floating — if either side bound to
        //      a shape, the user's explicit target wins.
        let finalFrom = fromEp;
        let finalTo = toEp;
        if (
          !noSnap &&
          !insideSingleShape &&
          !('shape' in fromEp) &&
          !('shape' in toEp)
        ) {
          const fp = fromEp as { x: number; y: number };
          const tp = toEp as { x: number; y: number };
          const containers = rawShapes
            .filter((s) => s.kind === 'container')
            .filter((s) => {
              const inFx = fp.x >= s.x && fp.x <= s.x + s.w;
              const inFy = fp.y >= s.y && fp.y <= s.y + s.h;
              const inTx = tp.x >= s.x && tp.x <= s.x + s.w;
              const inTy = tp.y >= s.y && tp.y <= s.y + s.h;
              return inFx && inFy && inTx && inTy;
            })
            // Front-most container wins so a connector drawn inside a
            // nested container sticks to the inner one.
            .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
          const target = containers[0];
          if (target && target.w > 0 && target.h > 0) {
            const clamp = (v: number) => Math.max(0, Math.min(1, v));
            finalFrom = {
              shape: target.id,
              anchor: [
                clamp((fp.x - target.x) / target.w),
                clamp((fp.y - target.y) / target.h),
              ],
            };
            finalTo = {
              shape: target.id,
              anchor: [
                clamp((tp.x - target.x) / target.w),
                clamp((tp.y - target.y) / target.h),
              ],
            };
          }
        }

        const c: ConnectorT = {
          id: newId('c'),
          from: finalFrom,
          to: finalTo,
          layer: connLayer,
          routing,
          fromMarker,
          toMarker,
          // Tool-default style for the line tool (solid). lastConnectorStyle
          // wins if the user has explicitly set a dash style at any point.
          ...(cur.toolName === 'line' ? { style: 'solid' as const } : {}),
          ...(stickyConn.stroke !== undefined ? { stroke: stickyConn.stroke } : {}),
          ...(stickyConn.strokeWidth !== undefined
            ? { strokeWidth: stickyConn.strokeWidth }
            : {}),
          ...(stickyConn.style !== undefined ? { style: stickyConn.style } : {}),
          ...(stickyConn.fromMarkerSize !== undefined
            ? { fromMarkerSize: stickyConn.fromMarkerSize }
            : {}),
          ...(stickyConn.toMarkerSize !== undefined
            ? { toMarkerSize: stickyConn.toMarkerSize }
            : {}),
        };
        addConnector(c);

        setInteraction({ kind: 'idle' });
        setPreview(null);
        if (cur.toolName !== 'select' && !toolLock) setActiveTool('1');
        return;
      }

      if (cur.kind === 'dragging') {
        if (cur.moved) {
          // Auto-adopt: any dragged shape whose centre now lands inside a
          // container becomes that container's child. Skip shapes already in
          // the dragged set's container family — they're already moving with
          // their parent. Run BEFORE commitHistory so the parent change folds
          // into the same undo step as the drag.
          const adopt = useEditor.getState().adoptIntoContainer;
          for (const id of cur.ids) {
            adopt(id);
          }
          commitHistory();
        }
        setAlignGuides(null);
        // Drop-target glow goes away the instant the gesture commits; the
        // adoption itself paints the shape inside the container, so leaving
        // the halo behind would feel like leftover state.
        setDropTargetIds((prev) => (prev.size > 0 ? new Set() : prev));
        setInteraction({ kind: 'idle' });
        // Non-drag click on a group → nudge the user that double-click
        // enters the group so they can select individual children. Published
        // AFTER setInteraction(idle) which clears all tips; the override is
        // intentional — selection-time tips don't map to a gesture kind.
        if (!cur.moved) {
          const sel = useEditor.getState().selectedIds;
          if (sel.length === 1) {
            const sh = rawShapes.find((s) => s.id === sel[0]);
            if (sh?.kind === 'group') {
              setActiveTipKey('dblclick-group-select');
            }
          }
        }
        return;
      }

      if (cur.kind === 'resizing') {
        // Normalise any negative w/h on commit so the data stays clean.
        const sh = useEditor.getState().diagram.shapes.find((s) => s.id === cur.id);
        if (sh) {
          const norm = normalizeRect({ x: sh.x, y: sh.y, w: sh.w, h: sh.h });
          if (
            sh.kind === 'text' &&
            (sh.autoSize === false || sh.autoSize === 'fit')
          ) {
            // Edge-drag and corner-drag both already wrote the
            // cursor-traced bbox + fontSize during the live gesture
            // (corner-drag derived fontSize from the box scale; edge-drag
            // left fontSize untouched). Commit just normalises and routes
            // through updateShape so a history entry is recorded. autoFit
            // on commit may grow h to fit wrapped lines but won't shift
            // the bbox the user drew, so no anchor re-shift is needed.
            // Legacy autoSize:'fit' shapes hit this branch too — same
            // semantics now that fit mode also pins fontSize.
            updateShape(cur.id, {
              x: norm.x,
              y: norm.y,
              w: norm.w,
              h: norm.h,
              fontSize: sh.fontSize,
              autoSize: sh.autoSize,
            });
          } else if (sh.kind === 'text' && sh.autoSize === true) {
            // Shrink-wrap commit (autoSize stayed true through the
            // gesture, e.g. some other code path that didn't transition
            // to false). Re-fit the bbox to the rendered text and shift
            // x/y so the un-dragged anchor corner stays put.
            const fitted = measureText({
              text: sh.body ?? sh.label ?? '',
              fontFamily: sh.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY,
              fontSize: sh.fontSize ?? TEXT_DEFAULT_FONT_SIZE,
              fontWeight: TEXT_DEFAULT_FONT_WEIGHT,
            });
            let anchorX = norm.x;
            let anchorY = norm.y;
            if (cur.handle === 'nw') {
              anchorX = norm.x + norm.w;
              anchorY = norm.y + norm.h;
            } else if (cur.handle === 'ne') {
              anchorY = norm.y + norm.h;
            } else if (cur.handle === 'sw') {
              anchorX = norm.x + norm.w;
            }
            let nx = norm.x;
            let ny = norm.y;
            if (cur.handle === 'nw') {
              nx = anchorX - fitted.w;
              ny = anchorY - fitted.h;
            } else if (cur.handle === 'ne') {
              ny = anchorY - fitted.h;
            } else if (cur.handle === 'sw') {
              nx = anchorX - fitted.w;
            }
            updateShape(cur.id, {
              x: nx,
              y: ny,
              fontSize: sh.fontSize,
              autoSize: true,
            });
          } else {
            updateShapeLive(cur.id, norm);
          }
        }
        commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'resizing-multi') {
        // Normalise every member's geometry so the data stays positive-w/h
        // even if the user dragged through zero. updateShapesLive already
        // committed the rectangle; we re-apply via updateShape on the
        // (possibly few) members whose normalisation changed something so
        // the history entry includes the cleaned-up values.
        const editor = useEditor.getState();
        const next = editor.diagram.shapes;
        for (const id of cur.childrenStart.keys()) {
          const sh = next.find((s) => s.id === id);
          if (!sh) continue;
          const norm = normalizeRect({ x: sh.x, y: sh.y, w: sh.w, h: sh.h });
          if (norm.x !== sh.x || norm.y !== sh.y || norm.w !== sh.w || norm.h !== sh.h) {
            editor.updateShapeLive(id, norm);
          }
        }
        commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'rotating') {
        // Live rotation already wrote the latest angle into the shape via
        // updateShapeLive; commit a single history entry so the gesture is
        // one undoable step rather than dozens.
        commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'marquee') {
        const rect = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cur.current.x - cur.start.x,
          h: cur.current.y - cur.start.y,
        });
        // Recompute on commit. We could trust the live preview's candidate
        // lists, but recomputing keeps the up-handler self-sufficient if some
        // future code path skips a setPreview frame.
        let shapeIds = shapesInMarquee(rect, visibleShapes);
        // While inside a focused group, marqueeing CAN'T select the group
        // itself — the user is operating inside that scope, and a marquee
        // that engulfs the entire group should yield "all the children",
        // not "the group + its children" (which would re-promote the group
        // back into the user's selection and feel like the focus exited).
        const fg = useEditor.getState().focusedGroupId;
        if (fg) shapeIds = shapeIds.filter((id) => id !== fg);
        const connectorIds = connectorsInMarquee(
          rect,
          visibleConnectors,
          new Set(shapeIds),
        );
        const allIds = [...shapeIds, ...connectorIds];
        if (rect.w < 2 && rect.h < 2) {
          // Click on empty space — clear selection AND close any open chrome
          // menus. Acts as a "panic button" reset.
          if (!cur.additive) {
            setSelected(null);
            useEditor.getState().closeAllOverlays();
            setContextMenu(null);
          }
        } else if (cur.additive) {
          addToSelection(allIds);
        } else {
          setSelected(allIds);
        }
        setInteraction({ kind: 'idle' });
        setPreview(null);
        return;
      }

      if (cur.kind === 'drag-waypoint') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'dragging-connector-label') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'create-waypoint') {
        // History was already snapshotted on first motion; nothing else to do.
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'drag-endpoint') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'translate-connector') {
        if (cur.moved) {
          // Auto-bind to a container: if a fully-orphan connector (both
          // endpoints floating) was dragged INTO a container — i.e. both
          // endpoint positions land inside that container's bbox — bind
          // both endpoints to the container with fractional anchors. The
          // connector then tracks the container on subsequent moves /
          // resizes (the shape-bound resolver does the rest), restoring
          // the "drop the line into the box and it sticks" mental model.
          //
          // Only fully-orphan connectors are eligible. Partially-bound
          // connectors already tie themselves to existing shapes; auto-
          // grabbing them would silently rewrite the user's intent.
          //
          // Container detection: front-most (highest z) container whose
          // bbox contains both endpoint points wins so dropping into a
          // nested container picks the inner one.
          const conn = useEditor
            .getState()
            .diagram.connectors.find((c) => c.id === cur.connectorId);
          if (
            conn &&
            !('shape' in conn.from) &&
            !('shape' in conn.to) &&
            !e.shiftKey
          ) {
            const fp = conn.from as { x: number; y: number };
            const tp = conn.to as { x: number; y: number };
            const containers = rawShapes
              .filter((s) => s.kind === 'container')
              .filter((s) => {
                const inFx = fp.x >= s.x && fp.x <= s.x + s.w;
                const inFy = fp.y >= s.y && fp.y <= s.y + s.h;
                const inTx = tp.x >= s.x && tp.x <= s.x + s.w;
                const inTy = tp.y >= s.y && tp.y <= s.y + s.h;
                return inFx && inFy && inTx && inTy;
              })
              .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
            const target = containers[0];
            if (target && target.w > 0 && target.h > 0) {
              const fx1 = (fp.x - target.x) / target.w;
              const fy1 = (fp.y - target.y) / target.h;
              const fx2 = (tp.x - target.x) / target.w;
              const fy2 = (tp.y - target.y) / target.h;
              // Clamp so floating-point drift on the boundary doesn't
              // produce an out-of-range anchor that the routing math
              // would later push back to the bbox edge.
              const clamp = (v: number) => Math.max(0, Math.min(1, v));
              updateConnectorLive(cur.connectorId, {
                from: {
                  shape: target.id,
                  anchor: [clamp(fx1), clamp(fy1)],
                },
                to: {
                  shape: target.id,
                  anchor: [clamp(fx2), clamp(fy2)],
                },
              });
            }
          }
          commitHistory();
        }
        // Same rationale as the shape-drag commit: the glow has done its
        // job once we land, and the bound connector now reads the binding
        // from the container itself.
        setDropTargetIds((prev) => (prev.size > 0 ? new Set() : prev));
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'laser') {
        // Trail keeps fading via the timer effect — nothing to commit.
        // Clear the live-cursor pin so the dot can fade with the trail
        // instead of staying anchored at the release point.
        laserCursorRef.current = null;
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'pen') {
        if (cur.points.length >= 2) {
          // Compute bounding box, normalise points relative to (minX, minY).
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of cur.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          const pad = 4;
          const x = minX - pad;
          const y = minY - pad;
          const w = maxX - minX + pad * 2;
          const h = maxY - minY + pad * 2;
          const st = useEditor.getState();
          addShape({
            id: newId('pen'),
            kind: 'freehand',
            x,
            y,
            w,
            h,
            layer: 'blueprint',
            points: cur.points.map((p) => ({ x: p.x - x, y: p.y - y })),
            stroke: st.penColor,
            strokeWidth: st.penWidth,
          });
          // Pen is the one tool that should NOT auto-select what it just
          // drew. Every other tool benefits from immediate selection
          // (so the user can resize / restyle the just-created shape),
          // but freehand strokes are usually drawn in clusters and
          // selecting each one in turn keeps yanking selection halos
          // over the artwork the user is building. addShape sets
          // `selectedIds: [sh.id]` unconditionally — clear it here for
          // the pen branch only.
          useEditor.getState().setSelected([]);
        }
        setPenPath(null);
        setInteraction({ kind: 'idle' });
        // Pen is also the one tool that should NOT revert to select on
        // release — every other shape tool reverts (governed by toolLock
        // for the rest), but freehand strokes are typically drawn in
        // clusters. Reverting after every stroke forced the user to
        // re-press 9 between strokes; keep pen active until the user
        // picks another tool explicitly.
        return;
      }
    },
    [
      activeTool,
      addConnector,
      addShape,
      addToSelection,
      bindings,
      commitHistory,
      eventToWorld,
      setActiveTool,
      setSelected,
      shapeUnder,
      toolLock,
      updateShapeLive,
      visibleShapes,
    ],
  );

  // wheel zoom (with ⌘/ctrl modifier OR pinch trackpad)
  // Native onWheel is passive by default → can't preventDefault. Attach via
  // ref + addEventListener with passive:false instead.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Trackpad pinch shows up as ctrlKey wheel events. Cmd-wheel is also
      // zoom. Plain wheel = pan.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const around = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = Math.exp(-e.deltaY * 0.005);
        zoomBy(factor, around);
      } else {
        // Two-finger pan on mac trackpads emits wheel events with deltaX/Y.
        e.preventDefault();
        useEditor.getState().panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // preview rendering
  const previewEl = useMemo(() => {
    if (!preview) return null;
    if (preview.kind === 'creating-shape') {
      const { rect, toolName } = preview;
      const stroke = 'var(--refined)';
      if (toolName === 'rect' || toolName === 'text' || toolName === 'note') {
        return (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'container') {
        // Container preview echoes the committed container's chrome: a
        // dashed rounded outline + a faint anchor square in the top-left
        // so the user sees the eventual "frame around stuff" treatment
        // mid-drag instead of an empty hover. The anchor square is sized
        // to match the final container's `make a child` slot (32×24) so
        // the proportions stay honest as they drag.
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        const x0 = rect.w < 0 ? rect.x + rect.w : rect.x;
        const y0 = rect.h < 0 ? rect.y + rect.h : rect.y;
        const r = Math.min(8, Math.min(w, h) / 4);
        const anchorW = Math.min(32, Math.max(0, w - 16));
        const anchorH = Math.min(24, Math.max(0, h - 16));
        return (
          <g pointerEvents="none">
            <rect
              x={x0}
              y={y0}
              width={w}
              height={h}
              rx={r}
              fill="rgba(31,111,235,0.06)"
              stroke={stroke}
              strokeWidth={1.25 / zoom}
              strokeDasharray={`${5 / zoom} ${3 / zoom}`}
            />
            {anchorW > 8 && anchorH > 6 && (
              <rect
                x={x0 + 8}
                y={y0 + 8}
                width={anchorW}
                height={anchorH}
                rx={Math.min(3, anchorH / 4)}
                fill="rgba(31,111,235,0.18)"
                stroke={stroke}
                strokeWidth={1 / zoom}
              />
            )}
          </g>
        );
      }
      if (toolName === 'ellipse') {
        return (
          <ellipse
            cx={rect.x + rect.w / 2}
            cy={rect.y + rect.h / 2}
            rx={Math.abs(rect.w / 2)}
            ry={Math.abs(rect.h / 2)}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'diamond') {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        return (
          <polygon
            points={`${cx},${rect.y} ${rect.x + rect.w},${cy} ${cx},${rect.y + rect.h} ${rect.x},${cy}`}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'table') {
        // Echo the eventual 3×3 grid so the user sees the table take shape
        // mid-drag instead of an empty rectangle. Internal lines are thinner
        // so the outer outline still reads as the bbox.
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        const x0 = rect.w < 0 ? rect.x + rect.w : rect.x;
        const y0 = rect.h < 0 ? rect.y + rect.h : rect.y;
        const ROWS = 3;
        const COLS = 3;
        const internal: React.ReactNode[] = [];
        for (let i = 1; i < ROWS; i++) {
          const ly = y0 + (i / ROWS) * h;
          internal.push(
            <line
              key={`pr-${i}`}
              x1={x0}
              y1={ly}
              x2={x0 + w}
              y2={ly}
              stroke={stroke}
              strokeOpacity={0.5}
              strokeWidth={1 / zoom}
              strokeDasharray={`${3 / zoom} ${3 / zoom}`}
            />,
          );
        }
        for (let i = 1; i < COLS; i++) {
          const lx = x0 + (i / COLS) * w;
          internal.push(
            <line
              key={`pc-${i}`}
              x1={lx}
              y1={y0}
              x2={lx}
              y2={y0 + h}
              stroke={stroke}
              strokeOpacity={0.5}
              strokeWidth={1 / zoom}
              strokeDasharray={`${3 / zoom} ${3 / zoom}`}
            />,
          );
        }
        return (
          <g pointerEvents="none">
            <rect
              x={x0}
              y={y0}
              width={w}
              height={h}
              fill="rgba(31,111,235,0.06)"
              stroke={stroke}
              strokeWidth={1.25 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
            {internal}
          </g>
        );
      }
    }
    if (preview.kind === 'creating-connector') {
      const { from, to, toShape } = preview;
      // Visual cue is just the moving line + endpoint dot. The snap on the
      // to-end is communicated by the dot's *position* (it slides onto the
      // shape's edge) and a fill change when bound. Plus a one-shot pulse
      // overlay (`SnapPulse`) when toShape transitions to a non-null id —
      // the keyed remount drives the CSS keyframe, no JS animation loop.
      return (
        <g pointerEvents="none">
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--refined)"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${5 / zoom} ${3 / zoom}`}
          />
          {toShape && (
            <SnapPulse
              key={`snap-${toShape}`}
              cx={to.x}
              cy={to.y}
              zoom={zoom}
            />
          )}
          <circle
            cx={to.x}
            cy={to.y}
            r={4 / zoom}
            fill={toShape ? 'var(--accent)' : 'var(--paper)'}
            stroke={toShape ? 'var(--paper)' : 'var(--refined)'}
            strokeWidth={1.5 / zoom}
          />
        </g>
      );
    }
    if (preview.kind === 'marquee') {
      const r = normalizeRect(preview.rect);
      return (
        <rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill="rgba(31,111,235,0.06)"
          stroke="var(--refined)"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          pointerEvents="none"
        />
      );
    }
    return null;
  }, [preview, zoom]);

  // cursor — driven by interaction-in-progress first (live drag/resize/
  // pan), then by the active tool, then by what's under the pointer in select
  // mode.
  const cursor = useMemo(() => {
    if (interactionKind === 'panning') return 'grabbing';
    if (interactionKind === 'dragging') return 'grabbing';
    if (interactionKind === 'creating-shape') return 'crosshair';
    if (interactionKind === 'creating-connector') return 'crosshair';
    if (interactionKind === 'marquee') return 'crosshair';
    if (interactionKind === 'resizing' || interactionKind === 'resizing-multi') {
      // Pick the right cursor for the active handle so an edge resize doesn't
      // show a corner cursor mid-drag. Read off the live interaction.
      const cur = interactionRef.current;
      if (cur.kind === 'resizing' || cur.kind === 'resizing-multi') {
        return cursorForHandle(cur.handle, 1, 1);
      }
      return 'nwse-resize';
    }
    if (interactionKind === 'rotating') return 'grabbing';
    if (
      interactionKind === 'drag-waypoint' ||
      interactionKind === 'create-waypoint' ||
      interactionKind === 'drag-endpoint' ||
      interactionKind === 'translate-connector' ||
      interactionKind === 'dragging-connector-label'
    ) {
      return 'grabbing';
    }

    const tool = bindings[activeTool]?.tool ?? 'select';
    if (tool !== 'select') return 'crosshair';

    // Idle in select mode — cursor follows hover.
    if (!hover) return 'default';
    if (hover.kind === 'shape-handle') {
      return cursorForHandle(hover.handle, 1, 1);
    }
    if (hover.kind === 'connector-handle') return 'grab';
    if (hover.kind === 'connector-label') return 'grab';
    if (hover.kind === 'shape') return 'grab';
    if (hover.kind === 'connector') return 'pointer';
    return 'default';
  }, [activeTool, bindings, hover, interactionKind]);

  // drop handling — library shapes from MoreShapesPopover and image files
  // from the OS file manager both arrive here as HTML5 drag-and-drop.
  const onDragOver = useCallback((e: React.DragEvent<SVGSVGElement>) => {
    const types = Array.from(e.dataTransfer.types);
    if (
      types.includes('application/x-vellum-library') ||
      types.includes('application/x-vellum-bundle') ||
      types.includes('application/x-vellum-icon') ||
      types.includes('Files')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<SVGSVGElement>) => {
      e.preventDefault();
      const world = eventToWorld({ clientX: e.clientX, clientY: e.clientY });

      // Personal library bundle drop — re-id and translate to cursor.
      // Security: the bundle is foreign JSON (the drag source could be any
      // window). Validate shape + sanitize iconSvg at the boundary.
      const bundleRaw = e.dataTransfer.getData('application/x-vellum-bundle');
      if (bundleRaw) {
        try {
          const raw = JSON.parse(bundleRaw);
          const safeShapes = parseShapes(
            (raw && typeof raw === 'object' && 'shapes' in raw ? raw.shapes : []) ?? [],
          );
          const safeConnectors = parseConnectors(
            (raw && typeof raw === 'object' && 'connectors' in raw
              ? raw.connectors
              : []) ?? [],
          );
          const bundle: { shapes: ShapeT[]; connectors: ConnectorT[] } = {
            shapes: safeShapes,
            connectors: safeConnectors,
          };
          const idMap = new Map<string, string>();
          const newShapes: ShapeT[] = bundle.shapes.map((sh) => {
            const id = newId(sh.kind);
            idMap.set(sh.id, id);
            return structuredClone({
              ...sh,
              id,
              x: sh.x + world.x,
              y: sh.y + world.y,
              parent: sh.parent ? idMap.get(sh.parent) ?? sh.parent : undefined,
            });
          });
          // Pass-2 fix-up for parent references that pointed at later shapes.
          for (const ns of newShapes) {
            if (ns.parent && idMap.has(ns.parent)) {
              ns.parent = idMap.get(ns.parent)!;
            }
          }
          const newConns: ConnectorT[] = bundle.connectors.map((c) => {
            const cloned = structuredClone(c);
            cloned.id = newId('c');
            if ('shape' in cloned.from && idMap.has(cloned.from.shape)) {
              cloned.from = { ...cloned.from, shape: idMap.get(cloned.from.shape)! };
            }
            if ('shape' in cloned.to && idMap.has(cloned.to.shape)) {
              cloned.to = { ...cloned.to, shape: idMap.get(cloned.to.shape)! };
            }
            return cloned;
          });
          // Append in one batch via store; group as a pseudo-paste.
          useEditor.setState((s) => {
            // Stamp fresh z values so the dropped bundle sits on top of
            // everything currently on the canvas. Without this the bundle
            // keeps the z values from when it was saved, which can be lower
            // than anything the user has drawn since.
            let topZ = 0;
            for (const sh of s.diagram.shapes) {
              if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
            }
            for (const cc of s.diagram.connectors) {
              if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
            }
            const stampedShapes = newShapes.map((sh) => ({ ...sh, z: ++topZ }));
            const stampedConns = newConns.map((cc) => ({ ...cc, z: ++topZ }));
            return {
              diagram: {
                ...s.diagram,
                shapes: [...s.diagram.shapes, ...stampedShapes],
                connectors: [...s.diagram.connectors, ...stampedConns],
              },
              dirty: true,
              selectedIds: stampedShapes.map((sh) => sh.id),
            };
          });
          useEditor.getState().commitHistory();
        } catch (err) {
          // Loud (was a quiet warn) so the next class of drop failure surfaces.
          console.error('library bundle drop failed', err);
        }
        return;
      }

      // Icon drop (vendor or iconify) — payload is just the id; we resolve
      // the SVG bytes + attribution at drop time. Async, so we await before
      // the addShape call so the shape lands in one history step.
      const iconRaw = e.dataTransfer.getData('application/x-vellum-icon');
      if (iconRaw) {
        try {
          const payload = JSON.parse(iconRaw) as IconDragPayload;
          const resolved = await resolveIcon(payload);
          const { w, h } = resolved.defaultSize;
          const id = newId('icon');
          addShape({
            id,
            kind: 'icon',
            x: world.x - w / 2,
            y: world.y - h / 2,
            w,
            h,
            layer: 'blueprint',
            iconSvg: resolved.svg,
            iconAttribution: resolved.attribution,
            iconConstraints: resolved.constraints,
          });
          // Auto-adopt into a container if the drop landed inside one.
          useEditor.getState().adoptIntoContainer(id);
          // Stamp the Recent feed. Glyph: 3-letter shorthand from the icon
          // id's last segment (`aws/ec2` → `EC2`, `mdi:database` → `DAT`).
          const tail =
            payload.source === 'vendor'
              ? payload.iconId.split('/').pop() ?? payload.iconId
              : payload.iconId.split(':').pop() ?? payload.iconId;
          useEditor.getState().recordRecent({
            key:
              payload.source === 'vendor'
                ? `vendor:${payload.iconId}`
                : `iconify:${payload.iconId}`,
            label: tail,
            glyph: tail.slice(0, 3).toUpperCase(),
            source:
              payload.source === 'vendor'
                ? { kind: 'vendor', iconId: payload.iconId, vendor: payload.vendor }
                : {
                    kind: 'iconify',
                    iconId: payload.iconId,
                    prefix: payload.prefix,
                  },
          });
        } catch (err) {
          console.error('icon drop: resolve failed', err);
        }
        return;
      }

      // Library shape drop
      const libRaw = e.dataTransfer.getData('application/x-vellum-library');
      if (libRaw) {
        try {
          const lib = JSON.parse(libRaw) as {
            id: string;
            label: string;
            glyph: string;
            lib?: string;
          };
          const w = 130;
          const h = 64;
          const id = newId(lib.id);
          addShape({
            id,
            kind: 'service',
            x: world.x - w / 2,
            y: world.y - h / 2,
            w,
            h,
            label: lib.label,
            icon: lib.glyph,
            layer: 'blueprint',
          });
          useEditor.getState().adoptIntoContainer(id);
          // Stamp the Recent feed.
          useEditor.getState().recordRecent({
            key: `library:${lib.id}`,
            label: lib.label,
            glyph: lib.glyph,
            source: {
              kind: 'library',
              libShapeId: lib.id,
              libName: lib.lib ?? '',
            },
          });
        } catch (err) {
          console.warn('library drop: bad payload', err);
        }
        return;
      }
      // OS file drop — accept images.
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          if (!file.type.startsWith('image/')) continue;
          let dataUrl: string;
          try {
            dataUrl = await fileToDataUrl(file);
          } catch (err) {
            console.warn('image drop rejected', err);
            alert('Image is too large to embed. Save it locally and import a smaller copy.');
            continue;
          }
          const dims = await imageDims(dataUrl);
          const maxW = 480;
          const scale = Math.min(1, maxW / dims.w);
          const w = dims.w * scale;
          const h = dims.h * scale;
          const id = newId('img');
          addShape({
            id,
            kind: 'image',
            x: world.x - w / 2,
            y: world.y - h / 2,
            w,
            h,
            src: dataUrl,
            layer: 'blueprint',
          });
          useEditor.getState().adoptIntoContainer(id);
        }
      }
    },
    [addShape, eventToWorld],
  );

  // right-click → open context menu
  const onContextMenu = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      e.preventDefault();
      const world = eventToWorld(e);
      // Right-click on a connector waypoint deletes that bend in one shot —
      // no menu needed (and the menu offers nothing else relevant for a bend).
      const handle = connectorHandleUnder(world);
      if (handle && handle.kind === 'waypoint') {
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === handle.connectorId);
        if (conn?.waypoints) {
          const next = conn.waypoints.slice();
          next.splice(handle.index, 1);
          useEditor
            .getState()
            .updateConnector(handle.connectorId, {
              waypoints: next.length ? next : undefined,
            });
        }
        return;
      }
      // Same z-priority rule as the left-click hit-test — right-click on a
      // connector that overlaps a shape should target the connector when it
      // sits visually on top.
      const shapeHit = shapeUnder(world);
      const connHit = connectorUnder(world);
      let target: NonNullable<typeof contextMenu>['target'];
      if (shapeHit && connHit) {
        const sz = shapeHit.z ?? 0;
        const cz = connHit.z ?? 0;
        target =
          cz >= sz
            ? { kind: 'connector', id: connHit.id }
            : { kind: 'shape', id: shapeHit.id };
      } else if (shapeHit) {
        // Right-click on a table → resolve to the specific cell so the
        // menu can offer cell-scoped ops (insert / delete row / col).
        if (shapeHit.kind === 'table') {
          const hit = cellAtPoint(shapeHit, world);
          target = hit
            ? { kind: 'cell', shapeId: shapeHit.id, row: hit.row, col: hit.col }
            : { kind: 'shape', id: shapeHit.id };
        } else {
          target = { kind: 'shape', id: shapeHit.id };
        }
      } else if (connHit) {
        target = { kind: 'connector', id: connHit.id };
      } else {
        target = { kind: 'canvas' };
      }
      setContextMenu({ x: e.clientX, y: e.clientY, target });
    },
    [eventToWorld, shapeUnder, connectorUnder, connectorHandleUnder],
  );

  // double-click → text edit on a shape, or fresh text shape on empty
  // canvas. The empty-canvas path mirrors Figma / Excalidraw: drop a small
  // text bounding box at the cursor and open it for typing immediately.
  //
  // Special case: double-clicking the icon a container is anchored to
  // re-opens the icon picker so the user can swap the icon without
  // hunting through the inspector. The container Shape listens for the
  // `vellum:open-icon-picker` event and pops its flyout — same component
  // as the empty-container "+" path; the flyout's pick handler detects
  // the existing anchor and replaces the icon in place.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const world = eventToWorld(e);
      // Plain-resolve first — this is what a single-click would land on.
      // If it's a group, double-click means "enter the group" and we stop
      // there. If it's something else, fall through to the existing
      // label/cell edit logic.
      const shapeHit = shapeUnder(world);
      // If the plain hit IS a group, the user is double-clicking the group's
      // body to enter it. Take the focus, bail out — don't open a label
      // editor (groups don't render labels anyway).
      if (shapeHit && shapeHit.kind === 'group') {
        useEditor.getState().setFocusedGroup(shapeHit.id);
        // Selecting nothing on entry mirrors Figma — entering a group is
        // an "I'm now operating inside this scope" gesture, not "select
        // every child". The user's next click picks the actual member.
        useEditor.getState().setSelected([]);
        return;
      }
      // Re-resolve with bypass so we know which actual member sits under
      // the cursor when the user dblclicks the body of a group's child.
      // Plain shapeUnder() already resolved children of the focused group
      // directly, so when we ARE focused this returns the same shape as
      // shapeHit. The bypass matters for the "not yet focused, dblclick
      // a child" case below — we want both the focus-enter side-effect
      // AND the inline editor to open in a single gesture.
      const pierceHit = shapeUnder(world, { bypassGroup: true });
      // Use the deepest hit for the actual edit so a dblclick on a member
      // of an already-focused group still opens that member's editor
      // (plain shapeUnder returns the member directly when focusedGroupId
      // is its parent, so shapeHit and pierceHit agree in that case).
      const hit = pierceHit ?? shapeHit;
      // If the deepest member belongs to a group we're not yet focused on,
      // enter focus on the ancestor group as a side-effect of the dblclick.
      // Saves a step: dblclick a member → focus enters AND its editor opens.
      if (hit && hit.parent) {
        const parent = rawShapes.find((s) => s.id === hit.parent);
        if (
          parent?.kind === 'group' &&
          useEditor.getState().focusedGroupId !== parent.id
        ) {
          useEditor.getState().setFocusedGroup(parent.id);
          useEditor.getState().setSelected([hit.id]);
        }
      }
      if (hit) {
        // Table cell-edit override — double-click on a table cell opens
        // InlineCellEditor over that cell, not the shape-level label
        // editor. cellAtPoint uses the same weighted layout the renderer
        // uses, so resized rows/cols hit-test correctly.
        if (hit.kind === 'table') {
          const cell = cellAtPoint(hit, world);
          if (cell) {
            useEditor
              .getState()
              .setEditingCell({ shapeId: hit.id, row: cell.row, col: cell.col });
          }
          return;
        }
        // Container-anchor-icon override. We check three things so the
        // override is precise: the hit is an icon, its parent is a
        // container, and that container's anchorId points back at this
        // exact icon. Loose icons that just happen to be parented to a
        // container (multi-icon containers) keep label-edit on dblclick.
        if (hit.kind === 'icon' && hit.parent) {
          const parent = rawShapes.find((s) => s.id === hit.parent);
          if (
            parent?.kind === 'container' &&
            parent.anchorId === hit.id
          ) {
            window.dispatchEvent(
              new CustomEvent('vellum:open-icon-picker', {
                detail: {
                  containerId: parent.id,
                  // Anchor the flyout at the click point so it pops up
                  // right where the user double-clicked. clientX/clientY
                  // are screen coords, which is what the flyout's portal
                  // expects.
                  x: e.clientX,
                  y: e.clientY,
                },
              }),
            );
            return;
          }
        }
        const ev = new CustomEvent('vellum:edit-shape', {
          detail: { id: hit.id },
        });
        window.dispatchEvent(ev);
        return;
      }
      // No shape hit — check for a connector. Double-clicking a connector
      // (anywhere along the line OR on its existing label) opens the
      // inline label editor for that connector. The same `vellum:edit-shape`
      // event drives both InlineLabelEditor and ConnectorLabelEditor; the
      // shape editor silently no-ops when the id isn't a shape, and vice
      // versa. Reusing the event keeps Canvas oblivious to which editor
      // will pick up the gesture — both listeners just look up by id.
      const connHit = connectorUnder(world);
      if (connHit) {
        useEditor.getState().setSelected(connHit.id);
        const ev = new CustomEvent('vellum:edit-shape', {
          detail: { id: connHit.id },
        });
        window.dispatchEvent(ev);
        return;
      }
      // Empty canvas double-click → create a shrink-wrapping text shape
      // (autoSize=true) at the click point and open the editor on it.
      // The store's autoFit sets the initial bbox from the empty content
      // (zero-width-space → one-line caret-height). fontSize matches the
      // bare-click text-tool drop (TEXT_DEFAULT_TOOL_FONT_SIZE = 28) so
      // double-clicking blank canvas and clicking with the text tool
      // produce the same starting size.
      const id = newId('text');
      addShape({
        id,
        kind: 'text',
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        label: '',
        autoSize: true,
        fontSize: TEXT_DEFAULT_TOOL_FONT_SIZE,
        layer: 'blueprint',
      });
      // Defer the edit signal one tick so the new shape is in the store before
      // InlineLabelEditor goes looking for it.
      setTimeout(() => {
        const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
        window.dispatchEvent(ev);
      }, 0);
    },
    [addShape, eventToWorld, rawShapes, shapeUnder],
  );

  return (
    <>
    <svg
      ref={svgRef}
      // `data-vellum-canvas` is the stable selector handleCopyPng uses so the
      // copy-as-PNG flow doesn't have to rely on `width="100%"` (which any
      // future chrome SVG could collide with).
      data-vellum-canvas=""
      width="100%"
      height="100%"
      viewBox={`0 0 ${viewport.w} ${viewport.h}`}
      preserveAspectRatio="xMinYMin meet"
      style={{
        display: 'block',
        background: canvasPaper ?? 'var(--paper)',
        cursor,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        // Mouse left the canvas — clear hover so the ring/cursor reset cleanly.
        setHover(null);
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <defs>
        <pattern
          id="dotgrid"
          width={24}
          height={24}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(${((pan.x % 24) + 24) % 24} ${((pan.y % 24) + 24) % 24})`}
        >
          {showGrid && (
            <>
              <line x1={0} y1={0} x2={24} y2={0} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
              <line x1={0} y1={0} x2={0} y2={24} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
            </>
          )}
          {showDots && (
            // Dot sits exactly at the grid line intersection so toggling both
            // on lines them up perfectly.
            <circle cx={0} cy={0} r={1.25} fill="var(--paper-grid)" />
          )}
        </pattern>
        {/* Notes-layer connector wobble. Applied as a filter on connector
         *  groups whose `layer === 'notes'` so lines + arrows pick up the
         *  same hand-drawn feel as Notes-layer shapes (which use jittered
         *  path math). feTurbulence + feDisplacementMap is a much cheaper
         *  approach than re-jittering each frame, and the seed is stable
         *  per-canvas so the wobble doesn't dance during pan/zoom. */}
        <filter id="notes-wobble" x="-2%" y="-10%" width="104%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.02"
            numOctaves="2"
            seed="3"
          />
          <feDisplacementMap in="SourceGraphic" scale="2.5" />
        </filter>
        {/* Notes-layer drop-shadow. Every Shape on the Notes layer references
         *  this via filter="url(#notes-glow)". Yellow drop-shadow rather than
         *  the previous symmetric halo — offset down + slightly right so the
         *  effect reads as a sticker dropped on the page, not a haze. The
         *  filter id is kept as `notes-glow` for back-compat (every callsite
         *  references it by that string). */}
        <filter id="notes-glow" x="-25%" y="-25%" width="150%" height="160%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
          <feOffset in="blur" dx="0.8" dy="2.2" result="offsetBlur" />
          <feFlood floodColor="rgb(var(--notes-glow))" floodOpacity="0.85" result="flood" />
          <feComposite in="flood" in2="offsetBlur" operator="in" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {(showDots || showGrid) && (
        <rect width="100%" height="100%" fill="url(#dotgrid)" />
      )}

      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {/* Frame bodies (groups + containers) always sit at the back so they
         *  don't paint over their children. Everything else (non-frame shapes
         *  + connectors) is rendered in unified z-order — the most-recently-
         *  drawn item wins the top slot until the user reorders. */}
        {visibleShapes
          .filter((s) => s.kind === 'group' || s.kind === 'container')
          .map((s) => (
            <Shape key={s.id} shape={s} />
          ))}
        {/* Focused-group halo — telegraphs "you're inside this group; clicks
         *  here resolve to its children, not the group itself". Sits behind
         *  the children but in front of the group's own (transparent) body
         *  so the accent ring is visible even when the group's bbox hugs
         *  its members. Soft fill + solid ring is intentionally distinct
         *  from the dashed selection halo (which is "this is selected") —
         *  focus is a scope cue, not a selection cue. */}
        {focusedGroupId &&
          (() => {
            const g = visibleShapes.find((s) => s.id === focusedGroupId);
            if (!g || g.kind !== 'group') return null;
            const pad = 6 / zoom;
            const w = Math.max(0, Math.abs(g.w));
            const h = Math.max(0, Math.abs(g.h));
            return (
              <g pointerEvents="none">
                {/* Soft fill — gives the focused group a faint accent wash
                 *  so the user reads "this is the active scope" at a
                 *  glance. Low opacity keeps it from competing with
                 *  contained shapes. */}
                <rect
                  x={g.x}
                  y={g.y}
                  width={w}
                  height={h}
                  rx={6}
                  fill="rgb(var(--accent-rgb) / 0.05)"
                  stroke="none"
                />
                {/* Solid accent ring just outside the group's bbox. Solid
                 *  (not dashed) intentionally differs from the dashed
                 *  selection halo so the user can tell them apart at a
                 *  glance. */}
                <rect
                  x={g.x - pad}
                  y={g.y - pad}
                  width={w + pad * 2}
                  height={h + pad * 2}
                  rx={8 / zoom}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5 / zoom}
                  opacity={0.65}
                />
              </g>
            );
          })()}
        {/* Drop-target glow — paints around any container that would adopt
         *  the dragged shape(s) (or auto-bind the dragged orphan connector)
         *  if released right now. Sits between the frame body and the
         *  z-ordered shape/connector layer, so the halo wraps the
         *  container's perimeter without obscuring its contents. The
         *  outer translucent fill softens the edge into a glow; the inner
         *  crisp accent ring carries the "yes, this is the target" cue.
         *  Strokes scale with `1/zoom` so the visual weight stays constant
         *  regardless of zoom level. */}
        {dropTargetIds.size > 0 && (
          <g pointerEvents="none">
            {[...dropTargetIds].map((id) => {
              const sh = visibleShapes.find((s) => s.id === id);
              if (!sh) return null;
              const w = Math.max(0, Math.abs(sh.w));
              const h = Math.max(0, Math.abs(sh.h));
              const outerPad = 8 / zoom;
              const innerPad = 2 / zoom;
              return (
                <g key={`drop-${id}`}>
                  {/* Outer soft halo — wide translucent stroke that blooms
                   *  outward from the container edge. Two stroke widths
                   *  layered for a faux-glow without paying for an SVG
                   *  filter (filters tank framerate during a drag). */}
                  <rect
                    x={sh.x - outerPad}
                    y={sh.y - outerPad}
                    width={w + outerPad * 2}
                    height={h + outerPad * 2}
                    rx={8 / zoom}
                    fill="rgb(var(--accent-rgb) / 0.06)"
                    stroke="rgb(var(--accent-rgb) / 0.22)"
                    strokeWidth={6 / zoom}
                  />
                  {/* Inner crisp accent ring sitting just outside the
                   *  container's frame. The dashed stroke matches the
                   *  hover-ring idiom so the user reads it as "active
                   *  binding target", not "selection". */}
                  <rect
                    x={sh.x - innerPad}
                    y={sh.y - innerPad}
                    width={w + innerPad * 2}
                    height={h + innerPad * 2}
                    rx={5 / zoom}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={1.75 / zoom}
                    strokeDasharray={`${5 / zoom} ${3 / zoom}`}
                  />
                </g>
              );
            })}
          </g>
        )}
        {(() => {
          type Item =
            | { kind: 'shape'; item: ShapeT }
            | { kind: 'connector'; item: ConnectorT };
          const items: Item[] = [
            ...visibleShapes
              .filter((s) => s.kind !== 'group' && s.kind !== 'container')
              .map((s) => ({ kind: 'shape' as const, item: s })),
            ...visibleConnectors.map((c) => ({
              kind: 'connector' as const,
              item: c,
            })),
          ];
          // Sort by z; tie-break by array position (already implicit via
          // stable sort on most engines).
          items.sort((a, b) => (a.item.z ?? 0) - (b.item.z ?? 0));
          return items.map((it) =>
            it.kind === 'shape' ? (
              <Shape key={`s-${it.item.id}`} shape={it.item} />
            ) : (
              <Connector
                key={`c-${it.item.id}`}
                conn={it.item}
                shapes={shapes}
                selected={selectedSet.has(it.item.id)}
              />
            ),
          );
        })()}

        {/* Hover ring — subtle accent outline on the shape under the cursor in
         *  select mode. Skip if the shape is already selected (the selection
         *  halo is already there) or if a gesture is in progress.
         *
         *  Wrapped in a rotation transform so the ring tracks the visual
         *  orientation of a rotated shape (group / freehand opt out of
         *  rotation per the SelectionOverlay convention; everything else
         *  rotates). Without this the ring sat axis-aligned over a rotated
         *  container and the user reported "everything rotates except the
         *  mouseover selection box". */}
        {hover &&
          hover.kind === 'shape' &&
          !selectedSet.has(hover.id) &&
          interactionKind === 'idle' &&
          (() => {
            const sh = visibleShapes.find((s) => s.id === hover.id);
            if (!sh) return null;
            const pad = 3;
            // Groups get a dashed bounding box (their normal frame) on hover
            // so the user knows it's a group; non-groups get a solid ring.
            const isFrame = sh.kind === 'group' || sh.kind === 'container';
            const rot = sh.rotation ?? 0;
            const supportsRotation =
              sh.kind !== 'group' && sh.kind !== 'freehand';
            const cx = sh.x + sh.w / 2;
            const cy = sh.y + sh.h / 2;
            const transform =
              supportsRotation && rot && Number.isFinite(rot)
                ? `rotate(${rot} ${cx} ${cy})`
                : undefined;
            return (
              <g key={`hover-${sh.id}`} transform={transform}>
                <rect
                  x={sh.x - pad}
                  y={sh.y - pad}
                  width={sh.w + pad * 2}
                  height={sh.h + pad * 2}
                  rx={4 / zoom}
                  fill="none"
                  stroke="var(--refined)"
                  strokeWidth={1.25 / zoom}
                  strokeDasharray={isFrame ? `${6 / zoom} ${4 / zoom}` : undefined}
                  opacity={isFrame ? 0.7 : 0.5}
                  pointerEvents="none"
                />
              </g>
            );
          })()}

        {/* Hover-edge connector affordance (rebuilt 2026-04-28 v3 — Josh:
         *  "way more subtle, gap from shape, only one near the hovered
         *  edge, 100ms dwell"). Single small "+" button placed just outside
         *  the edge the cursor is closest to, paper-fill with a thin
         *  ink-muted stroke so it reads as a quiet affordance rather than
         *  a UI shout. The state machine in `updateEdgeAffordance` handles
         *  the 100ms first-show debounce and the side-swap-on-the-fly
         *  when the cursor moves to a different edge.
         *
         *  Sized in SCREEN pixels so the glyph stays readable at any zoom.
         *  Hit-test in pointerdown uses the same geometry as this render
         *  block — keep them in sync if the offset / radius / gap change. */}
        {hoverEdgeConnectors &&
          hoverEdgeAffordance &&
          interactionKind === 'idle' &&
          (() => {
            const sh = visibleShapes.find(
              (s) => s.id === hoverEdgeAffordance.shapeId,
            );
            if (!sh) return null;
            if (sh.kind === 'group' || sh.kind === 'freehand') return null;
            if (selectedSet.has(sh.id)) return null;
            const R = 6 / zoom; // tiny — the affordance is a hint, not a tile
            const gap = 6 / zoom; // breathing room between shape edge and "+"
            const off = R + gap; // button-centre distance from shape edge
            const center = (() => {
              switch (hoverEdgeAffordance.side) {
                case 'top':
                  return { cx: sh.x + sh.w / 2, cy: sh.y - off };
                case 'right':
                  return { cx: sh.x + sh.w + off, cy: sh.y + sh.h / 2 };
                case 'bottom':
                  return { cx: sh.x + sh.w / 2, cy: sh.y + sh.h + off };
                case 'left':
                  return { cx: sh.x - off, cy: sh.y + sh.h / 2 };
              }
            })();
            const tickLen = R * 0.5;
            const tickStroke = 1 / zoom;
            // Match the hover-ring's rotation handling so the affordance
            // tracks rotated shapes. The pointerdown hit-test inverse-
            // rotates the cursor into this frame so visible + click stay
            // aligned.
            const rot = sh.rotation ?? 0;
            const rcx = sh.x + sh.w / 2;
            const rcy = sh.y + sh.h / 2;
            const transform =
              rot && Number.isFinite(rot)
                ? `rotate(${rot} ${rcx} ${rcy})`
                : undefined;
            // Capture the side here so the onPointerDown closure binds to
            // the rendered side at the moment the JSX evaluated, not the
            // possibly-mutated ref by the time the user actually clicks.
            const sideAtRender = hoverEdgeAffordance.side;
            return (
              <g
                key={`edge-conn-${sh.id}-${hoverEdgeAffordance.side}`}
                style={{ pointerEvents: 'none' }}
                transform={transform}
                opacity={0.7}
              >
                {/* Subtle button: paper fill, ink-muted hairline stroke,
                 *  ink-muted "+" glyph. No halo, no accent fill — those
                 *  read as a primary call-to-action rather than a quiet
                 *  hint.
                 *
                 *  The disc itself owns the pointerdown handler (rather
                 *  than relying on the canvas's pointerdown branch via
                 *  the affordance hit-test) because the canvas useCallback
                 *  closure didn't list `hoverEdgeAffordance` in its deps,
                 *  so the dispatched click was ending up in the marquee /
                 *  shape-select fallthrough every time. Owning the click
                 *  on the disc itself makes the affordance work
                 *  regardless of how the surrounding callback is memoised.
                 *
                 *  Capture on the SVG (via `svgRef.current.setPointerCapture`)
                 *  routes subsequent pointermove + pointerup back to the
                 *  canvas handlers, so the existing creating-connector
                 *  pipeline picks up from there without modification. */}
                <circle
                  cx={center.cx}
                  cy={center.cy}
                  r={R}
                  fill="var(--paper)"
                  stroke="var(--ink-muted)"
                  strokeWidth={1 / zoom}
                  // Override the parent g's pointerEvents:none so the disc
                  // accepts clicks while the "+" lines stay transparent
                  // (so they don't intercept clicks meant for the disc).
                  style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                  onPointerDown={(e) => {
                    // Stop the canvas's own pointerdown from also running
                    // — would race with our setInteraction below.
                    e.stopPropagation();
                    e.preventDefault();
                    const world = eventToWorld(e);
                    const fromPoint = endpointAt(
                      sh,
                      sideAtRender,
                      world,
                      rawShapes,
                    );
                    setInteraction({
                      kind: 'creating-connector',
                      fromShape: sh.id,
                      fromAnchor: sideAtRender,
                      fromPoint,
                      current: world,
                      fromShapeRaw: sh.id,
                      // 'select' lets the up-handler reuse the proven
                      // space-drag connector commit semantics — orthogonal
                      // routing default + arrow-on-to-end + sticky styles.
                      toolName: 'select',
                    });
                    setPreview({
                      kind: 'creating-connector',
                      from: fromPoint,
                      to: world,
                      fromShape: sh.id,
                      toShape: null,
                    });
                    // Capture on the disc itself (e.currentTarget). React
                    // synthetic pointer events bubble, so subsequent
                    // pointermove + pointerup fire on the disc AND
                    // bubble up to the SVG, where the canvas's
                    // onPointerMove / onPointerUp handlers pick them up
                    // and the existing creating-connector pipeline takes
                    // over. We don't capture on the SVG because some
                    // browsers refuse setPointerCapture on an element
                    // that didn't receive the original pointerdown.
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    pointerDownRef.current = e.pointerId;
                  }}
                />
                <line
                  x1={center.cx - tickLen}
                  y1={center.cy}
                  x2={center.cx + tickLen}
                  y2={center.cy}
                  stroke="var(--ink-muted)"
                  strokeWidth={tickStroke}
                  strokeLinecap="round"
                />
                <line
                  x1={center.cx}
                  y1={center.cy - tickLen}
                  x2={center.cx}
                  y2={center.cy + tickLen}
                  stroke="var(--ink-muted)"
                  strokeWidth={tickStroke}
                  strokeLinecap="round"
                />
              </g>
            );
          })()}

        {/* Hover halo on connectors — brighter glow under the line when the
         *  cursor is on it. Uses `buildPath` so the halo traces the actual
         *  rendered geometry (curves stay curved) instead of a chord. */}
        {hover &&
          hover.kind === 'connector' &&
          !selectedSet.has(hover.id) &&
          interactionKind === 'idle' &&
          (() => {
            const c = visibleConnectors.find((cc) => cc.id === hover.id);
            if (!c) return null;
            const path = resolveConnectorPath(c, rawShapes);
            if (!path) return null;
            const d = buildPath(
              c.routing,
              path.fx,
              path.fy,
              path.tx,
              path.ty,
              path.fromAnchor,
              path.toAnchor,
              c.waypoints,
              path.fromRot,
              path.toRot,
            );
            return (
              <path
                key={`hover-c-${c.id}`}
                d={d}
                fill="none"
                stroke="var(--refined)"
                strokeWidth={4 / zoom}
                opacity={0.18}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            );
          })()}

        {/* Marquee live preview — render a "candidate" halo for every shape
         *  and connector that *would* be selected if the user released the
         *  pointer right now. Rule is fully-contained, so partial-overlap
         *  shapes intentionally stay neutral and the user gets immediate
         *  feedback that they need to enclose more of the rect. */}
        {preview &&
          preview.kind === 'marquee' &&
          (preview.shapeIds.length > 0 || preview.connectorIds.length > 0) &&
          (() => {
            const shapeIdSet = new Set(preview.shapeIds);
            const connIdSet = new Set(preview.connectorIds);
            const candidateShapes = visibleShapes.filter((s) =>
              shapeIdSet.has(s.id),
            );
            const candidateConnectors = visibleConnectors.filter((c) =>
              connIdSet.has(c.id),
            );
            return (
              <g pointerEvents="none">
                {candidateShapes.map((s) => (
                  <MarqueeCandidateHalo
                    key={`mc-s-${s.id}`}
                    shape={s}
                    zoom={zoom}
                  />
                ))}
                {candidateConnectors.map((c) => {
                  const path = resolveConnectorPath(c, rawShapes);
                  if (!path) return null;
                  const d = buildPath(
                    c.routing,
                    path.fx,
                    path.fy,
                    path.tx,
                    path.ty,
                    path.fromAnchor,
                    path.toAnchor,
                    c.waypoints,
                    path.fromRot,
                    path.toRot,
                  );
                  return (
                    <path
                      key={`mc-c-${c.id}`}
                      d={d}
                      fill="none"
                      stroke="var(--refined)"
                      strokeWidth={4 / zoom}
                      opacity={0.28}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
              </g>
            );
          })()}

        {/* Selection overlay — halos + corner handles for selected shapes. */}
        {selectedShapes.map((s) => (
          <SelectionOverlay key={`sel-${s.id}`} shape={s} zoom={zoom} />
        ))}

        {/* Connector waypoint + midpoint handles for selected connectors. */}
        {visibleConnectors
          .filter((c) => selectedSet.has(c.id))
          .map((c) => {
            const poly = connectorSegmentPolyline(c);
            if (!poly) return null;
            return (
              <ConnectorHandles
                key={`ch-${c.id}`}
                connector={c}
                poly={poly}
                zoom={zoom}
              />
            );
          })}

        {/* Live preview (creation rect, marquee, connector rubber-band). */}
        {previewEl}

        {/* Cmd-hold snap-to-align guides — drawn only while a shape drag is
         *  in progress and the snap engages. Lines extend across the visible
         *  world rectangle so the user can see exactly which edges line up.
         *  Pan/zoom transform is already applied by the parent <g>, so we
         *  span the screen viewport in world units derived from the current
         *  pan + zoom. */}
        {alignGuides && (
          <g pointerEvents="none">
            {(() => {
              // Convert the screen viewport to world-space bounds so guide
              // lines run edge to edge regardless of pan/zoom.
              const minWX = -pan.x / zoom;
              const minWY = -pan.y / zoom;
              const maxWX = (viewport.w - pan.x) / zoom;
              const maxWY = (viewport.h - pan.y) / zoom;
              const stroke = 'var(--accent)';
              const sw = 1 / zoom;
              const dash = `${4 / zoom} ${3 / zoom}`;
              return (
                <>
                  {alignGuides.vx.map((vx, i) => (
                    <line
                      key={`gv-${i}-${vx}`}
                      x1={vx}
                      y1={minWY}
                      x2={vx}
                      y2={maxWY}
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      opacity={0.85}
                    />
                  ))}
                  {alignGuides.hy.map((hy, i) => (
                    <line
                      key={`gh-${i}-${hy}`}
                      x1={minWX}
                      y1={hy}
                      x2={maxWX}
                      y2={hy}
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      opacity={0.85}
                    />
                  ))}
                </>
              );
            })()}
          </g>
        )}

        {/* In-flight freehand pen path. Stroke colour/width come from the
         *  live store values so PenPanel changes show up while drawing —
         *  not only after the stroke is committed. */}
        {penPath && penPath.length >= 2 && (
          <path
            d={buildSmoothPath(penPath)}
            fill="none"
            stroke={penColor}
            strokeWidth={penWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}

        {/* Laser pointer trail — Excalidraw-style comet trail rendered as
         *  K layered polylines. Each layer is a single connected path
         *  starting progressively closer to the head: layer 0 covers the
         *  full trail (dim afterglow), layer K-1 covers only the newest
         *  1/K (brightest head). Stroke opacity per layer is constant; the
         *  visible fade comes from alpha compositing of overlapping layers
         *  — the head sees K layers stacked, the tail sees only 1.
         *
         *  Why this shape rather than alternatives:
         *
         *  • Per-segment <line> elements with their own strokeOpacity give
         *    a perfect per-point fade, but strokeLinecap="round" puts a
         *    half-circle at every segment endpoint. When the cursor moves
         *    slowly, consecutive samples cluster spatially — the round
         *    caps eclipse the line itself and the trail reads as a string
         *    of dots. strokeLinecap="butt" eliminates the dots but leaves
         *    triangular gaps at sharp joins. Neither is acceptable.
         *
         *  • One connected <path> with a stroke linearGradient gives the
         *    smoothest possible fade, but the gradient runs in spatial
         *    coordinates (first→last in userSpace). When the cursor
         *    doubles back, the gradient axis no longer correlates with
         *    traversal order — newest points project onto the wrong side
         *    of the axis, the fade smears into bands, and if first ≈ last
         *    spatially the gradient direction degenerates and the whole
         *    trail flashes one color. Unusable for a laser pointer.
         *
         *  • Layered polylines sidestep both. Each layer is a single
         *    <path> with strokeLinejoin="round" so internal corners are
         *    filled cleanly with no per-segment caps. strokeLinecap="butt"
         *    on the layer ends means the layer-start positions don't show
         *    up as round blobs along the trail — they're invisible
         *    perpendicular slices that only contribute opacity. Doubling
         *    back is a non-issue because each layer carries uniform
         *    opacity; self-crossings alpha-blend cleanly.
         *
         *  K=10 layers with α=0.18 yields a tail-to-head opacity ramp
         *  from ~0.18 to ~0.86 in 10 evenly-spaced steps — visually
         *  smooth, no perceivable banding at the boundaries.
         *
         *  Dot anchoring: while the laser is HELD (interactionKind ===
         *  'laser'), the leading dot is pinned to the live cursor ref so a
         *  click-and-hold-without-moving still shows a visible pointer
         *  even after all trail points have aged out. On release the dot
         *  falls back to the most recent fresh trail point and fades with
         *  the trail. */}
        {(laserTrail.length >= 1 || interactionKind === 'laser') && (
          (() => {
            const now = performance.now();
            const fresh = laserTrail.filter((p) => now - p.t < 700);
            const heldCursor =
              interactionKind === 'laser' ? laserCursorRef.current : null;
            if (fresh.length === 0 && !heldCursor) return null;
            // Dot position: prefer the live cursor while held; fall back to
            // the most recent fresh trail point as the trail fades out.
            const dotPos =
              heldCursor ?? (fresh.length > 0 ? fresh[fresh.length - 1] : null);
            // Global fade for the post-release dissolve. While the user is
            // moving, the youngest point was just added (headAge ≈ 0) so
            // the trail renders at full intensity. When motion stops, all
            // layers fade together over the 700ms window.
            const headAge =
              fresh.length > 0
                ? (now - fresh[fresh.length - 1].t) / 700
                : 1;
            const globalFade = Math.max(0, 1 - headAge);
            const dotOpacity = heldCursor ? 1 : globalFade;
            const N = fresh.length;
            const K = 10;
            const layerAlpha = 0.18;
            return (
              <g pointerEvents="none">
                {N >= 2 &&
                  Array.from({ length: K }, (_, k) => {
                    // Layer k starts at index startIdx and runs to the head.
                    // Each successive layer starts further toward the head,
                    // so the head accumulates opacity from all K layers and
                    // the tail accumulates from just layer 0.
                    const startIdx = Math.floor((k * (N - 1)) / K);
                    const slice = fresh.slice(startIdx);
                    if (slice.length < 2) return null;
                    const d =
                      `M ${slice[0].x} ${slice[0].y} ` +
                      slice
                        .slice(1)
                        .map((p) => `L ${p.x} ${p.y}`)
                        .join(' ');
                    return (
                      <path
                        key={k}
                        d={d}
                        fill="none"
                        stroke="#ff2d55"
                        strokeOpacity={layerAlpha * globalFade}
                        strokeWidth={3.5 / zoom}
                        strokeLinecap="butt"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                {/* Solid dot at the leading end — this is the actual
                 *  "pointer". Stays full-opacity until the gesture ends. */}
                {dotPos && (
                  <circle
                    cx={dotPos.x}
                    cy={dotPos.y}
                    r={5 / zoom}
                    fill="#ff2d55"
                    opacity={dotOpacity}
                  />
                )}
              </g>
            );
          })()
        )}
      </g>
    </svg>
    {contextMenu && (
      <ContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    )}
    </>
  );
}

/** Selected-connector handles — real waypoints (filled circles) + segment
 *  midpoint affordances (small ghost circles). All positions are in world
 *  coords; stroke widths divide by zoom so they stay crisp at any scale. */
function ConnectorHandles({
  connector,
  poly,
  zoom,
}: {
  connector: ConnectorT;
  poly: { x: number; y: number }[];
  zoom: number;
}) {
  return (
    <g pointerEvents="none">
      {/* Midpoint affordances between every consecutive pair of polyline pts.
       *  These are drag-to-bend handles — drawn small + low opacity so they
       *  read as ghosty hints rather than first-class controls. */}
      {poly.slice(0, -1).map((p, i) => {
        const q = poly[i + 1];
        const mx = (p.x + q.x) / 2;
        const my = (p.y + q.y) / 2;
        return (
          <circle
            key={`mid-${i}`}
            cx={mx}
            cy={my}
            r={5 / zoom}
            fill="var(--paper)"
            stroke="var(--refined)"
            strokeWidth={1.25 / zoom}
            opacity={0.75}
          />
        );
      })}
      {/* Real waypoints — bigger, filled. */}
      {(connector.waypoints ?? []).map((w, i) => (
        <circle
          key={`wp-${i}`}
          cx={w.x}
          cy={w.y}
          r={6 / zoom}
          fill="var(--refined)"
          stroke="var(--paper)"
          strokeWidth={1.5 / zoom}
        />
      ))}
    </g>
  );
}

/** Live marquee candidate halo — rendered while the user is dragging a
 *  marquee, for every shape that *would* be selected on release. Same dashed
 *  ring as SelectionOverlay (so the visual identity is "this is selected") but
 *  no corner handles, since this is a preview not a selection state.
 *
 *  Why match the selection halo: anything weaker (lighter stroke, different
 *  colour) reads as a separate "could be selected" state and the user has to
 *  decode it. Identical halo means "release now and you get exactly this." */
function MarqueeCandidateHalo({
  shape,
  zoom,
}: {
  shape: ShapeT;
  zoom: number;
}) {
  const pad = 4;
  const stroke = 'var(--refined)';
  const x = shape.x - pad;
  const y = shape.y - pad;
  const w = shape.w + pad * 2;
  const h = shape.h + pad * 2;
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill="none"
      stroke={stroke}
      strokeWidth={1.25 / zoom}
      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      rx={4 / zoom}
    />
  );
}

/** Selection overlay — dashed halo + 4 corner handles + 4 edge handles.
 *  Lives in world coords inside the transform group, so we divide stroke
 *  widths by zoom to keep the visuals consistent at any scale.
 *
 *  Edge handles are skipped for icon shapes with locked aspect ratio: a
 *  single-axis drag would have to be force-converted to a corner-style
 *  uniform scale, which makes the cursor lie about what the handle does.
 *  Hide them entirely instead. */
function SelectionOverlay({ shape, zoom }: { shape: ShapeT; zoom: number }) {
  const pad = 4;
  const stroke = 'var(--refined)';
  const x = shape.x - pad;
  const y = shape.y - pad;
  const w = shape.w + pad * 2;
  const h = shape.h + pad * 2;
  const lockAspect =
    shape.kind === 'icon' && shape.iconConstraints?.lockAspect === true;
  // Text shapes get the four corners + LEFT/RIGHT edges only (no top/bottom
  // edges — text height is a function of wrap width × content, not a
  // standalone axis the user controls). Corner drags scale typeface; e/w
  // drags set wrap width. Mirrors the hit-test filtering in handleUnder.
  const textHEdgesOnly = shape.kind === 'text';
  // Every kind except group / freehand opts in to the rotation handle.
  // Vendor icons used to ship with `lockRotation: true` (the trademark
  // safety default), but VENDOR_CONSTRAINTS in src/icons/resolve.ts now
  // allows rotation — so an icon's lockRotation is only true if a future
  // vendor pack opts back in.
  const showRotateHandle =
    shape.kind !== 'group' &&
    shape.kind !== 'freehand' &&
    !(shape.kind === 'icon' && shape.iconConstraints?.lockRotation === true);
  // The selection halo + handles rotate WITH the shape so the user sees a
  // box that matches the rendered orientation. We render every position in
  // un-rotated coords below and let the wrapping <g transform="rotate(…)">
  // handle the rotation — this keeps the math identical to the un-rotated
  // case and avoids re-deriving handle positions per angle.
  const rotation = shape.rotation ?? 0;
  const supportsRotation = shape.kind !== 'group' && shape.kind !== 'freehand';
  const rotCx = shape.x + shape.w / 2;
  const rotCy = shape.y + shape.h / 2;
  const overlayTransform =
    supportsRotation && rotation && Number.isFinite(rotation)
      ? `rotate(${rotation} ${rotCx} ${rotCy})`
      : undefined;
  const corners: { h: Handle; cx: number; cy: number }[] = [
    { h: 'nw', cx: shape.x, cy: shape.y },
    { h: 'ne', cx: shape.x + shape.w, cy: shape.y },
    { h: 'sw', cx: shape.x, cy: shape.y + shape.h },
    { h: 'se', cx: shape.x + shape.w, cy: shape.y + shape.h },
  ];
  const edges: { h: Handle; cx: number; cy: number }[] = lockAspect
    ? []
    : textHEdgesOnly
      ? [
          { h: 'e', cx: shape.x + shape.w, cy: shape.y + shape.h / 2 },
          { h: 'w', cx: shape.x, cy: shape.y + shape.h / 2 },
        ]
      : [
          { h: 'n', cx: shape.x + shape.w / 2, cy: shape.y },
          { h: 's', cx: shape.x + shape.w / 2, cy: shape.y + shape.h },
          { h: 'e', cx: shape.x + shape.w, cy: shape.y + shape.h / 2 },
          { h: 'w', cx: shape.x, cy: shape.y + shape.h / 2 },
        ];
  const handleSize = 6 / zoom;
  // Rotation handle position: top-center, ROTATE_HANDLE_OFFSET screen pixels
  // above the shape (divided by zoom so the offset stays constant on screen
  // regardless of zoom level — same trick we use for the corner handle size).
  const rotHandleX = shape.x + shape.w / 2;
  const rotHandleY = shape.y - ROTATE_HANDLE_OFFSET / zoom;
  const rotHandleR = 5 / zoom;
  return (
    <g pointerEvents="none" transform={overlayTransform}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25 / zoom}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        rx={4 / zoom}
      />
      {corners.map(({ h: kind, cx, cy }) => (
        <rect
          key={kind}
          x={cx - handleSize / 2}
          y={cy - handleSize / 2}
          width={handleSize}
          height={handleSize}
          fill="var(--paper)"
          stroke={stroke}
          strokeWidth={1 / zoom}
          style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
        />
      ))}
      {edges.map(({ h: kind, cx, cy }) => {
        // Text shapes show their e/w handles as TALL VERTICAL BARS (≈60%
        // of the bbox height), not the small square dots we use elsewhere.
        // The bar shape communicates "drag me sideways to change the wrap
        // width" — the user requested this affordance specifically because
        // the square corner-style handle felt like a one-axis re-aim of the
        // corner, which made the wrap mechanic invisible.
        if (textHEdgesOnly && (kind === 'e' || kind === 'w')) {
          const barW = 4 / zoom;
          const barH = Math.max(shape.h * 0.6, 14 / zoom);
          return (
            <rect
              key={kind}
              x={cx - barW / 2}
              y={cy - barH / 2}
              width={barW}
              height={barH}
              rx={barW / 2}
              fill="var(--paper)"
              stroke={stroke}
              strokeWidth={1 / zoom}
              style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
            />
          );
        }
        return (
          <rect
            key={kind}
            x={cx - handleSize / 2}
            y={cy - handleSize / 2}
            width={handleSize}
            height={handleSize}
            fill="var(--paper)"
            stroke={stroke}
            strokeWidth={1 / zoom}
            style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
          />
        );
      })}
      {showRotateHandle && (
        <g>
          {/* Tether line from the top-center of the bbox to the rotate
           *  knob. Pure visual affordance — communicates "this knob belongs
           *  to that shape" without needing a tooltip. */}
          <line
            x1={shape.x + shape.w / 2}
            y1={shape.y}
            x2={rotHandleX}
            y2={rotHandleY + rotHandleR}
            stroke={stroke}
            strokeWidth={1 / zoom}
            strokeDasharray={`${2 / zoom} ${2 / zoom}`}
          />
          {/* Round knob — distinct shape from the square resize handles so
           *  there's no chance of confusing the two. */}
          <circle
            cx={rotHandleX}
            cy={rotHandleY}
            r={rotHandleR}
            fill="var(--paper)"
            stroke={stroke}
            strokeWidth={1 / zoom}
            style={{ cursor: 'grab' }}
          />
        </g>
      )}
    </g>
  );
}

// small utils
/** Translate a polyline-segment index into the index where a new waypoint
 *  should be inserted in the connector's `waypoints` array. */
function waypointInsertIndex(
  c: import('@/store/types').Connector,
  segIndex: number,
): number {
  // poly = [from, ...waypoints, to] → segment i sits between poly[i] and
  // poly[i+1]. Insert at i (i.e. push between waypoints[i-1] and waypoints[i]).
  void c;
  return segIndex;
}

/** Find the polyline-segment index nearest to `p` for an arbitrary connector
 *  — used when the user clicks anywhere on a selected line body to bend it.
 *  Walks the same polyline the hit-tester uses so curved/orthogonal routes
 *  are handled consistently. */
function segmentIndexAt(
  c: import('@/store/types').Connector,
  p: { x: number; y: number },
  shapes: import('@/store/types').Shape[],
): number {
  const path = resolveConnectorPath(c, shapes);
  if (!path) return 0;
  const { fx, fy, tx, ty, fromAnchor, toAnchor, fromRot, toRot } = path;
  let pts: { x: number; y: number }[];
  if (c.routing === 'orthogonal') {
    pts =
      c.waypoints && c.waypoints.length
        ? [{ x: fx, y: fy }, ...c.waypoints, { x: tx, y: ty }]
        : buildOrthogonalPolyline(
            fx,
            fy,
            tx,
            ty,
            fromAnchor,
            toAnchor,
            fromRot,
            toRot,
          );
  } else if (c.routing === 'curved') {
    pts = sampleCurvedPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      c.waypoints,
      fromRot,
      toRot,
    );
  } else {
    pts =
      c.waypoints && c.waypoints.length
        ? [{ x: fx, y: fy }, ...c.waypoints, { x: tx, y: ty }]
        : [
            { x: fx, y: fy },
            { x: tx, y: ty },
          ];
  }
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointSegDist(p, pts[i], pts[i + 1]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** One-shot snap pulse — a single thin ring that expands and fades when a
 *  connector endpoint clicks onto a shape during creation. Keyed remount
 *  drives the animation; the existing endpoint dot (paper→accent fill swap)
 *  carries the steady-state "snapped" signal.
 *
 *  Implementation note: SVG `transform-origin` defaults to the user
 *  coordinate system (the SVG viewBox), so the cx/cy length values name a
 *  point in world coords and the scale animates IN PLACE. Earlier we set
 *  `transform-box: fill-box`, which reinterprets transform-origin lengths
 *  relative to the bounding-box top-left — that put the origin at
 *  (bboxLeft + cx, bboxTop + cy) ≈ off-circle, so the ring slid across the
 *  screen during the scale animation instead of expanding around the snap
 *  point. Visible as a stray dot drifting away from the connector. */
function SnapPulse({
  cx,
  cy,
  zoom,
}: {
  cx: number;
  cy: number;
  zoom: number;
}) {
  const ringStyle: React.CSSProperties = {
    transformOrigin: `${cx}px ${cy}px`,
    animation: 'vellum-snap-pulse 220ms ease-out forwards',
  };
  return (
    <circle
      cx={cx}
      cy={cy}
      r={8 / zoom}
      fill="none"
      stroke="var(--accent)"
      strokeWidth={1.25 / zoom}
      opacity={0}
      style={ringStyle}
      pointerEvents="none"
    />
  );
}

function pointSegDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/** Soft cap on image-paste/-drop size. Above this we refuse rather than
 *  bloat the autosave + localStorage backup + diagram file. 8 MiB raw is
 *  generous for diagram use; anything bigger should be linked, not embedded. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(
        new Error(
          `image too large (${(file.size / 1024 / 1024).toFixed(1)} MiB > ${MAX_IMAGE_BYTES / 1024 / 1024} MiB)`,
        ),
      );
      return;
    }
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function imageDims(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 320, h: 240 });
    img.src = src;
  });
}

function segHit(
  p: Pt,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tol: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - ax;
    const ddy = p.y - ay;
    return ddx * ddx + ddy * ddy <= tol * tol;
  }
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= tol * tol;
}

/** Resolve the world-space point of a connector endpoint, with the cursor's
 *  position as the "other side" so `auto` anchors lock onto a sensible edge. */
function endpointAt(
  fromShape: ShapeT,
  anchor: Anchor,
  cursor: { x: number; y: number },
  shapes: ShapeT[],
): { x: number; y: number } {
  const ep = resolveEndpointPoint(
    { shape: fromShape.id, anchor },
    { x: cursor.x, y: cursor.y },
    shapes,
  );
  if (ep) return { x: ep.x, y: ep.y };
  return { x: fromShape.x + fromShape.w / 2, y: fromShape.y + fromShape.h / 2 };
}

/** Snap-to-align: for a tentative drag bbox, find the smallest dx/dy that
 *  pulls one of the bbox's nine reference lines (left/center/right ×
 *  top/center/bottom) onto a matching reference line of any non-dragged
 *  shape. Only deltas within `threshold` (world units) on each axis are
 *  considered. Returns the suggested offset plus the reference x/y values
 *  that triggered the snap, so the caller can render alignment guides.
 *
 *  Cmd-only feature: this runs only while the drag handler sees the
 *  modifier held, so users who don't want snapping pay no cost. */
function computeAlignSnap(
  bbox: { x: number; y: number; w: number; h: number },
  others: ShapeT[],
  threshold: number,
): { dx: number; dy: number; vx: number[]; hy: number[] } {
  const sourceX = [bbox.x, bbox.x + bbox.w / 2, bbox.x + bbox.w];
  const sourceY = [bbox.y, bbox.y + bbox.h / 2, bbox.y + bbox.h];
  let bestDx = 0;
  let bestAbsX = threshold;
  let bestDy = 0;
  let bestAbsY = threshold;
  // Collect all reference lines from other shapes — one pass so guides can
  // include every alignment that happens to coincide at the snap distance.
  const targetX: number[] = [];
  const targetY: number[] = [];
  for (const o of others) {
    if (o.w === 0 && o.h === 0) continue;
    targetX.push(o.x, o.x + o.w / 2, o.x + o.w);
    targetY.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  for (const sx of sourceX) {
    for (const tx of targetX) {
      const delta = tx - sx;
      const abs = Math.abs(delta);
      if (abs <= bestAbsX) {
        bestAbsX = abs;
        bestDx = delta;
      }
    }
  }
  for (const sy of sourceY) {
    for (const ty of targetY) {
      const delta = ty - sy;
      const abs = Math.abs(delta);
      if (abs <= bestAbsY) {
        bestAbsY = abs;
        bestDy = delta;
      }
    }
  }
  // Snap accepted on each axis only if a real candidate beat the threshold.
  // Re-walk the targets and emit guides for every reference line that lies
  // on the snapped position (so multi-shape alignment shows multiple lines).
  const SNAP_EPS = 0.5; // tolerate floating-point drift
  const vx: number[] = [];
  const hy: number[] = [];
  if (bestAbsX < threshold) {
    const finalSourceX = sourceX.map((sx) => sx + bestDx);
    for (const tx of targetX) {
      if (finalSourceX.some((fx) => Math.abs(fx - tx) < SNAP_EPS)) {
        if (!vx.includes(tx)) vx.push(tx);
      }
    }
  } else {
    bestDx = 0;
  }
  if (bestAbsY < threshold) {
    const finalSourceY = sourceY.map((sy) => sy + bestDy);
    for (const ty of targetY) {
      if (finalSourceY.some((fy) => Math.abs(fy - ty) < SNAP_EPS)) {
        if (!hy.includes(ty)) hy.push(ty);
      }
    }
  } else {
    bestDy = 0;
  }
  return { dx: bestDx, dy: bestDy, vx, hy };
}

/** For a given resize handle, return the LOCAL-coord position of the
 *  "anchor" — the point on the bbox that should stay invariant in WORLD
 *  during the drag. Used by the rotated-shape resize correction:
 *  applyHandleDrag keeps the anchor stable in local coords already, but
 *  rotation is around the bbox center, so the anchor's WORLD position
 *  shifts unless we also translate the new bbox.
 *
 *  Conventions:
 *    nw drag → anchor = se corner (opposite corner stays put)
 *    ne drag → anchor = sw corner
 *    sw drag → anchor = ne corner
 *    se drag → anchor = nw corner
 *    n drag  → anchor = s edge midpoint (only the y axis moves)
 *    s drag  → anchor = n edge midpoint
 *    e drag  → anchor = w edge midpoint
 *    w drag  → anchor = e edge midpoint */
function oppositeAnchorLocal(
  handle:
    | 'nw'
    | 'ne'
    | 'sw'
    | 'se'
    | 'n'
    | 's'
    | 'e'
    | 'w',
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const { x, y, w, h } = rect;
  switch (handle) {
    case 'nw':
      return { x: x + w, y: y + h };
    case 'ne':
      return { x, y: y + h };
    case 'sw':
      return { x: x + w, y };
    case 'se':
      return { x, y };
    case 'n':
      return { x: x + w / 2, y: y + h };
    case 's':
      return { x: x + w / 2, y };
    case 'e':
      return { x, y: y + h / 2 };
    case 'w':
      return { x: x + w, y: y + h / 2 };
  }
}
