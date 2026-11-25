/**
 * txrintake board copy + label tables — the ITEM-8 home (`lib/format.ts`),
 * created at ITEM-5 with the Screen-B surface the panel needs: the option
 * labels of the question groups, the panel count copy, the short
 * marker-group names for the descriptive sentence, and the fallback reason
 * line (CONS-UI-INTAKE-9's fallback). ITEM-8 completes the file with the
 * row-label builders (`pluralize` / `rowLabel`) and the remaining
 * TEST-INT-13 rows — the "151 patients" / "1,102 rows" count phrasing the
 * C/N status boxes render (the download helper lives in `lib/download.ts`,
 * its ITEM-6 home).
 *
 * The disease and treatment OPTION text is NOT a static table any more
 * (step2-filters): the answers are the method catalogue's `filter_options`
 * node ids, so the screen builds its options from the loaded vocabulary
 * (`data/useFilterOptions.ts`) — disease ids are the readable names, and
 * treatment labels come from `treatment_classes[].label`; before the
 * vocabulary loads, the id is the fallback.
 *
 * Copy rule DEC-13: every label is the board's own text (Criteria.dc.html,
 * Files.dc.html, PredictFiles.dc.html) VERBATIM, and every NUMBER the
 * boards show is a design example — never data. The heading/label builders
 * below format whatever the caller passes; no count is hardcoded anywhere
 * in this module.
 *
 * The marker-group SHORT names: the board's panel sentence uses the short
 * forms ("using ctDNA, counts and LDH") while the checkbox labels are the
 * full `MarkerGroup.display_name` values from PROV-MC-4. The short-name map
 * below is the module's own board-vocabulary table keyed by the provider's
 * group ids (the closed 7-group board set, CONS-UI-INTAKE-1); an id outside
 * the map renders as itself — never a guessed label.
 */
import type { OutcomeId, StudyAnswers } from '../types'
import type { TreatmentClass } from '@/api-client/types'

/** Screen B, "What you want to predict" — the four board pills, verbatim
 *  (the separate "Any" pill is `OUTCOME_ANY_LABEL`, never in this table). */
export const OUTCOME_OPTIONS: ReadonlyArray<{ value: OutcomeId; label: string }> = [
  { value: 'binary-response', label: 'Will the treatment work? (yes or no)' },
  { value: 'response-probability', label: 'Chance of response' },
  { value: 'progression-by-day', label: 'Risk of progression or death by a day' },
  { value: 'dynamic-risk', label: 'Risk over time as new draws arrive' },
]

/** The "Any" pill's label — the UNANSWERED outcome state (`study.outcome
 *  === null`), NOT an outcome id: it must never join `OUTCOME_OPTIONS`,
 *  whose values are the real outcome ids the method filters map. */
export const OUTCOME_ANY_LABEL = 'Any'

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

/**
 * The panel sentence's disease text. The disease answer IS a
 * `filter_options` node id, and those ids are already the readable names
 * ("colorectal cancer", "melanoma", "Solid tumours") — the label table the
 * board once carried is gone with the old option set, so the text is the id
 * itself, used lower-case as is.
 *
 * A CATEGORY id — the "Another disease in <category> (not listed)" answer,
 * whose value is the category id itself (the server reads it as the whole
 * category's scope) — reads "another disease in <category>": the category's
 * first letter lower-cased, the same mid-sentence rule as the treatment
 * labels. Before the vocabulary loads (or for an id outside it) the id is
 * the fallback too: never a guessed label, never a blank clause.
 */
export function diseaseClause(
  disease: string,
  categories: ReadonlyArray<{ id: string }>,
): string {
  if (categories.some(category => category.id === disease)) {
    return `another disease in ${lowerFirst(disease)}`
  }
  return disease
}

/** The panel sentence's outcome phrase — after "that predict": the four
 *  task phrasings ("that predict a yes or no response", "…the chance of
 *  response", "…the risk by a set day", "…risk over time"). */
export function outcomeClause(outcome: OutcomeId): string {
  switch (outcome) {
    case 'binary-response':
      return 'a yes or no response'
    case 'response-probability':
      return 'the chance of response'
    case 'progression-by-day':
      return 'the risk by a set day'
    case 'dynamic-risk':
      return 'risk over time'
  }
}

/**
 * The panel sentence's treatment clause: "given with chemotherapy or
 * immune checkpoint inhibitor" — each class's vocabulary `label`, its first
 * letter lower-cased (the labels are capitalised display text; the sentence
 * reads mid-sentence), the id as the fallback for a class the vocabulary
 * does not know (or before it loads) — never a guessed label. The list join
 * is the sentence's own: ", " with a final " or ".
 */
