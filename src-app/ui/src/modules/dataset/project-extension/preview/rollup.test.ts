// Rolling several datasets' holdings into ONE set of groups, so a PROJECT-level
// summary can be composed by the same declared machinery a single dataset's is.
//
// ── Why this exists ────────────────────────────────────────────────────────────
//
// The project's datasets panel used to print `N datasets linked` and nothing else —
// an inventory count in this app's own storage vocabulary, built by a hardcoded
// template that never touched the contribution seam. It reads that way because the
// wire summary it was built on had denormalized per-axis total columns on the
// `datasets` row, those were deliberately dropped (a domain leak in the app's own
// schema), and the declared per-type previews that replaced them three weeks later
// were wired into the per-DATASET row and never into the rollup.
//
// So the rollup is not given its own vocabulary here. It is given the SAME groups
// the rows are given, merged, and handed to the SAME `describeSummary`.
//
// Every fixture id and key below is neutral (`probe/*`, `extents`) for the reason
// `summary.test.ts` gives: this code must work purely off what it is handed, so a
// fixture naming a real datatype would assert something it is not allowed to know.

import { describe, expect, it } from 'vitest'
import type { DatasetArtifactGroup, DatasetArtifactSummary } from '@/api-client/types'
import { DatasetPreviewRegistry } from './registry'
import { describeSummary, projectHoldings, rollupHoldings, type SummaryDeps } from './summary'

const TITLES: Record<string, string> = {
  'probe/matrix': 'Probe matrix',
  'probe/column': 'Probe column',
}

const deps = (registry = new DatasetPreviewRegistry()): SummaryDeps => ({
  lattice: { ancestors: () => [] },
  title: id => TITLES[id] ?? id,
  registry,
})

const group = (
  datatype: string,
  count: number,
  logical_bytes: number,
  structure: Record<string, unknown> = {},
  output = 'primary',
): DatasetArtifactGroup => ({
  datatype,
  count,
  logical_bytes,
  representative_output_id: output,
  representative_meta: {},
  representative_structure: structure,
})

const summary = (id: string, groups: DatasetArtifactGroup[], count?: number): DatasetArtifactSummary => ({
  dataset_id: id,
  artifact_count: count ?? groups.reduce((n, g) => n + g.count, 0),
  total_logical_bytes: groups.reduce((n, g) => n + g.logical_bytes, 0),
  groups,
})

/** A contribution that reads the representative's declared extents — the shape of
 *  thing a real package contributes, in neutral words. */
const dimensions = {
  datatype: 'probe/matrix',
  order: 10,
  phrase: (g: DatasetArtifactGroup) => {
    const extents = (g.representative_structure as { extents?: number[] } | undefined)?.extents
    return extents?.length === 2 ? `${extents[0]} rows x ${extents[1]} spans` : null
  },
}
const counted = {
  datatype: 'probe/column',
  order: 20,
  phrase: (g: DatasetArtifactGroup) => `${g.count} probe columns`,
}

describe('rollupHoldings', () => {
  it('is null for no datasets at all — the caller renders no line, not an empty one', () => {
    expect(rollupHoldings([])).toBeNull()
  })

  it('is a rollup of ONE dataset that is that dataset, unchanged', () => {
    // The identity case has to hold or every multi-dataset assertion is about a
    // transform nobody can check against a known-good.
    const s = summary('d1', [group('probe/matrix', 1, 4096, { extents: [3460, 32738] })])
    expect(rollupHoldings([s])).toEqual({
      groups: s.groups,
      artifact_count: 1,
      total_logical_bytes: 4096,
    })
  })

  it('sums counts and bytes per datatype across datasets', () => {
    const rolled = rollupHoldings([
      summary('d1', [group('probe/column', 63, 2000), group('probe/matrix', 1, 4096)]),
      summary('d2', [group('probe/column', 7, 500)]),
    ])
    const col = rolled?.groups.find(g => g.datatype === 'probe/column')
    expect(col?.count).toBe(70)
    expect(col?.logical_bytes).toBe(2500)
    expect(rolled?.artifact_count).toBe(71)
    expect(rolled?.total_logical_bytes).toBe(6596)
  })

  // The rollup applies the server's representative rule one level up, via
  // `preferredGroup` — best-declared, then the larger contributor, then a total order.
  // It is emphatically NOT "whichever dataset holds more bytes", which is what it used
  // to be; the rule itself is pinned in `core/workstore/representative.test.ts`, and
  // what these two pin is that the rollup DELEGATES to it.
  it('keeps the BEST-DECLARED contributor as the representative, not the biggest', () => {
    // The heavy group is bigger by 9x and declares nothing; the light one declares the
    // extents a contribution actually reads. A rollup still keyed on `size_bytes` picks
    // `heavy` here and the phrase goes silent.
    const heavy = group('probe/matrix', 1, 9_000, {}, 'heavy')
    const declared = group('probe/matrix', 1, 1_000, { extents: [3460, 32738] }, 'declared')
    for (const input of [
      [summary('d1', [heavy]), summary('d2', [declared])],
      [summary('d1', [declared]), summary('d2', [heavy])],
    ]) {
      const g = rollupHoldings(input)?.groups[0]
      expect(g?.representative_output_id).toBe('declared')
      expect(g?.representative_structure).toEqual({ extents: [3460, 32738] })
      // The totals are unaffected by which representative won — both rows still count.
      expect(g?.count).toBe(2)
      expect(g?.logical_bytes).toBe(10_000)
    }
  })

  it('settles equally-declared contributors by COUNT, and is order-independent', () => {
    const few = group('probe/matrix', 1, 9_000, { extents: [10, 20] }, 'few')
    const many = group('probe/matrix', 12, 1_000, { extents: [3460, 32738] }, 'many')
    for (const input of [
      [summary('d1', [few]), summary('d2', [many])],
      [summary('d1', [many]), summary('d2', [few])],
    ]) {
      const g = rollupHoldings(input)?.groups[0]
      expect(g?.representative_output_id).toBe('many')
      expect(g?.representative_structure).toEqual({ extents: [3460, 32738] })
    }
  })

  it('orders groups most-numerous first, as the per-dataset read does', () => {
    const rolled = rollupHoldings([
      summary('d1', [group('probe/matrix', 1, 9000)]),
      summary('d2', [group('probe/column', 63, 100)]),
    ])
    expect(rolled?.groups.map(g => g.datatype)).toEqual(['probe/column', 'probe/matrix'])
  })

  it('carries the artifacts BEYOND the per-dataset group cap into the total', () => {
    // `artifact_count` counts every artifact, `groups` is capped. Summing the groups
    // instead of the counts would silently drop the tail, and `remainderText` — which
    // is the only thing that reports it — would go quiet.
    const rolled = rollupHoldings([
      summary('d1', [group('probe/column', 2, 10)], 99),
      summary('d2', [group('probe/column', 3, 10)], 4),
    ])
    expect(rolled?.artifact_count).toBe(103)
    expect(describeSummary(rolled, deps())?.line).toContain('+98 more')
  })
})

