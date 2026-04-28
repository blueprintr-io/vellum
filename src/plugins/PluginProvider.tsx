// React context that carries the consumer-supplied plugins array down to the
// slot consumers (Brand, Actions, ContextMenu). Plugins are NOT stored in the
// Zustand store: they contain non-serializable React nodes/functions and the
// store is persisted to localStorage. Context is the right home.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { VellumPlugin } from './types';

const PluginContext = createContext<readonly VellumPlugin[]>([]);

export interface PluginProviderProps {
  plugins?: readonly VellumPlugin[];
  children: ReactNode;
}

export function PluginProvider({ plugins, children }: PluginProviderProps) {
  // Stabilize the array reference when the consumer passes a fresh literal
  // each render — avoids spurious re-renders for slot consumers that depend
  // on the plugin list. We key on the ids since plugins are conceptually
  // identified by id.
  const stable = useMemo(
    () => plugins ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins?.map((p) => p.id).join('|')],
  );

  // Dev-only: warn on duplicate ids. Duplicates would silently render twice
  // and confuse plugin-author debugging.
  if (import.meta.env?.DEV) {
    const seen = new Set<string>();
    for (const p of stable) {
      if (seen.has(p.id)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[vellum-editor] duplicate plugin id "${p.id}" — second instance will still render but ids should be unique`,
        );
      }
      seen.add(p.id);
    }
  }

  return (
    <PluginContext.Provider value={stable}>{children}</PluginContext.Provider>
  );
}

/** Returns the registered plugins. Stable reference unless the plugin id-set
 *  changes. Slot consumers call this and then filter / map as needed. */
export function usePlugins(): readonly VellumPlugin[] {
  return useContext(PluginContext);
}
