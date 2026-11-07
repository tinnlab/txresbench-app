/**
 * txrhistory public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this node owns: the path builder (PROV-HIST-1) — the F screen's
 * not-found "History" link and the run screens' handoffs bind the
 * `/history` route through `historyPath`, never a URL literal —, the
 * host-state vocabulary (types.ts, PROV-HIST-2: the K filter options and
 * the view/action shapes) and the history store (PROV-HIST-3: the K list's
 * data-owning surface, whole-store-lazy — its chunk loads only when a
 * consumer imports it; joining at ITEM-2 with the store file, per the
 * plan's barrel note). The module's components and pages are internal.
 */
export * from './routes'
export * from './types'
export * from './stores/TxrHistory.store'
