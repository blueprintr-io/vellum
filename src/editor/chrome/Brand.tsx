import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { I } from './icons';
import { usePlugins } from '@/plugins/PluginProvider';

/** Top-left file identity. The handwriting "V" mark IS the brand — vellum-as-
 *  drafting-paper signal. The mark uses the paper colour, not the chrome bg.
 *
 *  The sub-line shows real save state: "autosaved Ns ago" when we have a save
 *  destination and the diagram is clean; "unsaved" when dirty; "never saved"
 *  when there's no destination yet. */
export function Brand() {
  const dirty = useEditor((s) => s.dirty);
  const filePath = useEditor((s) => s.filePath);
  const title = useEditor((s) => s.diagram.meta.title ?? 'untitled');
  const setTitle = useEditor((s) => s.setTitle);
  const lastSavedAt = useEditor((s) => s.lastSavedAt);
  const isEmpty = useEditor(
    (s) => s.diagram.shapes.length === 0 && s.diagram.connectors.length === 0,
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus + select-all when entering edit mode.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  // Re-sync draft if the title changes externally (e.g., load).
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commitTitle = () => {
    const t = draft.trim();
    if (t && t !== title) setTitle(t);
    setEditing(false);
  };

  // Tick once a second so the "Ns ago" copy stays current. We use an interval
  // rather than reading Date.now() during render — keeps the component stable
  // and avoids stale-closure bugs.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Split path into directory + .vellum extension hint.
  const dir = (filePath ?? '').replace(/\/[^/]*\.vellum(\.ya?ml)?$/, '');

  const subline = (() => {
    // Fresh blank canvas — say nothing instead of nagging "unsaved" before the
    // user has even drawn anything.
    if (!filePath && isEmpty && !dirty) return 'new diagram';
    if (!lastSavedAt) {
      if (!filePath) return dirty ? 'unsaved (⌘S to save)' : 'new diagram';
      return dirty ? `${dir} · unsaved (⌘S to save)` : `${dir} · never saved`;
    }
    if (dirty) return `${dir} · saving…`;
    return `${dir} · autosaved ${formatAgo(now - lastSavedAt)}`;
  })();

  // Library-panel toggle — lives on the Brand card so the entry point is
  // co-located with the file identity (the "this is your project workspace"
  // anchor in the top-left).
  const libraryPanelOpen = useEditor((s) => s.libraryPanelOpen);
  const toggleLibraryPanel = useEditor((s) => s.toggleLibraryPanel);

  // Plugin slot: a consumer (e.g. Blueprintr) can replace the default "V"
  // mark with its own node — typically a user avatar in an embedded /
  // hosted context. First plugin contributing brandIcon wins; the wrapper
  // span (size, border-radius, paper background) is preserved so the
  // replacement sits cleanly inside the same chrome footprint without each
  // plugin re-implementing the mark frame.
  const plugins = usePlugins();
  const brandIconPlugin = plugins.find((p) => p.brandIcon != null);
  const brandIconNode = brandIconPlugin
    ? typeof brandIconPlugin.brandIcon === 'function'
      ? brandIconPlugin.brandIcon()
      : brandIconPlugin.brandIcon
    : null;

  return (
    <div className="float absolute top-[14px] left-[14px] z-20 flex items-center gap-[10px] py-[7px] pl-2 pr-2">
      <span className="flex-shrink-0 w-[26px] h-[26px] rounded-md bg-paper text-ink font-sketch text-[18px] font-bold flex items-center justify-center overflow-hidden">
        {brandIconNode ?? 'V'}
      </span>
      <div className="flex flex-col leading-[1.1] gap-[2px]">
        <span className="text-[12px] font-medium flex items-center gap-[6px]">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(title);
                  setEditing(false);
                }
              }}
              className="bg-bg-subtle border border-accent/40 rounded px-1 py-[1px] text-[12px] font-medium text-fg outline-none"
              style={{ width: Math.max(80, draft.length * 7 + 12) }}
            />
          ) : (
            <button
              onClick={() => {
                setDraft(title);
                setEditing(true);
              }}
              title="Rename diagram"
              className="bg-transparent border-none p-0 m-0 text-[12px] font-medium text-fg hover:underline cursor-text"
            >
              {title}
            </button>
          )}
          <span className="text-fg-muted font-mono text-[10px]">
            .vellum
          </span>
          {dirty && (
            <span
              className="w-[5px] h-[5px] rounded-full bg-accent"
              title="Unsaved"
            />
          )}
        </span>
        <span className="font-mono text-[9px] text-fg-muted">{subline}</span>
      </div>
      {/* Toggle → opens the persistent left-rail library card. Uses the
       *  shapes glyph (same as the floating-toolbar shapes button) so the
       *  affordance reads as "this opens the shapes/icons panel" rather
       *  than a generic expand caret. */}
      <button
        onClick={toggleLibraryPanel}
        title={
          libraryPanelOpen
            ? 'Hide shapes & icons panel'
            : 'Open shapes & icons panel'
        }
        aria-pressed={libraryPanelOpen}
        className={`flex-shrink-0 w-[24px] h-[24px] rounded-md flex items-center justify-center bg-transparent border border-transparent text-fg-muted hover:bg-bg-emphasis hover:text-fg ml-1 ${
          libraryPanelOpen ? 'bg-bg-emphasis text-fg' : ''
        }`}
      >
        <I.more />
      </button>
    </div>
  );
}

/** Format "Ns ago", "Nm ago", "Nh ago". Below 1s shows as "just now" so a fresh
 *  save doesn't read as "0s ago". */
function formatAgo(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
