/* Runtime schema for diagram-shaped foreign data.
 *
 * Anything that arrives from outside the running editor — a `.vellum` file
 * opened from disk, a localStorage backup, a paste envelope, a library /
 * bundle / icon JSON drop — must pass through one of the parsers in this
 * module before it reaches the Zustand store.
 *
 * Two jobs:
 *   1. Reject malformed input early with a useful error (instead of a
 *      half-loaded diagram crashing the renderer three frames later).
 *   2. Sanitize every iconSvg string at the boundary, so the in-memory
 *      diagram never carries raw foreign SVG. Schema-level transforms make
 *      this automatic — a forgotten manual sanitize call won't expose the
 *      whole app to stored XSS.
 *
 * RULE: never call `loadDiagram(d)` with `d` that hasn't come from one of
 * the parsers below. */

import { z } from 'zod';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import type { DiagramState, Shape, Connector, Annotation } from './types';

// primitive guards

const Point = z.looseObject({
  x: z.number(),
  y: z.number(),
});

const Anchor = z.union([
  z.literal('auto'),
  z.literal('top'),
  z.literal('right'),
  z.literal('bottom'),
  z.literal('left'),
  z.tuple([z.number(), z.number()]),
]);

// icon attribution

/** Strip non-http(s) URLs to empty string. The attributions panel renders
 *  these as `<a href>` links, so a hostile `.vellum` file could otherwise
 *  set `javascript:...` and trigger XSS on click. Empty string falls back
 *  to the panel's no-link path. */
