/* Programmatic shape insertion — extracted from Canvas's drop handlers so
 * the universal launcher (UniversalLauncher.tsx) can drop a shape/icon at
 * the viewport centre without duplicating the same construction logic.
 *
 * The Canvas drop branches still own the cursor-follows-cursor behaviour
 * (drop-at-pointer, drop-target highlighting); these helpers are the shared
 * "construct + add + adopt + record" tail. Keeping them here means a
 * regression in shape construction breaks both paths together — which is
 * the right trade-off when the construction logic is identical.
 */

import { useEditor, newId } from '@/store/editor';
import type { Shape } from '@/store/types';
import type { IconDragPayload } from '@/icons/types';
import { resolveIcon } from '@/icons/resolve';

/** World-space point at the centre of the current viewport. The launcher
 *  drops shapes here so the user sees them appear in the visible area
 *  without having to scroll/pan. Reads zoom + pan + window dims at call
 *  time so the answer is always current. */
export function viewportCentre(): { x: number; y: number } {
  const { pan, zoom } = useEditor.getState();
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  const cx = (window.innerWidth / 2 - pan.x) / zoom;
  const cy = (window.innerHeight / 2 - pan.y) / zoom;
  return { x: cx, y: cy };
}

/** Drop a library shape (the service-tile catalog entry shown in
 *  MoreShapesPopover / LibraryPanel) at world-space `(x, y)`, defaulting to
 *  the viewport centre. Mirrors Canvas's `application/x-vellum-library`
 *  drop branch so a launcher pick is byte-for-byte equivalent to a
 *  drag-and-drop of the same tile. */
export function insertLibraryShape(
  lib: { id: string; label: string; glyph: string; libName: string },
  at?: { x: number; y: number },
): void {
  const w = 130;
  const h = 64;
  const p = at ?? viewportCentre();
  const id = newId(lib.id);
  const editor = useEditor.getState();
  editor.addShape({
    id,
    kind: 'service',
    x: p.x - w / 2,
    y: p.y - h / 2,
    w,
    h,
    label: lib.label,
    icon: lib.glyph,
    layer: 'blueprint',
  });
  editor.adoptIntoContainer(id);
  editor.recordRecent({
    key: `library:${lib.id}`,
    label: lib.label,
    glyph: lib.glyph,
    source: { kind: 'library', libShapeId: lib.id, libName: lib.libName },
  });
  editor.setSelected(id);
}

/** Drop an icon (vendor or iconify) at world-space `(x, y)`. Async because
 *  vendor packs are lazy-loaded and iconify requires a network round trip
 *  for the SVG bytes. Mirrors Canvas's `application/x-vellum-icon` drop
 *  branch end-to-end. Throws on resolve failure — caller decides whether
 *  to toast or silently swallow. */
export async function insertIconShape(
  payload: IconDragPayload,
  at?: { x: number; y: number },
): Promise<void> {
  const resolved = await resolveIcon(payload);
  const { w, h } = resolved.defaultSize;
  const p = at ?? viewportCentre();
  const id = newId('icon');
  const editor = useEditor.getState();
  editor.addShape({
    id,
    kind: 'icon',
    x: p.x - w / 2,
    y: p.y - h / 2,
    w,
    h,
    layer: 'blueprint',
    iconSvg: resolved.svg,
    iconAttribution: resolved.attribution,
    iconConstraints: resolved.constraints,
  });
  editor.adoptIntoContainer(id);
  // Recent stamp — same shorthand the canvas drop uses.
  const tail =
    payload.source === 'vendor'
      ? (payload.iconId.split('/').pop() ?? payload.iconId)
      : (payload.iconId.split(':').pop() ?? payload.iconId);
  editor.recordRecent({
    key:
      payload.source === 'vendor'
        ? `vendor:${payload.iconId}`
        : `iconify:${payload.iconId}`,
    label: tail,
    glyph: tail.slice(0, 3).toUpperCase(),
    source:
      payload.source === 'vendor'
        ? { kind: 'vendor', iconId: payload.iconId, vendor: payload.vendor }
        : { kind: 'iconify', iconId: payload.iconId, prefix: payload.prefix },
  });
  editor.setSelected(id);
}

/** Drop a bare shape kind at the viewport centre. Used by launcher
 *  commands like "insert sticky note" / "insert table" that bypass the
 *  drag-out tool gesture. Subset of `defaultShapeFromTool` — only the
 *  kinds that make sense to drop at a fixed size. */
export function insertBareShape(
  kind: Extract<Shape['kind'], 'rect' | 'ellipse' | 'diamond' | 'note' | 'text' | 'table' | 'container'>,
  at?: { x: number; y: number },
): void {
  const p = at ?? viewportCentre();
  const editor = useEditor.getState();
  // Conservative defaults — caller can resize after.
  const dims: Record<string, { w: number; h: number }> = {
    rect: { w: 140, h: 80 },
    ellipse: { w: 140, h: 80 },
    diamond: { w: 120, h: 80 },
    note: { w: 160, h: 120 },
    text: { w: 120, h: 28 },
    table: { w: 240, h: 120 },
    container: { w: 280, h: 200 },
  };
  const { w, h } = dims[kind];
  const id = newId(kind);
  // Tables need a default cells matrix; note shapes get a seed for the
  // sketchy treatment. Both are picked up by Shape.tsx's renderer.
  const extras: Partial<Shape> = {};
  if (kind === 'table') {
    extras.rows = 3;
    extras.cols = 3;
    extras.cells = [];
  } else if (kind === 'note') {
    extras.seed = Math.floor(Math.random() * 0xffff);
    extras.layer = 'notes';
  }
  editor.addShape({
    id,
    kind,
    x: p.x - w / 2,
    y: p.y - h / 2,
    w,
    h,
    layer: extras.layer ?? 'blueprint',
    ...extras,
  } as Shape);
  editor.setSelected(id);
}
