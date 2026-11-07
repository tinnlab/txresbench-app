/**
 * txrhistory public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this module owns: the path builder (PROV-HIST-1) — the F screen's
 * not-found "History" link and the run screens' handoffs bind the
 * `/history` route through `historyPath`, never a URL literal — and the
 * host-state vocabulary (types.ts, PROV-HIST-2: the K filter options and
 * the view/action shapes). The module's store, components and pages are
 * internal.
 */
export * from './routes'
export * from './types'
