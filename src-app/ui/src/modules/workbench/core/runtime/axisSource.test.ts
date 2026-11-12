import { criterionColumn } from '@/modules/workbench/core/criteria/criteria'
import { declarationsOf } from './columnDeclarations'
import { describe, it, expect, vi } from 'vitest'
import type { ArtifactRow } from '@/modules/workbench/extensions/data/contract'
import type { DatatypeLattice } from '@/modules/workbench/core/datatypes/lattice'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  __resetColumnCollisionWarningsForTests,
  alignmentState,
  anchorId,
  anchorIds,
  offeredOnRowSpace,
  resolveRowSpaceAnchor,
  axisSourceRequestKey,
  declaredAxes,
  declaredValueKinds,
  axisColumnSources,
  criterionColumnNames,
  declaredComponentColumns,
  declaredComponentCount,
  matchesTypeFilter,
  mintColumnKeys,
  readAxisColumnsFrame,
  resolveArtifactRefSource,
  siblingsOnAxis,
  viewOwnAnalysisIds,
} from './axisSource'
// The criterion picker's options are minted from the resolved frame by this primitive, and
// it labels each option BY its frame key. Imported (never re-implemented) so "what the user
// can tell apart" is asserted through the real thing rather than through a stand-in.
import { columns_of } from './primitives'

// TEST-17 (ITEM-8) + TEST-20 (ITEM-11) — the two axis-scoped resolvers.
//
// The invariant under test is the one the manifest CANNOT express: a candidate set that
// depends on another control's value. Every case is written so that the tempting shortcut
// fails it — resolving project-wide when the anchor is unset, matching an axis by dataset
// alone, honouring a datatype filter but ignoring `excludes`, or reading a datatype
// declaration instead of the artifacts that actually landed.
//
// The fixtures are deliberately vocabulary-free: the resolver never reads an axis or column
// NAME for meaning, so naming one here would be an assumption the core does not make.

const DS_A = 'ds-alpha'
const DS_B = 'ds-beta'

function row(over: Partial<ArtifactRow> & { id: string }): ArtifactRow {
  return {
    project_id: 'p1',
    datatype: 'demo/column',
    structure: {},
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: DS_A,
    ...over,
  }
}

/** A `zarr_v3` table declaring ONE axis and its named columns. */
function table(
  id: string,
  axis: string,
  // `dtype` is the producer's STORED width (ITEM-32): a bool is declared `categorical` with
  // `dtype: bool`, and the kind alone cannot tell you its levels need the spelling bridge.
  cols: Array<{ name: string; kind: string; dtype?: string }>,
  over: Partial<ArtifactRow> = {},
) {
  return row({ id, structure: { encoding: 'zarr_v3', kind: 'table', axis, columns: cols }, ...over })
}

/**
 * A column as a REAL import actually writes it: a single-column store whose sole member is
 * the CONSTANT path `values`, with the column's real name only in `meta.name`.
 *
 * Every other fixture in this file names the member after the column — which is exactly why
 * no test caught the collision this shape produces. The shared column writer emits
 * `t.categorical("values", …)` / `t.string("values", …)` / `t.numeric("values", …)` for
 * every column, so on real data N columns declare ONE member name between them.
 */
function importedColumn(id: string, axis: string, name: string, kind: string) {
  return row({
    id,
    structure: { encoding: 'zarr_v3', kind: 'table', axis, columns: [{ name: 'values', kind }] },
    meta: { name, dtype: kind, n: 2, axis },
  })
}

/** A CSC matrix — declares BOTH axes, and is not a column source. */
function matrix(id: string, axes: string[], over: Partial<ArtifactRow> = {}) {
  return row({
    id,
    datatype: 'demo/matrix',
    structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes, shape: [3460, 35477] },
    ...over,
  })
}

/** A lattice with a hand-written `extends` chain + declared capabilities. */
function lattice(
  parents: Record<string, string | null> = {},
  caps: Record<string, string[]> = {},
): DatatypeLattice {
  const isA = (sub: string, sup: string): boolean => {
    let cur: string | null = sub
    while (cur) {
      if (cur === sup) return true
      cur = parents[cur] ?? null
    }
    return false
  }
  return {
    isA,
    matches: () => false,
    get: (id: string) => ({ capabilities: caps[id] ?? [] }) as never,
  }
}

describe('declaredAxes / declaredValueKinds read the ARTIFACT, not a datatype declaration', () => {
  it('a table names its one shared axis; a matrix names both', () => {
    expect(declaredAxes(table('t', 'cols', []).structure)).toEqual(['cols'])
    expect(declaredAxes(matrix('m', ['rows', 'cols']).structure)).toEqual(['rows', 'cols'])
  })

  it('an artifact declaring no axis contributes nothing (never a guessed default)', () => {
    expect(declaredAxes(undefined)).toEqual([])
    expect(declaredAxes({ encoding: 'opaque' })).toEqual([])
  })

  it('value kinds come from the producer-declared member kinds', () => {
    const t = table('t', 'cols', [
      { name: 'col_name', kind: 'string' },
      { name: 'metric_b', kind: 'numeric' },
    ])
    expect(declaredValueKinds(t.structure).sort()).toEqual(['numeric', 'string'])
  })
})

describe('siblingsOnAxis — scoped to the anchor artifact’s dataset AND axis', () => {
  const anchor = matrix('m1', ['rows', 'cols'])
  const artifacts = [
    anchor,
    table('names', 'cols', [{ name: 'col_name', kind: 'string' }]),
    table('analysis', 'rows', [{ name: 'metric_a', kind: 'numeric' }]),
    table('otherDsCols', 'cols', [{ name: 'col_name', kind: 'string' }], { source_dataset_id: DS_B }),
  ]

  it('returns only the same-dataset artifacts on the named axis', () => {
    expect(siblingsOnAxis(artifacts, 'm1', 'cols').map(a => a.id)).toEqual(['names'])
  })

  it('EXCLUDES the anchor itself, though it declares the axis', () => {
    // The anchor artifact declares the very axis it is being scoped by, so a naive
    // same-dataset+axis filter offers the thing the question was asked about as an
    // answer to it.
    expect(siblingsOnAxis(artifacts, 'm1', 'cols').map(a => a.id)).not.toContain('m1')
  })

  it('does not cross datasets', () => {
    expect(siblingsOnAxis(artifacts, 'm1', 'cols').map(a => a.id)).not.toContain('otherDsCols')
  })

  it('an anchor with no source dataset resolves to NOTHING, never project-wide', () => {
    const orphan = matrix('orphan', ['rows', 'cols'], { source_dataset_id: null })
    expect(siblingsOnAxis([orphan, ...artifacts], 'orphan', 'cols')).toEqual([])
  })

  it('an unknown anchor id resolves to nothing', () => {
    expect(siblingsOnAxis(artifacts, 'nope', 'cols')).toEqual([])
  })
})

// An anchor produced by INTEGRATING two datasets belongs to BOTH. The scope used to be
// scalar equality on one derived id, and the server used to answer that id with whichever
// source the producing run declared FIRST — so an integrated anchor was silently scoped to
// half its lineage and the other half's artifacts vanished from every dependent picker.
//
// Every assertion here would fail if the code went back to picking one source: the fixture
// has two, and both halves are named.
describe('siblingsOnAxis — an anchor integrating TWO datasets is scoped to both', () => {
  const integrated = matrix('int', ['rows', 'cols'], {
    // The wire's exactly-one rule: with several sources the singular pair is null and only
    // the set carries the truth. A fixture that also set `source_dataset_id` would let a
    // scalar-reading implementation pass.
    source_dataset_id: null,
    source_dataset_name: null,
    source_dataset_ids: [DS_A, DS_B],
    source_dataset_names: ['Dataset 1', 'Dataset 2'],
  })
  const fromA = table('colsA', 'cols', [{ name: 'col_name', kind: 'string' }], { source_dataset_id: DS_A })
  const fromB = table('colsB', 'cols', [{ name: 'col_name', kind: 'string' }], { source_dataset_id: DS_B })
  const fromC = table('colsC', 'cols', [{ name: 'col_name', kind: 'string' }], { source_dataset_id: 'ds-gamma' })
  const artifacts = [integrated, fromA, fromB, fromC]

  it('offers the siblings of BOTH sources, not the first-declared one', () => {
    expect(siblingsOnAxis(artifacts, 'int', 'cols').map(a => a.id).sort()).toEqual(['colsA', 'colsB'])
  })

  it('still excludes a dataset that is NOT one of its sources', () => {
    // The negative control: "both" must not have become "everything".
    expect(siblingsOnAxis(artifacts, 'int', 'cols').map(a => a.id)).not.toContain('colsC')
  })

  it('a single-source anchor is unchanged — it sees its own dataset only', () => {
    expect(siblingsOnAxis(artifacts, 'colsA', 'cols').map(a => a.id)).toEqual(['int'])
  })

  it('a candidate that itself integrates both datasets is a sibling of either source', () => {
    const other = table('bothCols', 'cols', [{ name: 'col_name', kind: 'string' }], {
      source_dataset_id: null,
      source_dataset_ids: [DS_A, DS_B],
    })
    expect(siblingsOnAxis([...artifacts, other], 'colsA', 'cols').map(a => a.id)).toContain('bothCols')
  })
})

describe('resolveArtifactRefSource — axis-scoped (ITEM-8)', () => {
  const artifacts = [
    matrix('m1', ['rows', 'cols']),
    table('names', 'cols', [{ name: 'col_name', kind: 'string' }]),
    table('ids', 'cols', [{ name: 'col_id', kind: 'string' }]),
    table('metricB', 'cols', [{ name: 'metric_b', kind: 'numeric' }]),
  ]
  const source = { axis: 'cols', of: '$state.matrix', datatype: 'demo/column', values: 'string' }

  it('is EMPTY until the referencing control has a value', () => {
    // The whole reason this cannot be a manifest key. An implementation that fell back to
    // "everything of the datatype" would return three here and look perfectly plausible.
    expect(resolveArtifactRefSource(artifacts, source, { state: {} })).toEqual([])
    expect(resolveArtifactRefSource(artifacts, source, { state: { matrix: '' } })).toEqual([])
    expect(resolveArtifactRefSource(artifacts, source, { state: { matrix: null } })).toEqual([])
  })

  it('resolves the siblings once the control has a value', () => {
    const got = resolveArtifactRefSource(artifacts, source, { state: { matrix: 'm1' } })
    expect(got.map(c => c.id).sort()).toEqual(['ids', 'names'])
  })

  it('filters by the declared VALUE kind (DEC-8: every string-valued artifact, unranked)', () => {
    const got = resolveArtifactRefSource(artifacts, source, { state: { matrix: 'm1' } })
    // The numeric column is out; BOTH string columns are in and neither is preferred —
    // guessing between `col_name` and `col_id` by name would be the hardcoded
    // spelling list this round removes.
    expect(got.map(c => c.id)).not.toContain('metricB')
    expect(got).toHaveLength(2)
  })

  // INVERTED by ITEM-11(b) — this test used to be titled "anchors on the FIRST selection when
  // the referencing control is multi-valued" and asserted that `['m1', 'm-other']` resolved
  // `m1`'s siblings. That is the defect, pinned as intent: an axis instance is (anchor dataset
  // × axis name), so a two-anchor selection names two instances and answering with the first
  // one's siblings is a different question, silently. `anchorIds` exists two lines below
  // `anchorId` precisely because the "they're all the same axis anyway" premise is false.
  //
  // What survives is the consistency that IS decidable here: a multi-selection every element
  // of which names ONE anchor still resolves (nothing is being chosen for the user), and one
  // naming two refuses.
  it('resolves a multi-valued selection only when every element names ONE anchor', () => {
    const consistent = resolveArtifactRefSource(artifacts, source, { state: { matrix: ['m1', 'm1'] } })
    expect(consistent.map(c => c.id).sort()).toEqual(['ids', 'names'])
    const conflicting = resolveArtifactRefSource(artifacts, source, { state: { matrix: ['m1', 'm-other'] } })
    expect(conflicting, 'two anchors identify two axis instances, so neither is answered').toEqual([])
  })

  it('labels a single-column artifact by its column name (what tells candidates apart)', () => {
    const got = resolveArtifactRefSource(artifacts, source, { state: { matrix: 'm1' } })
    expect(got.map(c => c.label).sort()).toEqual(['col_id', 'col_name'])
  })
})

