/* Minimal in-browser ZIP extractor.
 *
 * Why a hand-rolled parser instead of pulling in JSZip / fflate? Two reasons:
 *
 * 1. The only ingestion paths we currently care about are .zip files
 *    containing SVG icons (and .vssx Visio stencil packages, which are
 *    OOXML — really just zips with an XML payload). Both fit comfortably
 *    in a few hundred lines, so the dep weight isn't worth it.
 * 2. Modern browsers expose `DecompressionStream("deflate-raw")` natively
 *    (Chrome 80+, Firefox 113+, Safari 16.4+ — all our targets). So the
 *    only thing left is parsing the ZIP container itself: find the central
 *    directory, walk the entries, decompress each one's data.
 *
 * What we deliberately skip:
 *   - ZIP64 (>4GB archives — irrelevant for icon packs).
 *   - Encrypted entries (no use case in this app).
 *   - File-comment / extra-field decoding (not load-bearing for our flow).
 *   - Compression methods other than 0 (stored) and 8 (deflate). Anything
 *     else is reported back to the caller via `skipped` so the UI can warn.
 *
 * Returned entries are streamed out as ArrayBuffer slices; callers convert
 * to text via TextDecoder when they need to (e.g., for SVG payloads). */

export type ZipEntry = {
  /** Path inside the zip, with forward slashes (zip spec uses '/'). */
  name: string;
  /** Decompressed bytes. */
  data: ArrayBuffer;
};

export type ZipExtractResult = {
  entries: ZipEntry[];
  /** Names we encountered but couldn't decode — usually unsupported
   *  compression methods. Callers can surface these as warnings. */
  skipped: { name: string; reason: string }[];
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL_DIR = 0x02014b50;

export async function extractZip(buffer: ArrayBuffer): Promise<ZipExtractResult> {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // EOCD lives at the END of the file. There may be up to 65535 bytes of
  // comment after it, so we scan backwards from the end up to 65557 bytes
  // (22-byte EOCD + 65535 max comment).
  const minEocd = Math.max(0, buffer.byteLength - 65557);
  let eocdOffset = -1;
  for (let i = buffer.byteLength - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Not a valid zip file (end-of-central-directory not found).');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const decoder = new TextDecoder();

  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL_DIR) break;

    const generalFlags = view.getUint16(p + 8, true);
    const compressionMethod = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const fileNameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);

    const nameBytes = u8.subarray(p + 46, p + 46 + fileNameLen);
    // Bit 11 of the general-purpose flag = filename is UTF-8 (RFC 8.3).
    // Otherwise it's CP437. We default to UTF-8 since CP437 is rare in
    // packs we'd be importing, and falling back to UTF-8 for legacy files
    // gives a reasonable approximation.
    const name = decoder.decode(nameBytes);

    p += 46 + fileNameLen + extraLen + commentLen;

    // Skip directory entries — they have no payload.
    if (name.endsWith('/')) continue;
    if (generalFlags & 0x0001) {
      skipped.push({ name, reason: 'encrypted entries are not supported' });
      continue;
    }

    // Local header carries its own (potentially differently-sized) extra
    // field, so we re-read its lengths to find the data offset.
    const lhFileNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lhFileNameLen + lhExtraLen;
    const compressed = u8.subarray(dataOffset, dataOffset + compressedSize);

    if (compressionMethod === 0) {
      // Stored — copy the bytes out with their own backing buffer so the
      // caller doesn't accidentally hold a reference into the zip blob.
      const copy = new Uint8Array(compressed.byteLength);
      copy.set(compressed);
      entries.push({ name, data: copy.buffer });
    } else if (compressionMethod === 8) {
      try {
        // 'deflate-raw' is the no-zlib-header variant — that's the one zip
        // entries use. Plain 'deflate' would expect a 2-byte zlib header
        // and reject the data.
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([compressed]).stream().pipeThrough(ds);
        const data = await new Response(stream).arrayBuffer();
        entries.push({ name, data });
      } catch (err) {
        skipped.push({
          name,
          reason: `decompression failed (${(err as Error).message ?? err})`,
        });
      }
    } else {
      skipped.push({
        name,
        reason: `unsupported compression method ${compressionMethod}`,
      });
    }
  }

  return { entries, skipped };
}

/** Filter zip entries down to SVG payloads. Strips the ".svg" suffix and
 *  surfaces the original folder path so the caller can use it as a label
 *  hint or category. */
export function svgEntriesFrom(result: ZipExtractResult): {
  /** Just the basename, no extension — what we use as the icon's display
   *  label and as the seed for the iconAttribution.iconId. */
  baseName: string;
  /** Slash-separated folder path inside the zip (empty string for root). */
  folder: string;
  svg: string;
}[] {
  const decoder = new TextDecoder();
  const out: { baseName: string; folder: string; svg: string }[] = [];
  for (const entry of result.entries) {
    if (!/\.svgz?$/i.test(entry.name)) continue;
    // Skip macOS resource forks — zips made on Mac sometimes include them.
    if (entry.name.startsWith('__MACOSX/') || /\/\._/.test(entry.name)) continue;
    const text = decoder.decode(new Uint8Array(entry.data));
    if (!/<svg[\s>]/i.test(text)) continue;
    const lastSlash = entry.name.lastIndexOf('/');
    const folder = lastSlash >= 0 ? entry.name.slice(0, lastSlash) : '';
    const file = lastSlash >= 0 ? entry.name.slice(lastSlash + 1) : entry.name;
    const baseName = file.replace(/\.svgz?$/i, '');
    out.push({ baseName, folder, svg: text });
  }
  // Stable order: folder-first alpha, then filename alpha. Keeps the
  // imported library predictable across re-imports of the same zip.
  out.sort((a, b) =>
    a.folder === b.folder
      ? a.baseName.localeCompare(b.baseName)
      : a.folder.localeCompare(b.folder),
  );
  return out;
}

/** Detect whether a buffer looks like a zip (EOCD signature scan). Used by
 *  the import dialog to route .vssx files through the same extractor as
 *  plain zips — Visio's modern format IS a zip with a different extension. */
export function looksLikeZip(buffer: ArrayBuffer): boolean {
  // PK header at byte 0 is the cheap check — every zip starts with one of
  // 'PK\x03\x04' (local file), 'PK\x05\x06' (empty zip), or 'PK\x07\x08'.
  if (buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  const sig = view.getUint32(0, true);
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50;
}
