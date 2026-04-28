import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import {
  connectorPolyline,
  pointAtFraction,
  resolveConnectorPath,
} from '@/editor/canvas/routing';
import { domToMd, mdToHtml } from '@/lib/inline-marks';

/** Inline editor for a connector's `label` field. Mirrors `InlineLabelEditor`
 *  but for connectors — separate component on purpose: connectors don't
 *  carry the same body/anchor/font-family complexity that shapes do, and
 *  cramming connector handling into the shape editor was where Gemini's
 *  attempt fell apart (mismatched hook/call-site rename, etc.).
 *
 *  Listens for the same `vellum:edit-shape` CustomEvent the shape editor
 *  does. Both editors look up the id in their respective collections; the
 *  one that finds a match handles it, the other no-ops. Canvas's
 *  double-click handler is therefore oblivious to which editor will pick
 *  up the gesture — it just dispatches the id.
 *
 *  The contenteditable is positioned over the rendered label point in
 *  screen space so commit doesn't visibly jump. While the editor is open
 *  Connector.tsx suppresses its own label render (via `editingConnectorId`
 *  in the store) so the user doesn't see a ghosted-double of their typing
 *  position. */
export function ConnectorLabelEditor() {
  const [editingId, setLocalEditingId] = useState<string | null>(null);
  const setEditingConnectorId = useEditor((s) => s.setEditingConnectorId);
  // Mirror local id into store so Connector.tsx can suppress its rendered
  // label while the editor overlays it. Without that suppression the
  // editor's transparent background would show the committed text painted
  // underneath, ghosting the cursor.
  const setEditingId = (id: string | null) => {
    setLocalEditingId(id);
    setEditingConnectorId(id);
  };
  const editorRef = useRef<HTMLDivElement | null>(null);

  const updateConnector = useEditor((s) => s.updateConnector);
  const setSelected = useEditor((s) => s.setSelected);
  const connector = useEditor((s) =>
    editingId
      ? (s.diagram.connectors.find((c) => c.id === editingId) ?? null)
      : null,
  );
  const rawShapes = useEditor((s) => s.diagram.shapes);
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);

  // Listen for the shared edit signal. We coexist with InlineLabelEditor on
  // the same event — the id is checked against connectors here, against
  // shapes there. The non-matching listener silently bails.
  useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const conn = useEditor
        .getState()
        .diagram.connectors.find((c) => c.id === id);
      if (!conn) return;
      setEditingId(id);
    };
    window.addEventListener('vellum:edit-shape', onEdit);
    return () => window.removeEventListener('vellum:edit-shape', onEdit);
  }, []);

  // If the editor unmounts mid-edit (HMR, route swap), clear the store
  // flag so Connector.tsx repaints its label on next mount. Mirror of the
  // shape editor's matching effect.
  useEffect(() => {
    return () => {
      useEditor.getState().setEditingConnectorId(null);
    };
  }, []);

  // Seed the contenteditable with the current label and select all so a
  // fresh keystroke replaces. Empty labels seed a zero-width space — gives
  // the caret a real glyph to anchor against on first focus.
  useEffect(() => {
    if (!editingId || !editorRef.current || !connector) return;
    const el = editorRef.current;
    const initial = connector.label ?? '';
    if (initial === '') {
      el.textContent = '​';
    } else {
      // Stored markdown → HTML so b/i/u survive a re-edit.
      el.innerHTML = mdToHtml(initial);
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // editingId only — re-running on every connector field change would
    // wipe the user's caret on every other live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  if (!editingId || !connector) return null;

  const commit = () => {
    // DOM-to-markdown so bold/italic/underline run survives commit.
    // Plain-text view drives the empty / whitespace check — `**` alone
    // shouldn't paint a rect on the line.
    const md = domToMd(editorRef.current);
    const plain = md.replace(/\*\*|__|\*/g, '');
    const next = plain.trim() === '' ? '' : md;
    const current = connector.label ?? '';
    if (current !== next) {
      // Empty label → strip the field entirely so the renderer doesn't
      // paint an invisible-but-hit-testable label rect at the midpoint.
      updateConnector(connector.id, { label: next || undefined });
    }
    setEditingId(null);
    setSelected(connector.id);
  };
  const cancel = () => setEditingId(null);

  // Resolve the screen-space position of the label point — that's where
  // the rendered label sits, so opening the editor at the same point
  // means commit doesn't visibly jump.
  const path = resolveConnectorPath(connector, rawShapes);
  if (!path) return null;
  const poly = connectorPolyline(
    connector,
    path.fx,
    path.fy,
    path.tx,
    path.ty,
    path.fromAnchor,
    path.toAnchor,
    path.fromRot,
    path.toRot,
  );
  if (poly.length < 2) return null;
  const labelPt = pointAtFraction(poly, connector.labelPosition ?? 0.5);
  // Editor box is sized in screen pixels — the rendered label is a
  // 10px-tall mono-font text in world coords, so we multiply by zoom
  // and pad generously enough that wide labels still fit on first type.
  const minWidthScreen = Math.max(80, (connector.label?.length ?? 0) * 7 + 24);
  const heightScreen = 22;
  const screenX = labelPt.x * zoom + pan.x - minWidthScreen / 2;
  const screenY = labelPt.y * zoom + pan.y - heightScreen / 2;

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        minWidth: minWidthScreen,
        height: heightScreen,
        // Mono + small to match Connector.tsx's rendered <text>
        // (fontFamily=var(--font-mono), fontSize=10). We scale the world
        // size by zoom so the editor visually overlays the rendered label.
        fontFamily: 'var(--font-mono)',
        fontSize: 10 * zoom,
        lineHeight: 1.4,
        textAlign: 'center',
        color: 'var(--ink-muted)',
        background: 'var(--paper)',
        border: '1px dashed var(--accent)',
        borderRadius: 3,
        padding: '0 6px',
        outline: 'none',
        whiteSpace: 'nowrap',
        zIndex: 30,
        // Editor is a single-line inline-block so it grows horizontally
        // with the typed text (instead of soft-wrapping inside a fixed
        // height). The minWidth above gives it a non-collapsed baseline
        // even when the label is empty.
        display: 'inline-block',
        boxShadow: '0 0 0 3px rgba(31,111,235,0.18)',
        cursor: 'text',
      }}
    />
  );
}