// ── TEST-A4 (ITEM-14 / ITEM-17) [acceptance] [invariant: INV-4] ──────────────────────
//
// INV-4: a `$`-ref that resolves to `null` yields NO binding, and the consumer reports "not
// chosen yet" — it does NOT substitute something plausible.
//
// The block above already shows `null` → `[]`, but it does so against a catalog in which
// nothing plausible was AVAILABLE to substitute. That is the weak form: an implementation
// that silently fell back to "the same-named artifact in the new row space" would pass it,
// because there is no same-named artifact to fall back TO. INV-4 is a claim about what the
// resolver does when a substitute is sitting right there, so the fixture must put one there.
//
// The other half of this invariant — that the pane NULLS the coordinate on an anchor change
// rather than translating it — is asserted against the real store in
// `paneScopedField.test.ts` ("does NOT translate a coordinate across an anchor change"). The
// two together are INV-4: the writer refuses to translate, and the reader refuses to guess.
describe('INV-4 — a null ref binds NOTHING, with a plausible substitute available (TEST-A4)', () => {
  // Two row spaces. `coordsA` lives on the anchor the user HAD chosen; `coordsB` is
  // its namesake in the row space they moved to — identical column name, identical datatype,
  // different artifact. It is exactly what a "helpful" re-resolve would return.
  const artifacts = [
    matrix('space-a', ['rows_a', 'cols_a']),
    matrix('space-b', ['rows_b', 'cols_b']),
    table('coordsA', 'cols_a', [{ name: 'positions', kind: 'numeric' }]),
    table('coordsB', 'cols_b', [{ name: 'positions', kind: 'numeric' }]),
  ]
  const source = { axis: 'cols_a', of: '$state.anchor', datatype: 'demo/column', values: 'numeric' }

  it('the substitute IS resolvable — the fixture is not vacuous (positive control)', () => {
    // Without this the test below could pass because the catalog is empty or the source is
    // malformed, which would prove nothing at all about substitution.
    const got = resolveArtifactRefSource(artifacts, source, { state: { anchor: 'space-a' } })
    expect(got.map(c => c.id)).toEqual(['coordsA'])
    const other = resolveArtifactRefSource(
      artifacts,
      { ...source, axis: 'cols_b' },
      { state: { anchor: 'space-b' } },
    )
    expect(other.map(c => c.id), 'the namesake exists and is reachable').toEqual(['coordsB'])
  })

  it('a `null` ref yields NO binding — not the namesake, not anything', () => {
    for (const unset of [null, undefined, '']) {
      const got = resolveArtifactRefSource(artifacts, source, { state: { anchor: unset } })
      expect(got, `an unset spelled ${JSON.stringify(unset)} must bind nothing`).toEqual([])
    }
  })

  it('specifically does not reach for the SAME-NAMED artifact in the other row space', () => {
    // The named negative. `positions` is a real, offerable column with the right datatype and the
    // right value kind — everything except a user's choice.
    const got = resolveArtifactRefSource(artifacts, source, { state: { anchor: null } })
    expect(got.map(c => c.id)).not.toContain('coordsB')
    expect(got.map(c => c.label)).not.toContain('positions')
  })
})

describe('resolveArtifactRefSource — catalog source constraints', () => {
  // `demo/normalized` extends `demo/matrix` extends `matrix`; the normalized subtype is
  // the one the analysis must never be offered.
  const L = lattice({
    'demo/matrix': 'matrix',
    'demo/normalized': 'demo/matrix',
    'demo/column': null,
  })
  const artifacts = [
    row({ id: 'raw', datatype: 'demo/matrix' }),
    row({ id: 'norm', datatype: 'demo/normalized' }),
    row({ id: 'col', datatype: 'demo/column' }),
  ]

  it('subtypes_of offers every descendant', () => {
    const got = resolveArtifactRefSource(artifacts, { subtypes_of: 'matrix' }, {}, { lattice: L })
    expect(got.map(c => c.id).sort()).toEqual(['norm', 'raw'])
  })

  it('excludes DROPS a subtype of the excluded id (the analysis takes raw values only)', () => {
    // Running the analysis on an already-normalized input produces a number that is
    // arithmetically fine and meaningless for the question asked — a wrong answer with
    // no error.
    const got = resolveArtifactRefSource(
      artifacts,
      { subtypes_of: 'matrix', excludes: ['demo/normalized'] },
      {},
      { lattice: L },
    )
    expect(got.map(c => c.id)).toEqual(['raw'])
  })

  it('an excludes that CANNOT be evaluated fails CLOSED, never open', () => {
    // With no lattice the exclusion is unevaluable. Offering the candidate anyway would
    // silently deliver exactly what the constraint forbids; offering nothing is visible.
    const got = resolveArtifactRefSource(artifacts, { subtypes_of: 'matrix', excludes: ['x'] }, {})
    expect(got).toEqual([])
  })

  it('capabilities are honoured, and fail closed when the datatype is unknown', () => {
    const withCaps = lattice({ 'demo/matrix': 'matrix' }, { 'demo/matrix': ['sparse'] })
    expect(
      resolveArtifactRefSource(artifacts, { subtypes_of: 'matrix', capabilities: ['sparse'] }, {}, { lattice: withCaps })
        .map(c => c.id),
    ).toEqual(['raw'])
    expect(
      resolveArtifactRefSource(artifacts, { subtypes_of: 'matrix', capabilities: ['dense'] }, {}, { lattice: withCaps }),
    ).toEqual([])
    // No lattice ⇒ no declared capabilities ⇒ nothing satisfies the requirement.
    expect(resolveArtifactRefSource(artifacts, { capabilities: ['sparse'] }, {})).toEqual([])
  })

  it('an axis-scoped source honours excludes too (the constraint is not catalog-only)', () => {
    const L2 = lattice({ 'demo/column/derived': 'demo/column' })
    const arts = [
      matrix('m1', ['rows', 'cols']),
      table('names', 'cols', [{ name: 'col_name', kind: 'string' }]),
      table('derived', 'cols', [{ name: 'guess', kind: 'string' }], { datatype: 'demo/column/derived' }),
    ]
    const got = resolveArtifactRefSource(
      arts,
      { axis: 'cols', of: '$state.m', datatype: 'demo/column', excludes: ['demo/column/derived'] },
      { state: { m: 'm1' } },
      { lattice: L2 },
    )
    expect(got.map(c => c.id)).toEqual(['names'])
  })
})

// ── TEST-15 (ITEM-11b) — `anchorId` answers only when the selection names ONE anchor ───────
//
// It was `const first = Array.isArray(v) ? v[0] : v`, defended in prose: "the selections all
// sit on the same dataset by construction, so any of them names the same axis." No code
// checked that, and `anchorIds` exists directly below it BECAUSE the assumption is false for
// some callers — an axis instance is (anchor dataset × axis name), so two anchors from two
// datasets are two axes and the first one's answer is a different question wearing the right
// shape.
//
// The consistency that IS decidable in this scope (it sees an expression and a scope, never
// the catalog) is whether the selection resolves to one distinct id. So that is the gate: one
// distinct id binds, whatever the arity; anything else refuses, and the callers' existing
// "empty rather than unscoped" handling takes over.
describe('TEST-15: anchorId binds a provably consistent selection and refuses the rest', () => {
  const scope = (state: Record<string, unknown>) => ({ state })

  it('binds a scalar and a single-element selection (unchanged)', () => {
    expect(anchorId('$state.ds', scope({ ds: 'art-1' }))).toBe('art-1')
    expect(anchorId('$state.ds', scope({ ds: ['art-1'] }))).toBe('art-1')
  })

  it('binds a multi-selection whose elements are all the SAME anchor', () => {
    // Provably consistent: every element names one artifact, so there is one axis instance
    // and no choice is being made on the user's behalf.
    expect(anchorId('$state.ds', scope({ ds: ['art-1', 'art-1'] }))).toBe('art-1')
  })

  it('REFUSES a multi-selection naming two different anchors (the `[0]` this replaces)', () => {
    // Pre-fix this returned `'art-1'`, silently answering about ONE of two axis instances.
    expect(anchorId('$state.ds', scope({ ds: ['art-1', 'art-2'] }))).toBeUndefined()
    // The plural question is still answerable — by the seam that exists for it.
    expect(anchorIds('$state.ds', scope({ ds: ['art-1', 'art-2'] }))).toEqual(['art-1', 'art-2'])
  })

  it('REFUSES an empty selection, an empty string and a non-string', () => {
    expect(anchorId('$state.ds', scope({ ds: [] }))).toBeUndefined()
    expect(anchorId('$state.ds', scope({ ds: '' }))).toBeUndefined()
    expect(anchorId('$state.ds', scope({ ds: null }))).toBeUndefined()
    expect(anchorId(undefined, scope({}))).toBeUndefined()
  })
})

describe('axisSourceRequestKey — the re-resolve trigger', () => {
  const spec = (data: ViewSpec['data']): ViewSpec => ({
    id: 'v',
    title: 'v',
    permission: 'jobs::use',
    state: {},
    data,
    widgets: [],
    actions: [],
  })

  it('a spec with no axis source digests to nothing (epoch-only behaviour is unchanged)', () => {
    expect(axisSourceRequestKey(spec({ rowmeta: { source: 'job.result' } }), { x: 1 })).toBe('')
  })

  it('changes when the anchored value changes', () => {
    const s = spec({ rowmeta: { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows' } } })
    const a = axisSourceRequestKey(s, { ds: 'art-1' })
    const b = axisSourceRequestKey(s, { ds: 'art-2' })
    expect(a).not.toBe(b)
    expect(a).toContain('art-1')
  })

  it('is STABLE across unrelated state churn (a drag must not become a refetch storm)', () => {
    const s = spec({ rowmeta: { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows' } } })
    expect(axisSourceRequestKey(s, { ds: 'art-1', slider: 1 })).toBe(
      axisSourceRequestKey(s, { ds: 'art-1', slider: 999 }),
    )
  })

  // ── ITEM-34 — the digest must follow the CRITERION COLUMNS, and nothing else about them ───
  //
  // This is the link that makes a lazy body actually arrive. If the key does not move when the
  // user points a criterion at a new column, the slice never re-resolves, the body never lands,
  // and the criterion sits pending forever behind a loading message that never clears — a dead
  // form with no error. If it moves on every EDIT of a criterion, a slider drag becomes the
  // refetch storm this whole key exists to prevent. Both directions, therefore.
  describe('lazy bodies (ITEM-34)', () => {
    const lazy = spec({
      rowmeta: {
        source: 'axis_columns',
        args: { of: '$state.ds', axis: 'rows', values_for: '$state.criteria' },
      },
    })

    it('MOVES when a criterion names a different column — or the body never arrives', () => {
      const a = axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'alpha' }] })
      const b = axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'beta' }] })
      expect(a).not.toBe(b)
    })

    it('MOVES when a criterion is added, and again when it is removed', () => {
      const none = axisSourceRequestKey(lazy, { ds: 'd', criteria: [] })
      const one = axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'alpha' }] })
      expect(none).not.toBe(one)
      expect(axisSourceRequestKey(lazy, { ds: 'd', criteria: [] })).toBe(none)
    })

    it('is STABLE when only a BOUND changes — editing a threshold must not refetch', () => {
      expect(
        axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'alpha', max: 1 }] }),
      ).toBe(axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'alpha', max: 999 }] }))
    })

    it('is STABLE when only a KEEP-SET changes, and when criteria are REORDERED', () => {
      expect(
        axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'a', keep: ['x'] }] }),
      ).toBe(axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'a', keep: ['x', 'y'] }] }))
      // The wanted SET is what decides the fetch, so its order must not.
      expect(
        axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'a' }, { column: 'b' }] }),
      ).toBe(axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: 'b' }, { column: 'a' }] }))
    })

    it('a blank or whitespace-only column contributes nothing (a freshly-added row)', () => {
      const none = axisSourceRequestKey(lazy, { ds: 'd', criteria: [] })
      expect(axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: '' }] })).toBe(none)
      expect(axisSourceRequestKey(lazy, { ds: 'd', criteria: [{ column: '   ' }] })).toBe(none)
    })

    it('a slice WITHOUT `values_for` is unaffected by criteria — eager stays eager', () => {
      const eager = spec({ rowmeta: { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows' } } })
      expect(axisSourceRequestKey(eager, { ds: 'd', criteria: [{ column: 'alpha' }] })).toBe(
        axisSourceRequestKey(eager, { ds: 'd', criteria: [] }),
      )
    })
  })
})

