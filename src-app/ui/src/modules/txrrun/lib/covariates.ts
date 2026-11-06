/**
 * The Extra-inputs line facts of screen E (ITEM-7, PROV-UI-RUN-4).
 *
 * The "Extra inputs" row of `Busy.dc.html` shows the covariate names its
 * files carry ("age, sex, stage") beside the switch that turns the
 * covariates on. The names are DATA — the file's own resolved columns — so
 * this builder maps the ONE inspection that owns them (the patients
 * table's `FileInspection.columns.covariate_columns`, PROV-FV-2) into the
 * component's fact shape; the screen never re-derives a covariate from raw
 * columns and never hardcodes a name (the board's "age, sex, stage" is a
 * design example of the line, never a constant — INV-6).
 *
 * The availability answers "can the screen say what the covariates are
 * yet?":
 *
 * - `present` — the file was inspected and carries the named columns;
 * - `absent` — the file was inspected and carries no covariate column
 *   (the methods that REQUIRE extra inputs will be `cannot_run` — the
 *   eligibility engine's own verdict, never this screen's);
 * - `unknown` — the file has no resolved inspection (an inspect that
 *   failed, or a re-adopted file the validator has not re-read): the line
 *   cannot be stated, and the screen shows the pending mark, never a
 *   stale or guessed name.
 *
 * The `null` case is the caller's: an E render without a patients file
 * (the predict-mode snapshot on this route) has no covariate source at
 * all, and the row renders the switch alone.
 */
import type { FileInspection } from '@/api-client/types'

/** The Extra-inputs row's one fact (PROV-UI-RUN-4's `covariates` prop). */
export interface TxrSettingsCovariates {
  /** The file's resolved covariate column names, in file order. */
  names: string[]
  availability: 'present' | 'absent' | 'unknown'
}

/**
 * The patients file's inspection → the row's fact. `null` inspection is
 * `unknown` (nothing resolved yet), never a guess.
 */
export function buildCovariates(inspection: FileInspection | null): TxrSettingsCovariates {
  if (inspection === null) return { names: [], availability: 'unknown' }
  const names = inspection.columns.covariate_columns.map(column => column.name)
  return { names, availability: names.length === 0 ? 'absent' : 'present' }
}
