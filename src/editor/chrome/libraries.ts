// TRADEMARK-COMPLIANCE: this catalog drives the in-editor library tabs.
// By default Vellum ships with NO preloaded shape libraries. The basic
// primitives (rect / ellipse / diamond / arrow / line / text / note)
// live in the floating top toolbar, not here — duplicating them as
// library tiles would be noise. Everything else (notation packs like
// BPMN / UML, network shapes, and any vendor stencils) comes in via the
// Tier 2 user-import flow.
//
// The only tab that ships is "Recent", which is a user-activity log
// rather than a preloaded set — it populates as shapes are placed.
// "Personal" is also surfaced in the panels but is synthesized at
// render time from the persisted slice, not declared here.
//
// If a notation/vendor library is ever re-bundled, register it here AND
// (for vendor packs) in /public/icons/manifest.json so the icon-search
// "loaded?" check resolves correctly via findManifestVendorKey in
// useIconSearch.ts.

/** Static shape catalog — surfaced by both the floating MoreShapesPopover and
 *  the persistent LibraryPanel. v1 is hard-coded; v2 will derive from
 *  `src/libraries/*.ts` (each loaded on demand) so users can install/remove
 *  packs without a code change. Living here (not in MoreShapesPopover) so any
 *  future surface — palette, command-k, etc. — can read from the same source. */

export type LibraryShape = {
  id: string;
  label: string;
  glyph: string;
  /** When this shape is bound to a hotkey slot (from the editor store). */
  boundKey?: string;
};

export type Library = {
  id: string;
  name: string;
  version: string;
  shapes: LibraryShape[];
};

export const LIBRARIES: Library[] = [
  // Recent ships empty — populated as the user actually places shapes.
  { id: 'recent', name: 'Recent', version: '', shapes: [] },
];
