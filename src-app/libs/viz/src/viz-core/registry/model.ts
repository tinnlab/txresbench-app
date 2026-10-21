// registry/model.ts — the PURE binding-resolution layer for the chart-type registry
// (EXTENSIBILITY_STUDY Part 6 STEP 2). A chart type declares its `bindingSchema` (which
// channels it needs — value / group / valueKeys / continuous / table); these helpers
// resolve that schema against the dataset catalog into a `ChartModel`, and read the
// resolved values back out. This is the per-kind binding knowledge that USED to live in
// `CellView`'s `switch` + the shared `defaultBindings` — now owned by each descriptor.
//
// PURE: no React, no deck — plain data transforms over the catalog, so the whole file is
// unit-testable in node (mirrors ECharts `SeriesModel.getInitialData`).
//
// ── THIS FILE REFUSES; IT DOES NOT GUESS ────────────────────────────────────────────────
//
// It used to resolve every channel as `name-match → Nth-of-catalog-order → a hardcoded
// column literal`, on every chart-cell render:
//
//     case 'categorical': return catalog.categoricalColumns[ordinal]?.id ?? 'group'
//     case 'continuous':  return catalog.continuousColumns[ordinal]?.id ?? 'qcA'
//
// Each step is a further retreat from evidence and the last one invents. The middle step is
// the worst, because catalog order is real, stable and MEANINGLESS — so it produces a
// confident, plausible, wrong answer. Four owner-reported defects came out of this predicate
// (an all-black canvas, an identifier column bound as a grouping, a violin→histogram switch
// silently changing column, a fabricated "All" group); each was fixed at its own instance and
// the predicate was left intact.
//
// The rule now, from `docs/design/binding-resolution-refusal.md`:
//
//     A resolver may not take [0]. Either exactly one candidate matches, or the resolution
//     is an explicit refusal the caller must handle — and the user must be able to see why.
//
// so the return type is `BindingResolution` (five statuses, refusal expressible) rather than
// `string` (in which refusal cannot be said, so invention is the only thing left). The
// precedent is `AxisResolution` in the app's `extensions/data/contract.ts`, which made the
// same call for axis labels for the same reason.

import type { DatasetCatalog } from '../data/wire'
import type { GridCell } from '../grid/gridModel'
import type {
  BindingChannel,
  BindingResolution,
  BindingResolutions,
  ChartModel,
  ResolvedBindings,
} from './types'

/** Default cap on how many value columns a `value` / `valueList` channel considers. This is a
 *  RENDER BUDGET, not an identity claim — which is why a truncated `bound-list` carries its
 *  `total` rather than implying the cap is the whole set. Overridable per channel (`limit`). */
const DEFAULT_VALUE_LIMIT = 6

/**
 * How many candidate column names a refusal MESSAGE names before it elides the rest.
 *
 * A fixed constant, not a setting: it is a render budget on a message string — client-side,
 * no persistence, no security or resource boundary — and `libs/viz` is a package with no
 * settings surface at all. Named (rather than an inline `6`) so it can be promoted without a
 * rewrite. `DEFAULT_VALUE_LIMIT` above is the naming precedent.
 */
export const REFUSAL_CANDIDATE_PREVIEW = 6

/** The SOLE element of `xs`, or `undefined` when there are none or several.
 *
 *  This is the whole difference between the correct minority and the family: `length === 1`
 *  is not a choice at all, so binding it asserts nothing. `xs[0]` on a longer list asserts
 *  that position 0 means something, and nothing in any catalog's contract says it does. */
function sole<T>(xs: readonly T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined
}

/**
 * Resolve ONE binding channel against the dataset catalog, TOTALLY — every input yields one of
 * the five `BindingResolution` statuses, and none of them is an invented column name.
 *
 * Per source, in order:
 *  - `categorical` / `continuous` / `value` — an **id-match** first (a channel `group` binds a
 *    `group` column even when it isn't first, `open`→`open`, …): an exact match is EVIDENCE,
 *    not a guess, so it binds regardless of how many other columns exist. Failing that, the
 *    **sole** candidate of that kind binds. Failing that: `absent` (none) or `ambiguous`
 *    (several) — never the ordinal, never a literal.
 *  - `valueList` — inherently multi-column: binds the first ≤`limit` value columns and REPORTS
 *    `total`, so a caller can say "6 of 40". `absent` when the catalog has none.
 *  - `table` — a fixed `constant`, which is not a dataset column at all and so is not a guess
 *    about data; absent constant ⇒ `unbound`.
 *
 * An explicitly-empty `channel.id` on a column channel is `unbound` — viz's in-band "bind no
 * column" (INV-4), which must not be normalised into `absent`.
 *
 * ── WHAT HAPPENED TO `ordinal` ──────────────────────────────────────────────────────────
 *
 * It is GONE, and its disappearance is the fix rather than a side effect. `ordinal` existed so
 * that a schema declaring SEVERAL channels of one single-column source (candlestick's four
 * `continuous` price channels) would resolve each to a DISTINCT column — by taking the 0th,
 * 1st, 2nd, 3rd of catalog order. That is the family's exact shape applied four times: it
 * bound `high` to whatever the catalog happened to list third. Candlestick's channels are
 * `open`/`high`/`low`/`close` and its data has columns of those names, so the ID-MATCH resolves
 * every one of them correctly and always did; the ordinal only ever fired when the id-match
 * MISSED, which is precisely when there was no evidence. With it removed, a schema whose ids
 * do not match its columns now refuses per channel and says which — instead of silently
 * dealing out columns in list order.
 */
