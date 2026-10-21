// THE AXIS-ENTRY SEAM (visualize-pane ITEM-24 / ITEM-25 / ITEM-26 / ITEM-27) — the two
// `$data` sources that answer, for the row space the pane is anchored on, *"what can be
// chosen on one of its sibling axes, and what is a chosen thing MADE of?"*
//
// ── It is not a one-domain seam, and that is the whole instruction ─────────────────────
//
// DEC-12's instruction is that the old path served ONE domain's entries and one column each,
// and this one serves *"the axis equivalent of it"*. Two generalisations, and neither is
// optional:
//
//   1. **AXIS-GENERIC.** Nothing here names a domain entity or a datatype. An "entry" is one
//      key on a sibling axis of the anchored row space, whatever that axis holds. The label a
//      view writes is the PACKAGE's vocabulary; this resolver only resolves it.
//   2. **ONE ENTRY IS N COLUMNS.** {@link resolveEntrySources} answers a MAP to an ARRAY and
//      the engine never flattens it (INV-19). One entry, in a row space carrying two
//      artifacts indexed by its axis, is ONE entry and TWO sources; what happens to the two
//      is the CONSUMER's declared disposition (`each` / `combined` / `one` + `where`), never
//      this module's choice.
//
// ── Meta-first, on the same rule as `rowSpaceColumns` (INV-11) ──────────────────────────
//
// Every question that CAN be answered from declarations is: which axis, how long it is,
// which artifacts carry an entry, what they are called. The ONE read this seam ever issues
// is the entry KEYS themselves — because the keys are the choosable set and there is no
// declaration that enumerates them — and even that read is bounded by
// {@link ENTRY_BROWSE_MAX} and refused rather than truncated above it (ITEM-25).
//
// In particular the axis LENGTH is read off `AxisSummary.length` (the producer's own
// `structure.n`), never counted by reading the column. A length that cost a download would
// be INV-11's *"level count that became a column download"* one axis over.
//
// Pure + IO-injected: every function here is either pure over catalog rows or takes its read
// as a parameter, so the whole seam is unit-driven with synthetic rows and no backend.

import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { sharesSourceDataset, sourceDatasetIds } from '@/core/workstore'
import {
  candidateLabel,
  declaredAxes,
  declaredMemberships,
  matchesTypeFilter,
  offeredOnRowSpace,
  resolveRowSpaceAnchor,
  type ArtifactTypeFilter,
  type AxisResolveOptions,
  type RowSpaceAnchor,
} from './axisSource'
import { interpolateBraces } from './expr'

/** The `data.<slice>.source` value that selects the entry LISTING resolver. */
export const AXIS_ENTRIES_SOURCE = 'axis_entries'

/** The `data.<slice>.source` value that selects the entry VALUES resolver. */
export const AXIS_ENTRY_VALUES_SOURCE = 'axis_entry_values'

/** The `data.<slice>.args.as` value that asks {@link AXIS_ENTRY_VALUES_SOURCE} for each
 *  entry's PROVENANCE instead of its values — the same "one declaration, two questions"
 *  pairing `axis_columns`' `as: sources` established, and deliberately not a second source
 *  name, so the two answers describe the same candidate set by construction. */
export const AXIS_ENTRY_VALUES_AS_SOURCES = 'sources'

/**
 * How many entries an axis may carry and still be offered as a BROWSE LIST.
 *
 * A named, exported constant with its provenance recorded here rather than a bare literal
 * (DEC-7), and deliberately NOT admin-configurable: the workbench has no admin-settings
 * surface to configure it from, so "configurable" would mean inventing a settings table, a
 * REST pair, a permission and a card for one integer — the same shape of error as ITEM-40's
 * *"inventing a budget to make an affordance safe"*. The repo's precedent for a bounded
 * tunable with no configuring surface is a documented named constant beside its reasoning
 * (`colsummary.py`'s `MAX_SUMMARY_CATEGORIES` / `MAX_SUMMARY_CATEGORIES_BYTES`).
 *
 * **The number is INFERRED from one measurement, not measured at the boundary** (design
 * §12), and the next person changing it should know which measurement: the eager read of a
 * 10M × 18-char string column costs 979 ms and 580 MB of heap (`openStringColumn`'s own
 * header). 200k is roughly two orders of magnitude below that — comfortably a few MB and a
 * few tens of milliseconds — and is chosen to sit far above the smaller axis of a
 * typical two-axis artifact (10⁴) and far below its larger one (10⁶–10⁷), which is the
 * distinction it exists to make. It is not a measured cliff.
 *
 * Above it the browse list is **refused, not truncated** (ITEM-25): *"a truncated list with
 * a search box is `layouts[0]` wearing better clothes"* — it silently answers a question
 * about the first N entries while looking like an answer about the axis.
 */
export const ENTRY_BROWSE_MAX = 200_000

