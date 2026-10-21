// TEST-32 (ITEM-24), TEST-33 (ITEM-25), TEST-34 (ITEM-26), the runtime half of TEST-35
// (ITEM-27) and the acceptance pin TEST-A19 (INV-19).
//
// The fixtures carry NO domain vocabulary — no entity name, no modality, no domain datatype.
// That is not decoration: DEC-12's whole instruction is that this seam serves the AXIS
// equivalent of a path that used to serve one domain, and a fixture spelling a real entry
// name would let an implementation that RECOGNISED that name pass, which is exactly the
// tautology INV-14 exists to rule out. The two axes here are `rows` and `entries`.

import { describe, expect, it, vi } from 'vitest'

import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  DEFAULT_ENTRY_VALUE_NAME,
  ENTRY_BROWSE_MAX,
  EntryValueNameCollision,
  entryBrowseStrategy,
  narrowToOne,
  readEntryValuesFrame,
  resolveAxisEntries,
  resolveEntryAxes,
  resolveEntryAxis,
  resolveEntrySources,
  type EntryAxis,
  type EntrySource,
} from './axisEntries'
import { resolveRowSpaceAnchor } from './axisSource'

const ROW_HASH = 'r'.repeat(64)
const ENTRY_HASH = 'e'.repeat(64)
const OTHER_ENTRY_HASH = 'o'.repeat(64)
const ROW_DIGEST = 'digest-rows'
const DATASET = 'ds-1'

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: 'x',
    project_id: 'p',
    datatype: 'demo/thing',
    structure: {},
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: DATASET,
    ...over,
  }
}

/** A key artifact — the thing that IS an axis. Its `content_hash` is the identity the catalog
 *  publishes as an `AxisSummary`; its `key_sequence_digest` is what an ALIGNED artifact
 *  declares. Two namespaces, spelled apart so an implementation comparing the wrong pair
 *  fails. */
function keyArtifact(id: string, hash: string, axis: string, digest?: string): ArtifactRow {
  return row({
    id,
    content_hash: hash,
    datatype: 'demo/key',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      key: 'values',
      columns: [{ name: 'values', kind: 'string' }],
      ...(digest ? { key_sequence_digest: digest } : {}),
    },
  })
}

/** An artifact indexed BY the entry axis — the shape an entry's values live in. */
function carrier(id: string, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return row({
    id,
    datatype: 'demo/matrix',
    meta: { name: id },
    structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'entries'], aligned_to: ROW_DIGEST },
    ...over,
  })
}

const summary = (hash: string, name: string, length: number): AxisSummary => ({
  content_hash: hash,
  name,
  length,
})

const ROWS_AXIS = keyArtifact('k-rows', ROW_HASH, 'rows', ROW_DIGEST)
const ENTRY_AXIS = keyArtifact('k-entries', ENTRY_HASH, 'entries')
const AXES = [summary(ROW_HASH, 'rows', 500), summary(ENTRY_HASH, 'entries', 12)]

const ENTRY_KEYS = ['k0', 'k1', 'k2']
const readKeys = async (): Promise<readonly string[]> => ENTRY_KEYS

