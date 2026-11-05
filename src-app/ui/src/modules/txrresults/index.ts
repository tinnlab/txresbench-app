/**
 * txrresults public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this node owns: the run routes are bound by the sibling flow modules via
 * the path builders (PROV-UR-1) — screen F (`ui-run`) navigates to the
 * results, screen K (`ui-history`) reopens them — and neither spells a URL
 * literal. The two helper seams (PROV-UR-6/7, GAP-HIST-4) join the barrel
 * here: `downloadPredictionsCsv` (the CSV download) and `revealRunDir`
 * (the desktop open-folder) — screen K's "Download predictions" / "Open
 * the folder" import through this surface and never own a seam-mirror.
 * The module's stores, components and pages are internal.
 */
export * from './routes'
export { downloadPredictionsCsv } from './lib/download'
export { revealRunDir } from './lib/reveal'
