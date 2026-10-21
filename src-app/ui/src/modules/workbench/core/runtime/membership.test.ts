// WHICH MEMBERS of an axis an artifact's rows are — the reader, and the legacy default.
//
// `aligned_to` says which axis a set of values rests on. It does not say WHICH ROWS of it,
// and for everything that is not the whole axis that is the question a consumer is asking:
// a population of 6,000 selected out of 1,000,000 declares the SAME `aligned_to` as the
// parent, so on the declarations alone the two are indistinguishable.
//
// The two properties these cases exist to protect are opposite failures of one function:
//
//   * a legacy artifact (scalar `aligned_to`, no `memberships`) must keep meaning exactly
//     what it means today, or every existing project loses its offers on the day this
//     ships (ITEM-2 / INV-9);
//   * an artifact declaring NOTHING must read as "declared nothing" and never as "declared
//     an empty set" — those are A3 and A4, opposite verdicts, and collapsing them deletes
//     offers with no error anywhere (ITEM-6).

import { describe, expect, it } from 'vitest'

import {
  declaredMemberships,
  decodeMemberSet,
  describedRows,
  describedRowsLine,
  correspondenceGather,
  gatherFor,
  resolveRowSpaceAnchor,
} from './axisSource'
import type { ArtifactRow } from '@/modules/workbench/extensions/data/contract'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

describe('declaredMemberships — ITEM-2, the scalar spelling is a membership', () => {
  it('reads a scalar `aligned_to` as exactly ONE `full` membership on its declared axis', () => {
    // TEST-2. This is the shape of every artifact in every project today.
    expect(
      declaredMemberships({ axis: 'rows', n: 10, aligned_to: DIGEST_A, columns: [] }),
    ).toEqual([{ alignedTo: DIGEST_A, axis: 'rows', kind: 'full', declaredOrder: 0 }])
    // nc: returning `[]` here — treating the legacy spelling as undeclared — passes any
    // "the reader does not crash" check and fails this one. It is the regression that
    // would take a whole project's offers away, so it is asserted as an equality on the
    // WHOLE entry rather than on its length.
  })

  it('a MULTI-axis artifact declares no sole label, and the identity still carries', () => {
    // A matrix declares both its axes, so there is no ONE label to report — but the digest
    // identifies regardless, and a label decides nothing anyway. Reporting `axes[0]` here
    // would be the positional guess this engine deletes on sight.
    const read = declaredMemberships({ axes: ['rows', 'cols'], aligned_to: DIGEST_A })
    expect(read).toEqual([{ alignedTo: DIGEST_A, axis: undefined, kind: 'full', declaredOrder: 0 }])
  })
})

