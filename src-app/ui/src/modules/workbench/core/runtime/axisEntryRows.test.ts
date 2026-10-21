// TEST-62 / TEST-64 / TEST-67 / TEST-68 / TEST-A16 (ITEM-47 … ITEM-58) — the ENTRY-ROW
// resolver.
//
// Every display rule this section has lives here rather than in the widget, for the reason
// `row_space_columns` gives for the same split: a row on its own cannot answer "is my name
// contested?", "is one group a grouping?" or "which annotation did the search hit?" — those are
// facts about the whole offer, and the engine is the only party that sees it. So they are
// tested here, against plain arrays, with no catalog and no DOM.
//
// The fixture is deliberately VOCABULARY-FREE (TEST-A16 / INV-16): the grouping column is named
// something arbitrary and its values are not modalities, so any code that "knows what a modality
// is" fails these tests rather than passing them by coincidence.

import { describe, it, expect } from 'vitest'
import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { resolveRowSpaceAnchor } from './axisSource'
import { resolveEntryAxis, type EntryAxis } from './axisEntries'
import {
  DEFAULT_KEY_TITLE,
  NO_AXIS_ENTRY_ROWS,
  NO_ENTRY_SOURCES_REFUSAL,
  ambiguousGroupingRefusal,
  declaresGroupsEntries,
  defaultShowNote,
  describeEntryRows,
  entryAnnotationCandidates,
  entryAnnotationOptions,
  entryDistinguisher,
  groupsOf,
  missingNoteFor,
  resolveAxisEntryRows,
  resolveGroupingColumn,
  resolveKeyLabel,
  type EntryAnnotation,
} from './axisEntryRows'
import { NO_COORDINATE_REFUSAL } from './rowSpaceColumns'

// ── the fixture ────────────────────────────────────────────────────────────────────────

const ROW_DIGEST = 'digest-of-the-row-space'
const ROW_HASH = 'hash-rows'
const ENTRY_HASH = 'hash-entries'
const ENTRY_AXIS_LABEL = 'items'
/** The fixture's own datatype ids. Invented, because this resolver knows no datatypes: it
 *  applies the VIEW's declared filter and reports what passed. */
const ANNOTATION_TYPE = 'a-column-type'

function row(over: Partial<ArtifactRow> & { id: string }): ArtifactRow {
  return {
    datatype: ANNOTATION_TYPE,
    content_hash: null,
    created_at: '2026-01-01T00:00:00Z',
    meta: {},
    structure: {},
    ...over,
  } as unknown as ArtifactRow
}

/** A 1-D column declaring `axis`, with ONE member of the given encoding. */
function column(id: string, name: string, kind: string, over: Record<string, unknown> = {}): ArtifactRow {
  return row({
    id,
    meta: { name, ...((over.meta as Record<string, unknown>) ?? {}) },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ENTRY_AXIS_LABEL,
      columns: [{ path: 'values', name: 'values', kind }],
      ...((over.structure as Record<string, unknown>) ?? {}),
    },
  })
}

const KEY_ARTIFACT = row({
  id: 'a-entry-keys',
  content_hash: ENTRY_HASH,
  meta: { name: 'entry keys', is_axis_index: true },
  structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTRY_AXIS_LABEL, columns: [{ path: 'values', kind: 'string' }] },
})

const AXIS: EntryAxis = {
  artifact: KEY_ARTIFACT.id,
  contentHash: ENTRY_HASH,
  label: ENTRY_AXIS_LABEL,
  length: 4,
  structure: KEY_ARTIFACT.structure,
}

const KEYS = ['k-1', 'k-2', 'k-3', 'k-4']

/** The two ANNOTATIONS. `alpha` is an ordinary display name; `pool` DECLARES that it groups. */
const ALPHA = column('a-alpha', 'Alpha', 'string')
const POOL = column('a-pool', 'Pool', 'categorical', { meta: { groups_entries: true } })
const ALPHA_VALUES = ['one', 'shared', '', 'shared']
const POOL_VALUES = ['left', 'left', 'right', 'right']

const ANNOTATIONS: EntryAnnotation[] = [
  { value: ALPHA.id, label: 'Alpha', is_key: false, groups: false },
  { value: AXIS.artifact, label: 'Key', is_key: true, groups: false },
  { value: POOL.id, label: 'Pool', is_key: false, groups: true },
]

