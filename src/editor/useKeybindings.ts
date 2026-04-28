import { useEffect } from 'react';
import { useEditor } from '@/store/editor';
import type { ToolKey } from '@/store/types';
import { handleNew, handleOpen, handleSaveAs } from './files';

/** Editor-global keymap.
 *
 *  Tool / overlay:
 *    1-9                    activate hotkey slot (1=select, 2=rect, 3=ellipse,
 *                           4=diamond, 5=arrow, 6=line, 7=text, 8=container,
 *                           9=pen)
 *    L                      laser pointer
 *    T                      table
 *    Cmd+K (or Ctrl+K)      open searchable picker
 *    Q                      toggle tool lock
 *    Esc                    close any open overlay; clear selection
 *
 *  Edit:
 *    Delete / Backspace     delete selection
 *    Cmd+Z / Cmd+Shift+Z    undo / redo
 *    Cmd+C / Cmd+X / Cmd+V  copy / cut / paste
 *    Cmd+D                  duplicate selection
 *    Cmd+A                  select all (visible)
 *    Arrow keys             nudge selection by 1px
 *    Shift+Arrow            nudge selection by 10px
 *    Cmd/Ctrl+Arrow         estimate spacing from neighbours and nudge by that
 *    [ / ]                  send backward / bring forward
 *
 *  Connectors:
 *    Space + drag           drag-out connector (canvas-level)
 *    R                      reverse selected connector direction
 *    Tab                    swap selected connector endpoints
 *    Shift+Cmd+P            promote selection Notes -> Blueprint
 *
 *  Viewport:
 *    Cmd+= / Cmd+-          zoom in / out
 *    Cmd+0                  reset view
 *    Cmd+1                  fit to content
 *
 *  Suppressed when the user is typing in a form field. */
