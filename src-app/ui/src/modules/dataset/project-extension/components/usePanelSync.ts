// The datasets panel's realtime invalidation — the same device `useCatalogInvalidation`
// is for the workbench catalog, for the reads the panel holds in local `useState`.
//
// ── Why an epoch and not another dependency ──────────────────────────────────────────
//
// The panel's three server reads (`Project.datasetSummary`, `Dataset.listShared`,
// `Dataset.artifactSummaries`) were keyed on `datasetsTotal` — a COUNT off
// `ProjectDetail`. A count moves when the linked SET changes and at no other time, so it
// stands in for attach/detach and for nothing else. A dataset renamed or shared
// elsewhere, or a run producing artifacts for a linked dataset, leaves it identical and
// the panel showing stale rows — with no error to point at it.
//
// So the trigger is DERIVED from the channel the server already publishes on, rather than
// from a value that happens to correlate with one cause. Notify-and-refetch is preserved:
// the frame carries `{action, id}` and nothing else, and the only response is to re-read
// through the panel's own permission-checked endpoints.
//
// ── Which entities mean "what this panel draws may have changed" ─────────────────────
//
//   `sync:dataset`  — rename / share / unshare / delete all publish `Dataset` (see
//                     `dataset/routes.rs`). They change the picker's candidate list and
//                     the linked rows' names, and none of them move `datasetsTotal`.
//   `sync:artifact` — run-output ingest and artifact delete publish `Artifact` to the
//                     project (or dataset) audience; that is what the holdings line
//                     summarises.
//   `sync:reconnect`— frames missed while the stream was down.
//
// SELF-GATING: `sync:reconnect` reaches every subscriber regardless of server audience,
// so the re-read is gated on the read-perm of the endpoints it re-reads through
// (`projects::use`) — without it a user who lost access answers each reconnect with 403s.
//
// COALESCING: one run ingesting N artifacts publishes N `Artifact`/`Create` frames, and
// each epoch bump costs this panel three requests. The first frame schedules ONE bump and
// every frame inside the window is absorbed into it.

import { useEffect, useState } from 'react'
import { EventBus } from '@txresbench/framework/stores'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'

/** The throttle window a burst of sync frames is collapsed into. */
export const PANEL_INVALIDATION_COALESCE_MS = 120

/**
 * A monotonic counter that advances whenever the realtime channel reports a change this
 * panel's server reads depend on. Put it in an effect's dependency list.
 */
export function useDatasetPanelEpoch(): number {
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      // Trailing flush: the window is already open ⇒ absorb this frame into the pending
      // bump rather than opening a new one.
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        setEpoch(e => e + 1)
      }, PANEL_INVALIDATION_COALESCE_MS)
    }

    const offs = [
      EventBus.on('sync:dataset', schedule),
      EventBus.on('sync:artifact', schedule),
      EventBus.on('sync:reconnect', schedule),
    ]

    return () => {
      for (const off of offs) off()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  return epoch
}
