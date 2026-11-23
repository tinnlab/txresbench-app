/**
 * txrmodels row builders — PROV-UI-MODELS-4 (ITEM-4).
 *
 * `buildPretrainedRows` (screen D) and `buildSavedRows` / `buildSavedSections`
 * (screen I) are the pure joins the two choice screens are fed from: the
 * provider list payloads (the pretrained catalogue cards,
 * `PretrainedSummary[]`; the saved-model summaries, `ModelSummary[]`, plus
 * the set rows, `SetSummary[]`) × the eligibility verdicts (`PROV-PC-8` /
 * `PROV-MS-9`) → the shared list contract's rows (`txrlist`'s
 * `TxrListRow` / `TxrListSection` — PROV-UI-LIST-2). The screen hosts never
 * join the wire shapes themselves; the build is here, once, pure.
 *
 * Rules that shape the joins:
 *
 * - the D LIST row's name is the catalogue slug with the board's "· day N"
 *   suffix (Pretrained.dc.html — `id` is the mono id, `decision_day` the
 *   day the board reads); the I row's name is the model's own display
 *   label (`ModelSummary.name` — the catalogue label at save, renamed by
 *   the J screen's Rename; the boards' mono ids are that default);
 * - the D row's tag is the card's one-line description, its chip the
 *   Published / Learned here pill (tone neutral for a published rule,
 *   accent for a benchmark-trained model — PROV-UI-LIST-1's two palettes);
 *   the I row's tag is the DEC-13 subtitle ("decision day N" / "before
 *   treatment only"), its chip the provenance pill (Trained by you, accent;
 *   Imported, neutral; Pretrained, accent);
 * - the performance column is board copy from the structured facts only:
 *   "other cohorts: AUC <2dp>" / "not yet checked elsewhere" (D,
 *   `transfer`), "own data, cross-checked: AUC <2dp>" / "not yet
 *   cross-checked" (I, `own_auc`);
 * - the run verdict is the eligibility payload's status mapped to the
 *   three board codes, the detail line built by `txrlist`'s
 *   `formatReasonLine` from the STRUCTURED fields (reasons, coverage,
 *   min_draws, missing_markers) — first reason, else the coverage line
 *   (the E-row precedent); `disabled` is `status === 'cannot'`;
 * - a card/model the eligibility response does not know is a defensive
 *   fallback row — `cannot`, the `NOT_RUNNABLE` reason line, no time — so
 *   a row never silently vanishes (the reconcile asserts count parity);
 *   an eligibility entry with no source row is dropped (the catalogue /
 *   saved list is the row source);
 * - the sort/filter layer (`lib/filters.ts`) never touches these shapes:
 *   it reads the same structured facts through the row builders' keys.
 */
import type {
  Coverage,
  EligibilityStatus,
  MinDraws,
  ModelEligibilityResponse,
  ModelSummary,
  PretrainedEligibilityResponse,
  PretrainedSummary,
  PretrainedTransferSummary,
  SetSummary,
} from '@/api-client/types'
import {
  formatCoverage,
  formatDurationShort,
  formatReasonLine,
  formatRunHeadline,
  type TxrListRow,
  type TxrListSection,
  type TxrReasonCode,
  type TxrRunStatus,
} from '@/modules/txrlist'
import { formatPredicts, formatTrainedDateShort, UNRECORDED } from './format'
import { DEMO_PRETRAINED_CHIP } from '@/modules/demo/copy'

/** The provider's three verdict codes → the three board status codes. */
function toRunStatus(status: EligibilityStatus): TxrRunStatus {
  switch (status) {
    case 'can_run':
      return 'can'
    case 'can_run_some':
      return 'some'
    case 'cannot_run':
      return 'cannot'
  }
}

/** The shared run-verdict assembly: status + headline + the one detail
 *  line (first reason's board line, else the coverage line) + disabled. */
function runFacts(
  status: TxrRunStatus,
  reasons: ReadonlyArray<{ code: TxrReasonCode }>,
  coverage: Coverage,
  minDraws: MinDraws,
  missingMarkers: ReadonlyArray<{ display_name?: string; id?: string }>,
): { status: TxrRunStatus; headline: string; detail: string; disabled: boolean } {
  const headline = formatRunHeadline(status)
  return {
    status,
    headline,
    detail:
      reasons.length > 0
        ? formatReasonLine(status, reasons, coverage, minDraws, missingMarkers)
        : formatCoverage(coverage),
    disabled: status === 'cannot',
  }
}

/** The D performance entry: the board's transfer copy, or the "not yet
 *  checked elsewhere" constant for a catalogue entry with no transfer
 *  facts. The metric word is the provider's own vocabulary: a rule's
 *  `auc_rule` reads AUC, a `c_index` the c-index (the board's AUC rows are
 *  the same column with the other metric's word). */
