import { describe, it, expect } from 'vitest'
import {
  categories_by_column,
  columns_of,
  controlOfColumn,
  gate_mask,
  isIdentifierColumn,
  count_by,
  extent,
  filter_mask,
  keep_and,
  keep_categories,
  keep_mask,
  keep_range,
  or_masks,
  pendingCriterionColumns,
  unique,
  type ColumnOption,
} from './primitives'
import { DECLARED_KEY, type DeclaredFrame } from './columnDeclarations'
import { FrameDepthMismatchError } from './frameDepth'

/** Cast a fixture carrying a TypedArray column to `DeclaredFrame` — the runtime accepts it (ITEM-4:
 *  the guards route through `isColumn`), the compile-time type does not yet name the typed backing. */
const tf = (o: Record<string, unknown>): DeclaredFrame => o as unknown as DeclaredFrame

// TEST-4 (PLAN.md ITEM-6) — the compute-primitive library: exact expected
// values for `extent`, `filter_mask` (per-group inclusive range), `or_masks`,
// and `count_by` (before/after).

describe('extent', () => {
  it('returns [min, max] over finite numbers', () => {
    expect(extent([3, 1, 2, 9, 4])).toEqual([1, 9])
    expect(extent([7])).toEqual([7, 7])
  })
  it('ignores NaN and handles empty input', () => {
    expect(extent([NaN, 5, NaN, 2])).toEqual([2, 5])
    expect(extent([])).toEqual([undefined, undefined])
  })
})

describe('unique', () => {
  it('dedupes preserving first-seen order', () => {
    expect(unique(['A', 'B', 'A', 'C', 'B'])).toEqual(['A', 'B', 'C'])
    expect(unique([1, 1, 1])).toEqual([1])
  })
})

describe('filter_mask (per-group inclusive range)', () => {
  it('hides a cell below min or above max for its group; boundaries kept', () => {
    const mask = filter_mask({
      values: [1, 10, 100, 5],
      group_of: ['A', 'A', 'B', 'B'],
      ranges: { A: [2, 50], B: [0, 10] },
    })
    // A[2,50]: 1<2 hide, 10 keep ; B[0,10]: 100>10 hide, 5 keep
    expect(mask).toEqual([true, false, true, false])
  })

  it('keeps boundary values (inclusive) and cells whose group has no range', () => {
    const mask = filter_mask({
      values: [2, 50, 30],
      group_of: ['A', 'A', 'Z'],
      ranges: { A: [2, 50] },
    })
    expect(mask).toEqual([false, false, false]) // 2 == min, 50 == max, Z unranged
  })
})

describe('or_masks', () => {
  it('OR-combines parallel masks element-wise', () => {
    expect(
      or_masks([
        [true, false, false],
        [false, false, true],
      ]),
    ).toEqual([true, false, true])
  })
  it('returns [] for no masks', () => {
    expect(or_masks([])).toEqual([])
  })

  it('REFUSES masks of differing length (incremental-landing ITEM-4 / INV-10)', () => {
    // The masks are one frame's per-metric hidden masks, index-parallel by construction. Once
    // columns can land to different depths, the OLD "pad to the longest" sized the result to the
    // deepest metric and mis-aligned every shorter one — a full-length, plausible, wrong mask. So
    // differing lengths are now REFUSED, not padded. Equal lengths still compute (positive control).
    expect(() =>
      or_masks([
        [false, true],
        [false, false, false, true],
      ]),
    ).toThrow(FrameDepthMismatchError)
    expect(() => or_masks([[true], [false, false, false]])).toThrow(FrameDepthMismatchError)
    // Positive control: equal-length masks compute exactly as before.
    expect(
      or_masks([
        [false, true, false],
        [false, false, true],
      ]),
    ).toEqual([false, true, true])
  })
})

describe('count_by (before/after)', () => {
  it('counts every cell before and only unhidden cells after, per group', () => {
    const counts = count_by({
      group: ['A', 'A', 'A', 'B'],
      hidden: [true, false, true, false],
    })
    expect(counts).toEqual({
      A: { before: 3, after: 1 },
      B: { before: 1, after: 1 },
    })
  })

  it('a "__proto__" group key does NOT pollute Object.prototype (finding: proto pollution)', () => {
    const before = (Object.prototype as Record<string, unknown>).before
    const counts = count_by({
      group: ['__proto__', '__proto__', 'constructor'],
      hidden: [false, true, false],
    })
    // The dangerous keys are ordinary own entries on the result…
    expect(Object.prototype.hasOwnProperty.call(counts, '__proto__')).toBe(true)
    expect(counts['__proto__']).toEqual({ before: 2, after: 1 })
    expect(counts['constructor']).toEqual({ before: 1, after: 1 })
    // …and Object.prototype was never touched.
    expect((Object.prototype as Record<string, unknown>).before).toBe(before)
    expect(({} as Record<string, unknown>).before).toBeUndefined()
  })
})

describe('filter_mask (prototype-safe ranges lookup)', () => {
  it('a "__proto__" group does NOT resolve to Object.prototype (finding: proto pollution)', () => {
    // With a bare-object `ranges`, `ranges["__proto__"]` would be Object.prototype
    // (truthy) → the cell would always be kept. The own-property guard makes an
    // unranged "__proto__"/"constructor" group behave like any missing range (keep).
    const mask = filter_mask({
      values: [-100, 999],
      group_of: ['__proto__', 'constructor'],
      ranges: { A: [0, 10] },
    })
    expect(mask).toEqual([false, false])
  })
})

// ── Cell-filter KEEP masks (declarative-canvas-plots ITEM-29/30) — TEST-30 ──────

describe('keep_range (continuous criterion keep-mask, ITEM-29)', () => {
  it('keeps cells inside [min,max] inclusive; drops outside', () => {
    expect(keep_range([1, 5, 10, 15], 5, 10)).toEqual([false, true, true, false])
  })
  it('null bound is unbounded on that side', () => {
    expect(keep_range([1, 5, 10], null, 5)).toEqual([true, true, false])
    expect(keep_range([1, 5, 10], 5, null)).toEqual([false, true, true])
  })
  it('both bounds null ⇒ no constraint (all kept); a NaN fails a real threshold', () => {
    expect(keep_range([1, NaN, 3], null, null)).toEqual([true, true, true])
    expect(keep_range([1, NaN, 3], 0, 10)).toEqual([true, false, true])
  })
})

describe('keep_categories (categorical criterion keep-mask, ITEM-29)', () => {
  it('keeps cells whose category is in the keep set', () => {
    expect(keep_categories(['A', 'B', 'C', 'A'], ['A', 'C'])).toEqual([true, false, true, true])
  })
  it('an empty keep set is NO constraint (keep all) — not "hide everything"', () => {
    expect(keep_categories(['A', 'B'], [])).toEqual([true, true])
  })
})

