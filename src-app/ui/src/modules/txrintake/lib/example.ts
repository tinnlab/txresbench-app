/**
 * txrintake example-flow lib — qa-fixes3 ITEM-4.
 *
 * The ONE "Use example" family: the shared table loader (the A-screen
 * loader moved here and grown with the third kind), the study answers that
 * are CONSISTENT with the example family (the file-validator's seeded
 * simulator — its facts are the generator's own: markers M1/M2/M3 in a.u.,
 * draws before (-28/-14) and during (0..56, follow-up to 336) treatment,
 * both survival and response outcomes, no real disease or drug), the
 * overlap guard the buttons share, and the example-set ensure/poll.
 *
 * Facts, never design examples:
 *
 * - The example family is SYNTHETIC (generator README's provenance table):
 *   no disease, no named drug — the honest B answers are "Other or not
 *   listed" / "Other or mixed" (the board's own catch-all options), not a
 *   cancer the data does not carry.
 * - The markers have NO vocabulary match (M1/M2/M3 in a.u. are the
 *   simulator's own), so the example validation produces no join offer and
 *   no ladder match; none of the seven marker groups is "measured" by the
 *   example, so `markerGroups` stays unanswered (`null` — the B panel then
 *   renders what it does for any skipped group question).
 * - Draws: before treatment ALWAYS (every patient has day -28 and -14),
 *   four or more during treatment (day 0, 21, 42, 56 before the last draw),
 *   and the last draw the flow uses is day 56 — the board decision-day
 *   value the store's parameters default to (DEC-5's grid).
 * - "What to predict" is the survival task ('progression-by-day'): the
 *   example carries the pfs/os pair every method learns on; the response
 *   pair is the optional second outcome of the same file (D48).
 *
 * Copy rule: location-neutral (qa-fixes2 ITEM-2) — the copy names no
 * deployment location, and carries no status words (the module's INV-5
 * scan).
 */
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import { parseCsvText } from '@/lib/txr-files/csv'
import type { ExampleSetResponse } from '@/api-client/types'
import { resolveColumnRenames } from './flow'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { FileSlot } from '../stores/TxrIntake.store'
import type { IntakeIntent, LoadedFile, StudyAnswers } from '../types'

/** The example table kinds of the three paths (the first two are the C
 *  screen's pair; the third is the N screen's predict table — ITEM-3). */
export type ExampleTableKind = FileTableKind | 'predict-measurements'

/** The decode kind of each example table (the predict table IS a
 *  measurements table for the decoder — its header scan is the same). */
const DECODE_KIND: Record<ExampleTableKind, FileTableKind> = {
  patients: 'patients',
  measurements: 'measurements',
  'predict-measurements': 'measurements',
}

/** The B answers the example family factually has (see the module header). */
export const EXAMPLE_STUDY: StudyAnswers = {
  disease: 'other',
  treatment: 'other-mixed',
  outcome: 'progression-by-day',
  markerGroups: null,
  beforeTreatment: 'always',
  drawsDuringTreatment: 4,
  lastDrawDay: 56,
}

/** The example's last draw — the decision-day value of the example (DEC-5's
 *  grid: day 56 is the value the store and the engine default to). */
export const EXAMPLE_DECISION_DAY = 56

/** The file slots each path's example fills (train = the C screen's pair). */
export function exampleSlotsFor(path: IntakeIntent): FileSlot[] {
  return path === 'train' ? ['patients', 'measurements'] : ['predictMeasurements']
}

/** The example table kinds each path's example loads. */
export function exampleKindsFor(path: IntakeIntent): ExampleTableKind[] {
  return path === 'train' ? ['patients', 'measurements'] : ['predict-measurements']
}

/**
 * ONE example CSV through the provider asset endpoint (CONS-UI-INTAKE-6) —
 * the same bytes the "Download the full example" link serves, decoded by
 * the browser decode (PROV-FV-7) and adopted as a table. The generated
 * response type for the text/csv body is `void` (the openapi schema has no
 * JSON body — a provider dtype artifact, DRIFT-1 ITEM-4 #3); the shared
 * transport's parse switch returns the TEXT of a `text/*` body, so this
 * cast at the one seam is the consumer side, and the byte guard keeps a
 * bodiless response loud instead of a silent empty table.
 */
