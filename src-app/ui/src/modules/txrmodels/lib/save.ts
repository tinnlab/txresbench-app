/**
 * txrmodels save-request builders + checklist helpers — PROV-UI-MODELS-4
 * (ITEM-4).
 *
 * The L dialog (save a run's produced models as a set) and L2 (save one
 * model into a new or existing set) post PROV-MS-3 (`POST
 * /api/txr/models/save`); these pure builders emit the EXACT bodies — the
 * dialogs never hand-assemble the wire (`SaveModelsRequest`,
 * `SaveTarget` are the generated provider types; the builders are typed
 * against them, the provider regen drives the typecheck).
 *
 * The checklist helpers are the L dialog's two selection rules:
 *
 * - `onlySmallModels` — the board's "Only the small ones": a model is
 *   small iff its recorded `size_bytes` is at most `SMALL_MODEL_BYTES`
 *   (DEC-15, owner D24: `SMALL_MODEL_MB = 5`, ONE named constant — a
 *   display-only cutoff, not an operational tunable). A model with no
 *   recorded size (the pre-growth engine) is NEVER selected by this
 *   button: an unknown size is not a known-small size.
 * - `selectNone` — the board's "Select none": the empty selection.
 *
 * The warning lines read `formatTrainingDataWarning` (ITEM-2); the helper
 * here only selects WHICH models the warning names — exactly the run's
 * produced models whose `embeds_training_data` fact is true, in the run's
 * method order (DEC-15: never an invented warning, never a re-joined
 * order).
 *
 * The request builders take the structured choices (the set name / the
 * existing set id, the two checkboxes, the optional source label) and
 * return the wire body; both arms of `SaveTarget` stay exclusive (the
 * provider's untagged enum denies a both-arms payload on the wire — the
 * builders can never produce one).
 */
import type { SaveModelsRequest, SaveTarget } from '@/api-client/types'

/** The "Only the small ones" cutoff (DEC-15, owner D24) — named constant,
 *  one line to change; a display-only threshold. */
export const SMALL_MODEL_MB = 5

/** The cutoff in bytes (`SMALL_MODEL_MB` MiB). */
export const SMALL_MODEL_BYTES = SMALL_MODEL_MB * 1024 * 1024

/** The per-model facts the L checklist helpers read (the run's produced
 *  models as the dialog sees them: method id = the board's mono name,
 *  recorded size, the training-data residency fact). */
export interface TxrSaveableModel {
  methodId: string
  sizeBytes: number | null | undefined
  embedsTrainingData: boolean
}

/** The method ids of the models small enough for the board's "Only the
 *  small ones" (in the passed order; an unrecorded size is never small). */
export function onlySmallModels(models: ReadonlyArray<TxrSaveableModel>): string[] {
  return models
    .filter(model => {
      const size = model.sizeBytes
      return size !== null && size !== undefined && Number.isFinite(size) && size <= SMALL_MODEL_BYTES
    })
    .map(model => model.methodId)
}

/** "Select none" — the L checklist's empty selection (a named helper so
 *  the dialog's action stays one word; the RTL pins the call). */
export function selectNone(): string[] {
  return []
}

/** The board-ordered names the training-data warning names (DEC-15): the
 *  models whose `embeds_training_data` fact is true, in the pass order.
 *  Feed the result to `formatTrainingDataWarning` (ITEM-2) — the sentence
 *  is that formatter's; this helper is only the fact projection. */
export function trainingDataModelNames(models: ReadonlyArray<TxrSaveableModel>): string[] {
  return models.filter(model => model.embedsTrainingData).map(model => model.methodId)
}

/** The L/L2 save choices common to both dialogs (the structured fields the
 *  wire body carries; the dialogs' checkboxes map one-to-one). */
export interface TxrSaveOptions {
  keepTrainingFiles: boolean
  alsoExport: boolean
  /** The source file's name the save dialog showed (e.g. `patients.csv`);
   *  the engine's grown input-summary is the fallback — omitted here means
   *  "let the engine's truth win" (GAP-D). */
  sourceLabel: string | null | undefined
}

/** The shared body assembly: the checkbox fields ride always (the
 *  request is explicit), the source label only when the dialog has one
 *  (omitted means "let the engine's grown input-summary truth win" —
 *  GAP-D — and the wire key stays absent, never undefined). */
function saveBody(
  runId: string,
  methodIds: string[],
  target: SaveTarget,
  opts: TxrSaveOptions,
): SaveModelsRequest {
  const body: SaveModelsRequest = {
    run_id: runId,
    method_ids: methodIds,
    target,
    keep_training_files: opts.keepTrainingFiles,
    also_export: opts.alsoExport,
  }
  const label = opts.sourceLabel?.trim()
  if (label !== null && label !== undefined && label.length > 0) body.source_label = label
  return body
}

/** The L body: save the run's produced `methodIds` as a NEW set named
 *  `name` (PROV-MS-3's `target.set_name` arm; the L checkbox facts). */
export function buildSaveSetRequest(
  runId: string,
  methodIds: ReadonlyArray<string>,
  name: string,
  opts: TxrSaveOptions,
): SaveModelsRequest {
  return saveBody(runId, [...methodIds], { set_name: name }, opts)
}

/** The L2 body: save ONE produced model into an existing set (`set_id`) or
 *  a new set (`set_name`) — the caller passes exactly the arm the dialog's
 *  select chose (the two variants TEST-MOD-08 pins). */
export function buildSaveOneRequest(
  runId: string,
  methodId: string,
  target: SaveTarget,
  opts: TxrSaveOptions,
): SaveModelsRequest {
  return saveBody(runId, [methodId], target, opts)
}