describe('readAxisColumnsFrame (TEST-20, ITEM-11)', () => {
  const anchor = matrix('m1', ['rows', 'cols'])
  // The reference case: columns the IMPORT landed (which no analysis declared) sitting
  // beside columns a run produced.
  const imported = table('imported', 'rows', [
    { name: 'label_b', kind: 'categorical' },
    { name: 'label_a', kind: 'categorical' },
  ])
  const analysisOut = table('analysis', 'rows', [{ name: 'ns:metric_a', kind: 'numeric' }])
  const colsTable = table('colsTable', 'cols', [{ name: 'col_name', kind: 'string' }])
  const artifacts = [anchor, imported, analysisOut, colsTable]

  const FRAMES: Record<string, Record<string, unknown[]>> = {
    imported: { label_b: ['a1', 'a2'], label_a: ['b1', 'b2'] },
    analysis: { 'ns:metric_a': [1, 2] },
    colsTable: { col_name: ['x1', 'x2'] },
  }
  const read = async (r: ArtifactRow) => FRAMES[r.id] ?? {}

  it('returns EVERY metadata column on the axis, including ones no analysis declared', () => {
    return readAxisColumnsFrame(artifacts, 'm1', 'rows', read).then(frame => {
      // `label_b` / `label_a` exist only because the import landed them. A resolver
      // reading the newest artifact of a DECLARED datatype offers `ns:metric_a` alone,
      // which is precisely the measured defect (9 declared, 8 of them absent, 65 real).
      expect(Object.keys(frame).sort()).toEqual(['label_a', 'label_b', 'ns:metric_a'])
    })
  })

  // ── the SINGLE-COLUMN-STORE shape ─────────────────────────────────────────────────
  //
  // The defect these pin is not hypothetical: it is what a user gets from every real
  // import. A single-column store writes its sole member under a CONSTANT path, so N
  // columns on one axis declare ONE member name between them. A frame merged on member
  // names then keeps ONE column, and the `as: sources` map keeps ONE entry — so a view
  // offering "a criterion on any column" offers a single meaningless one, and every
  // `column:<name>` run-binding resolves to nothing.
  //
  // Names here are the file's own generic vocabulary (`rows`/`cols`, `ns:metric_*`,
  // `label_*`) because the rule under test is about NAMING, not about any domain: the
  // resolver is core and must never learn one.
  //
  // Both assertions fail on the old member-name rule; the frame one returns
  // `{values: [...]}` and the sources one `{values: <last id>}`.
  describe('the single-column-store shape: every column declares the member name `values`', () => {
    const soleAnchor = matrix('mReal', ['rows', 'cols'])
    const real = [
      soleAnchor,
      importedColumn('a-one', 'rows', 'ns:metric_a', 'numeric'),
      importedColumn('a-two', 'rows', 'ns:metric_b', 'numeric'),
      importedColumn('a-three', 'rows', 'label_a', 'categorical'),
    ]
    const readReal = async (r: ArtifactRow) =>
      (({
        'a-one': { values: [1, 2] },
        'a-two': { values: [10, 20] },
        'a-three': { values: ['x', 'y'] },
      }) as Record<string, Record<string, unknown[]>>)[r.id] ?? {}

    it('keeps every column under the PRODUCER name, not one collapsed `values`', async () => {
      const frame = await readAxisColumnsFrame(real, 'mReal', 'rows', readReal)
      expect(Object.keys(frame).sort()).toEqual(['label_a', 'ns:metric_a', 'ns:metric_b'])
      expect(frame).not.toHaveProperty('values')
      // Each name still carries ITS OWN values — a rename that crossed the wires would
      // pass the key assertion above while feeding every consumer the wrong column.
      expect(frame['ns:metric_b']).toEqual([10, 20])
      expect(frame['label_a']).toEqual(['x', 'y'])
    })

    it('maps each column name back to the artifact it came from (`as: sources`)', () => {
      const sources = axisColumnSources(real, 'mReal', 'rows')
      expect(sources).toEqual({
        'ns:metric_a': 'a-one',
        'ns:metric_b': 'a-two',
        label_a: 'a-three',
      })
    })

    it('renames a sole column even when the READER keys it differently from the declaration', async () => {
      // The frame key is minted from the DECLARED member path, which is the same string the
      // reader hands back today — every producer writes `name === path`. The codebase is
      // explicit that the two are a LABEL and an ADDRESS and may diverge, and a divergence
      // here is silent: the column would land under the reader's raw key (`0`), which is not
      // a name anyone can pick, and its real name would be free for the next artifact to
      // occupy. So a sole member is the producer's column whatever the reader called it.
      const sole = importedColumn('a-solo', 'rows', 'ns:metric_z', 'numeric')
      const frame = await readAxisColumnsFrame([soleAnchor, sole], 'mReal', 'rows', async () => ({
        '0': [7, 8],
      }))
      expect(Object.keys(frame)).toEqual(['ns:metric_z'])
      expect(frame['ns:metric_z']).toEqual([7, 8])
    })

    it('does NOT rename a multi-column table — its members carry real names already', async () => {
      // `meta.name` on a multi-member artifact describes the WHOLE artifact, so preferring
      // it per member would collapse a real table the way `values` collapsed these.
      const multi = table('multi', 'rows', [
        { name: 'label_b', kind: 'categorical' },
        { name: 'ns:metric_c', kind: 'numeric' },
      ])
      multi.meta = { name: 'a combined table' }
      const frame = await readAxisColumnsFrame([soleAnchor, multi], 'mReal', 'rows', async () => ({
        label_b: ['d1', 'd2'],
        'ns:metric_c': [30, 40],
      }))
      expect(Object.keys(frame).sort()).toEqual(['label_b', 'ns:metric_c'])
      expect(axisColumnSources([soleAnchor, multi], 'mReal', 'rows')).toEqual({
        label_b: 'multi',
        'ns:metric_c': 'multi',
      })
    })
  })

  it('is scoped to the named axis — a `cols` column never leaks into the `rows` frame', async () => {
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read)
    expect(frame).not.toHaveProperty('col_name')
  })

  it('is EMPTY until the anchor resolves', async () => {
    expect(await readAxisColumnsFrame(artifacts, undefined, 'rows', read)).toEqual({})
    expect(await readAxisColumnsFrame(artifacts, 'm1', undefined, read)).toEqual({})
  })

  it('never hands a MATRIX to the table reader (it is on the axis but is not a column source)', async () => {
    const spy = vi.fn(read)
    await readAxisColumnsFrame(artifacts, 'imported', 'rows', spy)
    // Anchoring on a column artifact makes the matrix a "sibling on the `rows` axis"; only
    // its lack of declared columns keeps it out.
    expect(spy.mock.calls.map(c => c[0].id)).not.toContain('m1')
  })

  // ── ITEM-34 — LAZY BODIES: metadata for every column, values only for the ones named ──────
  //
  // The read-reduction this whole item exists for. What must hold at once is easy to state and
  // easy to half-implement: the picker still sees EVERY column (or it blanks), and the network
  // sees only the artifacts a criterion refers to (or nothing was saved). Both are asserted
  // here, on the same call, because either alone passes with the other broken.
  describe('lazy column bodies (ITEM-34)', () => {
    it('reads ONLY the artifacts whose columns a criterion names', async () => {
      const spy = vi.fn(read)
      const frame = await readAxisColumnsFrame(
        artifacts,
        'm1',
        'rows',
        spy,
        undefined,
        undefined,
        name => name === 'ns:metric_a',
      )
      // The NETWORK half: `imported` declares two columns, neither named, so its bytes are
      // never requested. Non-vacuity is built in — `analysis` IS read, so a predicate that
      // refused everything would fail the next assertion rather than pass this one.
      expect(spy.mock.calls.map(c => c[0].id)).toEqual(['analysis'])
      // The VALUES half: only the named column has a body.
      expect(Object.keys(frame)).toEqual(['ns:metric_a'])
      // The METADATA half — the one that keeps the picker populated. Every column on the axis
      // is still described, including the two whose bytes were skipped.
      expect(Object.keys(declarationsOf(frame)).sort()).toEqual([
        'label_a',
        'label_b',
        'ns:metric_a',
      ])
      // …and described CORRECTLY, from the producer's declaration rather than a head peek.
      expect(declarationsOf(frame).label_a?.kind).toBe('categorical')
      expect(declarationsOf(frame)['ns:metric_a']?.kind).toBe('continuous')
    })

    it('names NO column ⇒ no artifact is read at all, and every column is still described', async () => {
      // The opening state of the form, and the one a naive implementation reports as `empty`.
      const spy = vi.fn(read)
      const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', spy, undefined, undefined, () => false)
      expect(spy).not.toHaveBeenCalled()
      expect(Object.keys(frame)).toEqual([])
      expect(Object.keys(declarationsOf(frame)).sort()).toEqual(['label_a', 'label_b', 'ns:metric_a'])
    })

    it('laziness changes WHETHER bytes are fetched, never WHICH artifacts are candidates', async () => {
      // The property that keeps the lazy path from quietly narrowing the axis. An artifact
      // declaring no columns is already excluded upstream by `axisColumnRows` (the sibling test
      // above pins that for the matrix), so the predicate must not be a second, different
      // filter — the DESCRIBED column set has to be identical either way.
      const eager = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read)
      const lazy = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read, undefined, undefined, () => false)
      expect(Object.keys(declarationsOf(lazy)).sort()).toEqual(Object.keys(declarationsOf(eager)).sort())
      // …and the eager frame's VALUES are the superset the lazy one defers.
      expect(Object.keys(eager).sort()).toEqual(['label_a', 'label_b', 'ns:metric_a'])
      expect(Object.keys(lazy)).toEqual([])
    })

    // ── H5 — the resolver and the kernel must normalise a column name IDENTICALLY ────────────
    //
    // WHAT THIS DOES WHEN THE DEFECT IS PRESENT: `criterionColumnNames` used JS `trim()` while
    // claiming to apply "the same normalisation `criterionColumn` applies". It does not:
    // `criterionColumn` strips the SIX ASCII whitespace characters precisely BECAUSE JS `trim()`
    // also eats U+FEFF while python's `str.strip()` and Rust's `str::trim()` do not. An
    // Excel-written CSV header column (a `"\ufeff"` prefixing the name) was therefore resolved to
    // the bare name here and looked up under the BOM-bearing spelling by the keep-mask — the
    // resolver fetches one column, the kernel finds another, and the criterion sits inert behind
    // an all-false mask.
    //
    // The column names below are arbitrary padding carriers; nothing about the property under test
    // depends on which name is used, only on which whitespace surrounds it.
    //
    // Asserted as an EQUIVALENCE against `criterionColumn` itself rather than against a spelled-out
    // expectation, so the two cannot drift apart again whatever either decides to strip.
    it('normalises a criterion column name exactly as the keep-mask kernel does', () => {
      const names = ['\ufeffratio_a', '  padded_name  ', '\u001cpy_only', 'plain']
      const scope = { state: { criteria: names.map(column => ({ column })) } }
      expect(criterionColumnNames('$state.criteria', scope)).toEqual(
        [...new Set(names.map(column => criterionColumn({ column })))].filter(n => n !== '').sort(),
      )
      // Non-vacuity: the case only exists if the two normalisations CAN differ on this input.
      expect(
        criterionColumn({ column: '\ufeffratio_a' }),
        'the BOM case is not being exercised — criterionColumn now strips U+FEFF too',
      ).not.toBe('\ufeffratio_a'.trim())
    })

    // ── H2 — the gate is asked in the vocabulary the CALLER answers in ───────────────────────
    //
    // WHAT THIS DOES WHEN THE DEFECT IS PRESENT: the gate asked `wantValues` the BARE declared
    // name, while a criterion carries `col.key` — and `mintColumnKeys` qualifies that key to
    // `name · <shortid>` for any name occurring on more than one artifact (this file's own notes
    // record a live project with three). Every test above uses names that are unique on the axis,
    // where key and name are the same string, so none of them can tell the two apart. With two
    // artifacts declaring `shared_metric`, the criterion's key matches no declared name, no
    // artifact is read, the column comes back declared-but-absent, and the keep-mask goes
    // ALL-FALSE — 0 of N rows behind a permanent spinner, because the re-resolve digest holds
    // the same name set on every edit and nothing ever re-resolves.
    it('fetches the body for a criterion carrying the QUALIFIED key of a contested name', async () => {
      const one = importedColumn('art-one', 'rows', 'shared_metric', 'numeric')
      const two = importedColumn('art-two', 'rows', 'shared_metric', 'numeric')
      const rows = [anchor, one, two]
      const spy = vi.fn(async (r: ArtifactRow) => ({ values: r.id === 'art-one' ? [1, 2] : [3, 4] }))

      // The key the PICKER offers and a saved criterion therefore carries — taken from the minter,
      // not spelled by hand, so this stays true if the qualifier format ever changes.
      const keys = mintColumnKeys([
        { artifactId: 'art-one', name: 'shared_metric' },
        { artifactId: 'art-two', name: 'shared_metric' },
      ])
      const wanted = keys.find(k => k.artifactId === 'art-two')!.key
      // Non-vacuity: the case only exists when the key really is qualified.
      expect(wanted, 'the name was not contested — this case is not being exercised').not.toBe(
        'shared_metric',
      )

      const frame = await readAxisColumnsFrame(
        rows,
        'm1',
        'rows',
        spy,
        undefined,
        undefined,
        name => name === wanted,
      )
      expect(spy.mock.calls.map(c => c[0].id), 'the qualified column\'s body was never fetched').
        toEqual(['art-two'])
      // …and it landed under the key the criterion names, carrying ITS artifact's values.
      expect(frame[wanted], 'the body arrived under a key no criterion can address').toEqual([3, 4])
    })

    it('a producer declaring `kind: bool` gets the level SPELLING bridge (isDeclaredBool)', async () => {
      // The branch the inline `dtype === 'bool'` test missed. A bool column is normally declared
      // `kind: categorical` + `dtype: bool`, but a producer may declare the kind directly — and
      // if its levels are offered RAW ("true") against a comparator that spells them "True",
      // every row of that criterion disappears with no error. `isDeclaredBool` is the one place
      // that rule lives; this is what proves it is actually consulted.
      const boolCol = table('boolArt', 'rows', [{ name: 'flag', kind: 'bool' }])
      const frame = await readAxisColumnsFrame(
        [anchor, boolCol],
        'm1',
        'rows',
        async () => ({ flag: [1, 0] }),
        undefined,
        async () => ['false', 'true'],
      )
      expect(declarationsOf(frame).flag?.levels).toEqual(['False', 'True'])
    })

    it('omitting the predicate is EAGER — byte-identical to before lazy bodies', async () => {
      const spy = vi.fn(read)
      const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', spy)
      expect(Object.keys(frame).sort()).toEqual(['label_a', 'label_b', 'ns:metric_a'])
      expect(spy.mock.calls.map(c => c[0].id).sort()).toEqual(['analysis', 'imported'])
    })
  })

  it('one unreadable artifact does not sink the frame', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flaky = async (r: ArtifactRow) => {
      if (r.id === 'analysis') throw new Error('read failed')
      return FRAMES[r.id] ?? {}
    }
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', flaky)
    // "one column is unreadable" and "the dataset has no metadata" are different
    // situations; only the second should blank a criteria builder.
    expect(Object.keys(frame).sort()).toEqual(['label_a', 'label_b'])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  // The merge is the ONE place two artifacts can claim the same column name, and the rule
  // is the ONE the whole subsystem turns on. It used to be "LATER ROWS WIN", justified as
  // matching a newest-first arrival order — a rule that made sense only while EVERY column
  // arrived under the same key (`values`), when a collision was the norm and the merge was
  // damage control. Once columns carried their producer's real name a collision became a
  // REAL event, and last-write-wins became silent data substitution: on a live project the
  // catalog held THREE artifacts declaring one column (the artifact natural key is
  // `(project, dataset, run, output)` — the NAME is not in it, so every re-run legitimately
  // adds another row), exactly one reached the builder, and nothing on screen said so.
  //
  // The replacement rule: a collision is resolved by ADDRESS, never by order.
  describe('two artifacts declaring the SAME column name on one axis', () => {
    const older = table('older', 'rows', [{ name: 'label_a', kind: 'categorical' }])
    const newer = table('newer', 'rows', [
      { name: 'label_a', kind: 'categorical' },
      { name: 'label_b', kind: 'categorical' },
    ])
    const COLLIDING: Record<string, Record<string, unknown[]>> = {
      older: { label_a: ['from_older', 'from_older'] },
      newer: { label_a: ['from_newer', 'from_newer'], label_b: ['n1', 'n1'] },
    }
    const readColliding = async (r: ArtifactRow) => COLLIDING[r.id] ?? {}
    // The two keys the rule mints, SPELLED OUT rather than derived from the implementation:
    // they are what a user reads in the picker, so a test that recomputed them with the
    // resolver's own helper would pass whatever that helper became.
    const OLDER_KEY = 'label_a · older'
    const NEWER_KEY = 'label_a · newer'

    it('keeps BOTH — neither column is dropped, and neither answers to the bare name', async () => {
      const frame = await readAxisColumnsFrame([anchor, older, newer], 'm1', 'rows', readColliding)
      expect(Object.keys(frame).sort()).toEqual([NEWER_KEY, OLDER_KEY, 'label_b'].sort())
      expect(
        frame,
        'the bare name names two columns, so nothing may be offered under it — that is the ' +
          'key a criterion built before the second artifact landed silently re-pointed through',
      ).not.toHaveProperty('label_a')
      // Each key carries ITS OWN values. A rule that made the keys distinct while crossing
      // the values would pass the key assertion above and feed every consumer the wrong column.
      expect(frame[OLDER_KEY]).toEqual(['from_older', 'from_older'])
      expect(frame[NEWER_KEY]).toEqual(['from_newer', 'from_newer'])
    })

    it('does NOT depend on the order the rows arrive in', async () => {
      // THE property. Under the old rule these two frames differ in the one column that
      // matters; under this one the caller's order cannot be read back out of the answer.
      const forward = await readAxisColumnsFrame([anchor, older, newer], 'm1', 'rows', readColliding)
      const reversed = await readAxisColumnsFrame([anchor, newer, older], 'm1', 'rows', readColliding)
      expect(reversed).toEqual(forward)
      // Not vacuous: the frame really does carry both columns' values, so "equal" is a
      // statement about content and not about two empty objects.
      expect(Object.keys(forward).length).toBe(3)
    })

    it('the criterion PICKER can tell them apart — two options, each naming its own artifact', async () => {
      // What the USER can determine, asserted through the thing the user actually sees:
      // `columns_of` mints one option per frame key and labels it BY that key, so a frame
      // that cannot distinguish two columns produces a picker that cannot either. An
      // assertion that some internal map has two entries would not have caught that.
      const frame = await readAxisColumnsFrame([anchor, older, newer], 'm1', 'rows', readColliding)
      const options = columns_of(frame as Record<string, readonly unknown[]>) as Array<{
        value: string
        label: string
      }>
      const contested = options.filter(o => o.value.startsWith('label_a'))
      expect(contested.map(o => o.value).sort()).toEqual([NEWER_KEY, OLDER_KEY].sort())
      expect(
        new Set(contested.map(o => o.label)).size,
        'two options a human reads as one string are not a choice',
      ).toBe(2)
    })

    it('each key BINDS its own artifact — what the run mounts is what the builder showed', async () => {
      // The frame and the id map are two answers to one question, and a run resolves its
      // `column:<name>` slot through the SECOND. If they disagreed the user would build a
      // criterion against one column and the run would mount another.
      const rows = [anchor, older, newer]
      const sources = axisColumnSources(rows, 'm1', 'rows')
      expect(sources[OLDER_KEY]).toBe('older')
      expect(sources[NEWER_KEY]).toBe('newer')
      const frame = await readAxisColumnsFrame(rows, 'm1', 'rows', readColliding)
      for (const key of [OLDER_KEY, NEWER_KEY]) {
        expect(frame[key], `${key} must hold the values of the artifact it names`).toEqual(
          COLLIDING[sources[key]]!.label_a,
        )
      }
    })

    it('the bare name is still reported TAKEN, and resolves to NO artifact', async () => {
      // `require.not_in` reads this map's KEYS to answer "is this column name already on the
      // axis this run writes to". Two artifacts carrying the name is the case where it is MOST
      // taken, so dropping the bare key would turn the strongest collision into the one the
      // guard misses. It resolves to NOTHING, though: a name that names several columns names
      // no single artifact, and answering with one of them is the substitution being removed.
      const sources = axisColumnSources([anchor, older, newer], 'm1', 'rows')
      expect(Object.keys(sources)).toContain('label_a')
      expect(sources['label_a']).toBe('')
      expect(
        Object.keys(sources).sort(),
        'the bare name is an ANSWER ABOUT NAMES, never a third binding',
      ).toEqual([NEWER_KEY, OLDER_KEY, 'label_a', 'label_b'].sort())
    })

    it('collides PER COLUMN — an uncontested name keeps its bare key', async () => {
      const extra = table('extra', 'rows', [{ name: 'label_c', kind: 'categorical' }])
      const withExtra: Record<string, Record<string, unknown[]>> = {
        ...COLLIDING,
        extra: { label_c: ['e1', 'e1'] },
      }
      const frame = await readAxisColumnsFrame(
        [anchor, extra, older, newer],
        'm1',
        'rows',
        async r => withExtra[r.id] ?? {},
      )
      expect(Object.keys(frame).sort()).toEqual([NEWER_KEY, OLDER_KEY, 'label_b', 'label_c'].sort())
      expect(frame.label_c).toEqual(['e1', 'e1'])
    })

    it('an artifact declaring ONE name TWICE still yields two distinct keys', async () => {
      // The artifact id cannot separate these, so the last-resort ordinal does. Two columns
      // merged onto one key is the same loss whether the second came from another artifact or
      // from the same one.
      const twice = table('twice', 'rows', [
        { name: 'label_a', kind: 'categorical' },
        { name: 'label_a', kind: 'categorical' },
      ])
      const sources = axisColumnSources([anchor, twice], 'm1', 'rows')
      const qualified = Object.entries(sources).filter(([k]) => k !== 'label_a')
      expect(qualified.length, 'both declared columns must be addressable').toBe(2)
      expect(new Set(qualified.map(([k]) => k)).size).toBe(2)
      // ITEM-29d — REWRITTEN, not appended. This asserted `''`, i.e. "the bare name binds
      // nothing", on the strength of the conflated `ambiguous` flag. But `label_a` is carried
      // by exactly ONE artifact here: it is qualified (two members had to be told apart) and
      // it is not CONTESTED, so the bare name denotes `twice` and nothing else. Answering `''`
      // made a malformed-but-unambiguous artifact unbindable by name for no reason, and it is
      // the same conflation INV-10's refusal would have inherited.
      expect(sources['label_a']).toBe('twice')
    })

    it('SAYS the collision — once per contested name, not once per keystroke', () => {
      // A qualified key is visible but not self-explaining: the operator wants to know that a
      // re-run landed a second artifact under a name that already existed. The resolver
      // re-runs on every state change, so an undeduped log would drown the console it is
      // meant to inform.
      __resetColumnCollisionWarningsForTests()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      axisColumnSources([anchor, older, newer], 'm1', 'rows')
      axisColumnSources([anchor, older, newer], 'm1', 'rows')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.join(' '))).toContain('label_a')
      warn.mockRestore()
    })

    it('says NOTHING when no name is contested — the common case is silent', () => {
      __resetColumnCollisionWarningsForTests()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const only = table('only', 'rows', [{ name: 'label_a', kind: 'categorical' }])
      expect(axisColumnSources([anchor, only], 'm1', 'rows')).toEqual({ label_a: 'only' })
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('an UNDECLARED column a reader hands back can never replace another row’s', async () => {
      // Keys are minted from what the READ produced, not only from what was declared, so a
      // reader returning a column nobody declared is inside the rule rather than outside it.
      // Silent replacement is the defect wherever the second column came from.
      const p = table('p', 'rows', [
        { name: 'label_p1', kind: 'categorical' },
        { name: 'label_p2', kind: 'categorical' },
      ])
      const q = table('q', 'rows', [
        { name: 'label_q1', kind: 'categorical' },
        { name: 'label_q2', kind: 'categorical' },
      ])
      const frame = await readAxisColumnsFrame([anchor, p, q], 'm1', 'rows', async r =>
        r.id === 'p' ? { stray: ['p1', 'p1'] } : { stray: ['q1', 'q1'] },
      )
      expect(Object.keys(frame).length).toBe(2)
      expect(Object.values(frame)).toContainEqual(['p1', 'p1'])
      expect(Object.values(frame)).toContainEqual(['q1', 'q1'])
    })
  })
})