// ── which axis? ─────────────────────────────────────────────────────────────────────────

/** The sibling axis a section's entry list is about, resolved WITHIN the anchored row
 *  space. */
export interface EntryAxis {
  /** the key artifact that IS this axis — the thing whose column holds the entry keys. */
  artifact: string
  /** its identity (`AxisSummary.content_hash`). Display never keys on it; a JOIN does. */
  contentHash: string
  /** the declared axis LABEL. Display only, exactly as `AxisSummary.name` is. */
  label: string
  /** how many entries it declares — the producer's own `structure.n`, as the server
   *  summarised it. NEVER a count obtained by reading (INV-11). */
  length: number
  /** the producer-declared `structure` of the key artifact, so a caller reading the keys
   *  needs no second `GET /artifacts/{id}`. */
  structure: unknown
  /**
   * WHICH ROW SPACE this sibling was resolved within — the anchor `content_hash` it came from
   * (dimension-membership ITEM-19).
   *
   * An integrated coordinate rests on TWO row-space axes and therefore has TWO siblings under
   * one label, one per dataset. The correspondence between them is joined by index PAIRS, and
   * the MEMBERSHIP that says which of the coordinate's rows each side contributes lives on the
   * ROW-SPACE axis, not on the sibling. So the sibling has to remember which row space it
   * belongs to, or the pairing has nothing to join the membership back on to.
   *
   * `undefined` only when the axis was resolved with no anchor hash to record, which the
   * resolvers below never do — it is optional so that a fixture building an `EntryAxis` by hand
   * for the SCALAR case (where there is exactly one row space and no pairing) is unaffected.
   */
  rowSpace?: string
}

/**
 * Why an entry axis could not be resolved — each a DIFFERENT emptiness, because ITEM-63
 * requires a section to say WHICH one it is and a single `undefined` can say only one.
 *
 * `ambiguous` is the case a `[0]` would have hidden: two sibling axes of the anchored row
 * space carrying the SAME label. The design permits `axis:` to be a label precisely because
 * *"within one resolved row space the sibling axes are unambiguous"* — so when they are
 * not, the honest answer is to refuse and say so, not to take the first (INV-3/R2).
 */
export type EntryAxisAbsence = 'no_anchor' | 'no_such_axis' | 'ambiguous'

export type EntryAxisResolution =
  | { readonly ok: true; readonly axis: EntryAxis }
  | { readonly ok: false; readonly because: EntryAxisAbsence; readonly candidates: number }

/**
 * The sibling axis labelled `label` within the row space `anchorContentHash` names.
 *
 * PURE over the catalog. The join is the one DEC-5 rules for every identity question in this
 * pane: locate the ANCHOR by `content_hash`, then look for key artifacts that belong to the
 * same source dataset(s) and declare `label` as an axis.
 *
 * **What makes an artifact a KEY artifact is not read from `meta` here.** The server already
 * made that judgement — `derive_axes` selects `meta.is_axis_index` and dedupes on
 * `content_hash` — and it publishes the answer as the catalog's `axes` list. So membership
 * of that list IS the predicate, which keeps the frontend from acquiring a second, drifting
 * opinion about what a key artifact is (the phase-2 finding that no production FE code reads
 * `meta.*`, honoured where it can be).
 *
 * The ANCHOR itself is excluded: it is the row space, not one of its sibling axes, and a
 * section asking for "the entries of my own row space" would be asking a different question
 * (and would get it by naming its own label).
 */
