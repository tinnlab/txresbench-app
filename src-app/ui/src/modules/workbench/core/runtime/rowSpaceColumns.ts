// The META-ONLY column listing for a section anchored on a row space
// (visualize-pane ITEM-37 / ITEM-38 / ITEM-39 / ITEM-41, and the listing half of ITEM-44).
//
// ── Why this is not `columns_of` ────────────────────────────────────────────────────────
//
// PLAN ITEM-44 says the categorical/continuous split "already ships" as
// `columns_of { only: categorical }` / `{ only: continuous }`. It does — but `columns_of`
// takes a COLUMNAR FRAME (`Record<string, unknown[]>`) and classifies each column by
// LOOKING AT ITS VALUES (`controlOfColumn(v)`). Reaching it therefore means resolving an
// `axis_columns` slice first, which READS EVERY COLUMN'S BODY.
//
// INV-11 forbids exactly that: *"The pane populates its lists from `meta` alone. It never
// reads a column body to describe a column. A picker that scans is the 580 MB eager read in
// a new costume — and worse than the one already caught, because it would fire on merely
// OPENING the pane."* A section listing forty columns on open is the population INV-11 was
// written about, so the split has to come from a declaration rather than from the data.
//
// It does, and it has since before this round: the producer already stamps
// `colsummary.summarize_column`'s dict verbatim into each `metadata-column` artifact's
// catalog `meta` — `kind` (`categorical`/`continuous`), `n_categories` (the TRUE distinct
// count, computed BEFORE either preview cap), `high_cardinality`, `min`/`max`/`mean`,
// `n`/`n_missing`. Every fact a row states is on the catalog row the pane has already
// fetched, so this resolver issues ZERO data-plane reads by construction: it never touches
// the read port at all, and `rowSpaceColumns.test.ts` asserts that against a spying port.
//
// ── What it is NOT allowed to know ─────────────────────────────────────────────────────
//
// `ArtifactRow.meta`'s own doc-comment records that core does NOT read `meta.kind`, and
// that stands: it is a SEMANTIC classification which disagrees with the stored ENCODING in
// `structure` on real data (a bool column is `categorical` here and `numeric` there), so
// nothing that DISPATCHES may read it. This resolver never dispatches on it — it DESCRIBES
// with it, and the semantic classification is exactly the right one to describe with: a
// reader choosing what to colour by is asking the semantic question, not the storage one.
// The distinction is why the split lives here and not in a read path.
//
// Nothing here names a datatype, an axis label, a column name or a modality. It reads a
// producer's declared `kind` and reports it. WHICH kinds exist is the producer's
// vocabulary; the two this resolver can format a shape sentence for are the two
// `colsummary` declares, and an unrecognised one degrades to "shape not declared" rather
// than to a guess (ITEM-38).

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  alignmentState,
  candidateLabel,
  describedRows,
  describedRowsLine,
  isAxisArtifact,
  resolveRowSpaceAnchor,
  type RowSpaceAnchor,
} from './axisSource'
import { reconcileVocabularies, vocabDeclarationOf } from './vocabFusion'

/** The `data.<slice>.source` value that selects this resolver. */
export const ROW_SPACE_COLUMNS_SOURCE = 'row_space_columns'

/**
 * How many distinct levels a categorical column may carry and still be a colour legend
 * (ITEM-39).
 *
 * Named, exported and reasoned-about rather than a bare literal, on DEC-7's rule for
 * `ENTRY_BROWSE_MAX` and on the repo's own precedent (`colsummary.py`'s
 * `MAX_SUMMARY_CATEGORIES` / `MAX_SUMMARY_CATEGORIES_BYTES`, each documented at its
 * definition). The number is a LEGIBILITY bound, not a performance one: past roughly two
 * dozen swatches a categorical legend stops being readable as a legend, and a 4,102-level
 * identifier column is not a colouring at all. It is deliberately generous — the failure
 * this refuses is qualitative and obvious, and refusing a column somebody could still read
 * would be the worse error.
 *
 * It is keyed on `n_categories` and NEVER on `high_cardinality`, which is the phase-2
 * correction: `colsummary.py:168` defines that flag as `len(categories) < n_categories`,
 * i.e. "the PREVIEW is not the whole set, whichever cap trimmed it" — so a column with
 * eight levels and long labels that blow the 1024-byte preview budget is flagged
 * `high_cardinality: true` and is perfectly legible. The flag says the preview is partial;
 * it does not say the column is unplottable.
 */
export const MAX_LEGEND_LEVELS = 64

