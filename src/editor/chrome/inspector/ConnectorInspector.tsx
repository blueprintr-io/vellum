import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import type { Connector, EndpointMarker, Layer, Shape } from '@/store/types';
import { resolveMarkerSize } from '@/editor/canvas/Connector';
import {
  MarkerSizeField,
  OpacityField,
  StrokeWidthField,
  SwatchRow,
} from './StyleControls';

/** Connector inspector — the heart of "connectors as relationships."
 *  Editing the from/to anchors and routing here updates the model;
 *  the canvas re-derives the path every frame from the live shape positions.
 *
 *  Multi-selection: APPEARANCE + .style routes through `updateSelection`
 *  (shape-vocabulary patch — the store maps strokeStyle→style on connectors)
 *  so changing stroke/width/opacity/dash on a connector with shapes also
 *  selected paints the lot. Routing / endpoints / label stay per-connector
 *  because they're tied to this connector's geometry + meaning. */
export function ConnectorInspector({
  conn,
  shapes,
}: {
  conn: Connector;
  shapes: Shape[];
}) {
  const update = useEditor((s) => s.updateConnector);
  const updateSelection = useEditor((s) => s.updateSelection);
  // The relationship section was removed — `shapes` no longer needed here, but
  // we accept it for API stability with the inspector wrapper.
  void shapes;

  return (
    <div className="float absolute z-[25] sm:z-[14] overflow-y-auto inset-x-0 bottom-0 top-auto h-[60vh] max-h-none rounded-b-none sm:left-auto sm:right-[14px] sm:top-[70px] sm:bottom-auto sm:w-[280px] sm:h-auto sm:max-h-[calc(100vh-100px)] sm:rounded-b-[10px]">
      <div className="px-[14px] py-3 border-b border-border flex items-center justify-between">
        <div className="text-[12px] font-semibold flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-accent" />
          Connector
        </div>
        <span className="font-mono text-[9px] text-fg-muted px-[6px] py-[2px] bg-bg-emphasis rounded-[3px]">
          connector
        </span>
      </div>

      <Section title="LAYER">
        <div className="seg">
          {(['notes', 'blueprint'] as Layer[]).map((l) => (
            <button
              key={l}
              className={(conn.layer ?? 'blueprint') === l ? 'active' : ''}
              onClick={() => updateSelection({ layer: l })}
              title={`Move connector to ${l}`}
            >
              {l}
            </button>
          ))}
        </div>
      </Section>

      {/* APPEARANCE moved to top of the inspector below LAYER 2026-04-28
       *  (Josh's request) — colour/width/opacity are the most-touched
       *  controls during a styling pass, so they get the prime real estate
       *  above ROUTING. */}
      <Section title="APPEARANCE">
        <Field label=".stroke">
          <SwatchRow
            kind="stroke"
            value={conn.stroke}
            // Connectors with no stroke are invisible — disallow the "none" cell.
            allowNone={false}
            onChange={(v) => updateSelection({ stroke: v })}
          />
        </Field>
        <Field label=".width">
          <StrokeWidthField
            value={conn.strokeWidth}
            onChange={(v) => updateSelection({ strokeWidth: v })}
          />
        </Field>
        <Field label=".opacity">
          <OpacityField
            value={conn.opacity}
            onChange={(v) => updateSelection({ opacity: v })}
          />
        </Field>
        <Field label=".style">
          <div className="seg">
            {(['solid', 'dashed', 'dotted'] as const).map((opt) => (
              <button
                key={opt}
                className={(conn.style ?? 'solid') === opt ? 'active' : ''}
                onClick={() => updateSelection({ strokeStyle: opt })}
              >
                {opt}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="ROUTING">
        <Field label=".routing">
          <div className="seg">
            {(
              [
                ['straight', 'direct'],
                ['curved', 'curved'],
                ['orthogonal', 'elbow'],
              ] as const
            ).map(([r, label]) => (
              <button
                key={r}
                className={conn.routing === r ? 'active' : ''}
                onClick={() => updateSelection({ routing: r })}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {conn.waypoints && conn.waypoints.length > 0 && (
          <Field label=".bends">
            <button
              className="font-mono text-[10px] px-2 py-[5px] rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
              onClick={() => update(conn.id, { waypoints: undefined })}
            >
              clear {conn.waypoints.length}{' '}
              {conn.waypoints.length === 1 ? 'bend' : 'bends'}
            </button>
          </Field>
        )}
        {/* .label stays per-connector — different connectors should keep
         *  their own copy. */}
        <Field label=".label">
          <CommitInput
            value={conn.label ?? ''}
            placeholder="(none)"
            onCommit={(v) => update(conn.id, { label: v || undefined })}
          />
        </Field>
        {/* Endpoint markers route through `updateSelection` so picking
         *  arrow/dot/diamond on a multi-connector selection paints the lot.
         *  The store's _shapePatchToConnectorPatch forwards fromMarker/
         *  toMarker/fromMarkerSize/toMarkerSize directly — see store/editor.ts. */}
        <Field label=".from end">
          <MarkerSeg
            value={conn.fromMarker ?? 'none'}
            onChange={(m) => updateSelection({ fromMarker: m })}
          />
        </Field>
        {(conn.fromMarker ?? 'none') !== 'none' && (
          <Field label=".from size">
            <MarkerSizeField
              value={conn.fromMarkerSize}
              defaultDisplay={resolveMarkerSize(
                (conn.fromMarker ?? 'arrow') as Exclude<EndpointMarker, 'none'>,
                conn.strokeWidth ?? 1.25,
                undefined,
              )}
              onChange={(v) => updateSelection({ fromMarkerSize: v })}
            />
          </Field>
        )}
        <Field label=".to end">
          <MarkerSeg
            value={conn.toMarker ?? 'arrow'}
            onChange={(m) => updateSelection({ toMarker: m })}
          />
        </Field>
        {(conn.toMarker ?? 'arrow') !== 'none' && (
          <Field label=".to size">
            <MarkerSizeField
              value={conn.toMarkerSize}
              defaultDisplay={resolveMarkerSize(
                (conn.toMarker ?? 'arrow') as Exclude<EndpointMarker, 'none'>,
                conn.strokeWidth ?? 1.25,
                undefined,
              )}
              onChange={(v) => updateSelection({ toMarkerSize: v })}
            />
          </Field>
        )}
        {((conn.fromMarker ?? 'none') !== 'none' ||
          (conn.toMarker ?? 'arrow') !== 'none') && (
          <Field label=".link">
            <LinkSizesCheckbox conn={conn} onUpdate={(p) => updateSelection(p)} />
          </Field>
        )}
      </Section>

    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-[14px] py-3 border-b border-border last:border-b-0">
      <h4 className="font-mono text-[9px] font-medium text-fg-muted mb-[10px] tracking-[0.04em]">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

/** Endpoint marker picker — five tiny SVG glyphs in a segmented row. The
 *  user can compose any from/to combination (e.g. dot→arrow for a state
 *  transition, circle→circle for a UML association). */
function MarkerSeg({
  value,
  onChange,
}: {
  value: EndpointMarker;
  onChange: (m: EndpointMarker) => void;
}) {
  const opts: { v: EndpointMarker; render: () => React.ReactNode }[] = [
    {
      v: 'none',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={18} y2={5} stroke="currentColor" strokeWidth={1.25} />
        </svg>
      ),
    },
    {
      v: 'arrow',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={14} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <path d="M 14 1 L 19 5 L 14 9 z" fill="currentColor" />
        </svg>
      ),
    },
    {
      v: 'dot',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={15} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <circle cx={16.5} cy={5} r={2.2} fill="currentColor" />
        </svg>
      ),
    },
    {
      v: 'circle',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={14.5} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <circle
            cx={16.5}
            cy={5}
            r={2.2}
            fill="var(--bg-subtle)"
            stroke="currentColor"
            strokeWidth={1.1}
          />
        </svg>
      ),
    },
    {
      v: 'diamond',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={13} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <path d="M 13 5 L 16.5 1.5 L 20 5 L 16.5 8.5 z" fill="currentColor" />
        </svg>
      ),
    },
  ];
  return (
    <div className="seg">
      {opts.map((o) => (
        <button
          key={o.v}
          title={o.v}
          className={value === o.v ? 'active' : ''}
          onClick={() => onChange(o.v)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 16 }}
        >
          {o.render()}
        </button>
      ))}
    </div>
  );
}


/** Tickbox that re-couples arrowhead sizes to `.width`. Conceptually the
 *  inverse of the size sliders: ticked = both `fromMarkerSize` and
 *  `toMarkerSize` cleared (renderer falls back to `strokeWidth × factor`),
 *  unticked = both seeded with their current resolved sizes so the slider
 *  state matches the visible geometry. The ticked state is derived
 *  (`both undefined`) rather than stored, so toggling never lies about what
 *  the renderer is painting. */
function LinkSizesCheckbox({
  conn,
  onUpdate,
}: {
  conn: Connector;
  onUpdate: (patch: Partial<Connector>) => void;
}) {
  const linked =
    conn.fromMarkerSize === undefined && conn.toMarkerSize === undefined;
  const sw = conn.strokeWidth ?? 1.25;
  const fromKind = conn.fromMarker ?? 'none';
  const toKind = conn.toMarker ?? 'arrow';

  const onToggle = (next: boolean) => {
    if (next) {
      // Re-link: clear both. Sliders will hide / fall back to "auto".
      onUpdate({ fromMarkerSize: undefined, toMarkerSize: undefined });
    } else {
      // Unlink: seed each end with the size the renderer is currently
      // painting. Without seeding, the sliders' first drag would jump from
      // wherever the thumb sits in auto-mode to the new value — feels broken.
      const patch: Partial<Connector> = {};
      if (fromKind !== 'none') {
        patch.fromMarkerSize = resolveMarkerSize(
          fromKind as Exclude<EndpointMarker, 'none'>,
          sw,
          undefined,
        );
      }
      if (toKind !== 'none') {
        patch.toMarkerSize = resolveMarkerSize(
          toKind as Exclude<EndpointMarker, 'none'>,
          sw,
          undefined,
        );
      }
      onUpdate(patch);
    }
  };

  return (
    <label
      className="flex items-center gap-[6px] cursor-pointer select-none"
      title="When ticked, arrowhead sizes scale with .width. Untick to size each end independently."
    >
      <input
        type="checkbox"
        checked={linked}
        onChange={(e) => onToggle(e.target.checked)}
        className="cursor-pointer"
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="font-mono text-[10px] text-fg-muted">
        sizes follow .width
      </span>
    </label>
  );
}

/** Field input that commits on blur or Enter. Avoids history-spam from every
 *  keystroke, which a controlled `value` + onChange-write would do. */
function CommitInput({
  value,
  placeholder,
  onCommit,
  className = 'field-input',
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Re-sync drafts when value changes externally (undo, etc.) — but only when
  // the user isn't actively editing this input. Without the focus check, a
  // mid-keystroke external mutation would clobber the user's typing.
  useEffect(() => {
    if (document.activeElement?.tagName === 'INPUT') return;
    setDraft(value);
  }, [value]);
  return (
    <input
      className={className}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}


