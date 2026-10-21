// entityLifecycle (ITEM-19) — self-close entity-bound panes when their entity is deleted /
// access-revoked, from BOTH the LOCAL mutation path AND the sync/SSE path. A pane's entity is
// DERIVED from its `ref` by the resolver its kind registered (`paneModel.resolvePaneEntity`); a
// bound pane whose artifact is gone self-closes (remove + reflow), leaving unrelated panes
// untouched. The two paths are SEPARATE handlers because the server suppresses a mutation's
// `sync:` echo to the ORIGINATING connection:
//   • cross-device / other-tab delete → a `sync:artifact` SSE frame → this hook re-reconciles.
//   • the ACTING tab's own delete → NO frame arrives from the server, so the delete affordance
//     ECHOES the withheld `sync:artifact` frame locally (`core/sync/localEcho.ts`) and this same
//     handler runs. A `cells`-dependency re-check alone would NOT fire (a delete does not change
//     the pane set), so the local path must be wired explicitly — it is not inferable from `cells`.
//     It used to be wired by the affordance CALLING `reconcileEntityPanes` itself, which quietly
//     made the mutation site responsible for enumerating every `sync:artifact` subscriber.
//
// ── WHY THE BINDINGS COME FROM THE STORE AND NOT FROM THE PANES' COMPONENTS ─────────────────
//
// They used to be REGISTERED by each pane's component in a mount effect, and dropped again on
// unmount. A region renders only its ACTIVE tab, so every bound pane the user was not currently
// looking at had no binding — and the delete affordance's own flow puts the bound pane in exactly
// that state (the review must be active for its Delete to be clickable). The reconcile then found
// zero bindings and closed nothing. Reading the store answers for EVERY pane, on screen or not.

import { useEffect } from 'react'
import { EventBus } from '@ziee/framework/stores'
import { useStore } from 'zustand'
import { resolveOrThrow, type WorkbenchAPI } from '@/modules/workbench/core'
// The capability CONTRACTS are TYPE-ONLY imports (erased at build), and the ids are plain
// string literals — so core keeps a compile-time reference to an extension's published
// shape without a runtime core→extensions edge (INV-6: routing is by id).
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import { workbenchDockStore } from './WorkbenchDock.store'
import { resolvePaneEntity } from './paneModel'
import { clearPaneState } from './paneState'
import type { PaneEntity } from './paneState'
import { destroy as destroyDeclarativeMount } from '@/modules/workbench/core/render/declarativeMount'

/** Self-close a pane bound to a gone entity (its store removal + state clear). Only clear state when
 *  the pane was ACTUALLY removed (`removePane` no-ops on the last surviving pane — keep-≥1). */
function closePane(paneId: string): void {
  if (workbenchDockStore.getState().removePane(paneId)) {
    clearPaneState(paneId)
    // Entity-bound panes are `artifact`/`run` panes — never a contributed declarative pane, which
    // binds no entity — so this never names a declarative mount and is inert. It stays as the
    // standing guarantee that EVERY close path releases one, should a bound pane ever be one.
    destroyDeclarativeMount(paneId)
  }
}

/** Every pane in the dock that names an entity, per its kind's registered resolver. Read from
 *  the STORE, so a pane that is not its region's active tab (and therefore not rendered) is
 *  bound exactly like one that is. */
export function entityBoundPanes(): { paneId: string; entity: PaneEntity }[] {
  const out: { paneId: string; entity: PaneEntity }[] = []
  for (const pane of workbenchDockStore.getState().panes()) {
    const entity = resolvePaneEntity(pane)
    if (entity) out.push({ paneId: pane.id, entity })
  }
  return out
}

/** Reconcile entity-bound panes against the current artifact catalog; self-close the gone ones.
 *  Idempotent + safe to call anytime. Driven by `useEntitySelfClose` below — on mount, on a pane-set
 *  change, and on every `sync:artifact` frame, INCLUDING the one the acting tab echoes locally for
 *  its own delete (`core/sync/localEcho.ts`). Exported so the unit suite can drive it directly. */
export async function reconcileEntityPanes(api: WorkbenchAPI): Promise<void> {
  // Skip the catalog fetch entirely when NO pane names an entity (the common case) — the
  // reconcile only has work to do once a bound pane exists.
  const bound = entityBoundPanes()
  if (bound.length === 0) return
  let ids: Set<string>
  try {
    const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
    const catalog = await data.catalog()
    ids = new Set(catalog.artifacts.map(a => a.id))
  } catch {
    return // a catalog read failure must NOT close panes (distinguish "gone" from "query failed")
  }
  // Any pane BOUND to an `artifact` whose id is no longer in the catalog is gone → self-close it
  // (unrelated / other-entity panes are never touched). Re-read the bindings rather than reusing
  // the pre-fetch snapshot: the catalog read is awaited, and a pane may have been closed (or
  // opened) while it was in flight.
  for (const { paneId, entity } of entityBoundPanes()) {
    if (entity.entity === 'artifact' && !ids.has(entity.id)) closePane(paneId)
  }
}

export function useEntitySelfClose(api: WorkbenchAPI): void {
  const cells = useStore(workbenchDockStore, s => s.cells)
  useEffect(() => {
    void reconcileEntityPanes(api)
    // The sync/SSE path: a `sync:artifact` frame (another device, or the server's own emit) →
    // re-reconcile so a deleted artifact's pane self-closes without a reload.
    const off = EventBus.on('sync:artifact', () => void reconcileEntityPanes(api))
    return () => off()
    // `cells` in deps re-reconciles after a pane add/close settles (e.g. re-binding after a
    // pop-out/return); `api` is stable per project. NOTE: this dep does NOT cover the acting tab's
    // OWN delete — a delete doesn't change the pane set, and the server suppresses that tab's
    // frame — which is why the affordance echoes it onto `sync:artifact` locally.
  }, [api, cells])
}
