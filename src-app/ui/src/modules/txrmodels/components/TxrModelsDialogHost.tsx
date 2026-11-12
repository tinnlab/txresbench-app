/**
 * TxrModelsDialogHost — the L / L2 / L3 dialog host (PROV-UI-MODELS-2,
 * ITEM-9), the EventBus seam between `txrresults` and this module.
 *
 * Mounted via `Slots.routerEffects` (the `command-palette` precedent),
 * inside the router context so the dialogs can navigate; it renders
 * exactly ONE dialog at a time and `null` when none is open (no layout
 * shift, the framework's contract for an effect host).
 *
 * The subscription (TEST-MOD-12): the framework EventBus `on` is passed
 * the group name `txr-models-dialog-host` — a host re-mount REPLACES its
 * own handlers for the two events instead of stacking a second
 * subscription (the group de-duplication), and the unsubscribers run on
 * unmount. A second event while a dialog is open REPLACES the dialog
 * state — the requests never stack; an emission with no mounted host is a
 * benign no-op (the bus's zero-handler path — the wave-3 button never
 * crashes an app whose dialog host is not mounted, e.g. a route with no
 * routerEffects slot).
 *
 * The open state is the host's own (payload-bearing: the run id + the
 * requested method ids, or the save response) — the module store's
 * `dialog` field remains the D/I pages' cross-screen mirror (card /
 * details), and JEDUF forbids double bookkeeping: one writer, one reader
 * per surface. The dialogs render from the payload + the engine's own
 * records (DEC-3: never another module's store).
 */
import { useEffect, useState } from 'react'
import { useEventBusStore } from '@txresbench/framework/events'
import type { ModelSaveResponse } from '@/api-client/types'
import { TxrSaveModelsDialog } from './TxrSaveModelsDialog'
import { TxrSaveOneDialog } from './TxrSaveOneDialog'
import { TxrSavedDialog } from './TxrSavedDialog'

/** The EventBus group name — the de-duplication key for this host's two
 *  subscriptions (`on(type, handler, group)`): a re-mount replaces, never
 *  stacks. */
const DIALOG_HOST_GROUP = 'txr-models-dialog-host'

/** The host's open dialog: the event payload (L or L2) or the saved
 *  response (L3); `null` = none open. */
type TxrDialogRequest =
  | { kind: 'save-set'; runId: string; methodIds: string[] }
  | { kind: 'save-one'; runId: string; methodId: string }
  | { kind: 'saved'; response: ModelSaveResponse }
  | null

// The release-gated e2e seam for the L entry (the repo's own testing device —
// `core/workstore`'s `window.__txr_read` precedent): on the deterministic
// real-backend tier NO run ever produces a model (DEC-14's all-cannot-run
// scope), so the results screen's "Save the models (N)" button never renders
// and the event it would emit is unreachable from a spec. The full-backend
// spec therefore drives the SAME bus event this host subscribes to through
// this guard: present under the Vite dev server and the e2e preview build
// (`VITE_ENABLE_TEST_SEAMS=1`), absent from a release bundle (neither set —
// the seam cannot be talked into from the outside, the `__txr_read`
// gating). The payload shape stays the `txrresults`-owned contract
// (`{type, runId, methodIds}` — PROV-UR-3); the host only ever opens what it
// is told to.
if ((import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS) && typeof window !== 'undefined') {
  ;(window as unknown as { __txrSaveModels?: unknown }).__txrSaveModels = (
    runId: string,
    methodIds: string[],
  ): Promise<void> =>
    useEventBusStore.getState().emit<'txr:save-models-requested'>({
      type: 'txr:save-models-requested',
      runId,
      methodIds,
    })
}

export function TxrModelsDialogHost() {
  const [request, setRequest] = useState<TxrDialogRequest>(null)

  useEffect(() => {
    const bus = useEventBusStore.getState()
    const offSet = bus.on(
      'txr:save-models-requested',
      event => {
        setRequest({ kind: 'save-set', runId: event.runId, methodIds: event.methodIds })
      },
      DIALOG_HOST_GROUP,
    )
    const offOne = bus.on(
      'txr:save-one-model-requested',
      event => {
        setRequest({ kind: 'save-one', runId: event.runId, methodId: event.methodId })
      },
      DIALOG_HOST_GROUP,
    )
    return () => {
      offSet()
      offOne()
    }
  }, [])

  if (request === null) return null

  if (request.kind === 'save-set') {
    return (
      <TxrSaveModelsDialog
        runId={request.runId}
        methodIds={request.methodIds}
        onClose={() => setRequest(null)}
        onSaved={response => setRequest({ kind: 'saved', response })}
      />
    )
  }

  if (request.kind === 'save-one') {
    return (
      <TxrSaveOneDialog
        runId={request.runId}
        methodId={request.methodId}
        onClose={() => setRequest(null)}
        onSaved={response => setRequest({ kind: 'saved', response })}
      />
    )
  }

  return (
    <TxrSavedDialog response={request.response} onClose={() => setRequest(null)} />
  )
}
