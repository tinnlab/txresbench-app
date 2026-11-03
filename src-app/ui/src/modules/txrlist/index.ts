/**
 * txrlist public surface.
 *
 * The barrel is the module's only public entry: the row/section/selection
 * contract (types.ts) now, and the components + hooks + adapters that the
 * run screens (E, D, I) compose. Host screens import from here and nowhere
 * else inside the module.
 */
export * from './types'