/** What a row reads when its producer declared no summary at all (ITEM-38).
 *
 *  NOT "not read", which would attribute the absence to the app — as if the pane had
 *  declined to look. Nothing was declined: the producer emitted no summary, and the
 *  sentence says so, because that is who can fix it. Exported so the spec pins the literal
 *  and the attribution cannot drift back. */
export const SHAPE_NOT_DECLARED = 'shape not declared'

// ── THE ALIGNMENT MARK IS RETIRED (owner, ledger #28 + #29) ───────────────────────────────
//
// `ALIGNMENT_NOT_DECLARED` used to live here — one string, rendered on the coordinate picker's
// candidates, on this resolver's rows, on the entry sources, and on every emitted plot, plus a
// § Coordinates alert that said the same thing in a sentence. The owner asked for the alert to
// go (*"remove the 'Alignment not declared …' warning please"*) and then for the plot's copy to
// go too (*"remove the alignment not declared in the plot too"*). Together those two retire the
// whole "unknown alignment is OFFERED but MARKED" rule that DEC-11 wrote.
//
// WHAT IS RETIRED IS THE TELLING, NOT THE OFFER. Every candidate this resolver offered before it
// still offers: `alignmentState(...) === 'A2'` (aligned to a DIFFERENT row space) is still
// dropped below, because that is an offering decision and not a mark. A3 — alignment simply not
// declared — is offered exactly as it was, and now says nothing about itself on any surface.
//
// The constant is DELETED rather than left unused with its readers removed: a string named for
// the fact is an invitation to render it again from a fourth surface, which is precisely how it
// came to be on four at once.

/** One offered column, described from its catalog row alone. */
export interface RowSpaceColumn {
  /** the artifact this column IS. Identity is `(artifact, selector)`; the name is display
   *  only and is never keyed on (INV-1). */
  artifact: string
  /** what the row READS as — the producer's declared display name. */
  name: string
  /** the producer's declared summary kind, verbatim and unvalidated: `categorical`,
   *  `continuous`, or whatever else a producer declares. `undefined` when none was
   *  declared. The vocabulary is the producer's (INV-6). */
  kind?: string
  /** the TRUE distinct level count of a categorical column (`meta.n_categories`), NOT the
   *  length of the size-capped `categories` preview. */
  levels?: number
  /** the declared range of a continuous column. */
  min?: number
  max?: number
  /** what the row states about its own shape — `"23 levels"`, `"0.02 – 9.81"`, or
   *  {@link SHAPE_NOT_DECLARED}. One sentence, computed once, so two surfaces cannot
   *  render the same column's shape two different ways. */
  shape: string
  /** whether the producer declared a summary this resolver could read a shape out of.
   *  `false` is what ITEM-41's header aggregate counts. */
  shape_declared: boolean
  /** ITEM-39 — why this row's ▶ is unavailable, or `null` when it is available. A
   *  non-empty string IS the refusal (the `unavailableReason` gate, ITEM-29c), so a
   *  refused control can never be refused silently. */
  plot_refusal: string | null
  /**
   * ITEM-10 — *"describes N of M rows"*, the ANCHOR-RELATIVE fact about this column, or
   * `null` when the anchor states no population to denominate on (every project that has not
   * yet produced a membership).
   *
   * Computed from DECLARATIONS ONLY, exactly like every other field on this row: the figure
   * is identical whether nothing, some or all of the data has landed, and this resolver
   * issues zero data-plane reads (INV-8). A figure that moved as data arrived would read as
   * progress and would be a violation of INV-3, which measures a declared set.
   */
  describes: string | null
  /**
   * ITEM-32/ITEM-35 — EVERY artifact this offer spans, when same-name fusion merged more than
   * one. `undefined` on an unfused row, which is every row of a single-dataset project.
   *
   * {@link artifact} stays ONE plain id — the PRIMARY — because that is what a stored pick
   * round-trips as and INV-4 forbids inventing a delimited composed id for it. The full set is
   * resolved from HERE and never parsed back out of the value.
   *
   * **Every record/export path must contribute ALL of these as inputs.** Provenance records
   * RESOLVED artifacts and refuses unknown ones, so recording only the primary passes every
   * existing provenance test — the one id it did record resolves fine and nothing errors —
   * while the colouring used two. That is the hole the Q12 verification exposed, and it is why
   * this field exists rather than the fused set being re-derived at each recording site.
   */
  artifacts?: readonly string[]
  /** WHICH datasets the fused offer spans, for the ITEM-10 line. Absent on an unfused row. */
  datasets?: readonly string[]
}

