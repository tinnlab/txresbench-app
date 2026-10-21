// useSharedColorDomain.ts — the React binding for shared color-domain
// coordination (DEC-25 / ITEM-64).
//
// A panel calls `useSharedColorDomain(key, ownDomain, colormap)`: the hook
// registers the panel's own domain into the Coordination store under a stable
// per-instance id, then returns the SHARED (union) domain across every panel
// currently coloring by the same `key`. Linked panels therefore render
// identical values with identical colors instead of each auto-scaling to its
// own min/max.

import { useEffect, useId, useMemo } from 'react'
import { useStore } from 'zustand'

import { useVizStores } from '../../adapter/vizStores'
import { resolveSharedDomain } from './colorScale'

/**
 * Register this panel's color-by domain and read back the shared merged domain.
 *
 * @param key       the value column the panel colors by (the coordination axis)
 * @param ownDomain the panel's own auto-detected `[min, max]`
 * @param colormap  the colormap the panel renders with (default `'viridis'`)
 * @returns the union domain across all panels coloring by `key` (falls back to
 *          `ownDomain` before this panel's registration lands / if it's alone)
 */
export function useSharedColorDomain(
  key: string,
  ownDomain: [number, number],
  colormap = 'viridis',
): [number, number] {
  const id = useId()
  const [lo, hi] = ownDomain
  // Resolve the active coordination store from context (the module singleton when unprovided),
  // so a per-instance `<Viz>` registers this panel's domain into ITS OWN store (VIZ_ISOLATION W2).
  const coordination = useVizStores().coordination

  useEffect(() => {
    coordination.getState().setColorScale(id, { key, domain: [lo, hi], colormap })
    return () => coordination.getState().clearColorScale(id)
  }, [coordination, id, key, lo, hi, colormap])

  const colorScales = useStore(coordination, s => s.colorScales)

  return useMemo(
    () => resolveSharedDomain(Object.values(colorScales), key) ?? [lo, hi],
    [colorScales, key, lo, hi],
  )
}
