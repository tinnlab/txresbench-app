/**
 * txrintake public surface.
 *
 * The barrel is the module's only public entry: host screens (ui-run's E,
 * ui-models' D/I) import the intake state contract from here and nowhere
 * else inside the module. The store owning a live snapshot
 * (`stores/TxrIntake.store.ts`) and the screen/lib/component surfaces use
 * the same entry.
 */
export * from './types'