/**
 * The whole answer for one binding: the rows, plus the AGGREGATE facts a section states in
 * its header instead of on forty rows (ITEM-20 / ITEM-41).
 *
 * The aggregates are computed HERE, not by the view, for the same reason `empty_text` is
 * declared on a control rather than written as a `when` predicate (INV-5): a view cannot
 * observe candidate availability at all, so every attempt to write "are they all A3?" as a
 * view expression ends up testing the nearest thing a view CAN see. The engine knows the
 * answer at the one point where it exists, and hands it over as a fact.
 */
export interface RowSpaceColumns {
  columns: RowSpaceColumn[]
  count: number
  /**
   * Whether a row space is anchored AT ALL — A0 vs "anchored, and it offers nothing".
   *
   * They are two different emptinesses and ITEM-63 requires a section to say WHICH one it
   * is, so they may not collapse into one `count === 0`. The slice is deliberately always
   * `ready` (never `undefined`/`empty`) so that a binding to `columns` is TOTAL and a
   * section cannot render a dangling list while it works out which sentence to show; the
   * distinction travels in the payload instead of in the slice status, where a view can
   * actually read it.
   */
  anchored: boolean
  /** ITEM-41 — how many offered columns declared no summary, and whether that is all of
   *  them. Same aggregate rule as A3: said once in the header rather than on every row. */
  n_shape_undeclared: number
  all_shape_undeclared: boolean
  /**
   * THE SAME COLUMNS, SHAPED AS A SEARCHABLE LIST (owner, ledger #32).
   *
   *   ledger #32 (quoted in full there: a search box, no table, a bounded scrolling
   *    list — "make it look like the other list section")
   *
   * The column section used to render TWO `table` widgets — one per declared kind — with a `Column`
   * heading, a shape column, a numeral column and a ▶ column. The entry-axis section renders ONE
   * `entry_list`: a search box, a scrolling list, a group heading per declared group. The
   * owner asked for the second shape, so this resolver hands the section the second shape,
   * and the section binds ONE control instead of two grids.
   *
   * The rows are the `columns` above, verbatim and in the same order, projected into the
   * vocabulary `entry_list` already speaks — so nothing about WHICH columns are offered or
   * HOW they are ordered moved into a new code path. `key` is the ARTIFACT, because that is
   * the identity (INV-1) and because it is what the section's `count_by` already groups the
   * open plots by.
   *
   * Empty unless the section declared {@link RowSpaceColumnsArgs.kinds} — a view that binds
   * `columns` (every view written before this) is byte-identical.
   */
  rows: RowSpaceColumnEntry[]
  /** The DECLARED groups, `[{name, count}]`, in the order the section declared them — what
   *  `entry_list` prints as its headings. One per {@link RowSpaceColumnsArgs.kinds} entry that
   *  has at least one column; a heading over nothing inverts what a heading is. */
  groups: { name: string; count: number }[]
  /** ITEM-56 — do headings render at all? ONE group is not a grouping. The ENGINE decides,
   *  because a view cannot see the whole offer (the same rule `axis_entry_rows` follows). */
  grouped: boolean
  /** ITEM-63 — was the list actually LISTED? `entry_list` refuses to claim emptiness unless
   *  the engine says so, since an empty `rows` is also what "no anchor yet" looks like. */
  browsable: boolean
}

/**
 * One offered column, in `entry_list`'s own vocabulary (see {@link RowSpaceColumns.rows}).
 *
 * It is a PROJECTION of {@link RowSpaceColumn} and never a second description: every field
 * below is copied from the column it is made of, so the two surfaces cannot come to describe
 * one column differently. It also carries the column's own `kind` and `artifact` through
 * unchanged, because the section's emit action reads them (`$row.kind` decides whether the
 * tile is coloured as a category or as a range) and a widget that dropped fields it did not
 * itself model would make that undeclarable.
 */
