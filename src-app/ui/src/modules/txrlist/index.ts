/**
 * txrlist public surface.
 *
 * The barrel is the module's only public entry: the row/section/selection
 * contract (types.ts), the board copy + selection helpers (lib/), and the
 * method-catalogue adapter (data/ — the pure join plus the fetch hooks) —
 * the screens (E, D, I) compose these.
 * Host screens import from here and nowhere else inside the module.
 */
export * from './types'
export * from './lib/format'
export * from './lib/selection'
export * from './data/methodRows'
export * from './data/useMethodRows'
export * from './data/useListEstimate'