describe('declaredMemberships — ITEM-6, `[]` is "declared nothing", never "declared empty"', () => {
  it('returns [] for an artifact declaring NEITHER spelling', () => {
    // TEST-7. `[]` means the question was never answered (A3 — offered and marked);
    // a declared membership of zero members would be A4 (not offered).
    for (const structure of [
      { axis: 'rows', n: 10, columns: [] },
      { axis: 'rows' },
      {},
      null,
      undefined,
      'not an object',
    ]) {
      expect(declaredMemberships(structure)).toEqual([])
    }
    // nc: answering `[{ kind: 'subset', nMembers: 0 }]` for an undeclared artifact — the
    // plausible "absence is an empty set" reading — passes every length and type check and
    // fails here. The two states drive OPPOSITE offer decisions.
  })

  it('a declared EMPTY membership is a real declaration and is NOT dropped', () => {
    // The other direction of the same distinction: an artifact that genuinely declares it
    // is about none of the axis's rows has said something, and saying it must survive the
    // read. Dropping it back to `[]` would turn A4 into A3 and offer a column describing
    // none of these rows.
    expect(
      declaredMemberships({ memberships: [{ aligned_to: DIGEST_A, kind: 'subset', n_members: 0 }] }),
    ).toEqual([
      {
        alignedTo: DIGEST_A,
        axis: undefined,
        kind: 'subset',
        nMembers: 0,
        bitmap: undefined,
        members: undefined,
        declaredOrder: 0,
      },
    ])
  })

  it('the plural spelling WINS over the scalar, and is read in declaration order', () => {
    const read = declaredMemberships({
      aligned_to: DIGEST_B,
      memberships: [
        { axis: 'left', aligned_to: DIGEST_A, kind: 'subset', n_members: 2, bitmap: 'AwE=' },
        { axis: 'right', aligned_to: DIGEST_B, kind: 'full', n_members: 9 },
      ],
    })
    // The SET and its ORDER, not its length: the declaration order IS the segment order a
    // gather honours (INV-7), so a reader that sorted or reversed would be wrong here.
    expect(read.map(m => m.alignedTo)).toEqual([DIGEST_A, DIGEST_B])
    expect(read.map(m => m.kind)).toEqual(['subset', 'full'])
    expect(read[0].bitmap).toBe('AwE=')
    expect(read[0].members).toBeUndefined()
  })

  it('an UNRECOGNISED kind is skipped, never defaulted to the strongest claim', () => {
    // `full` is the strongest thing in the vocabulary — every row of the axis. Defaulting
    // an entry this reader cannot understand to `full` would turn a declaration nobody can
    // act on into a confident claim; skipping leaves the artifact reading A3, which is the
    // honest state.
    expect(declaredMemberships({ memberships: [{ aligned_to: DIGEST_A, kind: 'partial' }] })).toEqual(
      [],
    )
    expect(declaredMemberships({ memberships: [{ kind: 'full' }] })).toEqual([])
  })
})

describe('declaredMemberships — INV-5, nothing composes', () => {
  it('resolves a derived-of-derived artifact in ONE hop, following no reference', () => {
    // TEST-50. Everything anchors to ORIGINAL dataset axes, so there is no chain to walk
    // and no common ancestor to find. The fixture is THREE levels deep on purpose: an
    // implementation that followed a reference from the derived artifact to its parent
    // resolves the same answer on a two-level fixture and only fails on this one.
    const original = { axis: 'rows', n: 100, key: 'values', key_sequence_digest: DIGEST_A }
    const derived = {
      axis: 'rows',
      n: 10,
      derived_from: 'level-1',
      memberships: [{ aligned_to: DIGEST_A, kind: 'subset', n_members: 10 }],
    }
    const derivedOfDerived = {
      axis: 'rows',
      n: 3,
      derived_from: 'level-2',
      memberships: [{ aligned_to: DIGEST_A, kind: 'subset', n_members: 3 }],
    }

    // Each answers the ORIGINAL axis's identity directly — the level-2 artifact does not
    // point at level-1, and nothing here reads any artifact but the one it was handed.
    expect(declaredMemberships(derived).map(m => m.alignedTo)).toEqual([DIGEST_A])
    expect(declaredMemberships(derivedOfDerived).map(m => m.alignedTo)).toEqual([DIGEST_A])
    expect(original.key_sequence_digest).toBe(DIGEST_A)
    // nc: a chain-walking reader needs the other artifacts to answer at all, and this
    // function is given none — it takes ONE `structure` and has nothing to walk to. That
    // is the property, and it is enforced by the signature rather than asserted about it.
  })
})

// ── THE FIGURE ON THE OFFERED ROW (ITEM-9 / ITEM-10) ──────────────────────────────────────
//
// INV-3: `|theirs ∩ mine| / |mine|` — **denominated on the COORDINATE's rows, not on the
// column's**. Both denominators produce a plausible percentage, which is why the fixture
// below is chosen so they produce DIFFERENT ones (6 of the anchor's 10 = 60%; the candidate's
// own 20 members = 30%): a same-denominator fixture would pass either implementation.
//
// The member sets are GOLDEN BLOBS produced by `cyto_zarr.encode_member_set` itself. The
// format has to be understood in two languages and the hazard is the two drifting apart, so
// nothing here encodes with a second implementation.