const VALUES = new Map<string, readonly string[]>([
  [ALPHA.id, ALPHA_VALUES],
  [POOL.id, POOL_VALUES],
])

// ── ITEM-53 / DEC-6: the column DECLARES itself ────────────────────────────────────────

describe('`meta.groups_entries` is a DECLARATION, not a naming convention (ITEM-53)', () => {
  it('accepts `true` and NOTHING else', () => {
    expect(declaresGroupsEntries({ groups_entries: true })).toBe(true)
    for (const meta of [null, undefined, {}, { groups_entries: false }, { groups_entries: 'true' }, { groups_entries: 1 }, { name: 'pool' }]) {
      expect(declaresGroupsEntries(meta), JSON.stringify(meta)).toBe(false)
    }
  })

  it('resolves the ONE grouping column, and REFUSES two rather than taking the first', () => {
    expect(resolveGroupingColumn([ALPHA, POOL]).row?.id).toBe(POOL.id)
    expect(resolveGroupingColumn([ALPHA]).row).toBeUndefined()
    const second = column('a-pool-2', 'Batch', 'categorical', { meta: { groups_entries: true } })
    const both = resolveGroupingColumn([POOL, second])
    expect(both.row).toBeUndefined()
    // Naming BOTH, because the author is the one who can fix it — and never `[0]`.
    expect(both.refusal).toBe(ambiguousGroupingRefusal(['Pool', 'Batch']))
    expect(both.refusal).toContain('Pool')
    expect(both.refusal).toContain('Batch')
  })
})

// ── ITEM-47: an annotation is just a column on the entry axis ──────────────────────────

describe('the annotation candidates are enumerated by DECLARATION (ITEM-47)', () => {
  const catalog = [KEY_ARTIFACT, ALPHA, POOL]

  it('offers the axis-declaring TEXT columns and nothing else', () => {
    const numeric = column('a-score', 'Score', 'numeric')
    const elsewhere = row({
      id: 'a-other-axis',
      meta: { name: 'Other' },
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'somewhere-else', columns: [{ path: 'values', kind: 'string' }] },
    })
    const got = entryAnnotationCandidates([...catalog, numeric, elsewhere], AXIS, { datatype: ANNOTATION_TYPE })
    expect(got.map(c => c.id).sort()).toEqual([ALPHA.id, POOL.id])
  })

  it('never offers the KEY artifact as one of its own alternatives', () => {
    const got = entryAnnotationCandidates(catalog, AXIS, {})
    expect(got.map(c => c.id)).not.toContain(KEY_ARTIFACT.id)
  })
})

// ── ITEM-49: the default is the axis KEY, and the section SAYS so ──────────────────────

describe('the displayed-annotation default is the axis KEY (ITEM-49, TEST-62)', () => {
  it('puts the key FIRST, valued by the axis artifact and titled by the declared key_label', () => {
    const options = entryAnnotationOptions(AXIS, [POOL, ALPHA], { key_label: 'Item id' })
    expect(options[0]).toEqual({ value: AXIS.artifact, label: 'Item id', is_key: true, groups: false })
    // and the rest are stable by TITLE, not by catalog order
    expect(options.slice(1).map(o => o.label)).toEqual(['Alpha', 'Pool'])
  })

  it('falls back to a NEUTRAL title rather than inventing one from a column', () => {
    expect(entryAnnotationOptions(AXIS, [ALPHA], undefined)[0].label).toBe(DEFAULT_KEY_TITLE)
  })

  it('resolves `key_label` only when the project\'s datatypes AGREE about it', () => {
    const rows = [row({ id: 'x', datatype: 'type-a' }), row({ id: 'y', datatype: 'type-b' })]
    const agree = resolveKeyLabel(rows, ENTRY_AXIS_LABEL, () => [{ name: ENTRY_AXIS_LABEL, key_label: 'Item id' }])
    expect(agree).toBe('Item id')
    // Two datatypes declaring the same axis with two different labels is a genuine
    // disagreement, and picking one would be `[0]` over a declaration set.
    const disagree = resolveKeyLabel(rows, ENTRY_AXIS_LABEL, id =>
      id === 'type-a' ? [{ name: ENTRY_AXIS_LABEL, key_label: 'Item id' }] : [{ name: ENTRY_AXIS_LABEL, key_label: 'Thing id' }],
    )
    expect(disagree).toBeUndefined()
    expect(resolveKeyLabel(rows, ENTRY_AXIS_LABEL, () => undefined)).toBeUndefined()
  })
})

