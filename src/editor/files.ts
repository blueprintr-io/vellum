/* File-action plumbing: bridges the Zustand store and the persist layer.
 *
 * These are plain async functions (not hooks) because keybindings call them
 * from event handlers, and Vite/React would warn if we routed them through
 * useEffect. The store actions handle the state transitions; the persist layer
 * touches disk. */

import { useEditor } from '@/store/editor';
import {
  diagramToYaml,
  getActiveHandle,
  openVellumFile,
  saveVellumFile,
  setActiveHandle,
  triggerDownload,
} from '@/store/persist';

/** Save the current diagram. If no active file handle exists, prompt for one
 *  via FSA / fall back to download. */
export async function handleSave() {
  const s = useEditor.getState();
  const handle = getActiveHandle();
  const filename = suggestedFilename(s.filePath);
  try {
    const result = await saveVellumFile(s.diagram, handle, filename);
    setActiveHandle(result.handle);
    if (result.filePath) {
      useEditor.getState().setFilePath(result.filePath);
    }
    useEditor.getState().markSaved();
  } catch (err) {
    console.error('save failed', err);
    alert('Save failed. See the developer console for details.');
  }
}

/** Save As — always prompts. Useful for bifurcating an in-flight diagram. */
export async function handleSaveAs() {
  const s = useEditor.getState();
  const filename = suggestedFilename(s.filePath);
  try {
    const result = await saveVellumFile(s.diagram, null, filename);
    setActiveHandle(result.handle);
    if (result.filePath) {
      useEditor.getState().setFilePath(result.filePath);
    }
    useEditor.getState().markSaved();
  } catch (err) {
    console.error('save-as failed', err);
    alert('Save As failed. See the developer console for details.');
  }
}

/** Open a file picker, parse the chosen file, and load it. */
export async function handleOpen() {
  try {
    const result = await openVellumFile();
    if (!result) return; // user cancelled
    setActiveHandle(result.handle);
    useEditor.getState().loadDiagram(result.diagram, result.filePath);
  } catch (err) {
    console.error('open failed', err);
    alert('Could not open that file. See the developer console for details.');
  }
}

/** New diagram — clears handle + resets store. */
export function handleNew() {
  // Confirm if the current diagram is dirty; otherwise we'd silently throw
  // away unsaved work.
  if (useEditor.getState().dirty) {
    const ok = confirm('Discard unsaved changes?');
    if (!ok) return;
  }
  setActiveHandle(null);
  useEditor.getState().newDiagram();
}

/** Render the live canvas SVG to a PNG and write it to the OS clipboard.
 *  Crops to the diagram's content bbox; output is alpha-transparent.
 *
 *  Implementation gotchas worth knowing about (see inline comments):
 *  - CSS custom properties don't survive serialization into an <img>, so
 *    we resolve the relevant tokens up front and embed them as a <style>.
 *  - Safari requires the ClipboardItem to be constructed in the same task
 *    as `clipboard.write`.
 *  - <foreignObject> labels poison <img>-based rasterization in Chrome
 *    and Safari; we flatten them to <text>/<tspan> in the clone.
 *
 *  Falls back to a PNG download if the clipboard rejects, then to an SVG
 *  download if rasterization itself fails. */
