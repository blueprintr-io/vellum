#!/usr/bin/env node
/**
 * Copy `vellum-iconpacks/dist/icons/` → `vellum/public/icons/` so the editor's
 * Vite build picks the bundled vendor packs up. Runs as the editor's
 * `prebuild` (after the workspaces root has built `vellum-iconpacks`).
 *
 * No-op when `vellum-iconpacks` is missing — that's the OSS distribution
 * path. The editor handles a missing /icons/manifest.json at runtime: vendor
 * search returns nothing, Iconify (network) still works.
 *
 * We deliberately avoid a runtime npm dependency on vellum-iconpacks: the
 * package has no JS API; it produces static JSON + SVG that Vite serves
 * from public/. A copy step keeps the editor and the pack loosely coupled
 * (different release cadences, different licence boundaries) without forcing
 * the editor to import-resolve a sibling workspace at build time.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const EDITOR_ROOT = join(__filename, '..', '..'); // vellum/
const REPO_ROOT = join(EDITOR_ROOT, '..'); // monorepo root
const ICONPACKS_DIST = join(REPO_ROOT, 'vellum-iconpacks', 'dist', 'icons');
const PUBLIC_ICONS = join(EDITOR_ROOT, 'public', 'icons');

async function main() {
  if (!existsSync(ICONPACKS_DIST)) {
    console.log(
      '[sync-iconpacks] vellum-iconpacks/dist/icons not found — skipping (OSS path).',
    );
    return;
  }
  // Wipe the destination first so a removed pack actually disappears from
  // the editor's public tree. cp without this would leave stale packs.
  if (existsSync(PUBLIC_ICONS)) {
    await rm(PUBLIC_ICONS, { recursive: true, force: true });
  }
  await mkdir(PUBLIC_ICONS, { recursive: true });
  await cp(ICONPACKS_DIST, PUBLIC_ICONS, { recursive: true });
  console.log(
    `[sync-iconpacks] copied ${ICONPACKS_DIST} → ${PUBLIC_ICONS}`,
  );
}

main().catch((err) => {
  console.error('[sync-iconpacks] failed:', err);
  process.exit(1);
});