// ── ITEM-51 / ITEM-52 / ITEM-58: the three display rules ───────────────────────────────

describe('what one row READS as (ITEM-51 / ITEM-52 / ITEM-58, TEST-64 / TEST-67)', () => {
  const rows = () => describeEntryRows(KEYS, ANNOTATIONS, VALUES, { artifact: POOL.id }, null)

  it('an entry with NO value under the displayed annotation shows its KEY and says so', () => {
    const third = rows()[2]
    expect(third.label).toBe('k-3')
    expect(third.missing_note).toBe(missingNoteFor('Alpha'))
    // and NEVER a silent fallback to another annotation that DOES have a value here
    expect(third.label).not.toBe('right')
  })

  it('QUALIFIES only the CONTESTED name, and with the declared group', () => {
    const [first, second, third, fourth] = rows()
    expect(second.label).toBe('shared')
    expect(fourth.label).toBe('shared')
    expect(second.qualifier).toBe('left')
    expect(fourth.qualifier).toBe('right')
    // uncontested rows carry NO qualifier — "show a distinguisher only where there is
    // something to distinguish"
    expect(first.qualifier).toBeNull()
    expect(third.qualifier).toBeNull()
  })

  it('the PLOT TITLE always qualifies, including where the list does not', () => {
    const [first, second] = rows()
    expect(second.title).toBe('shared (left)')
    // the uncontested row's LIST entry has no qualifier and its TITLE does
    expect(first.qualifier).toBeNull()
    expect(first.title).toBe('one (left)')
  })

  it('carries EVERY annotation as the search corpus, displayed one first (ITEM-50)', () => {
    const second = rows()[1]
    expect(second.values.map(v => v.title)).toEqual(['Alpha', 'Key', 'Pool'])
    expect(second.values.map(v => v.value)).toEqual(['shared', 'k-2', 'left'])
  })

  it('stores the KEY as the identity, never the label (ITEM-57)', () => {
    expect(rows().map(r => r.key)).toEqual(KEYS)
  })

  it('with NO grouping column there is no group and no grouping', () => {
    const plain = describeEntryRows(KEYS, ANNOTATIONS, VALUES, undefined, null)
    expect(plain.map(r => r.group)).toEqual([null, null, null, null])
    expect(groupsOf(plain)).toEqual([])
  })

  it('the viewer resolves the grouping column by its declared ROLE only (TEST-A16, INV-16)', () => {
    // The grouping column is named "Pool" and its values are "left"/"right" — nothing in this
    // fixture is a modality, an assay or any other domain thing. Any code that recognised one
    // would produce different answers here.
    expect(groupsOf(rows())).toEqual([
      { name: 'left', count: 2 },
      { name: 'right', count: 2 },
    ])
  })
})

// ── ITEM-52 / ITEM-58 WITHOUT a grouping column — the OTHER half of "what if names are
//    not unique?" ────────────────────────────────────────────────────────────────────────
//
// A declared grouping column is ONE import path. On the ordinary one — nobody declared a
// grouping — the contest is exactly as real, and the group-only rule answered it with `null`:
// two byte-identical rows, and two emitted plots carrying one title. The ladder's rung below
// the declared group is the entry's own KEY, which every axis has.

