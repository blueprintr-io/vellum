import { useEffect } from 'react';
import { useEditor } from '@/store/editor';
import { getActiveHandle, saveVellumFile, setActiveHandle } from '@/store/persist';
import { parseDiagram } from '@/store/schema';
import type { DiagramState } from '@/store/types';

/** Debounce ms for autosave to disk (FSA file handle). 1.5s is short enough
 *  to feel "live" but long enough that a string of edits coalesce into one
 *  write. */
const AUTOSAVE_DEBOUNCE_MS = 1500;

/** Debounce ms for the localStorage browser backup. Shorter than the disk
 *  autosave because (a) localStorage writes are sub-millisecond so we can
 *  afford to be aggressive, and (b) browser refresh recovery is the primary
 *  thing this guards against — losing a few hundred ms of work is fine,
 *  losing 1.5 seconds is not. */
const BROWSER_BACKUP_DEBOUNCE_MS = 250;

/** localStorage key for the redundant browser backup. Distinct from the
 *  Zustand persist key (`vellum.editor`) so a corrupt persist write doesn't
 *  also wipe the recovery copy. The Editor reads this on boot and merges it
 *  back in if persist hydration somehow lost shapes (see `restoreFromBackup`
 *  below for the rules). */
const BROWSER_BACKUP_KEY = 'vellum.diagram.backup';

type BackupShape = {
  v: 1;
  /** Wall-clock time of the backup write; lets us prefer the freshest copy
   *  if there's both a persist hydration and a backup. */
  t: number;
  diagram: DiagramState;
};

/** Watches `dirty` and silently saves to the active file handle (FSA). Plus
 *  a separate, more aggressive backup to localStorage on
 *  every diagram change, independent of the file handle — that's what
 *  guarantees a hard-refresh restores the last-edited state even when the
 *  user hasn't done a Save As yet. The Zustand persist middleware also
 *  writes the diagram, but we keep this redundant copy so a corrupted
 *  persist write or a future schema change can't lose user work. */
export function useAutosave() {
  const dirty = useEditor((s) => s.dirty);

  // FSA file autosave — writes through the active file handle if one
  // is present. No handle → wait for explicit Save As; we don't surprise the
  // user with a save prompt mid-edit.
  useEffect(() => {
    if (!dirty) return;
    const handle = getActiveHandle();
    if (!handle) return;

    const t = setTimeout(async () => {
      try {
        const s = useEditor.getState();
        const result = await saveVellumFile(s.diagram, handle, handle.name);
        setActiveHandle(result.handle);
        useEditor.getState().markSaved();
      } catch (err) {
        console.error('autosave failed', err);
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [dirty]);

  // Browser backup — subscribe to diagram changes and debounce-write
  // to localStorage. This runs regardless of whether a file handle exists
  // and is the recovery anchor for hard refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: DiagramState | null = null;

    const writeNow = (d: DiagramState) => {
      try {
        const payload: BackupShape = { v: 1, t: Date.now(), diagram: d };
        localStorage.setItem(BROWSER_BACKUP_KEY, JSON.stringify(payload));
      } catch (err) {
        // Quota errors or private-mode storage failures — surface to console
        // but don't break the editor.
        console.warn('browser backup failed', err);
      }
    };

    const unsub = useEditor.subscribe((s, prev) => {
      if (s.diagram === prev.diagram) return;
      pending = s.diagram;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending) writeNow(pending);
        pending = null;
        timer = null;
      }, BROWSER_BACKUP_DEBOUNCE_MS);
    });

    // Flush on unload — guarantees the very last edit lands even if the
    // debounce hasn't fired yet. localStorage is synchronous, so this runs
    // inline without blocking the close.
    const onUnload = () => {
      if (pending) {
        writeNow(pending);
        pending = null;
      }
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onUnload();
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  // Recovery — on first mount, if the persisted Zustand diagram is empty
  // but the browser backup has shapes, restore from the backup. This catches
  // the failure mode where the persist write got corrupted or the schema
  // version bumped and the persist layer reset diagram to default. The
  // backup is the authoritative recent-state source.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BROWSER_BACKUP_KEY);
      if (!raw) return;
      const parsedRaw = JSON.parse(raw) as Partial<BackupShape>;
      if (!parsedRaw?.diagram) return;
      // Run the backup through the same schema validator as the file load
      // path. localStorage is same-origin so an external attacker can't write
      // to it, but a prior compromise (or a corrupted persist write) shouldn't
      // re-arm a hostile diagram on next refresh.
      const safeDiagram = parseDiagram(parsedRaw.diagram);
      const cur = useEditor.getState().diagram;
      const curEmpty =
        cur.shapes.length === 0 &&
        cur.connectors.length === 0 &&
        cur.annotations.length === 0;
      const backupHasContent =
        safeDiagram.shapes.length > 0 || safeDiagram.connectors.length > 0;
      if (curEmpty && backupHasContent) {
        // Match loadDiagram's reset semantics: clear history, mark as saved
        // so the user doesn't see a stale dirty pill on a fresh restore.
        useEditor.getState().loadDiagram(safeDiagram, null);
      }
    } catch (err) {
      console.warn('browser backup restore failed', err);
    }
    // Run once on mount — we never want to clobber an in-flight session
    // diagram with an older backup mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