export function resolveEntryAxis(
  artifacts: readonly ArtifactRow[],
  axes: readonly AxisSummary[],
  anchorContentHash: string | null | undefined,
  label: string | undefined,
): EntryAxisResolution {
  if (typeof anchorContentHash !== 'string' || anchorContentHash === '' || !label) {
    return { ok: false, because: 'no_anchor', candidates: 0 }
  }
  const anchorRow = artifacts.find(a => a.content_hash === anchorContentHash)
  if (!anchorRow) return { ok: false, because: 'no_anchor', candidates: 0 }
  const byHash = new Map(axes.map(a => [a.content_hash, a]))
  // A row space with no resolvable source dataset cannot be asked about its siblings: the
  // set is not one anyone can enumerate, and widening to the project would silently offer
  // another row space's entries — the fallback INV-4 forbids.
  const anchorDatasets = sourceDatasetIds(anchorRow).length > 0
  const matches = artifacts.filter(
    a =>
      a.id !== anchorRow.id &&
      typeof a.content_hash === 'string' &&
      a.content_hash !== anchorContentHash &&
      byHash.has(a.content_hash) &&
      declaredAxes(a.structure).includes(label) &&
      anchorDatasets &&
      sharesSourceDataset(anchorRow, a),
  )
  const distinct = new Set(matches.map(a => a.content_hash as string))
  if (distinct.size === 0) return { ok: false, because: 'no_such_axis', candidates: 0 }
  if (distinct.size > 1) return { ok: false, because: 'ambiguous', candidates: distinct.size }
  // ── TEST-16 (ITEM-11c): DETERMINISM, not refusal ────────────────────────────────────────
  //
  // The guard above counts DISTINCT CONTENT HASHES; `matches` holds artifact ROWS, and two rows
  // can carry one hash. So `matches[0]` — what this used to be — was reachable with more than
  // one candidate, and which one it returned was the order the catalog happened to arrive in.
  //
  // This is a DETERMINISM defect and NOT a data defect, and the distinction decides the fix.
  // An axis IS its key artifact and its identity IS that content hash (INV-3), so two rows
  // sharing one hash are byte-identical: `length`, `structure` and every value read off either
  // is the same, and the READ is correct whichever is taken. Refusing here — the answer the
  // sibling `ambiguous` arm gives — would therefore break a working surface for no
  // data-correctness gain, and would refuse the *commonest* benign shape (one axis registered
  // twice, e.g. re-imported or copied between datasets).
  //
  // What IS wrong is that `axis.artifact` is a picker KEY and a stored-choice target: a user's
  // saved selection, a React key and a cache entry all keyed on an id that can change between
  // two reads of the same catalog. So the pick is made deterministic — lowest id, sorted — and
  // the same catalog now always answers with the same artifact, however the rows are ordered.
  const row = [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  const hash = row.content_hash as string
  return {
    ok: true,
    axis: {
      artifact: row.id,
      contentHash: hash,
      label,
      length: byHash.get(hash)?.length ?? 0,
      structure: row.structure,
      rowSpace: anchorContentHash,
    },
  }
}

/**
 * The sibling axes labelled `label`, ONE PER ROW-SPACE AXIS the anchor rests on (ITEM-19).
 *
 * ── WHY THIS IS A COMPOSITION OVER THE SCALAR AND NOT A WIDER SCALAR ────────────────────────
 *
 * The question {@link resolveEntryAxis} answers is *"which sibling of THIS row space"*, and its
 * `ambiguous` arm rests on the design's own clause: *"within one resolved row space the sibling
 * axes are unambiguous"*. Widening that function to take a LIST would have made `ambiguous` mean
 * two different things at once — two siblings within one row space (a genuine refusal) and one
 * sibling per row space across two (the correspondence, which is the normal state of an
 * integrated coordinate and must NOT refuse). So the per-row-space question keeps its own
 * function and its own refusal, and the plural composes over it.
 *
 * ── ALL OR NOTHING (ITEM-8's rule, applied to the sibling) ──────────────────────────────────
 *
 * If ANY named row space fails to resolve a sibling, the WHOLE answer is the refusal. It does
 * not resolve on the ones that did. A correspondence built from a subset of the anchor's axes
 * covers a subset of the anchor's rows, so every value it produced would be laid against
 * positions belonging to rows it never described — full-length only if something later padded
 * it, and short and silently index-shifted otherwise. Both are the failure this model exists to
 * make impossible, and `resolveRowSpaceAnchor` already refuses partial anchors for exactly this
 * reason.
 *
 * The returned order is the order the anchor's hashes were given in. It is NOT sorted: a
 * coordinate's segment order is its own declaration (INV-7), and every consumer below reads the
 * segment order off the ANCHOR rather than off this list, so nothing here can impose one.
 */
export type EntryAxesResolution =
  | { readonly ok: true; readonly axes: readonly EntryAxis[] }
  | { readonly ok: false; readonly because: EntryAxisAbsence; readonly candidates: number }

export function resolveEntryAxes(
  artifacts: readonly ArtifactRow[],
  axes: readonly AxisSummary[],
  anchorContentHashes: readonly string[] | null | undefined,
  label: string | undefined,
): EntryAxesResolution {
  const wanted = Array.isArray(anchorContentHashes)
    ? [...new Set(anchorContentHashes.filter(h => typeof h === 'string' && h !== ''))]
    : []
  if (wanted.length === 0) return { ok: false, because: 'no_anchor', candidates: 0 }
  const resolved: EntryAxis[] = []
  for (const hash of wanted) {
    const one = resolveEntryAxis(artifacts, axes, hash, label)
    if (!one.ok) return one
    resolved.push(one.axis)
  }
  return { ok: true, axes: resolved }
}

// ── source 1: `axis_entries` — what can be chosen ───────────────────────────────────────

/** What one `axis_entries` slice resolves to. ALWAYS total: every absence is a state in the
 *  payload rather than a missing slice, because a view has to be able to say WHICH emptiness
 *  it is looking at and a slice STATUS carries only one of them (the same rule
 *  `row_space_columns` follows). */
export interface AxisEntries {
  /** the entry keys, in the axis's own order — `[]` unless {@link browsable}. The KEY is the
   *  identity; nothing here is a display label (INV-1). */
  entries: readonly string[]
  /** how many entries the axis DECLARES — present even when the list is refused, because
   *  "4.1M entries" is exactly what makes the refusal legible. `0` when unresolved. */
  length: number
  /** whether a row space is anchored at all (A0 vs anchored-and-empty). */
  anchored: boolean
  /** whether the axis resolved and its entries were listed. */
  browsable: boolean
  /** WHY there is no browse list, or `null` when there is one. A non-empty string IS the
   *  refusal — the same gate shape `unavailableReason` uses (ITEM-29c), so a refused list
   *  can never be refused silently. */
  refusal: string | null
}

/** The empty answer — no anchor, nothing attempted, nothing claimed. */
export const NO_AXIS_ENTRIES: AxisEntries = {
  entries: [],
  length: 0,
  anchored: false,
  browsable: false,
  refusal: null,
}

/**
 * Which read strategy an axis of `length` gets — the ENGINE's choice, never the view's
 * (ITEM-25).
 *
 * A view declares WHICH axis and nothing else, so there is no per-view spelling of this rule
 * to get wrong and no way for a spec to opt into the read the bound exists to prevent.
 */
export function entryBrowseStrategy(length: number): 'browse' | 'exact' {
  return length <= ENTRY_BROWSE_MAX ? 'browse' : 'exact'
}

/**
 * The sentence an over-budget axis states instead of a list. It names the SIZE, because the
 * size is the reason, and it names what was NOT done with the rest, because a refusal that
 * only says "no" leaves the reader unable to tell it from a list that failed to load.
 *
 * ── It no longer promises "type an exact key" ──────────────────────────────────────────
 *
 * It used to end *"Type an exact key to choose one."* — a control that does not exist. The
 * section declares an `alert` and an `entry_list`, and the `entry_list`'s search box renders
 * only in the non-empty branch, so on precisely this state there was nothing to type into.
 *
 * The exact-key path is not simply unbuilt UI: it cannot be honoured under this seam's own
 * read budget as the value path stands today. A plot of an entry is addressed by the entry's
 * POSITION on its axis (`readOneEntryColumn` windows a `sparse_csc` `indptr` by it, and
 * `column_values` falls back to `position ?? 0` — so a typed key with an unknown position
 * plots column ZERO under the typed name, silently, which is the exact substitution this
 * module refuses everywhere else). The only key→position answer that exists today is
 * `entryKeysOf`, i.e. reading the WHOLE key column — the read this refusal exists to prevent.
 * A targeted lookup would have to be a new engine/read-port capability; until there is one,
 * the honest surface is one that promises nothing.
 */
export function entryBrowseRefusal(label: string, length: number): string {
  return (
    `This ${label} axis has ${length.toLocaleString()} entries — too many to list, so none of ` +
    'them are offered here rather than the first few being listed as if they were the axis.'
  )
}

/** The sentence for each way the AXIS itself failed to resolve. Distinct strings, because
 *  ITEM-63's rule is that every emptiness says which one it is. */
export function entryAxisRefusal(label: string, absence: EntryAxisAbsence, candidates: number): string | null {
  switch (absence) {
    case 'no_anchor':
      return null // A0 — the section says this in its own declared sentence, once.
    case 'no_such_axis':
      return `These rows declare no ${label} axis.`
    default:
      return (
        `These rows declare ${candidates} different ${label} axes, so the name does not ` +
        'identify one. Nothing is offered rather than one of them being picked for you.'
      )
  }
}

/** Read the entry keys of an axis. Injected, so this module does no IO. Resolves the KEYS in
 *  the axis's own order — the order IS the identity of a position, which is what lets a
 *  values read address a column by index. */
export type ReadEntryKeys = (axis: EntryAxis) => Promise<readonly string[]>

/** The `args` an `axis_entries` slice declares. */
export interface AxisEntriesArgs {
  /** a `$`-ref to the anchored row space's identity (an `AxisSummary.content_hash`,
   *  ITEM-10). Unresolved ⇒ the EMPTY answer, never a project-wide fallback (INV-4). */
  axis_of?: string
  /** the sibling axis's declared LABEL, within that row space. */
  axis?: string
}

/**
 * Resolve an `axis_entries` slice.
 *
 * The read is issued ONLY on the browse arm, and only after the axis has resolved — so an
 * unanchored pane, an absent axis, an ambiguous label and an over-budget axis all cost ZERO
 * bytes. That ordering is the whole of ITEM-25: the strategy is decided from a DECLARED
 * length before anything is opened.
 */
export async function resolveAxisEntries(
  artifacts: readonly ArtifactRow[],
  axes: readonly AxisSummary[],
  args: AxisEntriesArgs,
  anchorContentHashes: readonly string[] | null | undefined,
  read: ReadEntryKeys,
): Promise<AxisEntries> {
  const label = args.axis ?? ''
  const resolved = resolveEntryAxes(artifacts, axes, anchorContentHashes, args.axis)
  if (!resolved.ok) {
    return {
      ...NO_AXIS_ENTRIES,
      anchored: resolved.because !== 'no_anchor',
      refusal: entryAxisRefusal(label, resolved.because, resolved.candidates),
    }
  }
  const siblings = resolved.axes
  // THE WIDEST side decides the strategy, and the read set is the UNION of the sides (ITEM-19).
  // Taking the narrowest would refuse to browse a correspondence whose OTHER side is over the
  // budget, after reading it — the bound would be enforced on the wrong number.
  const widest = siblings.reduce((a, b) => (b.length > a.length ? b : a))
  if (entryBrowseStrategy(widest.length) === 'exact') {
    return {
      entries: [],
      length: widest.length,
      anchored: true,
      browsable: false,
      refusal: entryBrowseRefusal(widest.label, widest.length),
    }
  }
  const perSide = await Promise.all(siblings.map(read))
  // ONE SIDE ⇒ its keys, untouched. Byte-for-byte the previous answer, including `length`, which
  // stays the axis's DECLARED count rather than the read one (INV-11: a count obtained by
  // reading is not the producer's declaration, and the two are allowed to differ).
  const first = perSide.reduce(a => a)
  if (perSide.length === 1) {
    return { entries: first, length: widest.length, anchored: true, browsable: true, refusal: null }
  }
  // SEVERAL ⇒ the CORRESPONDENCE's domain: the entries present on EVERY side, in the first
  // side's order. An entry on only one side cannot be read across the coordinate's whole row
  // sequence (INV-6 joins by index PAIRS, and there is no pair for it), so offering it would
  // offer a choice that resolves to nothing the moment it is made.
  const rest = perSide.filter(side => side !== first).map(side => new Set(side))
  const entries = first.filter(key => rest.every(side => side.has(key)))
  // …and here `length` is the CORRESPONDENCE's size, not any one side's declaration: no producer
  // declared this number, because no producer declared the correspondence.
  return { entries, length: entries.length, anchored: true, browsable: true, refusal: null }
}

// ── source 2: `axis_entry_values` — what a chosen entry IS ───────────────────────────────

/** One SOURCE a chosen entry resolved to. `(artifact, selector)` is the identity (INV-1);
 *  `title` and `name` are display/binding labels and are never joined on. */
export interface EntrySource {
  /** the artifact carrying this entry's values. */
  artifact: string
  /** WHICH part of it — the entry key. An artifact may carry thousands of entries, so the
   *  artifact id alone does not identify a column. */
  selector: string
  datatype: string
  /** what the source READS as (the producer's own display name for the artifact). */
  title: string
  /** the COLUMN NAME the view declared for this (entry, source) pair — the key it will
   *  appear under in the values frame, so the two answers agree by construction. */
  name: string
  /**
   * THE CORRESPONDENCE, when the anchor rests on more than one row space (ITEM-19, INV-6).
   *
   * `undefined` on a single-axis anchor, which is every pane today: the artifact IS the whole
   * source and this record is byte-for-byte what it was. Present on an INTEGRATED coordinate,
   * where one logical entry is described by ds1's matrix at one index and ds2's at ANOTHER, and
   * the two together are what covers the coordinate's rows.
   *
   * ORDERED — one element per row-space axis, in the order {@link resolveEntryAxes} resolved
   * them. The emitted ROW sequence is NOT read off this order, though: it is read off the
   * ANCHOR's declared membership order (INV-7), because a membership is a set and this list is
   * a resolution artefact rather than a declaration.
   *
   * `artifact` above stays the PRIMARY member — one plain id, never a delimited composed one
   * (INV-4) — and the full set is resolved from here rather than parsed back out of it. Anything
   * that RECORDS or EXPORTS a correspondence must contribute EVERY member of this list, not just
   * the primary: provenance records resolved artifacts and refuses unknown ones, so recording
   * one id resolves fine and reports nothing while the colouring used two (ITEM-35's constraint,
   * which is the same hole one surface over).
   */
  readonly pairs?: readonly EntryPair[]
}

/** ONE side of a correspondence — WHICH artifact, and WHICH row space it describes. Structured,
 *  independently readable, never a delimited string (INV-4). */
export interface EntryPair {
  /** the artifact carrying this side's values. */
  readonly artifact: string
  /** the ENTRY axis this side's index is a position into — the sibling, not the row space. */
  readonly entryAxis: string
  /** the ROW-SPACE axis identity this side describes. The anchor's membership on THIS axis is
   *  what says which of the coordinate's rows the side contributes, so the join needs it. */
  readonly rowSpace: string
}

/** `{ <entryKey>: EntrySource[] }` — a MAP to an ARRAY, and the engine NEVER flattens it
 *  (INV-19). An entry present with `[]` is the U1 state: chosen, and resolved to nothing. */
export type EntrySources = Record<string, EntrySource[]>

/** The default column-name template. Names the ENTRY and the SOURCE, because with two
 *  sources for one entry the entry alone does not name a column — which is the collision the
 *  load error below refuses. */
export const DEFAULT_ENTRY_VALUE_NAME = '{entry} · {source.title}'

/** The `args` an `axis_entry_values` slice declares. */
export interface AxisEntryValuesArgs extends ArtifactTypeFilter {
  axis_of?: string
  axis?: string
  /** a `$`-ref to the CHOSEN entry keys. Nothing is read before a choice. */
  entries?: string
  /** the column NAME template, `{}`-interpolated per (entry, source) — the view declares the
   *  name (INV-6), because only the view knows what its own canvas binds. */
  name?: string
  /** `sources` asks for provenance instead of values. */
  as?: string
}

/**
 * A `name` template collision — two (entry, source) pairs claiming one column name.
 *
 * A LOAD ERROR naming BOTH, never a silent overwrite: the frame is `{name: values[]}`, so an
 * overwrite is one entry's values appearing under another entry's name, which reads as a
 * working plot of the wrong thing. This is the same substitution `mintColumnKeys` refuses one
 * axis over, and it is refused here rather than qualified because the name is the VIEW's
 * declaration: the author can fix it, and a template that cannot name its own outputs apart
 * is a defect in the declaration rather than an ambiguity in the data.
 */
export class EntryValueNameCollision extends Error {
  constructor(
    readonly name: string,
    readonly first: EntrySource,
    readonly second: EntrySource,
  ) {
    super(
      `axis_entry_values: the declared name "${name}" is claimed by two sources — ` +
        `${first.selector} in artifact ${first.artifact} and ${second.selector} in artifact ` +
        `${second.artifact}. Widen the \`name\` template so every source names one column.`,
    )
    this.name = 'EntryValueNameCollision'
  }
}

/**
 * Which artifacts can serve entries of `axis` against the anchored row space — PURE, and the
 * whole of the provenance answer.
 *
 * Two filters, and they are the two the engine always applies together (design §6.1):
 * `matchesTypeFilter` is about KIND (what the view declared it wants), and
 * {@link offeredOnRowSpace} is about IDENTITY (are these values about THESE rows?). A raw
 * matrix belonging to ds1 is exactly the candidate the second one exists to drop when the
 * pane is anchored on the integrated row space — §5.7's *"one rule, stated once"*.
 *
 * The third condition is what makes the entry-axis membership decidable from DECLARATIONS
 * alone: an artifact that declares this axis is indexed by its keys, so it carries every
 * entry of it. No artifact is opened to find out whether it holds `CD8A`.
 */
export function entryValueCandidates(
  artifacts: readonly ArtifactRow[],
  axis: EntryAxis,
  anchor: RowSpaceAnchor | undefined,
  filter: ArtifactTypeFilter,
  opts?: AxisResolveOptions,
): ArtifactRow[] {
  return offeredOnRowSpace(
    artifacts.filter(
      a =>
        a.id !== axis.artifact &&
        declaredAxes(a.structure).includes(axis.label) &&
        matchesTypeFilter(a, filter, opts),
    ),
    anchor,
  )
}

/**
 * `{ entry → [sources] }` for the chosen entries. PURE — no read port, no network.
 *
 * EVERY chosen entry appears as a key, including one that resolved to zero sources: that is
 * the U1 state (`unresolved_text`), and dropping the key would make "chosen and unresolved"
 * indistinguishable from "not chosen" — the distinction `entry_list` exists to render.
 */
export function resolveEntrySources(
  artifacts: readonly ArtifactRow[],
  entryAxes: readonly EntryAxis[],
  anchor: RowSpaceAnchor | undefined,
  entries: readonly string[],
  args: AxisEntryValuesArgs,
  opts?: AxisResolveOptions,
): EntrySources {
  const groups = correspondenceGroups(artifacts, entryAxes, anchor, args, opts)
  const template = typeof args.name === 'string' && args.name.trim() !== '' ? args.name : DEFAULT_ENTRY_VALUE_NAME
  const out: EntrySources = {}
  const claimed = new Map<string, EntrySource>()
  for (const entry of entries) {
    if (entry in out) continue // one chosen entry is one key, however many times it was named
    const sources: EntrySource[] = []
    for (const group of groups) {
      const source: EntrySource = {
        artifact: group.primary.id,
        selector: entry,
        datatype: group.primary.datatype,
        title: candidateLabel(group.primary),
        name: '',
        ...(group.pairs ? { pairs: group.pairs } : {}),
      }
      source.name = interpolateBraces(template, { entry, source })
      const prior = claimed.get(source.name)
      if (prior) throw new EntryValueNameCollision(source.name, prior, source)
      claimed.set(source.name, source)
      sources.push(source)
    }
    out[entry] = sources
  }
  return out
}

/** One offerable source before an entry is named to it — the artifact its display and identity
 *  come from, plus the correspondence's other sides when there are any. */
interface CorrespondenceGroup {
  readonly primary: ArtifactRow
  readonly pairs?: readonly EntryPair[]
}

/**
 * The candidates, GROUPED into correspondences (ITEM-19).
 *
 * ── THE SINGLE-AXIS CASE IS UNTOUCHED, DELIBERATELY ─────────────────────────────────────────
 *
 * One row space ⇒ every candidate is its own group, in candidate order, with no `pairs`. That
 * is byte-for-byte the previous behaviour and it is guarded rather than emergent: the grouping
 * rule below would otherwise FOLD two same-named candidates of one dataset into one ambiguous
 * group and drop both, which would delete offers from every existing pane. A correspondence
 * exists only ACROSS axes, so it only applies across axes.
 *
 * ── THE PAIRING RULE, AND WHY AN UNPAIRED CANDIDATE IS DROPPED ──────────────────────────────
 *
 * Across two row spaces the join is on the candidate's own DECLARATIONS — its datatype and its
 * producer-declared display title — because those are what the catalog carries and INV-8 forbids
 * opening a body to decide an offer. A group is offered only when it has EXACTLY ONE candidate
 * on EVERY axis:
 *
 *   · a group missing an axis describes only part of the coordinate's rows, so its values would
 *     be laid against positions belonging to rows it never described — and there is no honest
 *     filler for the rest (a zero is a confident claim that the entry is absent there).
 *   · a group with TWO candidates on one axis has not identified which one corresponds, and
 *     picking either is `[0]` with a join wrapped round it.
 *
 * Dropping is not silent: an entry whose every group is incomplete resolves to `[]`, which is
 * the U1 `unresolved_text` state the entry list already renders as "chosen and unresolved".
 * That distinction is exactly what an empty key is for.
 */
function correspondenceGroups(
  artifacts: readonly ArtifactRow[],
  entryAxes: readonly EntryAxis[],
  anchor: RowSpaceAnchor | undefined,
  args: AxisEntryValuesArgs,
  opts?: AxisResolveOptions,
): CorrespondenceGroup[] {
  const sole = entryAxes.length === 1 ? entryAxes.reduce(first => first) : undefined
  if (sole) {
    return entryValueCandidates(artifacts, sole, anchor, args, opts).map(primary => ({ primary }))
  }
  // WHICH SIDE DOES A CANDIDATE DESCRIBE? Its own declared alignment, against the row-space
  // axis's key-sequence digest (ITEM-19). `entryValueCandidates` narrows by the ENTRY axis's
  // LABEL, and both siblings carry the same label — so without this second narrowing every
  // candidate would appear on BOTH sides, every group would hold two candidates per side, and
  // the completeness rule below would reject every one of them.
  const digestOf = new Map(anchor?.axes.map(a => [a.contentHash, a.keySequenceDigest]) ?? [])
  const describes = (row: ArtifactRow, rowSpace: string | undefined): boolean => {
    const digest = rowSpace === undefined ? undefined : digestOf.get(rowSpace)
    if (digest === undefined) return false
    return declaredMemberships(row.structure).some(m => m.alignedTo === digest)
  }
  const perAxis = entryAxes.map(axis => ({
    axis,
    candidates: entryValueCandidates(artifacts, axis, anchor, args, opts).filter(row =>
      describes(row, axis.rowSpace),
    ),
  }))
  /** The declaration-only join key. Two candidates correspond when they are the same KIND of
   *  thing under the same declared name; neither term is a body read. */
  const joinKey = (row: ArtifactRow): string => JSON.stringify([row.datatype, candidateLabel(row)])
  const byKey = new Map<string, Map<string, ArtifactRow[]>>()
  for (const { axis, candidates } of perAxis) {
    for (const row of candidates) {
      const key = joinKey(row)
      let sides = byKey.get(key)
      if (!sides) {
        sides = new Map()
        byKey.set(key, sides)
      }
      const forAxis = sides.get(axis.contentHash) ?? []
      forAxis.push(row)
      sides.set(axis.contentHash, forAxis)
    }
  }
  const groups: CorrespondenceGroup[] = []
  for (const sides of byKey.values()) {
    const complete = perAxis.every(({ axis }) => sides.get(axis.contentHash)?.length === 1)
    if (!complete) continue
    const pairs = perAxis.map(({ axis }) => {
      const forAxis = sides.get(axis.contentHash) as ArtifactRow[]
      const row = forAxis.reduce(first => first)
      return { artifact: row.id, entryAxis: axis.contentHash, rowSpace: axis.rowSpace ?? '' }
    })
    // The PRIMARY is the side belonging to the FIRST row space the anchor named — a stated
    // choice, not `pairs[0]` taken because it was there. It is what `artifact` carries, what
    // display and `where` narrow on, and what a stored pick round-trips as; the other sides
    // are resolved from `pairs` and never parsed back out of it (INV-4).
    const primaryId = pairs.reduce(first => first).artifact
    const primary = artifacts.find(a => a.id === primaryId)
    if (!primary) continue
    groups.push({ primary, pairs })
  }
  return groups
}

// ── the `one` disposition's narrowing (ITEM-27 / INV-19) ────────────────────────────────

/** What a `where` may narrow over — the column's OWN DECLARATIONS, never a position. There is
 *  deliberately no `index`, no `first` and no ordering term: the whole point of `one` is that
 *  the author states which column they mean, and any positional term would be `[0]` with a
 *  declaration wrapped round it. */
export interface EntryWhere {
  datatype?: string
  artifact?: string
}

/**
 * Narrow an entry's sources to exactly one.
 *
 * ≠ 1 match is an ERROR SURFACED ON THE CONTROL, never a first match: a `where` that matches
 * two is an under-specified declaration and a `where` that matches none is a claim about data
 * that is not there, and both produce a plot that looks correct. The return carries the
 * SENTENCE, on the `unavailableReason` gate shape (ITEM-29c) — a non-empty string IS the
 * refusal — so a consumer cannot refuse silently.
 */
export function narrowToOne(
  sources: readonly EntrySource[],
  where: EntryWhere | undefined,
): { source: EntrySource; refusal?: undefined } | { source?: undefined; refusal: string } {
  const matched = sources.filter(
    s =>
      (where?.datatype === undefined || s.datatype === where.datatype) &&
      (where?.artifact === undefined || s.artifact === where.artifact),
  )
  if (matched.length === 1) return { source: matched[0] }
  const said = where ? JSON.stringify(where) : '(no `where`)'
  return {
    refusal:
      matched.length === 0
        ? `No column of this entry matches ${said}. Nothing is plotted rather than a different column being substituted.`
        : `${matched.length} columns of this entry match ${said} — the disposition is "one", so narrow it further. The first is not taken.`,
  }
}

/** Read ONE entry's values off one source. Injected — the columnar arm's only IO.
 *  `position` is the entry's index on its axis, which is what a column-indexed encoding
 *  (a CSC matrix) addresses; a reader for a name-addressed encoding ignores it. */
export type ReadEntryValues = (
  source: EntrySource,
  positions: readonly number[],
) => Promise<readonly number[]>

/** A columnar frame — the same `{ column: values[] }` shape every other source lands, so a
 *  consumer swaps sources without touching what reads it. */
export type EntryValueFrame = Record<string, readonly number[]>

/**
 * The columnar arm: every (entry, source) pair's values, under the view's declared names.
 *
 * `positionOf` maps an entry key to its index on the axis — supplied by the caller because
 * the caller is the one that read the keys (once, for the browse list) and can answer it for
 * free. An entry the caller cannot position is SKIPPED rather than guessed at: an index taken
 * from anywhere but the axis's own order addresses a different column, silently.
 *
 * A source that fails to read costs that column alone, not the frame — the same tolerance
 * `readAxisColumnsFrame` applies for the same reason ("one column is unreadable" and "there
 * is nothing here" are different situations).
 */
export async function readEntryValuesFrame(
  sources: EntrySources,
  positionOf: (entry: string, entryAxis?: string) => number | undefined,
  read: ReadEntryValues,
): Promise<EntryValueFrame> {
  const out: Record<string, readonly number[]> = {}
  const flat: EntrySource[] = []
  for (const list of Object.values(sources)) flat.push(...list)
  await Promise.all(
    flat.map(async source => {
      // ONE POSITION PER SIDE, each looked up on that side's OWN axis (ITEM-19 / INV-6). This is
      // the whole of the correspondence at this tier: the same entry key is at index *i* on one
      // axis and index *j* on another, and a single position applied to both sides is the
      // index-identity implementation — full length, well typed, and wrong for every row of the
      // second side.
      const sides: readonly { artifact: string; entryAxis?: string }[] =
        source.pairs ?? [{ artifact: source.artifact }]
      const positions: number[] = []
      for (const side of sides) {
        const position = positionOf(source.selector, side.entryAxis)
        // A side the caller cannot position is SKIPPED — the whole source, not just that side.
        // Reading the remaining sides would answer a shorter column that every consumer treats
        // as index-parallel with the coordinate's rows and is not.
        if (position === undefined) return
        positions.push(position)
      }
      try {
        out[source.name] = await read(source, positions)
      } catch (e) {
        console.error(
          `[declarative] axis_entry_values: read failed for "${source.selector}" in artifact ${source.artifact}`,
          e,
        )
      }
    }),
  )
  return out
}