/** members 0…9 — the coordinate's rows. */
const MEMBERS_0_TO_9 = 'AQEBAQEBAQEBAQ=='
/** members 4…23 — 20 of them, SIX of which are the coordinate's. */
const MEMBERS_4_TO_23 = 'BQEBAQEBAQEBAQEBAQEBAQEBAQE='
/** members 100…109 — same axis, none of the coordinate's. */
const MEMBERS_100_TO_109 = 'ZQEBAQEBAQEBAQ=='
/** a deliberately scattered set — `[0, 200, 70000, 70001, 1048576]`, so the decoder is
 *  exercised over multi-byte varints and not only over the one-byte contiguous run. */
const MEMBERS_SCATTERED = 'AcgBqKEEAY/dOw=='

function artifact(id: string, structure: unknown): ArtifactRow {
  return {
    id,
    project_id: 'p1',
    datatype: 'demo/column',
    structure,
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-alpha',
  }
}

function keyArtifact(id: string, contentHash: string, digest: string): ArtifactRow {
  return {
    ...artifact(id, { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: digest }),
    content_hash: contentHash,
  }
}

type Entry = { alignedTo: string; kind: 'full' | 'subset'; nMembers?: number; bitmap?: string }

function membered(id: string, entries: Entry[]): ArtifactRow {
  return artifact(id, {
    encoding: 'zarr_v3',
    kind: 'table',
    axis: 'rows',
    memberships: entries.map(e => ({
      axis: 'rows',
      aligned_to: e.alignedTo,
      kind: e.kind,
      ...(e.nMembers === undefined ? {} : { n_members: e.nMembers }),
      ...(e.bitmap === undefined ? {} : { bitmap: e.bitmap }),
    })),
  })
}

