import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import type { TipKey } from '@/store/editor';
import { I } from './icons';

/** Body copy for every TipKey, with a `{{ctrl}}` placeholder where the
 *  modifier key should appear. Substitution happens at render time —
 *  ⌘ on Mac, Ctrl elsewhere — so the same string ships to both platforms.
 *
 *  KEEP TIPS SHORT. The toast is a contextual nudge that lives at the
 *  bottom of the canvas while a gesture is in flight; the user can't read
 *  a paragraph mid-drag. One sentence, action-first.
 *
 *  When you add a tip:
 *    1. Add the matching TipKey to `editor.ts` (TipKey union).
 *    2. Add the body line here.
 *    3. Publish the key from wherever the gesture lives — usually
 *       `setActiveTipKey(...)` in Canvas.tsx's `setInteraction`.
 *    4. The toast appears + fades out automatically when the key clears. */
const TIP_BODIES: Record<TipKey, string> = {
  'shift-perfect-square': 'Hold ⇧shift to create a perfect square',
  'shift-perfect-circle': 'Hold ⇧shift to create a perfect circle',
  'shift-perfect-diamond': 'Hold ⇧shift to create a perfect diamond',
  'shift-disable-snap': 'Hold ⇧shift to disable snapping',
  'cmd-disable-snap': 'Hold {{ctrl}} to disable snapping',
  'ctrl-align': 'Hold {{ctrl}} to align to another shape',
  'ctrl-snap-rotate': 'Hold ⇧shift to snap rotate',
  'right-click-delete-bend': 'Right click on a bend to delete it',
  'dblclick-group-select': 'Double click to select individual objects in a group',
};

/** Lazy mac detection — runs once at module-eval, fine because the user
 *  doesn't switch OS mid-session. We check `userAgentData.platform` first
 *  (modern, non-deprecated) and fall back to `navigator.platform` so older
 *  browsers still get the right glyph. */
const IS_MAC = (() => {
  if (typeof navigator === 'undefined') return false;
  const uad = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData;
  if (uad?.platform) return /mac/i.test(uad.platform);
  return /Mac|iPhone|iPad/.test(navigator.platform);
})();

/** Render `body` with `{{ctrl}}` substituted for the platform's modifier
 *  glyph. The Mac glyph is a real character (⌘) and Ctrl is plain text —
 *  both render fine inline; no need for separate <kbd> styling at this
 *  level of subtlety. */
function formatTip(body: string): string {
  return body.replace(/\{\{ctrl\}\}/g, IS_MAC ? '⌘' : 'Ctrl');
}

/** Fade duration (ms). Matches the mount/unmount timer below — bump both
 *  if you want a slower transition. ~180ms reads as a soft fade without
 *  feeling laggy; under ~120 the pop-in is too sudden. */
const FADE_MS = 180;

/** Contextual nudge that floats above the bottom edge of the canvas while
 *  a gesture is in flight. Reads `activeTipKey` from the store; renders
 *  nothing when the key is null OR when the user has switched tips off in
 *  Customise canvas / hamburger menu.
 *
 *  Fade in/out: when the store's `activeTipKey` flips, the local
 *  `displayed` body state lags behind so the component stays mounted long
 *  enough to fade out. On the way IN, we mount with opacity 0 and switch
 *  to 0.35 on the next frame to trigger the CSS transition. On the way
 *  OUT, we set opacity to 0 immediately and unmount after FADE_MS.
 *
 *  Visual: pill, lightbulb glyph on the left, tip text + a smaller "disable
 *  tips in settings" caption underneath. The whole pill is wrapped at 35%
 *  opacity — deliberately quiet so it never competes with the canvas
 *  itself. The pill's width follows the content (no fixed min-width), so a
 *  short tip stays small. */
export function TipToast() {
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const activeTipKey = useEditor((s) => s.activeTipKey);

  // `displayed` is the body we're CURRENTLY rendering; lags behind the
  // store on the way out so we can play a fade. `visible` drives the
  // CSS transition's target opacity — flips false on hide, then displayed
  // clears after FADE_MS so the component unmounts.
  const [displayed, setDisplayed] = useState<TipKey | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const wantTip = tipsEnabled && activeTipKey != null;
    if (wantTip) {
      // Refresh the body even if the key changed mid-show (one tip → another).
      setDisplayed(activeTipKey);
      // Two-frame delay so the browser commits the initial opacity:0
      // BEFORE we transition to 0.35 — without this the element mounts
      // already at 0.35 and the fade-in is skipped. One rAF works in
      // most browsers but Safari occasionally batches state in a way
      // that drops the transition; double-rAF is the well-known fix.
      const r1 = requestAnimationFrame(() => {
        const r2 = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(r2);
      });
      return () => cancelAnimationFrame(r1);
    } else {
      // Hide path: drop opacity → wait for fade to finish → unmount.
      setVisible(false);
      const t = setTimeout(() => setDisplayed(null), FADE_MS);
      return () => clearTimeout(t);
    }
  }, [activeTipKey, tipsEnabled]);

  if (displayed == null) return null;
  const body = TIP_BODIES[displayed];
  if (!body) return null;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 bottom-[14px] z-[14] pointer-events-none"
      // 70% opacity covers the WHOLE pill (icon, text, caption). Putting
      // it on the wrapper rather than per-element keeps the visual weight
      // uniform and lets us re-tune in one place without touching child
      // elements. (35 → 50 → 70 over 2026-04-28; lower values read as
      // disabled/ghosted on most paper colours.)
      style={{
        opacity: visible ? 0.7 : 0,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg/[0.95] backdrop-blur-chrome shadow-[0_2px_8px_rgb(0_0_0_/_0.18)] px-3 py-[6px] text-fg whitespace-nowrap"
      >
        <span className="text-fg-muted shrink-0">
          <I.lightbulb />
        </span>
        <span className="flex flex-col leading-[1.15]">
          <span className="text-[12px] font-medium">{formatTip(body)}</span>
          <span className="text-[9px] font-mono text-fg-muted tracking-[0.02em]">
            disable tips in settings
          </span>
        </span>
      </div>
    </div>
  );
}