// `axisColumnSources` — the same axis relation, asked for the ARTIFACT ID behind each column.
//
// It exists because the frame ANSWERS ONE HALF of the question a run needs. A
// `demo/column` store keeps its values under the constant member `values` and cannot
// carry its own name, so a compute wanting a named row-metadata column must be handed it on
// a slot that carries the name — and the merged frame has already thrown the ids away. A view
// that can list a column but cannot name the artifact behind it can offer a criterion the
// launch is unable to mount, which is a filter that silently keeps everything.
describe('axisColumnSources — column NAME → the artifact it lives in', () => {
  const anchor = matrix('m1', ['rows', 'cols'])
  const imported = table('imported', 'rows', [
    { name: 'label_b', kind: 'categorical' },
    { name: 'label_a', kind: 'categorical' },
  ])
  const analysisOut = table('analysis', 'rows', [{ name: 'ns:metric_a', kind: 'numeric' }])
  const colsTable = table('colsTable', 'cols', [{ name: 'col_name', kind: 'string' }])
  const artifacts = [anchor, imported, analysisOut, colsTable]

  it('maps every column on the axis to the artifact that declares it', () => {
    expect(axisColumnSources(artifacts, 'm1', 'rows')).toEqual({
      label_b: 'imported',
      label_a: 'imported',
      'ns:metric_a': 'analysis',
    })
  })

  it('DESCRIBES EXACTLY THE FRAME — every offered column has a source, and no source is a phantom', async () => {
    const FRAMES: Record<string, Record<string, unknown[]>> = {
      imported: { label_b: ['a1', 'a2'], label_a: ['b1', 'b2'] },
      analysis: { 'ns:metric_a': [1, 2] },
    }
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', async r => FRAMES[r.id] ?? {})
    // The two answers share ONE row selection (`axisColumnRows`); this is the property that
    // buys — a column the criteria builder offers is always one the Run can mount.
    expect(Object.keys(axisColumnSources(artifacts, 'm1', 'rows')).sort()).toEqual(Object.keys(frame).sort())
  })

  it('is scoped to the named axis, and EMPTY until the anchor resolves', () => {
    expect(axisColumnSources(artifacts, 'm1', 'rows')).not.toHaveProperty('col_name')
    expect(axisColumnSources(artifacts, undefined, 'rows')).toEqual({})
    expect(axisColumnSources(artifacts, 'm1', undefined)).toEqual({})
  })

  it('never names the MATRIX as a column source', () => {
    expect(Object.values(axisColumnSources(artifacts, 'imported', 'rows'))).not.toContain('m1')
  })

  it('a contested name is ADDRESSED, not decided — and the answer does not move with the order', () => {
    const older = table('older', 'rows', [{ name: 'label_a', kind: 'categorical' }])
    const newer = table('newer', 'rows', [{ name: 'label_a', kind: 'categorical' }])
    const expected = {
      'label_a · older': 'older',
      'label_a · newer': 'newer',
      // present so `require.not_in` still sees the name as taken; bound to nothing, because
      // it names two columns.
      label_a: '',
    }
    expect(axisColumnSources([anchor, older, newer], 'm1', 'rows')).toEqual(expected)
    // Same two artifacts the other way round. Under the rule this replaces, the ONE binding
    // this map held flipped here — so the run mounted a different column than the builder
    // showed, decided by nothing the user could see.
    expect(axisColumnSources([anchor, newer, older], 'm1', 'rows')).toEqual(expected)
  })

  it('honours the datatype filter, and FAILS CLOSED on an unevaluable exclusion', () => {
    expect(axisColumnSources(artifacts, 'm1', 'rows', { filter: { datatype: 'nope' } })).toEqual({})
    // no lattice ⇒ `excludes` cannot be evaluated ⇒ the candidate is dropped, matching
    // `matchesTypeFilter`'s asymmetric degradation.
    expect(axisColumnSources(artifacts, 'm1', 'rows', { filter: { excludes: ['whatever'] } })).toEqual({})
  })
})

