// TRADEMARK-COMPLIANCE: mounts LegalDialog (IP complaints, credits, ToS)
// and ImportLibraryDialog (Tier 2 stub). Both are global overlays opened
// from the hamburger menu and the library picker respectively.

import { useEffect } from 'react';
import { useEditor } from '@/store/editor';
import { Canvas } from './canvas/Canvas';
import { Brand } from './chrome/Brand';
import { FloatingToolbar } from './chrome/FloatingToolbar';
import { LibraryPanel } from './chrome/LibraryPanel';
import { MoreShapesPopover } from './chrome/MoreShapesPopover';
import { UniversalLauncher } from './chrome/UniversalLauncher';
import { Actions } from './chrome/Actions';
import { GlobalDock } from './chrome/GlobalDock';
import { ZoomDock } from './chrome/ZoomDock';
import { UndoDock } from './chrome/UndoDock';
import { TipsButton } from './chrome/TipsButton';
import { TipToast } from './chrome/TipToast';
import { Inspector } from './chrome/inspector/Inspector';
import { InlineLabelEditor } from './chrome/InlineLabelEditor';
import { InlineCellEditor } from './chrome/InlineCellEditor';
import { ConnectorLabelEditor } from './chrome/ConnectorLabelEditor';
import { PenPanel } from './chrome/PenPanel';
import { ReturnToContent } from './chrome/ReturnToContent';
import { SaveDialog } from './chrome/SaveDialog';
import { LegalDialog } from './chrome/legal/LegalDialog';
import { ImportLibraryDialog } from './chrome/icons/ImportLibraryDialog';
import { useKeybindings } from './useKeybindings';
import { useAutosave } from './useAutosave';
import { PluginProvider } from '@/plugins/PluginProvider';
import type { VellumPlugin } from '@/plugins/types';

/** Public props for the top-level <VellumEditor> component. Currently the
 *  only knob is `plugins` (slot/extension contributions). Additional config
 *  — controlled-mode file, theme override, etc. — slots in here as needed. */
export interface VellumEditorProps {
  /** Slot/extension contributions. See `VellumPlugin` for the available
   *  slots (hamburger menu, context menu, top-right toolbar, brand icon). */
  plugins?: readonly VellumPlugin[];
}

/** Single-fullscreen editor shell. No persistent sidebars, no titlebar, no
 *  status bar. Floating chrome over a fullscreen canvas — Excalidraw-style,
 *  deliberately the opposite of draw.io's clutter. */
export function Editor({ plugins }: VellumEditorProps = {}) {
  const theme = useEditor((s) => s.theme);
  const saveDialogOpen = useEditor((s) => s.saveDialogOpen);
  const setSaveDialogOpen = useEditor((s) => s.setSaveDialogOpen);
  const legalDialogOpen = useEditor((s) => s.legalDialogOpen);
  const legalDialogTab = useEditor((s) => s.legalDialogTab);
  const closeLegalDialog = useEditor((s) => s.closeLegalDialog);
  const importDialogOpen = useEditor((s) => s.importDialogOpen);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);
  useKeybindings();
  useAutosave();

  // Theme mirrors to html.theme-light. Default styles target dark — adding the
  // class flips token vars + lights up `light:` Tailwind variants.
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  return (
    <PluginProvider plugins={plugins}>
      <div className="relative w-screen h-screen overflow-hidden bg-bg">
        <div className="absolute inset-0 overflow-hidden">
          <Canvas />
        </div>

        <Brand />
        <FloatingToolbar />
        <LibraryPanel />
        <MoreShapesPopover />
        <UniversalLauncher />
        <Actions />
        <GlobalDock />
        <UndoDock />
        <TipsButton />
        <TipToast />
        <ZoomDock />
        <Inspector />
        <InlineLabelEditor />
        <InlineCellEditor />
        <ConnectorLabelEditor />
        <PenPanel />
        <ReturnToContent />
        {saveDialogOpen && (
          <SaveDialog onClose={() => setSaveDialogOpen(false)} />
        )}
        <LegalDialog
          open={legalDialogOpen}
          initialTab={legalDialogTab}
          onClose={closeLegalDialog}
        />
        {importDialogOpen && (
          <ImportLibraryDialog onClose={() => setImportDialogOpen(false)} />
        )}
      </div>
    </PluginProvider>
  );
}
