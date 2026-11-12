// The ONE place the workbench learns that the project's ARTIFACT SET changed.
//
// ── Why this is a subscription and not another `refreshCatalog()` call site ──────────
//
// `catalogEpoch` used to advance only through hand-maintained `refreshCatalog()` calls —
// three of them. That is an enumeration, and an enumeration silently drops the N+1th
// entry: attach/detach a dataset and the project's artifact set changes (the workbench
// catalog SQL unions `project_id = $1` with the artifacts of the project's ATTACHED
// datasets), but no call site fired, so every `artifact_ref` picker kept offering the old
// rows with no error to show for it. Adding attach/detach as a fourth caller reproduces
// the same defect one mutation later.
//
// So the epoch is DERIVED from the realtime channel the server already publishes on
// (notify-and-refetch: the frame carries `{entity, action, id}` and nothing else; this
// hook's only response is to make the workbench re-read the catalog through its own
// permission-checked endpoint). No mutation site opts in, and a change made on ANOTHER
// DEVICE lands exactly like a local one.
//
// ── Which entities mean "this project's artifact set may have changed" ───────────────
//
//   `sync:project`   — `attach_dataset`/`detach_dataset` publish `Project`/`Update` to the
//                      project audience (owner ∪ accepted shares). The frame's `id` IS the
//                      project id, so it is filtered to THIS project. Also fires for
//                      rename/share edits; a redundant catalog re-read is the cost of not
//                      inventing a narrower entity, and it is bounded by the coalesce below.
//   `sync:artifact`  — run-output ingest, conformance verdicts and artifact delete publish
//                      `Artifact` to the project (or dataset) audience. The frame carries an
//                      ARTIFACT id, so it cannot be filtered by project; a user watching two
//                      projects re-reads one extra catalog. Refetching is always safe.
//   `sync:dataset`   — deleting or splitting a dataset removes its artifacts from EVERY
//                      project it was attached to by FK cascade (`artifacts_dataset_id_fkey
//                      ON DELETE CASCADE`), and that path publishes only `Dataset`/`Delete`.
//                      Without this key those rows would linger in the picker until reload.
//   `sync:reconnect` — the SyncClient broadcasts it on every (re)connect, so frames missed
//                      while the stream was down are recovered.
//
// ── The two invariants this hook must not break ──────────────────────────────────────
//
// SELF-GATING: `sync:reconnect` reaches every subscriber regardless of server audience, so
// the refetch is gated on the read-perm of the endpoint it refetches through — the catalog
// handler's `RequirePermissions<(ProjectsUse,)>` ⇒ `projects::use`. Without it a user who
// lost access answers each reconnect with a 403.
//
// COALESCING: one run ingesting N artifacts publishes N `Artifact`/`Create` frames
// (`workstore/ingest.rs` emits inside the insert loop), and each epoch bump costs every
// mounted consumer a catalog read. Frames are throttled with a trailing flush: the first
// frame schedules ONE bump and every frame inside the window is absorbed into it. That
// bounds the work per burst while keeping the refetch CAUSED — there is no timer when
// nothing is happening.

import { useEffect, useRef } from 'react'
import { EventBus } from '@txresbench/framework/stores'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'

/** The throttle window a burst of sync frames is collapsed into. Short enough to read as
 *  immediate, long enough to swallow a multi-artifact ingest. */
export const CATALOG_INVALIDATION_COALESCE_MS = 120

/**
 * Advance the workbench's catalog epoch whenever the realtime channel reports a change
 * that can alter THIS project's artifact set. Mounted once by `WorkbenchProvider`.
 *
 * `bump` is read through a ref so a re-created callback does not tear the subscriptions
 * down and rebuild them (which would drop a frame arriving mid-swap).
 */
export function useCatalogInvalidation(projectId: string, bump: () => void): void {
  const bumpRef = useRef(bump)
  bumpRef.current = bump

  useEffect(() => {
    if (!projectId) return
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      // Self-gate on the read-perm of the endpoint the bump makes us refetch through.
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      // Throttle with a TRAILING flush: the window is already open ⇒ this frame is
      // absorbed into the pending bump rather than opening a new one.
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        bumpRef.current()
      }, CATALOG_INVALIDATION_COALESCE_MS)
    }

    const offs = [
      // Filtered to THIS project — the frame's id IS the project id here.
      EventBus.on('sync:project', ev => {
        if (ev.data.id === projectId) schedule()
      }),
      EventBus.on('sync:artifact', schedule),
      EventBus.on('sync:dataset', schedule),
      EventBus.on('sync:reconnect', schedule),
    ]

    return () => {
      for (const off of offs) off()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [projectId])
}