describe('resolveEntryAxis (ITEM-24) — which axis, within the anchored row space', () => {
  it('resolves the sibling axis by its declared label, and reports its DECLARED length', () => {
    const res = resolveEntryAxis([ROWS_AXIS, ENTRY_AXIS], AXES, ROW_HASH, 'entries')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.axis.artifact).toBe('k-entries')
    expect(res.axis.contentHash).toBe(ENTRY_HASH)
    // From the AxisSummary the producer declared — never counted by reading (INV-11).
    expect(res.axis.length).toBe(12)
  })

  it('is `no_anchor` while the anchor is unresolved — never a project-wide fallback (INV-4)', () => {
    expect(resolveEntryAxis([ROWS_AXIS, ENTRY_AXIS], AXES, null, 'entries')).toMatchObject({
      ok: false,
      because: 'no_anchor',
    })
    expect(resolveEntryAxis([ROWS_AXIS, ENTRY_AXIS], AXES, 'nope', 'entries')).toMatchObject({
      ok: false,
      because: 'no_anchor',
    })
  })

  it('says `no_such_axis` rather than offering another label', () => {
    expect(resolveEntryAxis([ROWS_AXIS, ENTRY_AXIS], AXES, ROW_HASH, 'absent')).toMatchObject({
      ok: false,
      because: 'no_such_axis',
    })
  })

  it('REFUSES an ambiguous label instead of taking the first (INV-3)', () => {
    const second = keyArtifact('k-entries-2', OTHER_ENTRY_HASH, 'entries')
    const res = resolveEntryAxis(
      [ROWS_AXIS, ENTRY_AXIS, second],
      [...AXES, summary(OTHER_ENTRY_HASH, 'entries', 9)],
      ROW_HASH,
      'entries',
    )
    expect(res).toMatchObject({ ok: false, because: 'ambiguous', candidates: 2 })
  })

  // ── TEST-16 (ITEM-11c) — two ROWS, one HASH: determinism, not refusal ────────────────────
  //
  // The `ambiguous` guard above counts distinct content HASHES; the pick was over `matches`,
  // which holds artifact ROWS. Two rows can carry one hash (the same axis registered twice —
  // re-imported, or copied between datasets), and those two rows reached `matches[0]`, so the
  // resolved `axis.artifact` was whichever the catalog listed first.
  //
  // The READ is correct either way — one content hash means byte-identical artifacts — so this
  // is not a data defect and must NOT become a refusal. But `axis.artifact` is a picker KEY and
  // a stored-choice target, so it has to be the same across two reads of the same catalog.
  it('TEST-16: two rows sharing ONE content hash resolve deterministically, and still resolve', () => {
    const twin = { ...ENTRY_AXIS, id: 'k-entries-twin' }
    const forwards = resolveEntryAxis([ROWS_AXIS, ENTRY_AXIS, twin], AXES, ROW_HASH, 'entries')
    const backwards = resolveEntryAxis([ROWS_AXIS, twin, ENTRY_AXIS], AXES, ROW_HASH, 'entries')
    // Still RESOLVES — one hash is one axis, so refusing would break a working surface.
    expect(forwards.ok, 'one content hash is one axis — this must not become `ambiguous`').toBe(true)
    expect(backwards.ok).toBe(true)
    if (!forwards.ok || !backwards.ok) return
    // Catalog order must not decide which artifact id the picker keys on.
    expect(backwards.axis.artifact).toBe(forwards.axis.artifact)
    expect(forwards.axis.artifact).toBe('k-entries')
    // …and the rest of the axis is the same answer it always was.
    expect(forwards.axis.contentHash).toBe(ENTRY_HASH)
    expect(forwards.axis.length).toBe(12)
  })

  it('does not treat a NON-key artifact on the axis as the axis', () => {
    // Same label, same dataset — but the server never published it as an axis, so it is not
    // a key artifact. Membership of the catalog's `axes` list IS the predicate.
    const impostor = row({ id: 'not-a-key', content_hash: 'z'.repeat(64), structure: { axis: 'entries' } })
    expect(resolveEntryAxis([ROWS_AXIS, impostor], AXES, ROW_HASH, 'entries')).toMatchObject({
      ok: false,
      because: 'no_such_axis',
    })
  })

  it('does not reach into ANOTHER dataset for a same-labelled axis', () => {
    const elsewhere = keyArtifact('k-elsewhere', OTHER_ENTRY_HASH, 'entries')
    const foreign = { ...elsewhere, source_dataset_id: 'ds-2' }
    expect(
      resolveEntryAxis(
        [ROWS_AXIS, foreign],
        [...AXES, summary(OTHER_ENTRY_HASH, 'entries', 9)],
        ROW_HASH,
        'entries',
      ),
    ).toMatchObject({ ok: false, because: 'no_such_axis' })
  })
})

