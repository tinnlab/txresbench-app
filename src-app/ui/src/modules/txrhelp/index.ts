/**
 * txrhelp public surface.
 *
 * The barrel is the module's only public entry: `helpPath(anchor?)` (the
 * `/help` route builder — the intake problems list deep-links each problem
 * to its code entry through it, never a URL literal), the content types,
 * the content data and the helpers the sibling modules bind
 * (`problemAnchorOf` for the intake problem links). The page, the
 * components and the committed validator catalogue are internal.
 */
export * from './routes'
export * from './types'
export * from './content'
