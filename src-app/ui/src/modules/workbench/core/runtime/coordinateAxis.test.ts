// WHICH ROWS A CHOSEN COORDINATE SET IS ABOUT — the join that replaced the question.
//
// The pane's first block used to be a control asking which rows the pane was about. It is
// deleted (owner, 2026-08-13: there is no such thing as a row space, and an axis is not a thing
// anybody picks), so `$scope.axis` is now DERIVED from the coordinate set the user picked.
//
// The reason this file exists rather than a couple of cases appended somewhere: RUNG 2 IS THE
// RUNG THAT MATTERS. The owner's live data declares no `aligned_to` at all — it was imported
// before the importer stamped it — and a previous fix to this pane worked only for
// correctly-declared data and therefore changed nothing on their screen. A test suite that
// exercises only the well-declared path would certify that same non-fix again.

import { describe, expect, it } from 'vitest'

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { gatherFor, resolveRowSpaceAnchor } from './axisSource'
import { axesOfCoordinate } from './coordinateAxis'

/** The `(axis identity, membership)` pair {@link axesOfCoordinate} answers for a `full`
 *  declaration — the whole entry, not just its identifying component (ITEM-6).
 *
 *  Asserted rather than elided: `membership` is what ITEM-9's figure is denominated on, so a
 *  resolver that carried the digest and dropped the entry would pass every case in this file
 *  while leaving the consumer nothing to count with. `toEqual` treats an `undefined` property
 *  as absent, so this one shape covers the plural spelling (which omits nothing) and the
 *  legacy scalar (which has no `n_members` to report) alike. */
function pair(contentHash: string, alignedTo: string, axis?: string, declaredOrder = 0) {
  return {
    contentHash,
    alignedTo,
    membership: {
      alignedTo,
      axis,
      kind: 'full',
      nMembers: undefined,
      bitmap: undefined,
      members: undefined,
      // ITEM-11 — the producer's own array position, which is what a gather ranks its segments
      // by. Asserted rather than elided for the same reason `membership` itself is: a reader
      // that dropped it would leave the gather with nothing to order by but the array it
      // happened to arrive in.
      declaredOrder,
    },
  }
}

const AXIS = 'rows'
const OTHER_AXIS = 'others'

/** The SOLE source dataset of a fixture row, or `null`. One derivation for every builder here:
 *  the `datasets.length === 1 ? datasets[0] : null` shape is a sole-element read, and writing it
 *  once keeps it a single documented spot rather than one per builder. */
function soleDataset(datasets: readonly string[]): string | null {
  return datasets.length === 1 ? datasets[0] : null
}

let seq = 0
function row(over: Partial<ArtifactRow> & { structure: unknown }): ArtifactRow {
  seq += 1
  return {
    id: `art-${seq}`,
    project_id: 'p',
    datatype: 'demo/thing',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as ArtifactRow
}

/** A KEY artifact — the thing that IS an axis. Its `content_hash` is the identity
 *  `$scope.axis` carries, and its `key_sequence_digest` is what an aligned artifact names.
 *
 *  `meta.is_axis_index` is what makes it one, and it is not decoration here: it is the same
 *  declaration the SERVER derives the project's axes from, so an artifact without it has no
 *  `AxisSummary` and its `content_hash` is not an identity this function may return. Every
 *  fixture in this file used to omit it and lean on the digest instead — which is exactly the
 *  conflation the defect below is made of. */
function keyArtifact(hash: string, digest: string, axis: string, datasets: string[]): ArtifactRow {
  return row({
    id: `key-${hash}`,
    content_hash: hash,
    structure: { encoding: 'zarr_v3', kind: 'table', axis, key_sequence_digest: digest },
    meta: { is_axis_index: true },
    source_dataset_ids: datasets,
    source_dataset_id: soleDataset(datasets),
  })
}

/**
 * THE IDENTIFIER TWIN — an ordinary per-row column whose VALUES are the axis's key sequence,
 * so it truthfully declares the digest, and which is NOT the axis and says so by carrying no
 * `meta.is_axis_index`.
 *
 * Every real import writes this pair (the canonical index plus a per-row identifier column over
 * the same keys — the importer's own comment says the second one *"deliberately carries no
 * `is_axis_index`"*), and no fixture in this repo had ever written it. That is why the pane
 * shipped a coordinate pick that scoped nothing on every ordinary project: the derivation read
 * "declares a digest" as "is an axis", found two, and refused.
 */
function identifierTwin(id: string, digest: string, axis: string, datasets: string[]): ArtifactRow {
  return row({
    id,
    content_hash: `content-${id}`,
    structure: { encoding: 'zarr_v3', kind: 'table', axis, key_sequence_digest: digest },
    source_dataset_ids: datasets,
    source_dataset_id: soleDataset(datasets),
  })
}

/** A coordinate set. `alignedTo` absent ⇒ the producer declared nothing, which is the owner's
 *  real data and the whole reason rung 2 exists. */
function coords(id: string, axis: string, datasets: string[], alignedTo?: string): ArtifactRow {
  return row({
    id,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      ...(alignedTo ? { aligned_to: alignedTo } : {}),
      arrays: [{ path: 'positions', kind: 'numeric', shape: [10, 2] }],
    },
    source_dataset_ids: datasets,
    source_dataset_id: soleDataset(datasets),
  })
}