// ── `excludeGenerators` — narrowing the selection by WHO PRODUCED each column ──────────
//
// The selection is the only place a producer can be excluded, and that is a property rather
// than a preference: the collision rule is computed OVER the selection, so removing keys
// AFTERWARDS would leave a name carried by two excluded columns behind as a contested bare
// key — the excluded producer still blocking, under a key that denotes nothing.
describe('axisColumnRows / axisColumnSources — narrowing by PRODUCER', () => {
  const anchor = matrix('m1', ['rows', 'cols'])
  const producedBy = (id: string, name: string, generator: string | null) =>
    table('x', 'rows', [{ name, kind: 'numeric' }], { id, generator_id: generator })

  const mine = producedBy('mine', 'metric_a', 'pkg.thing')
  const theirs = producedBy('theirs', 'metric_b', 'other.thing')
  const unattributed = producedBy('imported', 'metric_c', null)
  const all = [anchor, mine, theirs, unattributed]

  it('drops only the named producers’ columns', () => {
    expect(Object.keys(axisColumnSources(all, 'm1', 'rows')).sort()).toEqual([
      'metric_a',
      'metric_b',
      'metric_c',
    ])
    expect(
      Object.keys(axisColumnSources(all, 'm1', 'rows', { excludeGenerators: ['pkg.thing'] })).sort(),
    ).toEqual(['metric_b', 'metric_c'])
  })

  it('an UNATTRIBUTED column is never excluded — absence is not membership', () => {
    // A row with no producer is an import, or a run whose provenance was never recorded.
    // Reading "unknown" as "mine" would hand the exclusion to every column on the axis.
    expect(
      axisColumnSources(all, 'm1', 'rows', { excludeGenerators: ['pkg.thing', 'other.thing'] }),
    ).toEqual({ metric_c: 'imported' })
  })

  it('an empty / absent exclusion narrows NOTHING', () => {
    const every = axisColumnSources(all, 'm1', 'rows')
    expect(axisColumnSources(all, 'm1', 'rows', { excludeGenerators: [] })).toEqual(every)
    expect(axisColumnSources(all, 'm1', 'rows', { excludeGenerators: undefined })).toEqual(every)
  })

  it('an excluded producer leaves NO contested bare key behind — the reason it filters the SELECTION', () => {
    // TWO columns of one name, both this producer's — the shape a THIRD run of the same
    // analysis makes. Unexcluded they are contested, so the bare name survives as a key
    // bound to nothing (which `require.not_in` reads as taken). Excluding them must remove
    // the name entirely, and only filtering BEFORE the keys are minted does that.
    const first = producedBy('first', 'metric_a', 'pkg.thing')
    const second = producedBy('second', 'metric_a', 'pkg.thing')
    const contested = [anchor, first, second]
    expect(Object.keys(axisColumnSources(contested, 'm1', 'rows')).sort()).toEqual([
      'metric_a',
      'metric_a · first',
      'metric_a · second',
    ])
    expect(axisColumnSources(contested, 'm1', 'rows', { excludeGenerators: ['pkg.thing'] })).toEqual({})
  })

  it('a name carried by BOTH an excluded and a kept producer stays taken, unqualified', () => {
    // The other half: excluding one carrier de-contests the name for the survivor, so the
    // kept column answers to the bare spelling — and a form asking "is this taken by someone
    // else?" gets yes, under the name it would have written.
    const ours = producedBy('ours', 'metric_a', 'pkg.thing')
    const foreign = producedBy('foreign', 'metric_a', 'other.thing')
    expect(
      axisColumnSources([anchor, ours, foreign], 'm1', 'rows', { excludeGenerators: ['pkg.thing'] }),
    ).toEqual({ metric_a: 'foreign' })
  })

  it('the VALUES answer narrows identically — one selection, two answers', async () => {
    const FRAMES: Record<string, Record<string, unknown[]>> = {
      mine: { metric_a: [1] },
      theirs: { metric_b: [2] },
      imported: { metric_c: [3] },
    }
    const frame = await readAxisColumnsFrame(all, 'm1', 'rows', async r => FRAMES[r.id] ?? {}, {
      excludeGenerators: ['pkg.thing'],
    })
    expect(Object.keys(frame).sort()).toEqual(
      Object.keys(axisColumnSources(all, 'm1', 'rows', { excludeGenerators: ['pkg.thing'] })).sort(),
    )
  })
})

// ── `viewOwnAnalysisIds` — WHICH analyses a view launches ──────────────────────────────
//
// The exclusion set for `produced_by: others`. Read off the view's own `run_processor` ops
// so no slice has to restate an analysis id — a restated one would still parse and still
// resolve after a rename, and would simply stop excluding anything.
describe('viewOwnAnalysisIds', () => {
  const withActions = (actions: unknown): ViewSpec => ({ actions } as unknown as ViewSpec)

  it('collects every run_processor id, de-duplicated', () => {
    const spec = withActions([
      { id: 'a', body: [{ set: {} }, { run_processor: { id: 'pkg.one' } }, { wait_for: {} }] },
      { id: 'b', body: [{ run_processor: { id: 'pkg.two' } }] },
      { id: 'c', body: [{ run_processor: { id: 'pkg.one' } }] },
    ])
    expect(viewOwnAnalysisIds(spec).sort()).toEqual(['pkg.one', 'pkg.two'])
  })

  it('a view that launches nothing yields nothing — so the exclusion narrows nothing', () => {
    // The conservative direction, stated as a property: a `produced_by: others` slice on a
    // view with no run keeps EVERY column, so whatever reads it goes on refusing rather than
    // quietly permitting.
    expect(viewOwnAnalysisIds(withActions([{ id: 'a', body: [{ set: {} }] }]))).toEqual([])
    expect(viewOwnAnalysisIds(withActions([]))).toEqual([])
    expect(viewOwnAnalysisIds(undefined)).toEqual([])
    // A malformed op contributes nothing rather than an empty id, which would match a
    // producer that names itself with the empty string.
    expect(viewOwnAnalysisIds(withActions([{ id: 'a', body: [{ run_processor: { id: '' } }] }]))).toEqual([])
    expect(viewOwnAnalysisIds(withActions([{ id: 'a', body: [{ run_processor: {} }] }]))).toEqual([])
  })
})

// ── TEST-40 (ITEM-29d) — the two propositions `ambiguous` used to conflate ────────────
//
// `mintColumnKeys` measures a collision (how many artifacts carry one name) and then, once,
// returned a DIFFERENT fact under that name: `key !== name`, recomputed from the key it had
// just minted. The residual-ordinal path — two members of ONE artifact declaring one name —
// changes the key without the name being contested at all, so it reported `ambiguous: true`
// for a name that denotes exactly one artifact.
//
// It matters because INV-10 keys `auto_bind_sole_candidate`'s refusal on `ambiguous`: under
// the old spelling that refusal fired on a malformed-but-unambiguous artifact, and did not
// fire for the reason it was written. The two facts are now separate fields, and this asserts
// BOTH directions — that is what makes the separation real rather than a rename.
describe('mintColumnKeys — `ambiguous` (contested) vs `qualified` (key had to change)', () => {
  it('a name carried by TWO artifacts is ambiguous AND qualified', () => {
    __resetColumnCollisionWarningsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const minted = mintColumnKeys([
      { artifactId: 'art-one', name: 'shared' },
      { artifactId: 'art-two', name: 'shared' },
    ])
    expect(minted.map(m => m.ambiguous)).toEqual([true, true])
    expect(minted.map(m => m.qualified)).toEqual([true, true])
    // and the keys really are distinct, which is the uniqueness invariant the flag rides on
    expect(new Set(minted.map(m => m.key)).size).toBe(2)
    warn.mockRestore()
  })

  it('a name carried by ONE artifact TWICE is qualified but NOT ambiguous — the fixed case', () => {
    // Two members of one artifact under one name. Their keys still have to differ, so
    // `qualified` is true for both — but the NAME denotes exactly one artifact, so nothing is
    // contested and `ambiguous` must be false. This is the case the old spelling reported as
    // ambiguous, and the one INV-10's refusal would have fired on for no reason.
    __resetColumnCollisionWarningsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const minted = mintColumnKeys([
      { artifactId: 'art-one', name: 'twice' },
      { artifactId: 'art-one', name: 'twice' },
    ])
    expect(minted.map(m => m.ambiguous)).toEqual([false, false])
    expect(minted.map(m => m.qualified)).toEqual([true, true])
    expect(new Set(minted.map(m => m.key)).size).toBe(2)
    // The collision WARNING is scoped to the same proposition: its sentence is "declared by N
    // artifacts", so firing it here would have printed "1 artifacts" about a name nobody is
    // fighting over.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('an uncontested name is neither', () => {
    __resetColumnCollisionWarningsForTests()
    const minted = mintColumnKeys([
      { artifactId: 'art-one', name: 'alpha' },
      { artifactId: 'art-two', name: 'beta' },
    ])
    expect(minted.map(m => m.ambiguous)).toEqual([false, false])
    expect(minted.map(m => m.qualified)).toEqual([false, false])
    expect(minted.map(m => m.key)).toEqual(['alpha', 'beta'])
  })

  it('the id map is UNCHANGED by the separation — a contested bare name still binds nothing', () => {
    // The one existing consumer reads `ambiguous`, so the separation has to be proven
    // behaviour-preserving there rather than assumed: a contested name maps to the empty
    // string (it names no single artifact) and a one-artifact-twice name still maps to that
    // artifact, exactly as before.
    __resetColumnCollisionWarningsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const contested = mintColumnKeys([
      { artifactId: 'art-one', name: 'shared' },
      { artifactId: 'art-two', name: 'shared' },
    ])
    const out: Record<string, string> = {}
    for (const c of contested) out[c.key] = c.artifactId
    for (const c of contested) if (c.ambiguous && !(c.name in out)) out[c.name] = ''
    expect(out['shared']).toBe('')
    warn.mockRestore()
  })
})

// ── TEST-25 / TEST-26 (ITEM-17 / ITEM-18) — the OFFERING predicate ──────────────────
//
// The second axis of narrowing, and the one no amount of kind-matching answers: are these
// values paintable on THESE points? A candidate of exactly the right kind that belongs to
// another row space is the failure this predicate exists to prevent — one dataset's values
// painted on another's coordinates, with nothing on screen to say so.
//
// The fixtures keep the vocabulary-free rule the rest of this file follows, and they name
// the two identifiers apart on purpose: an axis is identified on the wire by its key
// artifact's `content_hash`, while an ALIGNED artifact declares that axis's
// `key_sequence_digest`. A test that spelled them the same would pass with an
// implementation that compared the wrong two fields.

const KEYS_ONE = 'a'.repeat(64)
const KEYS_TWO = 'b'.repeat(64)

/** The key artifact that IS a row space: its `content_hash` is the axis's identity, its
 *  `structure.key_sequence_digest` is what an aligned artifact declares. */
function rowSpace(id: string, contentHash: string, keySequenceDigest: string): ArtifactRow {
  return row({
    id,
    content_hash: contentHash,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      key: 'values',
      key_sequence_digest: keySequenceDigest,
    },
  })
}

/** An ordinary candidate: right kind, declaring (or not) which row space it belongs to. */
function candidate(id: string, alignedTo?: string, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return row({
    id,
    datatype: 'demo/plottable',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      ...(alignedTo ? { aligned_to: alignedTo } : {}),
    },
    ...over,
  })
}

const ROW_SPACE_SOURCE = { aligned_to: '$scope.axis', datatype: 'demo/plottable' } as const

