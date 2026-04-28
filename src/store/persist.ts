/* YAML save/load + File System Access integration.
 *
 * RULE: in-memory state === serialised state. We hand the diagram to yaml
 * directly — no DTO, no toJSON. yaml.parse(text) → DiagramState.
 *
 * Determinism: sorted keys + 2-space indent. The point is diff-friendly files
 * — git stays sane and PR review of a diagram change is readable. */

import YAML from 'yaml';
import type { DiagramState } from './types';
import { parseDiagram } from './schema';

/** YAML config: 2-space indent, sort keys for determinism, defaults flow style
 *  for short scalars. The second-arg overload of YAML.stringify accepts either
 *  a replacer or an options object; passing options directly trips an
 *  overload-resolution error. We pass `null` for the replacer slot to land
 *  cleanly in the (value, replacer, options) overload. */
const STRINGIFY_OPTS = {
  indent: 2,
  sortMapEntries: true,
  lineWidth: 0, // Don't wrap long strings — they round-trip cleanly that way.
};

/** Serialise the diagram. Note we do NOT write the editor's UI state (zoom,
 *  pan, theme, selection) into the file — those are session-local. */
export function diagramToYaml(d: DiagramState): string {
  return YAML.stringify(d, null, STRINGIFY_OPTS);
}

/** Parse a YAML file back to a DiagramState. Throws on malformed YAML or
 *  schema-invalid contents; the caller surfaces the error to the user.
 *
 *  Security: this is the boundary where untrusted file contents enter the
 *  in-memory diagram. parseDiagram (in ./schema) does two things:
 *    1. Schema-validates every field — wrong types are rejected up-front.
 *    2. Sanitizes every shape's `iconSvg` through DOMPurify.
 *  Skip parseDiagram and you reintroduce the .vellum-file XSS chain. */
export function yamlToDiagram(text: string): DiagramState {
  const parsed = YAML.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Not a Vellum YAML file (expected a top-level object)');
  }
  if (!('version' in parsed)) {
    throw new Error('Not a Vellum YAML file (missing version)');
  }
  return parseDiagram(parsed);
}

/** File handle returned by File System Access API. We hold onto it so subsequent
 *  saves write back to the same file. */
type SaveHandle = FileSystemFileHandle;

/** Open a file picker and load a Vellum YAML. Returns null if the user cancels.
 *  Falls back to a hidden <input type="file"> in browsers without FSA support. */
export async function openVellumFile(): Promise<{
  diagram: DiagramState;
  filePath: string;
  handle: SaveHandle | null;
} | null> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [h] = await (
        window as unknown as {
          showOpenFilePicker: (opts: object) => Promise<SaveHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Vellum diagram',
            accept: {
              // Canonical extension is `.vellum`. Bytes are YAML, so we still
              // accept `.yaml`/`.yml` (and legacy `.vellum.yaml`) to keep old
              // files openable, but the "correct" name is now bare `.vellum`.
              'application/x-yaml': ['.vellum', '.vellum.yaml', '.yaml', '.yml'],
            },
          },
        ],
        multiple: false,
      });
      const file = await h.getFile();
      const text = await file.text();
      return {
        diagram: yamlToDiagram(text),
        filePath: file.name,
        handle: h,
      };
    } catch (err) {
      // AbortError = user cancelled; everything else is a real error.
      if ((err as DOMException)?.name === 'AbortError') return null;
      throw err;
    }
  }

  // Fallback: <input type="file">
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vellum,.vellum.yaml,.yaml,.yml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        resolve({
          diagram: yamlToDiagram(text),
          filePath: file.name,
          handle: null,
        });
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

/** Save to the existing handle, or prompt for a new one. Returns the handle
 *  used so callers can cache it for next time. */
export async function saveVellumFile(
  diagram: DiagramState,
  existingHandle: SaveHandle | null,
  suggestedName = 'untitled.vellum',
): Promise<{ filePath: string; handle: SaveHandle | null }> {
  const text = diagramToYaml(diagram);

  if (existingHandle) {
    try {
      const writable = await existingHandle.createWritable();
      await writable.write(text);
      await writable.close();
      return { filePath: existingHandle.name, handle: existingHandle };
    } catch (err) {
      // Permission lost (user revoked) or other write error — fall through to
      // re-prompt rather than silently failing.
      console.warn('saveVellumFile: existing handle write failed', err);
    }
  }

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const h = (await (
        window as unknown as {
          showSaveFilePicker: (opts: object) => Promise<SaveHandle>;
        }
      ).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'Vellum diagram',
            accept: { 'application/x-yaml': ['.vellum'] },
          },
        ],
      })) as SaveHandle;
      const writable = await h.createWritable();
      await writable.write(text);
      await writable.close();
      return { filePath: h.name, handle: h };
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        return { filePath: existingHandle?.name ?? '', handle: existingHandle };
      }
      // Fall through to download fallback.
      console.warn('showSaveFilePicker failed; falling back to download', err);
    }
  }

  // Final fallback — trigger a browser download. The user picks the path via
  // the OS save dialog; we lose the handle but the file is on disk.
  triggerDownload(suggestedName, text, 'application/x-yaml');
  return { filePath: suggestedName, handle: null };
}

export function triggerDownload(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Firefox actually finishes the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Module-local cache for the active file handle. Keeps it out of the Zustand
 *  store (FSA handles aren't structured-cloneable, so they'd break persist). */
let _activeHandle: SaveHandle | null = null;
export function getActiveHandle(): SaveHandle | null {
  return _activeHandle;
}
export function setActiveHandle(h: SaveHandle | null) {
  _activeHandle = h;
}