function transferText(transfer: PretrainedTransferSummary | null | undefined): string {
  if (transfer === null || transfer === undefined) return 'not yet checked elsewhere'
  const metric = transfer.metric === 'auc_rule' ? 'AUC' : 'c-index'
  return `other cohorts: ${metric} ${transfer.median.toFixed(2)}`
}

/** The I performance entry: the cross-checked own-data AUC, else "not yet
 *  cross-checked" (a model the engine has not scored on the current file). */
function ownAucText(ownAuc: number | null | undefined): string {
  if (ownAuc === null || ownAuc === undefined || !Number.isFinite(ownAuc)) {
    return 'not yet cross-checked'
  }
  return `own data, cross-checked: AUC ${ownAuc.toFixed(2)}`
}

/**
 * The DEC-13 row subtitle: `marker_facts.needs_baseline === true` → "before
 * treatment only" (Saved.dc.html's `baseline-cox-cumulative-hazard` row),
 * else `decision day <N>`. The summary row does not carry the
 * `marker_facts` block today (it is a `ModelDetail` fact and the store's
 * GAP surface), so the read is a DEFENSIVE optional read — a grown
 * response flips the baseline rows to the board's words, a not-yet-grown
 * one degrades to the day rule (the model-store DEC-18 drift-guard
 * pattern, the same posture the J table's `marker_count` read uses).
 * `decision_day` is the contract's f64 — spelled without trailing zeros
 * (the day picker sends whole days; the number renders as given).
 */
function savedSubtitle(model: ModelSummary): string {
  const grown = model as ModelSummary & {
    marker_facts?: { needs_baseline?: boolean } | null
  }
  if (grown.marker_facts?.needs_baseline === true) return 'before treatment only'
  return `decision day ${model.decision_day}`
}

/**
 * The screen-D join: catalogue cards × pretrained eligibility verdicts →
 * `TxrListRow[]`, one row per card in catalogue order (the list order is
 * the catalogue's). In demo mode (`demo: true` — the audit's ITEM-7 row)
 * the chip reads "Included in the demo": the card is part of the demo's
 * recorded set, its download/install are blocked, and it runs from the
 * recorded results.
 */
export function buildPretrainedRows(
  cards: PretrainedSummary[],
  eligibility: PretrainedEligibilityResponse | null,
  demo = false,
): TxrListRow[] {
  const verdictById = new Map(
    (eligibility?.models ?? []).map(verdict => [verdict.id, verdict]),
  )
  return cards.map(card => {
    const verdict = verdictById.get(card.id)
    const name = `${card.id} \u00b7 day ${card.decision_day}`
    const chip = demo
      ? { label: DEMO_PRETRAINED_CHIP, tone: 'accent' as const }
      : card.kind === 'published-rule'
        ? { label: 'Published rule', tone: 'neutral' as const }
        : { label: 'Learned here', tone: 'accent' as const }
    if (verdict === undefined) {
      // The defensive fallback: a card the verdict payload does not know
      // renders as `cannot` with the NOT_RUNNABLE line and no time.
      return {
        key: `ps:${card.id}`,
        name,
        tag: card.description,
        chip,
        performanceText: transferText(card.transfer),
        run: {
          status: 'cannot' as TxrRunStatus,
          headline: formatRunHeadline('cannot'),
          detail: formatReasonLine('cannot', [{ code: 'NOT_RUNNABLE' }], { eligible: 0, total: 0 }, { required: 0, met: 0, unmet_patients: 0 }, [], []),
          disabled: true,
        },
        timeText: null,
        action: { label: 'Model card' },
      }
    }
    const status = toRunStatus(verdict.status)
    return {
      key: `ps:${card.id}`,
      name,
      tag: card.description,
      chip,
      performanceText: transferText(card.transfer),
      run: runFacts(status, verdict.reasons, verdict.coverage, verdict.min_draws, verdict.missing_markers),
      timeText:
        verdict.estimated_seconds === null ||
        verdict.estimated_seconds === undefined ||
        !Number.isFinite(verdict.estimated_seconds)
          ? null
          : formatDurationShort(verdict.estimated_seconds),
      action: { label: 'Model card' },
    }
  })
}

/**
 * The screen-I row join: one set's saved-model summaries × their eligibility
 * verdicts → `TxrListRow[]`, in the list's order.
 *
 * The section-level facts (the run-facts subtitle, the section actions)
 * are `buildSavedSections`'s; a row reads only its own model's facts —
 * the `SetSummary` is a header concern and is deliberately not threaded
 * into the row signature (the plan's early draft named a `set` argument;
 * the sections function owns it: PROV-UI-MODELS-4's `buildSavedSections`).
 */
