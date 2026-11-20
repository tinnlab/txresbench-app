/**
 * txrlist method-picker logic (qa-fixes3 ITEM-1) — the PURE half of the
 * redesigned E screen: the family sections, the recommendation/presets, the
 * sort, the search/filter and the cannot-run reason groups. Every rule the
 * picker applies lives here so the component and its tests cannot drift
 * (the same discipline as `lib/selection.ts` — the module's pure rule set
 * is the module's contract).
 *
 * Rules, as the frozen plan STATES them:
 * - the family order is fixed (Response call, Response probability, Static
 *   risk, Dynamic risk) and each family has ONE plain sentence about what
 *   its methods output;
 * - the recommended set is deterministic: up to 8 runnable methods, at most
 *   3 per family, chosen by best benchmark (the higher median, needs >= 5
 *   datasets), fastest-first as the tie-break and as the fallback when no
 *   benchmark is known;
 * - presets: Recommended, All that can run, Fast only (each row's estimate
 *   under a minute), None; a manual tick is "Custom"; the pressed preset is
 *   the one last clicked while the selection still matches it;
 * - a cannot-run method is bucketed by its FIRST reason (the provider emits
 *   the reasons in a deterministic order), so the per-reason counts are a
 *   partition — never a double count.
 */
import type { TxrMethodCard } from '../types'

/** The fixed family order (the generated enum order, the boards' order). */
export const TXRMETHOD_GROUP_ORDER = [
  'response-call',
  'response-probability',
  'static-risk',
  'dynamic-risk',
] as const

export type TxrMethodGroupId = (typeof TXRMETHOD_GROUP_ORDER)[number]

/** The one-sentence family explainer (the plan's section-header copy). */
export const TXRMETHOD_GROUP_EXPLAINER: Record<TxrMethodGroupId, string> = {
  'response-call': 'Says whether each patient will respond or not',
  'response-probability': 'Gives each patient a chance of responding',
  'static-risk': 'A risk score from the first blood draw',
  'dynamic-risk': 'A risk score that updates with every new draw',
}

/** The picker's presets (the segmented control above the list). */
export type TxrMethodPreset = 'recommended' | 'all' | 'fast' | 'none'

/** The presets, in the control's order (the `methods.applyPreset` param). */
export const TXRMETHOD_PRESETS = ['recommended', 'all', 'fast', 'none'] as const satisfies readonly TxrMethodPreset[]

/** The mounted picker's instance type, which is also the page context it
 *  declares while mounted (`core/actions/builtin/methodActions.ts`). */
export const TXR_METHOD_PICKER_CONTEXT = 'txr.method-picker'

/** The preset action's id (the picker's instance handler key). */
export const METHODS_APPLY_PRESET = 'methods.applyPreset'

/** The picker's sort order. */
export type TxrMethodSort = 'recommended' | 'fastest' | 'name' | 'year'

/** The caps the frozen plan fixes: up to 8, at most 3 per family. */
export const TXRMETHOD_RECOMMEND_CAP = 8
export const TXRMETHOD_RECOMMEND_PER_FAMILY = 3

/** The "fast" preset's ceiling: under 1 min each. */
export const TXRMETHOD_FAST_SECONDS = 60

/** The minimum dataset count a benchmark fact counts as evidence (plan). */
export const TXRMETHOD_RANK_MIN_DATASETS = 5

/** The benchmark median the recommendation ranks on (higher is better). */
function rankMedian(card: TxrMethodCard): number | null {
  if (card.rank === null || card.rank.nDatasets < TXRMETHOD_RANK_MIN_DATASETS) return null
  return card.rank.median
}

/** The recommendation comparator: benchmark desc, then seconds asc, then id. */
function recommendationOrder(a: TxrMethodCard, b: TxrMethodCard): number {
  const ra = rankMedian(a)
  const rb = rankMedian(b)
  if (ra !== null && rb !== null && ra !== rb) return rb - ra
  if (ra !== null && rb === null) return -1
  if (ra === null && rb !== null) return 1
  const ea = a.estimate?.seconds ?? Number.POSITIVE_INFINITY
  const eb = b.estimate?.seconds ?? Number.POSITIVE_INFINITY
  if (ea !== eb) return ea - eb
  return a.id.localeCompare(b.id)
}

/** The runnable cards of a set (the picker never recommends/selects a
 *  cannot card — `disabled` is derived as `status === 'cannot'`). */
export function runnableCards(cards: ReadonlyArray<TxrMethodCard>): TxrMethodCard[] {
  return cards.filter(card => !card.run.disabled)
}

/**
 * The deterministic recommended selection: up to
 * [`TXRMETHOD_RECOMMEND_CAP`] runnable methods, at most
 * [`TXRMETHOD_RECOMMEND_PER_FAMILY`] per family, best benchmark first with
 * fastest-first tie-break and fastest-first fallback (plan point 2).
 */
