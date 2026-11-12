// TEST-50 / TEST-51 / TEST-52 / TEST-53 (ITEM-37 / ITEM-38 / ITEM-39 / ITEM-40), the
// listing half of TEST-57 (ITEM-44), TEST-28 (ITEM-20) and TEST-54 (ITEM-41), plus the
// acceptance pin TEST-A11 (INV-11).
//
// The fixtures carry NO domain vocabulary: no column here is named after a metric, no axis
// after a biological entity, and the two `kind` values are the producer's own declared
// words. A fixture that spelled a real column name would let an implementation that
// recognised that name pass, which is the tautology these specs exist to avoid.

import { describe, expect, it, vi } from 'vitest'

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  MAX_LEGEND_LEVELS,
  NO_COORDINATE_REFUSAL,
  NO_ROW_SPACE_COLUMNS,
  SHAPE_NOT_DECLARED,
  plotRefusalFor,
  resolveRowSpaceColumns,
  shapeOf,
} from './rowSpaceColumns'

const KEYS_ONE = 'a'.repeat(64)
const KEYS_TWO = 'b'.repeat(64)

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: 'x',
    project_id: 'p',
    datatype: 'demo/column',
    structure: {},
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** The key artifact that IS a row space — its `content_hash` is the axis's identity, its
 *  `structure.key_sequence_digest` is what an aligned artifact declares. Two namespaces,
 *  spelled apart on purpose (an implementation comparing the wrong pair must fail). */
function rowSpace(id: string, contentHash: string, digest: string): ArtifactRow {
  return row({
    id,
    content_hash: contentHash,
    datatype: 'demo/key',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', key: 'values', key_sequence_digest: digest },
  })
}

/** One offered column: a name, an optional producer summary, an optional alignment claim. */
function column(
  id: string,
  name: string,
  meta: Record<string, unknown> | undefined,
  alignedTo?: string,
  over: Partial<ArtifactRow> = {},
): ArtifactRow {
  return row({
    id,
    datatype: 'demo/column',
    meta: meta === undefined ? undefined : { name, ...meta },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      ...(alignedTo ? { aligned_to: alignedTo } : {}),
    },
    ...over,
  })
}

const ANCHOR = { aligned_to: '$scope.axis', datatype: 'demo/column' } as const

describe('shapeOf — every row states its own shape, from `meta` alone (ITEM-37 / ITEM-38)', () => {
  it('a categorical row states its TRUE level count, not the capped preview length', () => {
    // The distinction is the whole point of reading `n_categories`: `colsummary` caps the
    // `categories` PREVIEW at 50 entries AND 1 KiB, so a consumer counting the preview
    // reports 50 for a 4,102-level column. `n_categories` is computed BEFORE either cap.
    const got = shapeOf({ kind: 'categorical', levels: 4102 })
    expect(got.shape).toBe('4,102 levels')
    expect(got.shape_declared).toBe(true)
    expect(shapeOf({ kind: 'categorical', levels: 1 }).shape).toBe('1 level')
  })

  it('a continuous row states its declared range', () => {
    expect(shapeOf({ kind: 'continuous', min: 0, max: 60000 }).shape).toBe('0 – 60000')
    // Rounded for READING; the underlying values are untouched and are still on the row.
    expect(shapeOf({ kind: 'continuous', min: 0.019999999552965164, max: 9.8123 }).shape).toBe('0.02 – 9.81')
  })

  it('a column whose producer declared neither reads exactly "shape not declared"', () => {
    // Asserted on the LITERAL so the attribution cannot drift back to "not read", which
    // would read as a failure the app suffered rather than a declaration the producer
    // omitted. The absence belongs to whoever can fix it.
    expect(SHAPE_NOT_DECLARED).toBe('shape not declared')
    expect(shapeOf({}).shape).toBe(SHAPE_NOT_DECLARED)
    expect(shapeOf({}).shape_declared).toBe(false)
    // HALF a declaration is still not a declaration — a continuous column with a min and no
    // max cannot state a range, and inventing the other bound would be a guess.
    expect(shapeOf({ kind: 'continuous', min: 0 }).shape).toBe(SHAPE_NOT_DECLARED)
    // An UNRECOGNISED kind degrades rather than throwing: the kind vocabulary is the
    // producer's, and a fourth kind must not take a section down.
    expect(shapeOf({ kind: 'ordinal-ish', levels: 3 }).shape).toBe(SHAPE_NOT_DECLARED)
  })
})

