/**
 * txrhelp public surface.
 *
 * The barrel is the module's only public entry: `helpPath(anchor?)` (the
 * `/help` route builder — the intake problems list deep-links each problem
 * to its code entry through it, never a URL literal) and the content
 * types. The page, the content data and the components are internal.
 */
export * from './routes'
export * from './types'
export { problemAnchorOf } from './content'
