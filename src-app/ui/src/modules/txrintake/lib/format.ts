/**
 * txrintake board copy + label tables — the ITEM-8 home (`lib/format.ts`),
 * created at ITEM-5 with the Screen-B surface the panel needs: the option
 * labels of the six question groups, the panel count copy, the short
 * marker-group names for the descriptive sentence, and the fallback reason
 * line (CONS-UI-INTAKE-9's fallback). ITEM-8 completes the file with the
 * row-label builders (`pluralize` / `rowLabel`) and the remaining
 * TEST-INT-13 rows — the "151 patients" / "1,102 rows" count phrasing the
 * C/N status boxes render (the download helper lives in `lib/download.ts`,
 * its ITEM-6 home).
 *
 * Copy rule DEC-13: every label is the board's own text (Criteria.dc.html,
 * Files.dc.html, PredictFiles.dc.html) VERBATIM, and every NUMBER the
 * boards show is a design example — never data. The heading/label builders
 * below format whatever the caller passes; no count is hardcoded anywhere
 * in this module.
 *
 * The marker-group SHORT names: the board's panel sentence uses the short
 * forms ("with ctDNA, counts and LDH") while the checkbox labels are the
 * full `MarkerGroup.display_name` values from PROV-MC-4. The short-name map
 * below is the module's own board-vocabulary table keyed by the provider's
 * group ids (the closed 7-group board set, CONS-UI-INTAKE-1); an id outside
 * the map renders as itself — never a guessed label.
 */
import type { DiseaseId, OutcomeId, StudyAnswers, TreatmentId } from '../types'

/** Screen B, "Which disease" — board option text (Criteria.dc.html). */
export const DISEASE_OPTIONS: ReadonlyArray<{ value: DiseaseId; label: string }> = [
  { value: 'colorectal', label: 'Colorectal cancer' },
  { value: 'lung', label: 'Lung cancer' },
  { value: 'breast', label: 'Breast cancer' },
  { value: 'prostate', label: 'Prostate cancer' },
  { value: 'other', label: 'Other or not listed' },
]

/** Screen B, "Which treatment" — board option text. */
export const TREATMENT_OPTIONS: ReadonlyArray<{ value: TreatmentId; label: string }> = [
  { value: 'immunotherapy', label: 'Immunotherapy' },
  { value: 'chemotherapy', label: 'Chemotherapy' },
  { value: 'targeted', label: 'Targeted therapy' },
  { value: 'radiotherapy', label: 'Radiotherapy' },
  { value: 'other-mixed', label: 'Other or mixed' },
]

/** Screen B, "What you want to predict" — the four board pills, verbatim. */
export const OUTCOME_OPTIONS: ReadonlyArray<{ value: OutcomeId; label: string }> = [
  { value: 'binary-response', label: 'Will the treatment work? (yes or no)' },
  { value: 'response-probability', label: 'Chance of response' },
  { value: 'progression-by-day', label: 'Risk of progression or death by a day' },
  { value: 'dynamic-risk', label: 'Risk over time as new draws arrive' },
]

/** Screen B, "Before treatment" — board option text. */
export const BEFORE_TREATMENT_OPTIONS: ReadonlyArray<{ value: 'always' | 'sometimes'; label: string }> =
  [
    { value: 'always', label: 'Always' },
    { value: 'sometimes', label: 'Sometimes' },
  ]

/** Screen B, "Draws during treatment" — the board's three answers (code → text). */
export const DRAWS_OPTIONS: ReadonlyArray<{ value: 1 | 2 | 4; label: string }> = [
  { value: 1, label: '1' },
  { value: 2, label: '2 to 3' },
  { value: 4, label: '4 or more' },
]

/** Screen B, "Last draw you will use" — the four board days (DEC-5 values). */
export const LAST_DRAW_OPTIONS: ReadonlyArray<{ value: 28 | 42 | 56 | 84; label: string }> = [
  { value: 28, label: 'Day 28' },
  { value: 42, label: 'Day 42' },
  { value: 56, label: 'Day 56' },
  { value: 84, label: 'Day 84' },
]