export function treatmentClause(
  treatments: ReadonlyArray<string>,
  treatmentClasses: ReadonlyArray<TreatmentClass>,
): string {
  const names = treatments.map(id => {
    const label = treatmentClasses.find(treatment => treatment.id === id)?.label
    return typeof label === 'string' && label.length > 0 ? lowerFirst(label) : id
  })
  return `given with ${joinList(names, 'or')}`
}

/**
 * The panel sentence's schedule clause: "with a draw before treatment,
 * 2 to 3 draws during treatment and the last draw on day 56" — the
 * ANSWERED parts only (an unanswered schedule question adds nothing, the
 * same rule the preview body carries, R3-intake-2), joined with ", " and a
 * final " and ". `null` when no schedule question is answered.
 */
export function scheduleClause(answers: StudyAnswers): string | null {
  const parts: string[] = []
  if (answers.beforeTreatment === 'always') parts.push('a draw before treatment')
  else if (answers.beforeTreatment === 'sometimes') {
    parts.push('a draw before treatment for some patients')
  }
  if (answers.drawsDuringTreatment === 1) parts.push('1 draw during treatment')
  else if (answers.drawsDuringTreatment === 2) parts.push('2 to 3 draws during treatment')
  else if (answers.drawsDuringTreatment === 4) {
    parts.push('4 or more draws during treatment')
  }
  if (answers.lastDrawDay !== null) parts.push(`the last draw on day ${answers.lastDrawDay}`)
  return parts.length === 0 ? null : `with ${joinList(parts, 'and')}`
}

/** "a, b and c" / "a, b or c" — the sentence's list join (no Oxford comma,
 *  board style); a single phrase renders as itself. */
function joinList(phrases: ReadonlyArray<string>, conjunction: 'and' | 'or'): string {
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} ${conjunction} ${phrases[phrases.length - 1]}`
}

/** The first letter lower-cased ("Immune checkpoint inhibitor" →
 *  "immune checkpoint inhibitor") — the mid-sentence rule for a leading
 *  capital from a display label; an empty string stays empty. */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1)
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
export function fitHeading(fit: Readonly<{ total: number; fit: number }>): string {
  return `${fit.fit} of ${fit.total} methods fit`
}

/** The excluded-list heading ("N methods are left out" — board copy; N is
 *  the ANSWER-caused count, R2-1 — the environment fact has its own line).
 *  The count is live and the grammar truthful: "1 method is left out"
 *  (R3-intake-1 — the old byte "1 methods are left out" held the wrong
 *  grammar and its count disagreed with the headline's). */
export function leftOutHeading(fit: Readonly<{ leftOut: number }>): string {
  return `${fit.leftOut} ${fit.leftOut === 1 ? 'method is' : 'methods are'} left out`
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

/** The one honest line when the filter-options vocabulary cannot be loaded
 *  (step2-filters, brief 5a3): the disease/treatment lists are gone, so the
 *  methods are not filtered by them. Plain words, NO raw error string, and
 *  shown ONCE — the old page repeated the same raw fetch message under
 *  both the Disease and the Treatment control. */
export const FILTER_OPTIONS_UNAVAILABLE_LINE =
  'The disease and treatment lists could not be loaded. The methods are not filtered by them.'

/** The B panel's MAXIMUM directly-visible excluded rows (the board's 250px clip ≈ 6 rows). */
export const EXCLUDED_LIST_LIMIT = 6

/**
 * The treatment question's hint (step2-filters, brief 5b): the ONE line under
 * the multi-tick list — the board's own plain words, never a design promise
 * about combo counts.
 */
export const TREATMENT_MULTI_HINT =
  'A combination is several ticks. Tick none to keep every treatment.'

/**
 * One grouped left-out section's heading (step2-filters, brief 5b / round
 * 2b): the excluded methods are grouped by their first reason's code — the
 * three answer-caused codes get their own section, the marker-count rule's
 * "needs more markers" section, every other code one section with "do not
 * fit" — the count is live, and the singular forms are the section's own
 * ("1 made for another disease", "1 predicts something else", "1 needs more
 * markers than your file has", "1 does not fit your files or answers").
 * `code` is the raw reason code (or the grouping key's `'other'`); the
 * mapping is the board's own words.
 */
export function excludedSectionHeading(code: string, count: number): string {
  switch (code) {
    case 'DISEASE_NOT_MATCHED':
      return count === 1 ? '1 made for another disease' : `${count} made for another disease`
    case 'TREATMENT_NOT_MATCHED':
      return `${count} made for other treatments`
    case 'OUTCOME_NOT_MATCHED':
      return count === 1 ? '1 predicts something else' : `${count} predict something else`
    case 'MARKER_COUNT_UNMET':
      return count === 1
        ? '1 needs more markers than your file has'
        : `${count} need more markers than your file has`
    default:
      return count === 1
        ? '1 does not fit your files or answers'
        : `${count} do not fit your files or answers`
  }
}

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
