// The draftable MOUNT-GLUE resolver (draftable-entity ITEM-10 / geneset ITEM-8c). Turns a
// view's declared `draftable` block into a live `DraftableBinding` the reactive store seeds
// `$state` from and debounce-persists back through. DOMAIN-FREE: it carries the opaque
// package `kind`/`freeze` and never interprets them (INV-1) — the domain lives only in the
// package view config, never here.

import type { Draft, DraftableSpec } from '@/api-client/types'
import type { DraftableBinding } from '@/modules/workbench/core/runtime/store'
import { authStoreProxy } from '@ziee/framework/permissions'
import { Drafts } from './Drafts.store'
// The live-session registries (instance / launch-intent / in-flight) live in the CALL-FREE
// `draftRegistry` module so `draftActions` can read them WITHOUT importing this resolver — which
// is what breaks the import cycle `importCycles.test` guards (see draftRegistry.ts header).
import {
  bindDraftInstance,
  getDraftInstance,
  inFlight,
  takeDraftLaunchIntent,
} from './draftRegistry'
// Register the generic draft module actions (`draft.parseInto`/`draft.freeze`/`draft.exportGmt`/
// `draft.launchEditor`/`draft.editFork`) via their `defineAction` side-effect — this module is
// on the workbench render path. `draftActions` imports ONLY the call-free registry, never this
// file, so this side-effect import no longer closes a cycle.
import './draftActions'

// Re-exported so the registries stay reachable through this module's public surface (existing
// importers + tests import them from here). `DraftInstance` is the instance shape.
export type { DraftInstance } from './draftRegistry'
export {
  bindDraftInstance,
  getDraftInstance,
  setDraftLaunchIntent,
  unbindDraftInstance,
  __resetDraftInstancesForTests,
} from './draftRegistry'

/** The most-recently-updated row of a list (ISO `updated_at`), or `undefined` for []. */
function mostRecent(drafts: readonly Draft[]): Draft | undefined {
  let best: Draft | undefined
  for (const d of drafts) {
    if (!best || d.updated_at > best.updated_at) best = d
  }
  return best
}

/** The signed-in user's id, for scoping the reload fallback to the user's OWN drafts (never
 *  another project member's open draft). Non-reactive read (`.$`) — a live-session fact; the
 *  framework auth view is the app-agnostic accessor (unset in a bare test → undefined). */
function currentUserId(): string | undefined {
  try {
    return (authStoreProxy().$.user as { id?: string } | null | undefined)?.id
  } catch {
    return undefined
  }
}

/**
 * Resolve the `DraftableBinding` for a draftable editor view (draftable-entity ITEM-10 /
 * geneset ITEM-8c). Deduped per `viewId` (StrictMode), then resolved in order:
 *   1. the EXPLICIT draft a launcher threaded for this `viewId` (`setDraftLaunchIntent`) — the
 *      deterministic path: New-collection / Edit→new-version create the draft then launch. An
 *      explicit launch intent MUST win over a stale bound instance (round-2 HIGH): a SECOND
 *      New-collection/Edit re-launches the editor pane, and the intent — not the previously
 *      bound draft — decides what it opens, or the new draft is orphaned and the editor shows
 *      the OLD collection (breaks New=fresh and INV-6 Edit=current-content). `launchEditorBoundTo`
 *      also unbinds the prior instance, so both belts hold.
 *   2. the draft already BOUND to this `viewId` (a StrictMode remount / tab switch, no new
 *      intent) — resume it;
 *   3. else the current user's most-recent still-OPEN draft of the declared `kind` in this
 *      project (this is what makes a full page RELOAD restore the edited state — TEST-22 —
 *      scoped by `created_by` so a shared project never binds another member's draft, and
 *      SKIPPED entirely when the acting identity is unknown — round-2 MEDIUM fail-safe);
 *   4. else CREATE a fresh project-scoped draft of the opaque `kind`.
 * The binding seeds `$state` from `draft.data` and debounce-persists every `set()` back.
 */
export function resolveDraftBinding(
  viewId: string,
  draftable: DraftableSpec,
  projectId: string,
): Promise<DraftableBinding> {
  // The registry types the shared map loosely (`Promise<unknown>`) so it need not import this
  // resolver's binding type; every entry is produced HERE, so the resolver's own type is exact.
  const existing = inFlight.get(viewId) as Promise<DraftableBinding> | undefined
  if (existing) return existing
  const p = doResolve(viewId, draftable, projectId).finally(() => {
    inFlight.delete(viewId)
  })
  inFlight.set(viewId, p)
  return p
}

async function doResolve(
  viewId: string,
  draftable: DraftableSpec,
  projectId: string,
): Promise<DraftableBinding> {
  let draft: Draft | undefined

  // 1. the explicit draft a launcher threaded for this editor (deterministic) — checked FIRST,
  //    BEFORE the never-cleared bound instance, so a SECOND New-collection / Edit-fork binds the
  //    NEW/fork draft rather than resuming the stale one that is still bound to this viewId
  //    (round-2 HIGH). Single-use: consuming it clears it so it can't leak to a later resolve.
  const intentId = takeDraftLaunchIntent(viewId)
  if (intentId) draft = await Drafts.get(intentId).catch(() => undefined)

  // 2. already bound (a StrictMode remount / tab switch with NO fresh launch intent) — resume it.
  if (!draft) {
    const bound = getDraftInstance(viewId)
    if (bound) draft = await Drafts.get(bound.draftId).catch(() => undefined)
  }

  // 3. reload resume — the current user's most-recent open draft of this kind in this project.
  //    FAIL-SAFE (round-2 MEDIUM): when the acting identity is UNKNOWN (auth not yet hydrated on a
  //    fresh reload — the exact window a mount-effect reload hits), do NOT bind from the shared
  //    project list at all; skip to create-new. And the filter binds ONLY a row whose `created_by`
  //    equals the current user (a null-`created_by` row never equals `me`), so a shared project
  //    can never bind another member's — or an unattributed — open draft to the current user.
  if (!draft) {
    const me = currentUserId()
    if (me != null) {
      const open = (await Drafts.listForProject(projectId, draftable.kind)).filter(
        d => d.status === 'open' && d.created_by === me,
      )
      draft = mostRecent(open)
    }
  }

  // 4. else create a fresh draft.
  if (!draft) {
    draft = await Drafts.create({ kind: draftable.kind, project_id: projectId, data: {} })
  }

  const resolved = draft
  bindDraftInstance(viewId, {
    draftId: resolved.id,
    projectId,
    kind: draftable.kind,
    freeze: draftable.freeze,
  })
  const seed =
    resolved.data && typeof resolved.data === 'object' && !Array.isArray(resolved.data)
      ? (resolved.data as Record<string, unknown>)
      : {}
  return {
    data: seed,
    persist: (state: Record<string, unknown>) => Drafts.persist(resolved.id, state),
  }
}