describe('a contested name is distinguished with or WITHOUT a grouping column (ITEM-52 / ITEM-58)', () => {
  const ungrouped = () => describeEntryRows(KEYS, ANNOTATIONS, VALUES, undefined, null)

  it('qualifies the contested rows BY KEY when no column declares a grouping', () => {
    const [first, second, third, fourth] = ungrouped()
    // The two rows that read the same are told apart — by the identity each already carries.
    expect(second.label).toBe('shared')
    expect(fourth.label).toBe('shared')
    expect(second.qualifier).toBe('k-2')
    expect(fourth.qualifier).toBe('k-4')
    expect(second.qualifier).not.toBe(fourth.qualifier)
    // …and the contested-ONLY rule is untouched: an uncontested row is still bare, because a
    // list is scanned and a qualifier on every row is noise.
    expect(first.qualifier).toBeNull()
    expect(third.qualifier).toBeNull()
  })

  it('emits two DISTINGUISHABLE titles for the two rows that read the same', () => {
    const [first, second, third, fourth] = ungrouped()
    expect(second.title).toBe('shared (k-2)')
    expect(fourth.title).toBe('shared (k-4)')
    expect(second.title).not.toBe(fourth.title)
    // ALWAYS qualified, not contested-only: a title is read alone, and it must not go stale
    // when a same-named entry appears later.
    expect(first.title).toBe('one (k-1)')
    // …and the STUTTER is guarded: this row's displayed name has already fallen back to its
    // key (ITEM-51), so the label IS the identity and `k-3 (k-3)` would add a parenthesis and
    // no information.
    expect(third.label).toBe('k-3')
    expect(third.title).toBe('k-3')
    expect(third.qualifier).toBeNull()
  })

  it('never reaches for the storage-disambiguated index on either path (INV-15)', () => {
    for (const r of [...ungrouped(), ...describeEntryRows(KEYS, ANNOTATIONS, VALUES, { artifact: POOL.id }, null)]) {
      // The named wrong fix is the LABEL with a storage counter welded on (`shared-1`), and it
      // is one line away from looking helpful. Nothing here ever spells it.
      expect(r.title).not.toContain(`${r.label}-`)
      expect(r.qualifier ?? '').not.toContain(`${r.label}-`)
    }
  })

  it('walks the ladder one rung at a time, and skips a rung that IS the label', () => {
    // 1 — the DECLARED group outranks the key.
    expect(entryDistinguisher('shared', 'k-2', 'left')).toBe('left')
    // 2 — with no declaration, the key.
    expect(entryDistinguisher('shared', 'k-2', null)).toBe('k-2')
    // a blank group is not a declaration and falls through to the key.
    expect(entryDistinguisher('shared', 'k-2', '')).toBe('k-2')
    // 3 — a rung reading as the label already is SKIPPED rather than stuttered: displaying the
    // grouping column itself falls PAST the group to the key…
    expect(entryDistinguisher('left', 'k-2', 'left')).toBe('k-2')
    // …and a label that already IS the key has nothing below it, so it stops.
    expect(entryDistinguisher('k-3', 'k-3', null)).toBeNull()
  })

  it('falls PAST a group that reads as the label, so the row still says which entry it is', () => {
    // The header is on the GROUPING column itself, so every label equals its own group and the
    // old rule produced `left (left)` — a parenthesis carrying nothing, on every contested row.
    const byPool: EntryAnnotation[] = [ANNOTATIONS[2], ANNOTATIONS[1], ANNOTATIONS[0]]
    const rows = describeEntryRows(KEYS, byPool, VALUES, { artifact: POOL.id }, null)
    expect(rows.map(r => r.label)).toEqual(POOL_VALUES)
    expect(rows.map(r => r.qualifier)).toEqual(KEYS)
    expect(rows.map(r => r.title)).toEqual(['left (k-1)', 'left (k-2)', 'right (k-3)', 'right (k-4)'])
  })
})

// ── ITEM-48: the header governs DISPLAY only ───────────────────────────────────────────

describe('the `Show:` choice changes the NAME and nothing else (ITEM-48, TEST-61)', () => {
  it('changes every row\'s label while the keys, order and titles-of-record stay put', () => {
    const byAlpha = describeEntryRows(KEYS, ANNOTATIONS, VALUES, { artifact: POOL.id }, null)
    const reordered = [ANNOTATIONS[1], ANNOTATIONS[0], ANNOTATIONS[2]]
    const byKey = describeEntryRows(KEYS, reordered, VALUES, { artifact: POOL.id }, null)
    expect(byAlpha.map(r => r.label)).toEqual(['one', 'shared', 'k-3', 'shared'])
    expect(byKey.map(r => r.label)).toEqual(KEYS)
    // WHAT IS EMITTED does not move: the identity is the key on both.
    expect(byKey.map(r => r.key)).toEqual(byAlpha.map(r => r.key))
    // …and under the key nothing is contested, so the qualifiers stand down — the contest is a
    // fact about the DISPLAYED names, not about the entries.
    expect(byKey.map(r => r.qualifier)).toEqual([null, null, null, null])
  })
})

// ── the whole slice ────────────────────────────────────────────────────────────────────