export function buildSavedRows(
  summaries: ModelSummary[],
  eligibility: ModelEligibilityResponse | null,
): TxrListRow[] {
  const verdictById = new Map(
    (eligibility?.models ?? []).map(verdict => [verdict.id, verdict]),
  )
  return summaries.map(model => {
    const verdict = verdictById.get(model.id)
    const chip =
      model.provenance === 'run'
        ? { label: 'Trained by you', tone: 'accent' as const }
        : model.provenance === 'imported'
          ? { label: 'Imported', tone: 'neutral' as const }
          : { label: 'Ready-made', tone: 'accent' as const }
    if (verdict === undefined) {
      return {
        key: model.id,
        name: model.name,
        tag: savedSubtitle(model),
        chip,
        performanceText: ownAucText(model.own_auc),
        run: {
          status: 'cannot' as TxrRunStatus,
          headline: formatRunHeadline('cannot'),
          detail: formatReasonLine('cannot', [{ code: 'NOT_RUNNABLE' }], { eligible: 0, total: 0 }, { required: 0, met: 0, unmet_patients: 0 }, [], []),
          disabled: true,
        },
        timeText: null,
        action: { label: 'Details' },
      }
    }
    const status = toRunStatus(verdict.status)
    return {
      key: model.id,
      name: model.name,
      tag: savedSubtitle(model),
      chip,
      performanceText: ownAucText(model.own_auc),
      run: runFacts(status, verdict.reasons, verdict.coverage, verdict.min_draws, verdict.missing_markers),
      timeText:
        verdict.estimated_seconds === null ||
        verdict.estimated_seconds === undefined ||
        !Number.isFinite(verdict.estimated_seconds)
          ? null
          : formatDurationShort(verdict.estimated_seconds),
      action: { label: 'Details' },
    }
  })
}

/**
 * An I section's run-facts line (Saved.dc.html's "trained 19 Oct on
 * patients.csv · <N> patients · <M> models · progression or death by day
 * 238" SKELETON — the letters are the board's, the counts design
 * examples) from the set's record + its models' run facts — every fact is
 * a provider field, never a design example:
 *
 * - `trained <date> on <source_label>` — the first model's `trained_at`
 *   (the run's `finished_at`; the set's own record carries no timestamp)
 *   + the set's `source_label` (engine truth — the file name the save
 *   dialog showed); the segment is omitted when neither fact is present;
 * - `<N> patients` — the first model's `trained_on_patients` (singular at
 *   one), omitted when unrecorded;
 * - `<M> models` — the set's `model_count`;
 * - the predicts line — the first model's task/endpoint/horizon through
 *   `formatPredicts`, omitted when unrecorded.
 *
 * A set whose models are still loading renders from the set's own facts
 * only (the first three segments' companions can be absent — the compose
 * never spells a blank, UNRECORDED or otherwise: the header is one line
 * and a "not recorded" segment in the middle would read wrong; the rows
 * below carry the unrecorded verdicts individually).
 */
function sectionSubtitle(set: SetSummary, models: ModelSummary[]): string {
  const first = models[0]
  const parts: string[] = []
  const trained = formatTrainedDateShort(first?.trained_at ?? null)
  const label = set.source_label?.trim() ?? ''
  if (trained !== null && label.length > 0) parts.push(`trained ${trained} on ${label}`)
  else if (trained !== null) parts.push(`trained ${trained}`)
  else if (label.length > 0) parts.push(`on ${label}`)
  const trainedOn = first?.trained_on_patients
  if (trainedOn !== null && trainedOn !== undefined && Number.isFinite(trainedOn)) {
    parts.push(`${trainedOn} ${trainedOn === 1 ? 'patient' : 'patients'}`)
  }
  parts.push(`${set.model_count} ${set.model_count === 1 ? 'model' : 'models'}`)
  if (first !== undefined) {
    const predicts = formatPredicts(first.task, first.endpoint, first.horizon)
    if (predicts !== UNRECORDED) parts.push(predicts)
  }
  return parts.join(' \u00b7 ')
}

/**
 * One screen-J inventory section (screen J's set grouping): a set's title +
 * the models listed under it, facts spelled by `formatSetFacts` from the
 * `SetSummary` when the sets read has answered, and the row keys' source.
 */
export interface ModelSetSection {
  /** The stable section key: the set id, or `MODEL_SET_NONE_KEY`. */
  key: string
  /** The section title (the set's name, or 'Not in a set'). */
  title: string
  /** The set's record (facts source); null for the not-in-a-set section
   *  and for the sets-read-not-answered fallback groups. */
  set: SetSummary | null
  /** The section's models, in the inventory list's order. */
  models: ModelSummary[]
  /** True for the not-in-a-set section (the brief's no-actions row). */
  unsetted: boolean
}