export interface RowSpaceColumnEntry {
  /** the identity — the artifact (INV-1), which is also what the open-plot count is keyed by. */
  key: string
  /** what the row READS as. */
  label: string
  /** what a PLOT of it is called, and what its ▶ is named after (ITEM-30/ITEM-58). */
  title: string
  /** the declared group's heading, or `null` when the section declared no groups. */
  group: string | null
  /**
   * The row's other facts, in `entry_list`'s search/annotation shape. Index 0 is the DISPLAYED
   * name and index 1 is the one the row prints beside it — which is the SHAPE sentence, i.e.
   * exactly what the old table's `Levels`/`Range` column held. So the fact survives the change
   * of control; it moves from a grid tile to the row's second annotation slot, which is where
   * The entry-axis section already prints the per-row fact that varies.
   */
  values: { title: string; value: string }[]
  /**
   * ITEM-10 — the row's SECOND LINE: *"describes N of M rows"*, or `null` when the anchor
   * states no population to denominate on (every project that has produced no membership).
   *
   * It is a SENTENCE about this column relative to the coordinate, not a value with a title,
   * which is why it is its own field rather than a third {@link values} entry: the inline
   * annotation slot shows exactly one value by design, so a third one would be carried and
   * never shown. Verbatim {@link RowSpaceColumn.describes}.
   */
  note: string | null
  /** ITEM-39 — why this row's ▶ refuses, or `null`. Copied verbatim. */
  plot_refusal: string | null
  /** ITEM-32/ITEM-35 — every artifact a FUSED offer spans, primary first. Absent when the
   *  offer is one artifact. A consumer that records or exports this pick must contribute all
   *  of them, not just {@link key}. */
  artifacts?: readonly string[]
  /** the producer's declared summary kind, passed through for the section's emit action. */
  kind?: string
  /** the artifact id again, under the name the section's action already spells. */
  artifact: string
}

/** The empty answer — the shape every consumer gets when there is no anchor (A0), so a
 *  section renders its declared emptiness rather than a partially-filled list. */
export const NO_ROW_SPACE_COLUMNS: RowSpaceColumns = {
  columns: [],
  count: 0,
  anchored: false,
  n_shape_undeclared: 0,
  all_shape_undeclared: false,
  rows: [],
  groups: [],
  grouped: false,
  browsable: false,
}

/** The producer's declared summary, as a plain bag. Never validated into a closed enum:
 *  the vocabulary is the producer's and an unknown `kind` must degrade, not throw. */