describe('the offering predicate (ITEM-17)', () => {
  const catalog = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    candidate('mine', KEYS_ONE),
    candidate('theirs', KEYS_TWO),
    candidate('undeclared'),
  ]

  it('offers only what is aligned to the anchored row space — a column of another row space is not offered', () => {
    const got = resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis: 'hash-one' } })
    expect(got.map(c => c.id).sort()).toEqual(['mine', 'undeclared'])
    // …and the SAME catalog against the OTHER anchor offers the other one, so the filter is
    // the anchor's doing and not a property of the fixture.
    const other = resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis: 'hash-two' } })
    expect(other.map(c => c.id).sort()).toEqual(['theirs', 'undeclared'])
  })

  it('is INDEPENDENT of the kind filter — neither substitutes for the other', () => {
    const wrongKind = candidate('wrong-kind', KEYS_ONE, { datatype: 'demo/other' })
    const got = resolveArtifactRefSource(
      [...catalog, wrongKind],
      ROW_SPACE_SOURCE,
      { scope: { axis: 'hash-one' } },
    )
    // Right ROW SPACE, wrong KIND — excluded by `datatype`.
    expect(got.map(c => c.id)).not.toContain('wrong-kind')
    // Right KIND, wrong ROW SPACE — excluded by alignment. Asserted against a source that
    // asks NO alignment question, which offers it, so the exclusion is attributable.
    const kindOnly = resolveArtifactRefSource(catalog, { datatype: 'demo/plottable' }, {})
    expect(kindOnly.map(c => c.id).sort()).toEqual(['mine', 'theirs', 'undeclared'])
  })

  it('resolves the anchor by content_hash and NEVER by the axis label (INV-1)', () => {
    // Two row spaces whose artifacts declare the identical axis LABEL — the shape the label
    // cannot tell apart. Their key sequences differ, and so must the offers.
    const one = resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis: 'hash-one' } })
    const two = resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis: 'hash-two' } })
    expect(one.map(c => c.id)).not.toEqual(two.map(c => c.id))
    // An anchor nobody can find is not an anchor: it offers NOTHING rather than everything.
    expect(resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis: 'hash-gone' } })).toEqual([])
  })

  it('leaves every OTHER source form byte-identical, alignment unasked', () => {
    // The regression this pairs with DEC-16: the shipped sources are dataset-scoped
    // siblings with no anchor, so their candidates must keep `alignmentUnknown: undefined`
    // — which is NOT A3, and is what stops INV-10's refusal firing on every candidate in
    // the app.
    const plain = resolveArtifactRefSource(catalog, { datatype: 'demo/plottable' }, {})
    expect(plain.map(c => c.alignmentUnknown)).toEqual([undefined, undefined, undefined])
    const scoped = resolveArtifactRefSource(
      [table('anchor', 'entities', [{ name: 'values', kind: 'string' }]), candidate('sib')],
      { axis: 'entities', of: '$state.pick' },
      { state: { pick: 'anchor' } },
    )
    expect(scoped.every(c => c.alignmentUnknown === undefined)).toBe(true)
  })
})

describe('the four row-space states (ITEM-18)', () => {
  const catalog = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    candidate('aligned', KEYS_ONE),
    candidate('elsewhere', KEYS_TWO),
    candidate('unknown'),
  ]
  const offer = (axis: unknown) =>
    resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, { scope: { axis } })

  it('A0 — with no anchor NOTHING is offered, and that is not the same as everything', () => {
    for (const nothing of [null, undefined, '']) {
      expect(offer(nothing)).toEqual([])
    }
  })

  it('A1 — an artifact aligned to the anchored row space is offered, unmarked', () => {
    const a1 = offer('hash-one').find(c => c.id === 'aligned')
    expect(a1).toBeDefined()
    expect(a1?.alignmentUnknown).toBe(false)
  })

  it('A2 — aligned ELSEWHERE is ABSENT, not offered-and-disabled', () => {
    const got = offer('hash-one')
    expect(got.find(c => c.id === 'elsewhere')).toBeUndefined()
    // The distinction is the whole point: a disabled row would still be rendered, inviting
    // the reader to work out why another dataset's column is listed under these points.
    expect(got.map(c => c.id)).not.toContain('elsewhere')
  })

  it('A3 — undeclared alignment is OFFERED and MARKED, so INV-10 can refuse to bind it', () => {
    const a3 = offer('hash-one').find(c => c.id === 'unknown')
    expect(a3).toBeDefined()
    expect(a3?.alignmentUnknown).toBe(true)
  })

  it('an anchor that declares no key sequence makes every candidate A3, never A2', () => {
    // The question cannot be answered from either side. Reporting "aligned elsewhere" would
    // be a confident wrong answer about candidates that may well be aligned — and it would
    // empty the pane on exactly the projects that have not migrated yet.
    const unkeyed = [
      row({ id: 'axis-bare', content_hash: 'hash-bare', structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities' } }),
      candidate('aligned', KEYS_ONE),
      candidate('unknown'),
    ]
    const got = resolveArtifactRefSource(unkeyed, ROW_SPACE_SOURCE, { scope: { axis: 'hash-bare' } })
    expect(got.map(c => c.id).sort()).toEqual(['aligned', 'unknown'])
    expect(got.every(c => c.alignmentUnknown === true)).toBe(true)
  })
})

// ── THE MEMBERSHIP RULE AND THE FIFTH STATE (ITEM-7) ──────────────────────────────────────
//
// A1 stopped being "same axis identity" and became *same axis identity AND a non-empty member
// intersection*. What that buys is A4: a column that IS on this dataset's axis, whose members
// nobody is in any doubt about, and NONE of which are the rows the user is looking at — a
// column about a DIFFERENT population of the same dataset. It is dropped from the offer for
// the same reason A2 is, and it is a different fact from A2, which is why it is not spelled as
// one.
//
// The member sets below are GOLDEN BLOBS produced by `txr_zarr.encode_member_set` itself
// (`python3 -c "from txr_zarr import encode_member_set; ..."`), not by a second encoder
// written here. The format has to be understood in TWO languages and the whole hazard is the
// two drifting apart; a test that encoded with its own helper and decoded with the shipped one
// would agree with itself while disagreeing with every artifact a producer writes.

/** members 0…9 — the coordinate's rows in every fixture below. */
const MEMBERS_0_TO_9 = 'AQEBAQEBAQEBAQ=='
/** members 4…23 — 20 of them, SIX of which are the coordinate's (TEST-48's 60% vs 30%). */
const MEMBERS_4_TO_23 = 'BQEBAQEBAQEBAQEBAQEBAQEBAQE='
/** members 100…109 — same axis, provably NONE of the coordinate's rows. */
const MEMBERS_100_TO_109 = 'ZQEBAQEBAQEBAQ=='

type MemberDecl = { kind: 'full' | 'subset'; nMembers?: number; bitmap?: string }

/** A candidate (or a coordinate) declaring `structure.memberships` — the plural spelling. */
function membered(id: string, entries: Array<{ alignedTo: string } & MemberDecl>, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return row({
    id,
    datatype: 'demo/plottable',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      memberships: entries.map(e => ({
        axis: 'entities',
        aligned_to: e.alignedTo,
        kind: e.kind,
        ...(e.nMembers === undefined ? {} : { n_members: e.nMembers }),
        ...(e.bitmap === undefined ? {} : { bitmap: e.bitmap }),
      })),
    },
    ...over,
  })
}

describe('TEST-8 — the state table gains A4: same axis, DISJOINT members', () => {
  const coordinate = membered('coord', [{ alignedTo: KEYS_ONE, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 }])
  const catalog = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    coordinate,
    membered('intersecting', [{ alignedTo: KEYS_ONE, kind: 'subset', nMembers: 20, bitmap: MEMBERS_4_TO_23 }]),
    membered('disjoint', [{ alignedTo: KEYS_ONE, kind: 'subset', nMembers: 10, bitmap: MEMBERS_100_TO_109 }]),
    membered('whole-axis', [{ alignedTo: KEYS_ONE, kind: 'full', nMembers: 500 }]),
    membered('elsewhere', [{ alignedTo: KEYS_TWO, kind: 'full', nMembers: 500 }]),
    candidate('unknown'),
  ]
  const anchor = resolveRowSpaceAnchor(catalog, ['hash-one'], 'coord')

  it('names each of the five states, and A4 is neither A1 nor A2', () => {
    expect(alignmentState(undefined, undefined)).toBe('A0')
    const stateOf = (id: string) => alignmentState(catalog.find(a => a.id === id)?.structure, anchor)
    expect(stateOf('intersecting')).toBe('A1')
    expect(stateOf('whole-axis')).toBe('A1')
    expect(stateOf('elsewhere')).toBe('A2')
    expect(stateOf('unknown')).toBe('A3')
    // The assertion the control is written against. Mapping A4 onto A2 keeps the offered SET
    // identical and loses the fact; mapping it onto A1 offers a column describing NONE of
    // these rows.
    expect(stateOf('disjoint')).toBe('A4')
  })

  it('offeredOnRowSpace drops A2 and A4, and keeps A1 and A3', () => {
    const offered = offeredOnRowSpace(catalog, anchor).map(r => r.id).sort()
    // `coord` itself is membered and intersects itself, and the two KEY artifacts declare
    // nothing (A3) — this predicate knows about neither coordinates nor axes, and the sections
    // that do skip them themselves (`isAxisArtifact`).
    expect(offered).toEqual(['axis-one', 'axis-two', 'coord', 'intersecting', 'unknown', 'whole-axis'])
    expect(offered).not.toContain('disjoint')
    expect(offered).not.toContain('elsewhere')
  })

  it('A4 is reached only on PROOF — every undecidable intersection stays A1 and stays offered', () => {
    // The same disjoint member positions, declared with the inline set ABSENT (ITEM-5's
    // over-budget state). Nothing can be proven, so it is offered exactly as it was before
    // this rule was written.
    const overBudget = membered('over-budget', [{ alignedTo: KEYS_ONE, kind: 'subset', nMembers: 10 }])
    const withIt = [...catalog, overBudget]
    const anchorHere = resolveRowSpaceAnchor(withIt, ['hash-one'], 'coord')
    expect(alignmentState(overBudget.structure, anchorHere)).toBe('A1')
    // …and the anchor declaring nothing itself is the other half of the same rule.
    const noCoordinate = resolveRowSpaceAnchor(withIt, ['hash-one'], undefined)
    expect(alignmentState(withIt.find(a => a.id === 'disjoint')?.structure, noCoordinate)).toBe('A1')
  })

  it('the anchor carries the COORDINATE\'s membership, joined on the axis identity', () => {
    expect(anchor?.axes.map(a => a.membership?.nMembers)).toEqual([10])
    // Joined on the digest, never on the label: an anchor on the OTHER axis finds no entry.
    expect(resolveRowSpaceAnchor(catalog, ['hash-two'], 'coord')?.axes.map(a => a.membership)).toEqual([
      undefined,
    ])
  })
})

describe('TEST-9 — TODAY\'s shapes offer exactly what they offer now (INV-9)', () => {
  // The corpus is every shape a project holds before this round: the scalar `aligned_to`,
  // and nothing declared at all. No artifact here carries a `memberships` array, and no
  // coordinate declares members — which is the whole point: the membership rule must be
  // invisible to them.
  const legacy = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    candidate('scalar-mine', KEYS_ONE),
    candidate('scalar-theirs', KEYS_TWO),
    candidate('nothing-declared'),
    candidate('coord-legacy', KEYS_ONE),
  ]

  it('offers the same SET, in the same order, with and without a coordinate in scope', () => {
    const withoutCoordinate = resolveArtifactRefSource(legacy, ROW_SPACE_SOURCE, {
      scope: { axis: 'hash-one' },
    })
    const withCoordinate = resolveArtifactRefSource(legacy, ROW_SPACE_SOURCE, {
      scope: { axis: 'hash-one', coordinate: 'coord-legacy' },
    })
    // Ordered comparison, not a set comparison and not a count: a rule that narrowed a legacy
    // project\'s offers, or reordered them, turns this red.
    expect(withCoordinate.map(c => c.id)).toEqual(withoutCoordinate.map(c => c.id))
    expect(withCoordinate.map(c => c.id)).toEqual(['scalar-mine', 'nothing-declared', 'coord-legacy'])
    expect(withCoordinate.map(c => c.alignmentUnknown)).toEqual(withoutCoordinate.map(c => c.alignmentUnknown))
  })

  it('a legacy coordinate reads as ONE `full` membership and therefore proves nothing disjoint', () => {
    const anchor = resolveRowSpaceAnchor(legacy, ['hash-one'], 'coord-legacy')
    expect(anchor?.axes.map(a => a.membership)).toEqual([
      { alignedTo: KEYS_ONE, axis: 'entities', kind: 'full', declaredOrder: 0 },
    ])
    // `full` with no declared count: the intersection is known to be everything the candidate
    // has, but the DENOMINATOR is not declared — so the state is A1 and nothing is refused.
    expect(alignmentState(candidate('x', KEYS_ONE).structure, anchor)).toBe('A1')
  })
})

// ── `dims` — the one source term that narrows by SHAPE (owner, 2026-08-13) ─────────────
//
// § Coordinates draws a picture in TWO axes, and `plottable-xy` is a capability, not a shape:
// a decomposition declaring fifty components advertises it just as truthfully as a two-column
// layout does. Offering the fifty-component one means either a component picker (a question
// about which of fifty projections was meant) or a silent "first two" — `layouts[0]` wearing a
// default. So the source declares `dims: 2` and the wide one is not offered AT ALL.
//
// The fixtures below differ ONLY in the declared width, which is what makes them a controlled
// pair: anything that excluded the wide one for some other reason would pass a sloppier test.

