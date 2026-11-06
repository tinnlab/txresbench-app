/**
 * PROV-UI-MODELS-2 — the L / L2 / L3 dialog host, the EventBus seam between
 * `txrresults` (whose "Save the models" button emits
 * `txr:save-models-requested {type, runId, methodIds}` — PROV-UR-3) and
 * this module (which OWNS the dialogs).
 *
 * The host is mounted via `Slots.routerEffects` (the `command-palette`
 * precedent): a headless, effect-only component rendered INSIDE the router
 * context so the dialogs can navigate; it renders `null` except while a
 * dialog is open. Its subscription (EventBus `on` with a group name for
 * de-duplication, unsubscribe on unmount) and the three dialogs it opens
 * are the module's later surface; this scaffold is the mount point the
 * slot registration needs — it renders nothing.
 */
export function TxrModelsDialogHost() {
  return null
}
