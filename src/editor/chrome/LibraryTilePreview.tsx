import { Shape } from '@/editor/canvas/Shape';
import type { PersonalLibraryEntry } from '@/store/editor';

/** Mini-preview of a personal library entry. Renders the saved shapes inside
 *  a tiny SVG sized to the tile, so the user sees the actual icon / image /
 *  shape they saved instead of just a 3-letter glyph.
 *
 *  Why a real Shape render instead of a stored bitmap snapshot:
 *    - Icons, images, and freehand strokes already round-trip through Shape;
 *      reusing it means the preview matches the canvas rendering pixel-for-
 *      pixel.
 *    - The bundle's coordinates are normalised to (0, 0) by addToLibrary,
 *      so we just need a viewBox that spans the bbox.
 *    - No extra serialisation step, no rasterisation, no cache invalidation
 *      when a future Shape change adjusts the visuals.
 *
 *  The viewBox uses min-x / min-y of 0 (per normalisation) and the bundle
 *  bbox's max as width/height, with `preserveAspectRatio="xMidYMid meet"`
 *  so the contents fit without distortion. */
export function LibraryTilePreview({
  entry,
  size = 36,
}: {
  entry: PersonalLibraryEntry;
  size?: number;
}) {
  const shapes = entry.shapes;
  if (shapes.length === 0) {
    // Empty bundle — fall back to glyph in caller.
    return null;
  }
  let maxX = 0;
  let maxY = 0;
  for (const sh of shapes) {
    if (sh.x + sh.w > maxX) maxX = sh.x + sh.w;
    if (sh.y + sh.h > maxY) maxY = sh.y + sh.h;
  }
  // Guard against zero-sized bundles (a single text shape with w=0 is rare
  // but possible). Pad to 1 so the viewBox is valid.
  const vbW = Math.max(maxX, 1);
  const vbH = Math.max(maxY, 1);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      // Tile previews don't need to be interactive — the parent button
      // handles drag start.
      style={{ pointerEvents: 'none', display: 'block' }}
    >
      {/* Sort by z so the preview matches the on-canvas stack order. */}
      {shapes
        .slice()
        .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
        .map((s) => (
          <Shape key={s.id} shape={s} />
        ))}
    </svg>
  );
}
