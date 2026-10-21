// ControlsContext.tsx — plot-editing: the RESOLVED per-control edit capabilities (legend / colormap /
// titles / pointSize) made available to the in-cell overlays deep inside `GridWorkspace` WITHOUT
// prop-drilling. `<Viz>` provides it from `resolveControls(option.controls)`; a bare `<GridWorkspace>`
// (stories/tests, no provider) reads the DEFAULTS (`CONTROL_DEFAULTS`) so the pre-feature render is
// byte-identical. Static authoring config (never mutated at runtime), so a context — not a store — is
// the right seam (mirrors how `VizEventBusContext` threads the bus through the grid).

import { createContext, useContext } from 'react'
import { CONTROL_DEFAULTS, type ResolvedControls } from '../option/types'

/** The resolved edit capabilities in context. Default = every control at its `CONTROL_DEFAULTS`. */
export const VizControlsContext = createContext<ResolvedControls>(CONTROL_DEFAULTS)

/** Read the resolved per-control edit capabilities (defaults when no `<Viz>` provider is present). */
export function useVizControls(): ResolvedControls {
  return useContext(VizControlsContext)
}