export async function handleCopyPng() {
  // Prefer a data-attribute selector so we don't accidentally match a
  // foreign 100%-width SVG that some future chrome control might render.
  const svgEl =
    (document.querySelector('svg[data-vellum-canvas]') as SVGSVGElement | null) ??
    (document.querySelector('svg[width="100%"]') as SVGSVGElement | null);
  if (!svgEl) {
    alert('Canvas not ready.');
    return;
  }

  // Compute content bbox in viewBox coords
  // The SVG's viewBox dims are kept 1:1 with its rendered pixel dims (see
  // Canvas.tsx — ResizeObserver feeds viewport.{w,h} from getBoundingClientRect),
  // so screen-space rects translate directly to viewBox coords by subtracting
  // the SVG's own screen origin. That side-steps screenCTM gymnastics.
  //
  // We only measure shape and connector roots (identified by data-shape-id /
  // data-connector-id). Selection halos, hover rings, marquee previews, and
  // connector handles are deliberately excluded so the crop hugs actual
  // diagram content rather than transient UI affordances.
  const svgRect = svgEl.getBoundingClientRect();
  const contentEls = svgEl.querySelectorAll(
    '[data-shape-id], [data-connector-id]',
  );
  if (contentEls.length === 0) {
    alert('Nothing to copy — the canvas is empty.');
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of Array.from(contentEls)) {
    const r = (el as SVGGraphicsElement).getBoundingClientRect();
    // Skip degenerate (zero-sized) hits — shouldn't happen for real shapes
    // but guards against group-kind hit zones if any get reduced to nothing.
    if (r.width === 0 && r.height === 0) continue;
    minX = Math.min(minX, r.left - svgRect.left);
    minY = Math.min(minY, r.top - svgRect.top);
    maxX = Math.max(maxX, r.right - svgRect.left);
    maxY = Math.max(maxY, r.bottom - svgRect.top);
  }
  if (!isFinite(minX)) {
    alert('Nothing to copy — the canvas is empty.');
    return;
  }
  // Padding is in screen px (= viewBox units). Small enough to read as a
  // tight crop, large enough to absorb arrowhead overshoot, notes-glow
  // filter expansion, and the small stroke widths that paint outside their
  // nominal shape bounds.
  const PAD = 24;
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;
  const vbX = Math.round(minX);
  const vbY = Math.round(minY);
  const w = Math.max(1, Math.round(maxX - minX));
  const h = Math.max(1, Math.round(maxY - minY));

  // Resolve every CSS custom property we use into a literal value, then embed
  // them as inline styles on the SVG clone. The standalone <img> rasterizer
  // can't see the document's :root vars otherwise.
  const cs = getComputedStyle(document.documentElement);
  const vars = [
    '--paper',
    '--paper-grid',
    '--ink',
    '--ink-muted',
    '--accent',
    '--accent-deep',
    '--accent-emphasis',
    '--sketch',
    '--refined',
    '--bg',
    '--bg-subtle',
    '--bg-overlay',
    '--bg-emphasis',
    '--border',
    '--fg',
    '--fg-muted',
    '--note-bg',
    '--note-ink',
    '--notes-ink',
    '--notes-glow',
    '--mono',
    '--font-body',
    '--font-mono',
    '--font-sketch',
  ];
  const inlineVars = vars
    .map((v) => `${v}: ${cs.getPropertyValue(v).trim()};`)
    .join(' ');

  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  // Re-aim viewBox at the content bbox and shrink the SVG's pixel dims to
  // match — the rasterizer below uses these for canvas size.
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('viewBox', `${vbX} ${vbY} ${w} ${h}`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  // The live SVG sets `background: var(--paper)` inline (see Canvas.tsx) so
  // the clone inherits a paper-coloured backdrop. Override to transparent
  // so the exported PNG carries an alpha channel rather than a paper fill.
  clone.style.background = 'transparent';
  // Strip the dot-grid backdrop. It's a `<rect fill="url(#dotgrid)">` direct
  // child of the SVG, only present when grid/dots are toggled on; absent
  // otherwise. Removing it is a no-op when the user already has the grid
  // off, so we don't gate on visibility.
  for (const child of Array.from(clone.children)) {
    if (
      child.localName === 'rect' &&
      child.getAttribute('fill') === 'url(#dotgrid)'
    ) {
      child.remove();
    }
  }
  // Strip overlay artefacts from the content group. Direct children of the
  // pan/scale group that aren't a shape (`data-shape-id`) or connector
  // (`data-connector-id`) are: hover ring, hover halo, marquee preview group,
  // SelectionOverlay, ConnectorHandles, in-flight preview, pen path, laser
  // trail. None of those belong in the export.
  const contentG = Array.from(clone.children).find(
    (c) => c.localName === 'g' && c.hasAttribute('transform'),
  ) as SVGGElement | undefined;
  if (contentG) {
    for (const child of Array.from(contentG.children)) {
      const el = child as Element;
      if (
        !el.hasAttribute('data-shape-id') &&
        !el.hasAttribute('data-connector-id')
      ) {
        child.remove();
      }
    }
  }
  // Wrap the variable declarations in `:root` AND the SVG element itself so
  // both selector forms hit. Tucking them into a <style> at the top of <defs>
  // keeps the rest of the markup untouched.
  const styleEl = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'style',
  );
  styleEl.textContent = `:root, svg { ${inlineVars} }`;
  clone.insertBefore(styleEl, clone.firstChild);
  // Replace HTML-label foreignObjects with native SVG text — without this the
  // rasterizer either drops them silently (Chrome) or taints the canvas
  // (Safari). Done on the clone so the on-screen canvas keeps its real
  // wrapping HTML labels.
  flattenForeignObjects(clone);

  const xml = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  let blob: Blob | null = null;
  try {
    const img = new Image();
    // Don't set crossOrigin — it forces a CORS request on the data: URL and
    // breaks loading in some browsers. The serialized SVG is same-origin.
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG image failed to load'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');
    ctx.scale(dpr, dpr);
    // No fillRect — leave the canvas2d buffer transparent so the PNG carries
    // its alpha channel out to the clipboard. The previous implementation
    // painted a paper-colour rect here; that defeated the alpha output.
    ctx.drawImage(img, 0, 0, w, h);
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    );
    if (!blob) throw new Error('toBlob returned null');
  } catch (err) {
    URL.revokeObjectURL(url);
    console.error('Copy as PNG: rasterize failed; downloading SVG instead', err);
    // SVG-download fallback. The previous implementation alerted "Falling
    // back to a download" and then returned without doing anything — that
    // failure mode is what made the button look broken to users.
    const svgUrl = URL.createObjectURL(svgBlob);
    const a = document.createElement('a');
    a.href = svgUrl;
    a.download = 'vellum.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(svgUrl), 1000);
    return;
  }
  URL.revokeObjectURL(url);

  // Try the clipboard API first. Safari requires the ClipboardItem to be
  // constructed in the same microtask as `clipboard.write`, so we keep the
  // blob handle local and don't await between them.
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    'write' in navigator.clipboard &&
    typeof ClipboardItem !== 'undefined'
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      return;
    } catch (err) {
      console.warn('clipboard.write failed; falling back to download', err);
    }
  }
  // Fallback: trigger a download so the user still ends up with a file.
  const dl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = dl;
  a.download = 'vellum.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(dl), 1000);
}

