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
  ModelEligibility,
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
 * The merged list's saved/imported subtitle (predict-card merge round 2):
 * the run name first ("`<run name>` · decision day N" — the run name is the
 * set name, so the flat list still shows which run a model came from), or
 * the DEC-13 day part alone for an imported model with no set. "before
 * treatment only" stays the day part's baseline spelling.
 */
export function chooseSavedSubtitle(model: ModelSummary): string {
  const day = savedSubtitle(model)
  const run = model.set_name?.trim() ?? ''
  return run.length > 0 ? `${run} \u00b7 ${day}` : day
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
  return summaries.map(model =>
    buildSavedRow(model, verdictById.get(model.id), savedSubtitle(model)),
  )
}

/** ONE saved/imported row (the shared arm of the I join and the merged
 *  list's join — the merged list threads its own subtitle through). */
function buildSavedRow(
  model: ModelSummary,
  verdict: ModelEligibility | undefined,
  subtitle: string,
): TxrListRow {
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
      tag: subtitle,
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
    tag: subtitle,
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
}

/** The merged list row source labels (the small-caps DOM text, verbatim). */
export const CHOOSE_SOURCE_LABELS = {
  lab: 'From the lab',
  saved: 'Saved',
  imported: 'Imported',
} as const

/**
 * The merged model step's row join (predict-card merge round 2): the lab
 * catalogue rows (the D pages' rows, plus the source label) and the store's
 * `run` / `imported` rows (the I pages' row arm, plus the source label and
 * the run-name subtitle) in ONE flat list — every model that exists.
 * A store row with provenance `pretrained` is NOT listed: it is the lab
 * row's downloaded state (fixes today's double listing). When the lab
 * CATALOGUE fails to load (`pretrainedFailed`), that row would vanish — so
 * it is listed as a lab row from the store's own facts instead (the audit's
 * item 8: the downloaded lab models stay visible; a `ps:<catalogue_id>` key
 * keeps the same identity the loaded catalogue would use). The list order is
 * the lab catalogue order, then the store's own order.
 */
export function buildChooseRows(
  cards: PretrainedSummary[],
  summaries: ModelSummary[],
  pretrainedElig: PretrainedEligibilityResponse | null,
  savedElig: ModelEligibilityResponse | null,
  demo = false,
  pretrainedFailed = false,
): TxrListRow[] {
  const lab = buildPretrainedRows(cards, pretrainedElig, demo).map(row => ({
    ...row,
    source: { label: CHOOSE_SOURCE_LABELS.lab as string },
  }))
  const verdictById = new Map(
    (savedElig?.models ?? []).map(verdict => [verdict.id, verdict]),
  )
  const owned = summaries
    .filter(model => model.provenance !== 'pretrained' || pretrainedFailed)
    .map(model => {
      if (model.provenance === 'pretrained') {
        // The catalogue is down: the downloaded lab model stays listed as
        // a lab row, built from the store's own facts (the store row IS the
        // model — the catalogue list is only the not-downloaded view).
        const row = buildSavedRow(model, verdictById.get(model.id), chooseSavedSubtitle(model))
        return {
          ...row,
          key: `ps:${model.pretrained_catalogue_id ?? model.id}`,
          source: { label: CHOOSE_SOURCE_LABELS.lab as string },
        }
      }
      const row = buildSavedRow(model, verdictById.get(model.id), chooseSavedSubtitle(model))
      return {
        ...row,
        source: {
          label: (
            model.provenance === 'run'
              ? CHOOSE_SOURCE_LABELS.saved
              : CHOOSE_SOURCE_LABELS.imported
          ) as string,
        },
      }
    })
  return [...lab, ...owned]
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
 * The screen-J one-table join (ONE-TABLE round — the inventory table is ONE
 * `<table>` with set rows and model rows): a flat, ORDERED list of row
 * descriptors built from the inventory models × the sets read:
 *
 * - a SET row per set the inventory knows (the group header row: the set
 *   name, its record's facts, the Name-cell count, the Made date, the set
 *   actions) with the set's listed models; the model rows FOLLOW the set
 *   row only when the set is expanded (`expanded`), focused (`?set=` — the
 *   focus view shows exactly that one set, always expanded) or the
 *   client-side search FORCED it (a model match — see below);
 * - a MODEL row for every listed model of an expanded set (`inSet: true` —
 *   the page indents it in the Name column) and, at the TOP level, the
 *   models with no set (`inSet: false`) — there is no "Not in a set"
 *   section any more, and no `MODEL_SET_NONE_KEY`: an unsetted model is a
 *   plain top-level row (never indented, never empty in Name). Inside a set
 *   the model rows follow the CURRENT sort (the Made direction under the
 *   Made sort, the Name direction under the Name sort — brief 7).
 *
 * ORDERING (brief 7 — FOLDER-STYLE: the sort owns the row order, never
 * the component; the SET rows come ALWAYS FIRST, then the top-level
 * no-set models, in EVERY sort and direction — "folders on top"):
 *
 * - `sort.by === 'made'`: the set rows by the set's made date (the
 *   fallback group's newest model `created_at` while the sets read has not
 *   answered), newest first at birth — OLDEST first when the Made
 *   direction flips; then the top-level no-set models by their own
 *   `created_at`, in the SAME direction; each block is sorted on its own;
 *   a model row inside an expanded set follows the direction too (newest
 *   first / oldest first); an unparseable instant sorts LAST in both
 *   directions;
 * - `sort.by === 'name'`: the set rows by set name, then the top-level
 *   no-set models by model name — each block case-insensitive
 *   `localeCompare`, A→Z / Z→A, on its own; the models inside a set follow
 *   the SAME name direction.
 *
 * SEARCH (part 2 — the page loads the full model list and filters here over
 * the sets read; `options.search` is the raw input text, trimmed):
 *
 * - a SET-NAME match (case-insensitive substring of the set row's name)
 *   shows the set row with ALL its models and keeps the set's own expand
 *   state (`match: 'all'` — the set-name match WINS over model matches);
 * - a MODEL match (the model's name or method id) shows the model; when it
 *   is in a set, that set row is shown EXPANDED with ONLY the matching
 *   models (`match: 'partial'`, `matchCount` = the matches) — the forced
 *   expansion is a view-only arm, never written to the `expanded` store;
 * - a matching no-set model is a plain top-level row; nothing matches →
 *   the empty list (the page spells the no-match line); no search text →
 *   every row, expansion as the store says.
 *
 * The `sets` contract is the old builder's: `null` means the sets read has
 * NOT answered yet (or failed) — the grouping degrades to the rows' own
 * facts (the set name from `set_name`, the group order by the rows' newest
 * `created_at`, the count the listed one) so the inventory never flashes a
 * model into the no-set top level while the two reads race. A non-null
 * list is the provider's truth: a `set_id` not in it (a set deleted from
 * under the rows) goes to the top level.
 *
 * The `expanded` set is the module-level expansion store's snapshot (the
 * sets are CLOSED by default); the `focusSetId` is the `?set=` param — the
 * focus view overrides both expansion and the no-set rows (only that set's
 * rows exist while focused, and the search still applies inside it).
 */