describe('keep_and (combined keep-mask = AND of criteria, ITEM-30)', () => {
  it('a cell survives iff it passes EVERY criterion', () => {
    // cell1 fails mask2; cell2 fails mask1; cell0 & cell3 pass both.
    const m1 = [true, true, false, true]
    const m2 = [true, false, true, true]
    expect(keep_and([m1, m2])).toEqual([true, false, false, true])
  })
  it('empty input ⇒ [] (caller supplies the all-kept default)', () => {
    expect(keep_and([])).toEqual([])
  })
  it('a single mask passes through', () => {
    expect(keep_and([[true, false, true]])).toEqual([true, false, true])
  })
  it('a missing (short-mask) tail position defaults to kept — the criteria PAD-KEEP contract (DEC-4)', () => {
    // keep_and serves the criteria path, where a criterion column may be legitimately shorter than
    // the frame (a subset). The committed backend mask pads the tail KEPT, so the live
    // preview must too — pinned by the 127-case coercion corpus. This is index-ALIGNED (row i is
    // still row i; an absent column defaults kept), so it upholds INV-10; the mixed-depth refusal
    // lives on the directly-paired kernels + the cross-source keep-mask, not here.
    expect(keep_and([[false], [true, true, true]])).toEqual([false, true, true])
  })
})

// ── keep_mask (Slice 4, ITEM-9 / DEC-27 joint drop) ────────────────────────────
describe('keep_mask', () => {
  const obs = {
    pct_mito: [5, 20, 8, 2],
    cell_type: ['T', 'B', 'T', 'NK'],
  }
  it('no criteria ⇒ every cell kept (all-true over the obs length)', () => {
    expect(keep_mask([], obs)).toEqual([true, true, true, true])
  })
  it('a continuous range criterion keeps cells within [min,max] (bounds coerced from text)', () => {
    // keep pct_mito < 10 (max=10, min unbounded) — string bounds from a text input, "" ⇒ unbounded.
    expect(keep_mask([{ column: 'pct_mito', control: 'range', min: '', max: '10' }], obs)).toEqual([
      true,
      false,
      true,
      true,
    ])
  })
  it('a categorical keep-set from the REAL view shape (control:"") keeps cells whose category is in keep', () => {
    // P1 regression guard: the real cell-filter view seeds `control:''` and only writes
    // column/min/max/keep — a categorical keep-set arrives WITHOUT `control:'multiselect'`. It must
    // still reach the categorical branch (shape-inferred). If the bug returns it falls to range →
    // keep-all → [true,true,true,true].
    expect(keep_mask([{ column: 'cell_type', control: '', keep: ['T'] }], obs)).toEqual([
      true,
      false,
      true,
      false,
    ])
  })
  it('an explicit control:"multiselect" categorical criterion still works (AI back-compat)', () => {
    expect(keep_mask([{ column: 'cell_type', control: 'multiselect', keep: ['T'] }], obs)).toEqual([
      true,
      false,
      true,
      false,
    ])
  })
  it('AND across criteria — joint drop (a cell dropped by ANY criterion is dropped overall)', () => {
    const mask = keep_mask(
      // Real view shape: range criterion sets min/max, categorical sets keep — neither sets control.
      [
        { column: 'pct_mito', control: '', max: '10' },
        { column: 'cell_type', control: '', keep: ['T'] },
      ],
      obs,
    )
    // cell0 (mito5,T) kept; cell1 (mito20,B) dropped by both; cell2 (mito8,T) kept; cell3 (mito2,NK) dropped by cat.
    expect(mask).toEqual([true, false, true, false])
  })
  it('a criterion on an ABSENT column keeps every cell (never silently hides the dataset)', () => {
    expect(keep_mask([{ column: 'nope', control: 'range', max: '1' }], obs)).toEqual([true, true, true, true])
  })
  it('an empty-string bound is UNBOUNDED — never Number("")===0 dropping every cell below 0', () => {
    expect(keep_mask([{ column: 'pct_mito', control: 'range', min: '', max: '' }], obs)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })
})

// ── F2-27: the range branch's CELL coercion == the committed mask's ────────────────
// Every expectation below is the answer `cell-filter.py::criteria_keep_mask` gives for
// the SAME obs + criteria. Bare `Number()` — what this branch used before — answers the
// OPPOSITE on each of them.
//
// ROUND-4 (R3-122): this header used to certify these expectations "against a 50-case
// differential corpus" that existed NOWHERE in the tree, and nothing re-ran it — while
// the two coercions in fact already disagreed on `'1_0'`. The corpus is real now:
// `src-app/testdata/criteria-coercion-corpus.json` (123 cases), executed against all
// THREE readers by `scripts/coercion-parity.mjs` (`just check-coercion`), and against
// THIS reader (3, the live preview) by `coercionCorpus.test.ts` in this directory. (There
// was a fourth reader — the criteria lifted into a DSL predicate and evaluated — but that
// was a SECOND ENCODING of the same filter and ITEM-4 deleted it; see the corpus README.)
// The cases below are the readable, hand-explained subset; the corpus is the exhaustive
// one.
//
// The count above is a SNAPSHOT (read it off the corpus, don't trust this line if it
// matters): `coercionCorpus.test.ts`'s "keeps its breadth" case only floors it at 80, so
// the exact figure can drift upward without failing anything. It said 106 for one round
// after the corpus reached 123.
describe('keep_mask range-branch cell coercion (F2-27, parity with the committed mask)', () => {
  it('a NULL obs cell FAILS a numeric threshold (Number(null)===0 kept it live, the commit dropped it)', () => {
    // Reachable, not hypothetical: `arrowClient.tableFromArrow` yields `null` for an Arrow
    // null slot, i.e. any QC column with missing values. python: [1,None,10,None,20] max 10
    // → 10100.
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], { pct_mito: [1, null, 10, null, 20] })).toEqual([
      true,
      false,
      true,
      false,
      false,
    ])
    // …and on a MIN-only criterion too (`Number(null)===0` passed `min:0`).
    expect(keep_mask([{ column: 'pct_mito', min: '0' }], { pct_mito: [1, null, 10] })).toEqual([
      true,
      false,
      true,
    ])
  })

  it('an EMPTY / whitespace-only string cell fails the threshold (Number("")===0 did not)', () => {
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], { pct_mito: [1, '', 10] })).toEqual([
      true,
      false,
      true,
    ])
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], { pct_mito: [1, ' ', 10] })).toEqual([
      true,
      false,
      true,
    ])
  })

  it('a HEX-spelled cell is not a number (Number("0x10")===16 kept it under max 20; python raises)', () => {
    expect(keep_mask([{ column: 'pct_mito', max: '20' }], { pct_mito: ['0x10', 5] })).toEqual([
      false,
      true,
    ])
  })

  it('a mixed object column coerces per CELL exactly as the committed mask does', () => {
    // python: [1.5, None, "3", ""] with min 0 / max 10 → 1010.
    expect(
      keep_mask([{ column: 'pct_mito', min: '0', max: '10' }], { pct_mito: [1.5, null, '3', ''] }),
    ).toEqual([true, false, true, false])
  })

  it('keeps the coercions the committed mask AGREES with: plain, padded, exponent, sign, boolean', () => {
    // A padded numeric CELL stays numeric in EVERY reader — a cell must NOT be
    // ascii-rejected the way a BOUND is, or the fix would create a new divergence in the
    // opposite direction. ROUND-4: the strip set is the enumerated `VALUE_WS` (see
    // `parseValue`), not each reader's native trim, so the BOM / NEL / U+001C cases below
    // — which used to split the readers in OPPOSITE directions — now agree too.
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], { pct_mito: [1, ' 5', 10] })).toEqual([
      true,
      true,
      true,
    ])
    // R3-108: a BOM-padded cell (what a spreadsheet export leaves on a pasted value) was
    // stripped by JS `trim()` and NOT by python's `str.strip()`, so the preview KEPT a
    // cell the commit DROPPED; a U+0085 (NEL) padded cell was the exact mirror; python
    // alone stripped U+001C-U+001F. All three agree on the enumerated set now.
    expect(
      keep_mask([{ column: 'pct_mito', max: '10' }], {
        pct_mito: ['\ufeff5', '\u00855', '\u001c5', 50],
      }),
    ).toEqual([true, true, true, false])
    // R3-109: `'1_0'` is 10.0 to python's bare `float()` and NaN here. The CELL grammar is
    // now the same plain-ASCII-decimal one the BOUNDS are held to, in all four readers.
    expect(keep_mask([{ column: 'pct_mito', max: '20' }], { pct_mito: ['1_0', 5] })).toEqual([
      false,
      true,
    ])
    expect(keep_mask([{ column: 'score', max: '50' }], { score: ['1e2', '5', '1E1'] })).toEqual([
      false,
      true,
      true,
    ])
    expect(keep_mask([{ column: 'score', min: '0' }], { score: ['+5', '-5', '5'] })).toEqual([
      true,
      false,
      true,
    ])
    // A boolean column is 1.0/0.0 on commit, and the emitted replay prelude's
    // `float(True)` agrees.
    //
    // ROUND-4 (R3-131): this expectation used to hold only for the numpy `bool_` dtype
    // — `criteria_keep_mask`'s range branch dispatches on `np.asarray(col).dtype.kind`,
    // and an OBJECT-dtype bool column (what a pandas nullable-boolean obs column becomes
    // under `np.asarray`, and `main` snapshots exactly that) reached `_value_float`, which
    // answered NaN and therefore the exact INVERSE mask. So the assertion encoded the TS
    // answer rather than the specification's, and passed while the committed mask
    // depended on a storage dtype no recipe can see. `_value_float` now answers 1.0/0.0
    // too, and `test_coercion_corpus.py` runs EVERY corpus case in BOTH dtype flavours
    // (cases `F00`/`F01`) so the two branches can never drift apart again.
    expect(
      keep_mask([{ column: 'is_doublet', control: 'range', min: '0.5' }], {
        is_doublet: [true, false, true, false],
      }),
    ).toEqual([true, false, true, false])
  })

  it('a non-finite cell still fails a real threshold, and is kept when NOTHING is bounded', () => {
    expect(
      keep_mask([{ column: 'pct_mito', max: '10' }], {
        pct_mito: [1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 5],
      }),
    ).toEqual([true, false, false, false, true])
    expect(
      keep_mask([{ column: 'pct_mito', min: '', max: '' }], {
        pct_mito: [1, Number.POSITIVE_INFINITY, Number.NaN],
      }),
    ).toEqual([true, true, true])
  })

  it('an empty table / empty column yields an empty mask (no crash, nothing fabricated)', () => {
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], {})).toEqual([])
    expect(keep_mask([{ column: 'pct_mito', max: '10' }], { pct_mito: [] })).toEqual([])
  })

  it('a criterion carrying BOTH a bound and a keep-set takes the SAME branch the committed mask takes', () => {
    // Shape-inferred: a non-empty `keep` ⇒ CATEGORICAL, and the stale bound is ignored
    // (python `_is_categorical_criterion` agrees) → keeps leiden ∈ {1,3}.
    expect(
      keep_mask([{ column: 'leiden', min: '2', keep: ['1', '3'] }], { leiden: [1, 2, 3, 4] }),
    ).toEqual([true, false, true, false])
    // An EXPLICIT `control:'range'` overrides the shape → the bound wins, keep ignored.
    expect(
      keep_mask([{ column: 'leiden', control: 'range', min: '2', keep: ['1', '3'] }], {
        leiden: [1, 2, 3, 4],
      }),
    ).toEqual([false, true, true, true])
  })
})