export async function fetchExampleTable(kind: ExampleTableKind): Promise<ParsedTable> {
  const body = (await ApiClient.FileValidation.example({ kind })) as unknown as string
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`the example ${kind} file came back empty`)
  }
  return parseCsvText(body, { kind: DECODE_KIND[kind] }, `${kind}_example.csv`)
}

/** The adopted-file shell of an example table (decode only — the C/N flow
 *  derives the card facts exactly as it does for a dropped file). */
export function exampleLoadedFile(table: ParsedTable, kind: FileTableKind): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: resolveColumnRenames(table.columns, kind),
  }
}

/** The one-line banner under the file screens (the plan's copy). */
export const EXAMPLE_BANNER = 'This is example data'

/** The "Clear example" action's label (the plan's copy). */
export const CLEAR_EXAMPLE_LABEL = 'Clear example'

/** Poll the ITEM-3 example-set endpoint until it settles (ready/failed).
 *  `creating` reports progress through `onProgress` (the run id + status +
 *  the method pick — the UI's progress state); a `failed` answer throws
 *  with the honest reason so the button's retry state shows it. */
export async function ensureExampleSet(
  onProgress: (response: ExampleSetResponse) => void = () => {},
  options: { delayMs?: number; cancelled?: () => boolean } = {},
): Promise<ExampleSetResponse> {
  for (;;) {
    if (options.cancelled?.() === true) {
      throw new Error('The example models request was cancelled.')
    }
    const response = await ApiClient.Models.exampleSet()
    if (response.state === 'creating') {
      onProgress(response)
      await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1500))
      continue
    }
    if (response.state === 'failed') {
      throw new Error(
        response.error ?? 'The example models could not be prepared. Try again.',
      )
    }
    return response
  }
}

/**
 * The ONE example adoption (qa-fixes3 ITEM-4): set the path's intent, fill
 * the study answers consistent with the example family (train path only),
 * adopt the example tables into the path's slots through
 * `adoptExampleFile` (so the badge/banner/Clear-example stay honest), and
 * for the reuse path ensure the example saved set exists (ITEM-3) — the
 * progress + failure are the caller's (the button renders them).
 *
 * The flows the pages run afterwards are the SAME drop flows: adoption
 * nulls the validation and clears the confirmed offers (the example's
 * columns are the example's — the C/N inspect/validate round derives
 * everything for the current files, exactly as a user drop does).
 */
export async function runExampleFlow(
  path: IntakeIntent,
  hooks: {
    onSetProgress?: (response: ExampleSetResponse) => void
    cancelled?: () => boolean
  } = {},
): Promise<void> {
  useTxrIntakeStore.getState().setIntent(path)
  if (path === 'train') {
    useTxrIntakeStore.getState().patchStudy(EXAMPLE_STUDY)
    useTxrIntakeStore.getState().patchParameters({ decision_day: EXAMPLE_DECISION_DAY })
    const [patients, measurements] = await Promise.all([
      fetchExampleTable('patients'),
      fetchExampleTable('measurements'),
    ])
    const after = useTxrIntakeStore.getState()
    after.adoptExampleFile('patients', exampleLoadedFile(patients, 'patients'))
    const current = useTxrIntakeStore.getState()
    current.adoptExampleFile('measurements', exampleLoadedFile(measurements, 'measurements'))
    // The example's columns are the example's: a confirmed offer from a
    // previous user file never describes them (the C screen's own drop rule
    // — the re-validation re-derives the offers for the current files).
    useTxrIntakeStore.setState({ joins: [], mapping: [] })
    return
  }
  const table = await fetchExampleTable('predict-measurements')
  useTxrIntakeStore.getState().adoptExampleFile('predictMeasurements', exampleLoadedFile(table, 'measurements'))
  useTxrIntakeStore.setState({ joins: [], mapping: [] })
  if (path === 'reuse') {
    const ready = await ensureExampleSet(hooks.onSetProgress, { cancelled: hooks.cancelled })
    useTxrIntakeStore.getState().setPendingExampleSet(ready.set_id ?? null)
  }
}