describe('decodeMemberSet — the inline member set, across the language boundary', () => {
  it('decodes blobs the PRODUCER wrote, back to exactly its positions', () => {
    // Golden, not round-tripped through a local encoder: the property under test is that
    // this decoder and `cyto_zarr.encode_member_set` agree, and a local encoder would only
    // prove this file agrees with itself.
    expect(decodeMemberSet(MEMBERS_0_TO_9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(decodeMemberSet(MEMBERS_100_TO_109)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
    // Multi-byte varints, and a gap wider than 2^16 — the arm a single-byte reader gets wrong
    // while every contiguous fixture still passes.
    expect(decodeMemberSet(MEMBERS_SCATTERED)).toEqual([0, 200, 70000, 70001, 1048576])
  })

  it('REFUSES a malformed or truncated blob rather than returning the prefix that decoded', () => {
    // A truncated set is an off-by-thousands gather with a plausible shape. `undefined` reads
    // as undecidable everywhere it is consumed, which offers and renders no figure.
    expect(decodeMemberSet('AYA=')).toBeUndefined() // trailing varint with no terminator
    expect(decodeMemberSet('!!!not base64!!!')).toBeUndefined()
    expect(decodeMemberSet('')).toBeUndefined()
    expect(decodeMemberSet(undefined)).toBeUndefined()
  })
})

describe('TEST-11 / TEST-48 — `describedRows` is three-valued and denominated on the ANCHOR', () => {
  const coordinate = membered('coord', [
    { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
  ])
  const catalog = [keyArtifact('axis-a', 'hash-a', DIGEST_A), coordinate]
  const anchor = resolveRowSpaceAnchor(catalog, ['hash-a'], 'coord')

  it('is |theirs ∩ mine| / |mine| — the ANCHOR is the denominator, not the candidate', () => {
    // TEST-48. The candidate declares TWENTY members, six of which are the coordinate's ten.
    // Denominating on the anchor gives 6 of 10; denominating on the candidate gives 6 of 20.
    // Both are plausible; only one answers "how much of the picture in front of me".
    const candidate = membered('c', [
      { alignedTo: DIGEST_A, kind: 'subset', nMembers: 20, bitmap: MEMBERS_4_TO_23 },
    ])
    expect(describedRows(candidate.structure, anchor)).toEqual({ kind: 'ratio', described: 6, of: 10 })
  })

  it('`full` on the anchor’s axis needs NO member set — and is the common case', () => {
    const whole = membered('whole', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 1_000_000 }])
    expect(describedRows(whole.structure, anchor)).toEqual({ kind: 'full', of: 10 })
  })

  it('`undecidable` when an inline set is absent above ITEM-5’s budget — never a guess', () => {
    // Two counts are present (20 and 10) and an intersection is STILL not derivable from
    // them; the design says so explicitly. Estimating `min(20,10)` or `20/10` here would
    // produce a confident number nobody can justify.
    const overBudget = membered('over', [{ alignedTo: DIGEST_A, kind: 'subset', nMembers: 20 }])
    expect(describedRows(overBudget.structure, anchor)).toEqual({ kind: 'undecidable', of: 10 })
  })

  it('disjoint members are a REAL ZERO, not an undecidable', () => {
    const away = membered('away', [
      { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_100_TO_109 },
    ])
    expect(describedRows(away.structure, anchor)).toEqual({ kind: 'ratio', described: 0, of: 10 })
  })

  it('the question is NOT POSED where nobody stated the denominator — and that is not undecidable', () => {
    // Every project today: the coordinate declares the legacy scalar, which is a `full`
    // membership with no count. Nothing is printed, exactly as nothing is printed now.
    const legacyCoord = artifact('legacy-coord', {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'rows',
      aligned_to: DIGEST_A,
    })
    const legacyAnchor = resolveRowSpaceAnchor(
      [keyArtifact('axis-a', 'hash-a', DIGEST_A), legacyCoord],
      ['hash-a'],
      'legacy-coord',
    )
    const candidate = membered('c', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 5 }])
    expect(describedRows(candidate.structure, legacyAnchor)).toBeUndefined()
    // …and with no anchor at all, and with no coordinate named.
    expect(describedRows(candidate.structure, undefined)).toBeUndefined()
    expect(describedRows(candidate.structure, resolveRowSpaceAnchor(catalog, ['hash-a']))).toBeUndefined()
  })

  it('is computed from DECLARATIONS — a candidate declaring nothing on the axis describes none of it', () => {
    const elsewhere = membered('elsewhere', [{ alignedTo: DIGEST_B, kind: 'full', nMembers: 99 }])
    expect(describedRows(elsewhere.structure, anchor)).toEqual({ kind: 'ratio', described: 0, of: 10 })
  })
})

describe('TEST-13 — the sentence the row prints (ITEM-10)', () => {
  it('reads `describes N of M rows`, states the undecidable case in the same shape, and never says "coverage"', () => {
    const lines = [
      describedRowsLine({ kind: 'ratio', described: 6, of: 10 }),
      describedRowsLine({ kind: 'full', of: 12_500 }),
      describedRowsLine({ kind: 'undecidable', of: 10 }),
    ]
    expect(lines[0]).toBe('describes 6 of 10 rows')
    expect(lines[1]).toBe('describes all 12,500 rows')
    // Q3 ruled: suppress nothing. The undecidable row says so — it is neither blank nor a
    // computed guess — and it says it in the same shape, so the column of sentences scans.
    expect(lines[2]).toBe('describes some of 10 rows — how many is not declared')
    expect(lines.every(l => l !== undefined && l.startsWith('describes '))).toBe(true)
    // `alignmentCoverage.ts` already owns the word "coverage" in this pane for a DIFFERENT
    // quantity. A second one beside it is a defect in waiting.
    for (const line of lines) expect(line?.toLowerCase()).not.toContain('coverage')
    // The question not being posed is the one case that renders nothing at all.
    expect(describedRowsLine(undefined)).toBeUndefined()
  })
})

