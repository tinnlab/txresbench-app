/**
 * txrlist — the shared model/method selection list contract.
 *
 * Screens E (`Busy.dc.html`), D (`Pretrained.dc.html`) and I
 * (`Saved.dc.html`) are ONE list component with different rows and host
 * chrome (FLOW.md). The list component renders the normalized shapes below;
 * the HOST screen owns the data (method-catalogue for E, model cards for
 * D/I) and the selection state (it needs the selection to compute the
 * time estimate and to hand the run to the engine). This contract is the
 * only data coupling between the component and the two host screens.
 *
 * Board copy rule (DEC-12): every user-facing string is spelled verbatim in
 * the boards; the row carries structured fields and the display text is
 * produced from them by `lib/format.ts`.
 */

/**
 * Can the method/model run on the host's uploaded file?
 *
 * - `'can'`    — for every eligible patient;
 * - `'some'`   — for a subset of patients (the coverage line explains which);
 * - `'cannot'` — not at all (the reason line says why, the checkbox is
 *   disabled).
 *
 * The board headlines are "Can run" / "Can run for some patients" /
 * "Cannot run" (DEC-12); `formatRunHeadline` produces the string from this
 * code.
 */
export type TxrRunStatus = 'can' | 'some' | 'cannot'

/**
 * The two board chip palettes (DEC-8):
 *
 * - `'neutral'` — `var(--txr-success-soft)` chip / `var(--txr-success-ink)` text: the method group chips
 *   (e.g. "Response probability") on screen E;
 * - `'accent'`  — `var(--txr-accent-soft)` chip / `var(--txr-brand-ink)` text: the Published /
 *   Learned here / Trained by you chips on screens D and I.
 */
export type TxrListChipTone = 'neutral' | 'accent'

/**
 * One selectable row — a method on screen E, a model on screens D and I.
 *
 * The host builds rows from its own data and passes them pre-filtered; the
 * list component only renders and reports the selection (`selected` +
 * `onSelectionChange`). Field semantics:
 *
 * - `key` — the stable row identity in the list, the checkbox test-id and
 *   the selection-set member. Unique within one list instance.
 * - `name` — the method id (monospace on the board) or the model name.
 * - `tag` — the small secondary line: "Paper <year>, <language>" for
 *   methods, the model provenance line for models.
 * - `chip` — the group / model-kind chip, or `null` for no chip.
 * - `performanceText` — the performance fact ("other cohorts: AUC 0.64"),
 *   or `null` for no performance column (screen E via the summary's
 *   performance fact; screens D/I from the model cards).
 * - `run` — the eligibility verdict on the uploaded file: the board
 *   headline, the "what is missing / per-patient coverage" detail line,
 *   and the derived `disabled` flag (`status === 'cannot'`). `disabled`
 *   rows are never selectable and never counted.
 * - `timeText` — the per-row time estimate (from the eligibility
 *   response's `estimated_seconds`), or `null` for no time entry.
 * - `action` — the row action slot ("About" on E, "Model card" on D,
 *   "Details" on I). The host wires the click through `onRowAction`; the
 *   dialogs are the hosts'.
 */
export interface TxrListRow {
  key: string
  name: string
  tag: string
  chip: { label: string; tone: TxrListChipTone } | null
  performanceText: string | null
  run: {
    status: TxrRunStatus
    headline: string
    detail: string
    disabled: boolean
  }
  timeText: string | null
  action: { label: string } | null
}

/**
 * One screen-I run group: the models trained by one run, with the run's
 * facts as the section subtitle ("trained 19 Oct on patients.csv · 151
 * patients · 11 models · progression or death by day 238" — the board's
 * run-facts line).
 *
 * The section header renders title + subtitle + a select-all for exactly
 * the section's non-disabled `rowKeys` + the host's `actions` (Rename with
 * tone `'default'`, "Delete the run's models" with tone `'danger'`); the
 * actions' effects are the host's (`model-store` owns rename/delete).
 */
export interface TxrListSection {
  key: string
  title: string
  subtitle: string
  rowKeys: string[]
  actions: { id: string; label: string; tone: 'default' | 'danger' }[]
}

/**
 * A host-controlled filter chip (group chips on E, model-kind chips on D,
 * outcome-match chips on I), rendered beside the built-in "All N" and
 * "Can run N" count chips. The chip is host-controlled state: the host
 * passes pre-filtered `rows` and the filter predicate through `onToggle`.
 */
export interface TxrFilterChip {
  id: string
  label: string
  count: number
  active: boolean
  onToggle(): void
}

/**
 * The host-controlled sort control (screens D and I only). Changing the
 * value re-sorts the host's row/section order — the component does not
 * sort.
 */
export interface TxrSortControl {
  value: string
  options: { value: string; label: string }[]
  onChange(v: string): void
}

/**
 * The host-controlled search control (screen I's find-a-model box).
 * Changing the value filters the host's rows by the host's own rule.
 */
export interface TxrSearchControl {
  value: string
  onChange(v: string): void
}