describe('resolveAxisEntries (ITEM-25) — the ENGINE picks the read strategy', () => {
  it('lists the entries under the browse budget, reading the key column ONCE', async () => {
    const read = vi.fn(readKeys)
    const res = await resolveAxisEntries([ROWS_AXIS, ENTRY_AXIS], AXES, { axis: 'entries' }, [ROW_HASH], read)
    expect(res).toMatchObject({ browsable: true, anchored: true, length: 12, refusal: null })
    expect(res.entries).toEqual(ENTRY_KEYS)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('REFUSES the browse list above the budget, and does NOT read a truncated first N', async () => {
    const big = [summary(ROW_HASH, 'rows', 500), summary(ENTRY_HASH, 'entries', ENTRY_BROWSE_MAX + 1)]
    const read = vi.fn(readKeys)
    const res = await resolveAxisEntries([ROWS_AXIS, ENTRY_AXIS], big, { axis: 'entries' }, [ROW_HASH], read)
    expect(res.browsable).toBe(false)
    expect(res.entries).toEqual([]) // NOT the first N — a truncated list is `[0]` in better clothes
    expect(read).not.toHaveBeenCalled()
    // The size IS the reason, so the refusal states it.
    expect(res.refusal).toContain((ENTRY_BROWSE_MAX + 1).toLocaleString())
  })

  it('reads NOTHING when the axis does not resolve, and says WHICH absence it is', async () => {
    const read = vi.fn(readKeys)
    const none = await resolveAxisEntries([ROWS_AXIS, ENTRY_AXIS], AXES, { axis: 'entries' }, null, read)
    expect(none).toMatchObject({ anchored: false, browsable: false, refusal: null, length: 0 })
    const absent = await resolveAxisEntries([ROWS_AXIS, ENTRY_AXIS], AXES, { axis: 'absent' }, [ROW_HASH], read)
    expect(absent.anchored).toBe(true)
    expect(absent.refusal).toContain('no absent axis')
    expect(read).not.toHaveBeenCalled()
  })

  it('the refusal promises NO control — it used to say "type an exact key", and there is none', async () => {
    // Defect B (ledger 28). The section renders an `alert` and an `entry_list`, and the
    // entry_list's search box renders only in its NON-empty branch — so on precisely this
    // state the sentence directed the reader at a control that did not exist on the surface
    // saying it. The exact-key path is not merely unbuilt: a plot of an entry is addressed by
    // its POSITION on the axis (`readOneEntryColumn` windows a `sparse_csc` `indptr` by it and
    // `column_values` falls back to `position ?? 0`), and the only key→position answer that
    // exists is reading the WHOLE key column — the read this refusal exists to prevent. So the
    // sentence must instruct nothing until an engine-side targeted lookup exists.
    const big = [summary(ROW_HASH, 'rows', 500), summary(ENTRY_HASH, 'entries', 4_100_000)]
    const res = await resolveAxisEntries([ROWS_AXIS, ENTRY_AXIS], big, { axis: 'entries' }, [ROW_HASH], vi.fn(readKeys))
    const refusal = res.refusal ?? ''
    expect(refusal).toContain((4_100_000).toLocaleString()) // the size is still the reason
    // No imperative aimed at an affordance this state does not offer.
    expect(refusal).not.toMatch(/\b(type|enter|paste|search for|choose|pick)\b/i)
    // …and the POSITIVE half of the same contract, which the negative alone does not carry: the
    // sentence must say what was NOT done with the rest. Reduced to "This axis has 4,100,000
    // entries." it still passes every assertion above, and a reader cannot tell a deliberate
    // refusal from a list that failed to load — which is the whole reason the clause is there.
    expect(refusal).toMatch(/rather than/i)
    expect(refusal.length).toBeGreaterThan(80)
  })

  it('puts the boundary exactly at the constant, in both directions', () => {
    expect(entryBrowseStrategy(ENTRY_BROWSE_MAX)).toBe('browse')
    expect(entryBrowseStrategy(ENTRY_BROWSE_MAX + 1)).toBe('exact')
  })
})

describe('resolveEntrySources (ITEM-26) — ONE entry, N sources (DEC-12/INV-19)', () => {
  const axis: EntryAxis = { artifact: 'k-entries', contentHash: ENTRY_HASH, label: 'entries', length: 12, structure: {} }
  const anchor = resolveRowSpaceAnchor([ROWS_AXIS], [ROW_HASH])
  const raw = carrier('m-raw')
  const norm = carrier('m-norm')

  it('answers a MAP to an ARRAY, and never flattens it', () => {
    const out = resolveEntrySources([ROWS_AXIS, raw, norm], [axis], anchor, ['k1'], {})
    expect(Object.keys(out)).toEqual(['k1'])
    expect(out.k1).toHaveLength(2)
    // `(artifact, selector)` is the identity — the title is display only (INV-1).
    expect(out.k1.map(s => s.artifact).sort()).toEqual(['m-norm', 'm-raw'])
    expect(out.k1.every(s => s.selector === 'k1')).toBe(true)
  })

  it('keeps a CHOSEN entry that resolved to ZERO sources as a key (U1)', () => {
    const out = resolveEntrySources([ROWS_AXIS], [axis], anchor, ['k1'], {})
    expect(out).toEqual({ k1: [] })
  })

  it('drops a candidate aligned to a DIFFERENT row space (A2), and marks nothing', () => {
    const foreign = carrier('m-foreign', {
      structure: {
        encoding: 'zarr_v3',
        kind: 'sparse_csc',
        axes: ['rows', 'entries'],
        aligned_to: 'digest-somewhere-else',
      },
    })
    const out = resolveEntrySources([ROWS_AXIS, raw, foreign], [axis], anchor, ['k1'], {})
    expect(out.k1.map(s => s.artifact)).toEqual(['m-raw'])
  })

  it('narrows by the view\'s declared datatype and excludes, and never by a name', () => {
    const other = carrier('m-other', { datatype: 'demo/other' })
    const out = resolveEntrySources([ROWS_AXIS, raw, other], [axis], anchor, ['k1'], {
      datatype: 'demo/matrix',
    })
    expect(out.k1.map(s => s.artifact)).toEqual(['m-raw'])
  })

  it('names each column from the VIEW\'s template, per (entry, source)', () => {
    const out = resolveEntrySources([ROWS_AXIS, raw, norm], [axis], anchor, ['k1'], {
      name: DEFAULT_ENTRY_VALUE_NAME,
    })
    expect(out.k1.map(s => s.name).sort()).toEqual(['k1 · m-norm', 'k1 · m-raw'])
  })

  it('makes a name COLLISION a load error naming BOTH sources, never a silent overwrite', () => {
    let thrown: unknown
    try {
      resolveEntrySources([ROWS_AXIS, raw, norm], [axis], anchor, ['k1'], { name: '{entry}' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(EntryValueNameCollision)
    const message = String((thrown as Error).message)
    expect(message).toContain('m-raw')
    expect(message).toContain('m-norm')
  })

  it('does not offer the entry axis\'s own key artifact as a source of its entries', () => {
    const out = resolveEntrySources([ROWS_AXIS, ENTRY_AXIS], [axis], anchor, ['k1'], {})
    expect(out.k1).toEqual([])
  })
})

describe('narrowToOne (ITEM-27) — the `one` disposition', () => {
  const source = (over: Partial<EntrySource>): EntrySource => ({
    artifact: 'a',
    selector: 'k1',
    datatype: 'demo/matrix',
    title: 'a',
    name: 'a',
    ...over,
  })

  it('takes the single match', () => {
    const only = source({ artifact: 'm-raw' })
    expect(narrowToOne([only, source({ artifact: 'm-norm', datatype: 'demo/other' })], {
      datatype: 'demo/matrix',
    }).source).toBe(only)
  })

  it('REFUSES ≠ 1 match, in both directions, and says which — never a first match', () => {
    const two = [source({ artifact: 'm-raw' }), source({ artifact: 'm-norm' })]
    const many = narrowToOne(two, { datatype: 'demo/matrix' })
    expect(many.source).toBeUndefined()
    expect(many.refusal).toContain('2 columns')
    const none = narrowToOne(two, { datatype: 'demo/absent' })
    expect(none.source).toBeUndefined()
    expect(none.refusal).toContain('No column')
  })
})

describe('readEntryValuesFrame (ITEM-26) — the columnar arm', () => {
  const src = (name: string, selector: string): EntrySource => ({
    artifact: `m-${name}`,
    selector,
    datatype: 'demo/matrix',
    title: name,
    name,
    ...{},
  })

  it('lands one column per (entry, source) under the declared name, addressed by POSITION', async () => {
    const read = vi.fn(async (_s: EntrySource, at: readonly number[]) => at.flatMap(i => [i, i, i]))
    const frame = await readEntryValuesFrame(
      { k1: [src('one', 'k1')], k2: [src('two', 'k2')] },
      entry => ENTRY_KEYS.indexOf(entry),
      read,
    )
    expect(frame).toEqual({ one: [1, 1, 1], two: [2, 2, 2] })
  })

  it('SKIPS an entry it cannot position rather than guessing an index', async () => {
    const read = vi.fn(async () => [0])
    const frame = await readEntryValuesFrame({ zz: [src('one', 'zz')] }, () => undefined, read)
    expect(frame).toEqual({})
    expect(read).not.toHaveBeenCalled()
  })

  it('costs a failing source its own column, not the frame', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const read = vi.fn(async (s: EntrySource) => {
      if (s.name === 'one') throw new Error('nope')
      return [1]
    })
    const frame = await readEntryValuesFrame(
      { k1: [src('one', 'k1'), src('two', 'k1')] },
      () => 0,
      read,
    )
    expect(frame).toEqual({ two: [1] })
    spy.mockRestore()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CORRESPONDENCE (dimension-membership ITEM-19) — INV-6, at the resolver tier
//
// An INTEGRATED coordinate rests on TWO row-space axes. The sibling labelled `entries` therefore
// exists ONCE PER ROW SPACE, and one logical entry is described by ds1's carrier at index *i* and
// ds2's at index *j*, with i ≠ j. Everything below is about keeping those two indices apart:
// a resolver that answers ONE sibling, ONE candidate list or ONE position map produces a
// full-length, well-typed column that is wrong for every row of the second side.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const ROW_HASH_2 = 's'.repeat(64)
const ENTRY_HASH_2 = 'f'.repeat(64)
const ROW_DIGEST_2 = 'digest-rows-2'
const DATASET_2 = 'ds-2'

/** The SECOND dataset's row axis + sibling axis. Distinct hashes, distinct digests, distinct
 *  source dataset — the join below has to work on the declarations and on nothing else. */
const ROWS_AXIS_2 = row({
  ...keyArtifact('k-rows-2', ROW_HASH_2, 'rows', ROW_DIGEST_2),
  source_dataset_id: DATASET_2,
})
const ENTRY_AXIS_2 = row({
  ...keyArtifact('k-entries-2', ENTRY_HASH_2, 'entries'),
  source_dataset_id: DATASET_2,
})
const AXES_2 = [
  ...AXES,
  summary(ROW_HASH_2, 'rows', 400),
  summary(ENTRY_HASH_2, 'entries', 12),
]

/** A carrier belonging to the SECOND dataset, aligned to its own row axis. */
function carrier2(id: string, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return carrier(id, {
    source_dataset_id: DATASET_2,
    structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'entries'], aligned_to: ROW_DIGEST_2 },
    ...over,
  })
}

const INTEGRATED = [ROWS_AXIS, ENTRY_AXIS, ROWS_AXIS_2, ENTRY_AXIS_2]

describe('resolveEntryAxes (ITEM-19) — ONE sibling per row space, not one refusal', () => {
  it('answers a sibling PER anchored row space, each remembering which row space it came from', () => {
    const res = resolveEntryAxes(INTEGRATED, AXES_2, [ROW_HASH, ROW_HASH_2], 'entries')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // TWO siblings. A scalar resolver answers one — and a scalar resolver handed the integrated
    // COORDINATE's own hash answers `ambiguous`, which is why this had to go plural rather than
    // have its refusal relaxed.
    expect(res.axes.map(a => a.artifact)).toEqual(['k-entries', 'k-entries-2'])
    // …and each carries its ROW SPACE, which is what the membership is later joined back on.
    // Without it the two sides are indistinguishable and the gather cannot say which of the
    // coordinate's rows either contributes.
    expect(res.axes.map(a => a.rowSpace)).toEqual([ROW_HASH, ROW_HASH_2])
  })

  it('preserves the order it was ASKED in — it does not sort the sides', () => {
    const res = resolveEntryAxes(INTEGRATED, AXES_2, [ROW_HASH_2, ROW_HASH], 'entries')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.axes.map(a => a.artifact)).toEqual(['k-entries-2', 'k-entries'])
  })

  it('is ALL OR NOTHING — one row space without a sibling refuses the whole answer', () => {
    // ds2 has a row axis and NO sibling labelled `entries`. Resolving on the one that did would
    // describe half the coordinate's rows and lay the values against all of them.
    const partial = [ROWS_AXIS, ENTRY_AXIS, ROWS_AXIS_2]
    const res = resolveEntryAxes(partial, AXES_2, [ROW_HASH, ROW_HASH_2], 'entries')
    expect(res).toMatchObject({ ok: false, because: 'no_such_axis' })
    // …and the positive control that says the fixture is not simply broken: the SAME corpus
    // resolves fine when only the row space that HAS a sibling is anchored.
    expect(resolveEntryAxes(partial, AXES_2, [ROW_HASH], 'entries').ok).toBe(true)
  })

  it('an empty or absent anchor list is `no_anchor`, never a project-wide fallback (INV-4)', () => {
    expect(resolveEntryAxes(INTEGRATED, AXES_2, [], 'entries')).toMatchObject({ because: 'no_anchor' })
    expect(resolveEntryAxes(INTEGRATED, AXES_2, undefined, 'entries')).toMatchObject({ because: 'no_anchor' })
  })
})

describe('resolveAxisEntries (ITEM-19) — a plural list is the CORRESPONDENCE`s domain', () => {
  it('lists only the entries present on EVERY side, in the first side`s order', async () => {
    const perAxis = async (axis: EntryAxis): Promise<readonly string[]> =>
      axis.artifact === 'k-entries' ? ['k0', 'k1', 'k2'] : ['k2', 'k1', 'kX']
    const res = await resolveAxisEntries(INTEGRATED, AXES_2, { axis: 'entries' }, [ROW_HASH, ROW_HASH_2], perAxis)
    // `k0` is only on side A and `kX` only on side B: neither has a pair, so neither can be read
    // across the coordinate's whole row sequence. The ORDER is the first side's, not the
    // second's and not sorted — the second side lists `k2` before `k1`.
    expect(res.entries).toEqual(['k1', 'k2'])
    expect(res.browsable).toBe(true)
    // …and `length` is the correspondence's size, because no producer declared this number.
    expect(res.length).toBe(2)
  })

  it('one side is UNCHANGED — the same entries and the DECLARED length, not the read one', async () => {
    const res = await resolveAxisEntries(INTEGRATED, AXES_2, { axis: 'entries' }, [ROW_HASH], readKeys)
    expect(res.entries).toEqual(ENTRY_KEYS)
    // 12 is the producer's `AxisSummary.length`; the read returned 3. The scalar case must keep
    // reporting the declaration (INV-11), so this is asserted against the number that differs.
    expect(res.length).toBe(12)
  })
})

describe('resolveEntrySources (ITEM-19) — sources are PAIRED across the row spaces', () => {
  const anchor2 = resolveRowSpaceAnchor([ROWS_AXIS, ROWS_AXIS_2], [ROW_HASH, ROW_HASH_2])
  const axes2 = (): readonly EntryAxis[] => {
    const res = resolveEntryAxes(INTEGRATED, AXES_2, [ROW_HASH, ROW_HASH_2], 'entries')
    if (!res.ok) throw new Error('fixture: the two siblings must resolve')
    return res.axes
  }

  it('pairs the two datasets` same-kind, same-named carriers into ONE source', () => {
    const a = carrier('m-raw-a', { meta: { name: 'raw' } })
    const b = carrier2('m-raw-b', { meta: { name: 'raw' } })
    const out = resolveEntrySources([...INTEGRATED, a, b], axes2(), anchor2, ['k1'], {})
    // ONE offer, not two. Two would present the reader with a choice between two halves of one
    // column, each covering rows the other does not.
    expect(out.k1).toHaveLength(1)
    const source = out.k1.reduce(first => first)
    // The PRIMARY is the side of the FIRST row space named — a stated choice, and it is what a
    // stored pick round-trips as. The other side is resolved from `pairs`, never parsed out of it.
    expect(source.artifact).toBe('m-raw-a')
    expect(source.pairs?.map(p => p.artifact)).toEqual(['m-raw-a', 'm-raw-b'])
    expect(source.pairs?.map(p => p.rowSpace)).toEqual([ROW_HASH, ROW_HASH_2])
    expect(source.pairs?.map(p => p.entryAxis)).toEqual([ENTRY_HASH, ENTRY_HASH_2])
  })

  it('DROPS an unpaired carrier — a source covering one row space is not offered', () => {
    const a = carrier('m-raw-a', { meta: { name: 'raw' } })
    const b = carrier2('m-raw-b', { meta: { name: 'raw' } })
    const lonely = carrier('m-lonely', { meta: { name: 'lonely' } })
    const out = resolveEntrySources([...INTEGRATED, a, b, lonely], axes2(), anchor2, ['k1'], {})
    // `m-lonely` describes only ds1's rows. Offering it would offer a column that can only be
    // laid against part of the coordinate — and there is no honest filler for the rest, because
    // a zero is a confident claim that the entry is absent there.
    expect(out.k1.map(s => s.artifact)).toEqual(['m-raw-a'])
    // …and the entry whose EVERY carrier is unpaired resolves to `[]` — the U1 state the entry
    // list renders as "chosen and unresolved", which is a visible absence rather than a drop.
    const onlyLonely = resolveEntrySources([...INTEGRATED, lonely], axes2(), anchor2, ['k1'], {})
    expect(onlyLonely).toEqual({ k1: [] })
  })

  it('refuses to pair when one side has TWO candidates under the same declaration', () => {
    const a = carrier('m-raw-a', { meta: { name: 'raw' } })
    const a2 = carrier('m-raw-a2', { meta: { name: 'raw' } })
    const b = carrier2('m-raw-b', { meta: { name: 'raw' } })
    const out = resolveEntrySources([...INTEGRATED, a, a2, b], axes2(), anchor2, ['k1'], {})
    // Picking either of ds1's two is `[0]` with a join wrapped round it, and the two are not
    // interchangeable — they are two artifacts.
    expect(out.k1).toEqual([])
  })

  it('the SINGLE-axis case is untouched — two same-named carriers stay TWO offers', () => {
    // The guard that says the pairing rule may not reach a pane that has one row space: grouping
    // by (datatype, title) there would FOLD these two into one ambiguous group and drop both,
    // deleting offers from every existing pane.
    const anchor = resolveRowSpaceAnchor([ROWS_AXIS], [ROW_HASH])
    const one = resolveEntryAxes(INTEGRATED, AXES_2, [ROW_HASH], 'entries')
    expect(one.ok).toBe(true)
    if (!one.ok) return
    const twins = [carrier('m-a', { meta: { name: 'same' } }), carrier('m-b', { meta: { name: 'same' } })]
    // A distinguishing `name`, because two same-titled sources collide on the DEFAULT template
    // by design — that pre-existing refusal is not what this case is about.
    const out = resolveEntrySources([...INTEGRATED, ...twins], one.axes, anchor, ['k1'], {
      name: '{entry} · {source.artifact}',
    })
    expect(out.k1.map(s => s.artifact).sort()).toEqual(['m-a', 'm-b'])
    expect(out.k1.every(s => s.pairs === undefined)).toBe(true)
  })
})

describe('readEntryValuesFrame (ITEM-19) — each side is positioned on its OWN axis', () => {
  const src = (name: string, selector: string, pairs?: EntrySource['pairs']): EntrySource => ({
    artifact: 'm-a',
    selector,
    datatype: 'demo/matrix',
    title: 'm-a',
    name,
    ...(pairs ? { pairs } : {}),
  })
  const PAIRS = [
    { artifact: 'm-a', entryAxis: ENTRY_HASH, rowSpace: ROW_HASH },
    { artifact: 'm-b', entryAxis: ENTRY_HASH_2, rowSpace: ROW_HASH_2 },
  ]
  /** The SAME entry at DIFFERENT indices on the two axes — which is the whole of INV-6, and what
   *  makes an index-identity implementation distinguishable from a correspondence. */
  const POSITION: Record<string, Record<string, number>> = {
    [ENTRY_HASH]: { k1: 1 },
    [ENTRY_HASH_2]: { k1: 7 },
  }

  it('passes ONE POSITION PER SIDE, each looked up on that side`s axis', async () => {
    const read = vi.fn(async (_s: EntrySource, at: readonly number[]) => [...at])
    const frame = await readEntryValuesFrame(
      { k1: [src('one', 'k1', PAIRS)] },
      (entry, entryAxis) => (entryAxis ? POSITION[entryAxis]?.[entry] : undefined),
      read,
    )
    // 1 and 7 — not [1,1] and not [7,7]. Both of those are full-length and well typed.
    expect(frame).toEqual({ one: [1, 7] })
  })

  it('SKIPS the whole source when ANY side cannot be positioned — never the sides that could', async () => {
    const read = vi.fn(async () => [0])
    const frame = await readEntryValuesFrame(
      { k1: [src('one', 'k1', PAIRS)] },
      (entry, entryAxis) => (entryAxis === ENTRY_HASH ? POSITION[ENTRY_HASH][entry] : undefined),
      read,
    )
    // Reading only the side that positioned would answer a SHORTER column, which every consumer
    // treats as index-parallel with the coordinate's rows and which is not.
    expect(frame).toEqual({})
    expect(read).not.toHaveBeenCalled()
  })

  it('the UNPAIRED source asks with no axis — the scalar lookup, unchanged', async () => {
    const seen: Array<string | undefined> = []
    const read = vi.fn(async (_s: EntrySource, at: readonly number[]) => [...at])
    const frame = await readEntryValuesFrame(
      { k1: [src('one', 'k1')] },
      (_entry, entryAxis) => {
        seen.push(entryAxis)
        return 3
      },
      read,
    )
    expect(frame).toEqual({ one: [3] })
    expect(seen).toEqual([undefined])
  })
})