describe('projectHoldings — which datasets the header is allowed to speak for', () => {
  const mine = summary('mine', [group('probe/matrix', 1, 9000, { extents: [3460, 32738] })])
  const someoneElses = summary('other', [group('probe/column', 999, 1)])
  const map = new Map([
    ['mine', mine],
    ['other', someoneElses],
  ])

  it('is null while the batched read has not landed', () => {
    expect(projectHoldings(null, ['mine'], 1)).toBeNull()
  })

  it('rolls up ONLY the project’s linked datasets, not everything the read returned', () => {
    // The batched read covers every dataset the USER can see. Rolling up the whole map
    // would put another project's datasets in this project's header — and it would look
    // entirely plausible, which is what makes it worth a test.
    const h = projectHoldings(map, ['mine'], 1)
    expect(h?.groups.map(g => g.datatype)).toEqual(['probe/matrix'])
    expect(h?.artifact_count).toBe(1)
  })

  it('refuses to summarise a PARTIAL page as if it were the project', () => {
    // The linked list is paged. 1 of 4 loaded is not "the project holds one matrix".
    expect(projectHoldings(map, ['mine'], 4)).toBeNull()
    // POSITIVE CONTROL: the same map with the page complete does answer, so the null
    // above is about completeness and not about the fixture.
    expect(projectHoldings(map, ['mine'], 1)).not.toBeNull()
  })

  it('is null for a project with no linked datasets — no line, not an empty one', () => {
    expect(projectHoldings(map, [], 0)).toBeNull()
  })

  it('treats a linked dataset absent from a landed read as holding nothing', () => {
    // DEC-3: the response is complete when it arrives, so absence is unambiguously
    // zero. It must not suppress the whole line.
    const h = projectHoldings(map, ['mine', 'never-counted'], 2)
    expect(h?.artifact_count).toBe(1)
  })
})

describe('a project rollup composes through the SAME declared machinery', () => {
  const registry = () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions)
    r.register(counted)
    return r
  }

  it('names the declared size, in the contributing package’s own words', () => {
    // The whole point. A rollup that reaches this seam says what the packages say; a
    // hardcoded phrase cannot, which is the defect this replaces.
    const rolled = rollupHoldings([
      summary('d1', [group('probe/matrix', 1, 9000, { extents: [3460, 32738] })]),
      summary('d2', [group('probe/column', 63, 100)]),
    ])
    expect(describeSummary(rolled, deps(registry()))?.line).toBe(
      '3460 rows x 32738 spans · 63 probe columns',
    )
  })

  it('falls back to count-and-title for a datatype nobody contributes for', () => {
    const rolled = rollupHoldings([summary('d1', [group('probe/column', 5, 10)])])
    expect(describeSummary(rolled, deps())?.line).toBe('5 Probe column')
  })

  it('a contribution that cannot read the merged representative DECLINES, it does not invent', () => {
    // NEGATIVE CONTROL for the merge: strip the declarations and the phrase must
    // disappear rather than render half a sentence.
    const rolled = rollupHoldings([summary('d1', [group('probe/matrix', 2, 9000)])])
    expect(describeSummary(rolled, deps(registry()))?.line).toBe('2 Probe matrix')
  })
})