// ── columns_of (Slice 4, ITEM-9/29) ────────────────────────────────────────────
describe('an all-distinct column is an IDENTIFIER, not a category', () => {
  // A column with a distinct value in every row names its rows rather than grouping them.
  // Offered as a category it produced both degenerate outcomes at once on a real frame: a
  // keep-set with one option per row, and — because a chart needing a `group` channel binds
  // the first categorical column it is offered — one violin group per row, rendering as a
  // 2700-entry legend over a smear.
  const rows = { metric: [1, 2, 3, 4], label: ['a', 'b', 'a', 'b'], row_key: ['r1', 'r2', 'r3', 'r4'] }

  it('is not offered as a criterion, while the real category still is', () => {
    expect(columns_of(rows)).toEqual([
      { value: 'metric', label: 'metric', control: 'range' },
      { value: 'label', label: 'label', control: 'multiselect' },
    ])
  })

  it('is absent from the group-by picker and from the keyed control map', () => {
    expect(columns_of(rows, { only: 'categorical' })).toEqual([
      { value: 'label', label: 'label', control: 'multiselect' },
    ])
    expect(columns_of(rows, { keyed: true })).toEqual({ metric: 'range', label: 'multiselect' })
  })

  // ── negative controls: the rule is EXACTLY "every value distinct" ──────────────────
  //
  // Without these, the same symptom is "fixed" by a cardinality cutoff, which silently
  // deletes legitimate high-cardinality categories — a worse defect than the one it cures,
  // and invisible because the surface still looks populated.
  it('keeps a high-cardinality category that REPEATS even once', () => {
    const many = Array.from({ length: 500 }, (_, i) => `g${i}`)
    many[499] = 'g0' // one repeat, 499 distinct levels
    const got = columns_of({ donor: many }, { only: 'categorical' }) as Array<{ value: string }>
    expect(got.map(c => c.value)).toEqual(['donor'])
  })

  it('keeps a small all-distinct column only when there is nothing to group (< 2 rows)', () => {
    // One row is trivially all-distinct; stripping every column off it would be a worse
    // answer than an unhelpful one, and there is no grouping to get wrong either way.
    expect((columns_of({ label: ['solo'] }) as Array<{ value: string }>).map(c => c.value)).toEqual(['label'])
    // …but at two rows the property is real, and size is not what makes it true.
    expect(columns_of({ label: ['a', 'b'] })).toEqual([])
  })

  it('never strips a NUMERIC column, however distinct', () => {
    // Identifier-ness is asked only of the categorical branch: an all-distinct metric is
    // exactly what a threshold criterion is FOR.
    expect(columns_of({ metric: [1, 2, 3, 4] })).toEqual([
      { value: 'metric', label: 'metric', control: 'range' },
    ])
  })
})

describe('columns_of', () => {
  const obs = { total_counts: [1, 2, 3], cell_type: ['T', 'B', 'T'] }
  it('array form: numeric → range, string → multiselect', () => {
    expect(columns_of(obs)).toEqual([
      { value: 'total_counts', label: 'total_counts', control: 'range' },
      { value: 'cell_type', label: 'cell_type', control: 'multiselect' },
    ])
  })
  it('keyed form: a { column: control } map for the `when` gate', () => {
    expect(columns_of(obs, { keyed: true })).toEqual({ total_counts: 'range', cell_type: 'multiselect' })
  })
  it('only:categorical filters to string columns (the group-by picker)', () => {
    expect(columns_of(obs, { only: 'categorical' })).toEqual([
      { value: 'cell_type', label: 'cell_type', control: 'multiselect' },
    ])
  })
  // C1/C2 (DOMAIN_AUDIT): the remap is DATA the VIEW declares. `as: 'plot'` used to be a
  // literal that made core answer `violin`/`bar` — a chart-choice default hardcoded in a
  // compute primitive.
  it('as: remaps the keyed values with the DECLARED vocabulary', () => {
    expect(columns_of(obs, { keyed: true, as: { range: 'violin', multiselect: 'bar' } })).toEqual({
      total_counts: 'violin',
      cell_type: 'bar',
    })
    // any vocabulary, not just charts — the primitive knows none of it
    expect(columns_of(obs, { keyed: true, as: { range: 'slider', multiselect: 'chips' } })).toEqual({
      total_counts: 'slider',
      cell_type: 'chips',
    })
  })
  it('a PARTIAL remap falls back to the control name (never undefined)', () => {
    expect(columns_of(obs, { keyed: true, as: { range: 'violin' } })).toEqual({
      total_counts: 'violin',
      cell_type: 'multiselect',
    })
  })
  it('no remap keys the map by control type (the `when`-gate form)', () => {
    expect(columns_of(obs, { keyed: true })).toEqual({ total_counts: 'range', cell_type: 'multiselect' })
  })
})

