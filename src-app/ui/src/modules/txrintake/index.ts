/**
 * txrintake public surface.
 *
 * The barrel is the module's only public entry: host screens (ui-run's E,
 * ui-models' D/I) import the intake state contract and the shared file
 * surface from here and nowhere else inside the module. The store owning
 * a live snapshot (`stores/TxrIntake.store.ts`) and the screen/lib surfaces
 * use the same entry.
 */
export * from './types'
export * from './stores/TxrIntake.store'
export * from './components/TxrFileCard'
export * from './components/TxrFileDrop'
export * from './components/TxrProblemList'
export * from './components/TxrJoinOffer'
export * from './components/TxrVocabOffer'