export type ModelTableRow =
  | {
      kind: 'set'
      /** The stable key: the set id (never a no-set key). */
      key: string
      /** The set's display name (its record's, or the rows' own
       *  `set_name` fallback while the sets read has not answered). */
      name: string
      /** The set's record (the facts source); null for a fallback group. */
      set: SetSummary | null
      /** The models listed under this set, in the inventory list's order
       *  (a search narrows this to the matches — see `match`). */
      models: ModelSummary[]
      /** The count the set row's Name cell spells (the `(3)` visible count
       *  with its "3 models" sr text): the set's `model_count` (the
       *  engine's fact — the old facts line's count — never the listed
       *  count) when the record is known, else the listed count. */
      modelCount: number
      /** The number of LISTED models under the search filter: the full
       *  listed count for a set-name match / no search, the matches'
       *  count for a partial model match. */
      matchCount: number
      /** The client-side search's verdict on this set: `'all'` (the set
       *  NAME matched — every listed model is shown, the set keeps its
       *  own expand state), `'partial'` (only some listed models match —
       *  the row is FORCED expanded with just the matches), `null` (no
       *  search text, or the search missed this set and it is not shown). */
      match: 'all' | 'partial' | null
    }
  | {
      kind: 'model'
      model: ModelSummary
      /** True when the row belongs to the set row above it (indented in
       *  the Name column); false for a no-set top-level row. */
      inSet: boolean
    }

/** The one table's sort (part 2 — two sortable column headers, `Name` and
 *  `Made`; the ordering is the BUILDER's, never the component's). */
export interface ModelTableSort {
  /** `'made'` = the made dates (the set rows block first — folders on
   *  top — then the top-level no-set models block, each on its own);
   *  `'name'` = the names (the set rows by set name, then the no-set
   *  models by model name, both case-insensitive). */
  by: 'name' | 'made'
  /** ascending (`A→Z` / oldest first) or descending (`Z→A` / newest
   *  first). */
  direction: 'asc' | 'desc'
}

/** The birth sort: Made, newest first. */
export const MODEL_TABLE_DEFAULT_SORT: ModelTableSort = { by: 'made', direction: 'desc' }