describe('the ▶ refusal is keyed on the level COUNT, never on `high_cardinality` (ITEM-39)', () => {
  it('refuses a column with more levels than a legend can carry, and names the cause', () => {
    const refusal = plotRefusalFor({ kind: 'categorical', levels: MAX_LEGEND_LEVELS + 1 })
    expect(refusal).toContain(String(MAX_LEGEND_LEVELS + 1))
    expect(refusal).toContain(String(MAX_LEGEND_LEVELS))
    // A REASON, not a bare disabled control — `unavailableReason`'s whole contract.
    expect(refusal && refusal.length).toBeGreaterThan(20)
  })

  it('does NOT refuse a legible column whose PREVIEW was merely byte-trimmed', () => {
    // The phase-2 correction, asserted directly. `colsummary.py` sets `high_cardinality`
    // whenever the preview is shorter than the true set — INCLUDING when the 1 KiB budget
    // trimmed it — so a column with eight long-labelled levels carries the flag and is
    // perfectly plottable. Keying the refusal on the flag would refuse it.
    const catalog = [
      rowSpace('axis', 'hash-one', KEYS_ONE),
      column('c1', 'alpha', { kind: 'categorical', n_categories: 8, high_cardinality: true }, KEYS_ONE),
      // The FRAME. This subject is about the LEVEL-COUNT rule, so the pane has to be framed
      // or the frame refusal (below) is what would be observed instead — see ITEM-39.
      column('coords', 'a projection', { kind: 'continuous', min: 0, max: 1 }, KEYS_ONE),
    ]
    // BY ID — the offer is sorted by display name, so a positional read would silently pick
    // whichever fixture row happened to sort first.
    const c = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'], 'coords').columns.find(
      x => x.artifact === 'c1',
    )!
    expect(c.plot_refusal).toBeNull()
    expect(c.shape).toBe('8 levels')
  })

  // ── the FRAME gate (ITEM-39) ────────────────────────────────────────────────────────
  //
  // A row's ▶ emits a plot, and a plot is drawn in the pane's frame. With no coordinate
  // chosen there is no frame, and before this gate existed the ▶ emitted anyway: the emitted
  // plot carried `coordinate: null`, `resolveCanvasCoords` skipped the null ref, and `positionsFor`
  // fell through to the project-wide `layouts[0]` — a confident, plausible picture of the
  // WRONG artifact, reachable as the very first thing a user does.
  it('refuses EVERY row while the pane is unframed, and SAYS why', () => {
    const catalog = [
      rowSpace('axis', 'hash-one', KEYS_ONE),
      column('c1', 'alpha', { kind: 'categorical', n_categories: 8 }, KEYS_ONE),
      column('c2', 'beta', { kind: 'continuous', min: 0, max: 1 }, KEYS_ONE),
    ]
    const unframed = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one']).columns
    expect(unframed.length).toBe(2) // the rows are OFFERED, not hidden …
    expect(unframed.every(c => c.plot_refusal === NO_COORDINATE_REFUSAL)).toBe(true)
    // A REASON, not a bare disabled control — `unavailableReason`'s contract.
    expect(NO_COORDINATE_REFUSAL.length).toBeGreaterThan(20)

    // POSITIVE CONTROL: the same catalog with a coordinate chosen refuses nothing. Without
    // this the assertion above would also pass if the resolver refused unconditionally.
    const framed = resolveRowSpaceColumns(
      [...catalog, column('coords', 'a projection', { kind: 'continuous', min: 0, max: 1 }, KEYS_ONE)],
      ANCHOR,
      ['hash-one'],
      'coords',
    ).columns
    expect(framed.filter(c => c.artifact !== 'coords').every(c => c.plot_refusal === null)).toBe(true)
  })

  it('a row with its OWN permanent reason keeps it, framed or not', () => {
    // Precedence, stated: choosing a coordinate would not make a 65-level column plottable,
    // so naming the actionable reason here would be the LESS informative answer.
    const catalog = [
      rowSpace('axis', 'hash-one', KEYS_ONE),
      column('big', 'alpha', { kind: 'categorical', n_categories: MAX_LEGEND_LEVELS + 1 }, KEYS_ONE),
    ]
    // UNFRAMED — the frame gate is live, and the row's own reason still wins.
    const [unframed] = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one']).columns
    expect(unframed.plot_refusal).toContain(String(MAX_LEGEND_LEVELS))

    // FRAMED — the "or not" half of this test's own name, which went unasserted at first.
    // The refusal is UNCHANGED, which is the actual claim: the level cap is a fact about the
    // column, so the frame has no bearing on it either way.
    const framed = resolveRowSpaceColumns(
      [...catalog, column('coords', 'a projection', { kind: 'continuous', min: 0, max: 1 }, KEYS_ONE)],
      ANCHOR,
      ['hash-one'],
      'coords',
    ).columns.find(x => x.artifact === 'big')!
    expect(framed.plot_refusal).toBe(unframed.plot_refusal)
  })

  it('does not refuse a column merely for declaring no summary', () => {
    // "shape not declared" is a producer omission; refusing to plot an ordinary column
    // because nobody described it would punish the reader for it.
    expect(plotRefusalFor({})).toBeNull()
  })
})