const SafeHttpUrl = z
  .string()
  .transform((s) => (/^https?:\/\//i.test(s) ? s : ''));

const IconAttribution = z.looseObject({
  source: z.union([z.literal('vendor'), z.literal('iconify')]),
  iconId: z.string(),
  holder: z.string(),
  license: z.string(),
  sourceUrl: SafeHttpUrl,
  guidelinesUrl: SafeHttpUrl.optional(),
});

const IconConstraints = z.looseObject({
  lockColors: z.boolean(),
  lockAspect: z.boolean(),
  lockRotation: z.boolean(),
});

// label anchor enum
// Shared by Shape.labelAnchor, Shape.cellAnchor (table-default), and
// TableCell.anchor (per-cell override). One union, three uses.
const LabelAnchor = z.union([
  z.literal('center'),
  z.literal('below'),
  z.literal('above'),
  z.literal('left'),
  z.literal('right'),
  z.literal('right-of-icon'),
  z.literal('top-left'),
  z.literal('top-right'),
  z.literal('bottom-left'),
  z.literal('bottom-right'),
  z.literal('inside-top'),
  z.literal('inside-bottom'),
  z.literal('inside-left'),
  z.literal('inside-right'),
  z.literal('outside-top-left'),
  z.literal('outside-top-right'),
  z.literal('outside-bottom-left'),
  z.literal('outside-bottom-right'),
]);

// table cell
const TableCell = z.looseObject({
  text: z.string().optional(),
  anchor: LabelAnchor.optional(),
  textColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  fill: z.string().optional(),
});

/** Cells field accepts both shapes:
 *    - new: `(TableCell | null)[][]` — sparse by null
 *    - old: `string[][]` — the v1 shape from the basic-table ship
 *  Old strings are wrapped into `{ text }` objects on parse so the in-memory
 *  diagram is always the new shape. The transform runs per-cell, preserving
 *  null/undefined as null. */
const TableCellOrLegacy = z.union([
  z.null(),
  z.string().transform((s) => ({ text: s })),
  TableCell,
]);
const TableCells = z.array(z.array(TableCellOrLegacy));

// shape

const ShapeKind = z.union([
  z.literal('rect'),
  z.literal('ellipse'),
  z.literal('diamond'),
  z.literal('service'),
  z.literal('group'),
  z.literal('container'),
  z.literal('note'),
  z.literal('text'),
  z.literal('image'),
  z.literal('freehand'),
  z.literal('icon'),
  z.literal('table'),
]);

const Layer = z.union([z.literal('notes'), z.literal('blueprint')]);

/** Shape schema. `looseObject` keeps unknown fields for forward compat — a
 *  newer file won't lose data round-tripping through an older editor. The
 *  fields we DO validate are the ones the renderer hard-depends on or that
 *  carry security-relevant content. */
const ShapeSchema = z.looseObject({
  id: z.string(),
  kind: ShapeKind,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  layer: Layer,
  // Optional fields. Validated when present so a malformed value doesn't
  // crash the renderer downstream.
  label: z.string().optional(),
  sublabel: z.string().optional(),
  body: z.string().optional(),
  icon: z.string().optional(),
  fidelity: z.number().optional(),
  seed: z.number().optional(),
  src: z.string().optional(),
  imageFilter: z
    .union([
      z.literal('none'),
      z.literal('grayscale'),
      z.literal('sepia'),
      z.literal('invert'),
      z.literal('blur'),
    ])
    .optional(),
  points: z.array(Point).optional(),
  // Table fields. Cells run through TableCellOrLegacy so the v1 string[][]
  // shape migrates to TableCell[][] at the schema boundary.
  rows: z.number().optional(),
  cols: z.number().optional(),
  cells: TableCells.optional(),
  cellAnchor: LabelAnchor.optional(),
  headerRow: z.boolean().optional(),
  headerCol: z.boolean().optional(),
  rowHeights: z.array(z.number()).optional(),
  colWidths: z.array(z.number()).optional(),
  parent: z.string().optional(),
  anchorId: z.string().optional(),
  stroke: z.string().optional(),
  fill: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z
    .union([z.literal('solid'), z.literal('dashed'), z.literal('dotted')])
    .optional(),
  // Per-shape corner radius — rects + service tiles only at render time. Schema
  // accepts the field on every kind for forward compat (other kinds just
  // ignore it).
  cornerRadius: z.number().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  // Horizontal text alignment for label / body. Defaults to centred for
  // kind:'text' (renderer-driven default) and unset for body-bearing kinds
  // (the per-anchor textAlign in Shape.tsx applies). Persisted only when
  // the user has explicitly picked an alignment via the flyout toggle.
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  labelAnchor: LabelAnchor.optional(),
  // Auto-fit mode for kind:'text'. true = shrink-wrap, false = wrap-to-width,
  // 'fit' = bbox preserved with fontSize derived to fit. See Shape.autoSize
  // for full semantics.
  autoSize: z.union([z.boolean(), z.literal('fit')]).optional(),
  opacity: z.number().optional(),
  fillOpacity: z.number().optional(),
  z: z.number().optional(),
  textColor: z.string().optional(),
  // Security-critical: iconSvg is the field that flows into
  // dangerouslySetInnerHTML. Sanitize at the schema boundary so the
  // in-memory diagram never carries raw foreign SVG. The transform runs on
  // every successful parse — including the load-from-disk and
  // load-from-localStorage paths that previously had no sanitize step.
  iconSvg: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : sanitizeSvg(s))),
  iconAttribution: IconAttribution.optional(),
  iconConstraints: IconConstraints.optional(),
  // Rotation in degrees applied at render time around the shape center.
  // Currently rendered for icon shapes; reserved on the base shape so
  // future kinds can adopt without bumping the file format.
  rotation: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// connector

const ConnectorEndpoint = z.union([
  z.looseObject({ shape: z.string(), anchor: Anchor }),
  z.looseObject({ x: z.number(), y: z.number() }),
]);

const EndpointMarker = z.union([
  z.literal('none'),
  z.literal('arrow'),
  z.literal('dot'),
  z.literal('circle'),
  z.literal('diamond'),
]);

const ConnectorSchema = z.looseObject({
  id: z.string(),
  from: ConnectorEndpoint,
  to: ConnectorEndpoint,
  layer: Layer.optional(),
  routing: z.union([
    z.literal('straight'),
    z.literal('curved'),
    z.literal('orthogonal'),
  ]),
  waypoints: z.array(Point).optional(),
  fromMarker: EndpointMarker.optional(),
  toMarker: EndpointMarker.optional(),
  fromMarkerSize: z.number().optional(),
  toMarkerSize: z.number().optional(),
  label: z.string().optional(),
  labelPosition: z.number().optional(),
  style: z
    .union([z.literal('solid'), z.literal('dashed'), z.literal('dotted')])
    .optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  opacity: z.number().optional(),
  z: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// annotation

const AnnotationSchema = z.looseObject({
  id: z.string(),
  kind: z.union([z.literal('comment'), z.literal('todo')]),
  shape: z.string().optional(),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// diagram envelope

/** Top-level diagram. Strict on `version` and the array fields (because a
 *  hostile file with `shapes: "<svg>..."` would otherwise crash mid-render).
 *  Missing arrays default to empty, so partial writes from older editors
 *  load cleanly. */
const DiagramSchema = z.looseObject({
  version: z.literal('1.0'),
  meta: z
    .looseObject({
      title: z.string().optional(),
      defaults: z
        .looseObject({
          fidelity: z.number().optional(),
          cornerRadius: z.number().optional(),
        })
        .optional(),
    })
    .optional()
    .transform((m) => m ?? {}),
  shapes: z.array(ShapeSchema).optional().transform((s) => s ?? []),
  connectors: z.array(ConnectorSchema).optional().transform((c) => c ?? []),
  annotations: z.array(AnnotationSchema).optional().transform((a) => a ?? []),
});

// public parsers

/** Parse + sanitize a full diagram envelope. Throws on malformed input. */
export function parseDiagram(input: unknown): DiagramState {
  return DiagramSchema.parse(input) as DiagramState;
}

/** Parse + sanitize a flat list of shapes — used by the bundle/library/paste
 *  drop handlers that don't carry a full diagram envelope. */
export function parseShapes(input: unknown): Shape[] {
  return z.array(ShapeSchema).parse(input) as Shape[];
}

/** Parse + sanitize a flat list of connectors. Sibling to parseShapes. */
export function parseConnectors(input: unknown): Connector[] {
  return z.array(ConnectorSchema).parse(input) as Connector[];
}

/** Parse + sanitize an annotation list. */
export function parseAnnotations(input: unknown): Annotation[] {
  return z.array(AnnotationSchema).parse(input) as Annotation[];
}

/** Convenience: parse a clipboard envelope `{ shapes, connectors }`. */
export function parseClipboardEnvelope(input: unknown): {
  shapes: Shape[];
  connectors: Connector[];
} {
  const env = z
    .looseObject({
      shapes: z.array(ShapeSchema).optional().transform((s) => s ?? []),
      connectors: z.array(ConnectorSchema).optional().transform((c) => c ?? []),
    })
    .parse(input);
  return {
    shapes: env.shapes as Shape[],
    connectors: env.connectors as Connector[],
  };
}