/** The panel sentence's short disease clause (lower-case, board phrasing). */
export function diseaseClause(disease: DiseaseId): string {
  switch (disease) {
    case 'colorectal':
      return 'colorectal cancer'
    case 'lung':
      return 'lung cancer'
    case 'breast':
      return 'breast cancer'
    case 'prostate':
      return 'prostate cancer'
    case 'other':
      return 'another disease'
  }
}

/** The panel sentence's short outcome clause (the four task phrasings). */
export function outcomeClause(outcome: OutcomeId): string {
  switch (outcome) {
    case 'binary-response':
      return 'will the treatment work'
    case 'response-probability':
      return 'the chance of response'
    case 'progression-by-day':
      return 'risk by a day'
    case 'dynamic-risk':
      return 'risk over time'
  }
}

/**
 * The board's SHORT group name for the panel sentence ("ctDNA", "blood
 * counts", "LDH" — Criteria.dc.html's "with ctDNA, counts and LDH"; the
 * plan's pinned sentence uses the group's full short form "blood counts").
 */
export function groupShortName(groupId: string): string {
  switch (groupId) {
    case 'ctdna':
      return 'ctDNA'
    case 'counts':
      return 'blood counts'
    case 'ldh':
      return 'LDH'
    case 'tumour-markers':
      return 'tumour markers'
    case 'inflammation':
      return 'inflammation markers'
    case 'methylation-sequencing':
      return 'methylation'
    case 'other':
      return 'other markers'
    default:
      return groupId
  }
}

/** The panel headline ("N of M methods fit" — the board's example count is data). */
export function fitHeading(fit: Readonly<{ total: number; canRun: number }>): string {
  return `${fit.canRun} of ${fit.total} methods fit`
}

/** The excluded-list heading ("N methods are left out" — board copy). */
export function leftOutHeading(fit: Readonly<{ cannot: number }>): string {
  return `${fit.cannot} methods are left out`
}

/**
 * The panel line for the can-run-for-some subset — shown only when the
 * provider reports any (the board's headline + left-out count do not
 * account for them; silence would be a lie by omission). The status wording
 * is the shared E-screen board phrase ("Can run for some patients"), the
 * count is live.
 */
export function someFitLine(fit: Readonly<{ some: number }>): string {
  return `${fit.some} can run for some patients`
}

/**
 * The module's own fallback reason line for the B panel (CONS-UI-INTAKE-9):
 * an absent/unknown reason code, or a code whose shared E-row template
 * reads per-patient facts the preview cannot provide, renders this constant
 * — the plan's named string, never a blank line and never the E-row's
 * file-phrased fallback (screen B has no file).
 */
export const PREVIEW_REASON_FALLBACK = "doesn't fit with these answers"

/** The B panel's MAXIMUM directly-visible excluded rows (the board's 250px clip ≈ 6 rows). */
export const EXCLUDED_LIST_LIMIT = 6

/**
 * The board's thousands grouping — "1,102 rows" (PredictFiles.dc.html).
 * The grouping is fixed to the board's `1,102` bytes, never the host's
 * locale: a box in a comma-decimal locale must render the same string.
 */
export function groupNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * A count phrase — "151 patients", "1 patient" (`pluralize(151,
 * 'patient')`). The singular is the `count === 1` case; every other count
 * takes the `s` form (the C/N boxes' counts are file facts — "patients
 * read", "rows" — never design examples).
 */
export function pluralize(count: number, noun: string): string {
  return `${groupNumber(count)} ${count === 1 ? noun : `${noun}s`}`
}

/**
 * The row-count phrasing of the C/N status boxes — `rowLabel(1102)` →
 * "1,102 rows" (PredictFiles.dc.html's "Found 1,102 rows"), `rowLabel(1)`
 * → "1 row".
 */
export function rowLabel(rows: number): string {
  return pluralize(rows, 'row')
}