export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const inForm = isFormElement(target);
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      const key = e.key;
      const code = e.code;

      // Allow Esc to escape form fields (blur + close overlays). Other shortcuts
      // are suppressed inside inputs.
      if (inForm) {
        if (key === 'Escape') {
          useEditor.getState().closeAllOverlays();
          (target as HTMLElement).blur();
        }
        return;
      }

      // ⌘K / Ctrl+K → palette
      if (meta && key.toLowerCase() === 'k') {
        e.preventDefault();
        useEditor.getState().toggleCmdk();
        return;
      }

      if (key === 'Escape') {
        useEditor.getState().closeAllOverlays();
        useEditor.getState().setSelected(null);
        return;
      }

      // edit
      if (key === 'Delete' || key === 'Backspace') {
        if (useEditor.getState().selectedIds.length > 0) {
          e.preventDefault();
          useEditor.getState().deleteSelection();
          return;
        }
      }

      if (meta && key.toLowerCase() === 'z') {
        e.preventDefault();
        if (shift) useEditor.getState().redo();
        else useEditor.getState().undo();
        return;
      }
      // Some keyboards fire Cmd+Y for redo — accept it too.
      if (meta && key.toLowerCase() === 'y') {
        e.preventDefault();
        useEditor.getState().redo();
        return;
      }

      // NOTE: don't intercept Cmd+C / Cmd+X / Cmd+V here. preventDefault on
      // any of those would block the native clipboard event the Canvas
      // listens for, so we couldn't mirror the selection onto the OS
      // clipboard or read images from it. The Canvas owns the full clipboard
      // dispatch.
      if (meta && key.toLowerCase() === 'd') {
        e.preventDefault();
        useEditor.getState().duplicateSelection();
        return;
      }
      if (meta && key.toLowerCase() === 'a') {
        e.preventDefault();
        // Select-all has to include connectors too — they're first-class
        // selectable items (you can style/delete them from the inspector
        // and via keybindings) and a "select everything visible" hotkey
        // that quietly leaves the arrows behind violates the principle of
        // least surprise. Marquee select uses the same shape+connector
        // composition, so this just brings Cmd+A in line.
        const st = useEditor.getState();
        const ids = [
          ...st.diagram.shapes.map((s) => s.id),
          ...st.diagram.connectors.map((c) => c.id),
        ];
        st.setSelected(ids);
        return;
      }

      // Arrow-key nudge. Works for any selectable: shapes, groups (via the
      // store-side group expansion), icons, images, freehand, tables.
      // Modifiers:
      //   plain        → 1px
      //   Shift        → 10px (coarse nudge, draw.io / figma muscle memory)
      //   Cmd/Ctrl     → estimate spacing from neighbours; magnitude is
      //                  derived in the store. Sign is what we pass below.
      // Cmd+Shift+Arrow falls through to estimate (Shift is a no-op when
      // the magnitude is being computed for you — there's nothing to scale).
      if (
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'ArrowLeft' ||
        key === 'ArrowRight'
      ) {
        const st = useEditor.getState();
        if (st.selectedIds.length === 0) return;
        e.preventDefault();
        const sx =
          key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
        const sy =
          key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
        if (meta) {
          st.nudgeSelection(sx, sy, 'estimate');
        } else {
          const step = shift ? 10 : 1;
          st.nudgeSelection(sx * step, sy * step, 'fixed');
        }
        return;
      }

      // Z-order — bracket keys
      if (!meta && key === ']') {
        e.preventDefault();
        useEditor.getState().bringForward();
        return;
      }
      if (!meta && key === '[') {
        e.preventDefault();
        useEditor.getState().sendBackward();
        return;
      }

      // ⇧⌘P promote
      if (meta && shift && key.toLowerCase() === 'p') {
        e.preventDefault();
        useEditor.getState().promoteSelection();
        return;
      }

      // ⌘G group / ⇧⌘G ungroup
      if (meta && key.toLowerCase() === 'g') {
        e.preventDefault();
        if (shift) useEditor.getState().ungroupSelection();
        else useEditor.getState().groupSelection();
        return;
      }

      // Connector keys — only fire when one connector is selected.
      if (!meta && (key === 'r' || key === 'R')) {
        const s = useEditor.getState();
        const id = s.selectedIds[0];
        if (!id) return;
        const conn = s.diagram.connectors.find((c) => c.id === id);
        if (!conn) return;
        e.preventDefault();
        // Reverse direction = swap from/to. Same as Tab semantically; "R" is
        // committed in the handoff, "Tab" too. They're aliases for now —
        // a future spec might split them but for v1 they're equivalent.
        s.updateConnector(conn.id, { from: conn.to, to: conn.from });
        return;
      }
      if (key === 'Tab') {
        const s = useEditor.getState();
        const id = s.selectedIds[0];
        if (!id) return;
        const conn = s.diagram.connectors.find((c) => c.id === id);
        if (!conn) return;
        e.preventDefault();
        s.updateConnector(conn.id, { from: conn.to, to: conn.from });
        return;
      }

      // file
      if (meta && shift && key.toLowerCase() === 's') {
        // ⇧⌘S = quick save-as (skip the format picker).
        e.preventDefault();
        void handleSaveAs();
        return;
      }
      if (meta && key.toLowerCase() === 's') {
        // ⌘S — open the format picker. The picker decides which exporter
        // runs. Quick-save (existing FSA handle) lives behind the menu only
        // now, so we don't surprise the user with a silent overwrite.
        e.preventDefault();
        useEditor.getState().setSaveDialogOpen(true);
        return;
      }
      if (meta && key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpen();
        return;
      }
      if (meta && key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNew();
        return;
      }

      // viewport
      if (meta && (key === '=' || key === '+')) {
        e.preventDefault();
        useEditor.getState().zoomBy(1.2);
        return;
      }
      if (meta && key === '-') {
        e.preventDefault();
        useEditor.getState().zoomBy(1 / 1.2);
        return;
      }
      if (meta && key === '0') {
        e.preventDefault();
        useEditor.getState().resetView();
        return;
      }
      if (meta && key === '1') {
        e.preventDefault();
        useEditor.getState().fitToContent(window.innerWidth, window.innerHeight);
        return;
      }

      // tool
      if (!meta && (key === 'q' || key === 'Q')) {
        useEditor.getState().toggleLock();
        return;
      }

      if (!meta && /^[1-9]$/.test(key)) {
        useEditor.getState().setActiveTool(key as ToolKey);
        return;
      }
      // L → laser pointer. K is no longer bound (was the old laser key); B is
      // no longer bound (was the old pen key — pen now lives on 9).
      if (!meta && (key === 'l' || key === 'L')) {
        useEditor.getState().setActiveTool('l' as ToolKey);
        return;
      }
      // T → table. Out-of-band like L; meta-gated so Cmd/Ctrl+T (browser new
      // tab) still passes through. Listening for both cases since shift+T
      // shouldn't activate it but plain t/T should.
      if (!meta && (key === 't' || key === 'T')) {
        useEditor.getState().setActiveTool('t' as ToolKey);
        return;
      }
      // N → sticky-note. Contextual: only when the Notes layer is in scope.
      // Matches the FloatingToolbar button's visibility rule so users don't
      // get a phantom tool when they're working in Blueprint-only mode.
      if (!meta && (key === 'n' || key === 'N')) {
        const lm = useEditor.getState().layerMode;
        if (lm === 'notes' || lm === 'both') {
          useEditor.getState().setActiveTool('n' as ToolKey);
        }
        return;
      }
      // Don't swallow plain Space here — Canvas needs it for pan/connector.
      void code;
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function isFormElement(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    t.isContentEditable
  );
}