/** The builder's view options (the expansion state + the `?set=` focus +
 *  the part-2 client-side search and sort). */
export interface ModelTableOptions {
  /** The expanded set ids (the module-level store's snapshot). */
  expanded: ReadonlySet<string>
  /** The `?set=` focus: only that set's rows, always expanded. */
  focusSetId: string | null
  /** The search-box text (trimmed in the builder; `''` = no search). */
  search: string
  /** The column sort (the page owns the state — `MODEL_TABLE_DEFAULT_SORT`
   *  at birth). */
  sort: ModelTableSort
}

export function buildModelTableRows(
  sets: SetSummary[] | null,
  models: ModelSummary[],
  options: ModelTableOptions,
): ModelTableRow[] {
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

  interface Group {
    key: string
    name: string
    set: SetSummary | null
    models: ModelSummary[]
    modelCount: number
    matchCount: number
  }
  const groups: Group[] = []
  const knownSets = (sets ?? []).slice().sort(
    (a, b) => dateInstant(b.created_at) - dateInstant(a.created_at),
  )
  for (const set of knownSets) {
    const list = byId.get(set.id) ?? []
    groups.push({
      key: set.id,
      name: set.name,
      set,
      models: list,
      modelCount: set.model_count ?? list.length,
      matchCount: list.length,
    })
  }

  // The sets read not answered: the groups the known-sets loop did not
  // emit, named from the rows' own `set_name`, newest row first.
  const fallback = [...byId.entries()].filter(([id]) => !known.has(id))
  fallback.sort((a, b) => newestInstant(b[1]) - newestInstant(a[1]))
  for (const [id, list] of fallback) {
    const name = list.find(model => model.set_name?.trim())?.set_name?.trim() ?? id
    groups.push({
      key: id,
      name,
      set: null,
      models: list,
      modelCount: list.length,
      matchCount: list.length,
    })
  }

  const query = options.search.trim().toLowerCase()
  const searching = query.length > 0
  const focus = options.focusSetId

  /** One group the table will show, with the search filter applied: which
   *  of its models are listed, whether the search matched the group BY
   *  NAME (all models, own expand state) or by its MODELS (only the
   *  matches, forced expanded), and whether the model rows are forced into
   *  the view. */
  interface Shown {
    group: Group
    models: ModelSummary[]
    match: 'all' | 'partial' | null
    forced: boolean
  }
  const shownGroups: Shown[] = []
  const shownUnsetted: ModelSummary[] = []

  for (const group of groups) {
    // The `?set=` focus keeps only the focused group (never the no-set
    // rows); the unfocused view drops empty groups.
    if (focus !== null && group.key !== focus) continue
    if (searching) {
      // A set-name match WINS over its model matches: all models show and
      // the set keeps its own expand state; a model-only match FORCES the
      // view expanded with just the matches (the store is untouched).
      const nameMatch = group.name.toLowerCase().includes(query)
      const matches = group.models.filter(model => modelMatches(model, query))
      if (nameMatch) {
        shownGroups.push({ group, models: group.models, match: 'all', forced: false })
      } else if (matches.length > 0) {
        shownGroups.push({ group, models: matches, match: 'partial', forced: true })
      }
      continue
    }
    if (group.models.length > 0 || focus !== null) {
      shownGroups.push({ group, models: group.models, match: null, forced: false })
    }
  }
  // The top-level no-set rows belong to the UNFOCUSED inventory only (the
  // `?set=` focus is one set's view — part 1's byte; the search applies
  // inside it, never reaching out to the no-set rows).
  if (focus === null) {
    if (searching) {
      for (const model of unsetted) {
        if (modelMatches(model, query)) shownUnsetted.push(model)
      }
    } else {
      shownUnsetted.push(...unsetted)
    }
  }

  /** A shown group's model rows follow the CURRENT sort (brief 7): the
   *  Made direction (newest first at birth, OLDEST first when the Made
   *  direction flips) under the Made sort, the same Name direction
   *  (A→Z / Z→A, case-insensitive) under the Name sort. */
  const groupModels = (shown: Shown): ModelSummary[] => {
    if (shown.models.length <= 1) return shown.models
    return sortByMade(options.sort)
      ? modelMadeOrder(shown.models, options.sort.direction)
      : modelNameOrder(shown.models, options.sort.direction)
  }

  const rows: ModelTableRow[] = []
  const emitGroup = (shown: Shown): void => {
    const group = shown.group
    rows.push({
      kind: 'set',
      key: group.key,
      name: group.name,
      set: group.set,
      models: group.models,
      modelCount: group.modelCount,
      matchCount: shown.match === 'partial' ? shown.models.length : group.matchCount,
      match: shown.match,
    })
    if (focus !== null || shown.forced || options.expanded.has(group.key)) {
      for (const model of groupModels(shown)) rows.push({ kind: 'model', model, inSet: true })
    }
  }

  if (sortByMade(options.sort)) {
    // Made, folders on top: the set rows first (by the set's made date —
    // the fallback group's newest listed model), then the top-level
    // no-set models (by their own created_at) — each block sorted on its
    // own, in the SAME direction (newest first at birth, oldest first
    // when the Made direction flips).
    const groupsByMade = shownGroups
      .slice()
      .sort((a, b) =>
        compareMade(
          { instant: groupMadeInstant(a.group) },
          { instant: groupMadeInstant(b.group) },
          options.sort.direction,
        ),
      )
    for (const shown of groupsByMade) emitGroup(shown)
    const looseByMade = shownUnsetted
      .slice()
      .sort((a, b) =>
        compareMade(
          { instant: dateInstant(a.created_at) },
          { instant: dateInstant(b.created_at) },
          options.sort.direction,
        ),
      )
    for (const model of looseByMade) {
      rows.push({ kind: 'model', model, inSet: false })
    }
  } else {
    // Name, folders on top: the set rows by set name (A→Z / Z→A,
    // case-insensitive), then the top-level no-set models by model name in
    // the same direction — each block sorted on its own.
    const byName = shownGroups
      .slice()
      .sort((a, b) => compareNames(a.group.name, b.group.name, options.sort.direction))
    for (const shown of byName) emitGroup(shown)
    const looseByName = shownUnsetted
      .slice()
      .sort((a, b) => compareNames(a.name, b.name, options.sort.direction))
    for (const model of looseByName) {
      rows.push({ kind: 'model', model, inSet: false })
    }
  }
  return rows
}

