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
import type { MethodSummary, SaveModelsRequest, SaveTarget, TxrRunDetail } from '@/api-client/types'
import { UNRECORDED, formatBytes, formatPredicts } from './format'

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

// ─────────────────────────────────────────────────────────────────────────────
// The L checklist's pure facts (ITEM-9) — the dialog's rows are derived
// here, never hand-assembled in JSX
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The L checklist's one row per produced model: the board's mono id (the
 * produced model's `method_id`), the group label the board shows beside it
 * ("Response probability" / "Dynamic risk" / "Static risk" — the RUN's
 * method row joined by `method_id`, CONS-UM-12; null when the row is
 * absent), the produced model's recorded size (GAP-B's `size_bytes`,
 * read defensively — a non-finite value is a missing size, never "0 MB"),
 * and the training-data residency fact from the METHOD CATALOGUE's record
 * (CONS-UM-22 / GAP-A: `MethodSummary.embeds_training_data` joined by
 * method id — a missing catalogue row means NO recorded fact, so the
 * warning line never names it: never an app-invented warning, DEC-15).
 */
export interface TxrSaveChecklistEntry extends TxrSaveableModel {
  groupLabel: string | null
}

/** The checklist in the run's model order (the order the board draws). */
export function buildSaveChecklist(
  run: TxrRunDetail,
  methods: ReadonlyArray<MethodSummary>,
): TxrSaveChecklistEntry[] {
  const methodById = new Map(methods.map(method => [method.id, method]))
  return run.models.map(model => {
    const method = methodById.get(model.method_id)
    const runMethod = run.methods.find(m => m.method_id === model.method_id)
    const size = model.size_bytes
    return {
      methodId: model.method_id,
      groupLabel: runMethod?.group_label ?? null,
      sizeBytes: Number.isFinite(size) ? size : null,
      embedsTrainingData: method?.embeds_training_data === true,
    }
  })
}

/**
 * The dialog's initial selection: the event payload's ids that name a
 * produced model (the payload is the "save these" request). A payload that
 * names NONE of the produced models — a run that finished after the emit,
 * or a provider that spelled a different id — falls back to the board's
 * select-all default: the dialog never opens with an empty selection when
 * there are models to save.
 */
export function initialSaveSelection(
  entries: ReadonlyArray<TxrSaveChecklistEntry>,
  requested: ReadonlyArray<string>,
): ReadonlySet<string> {
  const produced = new Set(entries.map(entry => entry.methodId))
  const picked = new Set(requested.filter(id => produced.has(id)))
  return picked.size > 0 ? picked : new Set(produced)
}

/**
 * The selected models' total bytes: the Σ of the KNOWN sizes. One selected
 * model whose size is unrecorded → `null` — an "about X MB" total that
 * omits an unknown size would understate; a null renders the count line
 * without the size segment (never "0 MB"). An EMPTY selection is `null`
 * too — nothing selected has no total at all, and "about 0 B" would be a
 * fabricated number.
 */
export function totalSelectedBytes(
  selected: ReadonlySet<string>,
  entries: ReadonlyArray<TxrSaveChecklistEntry>,
): number | null {
  if (selected.size === 0) return null
  let total = 0
  for (const entry of entries) {
    if (!selected.has(entry.methodId)) continue
    if (entry.sizeBytes === null || entry.sizeBytes === undefined) return null
    total += entry.sizeBytes
  }
  return total
}

/** The board's count line: "N of M selected" + the size segment when the
 *  selected total is known ("N of M selected · about X MB" — the board's
 *  example numbers are design facts, never formatter constants). */
export function saveCountLine(selected: number, total: number, sizeBytes: number | null): string {
  const head = `${selected} of ${total} selected`
  return sizeBytes === null ? head : `${head} \u00b7 about ${formatBytes(sizeBytes)}`
}

/** The cannot-run notes: one line per method whose row never reached
 *  finished — the board's "cox-ctdna-status-rfs could not run, so it has
 *  no model to save." (never a mention of a method that has a model). */
export function cannotRunNotes(run: TxrRunDetail): string[] {
  return run.methods
    .filter(m => m.state === 'cannot_run')
    .map(m => `${m.label.trim().length > 0 ? m.label : m.method_id} could not run, so it has no model to save.`)
}

/**
 * The L dialog's "Made from …" line (`SaveModels.dc.html`): the source
 * file (the run's grown `input_summary.file_names` — GAP-D), the patient
 * count (the input summary's; the predictions' patient count is the
 * defensive fallback when the summary lacks it — the predictions the run
 * produced ARE the run's patients), the decision day and the outcome
 * spelling, joined with the board's commas. A null fact omits its segment
 * (never a blank, never a fabricated fact).
 */
export function formatMadeFrom(
  run: TxrRunDetail,
  predictPatientCount: number | null,
): string {
  const segments: string[] = []
  const file = run.input_summary?.file_names?.patients?.trim()
  if (file !== undefined && file.length > 0) segments.push(file)
  const summaryPatients = run.input_summary?.patients
  const patientCount =
    summaryPatients ?? (predictPatientCount !== null && predictPatientCount > 0 ? predictPatientCount : null)
  if (patientCount !== null) {
    segments.push(`${patientCount} ${patientCount === 1 ? 'patient' : 'patients'}`)
  }
  const day = run.config?.decision_day
  if (day !== undefined && Number.isFinite(day)) segments.push(`decision day ${day}`)
  const predicts = formatPredicts(null, run.outcome?.endpoint ?? null, run.outcome?.horizon ?? null)
  if (predicts !== UNRECORDED) segments.push(predicts)
  return `Made from ${segments.join(', ')}.`
}

/** The L2 summary line's "learned from" sentence (the one-run segment):
 *  "learned from N patients, decision day D" — the produced model's
 *  trained-cohort count + the run's decision day; a null fact omits its
 *  piece. */
export function formatLearnedFrom(patients: number | null, decisionDay: number | null): string | null {
  const parts: string[] = []
  if (patients !== null) parts.push(`learned from ${patients} ${patients === 1 ? 'patient' : 'patients'}`)
  if (decisionDay !== null) parts.push(`decision day ${decisionDay}`)
  return parts.length === 0 ? null : parts.join(', ')
}