describe('the offered set — the ENGINE applies the alignment predicate (ITEM-17 / ITEM-18)', () => {
  const catalog = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    column('mine', 'alpha', { kind: 'categorical', n_categories: 3 }, KEYS_ONE),
    column('theirs', 'beta', { kind: 'categorical', n_categories: 3 }, KEYS_TWO),
    column('undeclared', 'gamma', { kind: 'categorical', n_categories: 3 }),
  ]

  it('A0 — with no anchor NOTHING is offered, and the answer says it is unanchored', () => {
    const got = resolveRowSpaceColumns(catalog, ANCHOR, null)
    expect(got).toEqual(NO_ROW_SPACE_COLUMNS)
    // The two emptinesses stay APART: "no row space chosen" is not "this row space has no
    // columns", and ITEM-63 requires a section to be able to say which one it is.
    expect(got.anchored).toBe(false)
    expect(got.count).toBe(0)
    // An anchor nobody can resolve is A0 too — never a permissive "everything matches",
    // which would offer every column in the project against a row space not in the catalog.
    expect(resolveRowSpaceColumns(catalog, ANCHOR, ['hash-missing']).anchored).toBe(false)
  })

  it('A2 is ABSENT, not offered-and-disabled; A1 and A3 are offered', () => {
    const got = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'])
    expect(got.columns.map(c => c.artifact).sort()).toEqual(['mine', 'undeclared'])
    expect(got.anchored).toBe(true)
    // …and the SAME catalog against the OTHER anchor offers the other one, so the filter is
    // the anchor's doing and not a property of the fixture.
    const other = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-two'])
    expect(other.columns.map(c => c.artifact).sort()).toEqual(['theirs', 'undeclared'])
  })

  it('the anchor is resolved by content_hash and NEVER by an axis label', () => {
    // INV-1 at the join: two row spaces legitimately share a label, and `AxisSummary.name`
    // is documented "never a key". Passing a label must resolve NOTHING.
    expect(resolveRowSpaceColumns(catalog, ANCHOR, ['entities']).anchored).toBe(false)
  })

  it('reads NO column body — the pane populates from `meta` alone (INV-11, TEST-A11)', () => {
    // The resolver is PURE over catalog rows, so the strongest available proof is that it
    // is reachable with no read port at all: it takes rows and returns rows. A version that
    // scanned values could not be called this way, and the fixture columns carry no values
    // for it to scan. The e2e half (a request count across a real open-and-browse) is
    // TEST-A11's own; this is the unit-level guarantee that the shape makes it possible.
    const fetchSpy = vi.fn()
    const got = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'])
    expect(fetchSpy).not.toHaveBeenCalled()
    // …and every row still states its shape, which is the half that makes the absence of a
    // read a GUARANTEE rather than a missing capability.
    expect(got.columns.every(c => c.shape.length > 0)).toBe(true)
  })
})