describe('axesOfCoordinate — RUNG 1, the producer declared alignment', () => {
  it('joins the declared key sequence to the axis that IS it', () => {
    const key = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([key, c], 'c-1')).toEqual([pair('hash-a', 'digest-a', AXIS)])
  })

  it('a declared alignment that matches NOTHING answers null — never the other axis', () => {
    // A confident wrong answer here scopes § Colour by and the entry section to a population the
    // positions are not about, silently. The whole pane exists against that.
    const key = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'], 'digest-nobody-has')
    expect(axesOfCoordinate([key, c], 'c-1')).toEqual([])
  })

  it('a declared alignment WINS over the label rung — the digest is the stronger fact', () => {
    // The coordinate declares axis `others` (which would send rung 2 to the wrong key) and
    // declares the digest of the `rows` axis. The positive declared join is what counts.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b = keyArtifact('hash-b', 'digest-b', OTHER_AXIS, ['ds-1'])
    const c = coords('c-1', OTHER_AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([a, b, c], 'c-1')).toEqual([pair('hash-a', 'digest-a', OTHER_AXIS)])
  })
})

describe("axesOfCoordinate — RUNG 2, the owner's real data declares NOTHING", () => {
  it('resolves from the declared axis label WITHIN the source dataset', () => {
    // ONE dataset publishing TWO axes and no alignment anywhere: the shape on the owner's
    // screen. The coordinate says which axis it sits on and which dataset it came from, and
    // that pair identifies one axis instance — the same identity `siblingsOnAxis` uses.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b = keyArtifact('hash-b', 'digest-b', OTHER_AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'])
    expect(axesOfCoordinate([a, b, c], 'c-1')).toEqual([{ contentHash: 'hash-a' }])
  })

  it('does NOT reach across datasets — a same-named axis elsewhere is a different population', () => {
    // Two datasets each publishing an axis called the same thing. Answering with the other
    // dataset's would paint one population's columns on another's coordinates, which is the
    // exact failure the deleted control was built to prevent and must not return by the back
    // door of a looser join.
    const mine = keyArtifact('hash-mine', 'digest-mine', AXIS, ['ds-1'])
    const theirs = keyArtifact('hash-theirs', 'digest-theirs', AXIS, ['ds-2'])
    const c = coords('c-1', AXIS, ['ds-2'])
    expect(axesOfCoordinate([mine, theirs, c], 'c-1')).toEqual([{ contentHash: 'hash-theirs' }])
  })

  // ── THE REPORTED DEFECT (ledger #22) ─────────────────────────────────────────────────
  //
  // Both of these ran RED before the fix, on both rungs, and they are the shape of every
  // ordinary import — so the failure they describe was not an edge case, it was the default.
  it('the identifier twin is NOT a second axis — rung 2 still resolves', () => {
    const key = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const twin = identifierTwin('row-ids', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'])
    expect(axesOfCoordinate([key, twin, c], 'c-1')).toEqual([{ contentHash: 'hash-a' }])
  })

  it('…and rung 1 too — the twin declares the SAME digest the coordinate names', () => {
    const key = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const twin = identifierTwin('row-ids', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([key, twin, c], 'c-1')).toEqual([pair('hash-a', 'digest-a', AXIS)])
  })

  it('AMBIGUITY STILL REFUSES — two artifacts that both SAY they are the axis', () => {
    // The negative control for the pair above: narrowing "is an axis" to the producer's own
    // declaration must not degenerate into "take the first one that declares anything". Two
    // genuine axis indexes on one label in one dataset is still not a tie to break.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b = keyArtifact('hash-b', 'digest-b', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'])
    expect(axesOfCoordinate([a, b, c], 'c-1')).toEqual([])
  })

  it('an artifact that declares ONLY the digest is never the answer', () => {
    // With no artifact claiming to BE the axis there is no axis to name, and the honest answer
    // is absence — not the identity of a column that merely holds the keys.
    const twin = identifierTwin('row-ids', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-1', AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([twin, c], 'c-1')).toEqual([])
  })

  it('a coordinate declaring NO axis, or SEVERAL, answers null', () => {
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const none = row({ id: 'c-none', structure: { encoding: 'zarr_v3' }, source_dataset_ids: ['ds-1'] })
    const several = row({
      id: 'c-many',
      structure: { encoding: 'zarr_v3', axes: [AXIS, OTHER_AXIS] },
      source_dataset_ids: ['ds-1'],
    })
    expect(axesOfCoordinate([a, none, several], 'c-none')).toEqual([])
    expect(axesOfCoordinate([a, none, several], 'c-many')).toEqual([])
  })
})

describe('axesOfCoordinate — nothing chosen is a real answer, not a fallback', () => {
  it('null / empty / an unknown id all answer null', () => {
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    expect(axesOfCoordinate([a], null)).toEqual([])
    expect(axesOfCoordinate([a], undefined)).toEqual([])
    expect(axesOfCoordinate([a], '')).toEqual([])
    expect(axesOfCoordinate([a], 'not-in-the-catalog')).toEqual([])
  })

  it('a key artifact with no content_hash cannot be the answer — it names nothing', () => {
    // `$scope.axis` IS an `AxisSummary.content_hash`. A key row that carries none is not an
    // identity anything can join on, so it must not be returned as one.
    const hashless = row({
      id: 'key-hashless',
      structure: { encoding: 'zarr_v3', axis: AXIS, key_sequence_digest: 'digest-a' },
      source_dataset_ids: ['ds-1'],
    })
    const c = coords('c-1', AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([hashless, c], 'c-1')).toEqual([])
  })
})

describe('what counts as an AXIS is TWO declarations, not one', () => {
  it('rung 2 resolves against a key artifact that declares only `meta.is_axis_index`', () => {
    // The catalog publishes an axis for an artifact declaring `meta.is_axis_index`; the key
    // SEQUENCE digest is a separate declaration that an aligned artifact joins against. A
    // project imported before the importer stamped digests carries only the first — which is
    // precisely the project this whole module exists for, so gating on the digest alone would
    // have made rung 2 answer `null` on exactly the data it was written for.
    const key = row({
      id: 'key-indexed',
      content_hash: 'hash-indexed',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: AXIS },
      meta: { is_axis_index: true },
      source_dataset_ids: ['ds-1'],
      source_dataset_id: 'ds-1',
    })
    const c = coords('c-1', AXIS, ['ds-1'])
    expect(axesOfCoordinate([key, c], 'c-1')).toEqual([{ contentHash: 'hash-indexed' }])
  })

  it('an ordinary column on the same axis is NOT a key artifact', () => {
    // The negative control for the clause above: without it, "declares this axis and shares
    // the dataset" would match every column on the axis and the sole-match rule would refuse
    // on every real project rather than answering.
    const key = row({
      id: 'key-indexed',
      content_hash: 'hash-indexed',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: AXIS },
      meta: { is_axis_index: true },
      source_dataset_ids: ['ds-1'],
      source_dataset_id: 'ds-1',
    })
    const column = row({
      id: 'col-1',
      content_hash: 'hash-col',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: AXIS, columns: [{ name: 'values' }] },
      source_dataset_ids: ['ds-1'],
      source_dataset_id: 'ds-1',
    })
    const c = coords('c-1', AXIS, ['ds-1'])
    expect(axesOfCoordinate([key, column, c], 'c-1')).toEqual([{ contentHash: 'hash-indexed' }])
  })
})

