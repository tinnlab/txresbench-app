/**
 * txrresults public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this node owns: the run routes are bound by the sibling flow modules via
 * the path builders (PROV-UR-1) — screen F (`ui-run`) navigates to the
 * results, screen K (`ui-history`) reopens them — and neither spells a URL
 * literal. The module's stores, components and pages are internal; the
 * download and folder-reveal helper seams (`downloadPredictionsCsv`,
 * `revealRunDir`) join this barrel with their own items (PROV-UR-6/7).
 */
export * from './routes'