export function resolveBindingChannel(
  channel: BindingChannel,
  catalog: DatasetCatalog,
): BindingResolution {
  const limit = channel.limit ?? DEFAULT_VALUE_LIMIT
  switch (channel.source) {
    case 'categorical': {
      const ids = catalog.categoricalColumns.map(c => c.id)
      return resolveColumn(channel.id, ids, 'categorical')
    }
    case 'continuous': {
      const ids = catalog.continuousColumns.map(c => c.id)
      return resolveColumn(channel.id, ids, 'continuous')
    }
    case 'value':
      return resolveColumn(channel.id, catalog.valueColumns, 'value')
    case 'valueList': {
      const all = catalog.valueColumns
      if (all.length === 0) return { status: 'absent', source: 'valueList' }
      return { status: 'bound-list', columns: all.slice(0, limit), total: all.length }
    }
    case 'table':
      return channel.constant ? { status: 'bound', column: channel.constant } : { status: 'unbound' }
  }
}

/** The shared single-column rule: explicit-empty → id-match → sole candidate → refuse. */
function resolveColumn(
  channelId: string,
  candidates: readonly string[],
  source: 'categorical' | 'continuous' | 'value',
): BindingResolution {
  // INV-4: an explicitly-empty channel is a DECISION ("nothing, on purpose"), not a gap.
  if (channelId === '') return { status: 'unbound' }
  if (candidates.includes(channelId)) return { status: 'bound', column: channelId }
  const only = sole(candidates)
  if (only !== undefined) return { status: 'bound', column: only }
  if (candidates.length === 0) return { status: 'absent', source }
  return { status: 'ambiguous', source, candidates }
}

/**
 * Resolve a whole `bindingSchema` into its per-channel {@link BindingResolution}s, keyed by
 * channel id. An empty schema (scatter / image / grid) yields `{}`.
 *
 * There is no per-source ordinal counter any more — see `resolveBindingChannel`'s note. Two
 * channels of the same source that both fail their id-match now both refuse (identically, and
 * visibly) rather than being handed catalog positions 0 and 1.
 */
export function resolveBindings(
  schema: readonly BindingChannel[],
  catalog: DatasetCatalog,
): BindingResolutions {
  const out: Record<string, BindingResolution> = {}
  for (const channel of schema) out[channel.id] = resolveBindingChannel(channel, catalog)
  return out
}

/**
 * The `ResolvedBindings` view of a resolution map: the channels that actually resolved.
 *
 * `bound` / `bound-list` contribute their column(s). `unbound` contributes `''` — the in-band
 * "no column" every downstream reader already understands (`validateBindings` skips it,
 * `seriesBoundColumns` skips it, `CanvasObsSource.categorical('')` returns one group over
 * every row). `absent` / `ambiguous` contribute NOTHING: a refusal is not a blank, and
 * spelling it `''` would say "deliberately nothing" about a channel nobody decided (INV-4).
 */
export function bindingsOf(resolutions: BindingResolutions): ResolvedBindings {
  const out: Record<string, string | readonly string[]> = {}
  for (const [id, r] of Object.entries(resolutions)) {
    if (r.status === 'bound') out[id] = r.column
    else if (r.status === 'bound-list') out[id] = r.columns
    else if (r.status === 'unbound') out[id] = ''
  }
  return out
}

/**
 * Build a `ChartModel` for a cell from its chart's `bindingSchema` + the catalog. This is
 * the generic `model()` every built-in descriptor uses (closing over its own schema), so
 * the per-kind knowledge lives in the schema, not in a shared switch. Pure.
 *
 * The optional `override` lets a caller (the declarative controller, via `CellView`) supply
 * already-resolved per-channel bindings — a `series.encode` — that take PRECEDENCE over the
 * catalog resolution. An override is an AUTHOR'S DECLARATION, which is evidence, so it
 * outranks a refusal as well as a catalog default: a channel the catalog could not decide but
 * the series named is `bound`. Merge is per-channel; every channel the override omits keeps
 * its catalog resolution.
 */
