import { memo } from 'react';
import type {
  Connector as ConnectorT,
  EndpointMarker,
  Shape,
} from '@/store/types';
import { resolveSwatchColor } from '@/editor/swatches';
import { mdToPlain } from '@/lib/inline-marks';
import { useEditor } from '@/store/editor';
import {
  buildPath,
  connectorPolyline,
  pointAtFraction,
  resolveConnectorPath,
} from './routing';

type Props = {
  conn: ConnectorT;
  shapes: Shape[];
  selected: boolean;
};

function ConnectorImpl({ conn, shapes, selected }: Props) {
  // Suppress the rendered label while the inline editor overlays this
  // connector — otherwise the editor's transparent background would show
  // the committed label painted underneath, ghosting the cursor.
  const beingEdited = useEditor((s) => s.editingConnectorId === conn.id);
  const strokeWidth = conn.strokeWidth ?? 1.25;

  const fromFloating = !('shape' in conn.from);
  const toFloating = !('shape' in conn.to);
  const fromMarker: EndpointMarker = conn.fromMarker ?? 'none';
  const toMarker: EndpointMarker = conn.toMarker ?? 'arrow';
  const linecap = 'butt'; // Always cleanly finish on the edge

  const getSetback = (marker: EndpointMarker, floating: boolean) => {
    if (floating) return 0;
    if (marker === 'arrow') return strokeWidth + 2;
    // 'none', 'circle', 'dot', 'diamond' have 0 setback (centered on boundary or clean end)
    return 0;
  };

  const path = resolveConnectorPath(
    conn,
    shapes,
    getSetback(fromMarker, fromFloating),
    getSetback(toMarker, toFloating),
  );
  if (!path) return null;
  const fromPt = { x: path.fx, y: path.fy };
  const toPt = { x: path.tx, y: path.ty };

  // Resolve through the swatch palette so a connector saved with a legacy
  // stroke hex (#1f6feb etc.) routes to its theme-aware var() and
  // autoswitches when the user toggles theme. var()/transparent/none/
  // unrecognised hexes pass through unchanged.
  const stroke = resolveSwatchColor(conn.stroke, 'stroke') ?? 'var(--ink)';

  const pathD = buildPath(
    conn.routing,
    path.fx,
    path.fy,
    path.tx,
    path.ty,
    path.fromAnchor,
    path.toAnchor,
    conn.waypoints,
    path.fromRot,
    path.toRot,
  );

  // Per-end marker size override. Undefined = "auto" — falls back to the
  // legacy strokeWidth-relative sizing inside <Marker /> so existing diagrams
  // render unchanged. When set, the marker is sized in user-space px and is
  // fully decoupled from `strokeWidth`.
  const fromMarkerSize = conn.fromMarkerSize;
  const toMarkerSize = conn.toMarkerSize;

  // Per-connector marker IDs so colour follows the stroke. Size goes into the
  // id too — markers are referenced by URL and SVG caches them per id, so two
  // arrows with different sizes need different ids or the second silently
  // re-uses the first definition.
  const fromMarkerId = `mk-${conn.id}-from`;
  const toMarkerId = `mk-${conn.id}-to`;

  const dash =
    conn.style === 'dashed'
      ? '5 3'
      : conn.style === 'dotted'
        ? '1 4'
        : '0';

  // Label position — sample the actual rendered polyline at the stored
  // fraction (default 0.5 = midpoint of arclength). For straight lines this
  // matches the old `(from+to)/2` behaviour; for elbow / curved lines it
  // sits the label ON the line instead of at the geometric midpoint of the
  // endpoint pair (which was off-line for orthogonal routing).
  const polyline = connectorPolyline(
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
  const labelPt = pointAtFraction(polyline, conn.labelPosition ?? 0.5);
  const mx = labelPt.x;
  const my = labelPt.y;

  // Notes-layer connectors pick up a feTurbulence-based wobble so they
  // visually match the jittered Notes-layer shapes (rect/ellipse/etc render
  // through `jitter*` helpers; we'd rather not re-derive a jittered SVG
  // path per frame for every connector). Filter id matches a <filter
  // id="notes-wobble"> in Canvas's <defs>.
  const onNotes = (conn.layer ?? 'blueprint') === 'notes';

  return (
    <g
      data-connector-id={conn.id}
      opacity={conn.opacity ?? undefined}
      filter={onNotes ? 'url(#notes-wobble)' : undefined}
    >
      <defs>
        {fromMarker !== 'none' && (
          <Marker
            id={fromMarkerId}
            kind={fromMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={fromMarkerSize}
          />
        )}
        {toMarker !== 'none' && (
          <Marker
            id={toMarkerId}
            kind={toMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={toMarkerSize}
          />
        )}
      </defs>
      {/* Fat invisible hit target — 12px wide for click selection. */}
      <path d={pathD} fill="none" stroke="transparent" strokeWidth={12} />
      <path
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        markerStart={fromMarker !== 'none' ? `url(#${fromMarkerId})` : undefined}
        markerEnd={toMarker !== 'none' ? `url(#${toMarkerId})` : undefined}
        strokeLinecap={linecap}
        strokeLinejoin="round"
      />
      {selected && (
        <path
          d={pathD}
          fill="none"
          stroke="var(--refined)"
          strokeWidth={3}
          opacity={0.25}
          strokeLinecap={linecap}
          strokeLinejoin="round"
        />
      )}
      {/* Label rect = the "paper-coloured" box behind the text. This is the
       *  visible "gap" in the line under a label. Strict-truthy + trim guard
       *  here defends against a connector whose `label` was set to a stray
       *  whitespace string (NBSP, lone space) by an over-eager commit path —
       *  without the trim, the gap-rect would persist after the user "deleted"
       *  the label and the line wouldn't visibly reconnect. */}
      {(() => {
        if (beingEdited) return null;
        // Strip inline-markdown markers (`**bold**` etc.) for the displayed
        // text + bbox math. SVG <text> can't render marks anyway and the raw
        // marker chars would inflate the rect width relative to what users
        // see. Inline-mark rendering on connector labels is a known limit —
        // foreignObject would buy it but trades the SVG hit-testing model.
        const plain = mdToPlain(conn.label);
        if (!plain || !plain.trim()) return null;
        return (
          <g
            transform={`translate(${mx}, ${my})`}
            data-connector-label-id={conn.id}
            style={{ cursor: 'grab' }}
          >
            <rect
              x={-plain.length * 3.5 - 6}
              y={-9}
              width={plain.length * 7 + 12}
              height={18}
              fill="var(--paper)"
              rx={3}
            />
            <text
              x={0}
              y={4}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={10}
              fill="var(--ink-muted)"
              // Pointer events on the rect are enough — the text inside
              // would otherwise capture clicks and split hit handling
              // between two SVG nodes, which complicates the bbox check
              // in connectorLabelUnder.
              style={{ pointerEvents: 'none' }}
            >
              {plain}
            </text>
          </g>
        );
      })()}
      {selected && (
        <g style={{ pointerEvents: 'none' }}>
          {/* From-end: open circle = floating, filled = bound. Symmetric so
           *  direction reads at a glance. */}
          <circle
            cx={fromPt.x}
            cy={fromPt.y}
            r={4}
            fill={fromFloating ? 'var(--paper)' : 'var(--refined)'}
            stroke={fromFloating ? 'var(--refined)' : 'var(--paper)'}
            strokeWidth={1.5}
          />
          <circle
            cx={toPt.x}
            cy={toPt.y}
            r={4}
            fill={toFloating ? 'var(--paper)' : 'var(--refined)'}
            stroke={toFloating ? 'var(--refined)' : 'var(--paper)'}
            strokeWidth={1.5}
          />
        </g>
      )}
    </g>
  );
}

/** Default marker size factors (in stroke widths) — the values the renderer
 *  used historically when `markerUnits="strokeWidth"`. We now always render
 *  in `userSpaceOnUse`, but when the user hasn't picked an explicit size we
 *  multiply these factors by the connector's stroke width so existing
 *  diagrams render byte-identical to the pre-decouple behaviour. */
const MARKER_DEFAULT_FACTOR: Record<Exclude<EndpointMarker, 'none'>, number> = {
  arrow: 7,
  diamond: 7,
  dot: 5,
  circle: 5,
};

/** Resolve the rendered marker size (user-space px) for a given marker kind +
 *  connector stroke width + optional explicit override. Centralised so the
 *  renderer and the inspector slider's "auto" thumb position agree. */
export function resolveMarkerSize(
  kind: Exclude<EndpointMarker, 'none'>,
  strokeWidth: number,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  return strokeWidth * MARKER_DEFAULT_FACTOR[kind];
}

/** Single endpoint marker definition. The viewBox is fixed at `0 0 10 10`,
 *  with the *tip* sitting at refX (where the line meets the marker) and the
 *  marker facing the line outward (`auto-start-reverse` mirrors for the start
 *  side). The marker size is always resolved in user-space px so it's fully
 *  decoupled from `strokeWidth` — when no explicit size is given we fall back
 *  to `strokeWidth × factor` (preserves legacy visuals). */
function Marker({
  id,
  kind,
  stroke,
  strokeWidth,
  size,
}: {
  id: string;
  kind: EndpointMarker;
  stroke: string;
  strokeWidth: number;
  /** User-space px override. Undefined = `strokeWidth × kind-default-factor`. */
  size: number | undefined;
}) {
  if (kind === 'none') return null;
  const px = resolveMarkerSize(kind, strokeWidth, size);
  // refX is in viewBox units (always — independent of `markerUnits`).
  //
  // For *tapered* markers (arrow / diamond) the simple "tip-at-endpoint"
  // refX=10 has a fatal flaw: the arrow has zero height at its tip, so the
  // line's stroke-cap (`strokeWidth` tall) is fully exposed past the tip,
  // showing as a small "stub" poking through. Especially visible when the
  // line is thick relative to the marker.
  //
  // Fix: pull refX back into the marker body just enough that the arrow's
  // half-height at refX equals the line's half-stroke. The line cap is
  // then exactly contained by the arrow body. Geometry:
  //   arrow half-height(x) = (10 - x) / 2  in viewBox units
  //                        = (10 - x) * px / 20  in user units
  //   set equal to strokeWidth / 2:
  //     (10 - x) * px / 20 = strokeWidth / 2
  //     refX = 10 - 10 * strokeWidth / px
  // Tip ends up `strokeWidth` user units past the path vertex — negligible
  // at typical strokes, gracefully larger only when the stroke itself is
  // already heavy (which is when the user is paying for a chunky look
  // anyway). Capped at 0 so a very thick line on a tiny marker doesn't
  // pull refX negative.
  //
  // Open / dot markers are symmetric and refX=5 (centre) already places
  // the line endpoint inside the marker body — no dynamic adjustment.
  const taperedRefX = Math.max(0, 10 - (10 * strokeWidth) / Math.max(px, 0.0001));
  const common = {
    id,
    viewBox: '0 0 10 10',
    markerUnits: 'userSpaceOnUse' as const,
    orient: 'auto-start-reverse' as const,
    markerWidth: px,
    markerHeight: px,
  };
  if (kind === 'arrow') {
    return (
      <marker {...common} refX={taperedRefX} refY={5}>
        <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
      </marker>
    );
  }
  if (kind === 'dot') {
    return (
      <marker {...common} refX={5} refY={5}>
        <circle cx={5} cy={5} r={3.5} fill={stroke} />
      </marker>
    );
  }
  if (kind === 'circle') {
    return (
      <marker {...common} refX={5} refY={5}>
        <circle
          cx={5}
          cy={5}
          r={3.5}
          fill="var(--paper)"
          stroke={stroke}
          strokeWidth={1.5}
        />
      </marker>
    );
  }
  if (kind === 'diamond') {
    return (
      <marker {...common} refX={5} refY={5}>
        <path d="M 0 5 L 5 0 L 10 5 L 5 10 z" fill={stroke} />
      </marker>
    );
  }
  return null;
}

export const Connector = memo(ConnectorImpl);
