/**
 * txrhelp public surface.
 *
 * The barrel is the module's only public entry: `helpPath(anchor?)` (the
 * `/help` route builder — never a URL literal), `HelpLink` (the link into
 * Help that the intake problems list deep-links each problem code with; it
 * carries the step the user is on, so Help can offer the way back), the
 * content types, the content data and the helpers the sibling modules bind
 * (`problemAnchorOf` for the intake problem links). The page, its other
 * components and the committed validator catalogue are internal.
 */
export * from './routes'
export * from './types'
export * from './content'
export * from './components/HelpLink'
