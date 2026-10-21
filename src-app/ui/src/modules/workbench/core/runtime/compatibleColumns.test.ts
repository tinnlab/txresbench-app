import { describe, expect, it } from 'vitest'
import {
  compareDeclarations,
  decodeVocabSketch,
  REQUIRE_COLUMN_IN_EVERY_DATASET,
  resolveCompatibleColumns,
  VOCAB_SKETCH_HASH_BYTES,
} from './compatibleColumns'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'

// The cross-dataset column OFFER (ITEM-35), decided from catalog rows alone.
//
// The declarations below are the shape the RUNNING writer emits — read off
// `cyto_columns.write_metadata_column` rather than from a format note (a real return is
// pinned by the cross-seam suite; these are the unit-level cases around it).

const b64 = (hashes: string[]): string => {
  const bytes = new Uint8Array(hashes.length * VOCAB_SKETCH_HASH_BYTES)
  hashes.forEach((h, i) => {
    for (let j = 0; j < VOCAB_SKETCH_HASH_BYTES; j++) {
      bytes[i * VOCAB_SKETCH_HASH_BYTES + j] = parseInt(h.slice(j * 2, j * 2 + 2), 16)
    }
  })
  let s = ''
  bytes.forEach(x => {
    s += String.fromCharCode(x)
  })
  return btoa(s)
}
const H = {
  a: '0102030405060708',
  b: '1112131415161718',
  c: '2122232425262728',
}

let seq = 0
function column(
  datasetId: string,
  name: string,
  member: Record<string, unknown>,
  axis = 'rows',
): ArtifactRow {
  return {
    id: `col-${(seq += 1)}`,
    datatype: 'a/column-kind',
    source_dataset_id: datasetId,
    meta: { name },
    structure: { encoding: 'zarr_v3', kind: 'table', axis, n: 3, columns: [{ path: 'values', ...member }] },
  } as unknown as ArtifactRow
}
function dataset(id: string, axis = 'rows'): ArtifactRow {
  return {
    id,
    datatype: 'a/dataset-kind',
    source_dataset_id: id,
    meta: {},
    structure: { encoding: 'zarr_v3', kind: 'table', axis, n: 3, columns: [{ path: 'x', name: 'x' }] },
  } as unknown as ArtifactRow
}

const CAT = (levels: number, digest: string, sketch: string) => ({
  kind: 'categorical',
  n_levels: levels,
  ordered: false,
  vocab_digest: digest,
  vocab_sketch: sketch,
})
/** A categorical ABOVE the sketch budget — both ITEM-51 fields dropped together. This is the
 *  entire high-cardinality tail, not a corner. */
const HUGE = { kind: 'categorical', n_levels: 35_477, ordered: false }
const NUM = { kind: 'numeric' }

describe('decodeVocabSketch — a partial decode would answer subset questions with noise', () => {
  it('decodes the concatenated fixed-width hashes', () => {
    expect(decodeVocabSketch(b64([H.a, H.b]))).toEqual(new Set([H.a, H.b]))
  })

  it('refuses a length that is not a whole number of hashes', () => {
    // A short sketch has levels MISSING, so a strict superset would test as a subset — a
    // wrong answer with no signal. `undefined` becomes `undecidable` upstream, never a guess.
    const truncated = btoa('abc')
    expect(decodeVocabSketch(truncated)).toBeUndefined()
  })

  it('refuses bytes that are not base64 at all, and refuses an empty sketch', () => {
    expect(decodeVocabSketch('!!!not base64!!!')).toBeUndefined()
    expect(decodeVocabSketch('')).toBeUndefined()
  })
})