describe('resolveAxisEntryRows — the whole answer, and what it costs (INV-11)', () => {
  const catalog = [KEY_ARTIFACT, ALPHA, POOL]
  const browsable = { entries: KEYS, length: 4, anchored: true, browsable: true, refusal: null }

  const reader = () => {
    const reads: string[] = []
    return {
      reads,
      read: async (r: ArtifactRow) => {
        reads.push(r.id)
        return (VALUES.get(r.id) ?? []) as readonly string[]
      },
    }
  }

  it('reads NOTHING when the axis did not resolve, and carries the emptiness through', async () => {
    const spy = reader()
    const got = await resolveAxisEntryRows(
      catalog,
      undefined,
      undefined,
      {},
      { entries: [], length: 0, anchored: false, browsable: false, refusal: null },
      undefined,
      spy.read,
    )
    expect(spy.reads).toEqual([])
    expect(got.rows).toEqual([])
    expect(got.anchored).toBe(false)
  })

  it('reads NOTHING on the refused (over-budget) arm, but still reports the LENGTH', async () => {
    const spy = reader()
    const got = await resolveAxisEntryRows(
      catalog,
      AXIS,
      undefined,
      {},
      { entries: [], length: 4_100_000, anchored: true, browsable: false, refusal: 'too many' },
      undefined,
      spy.read,
    )
    expect(spy.reads).toEqual([])
    expect(got.length).toBe(4_100_000)
    expect(got.refusal).toBe('too many')
    // the header still resolved, from declarations alone
    expect(got.annotations.map(a => a.label)).toEqual([DEFAULT_KEY_TITLE, 'Alpha', 'Pool'])
  })

  it('reads EVERY offered annotation on the browse arm — search matches all of them', async () => {
    const spy = reader()
    await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, undefined, spy.read)
    expect([...spy.reads].sort()).toEqual([ALPHA.id, POOL.id])
  })

  it('one unreadable annotation costs THAT annotation, not the list', async () => {
    const got = await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, undefined, async r => {
      if (r.id === ALPHA.id) throw new Error('nope')
      return POOL_VALUES
    })
    expect(got.rows).toHaveLength(4)
    expect(got.rows.map(r => r.group)).toEqual(['left', 'left', 'right', 'right'])
  })

  it('ITEM-56 — the header select does not exist when there is nothing to distinguish', async () => {
    const alone = await resolveAxisEntryRows([KEY_ARTIFACT], AXIS, undefined, {}, browsable, undefined, reader().read)
    expect(alone.annotations).toHaveLength(1)
    expect(alone.show_select).toBe(false)
    // …and with one option there is no decision to report back either
    expect(alone.show_note).toBeNull()
    const several = await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, { key_label: 'Item id' }, reader().read)
    expect(several.show_select).toBe(true)
    expect(several.show_is_default).toBe(true)
    expect(several.show_note).toBe(defaultShowNote('Item id'))
  })

  it('ITEM-56 — ONE group is not a grouping', async () => {
    const oneGroup = new Map([[POOL.id, ['same', 'same', 'same', 'same']]])
    const got = await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, undefined, async r =>
      oneGroup.get(r.id) ?? [],
    )
    expect(got.groups).toEqual([{ name: 'same', count: 4 }])
    expect(got.grouped).toBe(false)
  })

  it('a stored `show` naming a column this row space does not have resolves BACK to the key', async () => {
    const got = await resolveAxisEntryRows(
      catalog,
      AXIS,
      undefined,
      { show: 'a-gone' },
      browsable,
      { key_label: 'Item id' },
      reader().read,
    )
    expect(got.show).toBe(AXIS.artifact)
    expect(got.show_is_default).toBe(true)
  })

  it('with no VALUE candidates every row\'s ▶ carries the refusal — no dead control', async () => {
    const got = await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, undefined, reader().read)
    expect(got.n_sources).toBe(0)
    expect(got.sources).toEqual([])
    // The row's OWN permanent reason wins over the frame gate: choosing a coordinate would
    // not give these entries a value source, so naming the actionable reason would be the
    // less informative answer. Same precedence as `row_space_columns`.
    expect(got.rows.every(r => r.plot_refusal === NO_ENTRY_SOURCES_REFUSAL)).toBe(true)
  })

  // ── the FRAME gate (ITEM-39), the entry-axis twin of `row_space_columns`' ─────────────
  //
  // An entry's ▶ emits a plot, and a plot is drawn in the pane's frame. Before this gate the
  // ▶ emitted with `coordinate: null`, and the canvas fell back to the project-wide
  // `layouts[0]` — the silent wrong-frame picture, reachable without ever opening the
  // coordinate picker.
  it('refuses every row while the pane is UNFRAMED, and says why — with a framed control', async () => {
    const rowsIndex = row({
      id: 'a-rows-frame',
      content_hash: ROW_HASH,
      meta: { is_axis_index: true, name: 'rows' },
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: ROW_DIGEST },
    })
    const matrix = row({
      id: 'a-matrix-frame',
      datatype: 'values-matrix',
      meta: { name: 'the values' },
      structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', ENTRY_AXIS_LABEL], aligned_to: ROW_DIGEST },
    })
    const full = [...catalog, rowsIndex, matrix]
    const anchor = resolveRowSpaceAnchor(full, [ROW_HASH])

    // UNFRAMED — the rows are still LISTED (never hidden), and every ▶ carries the reason.
    const unframed = await resolveAxisEntryRows(
      full, AXIS, anchor, { values_datatype: 'values-matrix' }, browsable, undefined, reader().read,
    )
    expect(unframed.rows.length).toBeGreaterThan(0)
    expect(unframed.rows.every(r => r.plot_refusal === NO_COORDINATE_REFUSAL)).toBe(true)

    // POSITIVE CONTROL — the same catalog with a coordinate chosen refuses nothing. Without
    // it, "every row refuses" would also hold for a resolver that refused unconditionally.
    const framed = await resolveAxisEntryRows(
      full, AXIS, anchor, { values_datatype: 'values-matrix', coordinate: matrix.id },
      browsable, undefined, reader().read,
    )
    expect(framed.rows.every(r => r.plot_refusal === null)).toBe(true)

    // …and a coordinate id naming NOTHING in the catalog is unframed, not framed: an
    // unresolvable identity yields absence rather than a guess (INV-4).
    const ghost = await resolveAxisEntryRows(
      full, AXIS, anchor, { values_datatype: 'values-matrix', coordinate: 'no-such-artifact' },
      browsable, undefined, reader().read,
    )
    expect(ghost.rows.every(r => r.plot_refusal === NO_COORDINATE_REFUSAL)).toBe(true)
  })

  it('the value sources are ONE list for the axis, not one per entry', async () => {
    // A row space, and a matrix indexed by BOTH it and the entry axis: the shape an entry's
    // values actually live in.
    const rowsIndex = row({
      id: 'a-rows',
      content_hash: ROW_HASH,
      meta: { is_axis_index: true, name: 'rows' },
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: ROW_DIGEST },
    })
    const matrix = row({
      id: 'a-matrix',
      datatype: 'values-matrix',
      meta: { name: 'the values' },
      structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', ENTRY_AXIS_LABEL], aligned_to: ROW_DIGEST },
    })
    const full = [...catalog, rowsIndex, matrix]
    const anchor = resolveRowSpaceAnchor(full, [ROW_HASH])
    // `coordinate` is the FRAME (ITEM-39). An entry's ▶ emits a plot drawn in the pane's
    // frame, so an UNFRAMED pane refuses every row — see the frame-gate test below. This
    // subject is about the value-SOURCE rule, so it frames the pane to isolate it.
    const args = { values_datatype: 'values-matrix', coordinate: matrix.id }
    const got = await resolveAxisEntryRows(full, AXIS, anchor, args, browsable, undefined, reader().read)
    expect(got.n_sources).toBe(1)
    // The source ref is exactly `(artifact, datatype, title)` — the identity plus its display
    // name. It used to carry three alignment fields as well; they went with the marks (owner,
    // ledger #28 + #29), and the exhaustive `toEqual` is what makes that visible here rather
    // than leaving a field nobody reads.
    expect(got.sources).toEqual([
      {
        artifact: matrix.id,
        datatype: 'values-matrix',
        title: 'the values',
      },
    ])
    expect(got.rows.every(r => r.plot_refusal === null)).toBe(true)

    // …and WITHOUT the view's `values_datatype`, the annotation columns are STILL not
    // candidates — but for a reason that has nothing to do with `values_datatype`.
    //
    // This assertion used to expect all three, on the argument that the annotations "declare
    // the same axis, so they carry a value per entry" and narrowing them was the view's
    // business. The first half is true and the conclusion does not follow: a value source has
    // to be indexed by the ANCHORED ROW SPACE as well, because what a source paints is the
    // anchored rows. An annotation carrying one value per ENTRY of the sibling axis cannot
    // paint them, and it declares that about itself — it names the entry axis and not the
    // anchor's. The engine now reads that declaration (`alignmentState`: a candidate on a
    // DIFFERENT declared axis is A2, not A3), which is the same defect the row-space picker
    // had, one layer down: a question answered from the wrong premise.
    //
    // `values_datatype:` is NOT thereby decoration. It narrows by KIND among the sources that
    // ARE on the anchor — several artifacts can be indexed by both axes — and this is the
    // engine refusing the ones that are not on it at all. Two different cuts.
    const unnarrowed = await resolveAxisEntryRows(full, AXIS, anchor, {}, browsable, undefined, reader().read)
    expect(unnarrowed.sources.map(s => s.artifact).sort()).toEqual([matrix.id])
  })
})

