// The read-only `window.__workbench` e2e seam (mirrors P5's `window.__workbenchRegistry`
// + `core/datatypes`' `window.__datatypeRegistry`). The app is served as a preview
// build with no `/src` imports and there is NO vitest runner, so a browser spec
// exercises the REAL pure shell logic (the placement engine + availability) through
// this seam — the app's established pattern for unit-testing pure logic. Read-only;
// installed as an import side-effect from the shell.

import { workbenchRegistry, type WhenContext } from '@/modules/workbench/core'
import { workbenchLattice } from '../host/createHost'
import { placeViews, isViewAvailable } from './placement'
import type { ViewArea } from '@/modules/workbench/core'

/**
 * The datatype ids the MOUNTED workbench's PROJECT has produced — i.e. the availability
 * input, published by `WorkbenchProvider` (which is the only thing that knows it: it is
 * derived from that project's artifact catalog).
 *
 * `null` means NO workbench is mounted, which is a different answer from "a workbench is
 * mounted over an empty project" (`[]`) and the two must not be collapsed: a consumer
 * defaulting off this needs to be able to tell "I cannot answer" from "the answer is
 * nothing".
 */
let mountedProducedTypeIds: string[] | null = null

/** Publish (or, with `null`, retract) the mounted workbench's produced datatype ids.
 *  Called by `WorkbenchProvider` only. */
export function publishProducedTypeIds(ids: string[] | null): void {
  mountedProducedTypeIds = ids
}

/** The mounted workbench's produced datatype ids, or `null` when none is mounted. */
export function currentProducedTypeIds(): string[] | null {
  return mountedProducedTypeIds
}

function install(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __workbench?: unknown }).__workbench = {
    /** the ordered, available view ids placed into a dock area for a given context. */
    placeViews: (area: ViewArea, ctx: WhenContext) =>
      placeViews(workbenchRegistry, area, ctx, workbenchLattice).map(v => v.id),
    /** whether a single view id is available for a context (drops when its `when` fails). */
    viewAvailable: (id: string, ctx: WhenContext) => {
      const v = workbenchRegistry.views.get(id)
      return v ? isViewAvailable(v, ctx, workbenchLattice) : false
    },
    /** the mounted workbench's produced datatype ids (`null` — no workbench mounted).
     *  This is what `window.__workbenchRegistry`'s availability answers default against,
     *  so a spec can see the SAME input the launcher gates on. */
    producedTypeIds: () => currentProducedTypeIds(),
  }
}

install()
