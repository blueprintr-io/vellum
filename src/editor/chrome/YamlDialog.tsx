/* View / edit the active diagram as YAML.
 *
 * Replaces the old "Export YAML" menu entry, which silently downloaded the
 * file with no preview step. The new dialog opens a textarea seeded with
 * `diagramToYaml(state.diagram)`, lets the user edit it inline, and on
 * commit pipes the edits back through `yamlToDiagram` (the same parser the
 * file-open path uses, so it carries the schema validation + iconSvg
 * sanitisation contract).
 *
 * Three actions:
 *   1. Apply — re-parse the textarea, replace the in-memory diagram. Surfaces
 *      a per-line parse error if the YAML is broken so the user can keep
 *      editing rather than losing their text.
 *   2. Download — write the (current textarea contents, NOT the live store)
 *      to disk as a `.vellum` file. We use the textarea text rather than
 *      re-serialising the store so a partial edit can be saved without first
 *      committing — useful for "let me snapshot this draft to disk".
 *   3. Copy — same intent, into the OS clipboard. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { diagramToYaml, triggerDownload, yamlToDiagram } from '@/store/persist';

export function YamlDialog({ onClose }: { onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const diagram = useEditor((s) => s.diagram);
  const filePath = useEditor((s) => s.filePath);
  const loadDiagram = useEditor((s) => s.loadDiagram);

  // Seed the textarea once at mount. After that the user owns the buffer —
  // re-syncing from `diagram` would clobber in-flight edits any time the
  // store ticks (selection, hover-on-z, autosave timestamp, etc.).
  const initial = useMemo(() => diagramToYaml(diagram), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [applyState, setApplyState] = useState<'idle' | 'applied'>('idle');

  useEffect(() => {
    // Defer attaching the outside-click listener so the click that opened the
    // dialog doesn't immediately close it. Same pattern as SaveDialog.
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Auto-focus the textarea on open. cursor at start so the user immediately
  // sees the top of the file (the meta block + first few shapes).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(0, 0);
  }, []);

  const filename = useMemo(() => {
    if (!filePath) return 'untitled.vellum';
    const base = filePath.split('/').pop() ?? filePath;
    if (base.endsWith('.vellum')) return base;
    if (base.endsWith('.vellum.yaml') || base.endsWith('.vellum.yml')) return base;
    return `${base}.vellum`;
  }, [filePath]);

  const apply = () => {
    try {
      const parsed = yamlToDiagram(text);
      loadDiagram(parsed, filePath);
      setError(null);
      setApplyState('applied');
      setTimeout(() => setApplyState('idle'), 1200);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    }
  };

  const download = () => {
    triggerDownload(filename, text, 'application/x-yaml');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1200);
    } catch (e) {
      // Fallback — surface as the error line so the user still gets feedback.
      setError(`Copy failed: ${(e as Error).message ?? e}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[50] flex items-center justify-center bg-black/40">
      <div
        ref={wrapRef}
        className="float w-[min(820px,92vw)] max-h-[88vh] flex flex-col p-4 gap-3"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold">View/Edit as YAML</div>
            <div className="text-[11px] text-fg-muted font-mono">{filename}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg"
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none">
              <path
                d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Clear stale error/apply chips on first keystroke after either.
            if (error) setError(null);
            if (applyState === 'applied') setApplyState('idle');
          }}
          spellCheck={false}
          className="flex-1 min-h-[360px] font-mono text-[12px] leading-relaxed text-fg bg-bg-subtle border border-border rounded-md p-3 resize-none outline-none focus:border-accent"
          // Tab inside the textarea inserts two spaces rather than escaping
          // focus — YAML is indentation-sensitive and the user is here to
          // edit the structure, not to navigate the dialog.
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const ta = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = ta;
              const next = `${text.slice(0, s)}  ${text.slice(end)}`;
              setText(next);
              // Restore caret after the inserted spaces.
              requestAnimationFrame(() => {
                ta.setSelectionRange(s + 2, s + 2);
              });
            }
          }}
        />
        {error && (
          <div className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-fg-muted">
            Edits aren't applied to the canvas until you press <strong>Apply</strong>.
          </div>
          <div className="flex gap-2">
            <button
              onClick={copy}
              className="px-3 py-[6px] rounded-md text-[12px] text-fg bg-bg-subtle border border-border hover:bg-bg-emphasis"
            >
              {copyState === 'copied' ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={download}
              className="px-3 py-[6px] rounded-md text-[12px] text-fg bg-bg-subtle border border-border hover:bg-bg-emphasis"
            >
              Download
            </button>
            <button
              onClick={apply}
              className="px-3 py-[6px] rounded-md text-[12px] text-white bg-accent-deep border border-accent-emphasis hover:bg-accent-emphasis"
            >
              {applyState === 'applied' ? 'Applied!' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
