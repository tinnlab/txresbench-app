/**
 * The Extra-inputs line facts of screen E (ITEM-7, PROV-UI-RUN-4), plus the
 * switch's auto-on / untick decisions (any-outcome-and-covariates part 2).
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
 *
 * AOC part 2 (the user's option A): the eligibility request carries the
 * file's extra-input column names whenever the file has them (availability
 * `present`), whatever the switch says — the switch then only decides
 * whether the run uses them. A `required` method is therefore TICKABLE with
 * the switch off. When the screen CANNOT say yet (`unknown` — no resolved
 * inspection), the request follows the switch again (the names when it is
 * on, `[]` when off — the pre-option-A rule); `absent` keeps `[]` (the
 * required methods are cannot-run, as before). The decisions below are the
 * switch's two automatic steps, as PURE functions:
 *
 * - auto-on: a ticked runnable method whose catalogue mode is `required`,
 *   with the switch off and the file's columns present, turns the switch
 *   on by itself and says so in one plain line;
 * - untick-on-manual-off: a manual switch-off with required methods ticked
 *   unticks them and says so in one plain line (the switch stays off — the
 *   auto-on fires only when a required method BECOMES ticked while the
 *   switch is off, never right after the person switched it off).
 *
 * Optional or none methods never trigger either step.
 */
import type { FileInspection } from '@/api-client/types'
import { reasonGroups, runnableCards } from '@/modules/txrlist/lib/methodPicker'
import type { TxrMethodCard } from '@/modules/txrlist/types'

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

/**
 * The Extra-inputs help line once the method list is known (the step-4
 * fix: the switch often changes nothing in the list, and the line says
 * why). It counts the methods that can run and take extra inputs (required
 * or optional: the card's `needs.covariates`), and the can't-run methods
 * held back by extra inputs (their first reason is in the "Needs
 * covariates" group, e.g. the switch is off and the method requires them).
 * `null` before there is any method to count (the caller keeps the general
 * help).
 *
 * - "Used by 1 of the 5 methods that can run."
 * - "None of the methods that can run use them."
 * - either, then " 2 more need them to run."
 */
export function covariatesUseLine(cards: ReadonlyArray<TxrMethodCard>): string | null {
  const runnable = runnableCards(cards)
  const held = reasonGroups(cards).find(group => group.key === 'covariates')?.count ?? 0
  if (runnable.length === 0 && held === 0) return null
  const users = runnable.filter(card => card.needs.covariates !== null).length
  const base =
    users === 0
      ? 'None of the methods that can run use them.'
      : runnable.length === 1
        ? 'Used by the one method that can run.'
        : `Used by ${users} of the ${runnable.length} methods that can run.`
  if (held === 0) return base
  return `${base} ${held} more ${held === 1 ? 'needs' : 'need'} them to run.`
}

// ── the switch's two automatic steps (AOC part 2) ────────────────────────────

/**
 * The ticked, RUNNABLE cards whose catalogue mode is `required` (they take
 * extra inputs and cannot run without them). A `cannot` card is never in a
 * real selection, and is excluded here all the same. The auto-on and the
 * untick-on-manual-off decisions both read this set.
 */
export function requiredTickedCards(
  cards: ReadonlyArray<TxrMethodCard>,
  selected: ReadonlySet<string>,
): TxrMethodCard[] {
  return runnableCards(cards).filter(
    card => selected.has(card.key) && card.needs.covariatesMode === 'required',
  )
}

/**
 * The ONE plain line of the auto-on step for the given required cards
 * (`required.length` is the text's own fact: one method names its title,
 * several say how many of the chosen methods need them). `null` for none.
 * The DECISION (switch off, file present, required ticked) is the caller's
 * (`covariatesAutoOnLine`); this builder is also used to follow the line
 * while the switch stays on (a required method added or removed).
 */
export function covariatesAutoOnText(required: ReadonlyArray<TxrMethodCard>): string | null {
  if (required.length === 0) return null
  if (required.length === 1) return `Turned on because ${required[0].title} needs them.`
  return `Turned on because ${required.length} of the chosen methods need them.`
}

/**
 * The auto-on decision: the ONE plain line the switch shows when it turns
 * itself on, or `null` when auto-on does not apply (the switch is already
 * on, the file's extra-input columns are not known to be there — `absent`
 * means a required method cannot run, `unknown` means the screen cannot
 * say — or no ticked runnable method requires them).
 *
 * - one required method: "Turned on because {method title} needs them."
 * - several:             "Turned on because {n} of the chosen methods need them."
 */
export function covariatesAutoOnLine(
  cards: ReadonlyArray<TxrMethodCard>,
  selected: ReadonlySet<string>,
  availability: TxrSettingsCovariates['availability'],
  switchOn: boolean,
): string | null {
  if (switchOn) return null
  if (availability !== 'present') return null
  return covariatesAutoOnText(requiredTickedCards(cards, selected))
}

/**
 * The ONE plain line of the untick-on-manual-off step for the required
 * cards that were just unticked (`null` for none — nothing was unticked).
 */
export function covariatesUntickText(required: ReadonlyArray<TxrMethodCard>): string | null {
  if (required.length === 0) return null
  if (required.length === 1) return `${required[0].title} was unticked: it needs extra inputs.`
  return `${required.length} methods were unticked: they need extra inputs.`
}

/**
 * The untick-on-manual-off decision: the ONE plain line the switch shows
 * when a manual switch-off unticked the required methods, or `null` when
 * no ticked runnable method requires them (nothing is unticked).
 *
 * - one: "{method title} was unticked: it needs extra inputs."
 * - several: "{n} methods were unticked: they need extra inputs."
 */
export function covariatesUntickLine(
  cards: ReadonlyArray<TxrMethodCard>,
  selected: ReadonlySet<string>,
): string | null {
  return covariatesUntickText(requiredTickedCards(cards, selected))
}
