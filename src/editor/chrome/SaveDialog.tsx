import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { handleCopyPng, handleExportYaml, handleSaveAs } from '../files';

type Format = 'vellum' | 'png' | 'jpg' | 'svg';

const FORMAT_OPTIONS: {
  value: Format;
  label: string;
  hint: string;
}[] = [
  { value: 'vellum', label: '.vellum', hint: 'Vellum file (YAML)' },
  { value: 'png', label: '.png', hint: 'PNG image (raster)' },
  { value: 'jpg', label: '.jpg', hint: 'JPEG image (compressed raster)' },
  { value: 'svg', label: '.svg', hint: 'SVG (vector, raw)' },
];

/** Cmd+S dialog. Picks format then routes to the right exporter:
 *  - vellum → save-as flow (FSA picker)
 *  - png/jpg → render canvas to image, download (or to clipboard for png)
 *  - svg → serialise the SVG node, trigger download
 */
export function SaveDialog({ onClose }: { onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [format, setFormat] = useState<Format>('vellum');
  const title = useEditor((s) => s.diagram.meta.title ?? 'untitled');

  useEffect(() => {
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

  const handleSave = async () => {
    onClose();
    if (format === 'vellum') {
      await handleSaveAs();
      return;
    }
    if (format === 'png') {
      await handleCopyPng();
      return;
    }
    if (format === 'svg') {
      const svgEl = document.querySelector('svg[width="100%"]') as SVGSVGElement | null;
      if (!svgEl) return;
      const xml = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([xml], { type: 'image/svg+xml' });
      triggerDownload(`${title}.svg`, blob);
      return;
    }
    if (format === 'jpg') {
      const svgEl = document.querySelector('svg[width="100%"]') as SVGSVGElement | null;
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const xml = new XMLSerializer().serializeToString(svgEl);
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = getComputedStyle(svgEl).background || '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const blob: Blob | null = await new Promise((res) =>
        c.toBlob((b) => res(b), 'image/jpeg', 0.92),
      );
      if (blob) triggerDownload(`${title}.jpg`, blob);
      return;
    }
    // Other paths default to YAML download as a safety net.
    handleExportYaml();
  };

  return (
    <div className="fixed inset-0 z-[50] flex items-center justify-center bg-black/40">
      <div ref={wrapRef} className="float w-[360px] p-4">
        <div className="text-[14px] font-semibold mb-1">Save</div>
        <div className="text-[11px] text-fg-muted mb-3">
          {title}.{format}
        </div>
        <div className="grid grid-cols-1 gap-1 mb-3">
          {FORMAT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setFormat(o.value)}
              className={`flex items-center justify-between px-3 py-[7px] rounded-md border text-left text-[12px] transition-colors duration-75 ${
                format === o.value
                  ? 'bg-bg-emphasis border-accent text-fg'
                  : 'bg-bg-subtle border-border text-fg hover:bg-bg-emphasis'
              }`}
            >
              <span className="font-mono">{o.label}</span>
              <span className="text-[10px] text-fg-muted">{o.hint}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-[6px] rounded-md text-[12px] text-fg bg-bg-subtle border border-border hover:bg-bg-emphasis"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-[6px] rounded-md text-[12px] text-white bg-accent-deep border border-accent-emphasis hover:bg-accent-emphasis"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
