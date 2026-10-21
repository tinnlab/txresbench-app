// renderStrategies (ITEM-60) — the pure classifier that maps a `ViewContribution.render`
// union member to its render-kind id, so `ViewHost` dispatches through ONE typed key
// rather than re-deriving the union shape inline. Pure + framework-free (node-safe) so the
// classification is unit-testable (TEST-527).
//
// The render KINDS are a FIXED, closed set (`component` / `named` / `iframe` / `spec`): a
// new low-level render mechanism is a `ViewHost` change, not a registration. What IS open
// is the set of NAMED views — an extension ships `render: { component: '<id>' }` and
// registers the React component via `ViewHost.registerViewComponent`, so new panels plug in
// without editing the shell. (An earlier draft wrapped these kinds in a strategy REGISTRY,
// but nothing read it in production — `selectRenderStrategy` is the only live consumer — so
// the write-only registry was removed in favor of this honest classifier.)

import type { ComponentType } from 'react'
import type { ViewSpec } from '@/modules/workbench/core'

/** The render union `ViewHost` dispatches (mirrors `ViewContribution.render`). */
export type ViewRender = ViewSpec | { component: ComponentType<Record<string, never>> }

/** The render-kind ids `ViewHost` renders. A view whose `render` matches none resolves to
 *  `spec` (the visible declarative-fallback note). */
export type RenderStrategyId = 'component' | 'named' | 'iframe' | 'spec'

/** Classify a `render` union member → its render-kind id (the pure dispatch key). */
export function selectRenderStrategy(render: ViewRender): RenderStrategyId {
  if ('component' in render && typeof render.component === 'function') return 'component'
  if ('component' in render && typeof render.component === 'string') return 'named'
  if ('iframe' in render) return 'iframe'
  return 'spec'
}