describe('gatherFor (ITEM-20) — WHEN a column has to be gathered before it can be painted', () => {
  const coordinate = membered('coord', [
    { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
  ])
  // The index BODY is what a gather reads; the inline set is only ever the offer-side answer.
  ;(coordinate.structure as { memberships: Array<Record<string, unknown>> }).memberships[0].members =
    'members'
  const catalog = [keyArtifact('axis-a', 'hash-a', DIGEST_A), coordinate]
  const anchor = resolveRowSpaceAnchor(catalog, ['hash-a'], 'coord')

  it('gathers a WHOLE-AXIS column at the coordinate’s member positions, off the COORDINATE', () => {
    const whole = membered('whole', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 1_000_000 }])
    expect(gatherFor('whole', whole.structure, anchor)).toEqual({
      segments: [
        {
          column: 'whole',
          alignedTo: DIGEST_A,
          // The index body lives on the COORDINATE, not on the column — the column has none,
          // which is precisely why it needs gathering.
          artifact: 'coord',
          member: 'members',
          count: 10,
          // ITEM-11 — the coordinate declared this membership first, and a gather's segments
          // are ranked by that and by nothing else.
          declaredOrder: 0,
        },
      ],
    })
  })

  it('gathers NOTHING when the lengths already agree, or when re-indexing would be wrong', () => {
    // Both `full` — a gather here is an identity permutation with a read attached.
    const fullAnchor = resolveRowSpaceAnchor(
      [keyArtifact('axis-a', 'hash-a', DIGEST_A), membered('c2', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 10 }])],
      ['hash-a'],
      'c2',
    )
    const whole = membered('whole', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 10 }])
    expect(gatherFor('whole', whole.structure, fullAnchor)).toBeUndefined()
    // The column ITSELF a subset — its rows are its own members, so indexing them by the
    // coordinate's axis-space positions is the off-by-thousands paint. Two subsets need the
    // correspondence, which is not a guess made here.
    const subset = membered('sub', [
      { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
    ])
    expect(gatherFor('sub', subset.structure, anchor)).toBeUndefined()
    // A coordinate with no index body — nothing to gather BY.
    const bodyless = resolveRowSpaceAnchor(
      [keyArtifact('axis-a', 'hash-a', DIGEST_A), membered('c3', [{ alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 }])],
      ['hash-a'],
      'c3',
    )
    expect(gatherFor('whole', whole.structure, bodyless)).toBeUndefined()
    // …and a legacy project asks for no gather at all, on any column.
    expect(gatherFor('whole', whole.structure, undefined)).toBeUndefined()
  })

  it('never gathers a column aligned ELSEWHERE — the axis is matched, never assumed', () => {
    const elsewhere = membered('elsewhere', [{ alignedTo: DIGEST_B, kind: 'full', nMembers: 99 }])
    expect(gatherFor('elsewhere', elsewhere.structure, anchor)).toBeUndefined()
  })
})