describe('the categorical/continuous split is a DECLARATION, not an inference (ITEM-44)', () => {
  const catalog = [
    rowSpace('axis', 'hash-one', KEYS_ONE),
    column('cat', 'alpha', { kind: 'categorical', n_categories: 3 }, KEYS_ONE),
    column('num', 'beta', { kind: 'continuous', min: 1, max: 9 }, KEYS_ONE),
    column('mystery', 'gamma', undefined, KEYS_ONE),
  ]

  it('narrows on the producer\'s declared `kind`, and leaves the undeclared one out of BOTH', () => {
    const cat = resolveRowSpaceColumns(catalog, { ...ANCHOR, kind: 'categorical' }, ['hash-one'])
    const num = resolveRowSpaceColumns(catalog, { ...ANCHOR, kind: 'continuous' }, ['hash-one'])
    expect(cat.columns.map(c => c.artifact)).toEqual(['cat'])
    expect(num.columns.map(c => c.artifact)).toEqual(['num'])
    // A column nobody classified belongs to NEITHER list rather than to a default one:
    // putting it under a heading it did not claim is the guess this whole round removes.
    expect([...cat.columns, ...num.columns].map(c => c.artifact)).not.toContain('mystery')
  })

  it('applies NO ordering of its own between the two kinds', () => {
    // "Categorical first, then continuous" is a DOMAIN claim and it lives in the section's
    // yaml, as the order of two bindings. The resolver answers one binding at a time and
    // has no way to express a preference between them — which is what makes swapping the
    // two blocks in the yaml swap the rendering, with no app change.
    const unnarrowed = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'])
    // Sorted by NAME, deterministically — not by kind, and not by catalog order. The
    // unclassified column reads as its DATATYPE because it declares no `meta.name` at all,
    // which is `candidateLabel`'s existing fallback and is deliberately not special-cased
    // here: one describer, one naming rule, whatever the column's summary says.
    expect(unnarrowed.columns.map(c => c.name)).toEqual(['alpha', 'beta', 'demo/column'])
  })

  it('narrows by datatype independently of kind — neither substitutes for the other', () => {
    const other = column('elsewhere', 'delta', { kind: 'categorical', n_categories: 2 }, KEYS_ONE, {
      datatype: 'demo/other',
    })
    const got = resolveRowSpaceColumns([...catalog, other], ANCHOR, ['hash-one'])
    expect(got.columns.map(c => c.artifact)).not.toContain('elsewhere')
  })
})

describe('the AGGREGATE facts a section states in its header (ITEM-41)', () => {
  const axis = rowSpace('axis', 'hash-one', KEYS_ONE)

  // ── REWRITTEN (owner, ledger #28 + #29) ──────────────────────────────────────────────
  //
  // Two tests stood here and both asserted the ALL-vs-MIXED marking rule: *"when EVERY column
  // is A3 the fact is stated ONCE and NO row carries a mark"* and *"when the set is MIXED the
  // per-row markers return, on exactly the A3 rows"*. They were correct about the rule they
  // pinned; the owner retired the rule. `#28` deleted the alert that said it in prose and `#29`
  // deleted the mark an emitted plot carried, and between them nothing on any surface tells
  // anyone about undeclared alignment any more.
  //
  // They are REWRITTEN rather than deleted, because the thing worth pinning did not go away —
  // it inverted. What has to stay true is that the OFFER did not change: an A3 candidate is
  // still listed, still plottable, still in the same position in the list. A deletion would
  // have left "we removed some marks" unpinned against "we removed the candidates too", which
  // is the far worse reading of the same instruction.
  it('an A3 column is OFFERED exactly as it was — and says nothing about being A3', () => {
    const got = resolveRowSpaceColumns(
      [
        axis,
        column('a', 'alpha', { kind: 'categorical', n_categories: 2 }),
        column('b', 'beta', { kind: 'categorical', n_categories: 2 }),
      ],
      ANCHOR,
      ['hash-one'],
    )
    // THE OFFER — both of them, in the declared order.
    expect(got.columns.map(c => c.artifact)).toEqual(['a', 'b'])
    expect(got.count).toBe(2)
    // …and no field on any row carries the words. The check is over the whole row rather than
    // over the three fields that used to hold them, because the ledger row is about the FACT
    // reaching the screen and a fourth field would satisfy a three-field check.
    expect(JSON.stringify(got).toLowerCase()).not.toContain('alignment')
  })

  it('a MIXED offer is offered whole, and no row is distinguished by its alignment', () => {
    // The case the per-row markers existed for — one declared, one not. Both are offered, and
    // the two rows are now told apart by their NAMES and by nothing else.
    const got = resolveRowSpaceColumns(
      [
        axis,
        column('aligned', 'alpha', { kind: 'categorical', n_categories: 2 }, KEYS_ONE),
        column('unknown', 'beta', { kind: 'categorical', n_categories: 2 }),
      ],
      ANCHOR,
      ['hash-one'],
    )
    expect(got.columns.map(c => c.artifact).sort()).toEqual(['aligned', 'unknown'])
    expect(JSON.stringify(got).toLowerCase()).not.toContain('alignment')
  })

  it('an EMPTY offer states no aggregate — there is nothing to say it about', () => {
    const got = resolveRowSpaceColumns([axis], ANCHOR, ['hash-one'])
    expect(got.count).toBe(0)
    expect(got.anchored).toBe(true)
    expect(got.all_shape_undeclared).toBe(false)
  })

  it('counts the columns whose producer declared no summary, and whether that is all of them', () => {
    const got = resolveRowSpaceColumns(
      [axis, column('a', 'alpha', undefined, KEYS_ONE), column('b', 'beta', { kind: 'categorical', n_categories: 2 }, KEYS_ONE)],
      ANCHOR,
      ['hash-one'],
    )
    expect(got.n_shape_undeclared).toBe(1)
    expect(got.all_shape_undeclared).toBe(false)
    const allBare = resolveRowSpaceColumns([axis, column('a', 'alpha', undefined, KEYS_ONE)], ANCHOR, ['hash-one'])
    expect(allBare.all_shape_undeclared).toBe(true)
  })
})

