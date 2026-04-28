# Vellum

A diagram editor that sits between the fantastic [Excalidraw](https://excalidraw.com)
and [draw.io](https://draw.io) — keyboard-first like the former,
structured like the latter, hand-drawn or pin-sharp depending on which
layer you're working in.

Built as a single-page React + TypeScript application. Floating chrome
over a fullscreen SVG canvas. State lives in Zustand; documents save as
human-readable YAML so a `.vellum` file diffs cleanly in git.

## Status

1.0 — the public API in [`src/index.ts`](./src/index.ts) and the
`.vellum` file format are committed. Breaking changes will go through
a major version bump.

## Run locally

```sh
npm install
npm run dev
```

Open http://localhost:5173. There is no backend — everything runs in
the browser. Files save through the File System Access API where
available, falling back to a download.

## Build

```sh
npm run build       # type-check + production bundle to dist/
npm run typecheck   # type-check only
```

## Use as a library

The package exports the editor as a React component plus the supporting
types and helpers, so you can drop it into another React + Vite + TS
project:

```tsx
import { VellumEditor } from 'vellum-editor';
import 'vellum-editor/styles.css';

export default function App() {
  return <VellumEditor />;
}
```

The full public API surface is in [`src/index.ts`](./src/index.ts).
Notable exports:

- `VellumEditor` — the editor shell.
- `useEditor` — Zustand hook over the editor state.
- `parseDiagram` / `parseShapes` / `parseClipboardEnvelope` — Zod-based
  validation + sanitization. Run any foreign diagram payload through
  these before handing it to the store.
- `diagramToYaml` / `yamlToDiagram` — canonical serialization.
- `sanitizeSvg` — the DOMPurify-backed SVG sanitizer used at every load
  boundary.

The package currently ships TypeScript source; consumers need their own
TS toolchain. A pre-built ESM library bundle is on the roadmap for a
future minor release.

## File format

A `.vellum` file is YAML with a `version: '1.0'` envelope and three
arrays — `shapes`, `connectors`, `annotations`. The on-disk shape is
identical to the in-memory shape; there's no DTO and no `toJSON`.
[`src/store/types.ts`](./src/store/types.ts) is the canonical reference;
[`src/store/schema.ts`](./src/store/schema.ts) is the Zod runtime
guard, used at every load boundary (file open, autosave restore,
clipboard paste, library drop) to reject malformed input and sanitize
embedded SVG.

## Security

Vellum embeds SVG via `dangerouslySetInnerHTML` for icon rendering.
Every load path sanitizes through DOMPurify (`src/lib/sanitize-svg.ts`)
and validates structure via Zod before anything reaches the store. A
strict Content-Security-Policy in [`index.html`](./index.html) acts as
defense in depth — `script-src 'self'`, `frame-src 'none'`,
`object-src 'none'`, and an explicit `connect-src` allowlist.

If you find a sanitizer bypass, schema-validation gap, or other
exploitable surface, please disclose privately rather than opening a
public issue.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: small focused
PRs, no unrelated reformatting, keep the file format stable across
versions. Contributions are accepted under a CLA — see CONTRIBUTING.md
for details before opening a PR.

## License

Vellum is **source-available, not open-source**. It is released under
the [PolyForm Noncommercial License 1.0.0](./LICENSE). In plain English:

- You can use it, modify it, and redistribute it for any noncommercial
  purpose — personal projects, hobby use, research, education,
  charitable orgs.
- You can build it into a free Obsidian plugin, a community tool, a
  classroom demo, etc.
- You **cannot** sell it, charge for access to it, or bundle it into a
  paid product or paid service without separate written permission from
  the copyright holder.
- Donations to support a noncommercial use (e.g. an Obsidian plugin
  with a "buy me a coffee" link) are fine — donations aren't sales.

The copyright holder ([Josh Morris](mailto:josh@blueprintr.io)) retains
all rights not granted by the licence above. For licensing questions
outside the terms above, reach out.
