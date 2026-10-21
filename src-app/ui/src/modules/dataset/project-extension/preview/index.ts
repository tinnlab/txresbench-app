// The dataset-preview contribution point — the public entry a contributing package
// imports. See `docs/design/dataset-attach-readiness-and-preview.md`.
//
// Importing this module REGISTERS the shipped declarations: `./load` reads every
// `packages/*/dataset-preview.yaml` at module evaluation, so a consumer gets the
// contributed previews by importing the seam rather than by remembering to call a
// bootstrap. Nothing is registered from app code — see `./load` for the mechanism
// and `./declared` for the template language it interprets.

export { DECLARED_PREVIEW_FILES, registerDeclaredPreviews, sourceLabelOf } from './load'
export {
  contributionOf,
  DECLARED_PREVIEW_API_VERSION,
  PHRASE_BAG_ROOTS,
  PHRASE_COUNT_ROOT,
  PHRASE_TITLE_ROOT,
  pathError,
  phraseContextOf,
  placeholdersOf,
  readPreviewDeclaration,
  renderPhrase,
} from './declared'
export type {
  DeclarationReadResult,
  DeclaredPreview,
  PhraseBagRoot,
  PhraseContext,
} from './declared'
export { DatasetPreviewRegistry, datasetPreviewRegistry, registerDatasetPreview } from './registry'
export type { DatasetPreviewContribution, PreviewLattice, ResolvedPhrase } from './types'
export {
  describePart,
  describeSummary,
  EMPTY_SUMMARY_TEXT,
  fallbackPartText,
  holdingsFor,
  projectHoldings,
  remainderText,
  rollupHoldings,
} from './summary'
export type { HoldingsTotals, PartDisplay, SummaryDeps, SummaryDisplay } from './summary'
