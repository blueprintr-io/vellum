/* SVG sanitizer — single source of truth.
 *
 * Run every foreign SVG string through this before it reaches an inline
 * <svg> via dangerouslySetInnerHTML. Wired into the schema parser
 * (`src/store/schema.ts`) so anything coming through the load boundaries
 * — file open, autosave restore, paste, library drop — is sanitized
 * automatically. Direct callers: `src/icons/resolve.ts` (drag from picker). */

import DOMPurify from 'dompurify';

/** Tags forbidden on top of DOMPurify defaults. `foreignObject` can host
 *  HTML (including `<iframe srcdoc>`); the SMIL animation tags can mutate
 *  href / xlink:href to `javascript:` after the sanitizer has run. */
const FORBID_TAGS = [
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'script',
  'meta',
  'link',
  'base',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
];

const FORBID_ATTR = [
  'srcdoc',
  'formaction',
  'action',
  'ping',
  'background',
];

/** Sanitize a raw SVG string. Returns an empty string for non-string or
 *  empty input — callers fall back to placeholder rendering. Never throws. */
export function sanitizeSvg(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,
  });
}

/** Walk a parsed diagram and sanitize every shape's `iconSvg` in place. */
export function sanitizeDiagramIconSvgs<
  T extends { shapes?: Array<{ iconSvg?: string | undefined } & object> },
>(diagram: T): T {
  if (!diagram?.shapes) return diagram;
  for (const shape of diagram.shapes) {
    if (typeof shape.iconSvg === 'string' && shape.iconSvg.length > 0) {
      shape.iconSvg = sanitizeSvg(shape.iconSvg);
    }
  }
  return diagram;
}

/** Sanitize a flat list of shapes — used by the drop / paste handlers that
 *  receive bundles outside of a full diagram envelope. Mutates in place and
 *  returns the same array for chainability. */
export function sanitizeShapesIconSvgs<
  T extends { iconSvg?: string | undefined } & object,
>(shapes: T[]): T[] {
  for (const shape of shapes) {
    if (typeof shape.iconSvg === 'string' && shape.iconSvg.length > 0) {
      shape.iconSvg = sanitizeSvg(shape.iconSvg);
    }
  }
  return shapes;
}
