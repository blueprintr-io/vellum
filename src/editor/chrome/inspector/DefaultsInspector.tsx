import { useEditor } from '@/store/editor';
import { FontPicker } from './FontPicker';
import {
  CornerRadiusField,
  OpacityField,
  StrokeWidthField,
  SwatchRow,
} from './StyleControls';

/** "Defaults" inspector — what the right panel shows when the user has the
 *  inspector pinned open with nothing selected. Edits `lastStyles` /
 *  `lastConnectorStyle` directly; the creation paths in `defaultShapeFromTool`
 *  and the connector tooling already inherit from those slots, so the next
 *  shape/connector the user draws picks up whatever they configured here.
 *
 *  This is what unblocks the "configure colours, then draw" workflow that
 *  draw.io users expect — without us inventing a separate "draft shape"
 *  concept. The same plumbing that gives style-stickiness across edits
 *  doubles as the defaults engine. */
export function DefaultsInspector() {
  const lastStyles = useEditor((s) => s.lastStyles);
  const setLastStyles = useEditor((s) => s.setLastStyles);
  const lastConnectorStyle = useEditor((s) => s.lastConnectorStyle);
  const setLastConnectorStyle = useEditor((s) => s.setLastConnectorStyle);
  const close = useEditor((s) => s.setInspectorOpen);

  return (
    <div className="float absolute z-[25] sm:z-[14] overflow-y-auto inset-x-0 bottom-0 top-auto h-[60vh] max-h-none rounded-b-none sm:left-auto sm:right-[14px] sm:top-[70px] sm:bottom-auto sm:w-[280px] sm:h-auto sm:max-h-[calc(100vh-100px)] sm:rounded-b-[10px]">
      <div className="px-[14px] py-3 border-b border-border flex items-center justify-between">
        <div className="text-[12px] font-semibold flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--fg-muted)' }}
          />
          Defaults
        </div>
        <button
          onClick={() => close(false)}
          title="Close defaults panel"
          className="bg-transparent border-none text-fg-muted hover:text-fg p-[2px] rounded"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="px-[14px] pt-2 pb-3 text-[10px] leading-relaxed text-fg-muted">
        Picks here apply to the next shape or connector you draw.
      </div>

      <Section title="SHAPE">
        <Field label=".stroke">
          <SwatchRow
            kind="stroke"
            value={lastStyles.stroke}
            onChange={(v) => setLastStyles({ stroke: v })}
          />
        </Field>
        <Field label=".fill">
          <SwatchRow
            kind="fill"
            value={lastStyles.fill}
            onChange={(v) => setLastStyles({ fill: v })}
          />
        </Field>
        <Field label=".text">
          <SwatchRow
            kind="stroke"
            value={lastStyles.textColor}
            onChange={(v) => setLastStyles({ textColor: v })}
          />
        </Field>
        <Field label=".line">
          <StrokeWidthField
            value={lastStyles.strokeWidth}
            onChange={(v) => setLastStyles({ strokeWidth: v })}
          />
        </Field>
        {/* Corner radius default — applies to the next rect / service tile.
         *  Other kinds ignore it at render time so we don't bother stamping
         *  the field on them in `defaultShapeFromTool`. The 4px default
         *  mirrors the rect kind default; the renderer's `min(w,h)/2`
         *  clamp keeps tall sliders from producing malformed shapes. */}
        <Field label=".roundness">
          <CornerRadiusField
            value={lastStyles.cornerRadius}
            defaultDisplay={4}
            onChange={(v) => setLastStyles({ cornerRadius: v })}
          />
        </Field>
        <Field label=".font">
          <FontPicker
            value={lastStyles.fontFamily}
            onChange={(v) => setLastStyles({ fontFamily: v })}
          />
        </Field>
      </Section>

      <Section title="CONNECTOR">
        <Field label=".stroke">
          <SwatchRow
            kind="stroke"
            value={lastConnectorStyle.stroke}
            onChange={(v) => setLastConnectorStyle({ stroke: v })}
          />
        </Field>
        <Field label=".line">
          <StrokeWidthField
            value={lastConnectorStyle.strokeWidth}
            onChange={(v) => setLastConnectorStyle({ strokeWidth: v })}
          />
        </Field>
        <Field label=".dash">
          <div className="seg">
            {(['solid', 'dashed', 'dotted'] as const).map((s) => (
              <button
                key={s}
                className={(lastConnectorStyle.style ?? 'solid') === s ? 'active' : ''}
                onClick={() =>
                  setLastConnectorStyle({
                    style: s === 'solid' ? undefined : s,
                  })
                }
              >
                {s}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="OPACITY">
        {/* Lives in lastStyles too — applies to next shape only. Connectors
         *  pick up their own opacity from the user's last choice on a
         *  connector via lastConnectorStyle, which doesn't currently track
         *  opacity by design. Surface it here for shapes only to keep the
         *  scope honest. */}
        <OpacityField
          value={undefined}
          onChange={() => {
            /* no-op: opacity isn't part of LastStyles by design — too many
               surprise "why is the default a faded shape" scenarios. The
               control is here for shape consistency; opacity gets set per-
               shape in the regular ShapeInspector once something exists. */
          }}
        />
        <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
          Per-shape only — set opacity after drawing.
        </p>
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