export function recommendedSelection(cards: ReadonlyArray<TxrMethodCard>): string[] {
  const perFamily = new Map<string, number>()
  const out: string[] = []
  for (const card of [...runnableCards(cards)].sort(recommendationOrder)) {
    if (out.length >= TXRMETHOD_RECOMMEND_CAP) break
    const seen = perFamily.get(card.group) ?? 0
    if (seen >= TXRMETHOD_RECOMMEND_PER_FAMILY) continue
    perFamily.set(card.group, seen + 1)
    out.push(card.key)
  }
  return out
}

/** The "Fast only" preset: runnable methods whose estimate is under a minute. */
export function fastSelection(cards: ReadonlyArray<TxrMethodCard>): string[] {
  return runnableCards(cards)
    .filter(card => card.estimate !== null && card.estimate.seconds < TXRMETHOD_FAST_SECONDS)
    .map(card => card.key)
}

/** A preset's selection over the cards (deterministic; the custom state is
 *  the caller's comparison against these). */
export function presetSelection(
  preset: TxrMethodPreset,
  cards: ReadonlyArray<TxrMethodCard>,
): string[] {
  switch (preset) {
    case 'recommended':
      return recommendedSelection(cards)
    case 'all':
      return runnableCards(cards).map(card => card.key)
    case 'fast':
      return fastSelection(cards)
    case 'none':
      return []
  }
}

/** True when `selected` is exactly the preset's set over `cards`. */
function selectionIsPreset(
  selected: ReadonlySet<string>,
  preset: TxrMethodPreset,
  cards: ReadonlyArray<TxrMethodCard>,
): boolean {
  const keys = presetSelection(preset, cards)
  return keys.length === selected.size && keys.every(key => selected.has(key))
}

/** The preset a selection equals: the control's active segment, or 'custom'
 *  when the user has ticked by hand. An empty selection is always 'none'
 *  (checked first: when no method is fast, the Fast set is empty too, and
 *  "None" must not light "Fast only"). When two presets give the same set,
 *  the first of recommended, all, fast wins; `activePreset` keeps the one
 *  the user clicked. */
export function presetOf(
  selected: ReadonlySet<string>,
  cards: ReadonlyArray<TxrMethodCard>,
): TxrMethodPreset | 'custom' {
  if (selected.size === 0) return 'none'
  for (const preset of ['recommended', 'all', 'fast'] as const) {
    if (selectionIsPreset(selected, preset, cards)) return preset
  }
  return 'custom'
}

/**
 * The preset button that shows as pressed. `chosen` is the preset the user
 * (or the AI action) last applied: while the selection still equals that
 * preset's set, it stays pressed, even when another preset gives the same
 * set (on a small catalogue Recommended, All and Fast are often the same
 * methods). Once the selection differs (a manual tick, a group select-all, a
 * settings change that unticks a method), the selection decides
 * (`presetOf`). With nothing chosen yet (the page's recommended seed), the
 * order is `presetOf`'s.
 */
export function activePreset(
  selected: ReadonlySet<string>,
  cards: ReadonlyArray<TxrMethodCard>,
  chosen: TxrMethodPreset | null,
): TxrMethodPreset | 'custom' {
  if (chosen !== null && selectionIsPreset(selected, chosen, cards)) return chosen
  return presetOf(selected, cards)
}

/** "1 method" / "N methods" (the re-check line's count words). */
function methodCount(count: number): string {
  return `${count} ${count === 1 ? 'method' : 'methods'}`
}

/**
 * The picker's line after a re-check (a settings or files change asked the
 * engine again what can run): what changed in the runnable set, compared by
 * key. Neutral wording, because a Change-files re-check gives the same line.
 *
 * - same set: "Checked again: the same 5 methods can run."
 * - another count: "Checked again: 6 methods can run (was 5)."
 * - same count, other members: "Checked again: a different set of 5 methods
 *   can run." (never "5 methods can run (was 5)").
 */
export function recheckLine(
  beforeKeys: ReadonlyArray<string>,
  afterKeys: ReadonlyArray<string>,
): string {
  const before = new Set(beforeKeys)
  const after = new Set(afterKeys)
  const same = before.size === after.size && [...after].every(key => before.has(key))
  if (same) {
    if (after.size === 0) return 'Checked again: still no method can run.'
    if (after.size === 1) return 'Checked again: the same method can run.'
    return `Checked again: the same ${methodCount(after.size)} can run.`
  }
  if (after.size === before.size) {
    return `Checked again: a different set of ${methodCount(after.size)} can run.`
  }
  if (after.size === 0) return `Checked again: no method can run now (was ${before.size}).`
  return `Checked again: ${methodCount(after.size)} can run (was ${before.size}).`
}

/** The line after a re-check that FAILED while a list is on screen: the
 *  list still shows the last answer, which may not match the settings. */
export function recheckFailedLine(error: string): string {
  const reason = error.trim().replace(/\.+$/, '')
  return `Could not check again: ${reason}. The list shows the last answer.`
}