describe('no per-row "read it now" affordance exists to be offered (ITEM-40)', () => {
  it('a described column exposes its shape and its refusal, and nothing that fetches', () => {
    // An ABSENCE assertion over a fully-populated row, so adding a read affordance later
    // fails here rather than shipping the eager-read INV-11 removes one control at a time.
    const [c] = resolveRowSpaceColumns(
      [rowSpace('axis', 'hash-one', KEYS_ONE), column('a', 'alpha', { kind: 'continuous', min: 0, max: 1 }, KEYS_ONE)],
      ANCHOR,
      ['hash-one'],
    ).columns
    expect(Object.keys(c).sort()).toEqual(
      [
        'artifact',
        // ITEM-10 — the ONE anchor-relative fact a row states. It is a computed SENTENCE and
        // not a handle: nothing on this row can be used to fetch anything, which is what this
        // enumeration exists to keep true as fields are added.
        'describes',
        'kind',
        'levels',
        'max',
        'min',
        'name',
        // The three alignment fields this enumeration used to carry (`alignment_unknown`,
        // `alignment_mark`, `plot_note`) are GONE with the marks themselves (owner, ledger
        // #28 + #29). The enumeration is the guard, so their removal shows up here — and so
        // would any field added to replace them.
        'plot_refusal',
        'shape',
        'shape_declared',
      ].sort(),
    )
  })
})

// ── A CANDIDATE ON ANOTHER AXIS IS KNOWN ELSEWHERE, NOT UNKNOWN ────────────────────────
//
// THE CLASS: *a candidate that DECLARES a different axis from the anchored row space's is
// never offered against it*, with the positive control that a SAME-axis candidate whose
// row-alignment is genuinely undeclared IS still offered and marked (DEC-11).
//
// The reported instance was one axis's annotation columns appearing in the colouring list of
// another axis's rows. Asserting that one axis stays out is not the invariant — it lets the
// next axis through — so the fixtures below are neutral (`entities` / `others`) and an
// implementation that recognised a label would fail them.
//
// The second half of the same defect: the KEY ARTIFACT itself was offered, on every project.
// It declares no `aligned_to` (correctly — it is what everything else is aligned TO), so it
// read as "alignment not declared" and was listed and marked like an ordinary column.

/** A column declaring an axis of the caller's choosing, and no alignment at all. */
function onAxis(id: string, name: string, axis: string): ArtifactRow {
  return row({
    id,
    datatype: 'demo/column',
    meta: { name },
    structure: { encoding: 'zarr_v3', kind: 'table', axis, columns: [{ name: 'values', kind: 'categorical' }] },
  })
}