describe('a source may narrow by DECLARED COMPONENT COUNT', () => {
  const positions = (id: string, width: number) =>
    row({
      id,
      datatype: 'demo/positions',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: 'rows',
        arrays: [{ path: 'p', kind: 'numeric', shape: [10, width] }],
      },
    })

  it('offers the declared width and NOT the other one', () => {
    const rows = [positions('flat', 2), positions('wide', 50)]
    const got = resolveArtifactRefSource(rows, { datatype: 'demo/positions', dims: 2 }, {})
    expect(got.map(c => c.id)).toEqual(['flat'])
  })

  it('is a NARROWING, not the whole selector — without it both are offered', () => {
    // The negative control. Without this the test above would pass against a resolver that
    // dropped the wide artifact for any reason at all.
    const rows = [positions('flat', 2), positions('wide', 50)]
    const got = resolveArtifactRefSource(rows, { datatype: 'demo/positions' }, {})
    expect(got.map(c => c.id).sort()).toEqual(['flat', 'wide'])
  })

  it('FAILS CLOSED — an artifact declaring no shape is not offered', () => {
    // The same direction `excludes` and `capabilities` take, and for the same reason: a
    // narrowing that cannot be evaluated must not offer the thing it exists to exclude. It is
    // also INV-11 — the count is DECLARED, never measured by reading bytes.
    const shapeless = row({ id: 'shapeless', datatype: 'demo/positions', structure: { encoding: 'zarr_v3' } })
    const got = resolveArtifactRefSource([shapeless, positions('flat', 2)], { datatype: 'demo/positions', dims: 2 }, {})
    expect(got.map(c => c.id)).toEqual(['flat'])
  })

  // ── TEST-13 (ITEM-12) — the width a NARROWED row set no longer declares ────────────────
  //
  // Materialising a narrowed row set gathers each source artifact and mints the result a
  // FRESH declaration (`server/src/modules/workstore/virtual_dataset.rs:1688-1705` →
  // `gathered_structure`, `:574-641`): ONE `values` column of `shape: [n_kept]`,
  // `arrays: []`, for every non-sparse source. It copies the source's `meta` VERBATIM
  // (`:1714`) and its `datatype` (`:1729`). So a 2-D artifact comes back through a narrowing
  // still advertising `plottable-xy` and declaring ONE dimension, the `dims: 2` narrowing
  // above drops it, and the pane renders `empty_text` with nothing said anywhere. Nothing had
  // ever put a 2-D artifact through a narrowing, which is why this went unnoticed.
  //
  // `meta` is the only channel that crosses that boundary, so it is where the producer's
  // component-column declaration lives (DEC-9) and the only place this can read it from.
  //
  // The fixtures differ ONLY in that declaration, which is what makes them a controlled pair:
  // a resolver that offered the gathered row for some other reason would pass a sloppier test.
  describe('a producer’s declared component columns answer where the gathered structure cannot', () => {
    const N_KEPT = 120
    /** The capability the § Coordinates source requires; the gathered row still carries it. */
    const XY = lattice({ 'demo/positions': null }, { 'demo/positions': ['plottable-xy'] })
    const XY_2D = { capabilities: ['plottable-xy'], dims: 2 }

    /**
     * A row shaped EXACTLY as the gather mints one: the single `values` column, the empty
     * `arrays`, the copied element type and the gather's own provenance stamp.
     *
     * The axis is named neutrally, like every other fixture in this file: the resolver reads
     * an axis NAME for meaning nowhere, so spelling a real one here would assert a behaviour
     * the core does not have.
     */
    const gathered = (id: string, meta?: Record<string, unknown>) =>
      row({
        id,
        datatype: 'demo/positions',
        structure: {
          encoding: 'zarr_v3',
          kind: 'table',
          axis: 'rows',
          n: N_KEPT,
          columns: [
            {
              path: 'values',
              name: 'values',
              kind: 'numeric',
              dtype: 'float32',
              shape: [N_KEPT],
              axis: 'rows',
              n: N_KEPT,
            },
          ],
          arrays: [],
          data_type: 'float32',
          gathered_from: { artifact_id: 'source-1', mask_len: 400 },
        },
        ...(meta ? { meta } : {}),
      })

    it('offers a gathered row that DECLARES its two component columns', () => {
      const declared = gathered('kept', { component_columns: ['c_one', 'c_two'] })
      expect(matchesTypeFilter(declared, XY_2D, { lattice: XY })).toBe(true)
      // Through the real resolver too, not only the predicate: this is what § Coordinates
      // actually calls, and it is the difference between an offer and an `empty_text`.
      expect(resolveArtifactRefSource([declared], XY_2D, {}, { lattice: XY }).map(c => c.id)).toEqual(['kept'])
    })

    it('the IDENTICAL row without that declaration is still dropped (the negative control)', () => {
      // Same datatype, same capability, same gathered structure — only the declaration is
      // absent. Without this the case above would pass against a build that simply stopped
      // narrowing by width.
      const undeclared = gathered('kept')
      expect(matchesTypeFilter(undeclared, XY_2D, { lattice: XY })).toBe(false)
      expect(resolveArtifactRefSource([undeclared], XY_2D, {}, { lattice: XY })).toEqual([])
    })

    it('a FIFTY-component artifact declaring no component columns is STILL not offered', () => {
      // `coordinates.yaml:18-26`'s argued divergence from the mockup, preserved verbatim: a
      // 50-wide decomposition advertises `plottable-xy` just as truthfully as a 2-wide layout,
      // and offering it means either asking which projection was meant or silently taking the
      // first two. The fallback is reached only through a declaration, so it cannot widen this.
      const wide = positions('wide', 50)
      expect(matchesTypeFilter(wide, XY_2D, { lattice: XY })).toBe(false)
      expect(declaredComponentCount(wide)).toBe(50)
    })

    it('STRUCTURE still wins wherever it speaks — a declared width is never overruled', () => {
      // The widening is in ONE direction only (`undefined` → a number) and only where the
      // structure said nothing. An artifact that declares its own width answers from it, even
      // when its `meta` disagrees — so every artifact shipped today answers byte-identically.
      const twoWide = row({ ...positions('flat', 2), meta: { component_columns: ['a', 'b', 'c'] } })
      expect(declaredComponentCount(twoWide)).toBe(2)
      expect(matchesTypeFilter(twoWide, XY_2D, { lattice: XY })).toBe(true)
      const fiftyWide = row({ ...positions('wide', 50), meta: { component_columns: ['a', 'b'] } })
      expect(declaredComponentCount(fiftyWide)).toBe(50)
      expect(matchesTypeFilter(fiftyWide, XY_2D, { lattice: XY })).toBe(false)
    })

    // A malformed declaration is REFUSED, exactly as an absent one is. `meta` is
    // producer-written and the server never interprets it, so anything at all can be in this
    // key; accepting a sloppy spelling here would offer a row the render half then cannot
    // resolve, which is the offered-but-blank state the whole mechanism exists to prevent. A
    // REPEATED name is the dangerous member of this set: it resolves both components to ONE
    // column and draws a perfect diagonal, which is wrong and looks like data.
    it.each([
      ['only ONE name — there is no pair to read', ['c_one']],
      ['a REPEATED name — two components, one column, a diagonal', ['c_one', 'c_one']],
      ['a non-string entry', ['c_one', 7]],
      ['an empty / whitespace name, which addresses nothing', ['c_one', '   ']],
      ['not a list at all', 'c_one,c_two'],
      ['an empty list', []],
    ])('REFUSES a malformed declaration: %s', (_label, component_columns) => {
      const bad = gathered('kept', { component_columns })
      expect(declaredComponentColumns(bad)).toBeUndefined()
      expect(declaredComponentCount(bad)).toBeUndefined()
      expect(matchesTypeFilter(bad, XY_2D, { lattice: XY })).toBe(false)
    })

    it('accepts EXACTLY the well-formed shape, and hands the names back VERBATIM', () => {
      // The names are joined against another producer declaration (`meta.name`) on the render
      // half, so normalising one side here is how the two sides would stop matching.
      expect(declaredComponentColumns(gathered('kept', { component_columns: ['c one', 'c_two'] }))).toEqual([
        'c one',
        'c_two',
      ])
      // More than two is a legitimate declaration of a wider artifact — the COUNT is what the
      // narrowing reads, so a 3-name declaration answers 3 and a `dims: 2` source drops it.
      const three = gathered('kept', { component_columns: ['a', 'b', 'c'] })
      expect(declaredComponentCount(three)).toBe(3)
      expect(matchesTypeFilter(three, XY_2D, { lattice: XY })).toBe(false)
      // A row with no `meta` at all, and one whose `meta` is not an object, both answer
      // nothing rather than throwing — this reads a LISTING over a whole project.
      expect(declaredComponentColumns(gathered('kept'))).toBeUndefined()
      expect(declaredComponentColumns(row({ id: 'x', meta: 'component_columns' }))).toBeUndefined()
    })
  })
})

// ── candidateLabel: THE DATATYPE WORD IS NOT A NAME (ledger #11 / #17) ────────────────────
//
// The owner, twice: the rows *"should be the name"* of the thing — not *"10 items with the same
// name"* — and *"what if we have 100 … are they gonna be all"* that one word. (Their sentences
// name the domain object; the words themselves stay in the ledger, since app-core carries none
// of that vocabulary and the rule under test is not about any of it.)
//
// The rule the owner stated, and the one narrower rule that was built instead, differ on ONE
// input — a project holding a SINGLE such artifact. The declared key was wired as a tie-break
// inside `disambiguate`, so it fired only where two labels collided; the owner's sentence is
// about what a row is CALLED, collision or not. Every case below states which of the two it
// separates, because a suite that only tested the contested case would pass on both.
describe('candidateLabel — a name that is the datatype word yields to the declared key', () => {
  const artifact = (over: Partial<ArtifactRow>): ArtifactRow =>
    ({
      id: 'a1',
      project_id: 'p',
      datatype: 'demo/positions',
      created_at: '2026-01-01T00:00:00Z',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', arrays: [{ path: 'v', kind: 'numeric', shape: [10, 2] }] },
      ...over,
    }) as ArtifactRow

  /** The label the picker would show, through the real resolver rather than a stand-in. */
  const labelsFor = (rows: readonly ArtifactRow[], datatype = 'demo/positions'): string[] =>
    resolveArtifactRefSource(rows, { datatype }, {}).map(c => c.label)

  it('ONE artifact, uncontested: the source key IS the name — this is the narrowing', () => {
    // The single input that separates the owner's rule from the tie-break that shipped. Under
    // the tie-break this read "positions"; nothing collided, so nothing fired.
    expect(labelsFor([artifact({ meta: { name: 'positions', source_key: 'K_alpha' } })])).toEqual(['K_alpha'])
  })

  it('a hundred of them read their own keys, with no hash anywhere', () => {
    const rows = ['K_alpha', 'K_beta', 'K_gamma'].map((k, i) =>
      artifact({ id: `a${i}`, meta: { name: 'positions', source_key: k } }),
    )
    expect(labelsFor(rows)).toEqual(['K_alpha', 'K_beta', 'K_gamma'])
  })

  it('falls to `meta.method` when there is no source key', () => {
    expect(labelsFor([artifact({ meta: { name: 'positions', method: 'M_one' } })])).toEqual(['M_one'])
  })

  it('the datatype word is matched on the ID and on its last segment, punctuation-insensitively', () => {
    expect(labelsFor([artifact({ meta: { name: 'demo/positions', source_key: 'K_alpha' } })])).toEqual(['K_alpha'])
    expect(
      labelsFor(
        [artifact({ datatype: 'demo/row-positions', meta: { name: 'Row Positions', source_key: 'K_alpha' } })],
        'demo/row-positions',
      ),
    ).toEqual(['K_alpha'])
  })

  it('a REAL name is untouched — the rule fires only on the word that says nothing', () => {
    expect(labelsFor([artifact({ meta: { name: 'anchored projection', source_key: 'K_alpha' } })])).toEqual([
      'anchored projection',
    ])
  })

  it('declaring NEITHER key falls back to the OPAQUE IDENTITY, never to an invented name', () => {
    // The owner's own project: imported before the producer stamped either key. The honest
    // answer is the artifact's own short identity — ugly, true, and selectable. Anything
    // prettier here would be a name the data does not carry.
    const rows = [
      artifact({ id: 'aaaaaaaa-1111-1111-1111-111111111111', meta: { name: 'positions' } }),
      artifact({ id: 'bbbbbbbb-2222-2222-2222-222222222222', meta: { name: 'positions' } }),
    ]
    expect(labelsFor(rows)).toEqual(['positions · aaaaaaaa', 'positions · bbbbbbbb'])
  })

  it('a hash appears only where two DECLARED names collide', () => {
    const rows = [
      artifact({ id: 'aaaaaaaa-1111-1111-1111-111111111111', meta: { name: 'positions', source_key: 'K_alpha' } }),
      artifact({ id: 'bbbbbbbb-2222-2222-2222-222222222222', meta: { name: 'positions', source_key: 'K_alpha' } }),
    ]
    // The hash lands on the row that would otherwise REPEAT one already used, which is
    // `disambiguate`'s long-standing shape and is left as it is: the claim under test is that a
    // hash appears ONLY here, not that both rows wear one. The two rows are still tellable
    // apart, which is the property `distinguishableOptions.test.tsx` asserts as a class.
    expect(labelsFor(rows)).toEqual(['K_alpha', 'K_alpha · bbbbbbbb'])
  })
})