/** The picker's sort (recommended keeps the recommendation's order). */
export function sortCards(
  cards: ReadonlyArray<TxrMethodCard>,
  sort: TxrMethodSort,
): TxrMethodCard[] {
  switch (sort) {
    case 'recommended':
      return [...cards].sort(recommendationOrder)
    case 'fastest':
      return [...cards].sort(
        (a, b) =>
          (a.estimate?.seconds ?? Number.POSITIVE_INFINITY) -
            (b.estimate?.seconds ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id),
      )
    case 'name':
      return [...cards].sort(
        (a, b) =>
          a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
      )
    case 'year':
      return [...cards].sort(
        (a, b) => b.year - a.year || recommendationOrder(a, b),
      )
  }
}

/**
 * The searchable text of one card: name, id, journal, years, the summary
 * and the paper title — author-year is the citation text inside the summary,
 * since the summary payload carries no separate author field (the
 * description's citation is the source).
 */
export function methodSearchText(card: TxrMethodCard): string {
  return [card.title, card.id, card.journal, String(card.year), card.summary, card.paperTitle ?? '']
    .join(' ')
    .toLowerCase()
}

/** The search + family filter → the matching cards. */
export function filterMethodCards(
  cards: ReadonlyArray<TxrMethodCard>,
  query: string,
  groups: ReadonlySet<string>,
): TxrMethodCard[] {
  const q = query.trim().toLowerCase()
  return [...cards].filter(
    card =>
      (q === '' || methodSearchText(card).includes(q)) &&
      (groups.size === 0 || groups.has(card.group)),
  )
}

// ── the cannot-run reason groups (plan point 1: count per REASON as chips) ──

/** One reason-group definition (the fix line + the codes it owns). */
interface TxrReasonGroupDef {
  key: string
  label: string
  codes: readonly string[]
  fix: string
}

/** The fixed reason-group order: the plan's five named reasons, the engine's
 *  marker-count rule (MARKER_COUNT_UNMET) + the
 *  catch-all (a reason code the vocabulary does not classify renders its own
 *  row, never blank). */
export const TXRMETHOD_REASON_GROUPS: readonly TxrReasonGroupDef[] = [
  {
    key: 'environment',
    label: "No published environment",
    codes: ['ENV_IMAGE_MISSING', 'NOT_RUNNABLE'],
    fix: 'This method is not available yet.',
  },
  {
    key: 'marker',
    label: "Needs a marker your file doesn't have",
    codes: ['REQUIRED_MARKER_MISSING', 'DETECTION_CALL_MISSING', 'UNIT_MISMATCH', 'MARKER_GROUP_MISSING'],
    fix: 'Add a column with the marker the method needs.',
  },
  {
    key: 'marker-count',
    label: 'Takes a set number of markers',
    codes: ['MARKER_COUNT_UNMET'],
    fix: 'Use a file with just the markers this method takes.',
  },
  {
    key: 'outcome',
    label: "Needs an outcome your file doesn't have",
    codes: ['TASK_INCOMPATIBLE', 'RESPONSE_LABEL_MISSING', 'SURVIVAL_OUTCOME_MISSING'],
    fix: 'Add the outcome column the method needs.',
  },
  {
    key: 'draws',
    label: 'Needs more draws per patient',
    codes: ['MIN_DRAWS_UNMET', 'DECISION_DAY_UNMET'],
    fix: 'Add more draws per patient or adjust the settings.',
  },
  {
    key: 'covariates',
    label: 'Needs covariates',
    codes: ['COVARIATE_MISSING', 'COVARIATE_REQUIRED_UNMET'],
    fix: 'Add the extra inputs the method needs.',
  },
  {
    key: 'other',
    label: 'Other',
    codes: [],
    fix: 'Check what the method needs.',
  },
]

export interface TxrReasonGroup {
  key: string
  label: string
  fix: string
  count: number
  cards: TxrMethodCard[]
}

function groupOfCode(code: string): string {
  for (const group of TXRMETHOD_REASON_GROUPS) {
    if (group.codes.includes(code)) return group.key
  }
  return 'other'
}

/**
 * The cannot-run partition: each cannot card in its FIRST reason's group
 * (the provider's reason order is deterministic; the counts therefore sum
 * to the cannot count). Groups with no member are omitted; the 'other'
 * group renders only when a foreign code appears (never blank, never noisy).
 */
export function reasonGroups(cards: ReadonlyArray<TxrMethodCard>): TxrReasonGroup[] {
  const byKey = new Map<string, TxrMethodCard[]>()
  for (const card of cards) {
    if (!card.run.disabled) continue
    const key = groupOfCode(card.run.reasonCode ?? 'other')
    const list = byKey.get(key) ?? []
    list.push(card)
    byKey.set(key, list)
  }
  const out: TxrReasonGroup[] = []
  for (const group of TXRMETHOD_REASON_GROUPS) {
    const members = byKey.get(group.key) ?? []
    if (members.length === 0) continue
    out.push({
      key: group.key,
      label: group.label,
      fix: group.fix,
      count: members.length,
      cards: members,
    })
  }
  return out
}