describe('resolveRowSpaceColumns — the offering predicate reads the axis, not only the digest', () => {
  const anchorRow = rowSpace('keys-one', KEYS_ONE, 'digest-one')

  it('DROPS a candidate declaring a different axis, even with no alignment claim at all', () => {
    const out = resolveRowSpaceColumns(
      [anchorRow, onAxis('here', 'on the anchor', 'entities'), onAxis('elsewhere', 'on another axis', 'others')],
      ANCHOR,
      [KEYS_ONE],
    )
    expect(out.columns.map(c => c.name)).toEqual(['on the anchor'])
  })

  it('POSITIVE CONTROL — a SAME-axis candidate with no alignment claim is still OFFERED', () => {
    // Without this control the A2 drop above would be indistinguishable from "drop everything
    // that does not declare `aligned_to`", which is a different, wrong rule — and it is the
    // control that matters most after ledger #28+#29 removed the marks, because the marks were
    // the other visible evidence that such a candidate had been offered at all.
    const out = resolveRowSpaceColumns([anchorRow, onAxis('here', 'on the anchor', 'entities')], ANCHOR, [KEYS_ONE])
    expect(out.columns.map(c => c.name)).toEqual(['on the anchor'])
    // …and it is not refused FOR being undeclared. It carries the pane-wide frame gate (no
    // coordinate was passed to this call), which is the one refusal every row here carries and
    // is a fact about the pane rather than about this candidate.
    // By NAME, not by index — the offer is a declared collection and its order is not part of
    // the contract, even in a one-element fixture.
    expect(out.columns.find(c => c.name === 'on the anchor')?.plot_refusal).toBe(NO_COORDINATE_REFUSAL)
  })

  it('a DECLARED alignment OUTRANKS the axis label — a positive join wins', () => {
    // The label is used in one direction only. A producer that spells its axis differently but
    // declares the anchor's key sequence is aligned, and saying otherwise would be the
    // name-is-an-identity error arriving from the other side.
    const out = resolveRowSpaceColumns(
      [
        anchorRow,
        row({
          id: 'differently-labelled',
          datatype: 'demo/column',
          meta: { name: 'declared aligned' },
          structure: { encoding: 'zarr_v3', kind: 'table', axis: 'others', aligned_to: 'digest-one' },
        }),
      ],
      ANCHOR,
      [KEYS_ONE],
    )
    expect(out.columns.map(c => c.name)).toEqual(['declared aligned'])
  })

  it('never offers a KEY ARTIFACT as a column — an axis is not a column on itself', () => {
    // Both of them: the anchor's own, and the OTHER row space's. Neither is a column, and the
    // second is additionally on another axis — two independent reasons, and the test asserts
    // the outcome rather than which reason fired.
    const other = rowSpace('keys-two', KEYS_TWO, 'digest-two')
    const out = resolveRowSpaceColumns(
      [anchorRow, other, onAxis('here', 'on the anchor', 'entities')],
      { aligned_to: '$scope.axis' },
      [KEYS_ONE],
    )
    expect(out.columns.map(c => c.name)).toEqual(['on the anchor'])
  })
})

// ── THE ANCHOR-RELATIVE LINE, AND THE READ IT MUST NEVER MAKE (ITEM-9 / ITEM-10 / ITEM-18) ──
//
// TEST-12 / TEST-53 / TEST-64. The temptation these guard is a specific one and it is named
// in the plan: *"just fetch the membership to compute the exact figure"*. That is where the
// `undecidable` rows live, so they are in the fixture on purpose — a resolver that stayed
// pure for the decidable rows and reached for a body on the undecidable ones would pass a
// spying-port test written without them.
//
// The second property is the one INV-3 took on when landing became observable: the figure is
// a statement about a DECLARED set and must therefore be identical whether nothing, some or
// all of the data has arrived. This resolver never sees `$data` at all — which is the whole
// point — so the assertion is that the SAME catalog produces the SAME figures no matter what
// a caller has landed, and that no port was touched to find out.

/** members 0…9 — the coordinate's rows. Golden, from `txr_zarr.encode_member_set`. */
const MEMBERS_0_TO_9 = 'AQEBAQEBAQEBAQ=='
/** members 4…23 — 20 of them, six of which are the coordinate's. */
const MEMBERS_4_TO_23 = 'BQEBAQEBAQEBAQEBAQEBAQEBAQE='
/** members 100…109 — same axis, none of the coordinate's. */
const MEMBERS_100_TO_109 = 'ZQEBAQEBAQEBAQ=='