// ── the axis join this resolver rests on ───────────────────────────────────────────────

describe('the sibling-axis join refuses an AMBIGUOUS label rather than taking the first', () => {
  it('reports how many claimed the label', () => {
    const axes: AxisSummary[] = [
      { content_hash: ROW_HASH, name: 'rows', length: 6 } as AxisSummary,
      { content_hash: ENTRY_HASH, name: ENTRY_AXIS_LABEL, length: 4 } as AxisSummary,
      { content_hash: 'hash-entries-2', name: ENTRY_AXIS_LABEL, length: 9 } as AxisSummary,
    ]
    const anchorRow = row({
      id: 'a-rows',
      content_hash: ROW_HASH,
      meta: { source_dataset_ids: ['ds-1'] },
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows' },
    })
    const got = resolveEntryAxis([anchorRow], axes, ROW_HASH, ENTRY_AXIS_LABEL)
    expect(got.ok).toBe(false)
  })
})

// ── A3 ON THE VALUE SOURCES (ITEM-18/ITEM-19, DEC-11) ─────────────────────────────────
//
// A plot emitted from an entry row is COLOURED by one of these artifacts, and nothing marked
// it: the rows and the sources carried no alignment field at all, and the emitted tile's note
// was the FRAME's mark alone — so R8's column half was dropped, in every project's DEFAULT,
// because a value matrix routinely declares no alignment.
//
// The rule is `row_space_columns`' verbatim, so these subjects are the entry-axis twins of its
// own: MIXED marks the undeclared one; ALL-undeclared marks none and raises the aggregate; the
// PLOT's mark follows the other rule and is set by EITHER half being undeclared.

