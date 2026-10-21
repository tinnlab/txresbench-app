// The project artifact ROWS a declarative pane needs in order to render its own input
// pickers (ITEM-7/8).
//
// An `artifact_ref` widget declares its own `source` (INV-2), and resolving one — whether
// project-wide by datatype or axis-scoped off another control's value — is a filter over
// the project catalog. `DeclarativeRegion` fetches the rows once per catalog epoch and
// hands them down through the render scope, so the pure resolver
// (`core/runtime/axisSource.ts`) runs inside each widget's OWN scope. That matters for a
// `for_each`-repeated ref: its `of` may bind the loop variable, and a resolution hoisted
// to the pane would silently answer with the wrong iteration's anchor.
//
// Best-effort by design: a failed catalog read yields NO rows, and the widget then renders
// its explicit empty state rather than throwing the pane down. The slice resolver
// (`viewData.ts`) is the surface that reports a catalog failure as an error — one
// announcement per fetch, not one per control.

import { useEffect, useMemo, useState } from 'react'
import { resolveOrThrow, type WorkbenchAPI } from '@/modules/workbench/core'
import type { ArtifactCatalogSource, ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import type { ArtifactValuePreviewSource } from '@/modules/workbench/core/artifacts/valuePreview'

/** The broker id the catalog is published under. A plain string literal, because routing
 *  is BY ID (INV-6) — core resolves the port below out of whatever answers to it. */
const CATALOG_CAPABILITY_ID = 'data'
/** The published range every in-tree consumer asks for. */
const CATALOG_CAPABILITY_RANGE = '^1'

/** The project's artifact rows, refetched whenever the catalog epoch advances. */
export function useArtifactCatalog(api: WorkbenchAPI, catalogEpoch: number): ArtifactRow[] {
  const [rows, setRows] = useState<ArtifactRow[]>([])
  useEffect(() => {
    let cancelled = false
    let data: ArtifactCatalogSource
    try {
      data = resolveOrThrow<ArtifactCatalogSource>(
        api.capabilities,
        CATALOG_CAPABILITY_ID,
        CATALOG_CAPABILITY_RANGE,
      )
    } catch {
      // A host with no `data` capability (a bare unit mount) simply has no catalog.
      setRows([])
      return
    }
    // The LIST read, not the project overview — see `ArtifactCatalogSource.artifacts` for
    // why the distinction is load-bearing: an axis-scoped `source` is scoped by the
    // anchor's SOURCE DATASET, and only this read carries it. Asked unfiltered, because
    // each widget narrows by its own declared `source` (INV-2); a filter here would be the
    // pane deciding what its controls may offer.
    void data.artifacts
      .query({})
      .then(rows => {
        if (!cancelled) setRows(rows)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [api, catalogEpoch])
  return rows
}

/**
 * The value-PREVIEW port, resolved out of the same capability the catalog comes from —
 * `undefined` when the host publishes no data plane, or publishes one that predates this
 * read.
 *
 * NOT fetched here, and that is the whole shape of DEC-1: this resolves a PORT, once per
 * api instance. A picker renders N candidates, and reading a value for each of them would
 * turn one control into N data-plane reads on every mount, for a question the user has not
 * asked yet. The read happens where the ANSWER is — in the control, after a selection.
 *
 * The `typeof … === 'function'` guard is not defensive noise. A host may inject its own
 * plane through `WorkbenchHost.planes` (the gallery and several test harnesses do), and
 * one written before this method existed satisfies the broker's id lookup and would then
 * `TypeError` at the instant a user made a selection — an absent AID becoming a broken
 * FORM, which is the one degradation DEC-4 forbids.
 */
export function useValuePreviewSource(api: WorkbenchAPI): ArtifactValuePreviewSource | undefined {
  return useMemo(() => {
    let source: ArtifactValuePreviewSource
    try {
      source = resolveOrThrow<ArtifactValuePreviewSource>(
        api.capabilities,
        CATALOG_CAPABILITY_ID,
        CATALOG_CAPABILITY_RANGE,
      )
    } catch {
      return undefined
    }
    return typeof source.previewValues === 'function' ? source : undefined
  }, [api])
}