describe('correspondenceGather (ITEM-19) — one side per row space, at its OWN column index', () => {
  /** An INTEGRATED coordinate: a SUBSET of each of two axes, declared in this order. Both index
   *  bodies are named, because a gather reads the body and never the inline set. */
  const integrated = membered('coord2', [
    { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
    { alignedTo: DIGEST_B, kind: 'subset', nMembers: 4, bitmap: MEMBERS_0_TO_9 },
  ])
  ;(integrated.structure as { memberships: Array<Record<string, unknown>> }).memberships[0].members = 'mem-a'
  ;(integrated.structure as { memberships: Array<Record<string, unknown>> }).memberships[1].members = 'mem-b'
  const catalog2 = [
    keyArtifact('axis-a', 'hash-a', DIGEST_A),
    keyArtifact('axis-b', 'hash-b', DIGEST_B),
    integrated,
  ]
  const anchor2 = resolveRowSpaceAnchor(catalog2, ['hash-a', 'hash-b'], 'coord2')
  const wholeA = membered('mat-a', [{ alignedTo: DIGEST_A, kind: 'full', nMembers: 1_000 }])
  const wholeB = membered('mat-b', [{ alignedTo: DIGEST_B, kind: 'full', nMembers: 900 }])
  const sides: Record<string, { column: string; columnIndex: number; structure: unknown }> = {
    'hash-a': { column: 'mat-a', columnIndex: 3, structure: wholeA.structure },
    'hash-b': { column: 'mat-b', columnIndex: 11, structure: wholeB.structure },
  }

  it('builds one segment per row space, each naming its OWN parent and its OWN column index', () => {
    const gather = correspondenceGather(anchor2, axis => sides[axis])
    expect(gather?.segments.map(s => s.column)).toEqual(['mat-a', 'mat-b'])
    // THE INDICES DIFFER, and they are per SEGMENT. A per-gather selector would say the two
    // sides sit at the same index — full length, well typed, wrong for every row of side B.
    expect(gather?.segments.map(s => s.columnIndex)).toEqual([3, 11])
    // The membership triple comes off the COORDINATE, per axis, and the segment ORDER is the
    // coordinate's own declaration order (ITEM-11).
    expect(gather?.segments.map(s => s.member)).toEqual(['mem-a', 'mem-b'])
    expect(gather?.segments.map(s => s.count)).toEqual([10, 4])
    expect(gather?.segments.map(s => s.alignedTo)).toEqual([DIGEST_A, DIGEST_B])
    expect(gather?.segments.every(s => s.artifact === 'coord2')).toBe(true)
  })

  it('ranks by the coordinate`s DECLARED order, not by the order the sides were offered', () => {
    // The resolver may hand the sides over in any order; the row sequence is the coordinate's
    // statement about its own rows and is read from the statement.
    const reversed = resolveRowSpaceAnchor(catalog2, ['hash-b', 'hash-a'], 'coord2')
    const gather = correspondenceGather(reversed, axis => sides[axis])
    expect(gather?.segments.map(s => s.member)).toEqual(['mem-a', 'mem-b'])
  })

  it('is ALL OR NOTHING — a missing side, a non-`full` side, or a bodyless axis answers undefined', () => {
    // A row space with no side: the gather would cover part of the coordinate and be laid
    // against all of it.
    expect(correspondenceGather(anchor2, axis => (axis === 'hash-a' ? sides[axis] : undefined))).toBeUndefined()
    // A side that is itself a SUBSET of its axis — its rows are its own members, so indexing
    // them by the coordinate's axis-space positions is the off-by-thousands paint.
    const subsetB = membered('sub-b', [
      { alignedTo: DIGEST_B, kind: 'subset', nMembers: 4, bitmap: MEMBERS_0_TO_9 },
    ])
    expect(
      correspondenceGather(anchor2, axis =>
        axis === 'hash-b'
          ? { column: 'sub-b', columnIndex: 11, structure: subsetB.structure }
          : sides[axis],
      ),
    ).toBeUndefined()
    // A coordinate declaring `full` on one axis has no index body to gather BY there. It is a
    // real shape and it is REFUSED rather than approximated with an identity segment.
    const halfFull = membered('coord3', [
      { alignedTo: DIGEST_A, kind: 'subset', nMembers: 10, bitmap: MEMBERS_0_TO_9 },
      { alignedTo: DIGEST_B, kind: 'full', nMembers: 900 },
    ])
    ;(halfFull.structure as { memberships: Array<Record<string, unknown>> }).memberships[0].members = 'mem-a'
    const halfAnchor = resolveRowSpaceAnchor(
      [keyArtifact('axis-a', 'hash-a', DIGEST_A), keyArtifact('axis-b', 'hash-b', DIGEST_B), halfFull],
      ['hash-a', 'hash-b'],
      'coord3',
    )
    expect(correspondenceGather(halfAnchor, axis => sides[axis])).toBeUndefined()
    // …and no anchor at all, and an anchor with no chosen coordinate.
    expect(correspondenceGather(undefined, axis => sides[axis])).toBeUndefined()
    expect(correspondenceGather(resolveRowSpaceAnchor(catalog2, ['hash-a', 'hash-b']), axis => sides[axis])).toBeUndefined()
  })
})
