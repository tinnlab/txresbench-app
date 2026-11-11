/**
 * txrlist public surface.
 *
 * The barrel is the module's only public entry: the row/section/selection
 * contract (types.ts), the board copy + selection helpers (lib/), the
 * method-catalogue adapter (data/ — the pure join plus the fetch hooks),
 * and the list pieces (components/ — the board row, the run-group header,
 * the filter bar, the shared select list, and the redesigned E method
 * picker) — the screens (E, D, I) compose these.
 * Host screens import from here and nowhere else inside the module.
 */
export * from './types'
export * from './lib/format'
export * from './lib/selection'
export * from './lib/methodPicker'
export * from './data/methodRows'
export * from './data/useMethodRows'
export * from './data/useListEstimate'
export * from './data/useMethodCardDetail'
export * from './components/TxrListRow'
export * from './components/TxrListSectionHeader'
export * from './components/TxrListFilterBar'
export * from './components/TxrListBottomBar'
export * from './components/TxrSelectList'
export * from './components/TxrMethodCardRow'
export * from './components/TxrMethodPicker'
