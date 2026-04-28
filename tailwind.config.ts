import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

// Tokens are CSS variables (declared as `R G B` triplets in tokens.css).
// `<alpha-value>` lets `bg-accent/20` etc. emit the right rgba().
const tokenColor = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Effectively disable the built-in dark: variant — Blueprintr drives theming
  // via html.theme-light, and the codebase uses the custom `light:` variant
  // (registered below). `dark:` here would only fire if `.dark` were on <html>,
  // and we never add it, so dark: is dormant by construction.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: tokenColor('bg'),
        'bg-subtle': tokenColor('bg-subtle'),
        'bg-overlay': tokenColor('bg-overlay'),
        'bg-emphasis': tokenColor('bg-emphasis'),
        border: tokenColor('border'),
        fg: tokenColor('fg'),
        'fg-muted': tokenColor('fg-muted'),
        accent: tokenColor('accent'),
        'accent-emphasis': tokenColor('accent-emphasis'),
        'accent-deep': tokenColor('accent-deep'),
        // Canvas tokens — constant across themes; use #hex form, no theme alpha needed.
        paper: 'var(--paper)',
        'paper-grid': 'var(--paper-grid)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        sketch: 'var(--sketch)',
        refined: 'var(--refined)',
        // Notes-layer ink — yellow highlighter feel. Used by the LayerPills
        // Notes dot and any chrome that wants to brand a Notes affordance.
        'notes-ink': 'var(--notes-ink)',
      },
      fontFamily: {
        body: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        sketch: ['Caveat', 'cursive'],
      },
      borderRadius: {
        float: '10px',
      },
      boxShadow: {
        // Floating panels — the only drop shadow allowed (dark default).
        float:
          '0 4px 14px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(0 0 0 / 0.04)',
        'float-light':
          '0 2px 8px rgb(36 41 47 / 0.06), 0 0 0 1px rgb(36 41 47 / 0.04)',
        // Standard chrome — the shadow-blueprint token from Blueprintr.
        blueprint: '0 0 0 1px var(--border)',
      },
      backdropBlur: {
        chrome: '10px',
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      // Custom `light:` variant — Blueprintr-style. Default styles target dark.
      addVariant('light', 'html.theme-light &');
    }),
  ],
};

export default config;