export function makeChartModel(
  cell: GridCell,
  schema: readonly BindingChannel[],
  catalog: DatasetCatalog,
  override?: ResolvedBindings,
): ChartModel {
  const resolutions: Record<string, BindingResolution> = {
    ...resolveBindings(schema, catalog),
  }
  if (override) {
    for (const [id, v] of Object.entries(override)) {
      resolutions[id] = Array.isArray(v)
        ? { status: 'bound-list', columns: v, total: v.length }
        : v === ''
          ? { status: 'unbound' }
          : { status: 'bound', column: v as string }
    }
  }
  return { kind: cell.kind, bindings: bindingsOf(resolutions), resolutions, cell }
}

/**
 * Read a SINGLE-column channel's resolved value out of a model's bindings. An absent channel
 * — one that refused, or one nobody declared — reads as `''`, so an adapter never hands
 * `undefined` to a View prop.
 *
 * A LIST-valued channel read through here reads as `''` too, and deliberately: it used to
 * return `v[0]`, silently answering "which one column is this?" with the first of several.
 * That is the same first-of-N mistake as the resolver's own, on the read path every adapter
 * goes through — and it is worse there, because the caller asked a question the data cannot
 * answer and got a plausible column back. A caller that genuinely wants the list calls
 * {@link bindingList}; a caller that wants a single column and finds a list has a schema
 * mismatch, and `''` (no column) is the honest report of it.
 */
export function bindingValue(bindings: ResolvedBindings, id: string): string {
  const v = bindings[id]
  return typeof v === 'string' ? v : ''
}

/**
 * Read a MULTI-column channel's resolved values out of a model's bindings. A single-valued
 * channel is wrapped to a one-element list; an absent (or refused) channel yields `[]`.
 */
export function bindingList(bindings: ResolvedBindings, id: string): readonly string[] {
  const v = bindings[id]
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v ? [v] : []
  return []
}

/**
 * A resolution that REFUSED — the two statuses in which nobody has decided what to draw.
 *
 * A named subtype rather than a runtime check repeated at each call site, because the guard
 * and the message were briefly TWO guards: `ChartBody` filtered on `isRefusal(...)` and then
 * `refusalMessage` independently returned `null` for a non-refusal. Either alone blocked the
 * defect, so no single mutation of either was observable — the same "two spellings of one
 * rule plus a precedence question no input can make observable" that got
 * `carryCompatibleBindings` deleted rather than kept beside the binding memo (`1aa80af8`).
 *
 * There is one decision now — {@link asRefusal} — and the TYPE carries it: `refusalMessage`
 * cannot be called with a `bound` / `unbound` resolution at all, so "we rendered a refusal
 * over a deliberate choice" is a compile error rather than a thing a test has to catch.
 */
export type BindingRefusal = Extract<
  BindingResolution,
  { status: 'absent' } | { status: 'ambiguous' }
>

/**
 * THE gate: the refusal in a resolution, or `undefined` when there was none.
 *
 * This is the FACT a render keys off (INV-5). The tempting alternative —
 * `!bindings[channel.id]` — is vacuous: a channel that is deliberately `unbound` is also
 * absent from `bindings`, so that test cannot tell a refusal from a decision, and would put
 * "choose a column" over every chart an author intentionally left unbound.
 */
export function asRefusal(r: BindingResolution | undefined): BindingRefusal | undefined {
  return r?.status === 'absent' || r?.status === 'ambiguous' ? r : undefined
}

/**
 * The human sentence for a refusal, naming the CANDIDATES and not merely the fact.
 *
 * "This binding is ambiguous" is not actionable; "these columns all qualify" is — the same
 * reasoning `contract.ts::axisAmbiguousMessage` and `axisEntryRows::ambiguousGroupingRefusal`
 * already apply to axes and grouping columns. The list is capped at
 * {@link REFUSAL_CANDIDATE_PREVIEW} because a catalog can carry hundreds of value columns and
 * a refusal that overflows its pane is a second defect.
 *
 * Takes a {@link BindingRefusal}, so it is TOTAL: there is no non-refusal input and therefore
 * no `null` return to double as a second gate.
 */
export function refusalMessage(label: string, r: BindingRefusal): string {
  if (r.status === 'absent') {
    return `${label}: this dataset has no ${r.source} column to bind.`
  }
  const shown = r.candidates.slice(0, REFUSAL_CANDIDATE_PREVIEW)
  const more = r.candidates.length - shown.length
  const list = more > 0 ? `${shown.join(', ')} +${more} more` : shown.join(', ')
  return `${label}: ${r.candidates.length} columns qualify and nothing chooses between them — ${list}. Pick one.`
}
