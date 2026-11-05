/**
 * txrintake — the intake state contract (PROV-UI-INTAKE-2).
 *
 * What the user builds across screens A (Start), B (Your study), C (Your
 * files) and N (Add the patients to predict) is ONE snapshot
 * (`IntakeSnapshot`), held in the module's lazy store
 * (`stores/TxrIntake.store.ts` — the store ships with its own item and owns
 * the actions + the `buildTxrRunInput` builder). This file declares the
 * types alone; the later screens read the same snapshot through the barrel
 * (`index.ts`): ui-run's screen E (choose methods and settings), ui-models'
 * screens D and I (pretrained / saved models). No other module re-derives
 * the intake state, and no screen rebuilds what the user already answered
 * or dropped.
 *
 * Wire shapes are the provider contracts, never module copies:
 *
 * - the decoded files are PROV-FV-7's `ParsedTable` /
 *   `ParsedTableSource` (`@/lib/txr-files` — ONE browser decode library,
 *   consumed, never re-implemented; `LoadedFile.source` is that library's
 *   shape, so the format union `'csv' | 'excel'` has one source of truth);
 * - the inspect/validate results, the confirmed marker mapping and the
 *   vocabulary matches are the generated `@/api-client/types`
 *   (`FileInspection`, `FileProblem`, `ValidationResponse`, `MarkerMapping`,
 *   `MarkerMatch`) — provider-owned output; this module never regenerates
 *   it and never vendors a copy.
 *
 * Board copy rule (DEC-13): the board's example counts are design
 * examples, never data. The snapshot carries STRUCTURED fields only; every
 * count the screens show is computed from these fields (or from the live
 * provider response), never hardcoded.
 *
 * Persistence (DEC-4 / OWNER-6): the SMALL fields survive a reload through
 * the store's persist partialize (`intent`, `mode`, `study`, file names +
 * prepared flags, `joins`, `mapping`, `parameters`). The `ParsedTable`
 * payloads, `FileInspection` and `ValidationResponse` bodies are memory
 * only — a reload shows the file cards' "name, choose the file again"
 * state, and the user re-drops the files (the engine's run creation is the
 * app's real durability point, PROV-EE-2).
 */