describe('A3 on the value sources (ITEM-19 / DEC-11)', () => {
  // Re-declared rather than reached for out of the sibling describe: these fixtures are
  // block-scoped there, and a suite that borrowed them would be coupled to another subject's
  // setup.
  const catalog = [KEY_ARTIFACT, ALPHA, POOL]
  const browsable = { entries: KEYS, length: 4, anchored: true, browsable: true, refusal: null }
  const reader = () => ({
    read: async (r: ArtifactRow) => (VALUES.get(r.id) ?? []) as readonly string[],
  })
  const ROWS_INDEX = row({
    id: 'a3-rows',
    content_hash: ROW_HASH,
    meta: { is_axis_index: true, name: 'rows' },
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: ROW_DIGEST },
  })
  /** A value source that DECLARES its alignment (`aligned_to`), or — the A3 case — does not. */
  const source = (id: string, declared: boolean) =>
    row({
      id,
      datatype: 'values-matrix',
      meta: { name: id },
      structure: {
        encoding: 'zarr_v3',
        kind: 'sparse_csc',
        axes: ['rows', ENTRY_AXIS_LABEL],
        ...(declared ? { aligned_to: ROW_DIGEST } : {}),
      },
    })

  const resolve = async (sources: ReturnType<typeof source>[], coordinate?: string) => {
    const full = [...catalog, ROWS_INDEX, ...sources]
    const anchor = resolveRowSpaceAnchor(full, [ROW_HASH])
    return resolveAxisEntryRows(
      full,
      AXIS,
      anchor,
      { values_datatype: 'values-matrix', ...(coordinate ? { coordinate } : {}) },
      browsable,
      undefined,
      reader().read,
    )
  }

  // ── REWRITTEN (owner, ledger #28 + #29) ──────────────────────────────────────────────
  //
  // FOUR tests stood here — a mixed offer marks the undeclared source, an all-undeclared offer
  // says it once, "all of nothing" is not a fact, and the plot mark follows the other rule.
  // Every one pinned `alignment_unknown` / `alignment_mark` / `plot_note` on a value source,
  // and those three fields are gone: `#28` deleted the alert that stated the fact in prose and
  // `#29` deleted the mark an emitted plot carried, which together retire the rule the four
  // tests were about.
  //
  // What they are rewritten TO is the thing those tests were silently also proving, and which
  // is the only part still true: WHICH SOURCES ARE OFFERED. Each of the four cases fed the
  // resolver a different alignment configuration; the marks changed between them and the OFFER
  // never did. That invariance is now the assertion, driven through the same four
  // configurations — so a change that started dropping A3 sources (the obvious wrong reading of
  // "remove the alignment not declared") goes red here.
  it.each([
    ['a MIXED offer', [['declared', true] as const, ['undeclared', false] as const]],
    ['an ALL-UNDECLARED offer', [['one', false] as const, ['two', false] as const]],
    ['an ALL-DECLARED offer', [['one', true] as const, ['two', true] as const]],
  ])('%s offers every source, and none of them is marked', async (_case, spec) => {
    const got = await resolve(spec.map(([id, declared]) => source(id, declared)))
    expect(got.sources.map(s => s.artifact)).toEqual(spec.map(([id]) => id))
    expect(got.n_sources).toBe(spec.length)
    // Over the whole payload rather than over the three deleted field names: the ledger row is
    // about the fact reaching a surface, and a fourth field would satisfy a three-field check.
    expect(JSON.stringify(got).toLowerCase()).not.toContain('alignment')
  })

  it('an UNDECLARED FRAME does not change what is offered either', async () => {
    // The fourth deleted case, kept as its own test because the frame is a SECOND half: the
    // plot note used to fire on it independently of the source's own state. Now neither half
    // says anything, and — the part that has to stay true — neither half withholds a source.
    const undeclaredFrame = await resolve([source('v', true), source('coord', false)], 'coord')
    expect(undeclaredFrame.sources.map(s => s.artifact)).toEqual(['v', 'coord'])
    expect(JSON.stringify(undeclaredFrame).toLowerCase()).not.toContain('alignment')
  })

  it('no sources at all is still an answer', async () => {
    const got = await resolve([])
    expect(got.sources).toEqual([])
    expect(got.resolved).toBe(true)
  })
})