describe('compareDeclarations — the arms, in the order that makes each a different question', () => {
  const d = (m: Record<string, unknown>) => ({
    kind: m.kind as string | undefined,
    levels: (m.n_levels as number) ?? null,
    digest: m.vocab_digest as string | undefined,
    sketch: m.vocab_sketch as string | undefined,
    ordered: m.ordered as boolean | undefined,
  })

  it('a KIND disagreement is incompatible and says which is which', () => {
    const v = compareDeclarations([d(CAT(2, 'x', b64([H.a]))), d(NUM)])
    expect(v.compatibility).toBe('incompatible')
    expect(v.note).toMatch(/measurement and a label/)
  })

  it('two continuous columns are compatible with nothing to reconcile', () => {
    const v = compareDeclarations([d(NUM), d(NUM)])
    expect(v.compatibility).toBe('compatible')
    expect(v.note).toMatch(/no vocabulary to reconcile/)
  })

  // THE PRIMARY PATH, not a fallback: above 6,144 levels the writer drops both fields, so this
  // arm carries every real very-wide-vocabulary column.
  it('a high-cardinality pair is UNDECIDABLE — offered, never called incompatible', () => {
    const v = compareDeclarations([d(HUGE), d(HUGE)])
    expect(v.compatibility).toBe('undecidable')
    expect(v.compatibility).not.toBe('incompatible')
    // Copy is a plain fact about the pair, not an apology and not an exception being granted.
    expect(v.note).toMatch(/cannot be checked here/)
    expect(v.note).not.toMatch(/sorry|unfortunately|unable to support|not supported/i)
  })

  it('EXACTLY ONE field present is undecidable, because the writer cannot emit one alone', () => {
    // A tree carrying a digest with no sketch is a state the writer does not produce, so
    // meeting one means something rewrote it and neither field can be trusted.
    const half = { kind: 'categorical', levels: 3, digest: 'x', sketch: undefined, ordered: false }
    const whole = d(CAT(3, 'x', b64([H.a, H.b, H.c])))
    expect(compareDeclarations([half, whole]).compatibility).toBe('undecidable')
  })

  it('equal digests are compatible and identical', () => {
    const v = compareDeclarations([d(CAT(2, 'same', b64([H.a, H.b]))), d(CAT(2, 'same', b64([H.a, H.b])))])
    expect(v.compatibility).toBe('compatible')
    expect(v.relation).toBe('identical')
  })

  // The arm a set hash alone could not answer, and what `authority` mode's level-drop needs.
  it('a nesting SUBSET is compatible and named as containment', () => {
    const small = d(CAT(1, 'da', b64([H.a])))
    const big = d(CAT(3, 'db', b64([H.a, H.b, H.c])))
    const v = compareDeclarations([small, big])
    expect(v.compatibility).toBe('compatible')
    expect(v.relation).toBe('contains')
  })

  // NEGATIVE CONTROL for the arm above: without it, "subset" would just be "any two
  // categoricals", and every genuinely-disjoint pair would be offered as compatible.
  it('vocabularies that do NOT nest are incompatible — decided, not undecidable', () => {
    const l = d(CAT(2, 'dl', b64([H.a, H.b])))
    const r = d(CAT(2, 'dr', b64([H.b, H.c])))
    const v = compareDeclarations([l, r])
    expect(v.compatibility).toBe('incompatible')
    expect(v.relation).toBe('disjoint-or-partial')
    // The distinction the whole vocabulary exists for: here the elements WERE compared.
    expect(v.compatibility).not.toBe('undecidable')
  })

  it('an unreadable sketch degrades to undecidable, never to a mismatch', () => {
    const ok = d(CAT(2, 'd1', b64([H.a, H.b])))
    const bad = { kind: 'categorical', levels: 2, digest: 'd2', sketch: 'zzz', ordered: false }
    expect(compareDeclarations([ok, bad]).compatibility).toBe('undecidable')
  })
})