/** The not-in-a-set section's stable key (no `SetSummary` ever carries it;
 *  the underscored spelling keeps a real set id of that raw word from
 *  colliding with it — the section key must never equal a provider set id). */
export const MODEL_SET_NONE_KEY = '__none__'

/**
 * The screen-J section join (the inventory grouped by set): one section
 * per set the inventory knows, newest set first, then a LAST section for
 * the models whose set is not in the sets list ("Not in a set" — a missing
 * `set_id`, or a `set_id` the sets read does not know).
 *
 * Ordering: known sets by `created_at` desc (the newest set first); the
 * not-in-a-set section is always last.
 *
 * The `sets` contract: `null` means the sets read has NOT answered yet (or
 * failed) — the grouping then degrades to the rows' own facts (the set
 * name from `set_name`, the section order by the rows' newest
 * `created_at`) so the inventory never flashes everything into
 * "Not in a set" while the two reads race, and a failed sets read still
 * renders the rows. A non-null list is the provider's truth: a `set_id`
 * not in it (a set deleted from under the rows) goes to "Not in a set".
 *
 * A section with no listed model is omitted — the server-side `q`/`?set=`
 * filters leave the empty sections hidden (a search hit or the set focus
 * shows only the sections that match).
 */
export function buildModelSetSections(
  sets: SetSummary[] | null,
  models: ModelSummary[],
): ModelSetSection[] {
  const known = new Map((sets ?? []).map(set => [set.id, set] as const))
  const byId = new Map<string, ModelSummary[]>()
  const unsetted: ModelSummary[] = []
  for (const model of models) {
    const id = model.set_id?.trim() ?? ''
    if (id.length === 0 || (sets !== null && !known.has(id))) {
      unsetted.push(model)
      continue
    }
    const bucket = byId.get(id) ?? []
    bucket.push(model)
    byId.set(id, bucket)
  }

  const sections: ModelSetSection[] = []
  const knownSets = (sets ?? []).slice().sort(
    (a, b) => dateInstant(b.created_at) - dateInstant(a.created_at),
  )
  for (const set of knownSets) {
    const list = byId.get(set.id) ?? []
    if (list.length === 0) continue
    sections.push({ key: set.id, title: set.name, set, models: list, unsetted: false })
  }

  // The sets read not answered: the groups the known-sets loop did not
  // emit, named from the rows' own `set_name`, newest row first.
  const fallback = [...byId.entries()].filter(([id]) => !known.has(id))
  fallback.sort((a, b) => newestInstant(b[1]) - newestInstant(a[1]))
  for (const [id, list] of fallback) {
    const name = list.find(model => model.set_name?.trim())?.set_name?.trim() ?? id
    sections.push({ key: id, title: name, set: null, models: list, unsetted: false })
  }

  if (unsetted.length > 0) {
    sections.push({
      key: MODEL_SET_NONE_KEY,
      title: 'Not in a set',
      set: null,
      models: unsetted,
      unsetted: true,
    })
  }
  return sections
}

/** The instant a date string names; an unparseable string is -Infinity —
 *  an unknown date sorts LAST in both comparators, never arbitrarily
 *  placed by a NaN comparison (NaN < any number is false, so the sort
 *  treats it as equal and the position is unspecified). */
function dateInstant(value: string): number {
  const t = Date.parse(value)
  return Number.isNaN(t) ? -Infinity : t
}

/** The group's newest `created_at` instant (-Infinity for a group whose
 *  dates are all unparseable — the group sorts last). */
function newestInstant(models: ModelSummary[]): number {
  let newest = -Infinity
  for (const model of models) {
    const t = dateInstant(model.created_at)
    if (t > newest) newest = t
  }
  return newest
}

/**
 * The screen-I section join (INV-2: models from one training run are
 * grouped): one `TxrListSection` per saved set, in the sets list's order,
 * with the set's row keys (the set's models in the summaries list order)
 * and the board's two section actions — Rename (default tone) and "Delete
 * the run's models" (danger). The section's models are grouped by
 * `set_id`; a summary row with no set (the J inventory owns it) is not a
 * saved-model section member. The action ids are the host's
 * `onSectionAction` vocabulary: `'rename'` / `'delete'`.
 */
export function buildSavedSections(
  sets: SetSummary[],
  summaries: ModelSummary[],
  eligibility: ModelEligibilityResponse | null,
): TxrListSection[] {
  return sets.map(set => {
    const models = summaries.filter(model => model.set_id === set.id)
    const rows = buildSavedRows(models, eligibility)
    return {
      key: set.id,
      title: set.name,
      subtitle: sectionSubtitle(set, models),
      rowKeys: rows.map(row => row.key),
      actions: [
        { id: 'rename', label: 'Rename', tone: 'default' },
        { id: 'delete', label: "Delete the run's models", tone: 'danger' },
      ],
    }
  })
}
