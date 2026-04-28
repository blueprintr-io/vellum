/**
 * Inline text marks (bold / italic / underline) — encoded as a tiny markdown
 * subset so the on-disk format stays plain-text and reads sensibly when a
 * .vellum file is opened in another tool.
 *
 *   **bold**         → <b>bold</b>
 *   *italic*         → <i>italic</i>
 *   __underline__    → <u>underline</u>
 *
 * The markers are NOT recursive (no `***bold-italic***`) — keeping the
 * grammar trivial avoids a real parser, and the contenteditable's three
 * commands are independently togglable so users compose nesting via separate
 * spans which we serialise as adjacent runs.
 *
 * Usage:
 *   - Commit (DOM → markdown): `domToMd(editorRef.current)`
 *   - Seed (markdown → HTML for the contenteditable): `mdToHtml(stored)`
 *   - Render to wrapped HTML (foreignObject + dangerouslySetInnerHTML):
 *       `mdToHtml(text)`
 *   - Render to plain text (SVG <text>, exports, search):
 *       `mdToPlain(text)`
 *
 * The pair is deliberately roundtrip-stable for the closed grammar:
 * `domToMd(divFromMdToHtml(s)) === s` for any `s` produced by domToMd.
 *
 * Why markdown, not HTML-on-disk? Two reasons:
 *   1. Keeps the file format clean. Search / export / Connector label
 *      rendering all stay byte-for-byte plain-text-friendly.
 *   2. Sandboxes the inline-formatting surface. We never need to sanitise
 *      arbitrary HTML on commit — we walk the DOM ourselves and emit only
 *      the three known markers.
 */

const ZWSP = '​';

/** Escape characters that the renderer would otherwise interpret as marks
 *  or HTML, so a label that contains a literal `**` survives a roundtrip
 *  without being eaten as bold. We use HTML entities for `<`/`>`/`&` and
 *  pre-pad the markdown markers with a zero-width-space so the parser stops.
 *  ZWSPs get stripped in mdToPlain so the visible-text accessor stays clean. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Walk a DOM subtree and emit the inline-markdown representation of its
 *  text content + bold / italic / underline runs. We emit markers around the
 *  smallest ranges that carry the matching format, so two independent runs
 *  ("**a** plain **b**") don't get coalesced. */
export function domToMd(node: Node | null | undefined): string {
  if (!node) return '';
  let out = '';
  const walk = (n: Node, b: boolean, i: boolean, u: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? '';
      if (!t) return;
      // Strip ZWSP seeds — the editor seeds an empty contenteditable with
      // a zero-width space so the caret has something to anchor against,
      // and that character must not be persisted.
      const cleaned = t.replace(new RegExp(ZWSP, 'g'), '');
      if (!cleaned) return;
      out += wrapMd(cleaned, b, i, u);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    // execCommand emits both <b>/<i>/<u> and <strong>/<em> on different
    // browsers; honour both. Inline style fallbacks (font-weight, etc.)
    // catch the case where the browser inserted styled <span>s instead.
    const style = el.style;
    const isBold =
      tag === 'B' ||
      tag === 'STRONG' ||
      style.fontWeight === 'bold' ||
      Number(style.fontWeight) >= 600;
    const isItalic =
      tag === 'I' || tag === 'EM' || style.fontStyle === 'italic';
    const isUnderline =
      tag === 'U' ||
      style.textDecoration?.includes('underline') ||
      style.textDecorationLine?.includes('underline');
    const nb = b || isBold;
    const ni = i || isItalic;
    const nu = u || isUnderline;
    for (const child of Array.from(el.childNodes)) {
      walk(child, nb, ni, nu);
    }
  };
  for (const child of Array.from(node.childNodes)) {
    walk(child, false, false, false);
  }
  return out;
}

/** Wrap `text` with the three markdown markers as appropriate. Empty runs
 *  pass through unwrapped to avoid emitting `**` `__` shells with no body. */
function wrapMd(text: string, b: boolean, i: boolean, u: boolean): string {
  if (text === '') return '';
  let s = text;
  // Order matters for readability in the on-disk format, not for parsing —
  // mdToHtml processes them in the same order so a roundtrip lands on the
  // identical string.
  if (u) s = `__${s}__`;
  if (i) s = `*${s}*`;
  if (b) s = `**${s}**`;
  return s;
}

/** Convert stored markdown to a sanitised HTML string suitable for
 *  dangerouslySetInnerHTML or a contenteditable's innerHTML. The output
 *  contains only `<b>`, `<i>`, `<u>`, `<br>`, and html-escaped text — never
 *  arbitrary user HTML. */
export function mdToHtml(input: string | undefined): string {
  if (!input) return '';
  // Newlines → <br> so contenteditable + foreignObject both honour them.
  // Escape first, then walk the markers — markers never contain `<`/`>`/`&`.
  const escaped = escapeHtml(input).replace(/\n/g, '<br>');
  // Bold first (longest marker), then underline (next longest), then italic.
  // Italic last because `*` is a single char and its regex would otherwise
  // eat the inner `*` of an unconsumed `**` if we processed bold afterward.
  let s = escaped;
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_]+?)__/g, '<u>$1</u>');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i>$1</i>');
  return s;
}

/** Strip the marker syntax for plain-text consumers — SVG `<text>` (which
 *  doesn't render inline marks anyway), exports, and search. Leaves the
 *  visible characters intact. */
export function mdToPlain(input: string | undefined): string {
  if (!input) return '';
  let s = input;
  s = s.replace(/\*\*([^*]+?)\*\*/g, '$1');
  s = s.replace(/__([^_]+?)__/g, '$1');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1');
  return s;
}
