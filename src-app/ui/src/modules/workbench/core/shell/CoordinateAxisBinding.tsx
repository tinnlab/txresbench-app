// THE DERIVATION, mounted once per section pane — it renders NOTHING.
//
// `$scope.axis` is what every contributed section resolves its candidates against, and it is
// no longer asked for: the pane's first block is § Coordinates, and the rows the pane is about
// are the ones the chosen coordinate set DECLARES (`runtime/coordinateAxis.ts`).
//
// It is a component because the join needs the project's artifact rows, which is a fetch, and
// because it must re-run when either half moves — a new coordinate, or a new catalog (a run
// finishing can add the very key artifact the join was missing). It lives in the STACK, not in
// `DeclarativeRegion`, so the write happens ONCE rather than once per contributed section: the
// store's write is idempotent, but three components racing to compute one derived value is
// three places for it to come out differently.
//
// It renders nothing on purpose. The thing the deleted anchor control got wrong was being a
// control at all; replacing it with a smaller control that says which rows were derived would
// be the same mistake at lower volume. The consequence of the derivation is VISIBLE where it
// belongs — in what the sections below then list.

import * as React from 'react'
import { useStore } from 'zustand'

import { useArtifactCatalog } from '@/modules/workbench/core/render/useArtifactCatalog'
import { axesOfCoordinate } from '@/modules/workbench/core/runtime/coordinateAxis'
import { paneScopeStore } from '@/modules/workbench/core/runtime/paneScope.store'
import { useWorkbench } from './WorkbenchContext'

export function CoordinateAxisBinding(): null {
  const { api, projectId, catalogEpoch } = useWorkbench()
  const artifacts = useArtifactCatalog(api, catalogEpoch)
  const coordinate = useStore(paneScopeStore, s => s.scope.coordinate)

  // A `content_hash` from another project names nothing here, so the scope is bound to the
  // project and CLEARED on a change rather than carried. Before the derivation, so a stale
  // coordinate cannot be joined against the new project's catalog for one render.
  React.useEffect(() => {
    if (projectId) paneScopeStore.getState().bindProject(projectId)
  }, [projectId])

  React.useEffect(() => {
    if (!projectId) return
    // The IDENTITIES only (ITEM-8). `axesOfCoordinate` answers `(axis identity, membership)`
    // pairs; pane scope carries identities, because a membership is a DECLARATION every
    // consumer re-reads from the catalog for itself and copying it into shared state would
    // make the store a second, staleable source for it. The ORDER is carried verbatim — it is
    // the order the coordinate declared its memberships in, which is the anchor's segment
    // order (INV-7) and not this component's to normalise.
    paneScopeStore
      .getState()
      .setDerivedAxis(projectId, axesOfCoordinate(artifacts, coordinate).map(a => a.contentHash))
  }, [projectId, artifacts, coordinate])

  return null
}