/** Direct-download YAML. The "Export YAML" action; bypasses the FSA flow so it
 *  doesn't overwrite the active handle. */
export function handleExportYaml() {
  const s = useEditor.getState();
  const text = diagramToYaml(s.diagram);
  triggerDownload(suggestedFilename(s.filePath), text, 'application/x-yaml');
}

function suggestedFilename(filePath: string | null): string {
  if (!filePath) return 'untitled.vellum';
  const base = filePath.split('/').pop() ?? filePath;
  if (base.endsWith('.vellum')) return base;
  // Legacy compat — historical diagrams may still carry .vellum.yaml on disk;
  // accept them but the canonical extension is now bare `.vellum`.
  if (base.endsWith('.vellum.yaml') || base.endsWith('.vellum.yml')) return base;
  return `${base}.vellum`;
}

/** Walk the cloned SVG and replace each `<foreignObject>` with a native SVG
 *  `<text>` element so the result rasterizes. We use foreignObjects on the
 *  live canvas to get HTML word-wrap on labels, but rasterizers either drop
 *  them (Chrome) or taint the canvas (Safari) — so the copy-as-PNG flow has
 *  to flatten them.
 *
 *  Lossy on purpose: the new <text> won't word-wrap, only honours newlines.
 *  That's a known compromise — copy-as-PNG is for screenshots, not for
 *  pixel-perfect round-tripping of HTML layout. The on-screen canvas (and
 *  the .vellum file) still hold the original wrapping label, so the loss
 *  is one-way and only affects the exported image. */
function flattenForeignObjects(svg: SVGSVGElement) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fos = Array.from(svg.querySelectorAll('foreignObject'));
  for (const fo of fos) {
    const x = parseFloat(fo.getAttribute('x') || '0') || 0;
    const y = parseFloat(fo.getAttribute('y') || '0') || 0;
    const w = parseFloat(fo.getAttribute('width') || '0') || 0;
    const h = parseFloat(fo.getAttribute('height') || '0') || 0;

    // Inner div carries text + style. If there isn't one, drop the empty
    // foreignObject — leaving it would still poison the rasterizer.
    const div = fo.querySelector('div') as HTMLElement | null;
    const text = div?.textContent ?? '';
    const cleaned = text.replace(/\s+\n/g, '\n').trim();
    if (!cleaned) {
      fo.remove();
      continue;
    }

    // Pull the styles applied at render-time. Computed style would be more
    // accurate but the cloned node isn't in the document, so it'd come back
    // empty. Inline styles (which is what Shape.tsx sets) are good enough.
    const cs = div?.style;
    const fontFamily = cs?.fontFamily || 'sans-serif';
    const fontSizeRaw = cs?.fontSize || '13';
    const fontSize = parseFloat(fontSizeRaw) || 13;
    const fontWeight = cs?.fontWeight || '400';
    const color = cs?.color || '#000';

    const lines = cleaned.split('\n');
    // Vertical centring: total block height = lines × (fontSize × lineHeight)
    // — match the live canvas's 1.2/1.3 line-heights closely enough that
    // labels don't visibly drift in the export. We use 1.25 as a compromise.
    const lineHeight = fontSize * 1.25;
    const blockH = lines.length * lineHeight;
    const baseline = y + Math.max(0, (h - blockH) / 2) + fontSize;

    const textEl = document.createElementNS(SVG_NS, 'text');
    textEl.setAttribute('x', String(x + w / 2));
    textEl.setAttribute('y', String(baseline));
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('font-family', fontFamily);
    textEl.setAttribute('font-size', String(fontSize));
    textEl.setAttribute('font-weight', String(fontWeight));
    textEl.setAttribute('fill', color);
    textEl.setAttribute('dominant-baseline', 'alphabetic');

    lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', String(x + w / 2));
      if (i === 0) {
        tspan.setAttribute('dy', '0');
      } else {
        tspan.setAttribute('dy', `${lineHeight}`);
      }
      tspan.textContent = line;
      textEl.appendChild(tspan);
    });

    fo.parentNode?.replaceChild(textEl, fo);
  }
}