/** True when the sort is the `made` column's (the date-block arm vs the
 *  name-block arm). */
function sortByMade(sort: ModelTableSort): boolean {
  return sort.by === 'made'
}

/** The made instant a set row counts in the `made` sort: the set's own
 *  `created_at`; a fallback group (the sets read not answered) counts by
 *  its newest listed model — the same fact the fallback ordering used. */
function groupMadeInstant(group: { set: SetSummary | null; models: ModelSummary[] }): number {
  if (group.set !== null) return dateInstant(group.set.created_at)
  return newestInstant(group.models)
}

/** A model row's search verdict: the model's display name or its method id
 *  holds the query (case-insensitive substring), the search's whole rule. */
function modelMatches(model: ModelSummary, substring: string): boolean {
  return (
    model.name.toLowerCase().includes(substring) ||
    model.method_id.toLowerCase().includes(substring)
  )
}

/** The made-order comparator (both directions): an unparseable instant
 *  (`-Infinity` — `dateInstant`'s unknown-date marker) sorts LAST, never
 *  first, so a NaN comparison can never place an unknown date arbitrarily. */
function compareMade(
  a: { instant: number },
  b: { instant: number },
  direction: 'asc' | 'desc',
): number {
  if (a.instant === -Infinity && b.instant === -Infinity) return 0
  if (a.instant === -Infinity) return 1
  if (b.instant === -Infinity) return -1
  return direction === 'asc' ? a.instant - b.instant : b.instant - a.instant
}

/** The name comparator (both directions): case-insensitive
 *  `localeCompare` (the brief's rule), ascending or descending. */
function compareNames(a: string, b: string, direction: 'asc' | 'desc'): number {
  const c = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return direction === 'asc' ? c : -c
}

/** The models in the Name direction (case-insensitive `localeCompare` —
 *  the row order inside an expanded set under the Name sort, and the
 *  top-level no-set models' order). */
function modelNameOrder(models: ModelSummary[], direction: 'asc' | 'desc'): ModelSummary[] {
  return models.slice().sort((a, b) => compareNames(a.name, b.name, direction))
}

/** The models in the Made direction (an unparseable instant LAST in both
 *  directions — `dateInstant`'s -Infinity marker, never a NaN placement):
 *  the row order inside an expanded set under the Made sort. */
function modelMadeOrder(models: ModelSummary[], direction: 'asc' | 'desc'): ModelSummary[] {
  return models.slice().sort((a, b) => {
    const ta = dateInstant(a.created_at)
    const tb = dateInstant(b.created_at)
    if (ta === -Infinity && tb === -Infinity) return 0
    if (ta === -Infinity) return 1
    if (tb === -Infinity) return -1
    return direction === 'asc' ? ta - tb : tb - ta
  })
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
