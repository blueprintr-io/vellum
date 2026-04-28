// TRADEMARK-COMPLIANCE: hamburger menu now contains a "Legal" entry that
// opens the LegalDialog (IP complaints, credits, ToS).

import { Fragment, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { SettingsDialog } from './SettingsDialog';
import {
  handleCopyPng,
  handleNew,
  handleOpen,
  handleSave,
  handleSaveAs,
} from '../files';
import { YamlDialog } from './YamlDialog';
import { I } from './icons';
import { usePlugins } from '@/plugins/PluginProvider';
import type { PluginMenuEntry } from '@/plugins/types';

/** Top-right action cluster: theme toggle, share, publish (primary), menu.
 *  The Publish button uses bg-accent-deep + text-white — DO NOT use text-chalk
 *  on accent backgrounds (a known Blueprintr light-mode contrast bug). */
export function Actions() {
  const theme = useEditor((s) => s.theme);
  const toggleTheme = useEditor((s) => s.toggleTheme);
  // Inspector pin — opens the right panel even with empty selection so the
  // user can configure default styles before drawing. Active state mirrors
  // the persisted `inspectorOpen` flag so the toggle reads as a stable
  // setting.
  const inspectorOpen = useEditor((s) => s.inspectorOpen);
  const toggleInspector = useEditor((s) => s.toggleInspector);

  // Plugin-contributed buttons render LEFT of the built-in cluster so the
  // hamburger stays in its conventional far-right position. Each plugin owns
  // its own button styling — we don't (yet) export <ChromeButton> as part of
  // the public API.
  const plugins = usePlugins();

  return (
    <div className="absolute top-[14px] right-[14px] z-20 flex gap-2">
      {plugins.map((p) => {
        if (p.toolbarButtons == null) return null;
        const node =
          typeof p.toolbarButtons === 'function'
            ? p.toolbarButtons()
            : p.toolbarButtons;
        return <Fragment key={p.id}>{node}</Fragment>;
      })}
      <ChromeButton
        title="Copy diagram as PNG"
        onClick={() => void handleCopyPng()}
        iconOnly
      >
        <I.copy />
      </ChromeButton>
      <ChromeButton
        title={
          inspectorOpen
            ? 'Hide style panel'
            : 'Open style panel (configure defaults)'
        }
        onClick={toggleInspector}
        iconOnly
        active={inspectorOpen}
      >
        {/* Sliders/tweak glyph — we don't have a dedicated icon component for
         *  this in I, so render the SVG inline. Three horizontal lines with
         *  a dot on each, telegraphing "settings panel" without overloading
         *  any existing affordance. */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="9" cy="4" r="1.6" fill="var(--bg)" stroke="currentColor" strokeWidth="1.4" />
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="6" cy="8" r="1.6" fill="var(--bg)" stroke="currentColor" strokeWidth="1.4" />
          <line x1="3" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="11" cy="12" r="1.6" fill="var(--bg)" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </ChromeButton>
      <ChromeButton
        title="Toggle theme"
        onClick={toggleTheme}
        iconOnly
      >
        {theme === 'light' ? <I.themeLight /> : <I.themeDark />}
      </ChromeButton>
      {/* Share + Publish were placeholders that didn't do anything; hidden
       *  until they're wired so the chrome doesn't read as half-built. */}
      <MenuButton />
    </div>
  );
}

/** The hamburger ⨯ file menu. Opens on click; closes on outside click or Esc.
 *  Items are simple buttons that delegate to the file-action helpers (which
 *  share their plumbing with the keybinding handler). */
function MenuButton() {
  const [open, setOpen] = useState(false);
  // Settings dialog (added 2026-04-28). Replaces the old "Customise canvas…"
  // popover and the standalone "Disable / Enable tips" line item — both are
  // folded into the dialog along with the new edge-connector toggle. The
  // local state slot keeps the dialog opening / closing trivial; we don't
  // need a global cmdk-style flag since only the menu opens it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const plugins = usePlugins();
  // Flatten plugin-contributed menu entries in plugin order. Each plugin's
  // entries are kept contiguous; ordering across plugins follows the order
  // they were passed to <VellumEditor plugins={...} />.
  const pluginMenuEntries: PluginMenuEntry[] = plugins.flatMap(
    (p) => p.menuItems ?? [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (
    label: string,
    shortcut: string | null,
    fn: () => void | Promise<void>,
  ) => (
    <button
      onClick={() => {
        setOpen(false);
        void fn();
      }}
      className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
    >
      <span>{label}</span>
      {shortcut && (
        <span className="font-mono text-[9px] text-fg-muted">{shortcut}</span>
      )}
    </button>
  );

  const sep = (
    <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />
  );

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const meta = isMac ? '⌘' : 'Ctrl';

  return (
    <div ref={wrapRef} className="relative">
      <ChromeButton
        title="Menu"
        iconOnly
        onClick={() => setOpen((o) => !o)}
        active={open}
      >
        <I.menu />
      </ChromeButton>
      {open && (
        <div className="float absolute top-[40px] right-0 z-30 w-[200px] py-1">
          {item('New', `${meta}N`, handleNew)}
          {item('Open…', `${meta}O`, handleOpen)}
          {sep}
          {item('Save', `${meta}S`, handleSave)}
          {item('Save As…', `⇧${meta}S`, handleSaveAs)}
          {item('View/Edit as YAML', null, () => setYamlOpen(true))}
          {item('Copy as PNG', null, handleCopyPng)}
          {sep}
          {/* Single Settings entry — folds canvas customisation (paper,
           *  dots, gridlines), the tips master switch, and the new
           *  edge-connector toggle into one dialog. The toast's "disable
           *  tips in settings" caption now matches the actual location of
           *  the toggle. */}
          {item('Settings…', null, () => setSettingsOpen(true))}
          {/* Plugin-contributed entries sit here, between core file/canvas
              actions and the Legal trailer. A separator before is included
              only if at least one plugin item exists, so the menu doesn't
              show a trailing rule when no plugins are registered. */}
          {pluginMenuEntries.length > 0 && (
            <>
              {sep}
              {pluginMenuEntries.map((entry) =>
                entry.type === 'separator' ? (
                  <div
                    key={entry.id}
                    className="my-1 mx-2 border-t border-border"
                    aria-hidden="true"
                  />
                ) : (
                  <button
                    key={entry.id}
                    disabled={entry.disabled}
                    onClick={() => {
                      setOpen(false);
                      if (!entry.disabled) entry.onClick();
                    }}
                    className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span>{entry.label}</span>
                    {entry.shortcut && (
                      <span className="font-mono text-[9px] text-fg-muted">
                        {entry.shortcut}
                      </span>
                    )}
                  </button>
                ),
              )}
            </>
          )}
          {sep}
          {/* TRADEMARK-COMPLIANCE: Legal entry — opens IP complaints,
              library credits, and Terms of Service in a single dialog. */}
          {item('Legal', null, () => openLegalDialog('ip-complaints'))}
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {yamlOpen && <YamlDialog onClose={() => setYamlOpen(false)} />}
    </div>
  );
}

type ChromeButtonProps = {
  title?: string;
  onClick?: () => void;
  iconOnly?: boolean;
  active?: boolean;
  children: React.ReactNode;
};

function ChromeButton({
  title,
  onClick,
  iconOnly,
  active,
  children,
}: ChromeButtonProps) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-[6px] rounded-lg border ${
        active ? 'border-accent/40 bg-bg-emphasis' : 'border-border bg-bg/[0.92]'
      } backdrop-blur-chrome text-fg text-[12px] font-medium shadow-[0_2px_8px_rgb(0_0_0_/_0.12)] hover:bg-bg-emphasis transition-colors duration-100 ${
        iconOnly ? 'w-[34px] p-[7px] justify-center' : 'px-3 py-[7px]'
      }`}
    >
      {children}
    </button>
  );
}