describe('resolveCompatibleColumns — the offer, from catalog rows only', () => {
  const rows = (): ArtifactRow[] => [
    dataset('ds-a'),
    dataset('ds-b'),
    column('ds-a', 'label_a', CAT(3, 'same', b64([H.a, H.b, H.c]))),
    column('ds-b', 'label_a', CAT(3, 'same', b64([H.a, H.b, H.c]))),
    column('ds-a', 'wide_vocab', HUGE),
    column('ds-b', 'wide_vocab', HUGE),
    column('ds-a', 'measure_a', NUM),
    column('ds-b', 'measure_a', NUM),
    column('ds-a', 'only_in_a', NUM),
  ]

  const resolve = (ids: string[]) =>
    resolveCompatibleColumns(rows(), { of: '$state.datasets', axis: 'rows' }, ids)

  it('offers only columns SEVERAL datasets carry', () => {
    const r = resolve(['ds-a', 'ds-b'])
    const names = r.columns.map(c => c.name)
    expect(names).toContain('label_a')
    expect(names).toContain('wide_vocab')
    expect(names).toContain('measure_a')
    // Not a compatibility verdict — there is no second thing to be compatible with.
    expect(names).not.toContain('only_in_a')
  })

  it('the high-cardinality pair IS offered, marked undecidable', () => {
    const wide = resolve(['ds-a', 'ds-b']).columns.find(c => c.name === 'wide_vocab')
    expect(wide, 'the tail must be offered, not hidden').toBeDefined()
    expect(wide?.compatibility).toBe('undecidable')
  })

  // THE ARM ITSELF IS THE PRIMARY PATH, so it must reach the SELECTABLE offer and not only the
  // evidence table. A negative control that narrowed `options` to `compatible` alone left this
  // suite green — the coverage stopped at `columns`, and the assertion below is what the
  // control found missing. Above 6,144 levels the writer publishes no comparable vocabulary,
  // so this arm carries every real very-wide-vocabulary column: dropping it from the offer would remove
  // most of what a user came to align.
  it('an UNDECIDABLE pair is selectable, and its label says it is unverified', () => {
    const opts = resolve(['ds-a', 'ds-b']).options
    const wide = opts.find(o => o.value === 'wide_vocab')
    expect(wide, 'the undecidable arm must be OFFERED, not merely listed').toBeDefined()
    expect(wide?.label).toMatch(/unverified/)
    // A plain fact about the pair — never an apology, and never an exception being granted.
    expect(wide?.label).not.toMatch(/sorry|unfortunately|not supported|cannot be used/i)
  })

  it('an INCOMPATIBLE pair is listed with its reason but never offered', () => {
    const mixed = [...rows(), column('ds-a', 'mixed_kind', NUM), column('ds-b', 'mixed_kind', CAT(2, 'd', b64([H.a, H.b])))]
    const r = resolveCompatibleColumns(mixed, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b'])
    expect(r.columns.find(c => c.name === 'mixed_kind')?.compatibility).toBe('incompatible')
    expect(r.options.map(o => o.value)).not.toContain('mixed_kind')
  })

  it('sorts offerable rows above refusals, then by name', () => {
    const r = resolve(['ds-a', 'ds-b'])
    const order = r.columns.map(c => c.compatibility)
    const firstUndecidable = order.indexOf('undecidable')
    const lastCompatible = order.lastIndexOf('compatible')
    expect(lastCompatible).toBeLessThan(firstUndecidable)
  })

  it('ONE dataset is anchored-but-empty — a different emptiness from none chosen', () => {
    const one = resolve(['ds-a'])
    expect(one.anchored).toBe(true)
    expect(one.datasets).toBe(1)
    expect(one.count).toBe(0)

    const none = resolve([])
    expect(none.anchored).toBe(false)
    // The two are both empty and they need different sentences; a status could carry only one.
    expect(none.datasets).toBe(0)
  })

  it('reports a name a single dataset declares TWICE rather than merging it away', () => {
    const withDup = [...rows(), column('ds-a', 'label_a', CAT(2, 'other', b64([H.a, H.b])))]
    const r = resolveCompatibleColumns(withDup, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b'])
    const ct = r.columns.find(c => c.name === 'label_a')
    expect(ct?.note).toMatch(/more than once/)
  })

  it('answers with no read port in scope at all — INV-11 by construction', () => {
    // The resolver is PURE over rows the caller already fetched, so there is no read function
    // it could call. That is a stronger guarantee than a spy: a body fetch is not expressible.
    expect(resolve(['ds-a', 'ds-b']).count).toBeGreaterThan(0)
  })
})

// ── H3 / H4 — OFFERABLE IS NARROWER THAN COMPATIBLE ──────────────────────────────────────
//
// Both defects shipped because the offer filter was `compatibility !== 'incompatible'`, and
// `compatibility` answers a different question from "will the producer accept it". Each is
// asserted on `options` (what a user can CHOOSE) separately from `columns` (what a user can
// READ), because the fix must not hide the row — only stop offering it.
describe('the offer filter refuses what the producer refuses', () => {
  const numericPair = [
    dataset('ds-a'),
    dataset('ds-b'),
    column('ds-a', 'measure_col', { kind: 'numeric' }),
    column('ds-b', 'measure_col', { kind: 'numeric' }),
  ]

  it('H3 — a NUMERIC pair is compatible but NOT offerable', () => {
    const r = resolveCompatibleColumns(numericPair, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b'])
    // Still shown, with its verdict — the row is not hidden.
    expect(r.columns.map(c => c.name)).toContain('measure_col')
    expect(r.columns.find(c => c.name === 'measure_col')?.compatibility).toBe('compatible')
    // …and NOT choosable. Offering it produced a form that reported ready and a job that died
    // in the sandbox minutes later.
    expect(r.options.map(o => o.value)).not.toContain('measure_col')
    expect(r.columns.find(c => c.name === 'measure_col')?.note).toMatch(/only label columns/i)
  })

  it('H4 — a column carried by SOME of three datasets is not offerable', () => {
    const three = [
      dataset('ds-a'),
      dataset('ds-b'),
      dataset('ds-c'),
      column('ds-a', 'label_col', { kind: 'categorical', n_levels: 3 }),
      column('ds-b', 'label_col', { kind: 'categorical', n_levels: 3 }),
      // ds-c does NOT carry it — the producer requires every chosen dataset to.
      column('ds-c', 'other', { kind: 'categorical', n_levels: 2 }),
    ]
    const r = resolveCompatibleColumns(three, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b', 'ds-c'])
    expect(r.columns.map(c => c.name)).toContain('label_col')
    expect(r.options.map(o => o.value)).not.toContain('label_col')
    expect(r.columns.find(c => c.name === 'label_col')?.note).toMatch(/2 of the 3 chosen/i)
  })

  it('the CONSTANT drives the threshold — it is a switch, not a comment', () => {
    // `REQUIRE_COLUMN_IN_EVERY_DATASET` is documented as the thing to flip when the producer
    // supports partial carriage. If the behaviour did not actually read it, that note would be
    // an instruction that does nothing — the "declared but not honoured" shape this tree
    // refuses elsewhere. Asserted by tying the constant to the observable outcome.
    const three = [
      dataset('ds-a'), dataset('ds-b'), dataset('ds-c'),
      column('ds-a', 'label_col', { kind: 'categorical', n_levels: 3 }),
      column('ds-b', 'label_col', { kind: 'categorical', n_levels: 3 }),
      column('ds-c', 'other', { kind: 'categorical', n_levels: 2 }),
    ]
    const offered = resolveCompatibleColumns(three, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b', 'ds-c'])
      .options.map(o => o.value)
    // The LINKAGE — behaviour follows the constant, whatever it is set to. This half stays
    // green through the future relaxation and is what proves the constant is a switch.
    expect(offered.includes('label_col')).toBe(!REQUIRE_COLUMN_IN_EVERY_DATASET)
    // TODAY'S VALUE, pinned separately and ON PURPOSE. Flipping the constant turns this red,
    // and that red is EXPECTED, not a regression: it is what makes the relaxation deliberate.
    //
    // WHEN THE PRODUCER SUPPORTS PARTIAL CARRIAGE, update exactly two things and nothing else:
    //   1. this expectation, and
    //   2. the `H4 — a column carried by SOME of three datasets is not offerable` test, which
    //      inverts (it becomes offerable).
    // Stage 1 has pinned the matching refusal with the same note, so both sides relax in ONE
    // change or the form and the compute disagree again — in the other direction.
    expect(
      REQUIRE_COLUMN_IN_EVERY_DATASET,
      'the threshold was relaxed — see this test’s comment for the two expectations to update',
    ).toBe(true)
  })

  it('the POSITIVE control — a label pair carried by ALL of them IS offerable', () => {
    // Without this every assertion above is satisfied by an offer list that is always empty.
    const both = [
      dataset('ds-a'),
      dataset('ds-b'),
      column('ds-a', 'label_col', { kind: 'categorical', n_levels: 3 }),
      column('ds-b', 'label_col', { kind: 'categorical', n_levels: 3 }),
    ]
    const r = resolveCompatibleColumns(both, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b'])
    expect(r.options.map(o => o.value)).toContain('label_col')
  })

  it('an object-dtype label pair (stored `string`) is STILL offered — it is the primary case', () => {
    // `cyto_columns.write_metadata_column` routes object-dtype series through `t.string(...)`,
    // so the commonest real label column declares `string` and classifies `undecidable`. It is
    // a LABEL and must stay offerable; hiding it would remove most of what a user came to
    // align. (Whether the PRODUCER accepts a string-stored label is its own question and is
    // routed to the producer — this side must not pre-emptively drop it.)
    const strings = [
      dataset('ds-a'),
      dataset('ds-b'),
      column('ds-a', 'label_col', { kind: 'string' }),
      column('ds-b', 'label_col', { kind: 'string' }),
    ]
    const r = resolveCompatibleColumns(strings, { of: '$x', axis: 'rows' }, ['ds-a', 'ds-b'])
    expect(r.options.map(o => o.value)).toContain('label_col')
  })
})