// ── categories_by_column (Bug 3: the keep-set multiselect OPTIONS source) ────────
describe('categories_by_column', () => {
  it('distinct values per categorical column, first-seen order; numeric columns skipped', () => {
    const obs = {
      total_counts: [1, 2, 3],
      louvain: ['1', '1', '3', '0', '3'],
      bulk_labels: ['NK', 'Mono', 'NK'],
    }
    expect(categories_by_column(obs)).toEqual({
      // total_counts is numeric → skipped (it uses a range, not a keep-set)
      louvain: ['1', '3', '0'],
      bulk_labels: ['NK', 'Mono'],
    })
  })
  it('non-array columns are skipped; an empty column yields an empty list (mirrors columns_of)', () => {
    expect(categories_by_column({})).toEqual({})
    expect(
      categories_by_column({ notArr: 5 as unknown as unknown[], empty: [], strs: ['a'] }),
    ).toEqual({ empty: [], strs: ['a'] })
  })
  // ── F2-28: an OFFERED option must be a SELECTABLE option ─────────────────────────
  // The multiselect can only offer what this returns, and `keep_mask` compares with
  // `categoricalMatches` (python's `str()` spelling). Spelling the options with JS
  // `String()` made every option of a boolean column ("true"/"false") and every "null"
  // option DEAD: picking it hid 100% of the cells, in the preview AND on commit, silently.
  it('spells options in the SAME dialect the mask compares in (python str): True/False/None', () => {
    expect(
      categories_by_column({
        is_doublet: [true, false, true, false],
        cell_type: ['T', null, 'NK', 'T'],
      }),
    ).toEqual({
      is_doublet: ['True', 'False'],
      cell_type: ['T', 'None', 'NK'],
    })
  })

  it('EVERY offered option round-trips: selecting it keeps a non-zero number of cells', () => {
    const obs = {
      is_doublet: [true, false, true, false],
      is_primary: [false, false, true, true],
      cell_type: ['T', null, 'NK', 'T'],
      leiden_str: ['0', '1', '2', '0'],
    }
    const options = categories_by_column(obs)
    // Nothing offered may be a dead end — and the offered options must COVER the column.
    for (const [column, values] of Object.entries(options)) {
      expect(values.length, `${column} offers options`).toBeGreaterThan(0)
      let covered = 0
      for (const option of values) {
        const kept = keep_mask([{ column, keep: [option] }], obs).filter(Boolean).length
        expect(kept, `option ${column}="${option}" keeps at least one cell`).toBeGreaterThan(0)
        covered += kept
      }
      // …and, being the DISTINCT values, they partition the column exactly once.
      expect(covered, `${column} options partition the column`).toBe(4)
    }
  })

  it('a __proto__-named column becomes an own key, never pollutes the prototype', () => {
    // JSON.parse builds a REAL own `__proto__` property (an object literal would set the prototype).
    const obs = JSON.parse('{"__proto__":["x","y"]}') as Record<string, string[]>
    const out = categories_by_column(obs)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(out['__proto__']).toEqual(['x', 'y'])
  })
})



// ═══════════════════════════════════════════════════════════════════════════════════════
// SLICE D — the criteria regression battery.
//
// DEC-19 folded `axis_columns` + the criteria builder into this work, which UNDID the
// isolation the `TypedColumnarFrame` split was built to give. So the criteria kernels are back
// inside the blast radius, and what has to be pinned is not performance but whether a filter's
// RESULT can change — which rows survive — while looking entirely plausible and logging nothing.
//
// Coverage reality this battery answers (measured, 2026-08-15): the tree carries exactly TWO
// effective e2e assertions that would catch a changed kept set, and `gate_mask`,
// `isIdentifierColumn` and `controlOfColumn` had NO direct unit tests at all despite
// `isIdentifierColumn` being an exported cross-module seam consumed by both `columns_of` and the
// canvas binding.
// ═══════════════════════════════════════════════════════════════════════════════════════

// ── TEST-49 [ITEM-37] — first DIRECT tests for three untested seams ────────────────────

describe('gate_mask — the brushed gate reduce (ITEM-37: first direct coverage)', () => {
  it('an EMPTY gate is a no-op, and returns a COPY rather than the caller\'s array', () => {
    const base = [false, true, false]
    const out = gate_mask({ base, gate: [] })
    expect(out).toEqual([false, true, false])
    // A shared reference would let a later mutation of the result rewrite the base mask
    // under whoever still holds it — the aliasing class this repo keeps paying for.
    expect(out).not.toBe(base)
  })

  it('only ever REMOVES rows — it never resurrects a base-hidden one', () => {
    // The documented invariant, and the one that actually matters: a gate must not be able
    // to un-hide a row the sliders hid, or brushing would silently widen the kept set.
    const base = [true, false, false, true]
    expect(gate_mask({ base, gate: [0, 1, 2, 3] })).toEqual([true, false, false, true])
  })

  it('hides every row outside a non-empty gate', () => {
    expect(gate_mask({ base: [false, false, false], gate: [1] })).toEqual([true, false, true])
  })
})

describe('isIdentifierColumn — a per-row name is not a category (ITEM-37)', () => {
  it('is TRUE only when every value is distinct', () => {
    expect(isIdentifierColumn(['a', 'b', 'c'])).toBe(true)
    expect(isIdentifierColumn(['a', 'b', 'a'])).toBe(false)
  })

  it('is exact at EVERY size — not a "too many categories" threshold', () => {
    // Deliberately not a tuned cutoff: a legitimately high-cardinality category (a donor, a
    // cluster) stays a category however many levels it has, and three distinct labels group
    // exactly as uselessly as 2700 do.
    const many = Array.from({ length: 2700 }, (_, i) => `grp-${i % 90}`)
    expect(isIdentifierColumn(many), '90 groups over 2700 rows is a CATEGORY').toBe(false)
    expect(isIdentifierColumn(Array.from({ length: 2700 }, (_, i) => `row-${i}`))).toBe(true)
  })

  it('is FALSE below 2 rows, where everything is trivially distinct', () => {
    expect(isIdentifierColumn([])).toBe(false)
    expect(isIdentifierColumn(['only'])).toBe(false)
  })

  it('compares by VALUE identity, so 1 and "1" are distinct values', () => {
    // Pins the actual comparison rule (Set identity), because a future migration to typed
    // arrays or declared levels changes what the values ARE, and this is what would move.
    expect(isIdentifierColumn([1, '1'])).toBe(true)
  })
})