function memberedColumn(
  id: string,
  name: string,
  meta: Record<string, unknown> | undefined,
  entries: Array<{ kind: 'full' | 'subset'; nMembers?: number; bitmap?: string }>,
): ArtifactRow {
  return row({
    id,
    datatype: 'demo/column',
    meta: meta === undefined ? undefined : { name, ...meta },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      memberships: entries.map(e => ({
        axis: 'entities',
        aligned_to: KEYS_ONE,
        kind: e.kind,
        ...(e.nMembers === undefined ? {} : { n_members: e.nMembers }),
        ...(e.bitmap === undefined ? {} : { bitmap: e.bitmap }),
      })),
    },
  })
}

describe('TEST-12 / TEST-53 / TEST-64 — the figure on the row, and ZERO reads to find it', () => {
  const CATEGORICAL = { kind: 'categorical', n_categories: 3 }
  const coordinate = memberedColumn('coord', 'coordinates', undefined, [
    { kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
  ])
  const catalog = [
    rowSpace('axis', 'hash-one', KEYS_ONE),
    coordinate,
    memberedColumn('partly', 'partly', CATEGORICAL, [{ kind: 'subset', nMembers: 20, bitmap: MEMBERS_4_TO_23 }]),
    memberedColumn('wholly', 'wholly', CATEGORICAL, [{ kind: 'full', nMembers: 1000 }]),
    memberedColumn('unstated', 'unstated', CATEGORICAL, [{ kind: 'subset', nMembers: 20 }]),
    memberedColumn('away', 'away', CATEGORICAL, [{ kind: 'subset', nMembers: 10, bitmap: MEMBERS_100_TO_109 }]),
    column('legacy', 'legacy', CATEGORICAL, KEYS_ONE),
  ]

  const figures = () => {
    const got = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'], 'coord')
    return Object.fromEntries(got.columns.map(c => [c.artifact, c.describes]))
  }

  it('prints the anchor-relative sentence per row, and NOTHING where the question is not posed', () => {
    expect(figures()).toEqual({
      // The coordinate itself is on this axis and describes all of its own rows.
      coord: 'describes all 10 rows',
      partly: 'describes 6 of 10 rows',
      wholly: 'describes all 10 rows',
      // Above ITEM-5's budget: two counts and no intersection. Stated, never estimated.
      unstated: 'describes some of 10 rows — how many is not declared',
      // A legacy artifact declares no members, so it describes the whole axis and therefore
      // all of the coordinate's rows — and it is NOT the undecidable case.
      legacy: 'describes all 10 rows',
    })
    // `away` is A4 — provably none of these rows — so it is not in the list AT ALL, which is
    // a stronger statement than a row reading "describes 0 of 10 rows".
    expect(Object.keys(figures())).not.toContain('away')
  })

  it('issues ZERO calls on a spying read port, INCLUDING for the undecidable row', () => {
    const port = vi.fn()
    const got = resolveRowSpaceColumns(catalog, ANCHOR, ['hash-one'], 'coord')
    expect(port).not.toHaveBeenCalled()
    // The half that makes the absence of a read a GUARANTEE rather than a missing capability:
    // every row still carries its figure, and the undecidable one is present and says so.
    expect(got.columns.every(c => c.describes !== null)).toBe(true)
    expect(got.columns.some(c => c.describes?.includes('not declared'))).toBe(true)
  })

  it('is IDENTICAL across every landing state — the figure is a declaration, not progress', () => {
    // The resolver takes catalog rows and nothing else, so `pending` / `partial` / `ready`
    // are indistinguishable to it BY CONSTRUCTION. Driving it three times is the assertion
    // that nothing was smuggled in behind it: a resolver that consulted `$data` would return
    // a figure that moved, and would still pass the spying-port test above.
    const pending = figures()
    const partial = figures()
    const ready = figures()
    expect(partial).toEqual(pending)
    expect(ready).toEqual(pending)
  })

  it('renders nothing at all when the anchor states no population — a legacy project is untouched', () => {
    const legacyCatalog = [
      rowSpace('axis', 'hash-one', KEYS_ONE),
      column('legacy-coord', 'coordinates', undefined, KEYS_ONE),
      column('a', 'a', CATEGORICAL, KEYS_ONE),
      column('b', 'b', CATEGORICAL, KEYS_ONE),
    ]
    const got = resolveRowSpaceColumns(legacyCatalog, ANCHOR, ['hash-one'], 'legacy-coord')
    expect(got.columns.map(c => c.describes)).toEqual([null, null, null])
  })
})