/** The decoded table a file card holds (PROV-FV-7). */
import type { ParsedTable, ParsedTableSource } from '@/lib/txr-files/types'
import type {
  FileInspection,
  FileProblem,
  MarkerMapping,
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'

/**
 * The A-card intent (screen A, the three path cards of FLOW.md):
 *
 * - `'pretrained'` — Path 1: pretrained models on the patient's file;
 * - `'train'`      — Path 2: learn from my data (study + files + methods);
 * - `'reuse'`      — Path 3: saved models on a new file.
 *
 * The intent sets the snapshot's `mode`: pretrained/reuse =
 * `'predict'` (screen N feeds it), train = `'study'` (screen B + C feed it).
 */
export type IntakeIntent = 'pretrained' | 'train' | 'reuse'

/** Screen B, "which disease" — the first question group's option set. */
export type DiseaseId = 'colorectal' | 'lung' | 'breast' | 'prostate' | 'other'

/** Screen B, "which treatment" — the second question group's option set. */
export type TreatmentId =
  | 'immunotherapy'
  | 'chemotherapy'
  | 'targeted'
  | 'radiotherapy'
  | 'other-mixed'

/**
 * Screen B, "what to predict" — the four outcome pills. `'progression-by-day'`
 * is the survival task (a risk by a day); `'binary-response'` and
 * `'response-probability'` are the response task; `'dynamic-risk'` is the
 * risk-over-time task. Stored and shown in the panel's descriptive line
 * (DEC-6 / OWNER-3): the preview endpoint carries no outcome field today,
 * so the value is display-only at B and the fit count is outcome-blind.
 */
export type OutcomeId =
  | 'binary-response'
  | 'response-probability'
  | 'progression-by-day'
  | 'dynamic-risk'

/**
 * The six screen-B answer groups (the board's question groups, one field
 * each). Every field starts `null` — the user may skip B entirely, and the
 * panel renders from whatever is answered (empty answers still fire the
 * preview with the provider's defaults, DEC-5).
 *
 * - `markerGroups` — checked marker-group ids → `true`; every group id is
 *   a key (unchecked = `false`), from `GET /api/markers` (PROV-MC-4).
 *   `null` = nothing answered yet (no box checked, no request made).
 * - `drawsDuringTreatment` — the board's "2 to 3" answers collapse onto the
 *   provider's `draws_during_treatment: 1 | 2 | 4` code.
 * - `lastDrawDay` — the last draw the user will use; it IS the engine's
 *   `decision_day` contract value (one value, three uses: the B panel, the
 *   C/N validation `parameters.decision_day`, the E run default).
 */
export interface StudyAnswers {
  disease: DiseaseId | null
  treatment: TreatmentId | null
  outcome: OutcomeId | null
  markerGroups: Record<string, boolean> | null
  beforeTreatment: 'always' | 'sometimes' | null
  drawsDuringTreatment: 1 | 2 | 4 | null
  lastDrawDay: 28 | 42 | 56 | 84 | null
}

/**
 * One adopted file (screen C's patients or measurements card, screen N's
 * measurements card, and ui-run's E-screen "Change files" slots — one card
 * surface, three mounts). The byte decode is `table`; every later fact is
 * the validator's response, never re-derived:
 *
 * - `inspection` — `POST /api/file-validation/inspect` (PROV-FV-2): the
 *   resolved roles, the column table and the file's own problems. `null`
 *   until the drop's inspection resolves; a failed inspect keeps the file
 *   with `inspection: null` and the card error text separate.
 * - `problems` — the CURRENT full problem set for the card (inspect's own
 *   problems first, then the validate pass's, then the cross-file ones);
 *   the card's "N problems in N rows" box and the per-row list render from
 *   here, and Continue is gated on `severity: 'error'` (DEC-10).
 * - `prepared` — the validator marked the file ready (no error problems);
 *   the card's green "N rows read" state.
 * - `joinOffers` / `vocabOffers` — the pending offers derived from
 *   `validate` (spelling joins from `spellings.length > 1`; fuzzy
 *   vocabulary matches). None is ever auto-applied (PROV-FV-5/7's own rule
 *   — suggestions only): the user confirms, the card re-validates.
 */
export interface LoadedFile {
  source: ParsedTableSource
  table: ParsedTable
  inspection: FileInspection | null
  problems: FileProblem[]
  prepared: boolean
  joinOffers: JoinOffer[]
  vocabOffers: VocabOffer[]
}

/**
 * A confirmed spelling join: the measurement column `key` carries every
 * spelling in `variants` (the A03 group, e.g. `ldh` + `LDH`) and must be
 * treated as ONE marker column. The shape is the engine's `TxrJoin`
 * (`CreateRunRequest.input.joins` — PASSED THROUGH by `buildTxrRunInput`,
 * which is where the structural equality is enforced at compile time).
 */
export interface JoinOffer {
  variants: string[]
  key: string
}

/**
 * A confirmed vocabulary mapping for one file column: `key` is the column
 * key, `match` is the vocabulary candidate the user approved.
 *
 * `accepted` is the user's answer on THIS offer (`true` = the mapping is
 * confirmed, `false`/`null` = still open or declined; "not this one" leaves
 * the key UNMAPPED — the column still counts for marker-agnostic methods).
 * A `'fuzzy'` match is never mapped without the confirmation.
 */
export interface VocabOffer {
  key: string
  match: MarkerMatch
  accepted: boolean | null
}

/**
 * The full intake state, as the later screens read it (PROV-UI-INTAKE-2).
 *
 * - `patients` / `measurements` — the screen-C files (mode `'study'`);
 * - `predictMeasurements` — the screen-N measurements-only file (mode
 *   `'predict'`, the file the pretrained/saved models run on);
 * - `joins` / `mapping` — the CONFIRMED offers only (the store moves an
 *   offer from `LoadedFile.*Offers` into these lists when the user accepts
 *   it — the two lists are the validator request's `joins`/`mapping`
 *   passthrough, CONS-UI-INTAKE-5);
 * - `parameters` — `decision_day` (= the study answer's `lastDrawDay`,
 *   DEC-5's single value) and `baseline_max_day` (fixed `0`: baseline =
 *   day <= baseline_max_day, the contract rule);
 * - `validation` — the ONE `ValidationResponse` of the LAST successful
 *   validate against the current files/joins/mapping/parameters, `null`
 *   before a validated state and after ANY mutation of those inputs (and
 *   never persisted — a reload gives `null`). ui-run and ui-models read
 *   `validation.inventory` as the single eligibility object, so no sibling
 *   module re-posts or re-derives it.
 */
export interface IntakeSnapshot {
  intent: IntakeIntent
  mode: 'study' | 'predict'
  study: StudyAnswers
  patients: LoadedFile | null
  measurements: LoadedFile | null
  predictMeasurements: LoadedFile | null
  joins: JoinOffer[]
  mapping: MarkerMapping[]
  parameters: {
    decision_day: number
    baseline_max_day: number
  }
  validation: ValidationResponse | null
}