// ── TEST-10 (ITEM-8): THE PLURAL ANSWER ────────────────────────────────────────────────
//
// An INTEGRATED coordinate rests on TWO datasets' axes at once. The scalar form could only
// ever name one of them, and a pane anchored on one of two offers half the project's columns
// while looking exactly as complete as a correct answer — the silent-wrong-rows failure this
// whole pane exists against. So the assertions below compare the SET of pairs, never a length
// and never "non-empty": truncating to the first pair is precisely the defect, and it passes
// every check that is not this one.

/** An INTEGRATED coordinate — positions resting on SEVERAL axes, declared as the design's
 *  `(axis identity, membership)` pairs (`structure.memberships`, ITEM-1). */
function integrated(id: string, datasets: string[], alignedTo: string[]): ArtifactRow {
  return row({
    id,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      memberships: alignedTo.map(d => ({ aligned_to: d, kind: 'full' })),
      arrays: [{ path: 'positions', kind: 'numeric', shape: [10, 2] }],
    },
    source_dataset_ids: datasets,
    source_dataset_id: soleDataset(datasets),
  })
}

describe('axesOfCoordinate — an integrated coordinate rests on SEVERAL axes (ITEM-8)', () => {
  it('answers BOTH pairs, in the order the coordinate declared them', () => {
    // Two datasets, one coordinate integrating them. Answering `[{hash-a}]` — the first pair —
    // is the truncation: it is non-empty, it resolves, every dependent section renders, and
    // every column of ds-2 is silently absent from the offer.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b = keyArtifact('hash-b', 'digest-b', AXIS, ['ds-2'])
    const c = integrated('c-int', ['ds-1', 'ds-2'], ['digest-a', 'digest-b'])
    expect(axesOfCoordinate([a, b, c], 'c-int')).toEqual([
      pair('hash-a', 'digest-a'),
      pair('hash-b', 'digest-b', undefined, 1),
    ])
  })

  it('the ORDER is the coordinate’s, not the catalog’s', () => {
    // The declared order is the anchor's segment order (INV-7) — a gather may not invent one —
    // so it is read off the coordinate and never off whatever order the rows arrived in.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b = keyArtifact('hash-b', 'digest-b', AXIS, ['ds-2'])
    const c = integrated('c-int', ['ds-1', 'ds-2'], ['digest-b', 'digest-a'])
    expect(axesOfCoordinate([a, b, c], 'c-int').map(x => x.contentHash)).toEqual([
      'hash-b',
      'hash-a',
    ])
  })

  it('a ONE-membership coordinate answers exactly one pair — the ordinary case is unchanged', () => {
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const c = integrated('c-one', ['ds-1'], ['digest-a'])
    expect(axesOfCoordinate([a, c], 'c-one')).toEqual([pair('hash-a', 'digest-a')])
  })

  it('ALL OR NOTHING — one unresolvable membership refuses the WHOLE answer', () => {
    // The negative control for the plural form itself. Returning the pair that did resolve
    // would be a SHORT anchor that is indistinguishable, downstream, from a coordinate that
    // genuinely rests on one axis: it would offer ds-1's columns against a picture drawn from
    // ds-1 AND ds-2 and call it complete. `[]` makes the sections say what they need instead.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const c = integrated('c-int', ['ds-1', 'ds-2'], ['digest-a', 'digest-nobody-has'])
    expect(axesOfCoordinate([a, c], 'c-int')).toEqual([])
  })

  it('AMBIGUITY on ONE membership still refuses — plural is not a licence to pick', () => {
    // Two artifacts declaring the same key sequence is still not a tie to break, and it is not
    // made breakable by there being another membership that resolved cleanly.
    const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const b1 = keyArtifact('hash-b1', 'digest-b', AXIS, ['ds-2'])
    const b2 = keyArtifact('hash-b2', 'digest-b', AXIS, ['ds-2'])
    const c = integrated('c-int', ['ds-1', 'ds-2'], ['digest-a', 'digest-b'])
    expect(axesOfCoordinate([a, b1, b2, c], 'c-int')).toEqual([])
  })

  it('the LEGACY scalar `aligned_to` still reads as exactly one membership', () => {
    // Zero existing artifacts declare `memberships`, so the scalar spelling is what every
    // project in existence carries and it must keep meaning exactly what it means now. A
    // plural reader that only understood the array would take every current project's offers
    // away — the regression this case stands against.
    const key = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
    const c = coords('c-legacy', AXIS, ['ds-1'], 'digest-a')
    expect(axesOfCoordinate([key, c], 'c-legacy')).toEqual([pair('hash-a', 'digest-a', AXIS)])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// TEST-14 (ITEM-11) — THE SEGMENT ORDER IS THE COORDINATE'S DECLARATION, END TO END
//
// The block above pins the order `axesOfCoordinate` READS. This one carries it the rest of the
// way, to the gather request built from it — because that is where the order stops being a list
// and becomes a ROW SEQUENCE, and where getting it wrong stops being visible.
//
// INV-7: *"Membership is a set; a coordinate's rows are a sequence. … Across two axes the segment
// order must be declared."* A set has no order, so a gather that imposes one has invented it. And
// the invention is silent: both segments are present, the gathered length is exactly right, every
// count agrees, and the only thing that is wrong is WHICH ROW each value lands on — a colouring
// permuted against the positions beside it. That is the §4 failure class this branch exists for,
// so it is asserted here rather than described in a comment.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** A coordinate declaring a SUBSET membership per axis, each with its own index body — the
 *  shape a gather is actually built from (a `full` membership has nothing to gather by). */
function integratedSubset(
  id: string,
  datasets: string[],
  segments: ReadonlyArray<{ alignedTo: string; member: string; nMembers: number }>,
): ArtifactRow {
  return row({
    id,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      memberships: segments.map(s => ({
        aligned_to: s.alignedTo,
        kind: 'subset',
        members: s.member,
        n_members: s.nMembers,
      })),
      arrays: [{ path: 'positions', kind: 'numeric', shape: [30, 2] }],
    },
    source_dataset_ids: datasets,
    source_dataset_id: soleDataset(datasets),
  })
}

/** A candidate COLUMN declaring `full` on both axes — the one gathered column an integrated
 *  coordinate's two segments can both be read from. */
function wholeOnBoth(id: string, alignedTo: string[]): ArtifactRow {
  return row({
    id,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      memberships: alignedTo.map(d => ({ aligned_to: d, kind: 'full' })),
      columns: [{ path: 'v', kind: 'numeric', dtype: 'float32', shape: [1000] }],
    },
    source_dataset_ids: ['ds-1'],
    source_dataset_id: 'ds-1',
  })
}

describe('TEST-14 (ITEM-11) — a gather emits the ANCHOR’s declared segment order', () => {
  const a = keyArtifact('hash-a', 'digest-a', AXIS, ['ds-1'])
  const b = keyArtifact('hash-b', 'digest-b', AXIS, ['ds-2'])
  const column = wholeOnBoth('col', ['digest-a', 'digest-b'])

  /** The gather segments for `col` under a coordinate declaring `order`. */
  function segmentsFor(order: ReadonlyArray<{ alignedTo: string; member: string; nMembers: number }>) {
    const coordinate = integratedSubset('c-int', ['ds-1', 'ds-2'], order)
    const anchor = resolveRowSpaceAnchor(
      [a, b, column, coordinate],
      ['hash-a', 'hash-b'],
      'c-int',
    )
    return gatherFor('col', column.structure, anchor)?.segments ?? []
  }

  const A = { alignedTo: 'digest-a', member: 'members-a', nMembers: 10 }
  const B = { alignedTo: 'digest-b', member: 'members-b', nMembers: 20 }

  it('reads the order off the coordinate’s own `memberships` array — A then B', () => {
    expect(segmentsFor([A, B]).map(s => s.member)).toEqual(['members-a', 'members-b'])
  })

  it('a REVERSED declaration produces the REVERSED segment order — the declaration decides', () => {
    // Nothing about the two axes changed: the same key artifacts, the same column, the same
    // member counts. Only the coordinate's declaration order moved, and the gather moved with it.
    expect(segmentsFor([B, A]).map(s => s.member)).toEqual(['members-b', 'members-a'])
  })

  it('NEGATIVE CONTROL — every non-declared ordering agrees on LENGTH and disagrees on SEQUENCE', () => {
    // The mutations this test exists against, each one a plausible implementation: sort the
    // segments by axis identity, by member name, or by member count. Under the reversed
    // declaration all three produce `[a, b]` — the ascending order — while the declaration says
    // `[b, a]`. Both answers are two segments long and both sum to 30 rows, so a length or a
    // total assertion cannot tell them apart. The SEQUENCE can, and only the sequence can.
    const declared = segmentsFor([B, A])
    expect(declared.map(s => s.count)).toEqual([20, 10])
    const total = declared.reduce((n, s) => n + s.count, 0)

    const byAxis = [...declared].sort((x, y) => x.alignedTo.localeCompare(y.alignedTo))
    const byMember = [...declared].sort((x, y) => x.member.localeCompare(y.member))
    const byCount = [...declared].sort((x, y) => x.count - y.count)
    for (const permuted of [byAxis, byMember, byCount]) {
      // Indistinguishable by every count-shaped assertion…
      expect(permuted).toHaveLength(declared.length)
      expect(permuted.reduce((n, s) => n + s.count, 0)).toBe(total)
      // …and a different row sequence, which is the whole of the defect.
      expect(permuted.map(s => s.member)).not.toEqual(declared.map(s => s.member))
    }
  })

  it('the ONE-axis case is the one-segment case — nothing is special-cased', () => {
    const oneAxis = resolveRowSpaceAnchor(
      [a, column, integratedSubset('c-one', ['ds-1'], [A])],
      ['hash-a'],
      'c-one',
    )
    expect(gatherFor('col', column.structure, oneAxis)?.segments.map(s => s.member)).toEqual([
      'members-a',
    ])
  })
})