function summaryOf(meta: unknown): Record<string, unknown> {
  return meta != null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Format a continuous bound for display.
 *
 * Fixed to a small number of significant digits rather than printed raw, because a range
 * read off floating-point data is routinely `0.019999999552965164`, and a row whose job is
 * to be scanned at a glance cannot spend twenty characters on precision nobody asked for.
 * The VALUE is untouched; only the sentence is rounded.
 */
function bound(v: number): string {
  if (Number.isInteger(v)) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return v.toExponential(2)
  return String(Number(v.toPrecision(3)))
}

/**
 * The shape sentence for one column, from its declared summary alone (ITEM-37 / ITEM-38).
 *
 * PURE and exported so the rule is testable without a catalog. A categorical column states
 * its LEVEL COUNT and a continuous one its RANGE, because those are the two facts that make
 * a row a different proposition before it is clicked: a 2-level `batch` and a 23-level
 * cluster label are not the same act, and neither is a 0–1 score and a 0–60000 count.
 */
export function shapeOf(column: Pick<RowSpaceColumn, 'kind' | 'levels' | 'min' | 'max'>): {
  shape: string
  shape_declared: boolean
} {
  if (column.kind === 'categorical' && column.levels !== undefined) {
    return { shape: `${column.levels.toLocaleString()} ${column.levels === 1 ? 'level' : 'levels'}`, shape_declared: true }
  }
  if (column.kind === 'continuous' && column.min !== undefined && column.max !== undefined) {
    return { shape: `${bound(column.min)} – ${bound(column.max)}`, shape_declared: true }
  }
  return { shape: SHAPE_NOT_DECLARED, shape_declared: false }
}

/**
 * Why NO ▶ in this pane can emit yet: the frame has no coordinate (visualize-pane ITEM-39).
 *
 * The coordinate picker deliberately does not auto-bind, so a pane opens ANCHORED (the row
 * space auto-anchors) and UNFRAMED. Before this refusal existed, the two contributed emit
 * sections gated their ▶ on their own row-level reasons alone, so the natural first action —
 * press a ▶ without ever opening the coordinate picker — appended a plot whose `coordinate`
 * was `null`.
 * `resolveCanvasCoords` skips a null ref and `positionsFor` then fell through to the
 * project-wide `layouts[0]`, painting the column on the project's FIRST plottable artifact:
 * a confident, plausible, WRONG picture. Refusing is not enough on its own — a control that
 * refuses without saying why is the same dead end — so this rides `unavailableReason`, which
 * is the string the user reads.
 *
 * Spelled ONCE, here, and consumed by all three
 * surfaces (`row_space_columns`' rows, `axis_entry_rows`' rows, and `pane_frame`'s own ▶),
 * so the pane cannot state one refusal three ways — and so fixing one surface and not the
 * others is not expressible.
 */
export const NO_COORDINATE_REFUSAL = 'Pick a coordinate set under Coordinates above first.'

/** Why nothing in this pane can emit yet: no coordinate set is chosen, so there are no rows
 *  for a picture to be about. Spelled beside {@link NO_COORDINATE_REFUSAL} for the same reason,
 *  and DELIBERATELY the same sentence: the two states became one the day the rows stopped being
 *  a separate question and started being derived from the coordinate set. */
export const NO_ANCHOR_REFUSAL = NO_COORDINATE_REFUSAL

/**
 * Why this row's ▶ is unavailable, or `null` (ITEM-39).
 *
 * The ROW's own refusal, and it is a legibility one — distinct from the pane-wide frame gate
 * ({@link NO_COORDINATE_REFUSAL}), which is not a fact about any column. This one WINS when
 * both apply: choosing a coordinate would not make a 65-level column plottable, so naming the
 * actionable reason where acting changes nothing is the less informative answer.
 *
 * A column whose summary is absent is NOT refused: "shape not declared" is a producer
 * omission, and refusing to plot a perfectly ordinary column because nobody described it
 * would punish the user for it.
 */
export function plotRefusalFor(column: Pick<RowSpaceColumn, 'kind' | 'levels'>): string | null {
  if (column.kind === 'categorical' && column.levels !== undefined && column.levels > MAX_LEGEND_LEVELS) {
    return `${column.levels.toLocaleString()} distinct values — too many for a color legend (the limit is ${MAX_LEGEND_LEVELS.toLocaleString()}).`
  }
  return null
}

/** Describe ONE catalog row as an offered column. PURE.
 *
 *  The `anchor` is READ as of ITEM-10, for exactly the one anchor-relative thing a row says —
 *  *"describes N of M rows"*. Everything else on the row is a producer declaration about the
 *  column alone, so the two kinds of fact stay distinguishable at the site that makes them. The
 *  signature did not change: ITEM-8 typed it plural ahead of this line for that reason. */
export function describeColumn(row: ArtifactRow, anchor: RowSpaceAnchor | undefined): RowSpaceColumn {
  const summary = summaryOf(row.meta)
  const kind = typeof summary.kind === 'string' && summary.kind !== '' ? summary.kind : undefined
  const levels = num(summary.n_categories)
  const min = num(summary.min)
  const max = num(summary.max)
  const shape = shapeOf({ kind, levels, min, max })
  return {
    artifact: row.id,
    name: candidateLabel(row),
    kind,
    levels,
    min,
    max,
    shape: shape.shape,
    shape_declared: shape.shape_declared,
    plot_refusal: plotRefusalFor({ kind, levels }),
    describes: describedRowsLine(describedRows(row.structure, anchor)) ?? null,
  }
}

/** The `args` a `row_space_columns` slice declares. */
export interface RowSpaceColumnsArgs {
  /** a `$`-ref to the anchored row space's IDENTITIES — the `AxisSummary.content_hash` of every
   *  axis it rests on (ITEM-10, plural since ITEM-8). Unresolved ⇒ the EMPTY answer, never a
   *  project-wide fallback (INV-4). */
  aligned_to?: string
  /** narrow to a datatype id (exact). Kept an exact match rather than a subtype walk
   *  because this resolver holds no datatype registry — the lattice is the availability
   *  layer's, and a section's KIND question is already answered by `applies_to`. */
  datatype?: string
  /** a `$`-ref to the CHOSEN COORDINATE artifact's id (`$scope.coordinate`), so a row can say
   *  what a picture made from it would be marked with ({@link RowSpaceColumn.plot_note}). Absent
   *  / unresolved ⇒ the frame contributes nothing to the mark, which is correct: with no
   *  coordinates chosen there is no picture to mark. */
  coordinate?: string
  /** narrow to the producer's declared summary `kind`. THE categorical/continuous split
   *  (ITEM-44), from a DECLARATION rather than from the values — which is what makes
   *  "categorical first, then continuous" the order of two bindings in the section's yaml,
   *  with no sort in core, in a primitive, or in the renderer. */
  kind?: string
  /**
   * THE SAME SPLIT, DECLARED AS ONE ORDERED LIST — what makes ledger #32's single searchable
   * list possible without moving the domain claim out of the package.
   *
   * `[{ kind, heading }, …]`. Each entry names a producer-declared summary `kind` and the
   * HEADING the group reads under; the array's ORDER is the offer's order. So *"categorical
   * first, then continuous"* stays exactly what it was — a package's declaration, in the
   * package's own file — while the section renders ONE control instead of two grids. There is
   * still no sort in core: this resolver walks the declared array and nothing else.
   *
   * Absent ⇒ {@link RowSpaceColumns.rows}/`groups` come back empty and `kind` behaves exactly
   * as before, so every view that binds `columns` is untouched. Present ⇒ `kind` is ignored
   * (the array says which kinds, one place), and `columns` is the flat concatenation in the
   * declared order, so a binding to it still reads the same offer.
   */
  kinds?: { kind: string; heading: string }[]
}

/**
 * Resolve a `row_space_columns` slice. PURE over the catalog rows — no read port, no
 * network, no column bodies (INV-11).
 *
 * The offering predicate is the engine's, not the view's (ITEM-17): a view declares WHICH
 * row space and nothing else, so A2 candidates (aligned to a DIFFERENT row space) are
 * dropped here and cannot be offered by any spelling of any spec. A3 candidates — alignment
 * not declared — are OFFERED, exactly as before; what changed (owner, ledger #28+#29) is that
 * they are no longer marked. See the note at the top of this file: the offer stayed, the
 * telling went.
 */
export function resolveRowSpaceColumns(
  artifacts: readonly ArtifactRow[],
  args: RowSpaceColumnsArgs,
  anchorContentHashes: readonly string[] | null | undefined,
  coordinateArtifactId?: string | null,
): RowSpaceColumns {
  // EVERY axis the pane is anchored on (ITEM-8). The offering predicate composes over them —
  // a column of either dataset of an integrated coordinate describes rows the user is looking
  // at — so this resolver hands the whole list down and never picks one.
  const anchor = resolveRowSpaceAnchor(artifacts, anchorContentHashes, coordinateArtifactId)
  // A0 — no anchor. Nothing is offered: with no row space chosen there is no question for a
  // candidate to answer, and listing the project's columns would be the fallback INV-4
  // forbids. The section says WHICH emptiness this is from its own declared sentence.
  if (!anchor) return NO_ROW_SPACE_COLUMNS

  // The declared kind ORDER (ledger #32). Read once, and validated only to the extent that a
  // malformed entry is skipped rather than thrown on: `args` is a package's declaration and an
  // engine that crashes a whole pane over one bad key is a worse answer than one that offers
  // the groups it could read.
  const declaredKinds = Array.isArray(args.kinds)
    ? args.kinds.filter(
        (g): g is { kind: string; heading: string } =>
          !!g && typeof g === 'object' && typeof g.kind === 'string' && typeof g.heading === 'string',
      )
    : undefined

  const byId = new Map(artifacts.map(a => [a.id, a]))
  const columns: RowSpaceColumn[] = []
  for (const row of artifacts) {
    if (args.datatype !== undefined && row.datatype !== args.datatype) continue
    // AN AXIS IS NOT A COLUMN ON ITSELF. A key artifact declares the ordered key sequence
    // that IS a row space (§7.7.2), so offering it here offers the row identifiers as a
    // thing to colour by — one distinct value per row, on every project. It was offered,
    // and MARKED while it was: a key artifact correctly declares no `aligned_to`, so it
    // read as "alignment not declared" about the very thing everything else is aligned TO.
    if (isAxisArtifact(row.structure)) continue
    // A2 is DROPPED, not offered-and-disabled: a disabled row invites the reader to work
    // out why one row space's columns are listed under another's coordinates, which is not
    // a question they should be asked (ITEM-18). It now also covers a candidate that
    // DECLARES a different axis — known elsewhere, not unknown (see `alignmentState`).
    // …and A4 alongside it (ITEM-7 / ITEM-18): same axis, known members, and PROVABLY none
    // of the coordinate's rows — a column about a different population of the same dataset.
    // Dropped for the same reason A2 is, and it is a stronger statement than a row reading
    // "describes 0 of 10 rows": there is nothing here to colour, so there is nothing to offer.
    const state = alignmentState(row.structure, anchor)
    if (state === 'A2' || state === 'A4') continue
    const column = describeColumn(row, anchor)
    // `kinds` (the ordered, grouped form) takes over the narrowing when it is declared —
    // the array says which kinds are offered, in one place, so a stale `kind:` beside it
    // cannot narrow the offer a second time and disagree.
    if (declaredKinds === undefined && args.kind !== undefined && column.kind !== args.kind) continue
    if (declaredKinds !== undefined && !declaredKinds.some(g => g.kind === column.kind)) continue
    columns.push(column)
  }
  // ── SAME-NAME FUSION (ITEM-32, Q1 ruled) ──────────────────────────────────────────────
  //
  // AFTER the A2/A4 filter, deliberately: fusion is about what to SHOW, and a candidate the
  // offer rule already dropped has nothing to be shown as. Fusing first would merge a dropped
  // column into a kept one and put back exactly what A2/A4 removed.
  const fused = fuseSameName(columns, byId)
  // Stable and declared: by display name, so the list does not reorder itself between two
  // catalog reads that returned the same rows in a different order. NOT by "importance" —
  // there is no such declaration to read, and inventing one is the chart-choice default
  // `columns_of`'s `as:` remap exists to undo.
  fused.sort((a, b) => a.name.localeCompare(b.name) || a.artifact.localeCompare(b.artifact))
  // …and then, when the section declared an ORDER OF KINDS, by that order first. It is a
  // STABLE sort on top of the name sort, so within a group the rule above is untouched. This
  // is the whole of "categorical first, then continuous" as code: it reads a declared array
  // and has no opinion of its own about which kind matters more.
  if (declaredKinds !== undefined) {
    const at = new Map(declaredKinds.map((g, i) => [g.kind, i]))
    const rank = (c: RowSpaceColumn): number => at.get(c.kind ?? '') ?? declaredKinds.length
    fused.sort((a, b) => rank(a) - rank(b))
  }

  const nUndeclared = fused.filter(c => !c.shape_declared).length
  // THE FRAME GATE (ITEM-39). The coordinate is still resolved — not to MARK anything (the
  // marks are retired; see the note at the top of this file) but because an unframed pane has
  // no rows for a picture to be about, and every ▶ must say so rather than emit a plot drawn
  // on the project's first plottable artifact.
  const coordRow =
    typeof coordinateArtifactId === 'string' && coordinateArtifactId !== ''
      ? artifacts.find(a => a.id === coordinateArtifactId)
      : undefined
  for (const c of fused) {
    // Unframed ⇒ every row refuses, in the ONE sentence {@link NO_COORDINATE_REFUSAL} spells.
    // The row's OWN reason wins when it has one: a >64-level column stays refused for the level
    // cap because choosing a coordinate would not make it available, and naming the reason the
    // user CAN act on when acting changes nothing is the less informative answer.
    if (coordRow === undefined) c.plot_refusal = c.plot_refusal ?? NO_COORDINATE_REFUSAL
  }
  // ── THE LIST FORM (ledger #32) ────────────────────────────────────────────────────────
  //
  // Built from `columns` AFTER every decision above has been made, so the list and the grid a
  // legacy view might still bind are the same offer in the same order by construction.
  const headingOf = new Map((declaredKinds ?? []).map(g => [g.kind, g.heading]))
  const rows: RowSpaceColumnEntry[] =
    declaredKinds === undefined
      ? []
      : fused.map(c => ({
          key: c.artifact,
          artifact: c.artifact,
          label: c.name,
          // A column's name is not contested within one row space, so the plot's name IS the
          // column's — but it is spelled as its own field because a ▶ is named from `title`
          // everywhere in this pane and a surface that named it from `label` would be the one
          // that drifts (ITEM-58).
          title: c.name,
          group: headingOf.get(c.kind ?? '') ?? null,
          // Index 0 is the displayed name; index 1 is what the row PRINTS beside it. The old
          // table's `Levels`/`Range` tile, in the row's second-annotation slot.
          // A THIRD slot only when there is a third fact: the anchor-relative sentence
          // (ITEM-10). Rendering an empty one on every row of every legacy project would
          // spend the row's width on nothing.
          values: [
            { title: 'Column', value: c.name },
            { title: 'Shape', value: c.shape },
            ...(c.describes === null ? [] : [{ title: 'Rows', value: c.describes }]),
          ],
          // ITEM-10 — the SECOND LINE. It is stated here as well as in `values` above, and the
          // two are different jobs: `values` is the SEARCH CORPUS (a reader typing `40` finds
          // the rows that describe forty), and `note` is what is PRINTED, on its own line.
          //
          // Putting the sentence only in `values` is what shipped, and it reached no user: the
          // row's inline annotation slot deliberately shows exactly ONE value (the entry
          // widget's suppress-what-is-constant rule), so a third one is computed, carried,
          // searchable — and invisible. The resolver's unit tests were green throughout.
          note: c.describes,
          plot_refusal: c.plot_refusal,
          kind: c.kind,
          ...(c.artifacts ? { artifacts: c.artifacts } : {}),
        }))
  const groups = (declaredKinds ?? [])
    .map(g => ({ name: g.heading, count: fused.filter(c => c.kind === g.kind).length }))
    // A heading over nothing inverts what a heading is (`entry_list`'s own rule, and
    // `axis_entry_rows`' before it).
    .filter(g => g.count > 0)
  return {
    columns: fused,
    count: fused.length,
    anchored: true,
    n_shape_undeclared: nUndeclared,
    all_shape_undeclared: fused.length > 0 && nUndeclared === fused.length,
    rows,
    groups,
    // ITEM-56 — one group is not a grouping.
    grouped: groups.length > 1,
    // Anchored ⇒ the list was listed. There is no over-budget arm here: this resolver reads
    // catalog rows only, so it cannot be refused for size the way an entry axis can.
    browsable: true,
  }
}

/**
 * SAME-NAME FUSION (ITEM-32) — one offer where two datasets' same-named columns provably mean
 * the same thing, and two offers otherwise.
 *
 * ── WHAT IT GROUPS, AND WHY IT IS NOT A JOIN ────────────────────────────────────────────────
 *
 * Grouping is by DISPLAY NAME, which the schema says is display-only and never a key — and that
 * is exactly right here, because the question being asked IS a display question ("does the
 * reader see one row or two?"). The name is never used to decide identity: every offer keeps its
 * artifact id, and a fused one keeps ALL of them ({@link RowSpaceColumn.artifacts}).
 *
 * A group only fuses when it spans MORE THAN ONE DATASET. Two same-named columns of ONE dataset
 * are two different columns that happen to share a label — the natural key excludes the name
 * precisely so that is legal — and merging them would delete an offer inside a single project,
 * which is not what the ruling asked for.
 *
 * ── ALL PAIRS, NOT A REPRESENTATIVE ─────────────────────────────────────────────────────────
 *
 * Fusion requires EVERY pair in the group to reconcile. Checking each member against a chosen
 * representative would make the verdict depend on which member was chosen — with three datasets
 * where A≡B and A≡C but B≢C, a representative-based check fuses all three and hides a conflict
 * the reader is entitled to see. Any failure ⇒ the whole group is offered SEPARATELY, which is
 * the ruling's own second clause and needs no per-row warning to be legible.
 */
function fuseSameName(
  columns: readonly RowSpaceColumn[],
  byId: ReadonlyMap<string, ArtifactRow>,
): RowSpaceColumn[] {
  const groups = new Map<string, RowSpaceColumn[]>()
  for (const column of columns) {
    const group = groups.get(column.name) ?? []
    group.push(column)
    groups.set(column.name, group)
  }
  const out: RowSpaceColumn[] = []
  for (const group of groups.values()) {
    const datasets = [
      ...new Set(group.map(c => byId.get(c.artifact)?.source_dataset_id).filter((d): d is string => !!d)),
    ]
    if (group.length < 2 || datasets.length < 2) {
      out.push(...group)
      continue
    }
    const declarations = group.map(c => {
      const row = byId.get(c.artifact)
      return row ? vocabDeclarationOf(row) : undefined
    })
    let reconciled = true
    for (let i = 0; reconciled && i < declarations.length; i++) {
      for (let j = i + 1; reconciled && j < declarations.length; j++) {
        const a = declarations[i]
        const b = declarations[j]
        reconciled = !!a && !!b && reconcileVocabularies(a, b).verdict === 'reconciled'
      }
    }
    if (!reconciled) {
      out.push(...group)
      continue
    }
    // DETERMINISTIC PRIMARY — lowest artifact id. Not "the first the catalog returned": the
    // primary is a picker KEY and a stored-choice target, so two reads of one catalog that
    // arrived in different orders must answer the same id or a saved selection stops resolving.
    const ordered = [...group].sort((a, b) => (a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0))
    const primary = ordered.reduce(first => first)
    out.push({
      ...primary,
      artifacts: ordered.map(c => c.artifact),
      datasets: [...datasets].sort(),
      // ITEM-10, fused: WHICH datasets it spans, and each one's own row figure. A fusion that
      // said only "describes 40 rows" would be invisible as a fusion, which is the one thing the
      // ruling's second clause forbids — the reader must be able to see that two things were
      // merged and on what.
      describes: fusedDescribesLine(ordered, byId),
    })
  }
  return out
}

/** The fused row's ITEM-10 line: the datasets it spans, and each one's own figure. `null` when
 *  no member had a figure — the same silence an unfused row keeps on a project that has declared
 *  no membership. */
function fusedDescribesLine(
  group: readonly RowSpaceColumn[],
  byId: ReadonlyMap<string, ArtifactRow>,
): string | null {
  const parts = group
    .map(c => {
      const dataset = byId.get(c.artifact)?.source_dataset_id
      return dataset && c.describes ? `${dataset}: ${c.describes}` : undefined
    })
    .filter((p): p is string => p !== undefined)
  if (parts.length === 0) return null
  return `spans ${group.length} datasets — ${parts.join('; ')}`
}
