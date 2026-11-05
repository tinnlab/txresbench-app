/**
 * txrresults event surface (PROV-UR-3) — the framework EventBus events the
 * results screens' save-model entry points emit, and the emitters the header
 * buttons call (DEC-8).
 *
 * The dialogs the events open belong to `ui-models` (wave 7): its dialog host
 * subscribes to these two events and renders L / L2 over the results screen —
 * this module NEVER renders a save dialog, and until that host mounts, a
 * click emits into an empty bus (a benign no-op on a non-slice path; the
 * vertical slice ends at H). The payloads carry only engine-owned data (the
 * run id + the finished method ids), so the consumer opens the dialog without
 * reading this module's store.
 *
 * The payload shapes are the cross-node contract ui-models binds (its plan
 * records `{type, runId, methodIds}` and `{type, runId, methodId}` — see
 * ui-models DEC / PROV-UI-MODELS-2); a shape change here is a reconcile item,
 * never a silent one.
 *
 * Framework note (recorded where it bites): `AppEvents` members must satisfy
 * the framework's `BaseEvent` ("All module events must extend this",
 * `sdk/packages/framework/src/events/types.ts`), and the EventBus `emit`
 * generic does not infer its `K` from the argument — the emitters therefore
 * spell the event key explicitly, and the pre-existing sync `emit` call sites
 * gained the same explicit `K` (see `core/sync/localEcho.ts` +
 * `catalogInvalidation.test.tsx` — the union fallback only ever worked while
 * every `AppEvents` member shared the same top-level keys).
 */

import { useEventBusStore } from '@ziee/framework/events'
import type { BaseEvent } from '@ziee/framework/events'

declare module '@ziee/framework' {
  interface AppEvents {
    'txr:save-models-requested': BaseEvent & {
      type: 'txr:save-models-requested'
      runId: string
      methodIds: string[]
    }
    'txr:save-one-model-requested': BaseEvent & {
      type: 'txr:save-one-model-requested'
      runId: string
      methodId: string
    }
  }
}

/**
 * Emit the L dialog request — the G/H header "Save the models (N)" entry
 * point (the button renders only when the run produced models;
 * `run.models.length` is the N and the finished method ids the payload).
 */
export const emitSaveModels = (runId: string, methodIds: string[]): Promise<void> =>
  useEventBusStore
    .getState()
    .emit<'txr:save-models-requested'>({
      type: 'txr:save-models-requested',
      runId,
      methodIds,
    })

/**
 * Emit the L2 dialog request — the H one-method header "Save this model"
 * entry point (the button renders only for a finished method with a produced
 * model; DEC-8, the SaveOne board's entry point).
 */
export const emitSaveOneModel = (runId: string, methodId: string): Promise<void> =>
  useEventBusStore.getState().emit<'txr:save-one-model-requested'>({
    type: 'txr:save-one-model-requested',
    runId,
    methodId,
  })