// ── the PRESENCE witness (round-2 re-audit) ────────────────────────────────────────────
//
// `evalWhen`'s `!=` arm is a strict `!==`, so `$data.entries.refusal != null` reads TRUE for a
// slice that never answered, and the section renders an alert with an undefined `text` — an
// empty info box as its only surface. A refusal cannot express "the slice never answered", so
// the answer carries a fact that says it DID answer. Round 1 closed the identical hole on
// `PaneFrame`; this is the second slice to need it.

describe('every answer this resolver produces is RESOLVED (the presence witness)', () => {
  const catalog = [KEY_ARTIFACT, ALPHA, POOL]
  const browsable = { entries: KEYS, length: 4, anchored: true, browsable: true, refusal: null }
  const reader = () => ({ read: async (r: ArtifactRow) => (VALUES.get(r.id) ?? []) as readonly string[] })

  it('the EMPTY answer is resolved — "nothing anchored" is an answer, not the absence of one', () => {
    expect(NO_AXIS_ENTRY_ROWS.resolved).toBe(true)
  })

  it('the unresolved-axis arm and the full arm are both resolved', async () => {
    const noAxis = await resolveAxisEntryRows(
      catalog, undefined, undefined,
      {}, { ...browsable, browsable: false, anchored: false }, undefined, reader().read,
    )
    expect(noAxis.resolved).toBe(true)
    const full = await resolveAxisEntryRows(catalog, AXIS, undefined, {}, browsable, undefined, reader().read)
    expect(full.resolved).toBe(true)
    // …and the property is only worth anything because the UNDEFINED case is what it
    // distinguishes: a `when:` predicate reading a slice that never ran sees `undefined`, which
    // is neither of the above. Asserted as the type-level fact it is, since there is no resolver
    // call that produces it.
    expect((undefined as unknown as { resolved?: boolean })?.resolved).toBeUndefined()
  })
})
