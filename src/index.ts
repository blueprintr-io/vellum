// Public API for `vellum-editor`. Consumers import from this entry only;
// anything not re-exported here is internal.

export { Editor as VellumEditor } from './editor/Editor';
export type { VellumEditorProps } from './editor/Editor';

export { useEditor } from './store/editor';

// Plugin / slot extension API. Embedders (e.g. Blueprintr) build a
// `VellumPlugin` and pass it via <VellumEditor plugins={[plugin]} /> to
// contribute hamburger items, context-menu items, top-right buttons, and
// brand-icon replacements without forking core.
export type {
  VellumPlugin,
  PluginMenuItem,
  PluginMenuSeparator,
  PluginMenuEntry,
  PluginContextMenuItem,
  PluginContextMenuEntry,
  ContextMenuTargetKind,
} from './plugins/types';
export type { ContextMenuTarget } from './editor/chrome/ContextMenu';

export type {
  DiagramState,
  Shape,
  ShapeKind,
  Anchor,
  TableCell,
  LabelAnchor,
  IconAttribution,
  IconConstraints,
  Connector,
  ConnectorEndpoint,
  EndpointMarker,
  Annotation,
  Theme,
  Layer,
  LayerMode,
  ToolKey,
  ToolDef,
  HotkeyBindings,
} from './store/types';

export {
  parseDiagram,
  parseShapes,
  parseConnectors,
  parseAnnotations,
  parseClipboardEnvelope,
} from './store/schema';
export { sanitizeSvg } from './lib/sanitize-svg';

export {
  diagramToYaml,
  yamlToDiagram,
  openVellumFile,
  saveVellumFile,
  triggerDownload,
} from './store/persist';

export {
  handleNew,
  handleOpen,
  handleSave,
  handleSaveAs,
  handleCopyPng,
  handleExportYaml,
} from './editor/files';