// ── TEST-56 [ITEM-43] — declarations reach the kernels WITHOUT entering the frame ──────────
//
// The acceptance condition DRIFT-1.12 set: a seam that requires editing this module's existing
// "returns EVERY metadata column on the axis" / "keeps every column under the PRODUCER name"
// assertions is the WRONG seam. Those assertions are about the frame's COLUMN SET, and a
// declaration is not a column. The first attempt put the declarations under a reserved key inside
// the frame and broke all four; this pins that the replacement cannot.
describe('declared metadata rides ALONGSIDE the frame, never inside it (ITEM-43)', () => {
  const anchor = matrix('m1', ['rows', 'cols'])
  const imported = table('imported', 'rows', [{ name: 'label_a', kind: 'categorical' }])
  const analysisOut = table('analysis', 'rows', [{ name: 'metric_a', kind: 'numeric' }])
  const artifacts = [anchor, imported, analysisOut]
  const FRAMES: Record<string, Record<string, unknown[]>> = {
    imported: { label_a: ['a', 'b'] },
    analysis: { metric_a: [1, 2] },
  }
  const read = async (r: ArtifactRow) => FRAMES[r.id] ?? {}

  it('the frame key set is EXACTLY the columns — no reserved key, no phantom column', async () => {
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read)
    // The property every key-enumerating reader depends on. A sidecar key would appear here.
    expect(Object.keys(frame).sort()).toEqual(['label_a', 'metric_a'])
    for (const v of Object.values(frame)) expect(Array.isArray(v)).toBe(true)
  })

  it('the kernels still SEE the declarations, keyed by the minted column key', async () => {
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read)
    const decls = declarationsOf(frame)
    // `numeric` is the producer's word for what the kernels call continuous; the mapping happens
    // once, here, rather than in each consumer.
    expect(decls['metric_a']?.kind).toBe('continuous')
    expect(decls['label_a']?.kind).toBe('categorical')
  })

  it('the DECLARED level set arrives, and a bool level is bridged to the comparator dialect', async () => {
    // The levels reader is injected (this module stays IO-free) and is a METADATA read in
    // production — one `zarr.json`, no chunks. The picker must be able to list a column's
    // categories without downloading the column, because the list is rendered for every column
    // on the axis while the values are wanted for the one or two a criterion names.
    const boolTable = table('flags', 'rows', [{ name: 'flag_a', kind: 'categorical', dtype: 'bool' }])
    const rows = [anchor, imported, boolTable]
    const frames: Record<string, Record<string, unknown[]>> = {
      imported: { label_a: ['a', 'b'] },
      flags: { flag_a: [true, false] },
    }
    const readLevels = async (row: ArtifactRow) =>
      row.id === 'flags' ? ['false', 'true'] : ['a', 'b', 'c']
    const frame = await readAxisColumnsFrame(
      rows,
      'm1',
      'rows',
      async r => frames[r.id] ?? {},
      undefined,
      readLevels,
    )
    const decls = declarationsOf(frame)
    // A level that occurs in ZERO rows is still declared, and still offered.
    expect(decls['label_a']?.levels).toEqual(['a', 'b', 'c'])
    // THE BRIDGE (ITEM-36): the producer declares a bool's levels lowercase, the comparator
    // spells a JS boolean capitalised. Offering the raw form would match nothing and silently
    // drop every row of that criterion, so the spelling is fixed ONCE, here, at construction.
    expect(decls['flag_a']?.levels).toEqual(['False', 'True'])
  })

  it('reads NO levels when none is injected — byte-identical to before', async () => {
    const frame = await readAxisColumnsFrame(artifacts, 'm1', 'rows', read)
    const decls = declarationsOf(frame)
    // NON-VACUITY. The claim below is a `for` over the declarations. WHEN THE DEFECT IS
    // PRESENT — `attachDeclarations` becomes a no-op, or the WeakMap seam stops being
    // registered against the frame object — `declarationsOf` returns `{}`, the loop body
    // runs ZERO times and this test reports "no levels were read" while in truth NOTHING
    // was read. Pin that declarations exist first, and name them, so the loop has subjects.
    expect(Object.keys(decls).sort()).toEqual(['label_a', 'metric_a'])
    for (const d of Object.values(decls)) expect(d.levels).toBeUndefined()
  })

  it('a frame built with NO declarations reports none', async () => {
    // The opt-in property: every pre-existing frame keeps behaving exactly as before.
    expect(declarationsOf({ a: [1, 2] })).toEqual({})
    expect(declarationsOf(null)).toEqual({})
  })
})

// ── ITEM-8: THE PLURAL ANCHOR, AND THE FOLD THAT MAKES IT MEAN SOMETHING ────────────────
//
// `RowSpaceAnchor` carries a LIST of axes, because an integrated coordinate rests on two
// datasets' axes at once. A predicate that decided off `axes[0]` would look identical on
// every project in existence (they all have one axis) and would silently drop the SECOND
// dataset's every column the moment an integrated coordinate appeared. So each case below is
// written so that a first-axis-only implementation FAILS it, and each compares the offered SET
// rather than a count.

describe('the offering predicate over a PLURAL anchor (ITEM-8)', () => {
  const catalog = [
    rowSpace('axis-one', 'hash-one', KEYS_ONE),
    rowSpace('axis-two', 'hash-two', KEYS_TWO),
    candidate('mine', KEYS_ONE),
    candidate('theirs', KEYS_TWO),
    candidate('undeclared'),
  ]
  /** The anchor an INTEGRATED coordinate produces: both axes, in the declared order. */
  const both = resolveRowSpaceAnchor(catalog, ['hash-one', 'hash-two'])

  it('resolves EVERY named axis, in the order named', () => {
    expect(both?.axes.map(a => a.contentHash)).toEqual(['hash-one', 'hash-two'])
    expect(both?.axes.map(a => a.keySequenceDigest)).toEqual([KEYS_ONE, KEYS_TWO])
    // …and the other order is a different anchor, because the declared order IS the segment
    // order (INV-7) and is not the resolver's to normalise.
    expect(resolveRowSpaceAnchor(catalog, ['hash-two', 'hash-one'])?.axes.map(a => a.contentHash)).toEqual([
      'hash-two',
      'hash-one',
    ])
  })

  it('ALL OR NOTHING — one unresolvable hash refuses the whole anchor, it does not shrink it', () => {
    // A short anchor is the dangerous answer: it IS an anchor, every section renders, and the
    // offer silently describes fewer rows than the picture does. A0 makes the sections speak.
    expect(resolveRowSpaceAnchor(catalog, ['hash-one', 'hash-gone'])).toBeUndefined()
    expect(resolveRowSpaceAnchor(catalog, [])).toBeUndefined()
    expect(resolveRowSpaceAnchor(catalog, null)).toBeUndefined()
    // A repeated hash names ONE axis, however many times it is written.
    expect(resolveRowSpaceAnchor(catalog, ['hash-one', 'hash-one'])?.axes).toHaveLength(1)
  })

  it('A1 on EITHER axis is A1 — a candidate of either dataset describes rows of this picture', () => {
    // The case a first-axis-only fold gets wrong in the direction that LOSES data: `theirs`
    // is aligned to the SECOND axis, and dropping it takes ds-2's every column off the offer.
    expect(alignmentState(candidate('x', KEYS_ONE).structure, both)).toBe('A1')
    expect(alignmentState(candidate('x', KEYS_TWO).structure, both)).toBe('A1')
  })

  it('A2 only when EVERY axis says elsewhere', () => {
    // The other direction: a candidate genuinely on neither axis is still not offered, so the
    // plural fold has not been widened into "offer everything".
    const elsewhere = candidate('elsewhere', 'c'.repeat(64))
    expect(alignmentState(elsewhere.structure, both)).toBe('A2')
    // …and against a single-axis anchor the same candidate is A2 too, so the verdict is the
    // candidate's and not an artefact of the anchor's arity.
    expect(alignmentState(elsewhere.structure, resolveRowSpaceAnchor(catalog, ['hash-one']))).toBe('A2')
  })

  it('an axis that cannot answer makes the verdict A3, never a confident A2', () => {
    // One axis whose own key artifact declares no key sequence: the question is open on that
    // axis, so "aligned elsewhere" would be a confident wrong answer about a candidate that
    // may well be aligned to it.
    const silent = row({
      id: 'axis-silent',
      content_hash: 'hash-silent',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', key: 'values' },
    })
    const mixed = resolveRowSpaceAnchor([...catalog, silent], ['hash-one', 'hash-silent'])
    expect(alignmentState(candidate('x', KEYS_TWO).structure, mixed)).toBe('A3')
    // …while the SAME candidate against the two REAL axes it is not on is A2, which is what
    // makes the A3 above attributable to the unanswerable axis rather than to the fold.
    expect(alignmentState(candidate('x', 'c'.repeat(64)).structure, both)).toBe('A2')
  })

  it('offers BOTH datasets’ columns against an integrated anchor — the SET, not the count', () => {
    const offered = offeredOnRowSpace(catalog.filter(r => r.datatype === 'demo/plottable'), both)
    expect(offered.map(c => c.id).sort()).toEqual(['mine', 'theirs', 'undeclared'])
    // The single-axis anchor is the control: the same catalog offers only ITS half, so the
    // extra offer above is the second axis doing work and not the filter being absent.
    const one = offeredOnRowSpace(
      catalog.filter(r => r.datatype === 'demo/plottable'),
      resolveRowSpaceAnchor(catalog, ['hash-one']),
    )
    expect(one.map(c => c.id).sort()).toEqual(['mine', 'undeclared'])
  })

  it('a section reaches the plural anchor through `$scope.axis` unchanged', () => {
    // End of the wire: the declarative source spells `aligned_to: "$scope.axis"` and pane scope
    // now carries a LIST. No spec changed; a source that resolved it through `anchorId` would
    // refuse a two-element list and offer nothing at all here.
    const got = resolveArtifactRefSource(catalog, ROW_SPACE_SOURCE, {
      scope: { axis: ['hash-one', 'hash-two'] },
    })
    expect(got.map(c => c.id).sort()).toEqual(['mine', 'theirs', 'undeclared'])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// ITEM-35 (DEC-D) — SAME-NAME FUSION in the artifact-ref picker.
//
// The picker twin of `row_space_columns`' fusion. Two datasets carrying a same-named column
// become ONE offer WHEN their vocabularies reconcile, carrying the whole member set (primary
// first) so a run bound to the fused pick records every member. An unreconcilable pair, or two
// columns of ONE dataset, or a single-dataset project, stay UNFUSED — the model must never
// assert a shared meaning that is not there (§7 Q1).
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('resolveArtifactRefSource — same-name fusion (ITEM-35, DEC-D)', () => {
  const lat = lattice()
  const source = { datatype: 'demo/column' } as never
  const contCol = (id: string, ds: string) =>
    row({
      id,
      datatype: 'demo/column',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'cols', columns: [{ name: 'values', kind: 'numeric' }] },
      meta: { name: 'metric', kind: 'continuous' },
      source_dataset_id: ds,
    })

  it('fuses a same-named continuous column across TWO datasets into ONE offer, every member primary-first', () => {
    const got = resolveArtifactRefSource([contCol('col-a', DS_A), contCol('col-b', DS_B)], source, { state: {} }, { lattice: lat })
    expect(got).toHaveLength(1)
    // deterministic primary = lowest artifact id, and it stays the offer's single stored id (INV-4)
    expect(got[0].id).toBe('col-a')
    expect(got[0].artifacts).toEqual(['col-a', 'col-b'])
    // a fused offer spans several datasets — its display set is the UNION, not one source
    expect([...(got[0].datasetIds ?? [])].sort()).toEqual([DS_A, DS_B])
    expect(got[0].datasetId, 'the exactly-one field collapses for a multi-source offer').toBeUndefined()
  })

  it('does NOT fuse two same-named columns of the SAME dataset — an ambiguity, never a fusion', () => {
    const got = resolveArtifactRefSource([contCol('col-a', DS_A), contCol('col-b', DS_A)], source, { state: {} }, { lattice: lat })
    expect(got).toHaveLength(2)
    expect(got.every(c => c.artifacts === undefined)).toBe(true)
  })

  it('does NOT fuse when the vocabularies do not reconcile — two honest separate offers (§7 Q1)', () => {
    // continuous vs categorical → mismatched → kept apart, each still selectable.
    const categorical = row({
      id: 'col-b',
      datatype: 'demo/column',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'cols', columns: [{ name: 'values', kind: 'string' }] },
      meta: { name: 'metric', kind: 'categorical', n_categories: 3 },
      source_dataset_id: DS_B,
    })
    const got = resolveArtifactRefSource([contCol('col-a', DS_A), categorical], source, { state: {} }, { lattice: lat })
    expect(got).toHaveLength(2)
    expect(got.every(c => c.artifacts === undefined)).toBe(true)
  })

  it('a single-dataset project never fuses — the one candidate carries no member set', () => {
    const got = resolveArtifactRefSource([contCol('col-a', DS_A)], source, { state: {} }, { lattice: lat })
    expect(got).toHaveLength(1)
    expect(got[0].artifacts).toBeUndefined()
  })
})