describe('controlOfColumn — which control a criterion renders (ITEM-37)', () => {
  it('numeric -> range, string -> multiselect', () => {
    expect(controlOfColumn([1, 2, 3])).toBe('range')
    expect(controlOfColumn(['a', 'b'])).toBe('multiselect')
  })

  it('decides from the HEAD value — the property ITEM-33 changes, pinned before it moves', () => {
    // This is a head-peek: `typeof values[0] === 'number'`. A first-row null, or a
    // momentarily-empty column, therefore classifies as `multiselect`. That is the CURRENT
    // rule, and ITEM-33's declaration-driven successor must agree with it on every real
    // column or a criterion silently changes which branch it evaluates.
    expect(controlOfColumn([null, 2, 3]), 'a leading null reads as multiselect today').toBe(
      'multiselect',
    )
    expect(controlOfColumn([]), 'an empty column reads as multiselect today').toBe('multiselect')
  })
})

// ── TEST-44 [ITEM-20/21] — the fail-open guard, and the fallback that certifies it ─────

describe('keep_mask — the all-true fallback is for an ABSENT column ONLY (ITEM-20)', () => {
  const frame = { metric: [5, 20, 8, 2], label: ['x', 'y', 'x', 'z'] }

  it('keeps every row for a column that is genuinely ABSENT', () => {
    // The existing, correct behaviour: a criterion naming a column nobody has must not
    // silently hide the whole table.
    expect(keep_mask([{ column: 'nope', max: 1 }], frame)).toEqual([true, true, true, true])
  })

  it('NEGATIVE CONTROL: a PRESENT column must never reach that fallback', () => {
    // The load-bearing half, and the one the tree was missing. `primitives.test.ts`'s
    // absent-column test passes identically whether the guard is right OR whether every
    // column has stopped being recognised — so on its own it CERTIFIES the failure mode it
    // looks like it protects against. A typed-array migration that leaves one
    // `Array.isArray` guard unconverted turns every criterion into keep-all, silently, with
    // a clean console. This asserts the difference: a present column CONSTRAINS.
    const constrained = keep_mask([{ column: 'metric', max: 10 }], frame)
    expect(constrained).toEqual([true, false, true, true])
    expect(
      constrained.some(v => !v),
      'a PRESENT column must drop at least one row — an all-true answer here means the ' +
        'column was not recognised as a column, which is the fail-open bug, not a filter',
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: a categorical keep-set on a PRESENT column constrains too', () => {
    const constrained = keep_mask([{ column: 'label', keep: ['x'] }], frame)
    expect(constrained).toEqual([true, false, true, false])
    expect(constrained.some(v => !v)).toBe(true)
  })
})

// ── TEST-45 [ITEM-21/40] — missing, boundaries, and int64 ──────────────────────────────

describe('keep_mask — missing values, inclusive bounds and int64 (ITEM-21/40)', () => {
  it('a MISSING row is dropped by a min:0 bound — it is not a real zero', () => {
    // The hazard a typed migration introduces: an integer typed array has no `null` and no
    // `NaN`, so an erased missing becomes 0 and lands INSIDE `{min: 0}`. Today `parseValue`
    // makes it non-finite and `keep_range` drops it. Pinned in the BOXED representation now,
    // so the typed one has an oracle to match.
    const frame = { m: [1, null, 2, ''] }
    const mask = keep_mask([{ column: 'm', min: 0 }], frame)
    expect(mask, 'null and empty-string are NOT zeros').toEqual([true, false, true, false])
  })

  it('bounds are INCLUSIVE at both ends', () => {
    const frame = { m: [1, 2, 3] }
    expect(keep_mask([{ column: 'm', min: 1, max: 3 }], frame)).toEqual([true, true, true])
    expect(keep_mask([{ column: 'm', min: 2, max: 2 }], frame)).toEqual([false, true, false])
  })

  it('a value one ULP below an inclusive bound is EXCLUDED — the fround boundary', () => {
    // `Math.fround` differs from a boxed double, so a typed migration moves values that sit
    // exactly on a bound. This pins the classification either side of one.
    const bound = 0.1
    const below = bound - Number.EPSILON * bound
    const frame = { m: [below, bound] }
    expect(keep_mask([{ column: 'm', min: bound }], frame)).toEqual([false, true])
  })

  it('an int64-scale integer keeps the same rows (no bigint -> NaN collapse)', () => {
    // A `BigInt64Array` passthrough would make `typeof v !== "number"`, hence NaN, hence
    // EVERY row dropped. The reader widens int64 to Number today; this is the oracle.
    const big = Number.MAX_SAFE_INTEGER
    const frame = { m: [1, big] }
    expect(keep_mask([{ column: 'm', min: 1 }], frame)).toEqual([true, true])
  })
})

// ── TEST-47 [ITEM-36] — the BOOLEAN SPELLING divergence ───────────────────────────────

describe('categorical spelling — a saved keep-set must resolve identically (ITEM-36)', () => {
  const frame = {
    flagA: [true, false, true, false],
    label: ['x', null, 'z', 'x'],
    code: ['0', '1', '2', '0'],
  }

  it('the OPTIONS a column offers are spelled in the comparator\'s own dialect', () => {
    // One spelling for the option list and the comparator, or the dropdown offers values its
    // own filter cannot match. `pyStr` is that dialect: True/False/None, not true/false/null.
    const opts = categories_by_column(frame)
    expect(opts.flagA).toEqual(['True', 'False'])
    expect(opts.label).toEqual(['x', 'None', 'z'])
  })

  it('THE DIVERGENCE: the PRODUCER declares bool levels as "false"/"true", lowercase', () => {
    // `cyto_columns.py:225` — `meta.update({"kind": KIND_CATEGORICAL, "levels": ["false", "true"]})`
    // — and for a bool that `meta.levels` is the ONLY copy, because a bool is written as a plain
    // bool array with no `attributes.cyto.levels` to fall back on.
    //
    // So serving the picker from DECLARED levels without reconciling the spelling offers
    // "true"/"false" while the comparator spells the row "True"/"False". Nothing matches, and
    // EVERY row of a boolean criterion is dropped — silently, with a clean console. This test
    // states the divergence as a fact so the reconciliation cannot be quietly skipped.
    const declaredBoolLevels = ['false', 'true']
    for (const level of declaredBoolLevels) {
      const kept = keep_mask([{ column: 'flagA', keep: [level] }], frame).filter(Boolean).length
      expect(
        kept,
        `a RAW declared bool level "${level}" matches nothing — it must be spelled through ` +
          'the comparator dialect before it is offered',
      ).toBe(0)
    }
    // ...whereas the reconciled spelling keeps exactly the rows it names.
    expect(keep_mask([{ column: 'flagA', keep: ['True'] }], frame).filter(Boolean).length).toBe(2)
  })

  it('a keep-set saved under the OBSERVED options resolves to the same rows either way', () => {
    // The migration-safety property: keep-sets persist BY NAME, so the only thing that can
    // move the answer is the SPELLING of that name. Pinned for string, bool and missing.
    for (const [column, option, expected] of [
      ['label', 'x', 2],
      ['label', 'None', 1],
      ['flagA', 'False', 2],
      ['code', '0', 2],
    ] as const) {
      const kept = keep_mask([{ column, keep: [option] }], frame).filter(Boolean).length
      expect(kept, `${column}="${option}"`).toBe(expected)
    }
  })
})

// ── TEST-48 [ITEM-32] — declared levels, and the zero-row level ───────────────────────

describe('declared levels — the round-trip canary (ITEM-32)', () => {
  it('a level DECLARED but never observed keeps ZERO rows, and must not be silently dropped', () => {
    // pandas retains unused categories after subsetting, so a declared level with no rows is
    // ordinary. Serving the picker from declared levels therefore offers an option that keeps
    // nothing — which is legitimate, but it BREAKS the existing "every offered option keeps at
    // least one row" invariant. That existing test is the canary; this states the intended
    // successor behaviour so the two cannot both be believed at once.
    const frame = { label: ['x', 'x', 'z'] }
    expect(categories_by_column(frame).label, 'observed options today').toEqual(['x', 'z'])
    // A declared-levels implementation would additionally offer e.g. "B" here. Selecting it
    // must keep zero rows WITHOUT throwing and WITHOUT hiding the other options.
    expect(keep_mask([{ column: 'label', keep: ['y'] }], frame)).toEqual([false, false, false])
    expect(keep_mask([{ column: 'label', keep: ['y', 'x'] }], frame)).toEqual([true, true, false])
  })
})

// ── TEST-39/40/48 [ITEM-32/33] — the DECLARATION outranks the data ─────────────────────
//
// [acceptance][invariant: INV-11] The producer's declared level set is authoritative, and
// substituting it must not change which rows a saved criterion keeps.
describe('declared metadata outranks inspection (ITEM-32/33)', () => {
  const declare = (d: Record<string, { kind?: string; levels?: string[] }>) => ({
    [DECLARED_KEY]: d,
  })

  it('TEST-39: options come from the DECLARED levels, in the producer\'s order', () => {
    const frame = {
      label: ['x', 'x', 'z'],
      ...declare({ label: { kind: 'categorical', levels: ['x', 'y', 'z'] } }),
    }
    // 'y' occurs in ZERO rows and is still offered — pandas keeps unused categories after a
    // subset, and a user filtering on a currently-absent value should see it. Order is the
    // producer's, not first-seen (which would be x, z).
    expect(categories_by_column(frame).label).toEqual(['x', 'y', 'z'])
  })

  // ── M3 — an EMPTY declared level set is an absence, not an assertion of "no categories" ──────
  //
  // WHAT THIS DOES WHEN THE DEFECT IS PRESENT: the guard was `if (d?.levels)`, and `[]` is truthy.
  // A producer that wrote an empty level set therefore SUPPRESSED the inspection fallback and the
  // picker offered zero options over a column whose rows are right there — a dropdown asserting
  // "this column has no categories" about a column full of them. `valuePreview` in `artifactReader`
  // already applies the correct rule (`!levels || levels.length === 0`); this kernel did not.
  it('M3: an empty declared level set falls back to INSPECTING the rows', () => {
    const frame = {
      label: ['x', 'x', 'z'],
      ...declare({ label: { kind: 'categorical', levels: [] } }),
    }
    expect(categories_by_column(frame).label, 'an empty declaration silenced the real values').
      toEqual(['x', 'z'])
    // Non-vacuity: a NON-empty declaration must still outrank inspection — the fix must not have
    // turned the declared path off (this is TEST-39's property, restated here as the control).
    const declared = {
      label: ['x', 'x', 'z'],
      ...declare({ label: { kind: 'categorical', levels: ['x', 'y', 'z'] } }),
    }
    expect(categories_by_column(declared).label).toEqual(['x', 'y', 'z'])
  })

  it('TEST-48: a declared-but-unobserved level keeps ZERO rows without throwing or hiding the rest', () => {
    const frame = {
      label: ['x', 'x', 'z'],
      ...declare({ label: { kind: 'categorical', levels: ['x', 'y', 'z'] } }),
    }
    expect(keep_mask([{ column: 'label', keep: ['y'] }], frame)).toEqual([false, false, false])
    expect(keep_mask([{ column: 'label', keep: ['y', 'x'] }], frame)).toEqual([true, true, false])
  })

  it('TEST-39: a saved keep-set resolves to the SAME rows with and without declarations', () => {
    // The migration-safety property, asserted as an equivalence rather than a snapshot: the
    // substitution may ADD options, but it must not move the answer for one already saved.
    const values = { label: ['x', null, 'z', 'x'] }
    const declared = {
      ...values,
      ...declare({ label: { kind: 'categorical', levels: ['x', 'None', 'z'] } }),
    }
    for (const option of ['x', 'None', 'z']) {
      expect(
        keep_mask([{ column: 'label', keep: [option] }], declared),
        `option ${option} must select the same rows either way`,
      ).toEqual(keep_mask([{ column: 'label', keep: [option] }], values))
    }
  })

  it('TEST-40: a declared kind classifies a column the head peek gets WRONG', () => {
    // A leading null reads as `multiselect` by inspection; the producer says continuous.
    const frame = {
      metric: [null, 2, 3],
      ...declare({ metric: { kind: 'continuous' } }),
    }
    expect(columns_of(frame)).toEqual([{ value: 'metric', label: 'metric', control: 'range' }])
    // ...and this is what the SAME column does UNDECLARED, which is worse than it looks: the
    // head peek reads `null` as non-numeric so the column becomes a `multiselect`, and then the
    // identifier check sees three distinct values and drops it from the picker ALTOGETHER. A
    // perfectly ordinary numeric column with one missing leading value is simply not offerable
    // today. The declaration is what makes it a range again.
    expect(columns_of({ metric: [null, 2, 3] }), 'undeclared: not offered at all').toEqual([])
  })

  it('TEST-40: a DECLARED categorical is never mistaken for an identifier', () => {
    // Every sampled value distinct — by inspection this is a per-row name and gets dropped
    // from the picker. The producer says it is a category, so it stays: a subset narrow
    // enough to make a category look unique must not remove the filter.
    const frame = {
      label: ['a', 'b', 'c'],
      ...declare({ label: { kind: 'categorical', levels: ['a', 'b', 'c'] } }),
    }
    expect(columns_of(frame)).toEqual([{ value: 'label', label: 'label', control: 'multiselect' }])
    expect(columns_of({ label: ['a', 'b', 'c'] }), 'undeclared: still dropped').toEqual([])
  })

  it('the sidecar is invisible to every value-consuming kernel', () => {
    // It is a non-array under a reserved key, so every `Array.isArray` guard skips it. If that
    // stopped being true it would show up as a phantom column in the picker or a row-count of
    // its own — both silent.
    const frame = { metric: [1, 2], ...declare({ metric: { kind: 'continuous' } }) }
    expect(Object.keys(categories_by_column(frame))).not.toContain(DECLARED_KEY)
    expect((columns_of(frame) as ColumnOption[]).map(o => o.value)).not.toContain(DECLARED_KEY)
    expect(keep_mask([{ column: 'metric', min: 2 }], frame)).toEqual([false, true])
  })
})

// ── TEST-55 [ITEM-34] — THE HAZARD, not the fix ────────────────────────────────────────
//
// Lazy column bodies create a window in which a criterion names a column that EXISTS but has not
// ARRIVED. The failure mode is that the criterion silently does nothing and the user reads an
// unfiltered result as a filtered one. A test that only checked "a loading state appeared" would
// pass with that bug fully intact — the assertion that matters is about the MASK: during the
// window it must not be permissive.
describe('a criterion whose column has not ARRIVED is gated, not permissive (ITEM-34)', () => {
  const declare = (d: Record<string, { kind?: string; levels?: string[] }>) => ({
    [DECLARED_KEY]: d,
  })

  it('THE HAZARD: a DECLARED but unloaded column must NOT produce an all-true mask', () => {
    // The column is declared (so it exists) and absent from the values (so it is in flight).
    const frame = {
      metric: [1, 2, 3],
      ...declare({ metric: { kind: 'continuous' }, pending: { kind: 'continuous' } }),
    }
    const mask = keep_mask([{ column: 'pending', max: 1 }], frame)
    expect(
      mask.every(Boolean),
      'an all-true mask here is the silent bug: the criterion did nothing and the user ' +
        'cannot tell the result is unfiltered',
    ).toBe(false)
  })

  it('an ABSENT column — one nobody declared — still keeps every row', () => {
    // The pre-existing, correct behaviour, and the reason the two cases must be told apart
    // rather than merged: a criterion on a column that does not exist must never hide the table.
    const frame = { metric: [1, 2, 3], ...declare({ metric: { kind: 'continuous' } }) }
    expect(keep_mask([{ column: 'nope', max: 1 }], frame)).toEqual([true, true, true])
  })

  it('names which criterion is waiting, so a user with several can tell WHICH', () => {
    const frame = {
      metric: [1, 2, 3],
      ...declare({ metric: { kind: 'continuous' }, waiting: { kind: 'categorical' } }),
    }
    expect(
      pendingCriterionColumns([{ column: 'metric', max: 2 }, { column: 'waiting', keep: ['x'] }], frame),
    ).toEqual(['waiting'])
  })

  it('is EMPTY once every criterion column has arrived — the gate opens', () => {
    const frame = {
      metric: [1, 2, 3],
      waiting: ['x', 'y', 'x'],
      ...declare({ metric: { kind: 'continuous' }, waiting: { kind: 'categorical' } }),
    }
    expect(pendingCriterionColumns([{ column: 'waiting', keep: ['x'] }], frame)).toEqual([])
    // ...and the criterion now evaluates normally rather than staying gated.
    expect(keep_mask([{ column: 'waiting', keep: ['x'] }], frame)).toEqual([true, false, true])
  })

  it('an UNDECLARED absent column is not reported as pending — it will never arrive', () => {
    const frame = { metric: [1, 2], ...declare({ metric: { kind: 'continuous' } }) }
    expect(pendingCriterionColumns([{ column: 'nope', max: 1 }], frame)).toEqual([])
  })
})

// ── ITEM-34 — the PICKER must survive lazy bodies, and the mask must not collapse ──────────
//
// The other half of the lazy read, and the half whose failure is invisible. Both picker kernels
// walked the frame's own arrays, so under lazy bodies they would list only the columns already
// downloaded — a criterion picker that offers 1 of 65 columns, or none at all, with no error
// anywhere. And `columnLength` took its answer from those same arrays, so an unfiltered surface
// (no criteria ⇒ no bodies) would compute a ZERO-length keep-mask and render nothing.
//
// Each test below pairs the lazy state with the eager one, because "it lists the column" is only
// meaningful next to "and it still lists it when the body IS present".
describe('a DECLARED column with no body is still offered (ITEM-34)', () => {
  const declare = (d: Record<string, { kind?: string; levels?: string[]; n?: number }>) => ({
    [DECLARED_KEY]: d,
  })

  it('columns_of offers a body-less column, classified from its DECLARATION', () => {
    const frame = {
      metric: [1, 2, 3],
      ...declare({
        metric: { kind: 'continuous', n: 3 },
        deferred_cat: { kind: 'categorical', n: 3 },
        deferred_num: { kind: 'continuous', n: 3 },
      }),
    }
    const offered = columns_of(frame) as Array<{ value: string; control: string }>
    expect(offered.map(o => o.value).sort()).toEqual(['deferred_cat', 'deferred_num', 'metric'])
    // …and with the right control, which decides what the user may EXPRESS about it. A head
    // peek cannot answer here at all — there are no values to peek at.
    expect(offered.find(o => o.value === 'deferred_cat')?.control).toBe('multiselect')
    expect(offered.find(o => o.value === 'deferred_num')?.control).toBe('range')
  })

  it('a body-less column the producer did NOT classify is skipped, not guessed at', () => {
    // Guessing a control decides what the user is allowed to express about a column, so an
    // undeclared kind must not be defaulted into one.
    const frame = { metric: [1, 2], ...declare({ metric: { kind: 'continuous' }, mystery: {} }) }
    expect((columns_of(frame) as Array<{ value: string }>).map(o => o.value)).toEqual(['metric'])
  })

  it('`only` still narrows across body-less columns', () => {
    const frame = {
      ...declare({ a: { kind: 'categorical' }, b: { kind: 'continuous' } }),
    }
    expect((columns_of(frame, { only: 'categorical' }) as Array<{ value: string }>).map(o => o.value)).toEqual(['a'])
    expect((columns_of(frame, { only: 'continuous' }) as Array<{ value: string }>).map(o => o.value)).toEqual(['b'])
  })

  it('categories_by_column offers a body-less categorical\'s DECLARED levels', () => {
    // The affordance the lazy read exists to serve: list a column's categories without
    // downloading the column.
    const frame = { ...declare({ phase: { kind: 'categorical', levels: ['a', 'b', 'zeta'] } }) }
    expect(categories_by_column(frame).phase).toEqual(['a', 'b', 'zeta'])
  })

  it('a body-less categorical with no declared levels offers NOTHING, not an empty list', () => {
    // An empty option array reads as "this column has no categories", which is a claim the
    // frame cannot support — there is nothing declared and nothing to inspect.
    const frame = { ...declare({ phase: { kind: 'categorical' } }) }
    expect(Object.hasOwn(categories_by_column(frame), 'phase')).toBe(false)
  })

  it('THE COLLAPSE: no criteria over a body-less frame keeps every row, at the DECLARED length', () => {
    // The unfiltered opening state under lazy bodies. Taking the length from the values alone
    // gives 0, and a zero-length keep-mask renders an empty before/after with no error — a
    // blank result on a surface the user has not even filtered yet.
    const frame = { ...declare({ metric: { kind: 'continuous', n: 4 }, phase: { kind: 'categorical', n: 4 } }) }
    expect(keep_mask([], frame)).toEqual([true, true, true, true])
  })

  it('a PRESENT body still wins over the declared count', () => {
    // The declared count is a fallback, not an override: if a producer's `n` disagreed with the
    // rows actually delivered, the mask must span the rows that exist.
    const frame = { metric: [1, 2, 3], ...declare({ metric: { kind: 'continuous', n: 99 } }) }
    expect(keep_mask([], frame)).toHaveLength(3)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// incremental-landing (#29) — depth-aware kernels + the TypedArray guard class (ITEM-4)
// ════════════════════════════════════════════════════════════════════════════════════════════

const declareOnly = (d: Record<string, { kind?: string; levels?: string[]; n?: number }>) => ({
  [DECLARED_KEY]: d,
})

describe('TEST-5 — a mixed-depth frame is REFUSED by the directly-paired kernels (INV-10 within-frame)', () => {
  // The refusal lives on the kernels whose operands are DIRECTLY-PAIRED index-parallel arrays,
  // where a differing length is a genuine mis-address (values[i] paired with group_of[j], i≠j).
  // keep_mask/keep_and serve the CRITERIA contract, where a shorter column is legitimately
  // PAD-KEPT (backend parity — DEC-4 amended); that is index-aligned, so it does not go here.
  it('the paired kernels throw on operands of differing length; equal depths compute (positive control)', () => {
    // filter_mask: values vs group_of index-parallel
    expect(() => filter_mask({ values: [1, 2, 3], group_of: ['a', 'a'], ranges: {} })).toThrow(
      FrameDepthMismatchError,
    )
    expect(filter_mask({ values: [1, 2], group_of: ['a', 'a'], ranges: { a: [0, 1] } })).toEqual([
      false,
      true,
    ])
    // count_by: group vs hidden
    expect(() => count_by({ group: ['a', 'a', 'b'], hidden: [true, false] })).toThrow(FrameDepthMismatchError)
    expect(count_by({ group: ['a', 'b'], hidden: [false, true] })).toEqual({
      a: { before: 1, after: 1 },
      b: { before: 1, after: 0 },
    })
    // or_masks: the per-metric hidden masks of one slice are index-parallel by construction.
    expect(() => or_masks([[true, false], [true]])).toThrow(FrameDepthMismatchError)
    expect(or_masks([[true, false, false], [false, false, true]])).toEqual([true, false, true])
    // gate_mask: a gate index beyond the base means the gate was brushed over a DEEPER frame
    expect(() => gate_mask({ base: [false, false], gate: [5] })).toThrow(FrameDepthMismatchError)
    expect(gate_mask({ base: [false, false, false], gate: [1] })).toEqual([true, false, true])
  })

  it('keep_mask PAD-KEEPS a ragged criterion column (the backend-parity contract is preserved)', () => {
    // A criterion on `a` (2 rows) over a frame whose slice is 3 rows: the un-landed/absent tail is
    // KEPT, index-aligned (row 2 of `a` is absent ⇒ kept), matching the committed backend mask.
    const ragged = { a: [1, 2], b: [4, 5, 6] }
    expect(keep_mask([{ column: 'a', min: 0, max: 1 }], ragged)).toEqual([true, false, true])
    // Equal depths still compute exactly as before (positive control).
    const even = { a: [1, 2, 3], b: [4, 5, 6] }
    expect(keep_mask([{ column: 'a', min: 0, max: 2 }], even)).toEqual([true, true, false])
  })
})

describe('TEST-6/7/10 — a TypedArray column is a real column at every guard (isColumn, not Array.isArray)', () => {
  it('TEST-6: columnLength reads a typed column\'s true length; a DECLARED typed column keeps its rows; an UNDECLARED one is not inert', () => {
    const typed = tf({ pct: new Float32Array([5, 20, 8, 2]) })
    // columnLength (via keep_mask mask length) is 4, not 0 — the `:260` guard used to read 0.
    expect(keep_mask([], typed)).toHaveLength(4)
    // A range criterion over the typed column keeps the right rows (not "everything dropped").
    expect(keep_mask([{ column: 'pct', min: 0, max: 10 }], typed)).toEqual([true, false, true, true])
    // A DECLARED typed column keeps its rows under the same criterion.
    const declaredTyped = tf({
      pct: new Float32Array([5, 20, 8, 2]),
      ...declareOnly({ pct: { kind: 'continuous' } }),
    })
    expect(keep_mask([{ column: 'pct', min: 0, max: 10 }], declaredTyped)).toEqual([
      true,
      false,
      true,
      true,
    ])
  })

  it('TEST-7: every kernel that reads a frame column accepts the typed backing (behaviour, not a source scan)', () => {
    const typed = tf({
      pct: new Float32Array([5, 20, 8, 2]),
      ...declareOnly({ pct: { kind: 'continuous' } }),
    })
    // columns_of keeps the typed column in the picker, classified as a range control.
    expect((columns_of(typed) as ColumnOption[]).map(o => o.value)).toContain('pct')
    // pendingCriterionColumns clears — a present typed body is NOT pending.
    expect(pendingCriterionColumns([{ column: 'pct', min: 0, max: 1 }], typed)).toEqual([])
  })

  it('TEST-10: categories_by_column inspects a typed numeric column (skips it as a range) and offers a real column\'s categories', () => {
    // A numeric typed column is a RANGE, so it is skipped by categories_by_column (no keep-set).
    const typed = tf({ pct: new Float32Array([5, 20, 8]) })
    expect(categories_by_column(typed).pct).toBeUndefined()
    // A DECLARED-but-body-less typed column is still classified pending=false once its body lands.
    const declaredTyped = tf({
      pct: new Float32Array([5, 20, 8]),
      ...declareOnly({ pct: { kind: 'continuous' } }),
    })
    expect(pendingCriterionColumns([{ column: 'pct', min: 0, max: 1 }], declaredTyped)).toEqual([])
  })
})

describe('TEST-11 — a converted guard\'s BODY produces a real boolean[]/number[], not a Float32Array', () => {
  it('keep_mask over a typed column returns a boolean[] (Array.isArray), never Float32Array.map\'s typed result', () => {
    const typed = tf({ pct: new Float32Array([5, 20, 8, 2]) })
    const mask = keep_mask([{ column: 'pct', min: 0, max: 10 }], typed)
    // The second-order hazard: `Float32Array.prototype.map` returns a Float32Array. A converted
    // guard whose BODY still used `col.map` would return a typed array of 0/1 here, whose VALUES
    // read the same but whose TYPE is wrong. Assert the representation, the only thing that differs.
    expect(Array.isArray(mask)).toBe(true)
    expect(ArrayBuffer.isView(mask)).toBe(false)
    expect(mask.every(v => typeof v === 'boolean')).toBe(true)
  })
})

describe('TEST-17 — [acceptance][invariant: INV-10] every index-parallel kernel observes an index-parallel frame', () => {
  // The within-frame clause: a kernel whose operands are supposed to be index-parallel (one frame's
  // metric + its group) must never pair row i of one with row j of another. Drive a deliberately
  // INCREMENTAL landing — `metric` advanced to depth 4 while `group` lagged at 2 — and assert the
  // kernel REFUSES rather than computing a full-length mis-aligned result. Under a wholesale
  // landing this state never arises; neither the old code nor an ungated new impl passes it.
  it('a directly-paired kernel handed columns of differing depth is refused; the completed frame computes', () => {
    // `filter_mask`'s values (metric, depth 4) and group_of (group, depth 2) are one frame's two
    // index-parallel columns. A kernel indexing each by its OWN local offset would compute a
    // length-4 mask and mis-address the two group rows — a full-length, plausible, wrong result.
    expect(() => filter_mask({ values: [1, 2, 3, 4], group_of: ['a', 'b'], ranges: { a: [0, 1] } })).toThrow(
      FrameDepthMismatchError,
    )
    // NEGATIVE CONTROL is baked into the fixture: the two buffers have DIFFERENT depths, so a
    // local-offset implementation is the arm that fails (it would NOT throw). Once the landing
    // COMPLETES (both at depth 4) the same kernel computes the correctly-addressed mask.
    const mask = filter_mask({
      values: [1, 2, 3, 4],
      group_of: ['a', 'b', 'a', 'b'],
      ranges: { a: [2, 10], b: [2, 10] },
    })
    // Global rows: metric 1 (group a, <2 → hidden), 2 (b, kept), 3 (a, kept), 4 (b, kept).
    expect(mask).toEqual([true, false, false, false])
    expect(mask).toHaveLength(4)
    // count_by over the same completed slice is index-parallel and computes.
    expect(count_by({ group: ['a', 'b', 'a', 'b'], hidden: mask })).toEqual({
      a: { before: 2, after: 1 },
      b: { before: 2, after: 2 },
    })
  })
})
