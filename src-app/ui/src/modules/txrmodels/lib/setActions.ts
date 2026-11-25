/**
 * txrmodels — the ONE set-mutation seam (PROV-MS-4) + the two minimal
 * module-level channels the registered set actions need.
 *
 * The wire calls are called from ONE place so a mutation has one path:
 *
 * - `renameSetById` — `PATCH /api/txr/model-sets/{id}` via
 *   `ApiClient.ModelSets.renameSet`: the `TxrRenameSetDialog`'s confirm and
 *   the registered `models.renameSet` action call THE SAME function (the AI
 *   path never re-implements a rename; it is a thin wrapper over the
 *   dialog's call).
 * - `deleteSetById` — `DELETE /api/txr/model-sets/{id}?keep_files=false`
 *   (DEC-14: files go with the rows; `keep_files` is `false` on the wire for
 *   EVERY caller — the Models page's "Delete the set" and Card 3's "Delete
 *   the run's models" both promise the files go): the
 *   `TxrDeleteSetDialog`'s confirm is its one caller (the registered
 *   `models.deleteSet` action deliberately does NOT delete — it only opens
 *   that confirm dialog, so the person confirms).
 *
 * The two channels are the "the page's data comes from hooks" answer to the
 * registered actions' refresh obligation:
 *
 * - `notifyModelSetsChanged` / `subscribeModelSetsChanged` — the refresh
 *   bus. `models.renameSet` (the AI/command path) has no dialog `onSaved`
 *   to refresh through, so after the wire call it publishes this event and
 *   the host that shows the data listens: the Models page (the inventory +
 *   sets hooks, subscribed in the page — the merged list shows saved rows
 *   but no set actions). The human path
 *   refreshes through the dialogs' own `onSaved`/`onDeleted` as before — the
 *   bus is the extra path, never a replacement, so no double refresh.
 * - `requestDeleteSet` / `subscribeDeleteSetRequest` — the pending-request
 *   channel: how `models.deleteSet` OPENS the delete confirm dialog. A
 *   module-level listener set is the simplest existing shape for an action
 *   to open a dialog (the EventBus pattern the dialog host uses, kept
 *   smaller): the action calls `requestDeleteSet(setId)`; every mounted
 *   host that can confirm the delete (the Models page)
 *   subscribes and opens its own `TxrDeleteSetDialog` for that id. The
 *   actual `DELETE` still happens only in the dialog's confirm — the
 *   action never deletes, `?keep_files=false` never leaves the dialog.
 *   `requestDeleteSet` answers whether the request was HANDLED (a
 *   listener opened the dialog): each listener returns `true` only when it
 *   actually opened the dialog, `false` when the set is unknown to it or
 *   it has no data yet — so the action can REJECT (never report a
 *   confirm "opened" that no one opened).
 */
import { ApiClient } from '@/api-client'

/** The one failure line for the delete-OPEN path (the pages' action error —
 *  never the engine's own words). */
export const SET_DELETE_FAILED_LINE = 'The set could not be deleted.'

/** Rename one set (the ONE `PATCH` call the dialog and the action share). */
export function renameSetById(setId: string, name: string): Promise<unknown> {
  return ApiClient.ModelSets.renameSet({ id: setId, name })
}

/** Delete one set and its models — DEC-14's `keep_files: false` always. */
export function deleteSetById(setId: string): Promise<void> {
  return ApiClient.ModelSets.deleteSet({ id: setId, keep_files: false })
}

// ── the refresh bus (the actions' post-mutation re-read) ─────────────────────

type ChangedListener = () => void

const changedListeners = new Set<ChangedListener>()

/** Subscribe to the "the model-set data changed" event (returns unsubscribe). */
export function subscribeModelSetsChanged(listener: ChangedListener): () => void {
  changedListeners.add(listener)
  return () => {
    changedListeners.delete(listener)
  }
}

/** Publish the event (the registered `models.renameSet` action's refresh). */
export function notifyModelSetsChanged(): void {
  for (const listener of changedListeners) listener()
}

// ── the pending-delete channel (an action opening a confirm dialog) ──────────

/** A listener answers whether IT handled the request (opened the dialog):
 *  `true` only when it opened it; `false` when the set is unknown to it or
 *  it has no data yet (the request must then fail, not report success). */
type DeleteRequestListener = (setId: string) => boolean

const deleteRequestListeners = new Set<DeleteRequestListener>()

/** Subscribe to the "delete set N was requested" event (returns unsubscribe). */
export function subscribeDeleteSetRequest(listener: DeleteRequestListener): () => void {
  deleteRequestListeners.add(listener)
  return () => {
    deleteRequestListeners.delete(listener)
  }
}

/** Publish the request (the registered `models.deleteSet` action's one job:
 *  open the confirm dialog — it never deletes). Returns `true` when some
 *  listener HANDLED it (opened the dialog for that set) — the first handler
 *  wins (only one host can be showing the confirm at a time); `false` when
 *  every listener declined (the set is unknown to the mounted pages, or no
 *  page has data yet), so the caller can reject instead of lying. */
export function requestDeleteSet(setId: string): boolean {
  for (const listener of deleteRequestListeners) {
    if (listener(setId)) return true
  }
  return false
}
