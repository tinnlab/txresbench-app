import { describe, it, expect } from 'vitest'
import type { ArtifactRefCandidate } from './axisSource'
import { groupCandidates, shouldShowGroups, UNGROUPED_LABEL } from './candidateGroups'

// Grouping IS the disambiguation, so these are behaviour rather than presentation: which options
// a user can tell apart, and whether the thing that tells them apart survives truncation.

const c = (over: Partial<ArtifactRefCandidate> & { id: string }): ArtifactRefCandidate => ({
  label: 'counts',
  datatype: 'demo/matrix',
  ...over,
})

describe('candidates group by the dataset they came from', () => {
  it('groups ALWAYS — not only when two labels collide', () => {
    // The old behaviour named the dataset only on a collision, so a user could not see which
    // dataset an option belonged to unless the system happened to notice a clash.
    const groups = groupCandidates([
      c({ id: 'a', label: 'counts', datasetId: 'ds1', datasetName: 'First' }),
      c({ id: 'b', label: 'filtered', datasetId: 'ds2', datasetName: 'Second' }),
    ])
    expect(groups.map(g => g.label)).toEqual(['First', 'Second'])
    expect(groups.map(g => g.candidates.map(x => x.id))).toEqual([['a'], ['b']])
  })

  it('keeps arrival order, for groups and within them', () => {
    // The resolver upstream chose an order with more context than this function has; re-sorting
    // here would silently override it.
    const groups = groupCandidates([
      c({ id: 'b1', datasetId: 'ds2', datasetName: 'Second' }),
      c({ id: 'a1', datasetId: 'ds1', datasetName: 'First' }),
      c({ id: 'b2', datasetId: 'ds2', datasetName: 'Second' }),
    ])
    expect(groups.map(g => g.label)).toEqual(['Second', 'First'])
    expect(groups[0].candidates.map(x => x.id)).toEqual(['b1', 'b2'])
  })

  it('gives artifacts with NO dataset a named group', () => {
    // Nullable in the schema and absent from some catalog reads, so a user meets this — and an
    // unlabelled group reads as a rendering bug.
    const groups = groupCandidates([c({ id: 'x' })])
    expect(groups[0].label).toBe(UNGROUPED_LABEL)
    expect(groups[0].datasetId).toBeUndefined()
  })

  it('keeps two datasets that SHARE a name apart', () => {
    // They are different datasets. Merging them on a display string is the same error as telling
    // two artifacts apart by one.
    const groups = groupCandidates([
      c({ id: 'a', datasetId: 'ds1', datasetName: 'Same' }),
      c({ id: 'b', datasetId: 'ds2', datasetName: 'Same' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('titles a dataset with no name by what IS known', () => {
    expect(groupCandidates([c({ id: 'a', datasetId: 'ds1' })])[0].label).toBe('ds1')
  })
})

describe('the heading is DRAWN wherever there is a group (ledger #8 / #16)', () => {
  it('shows the heading even when everything shares ONE dataset', () => {
    // REWRITTEN. This asserted the opposite — *"the heading would repeat on every row what is
    // true of all of them"* — and the owner rejected that twice: *"why there are no header for
    // Datasets?"* and *"didn't I tell you to group by dataset?"*. The suppression was an
    // assistant's addition, and the argument for it mistakes the heading for a discriminator
    // between the options; it is the answer to WHOSE DATA THIS IS, which a one-dataset project
    // needs as much as any other. It also contradicted this module's own stated rule, that
    // grouping is applied always and not on collision.
    expect(shouldShowGroups(groupCandidates([c({ id: 'a', datasetId: 'ds1', datasetName: 'One' })]))).toBe(true)
  })

  it('draws nothing for an EMPTY offer — a heading over no options claims a contribution', () => {
    expect(shouldShowGroups(groupCandidates([]))).toBe(false)
  })

  it('shows it as soon as there are two', () => {
    expect(
      shouldShowGroups(
        groupCandidates([
          c({ id: 'a', datasetId: 'ds1', datasetName: 'One' }),
          c({ id: 'b', datasetId: 'ds2', datasetName: 'Two' }),
        ]),
      ),
    ).toBe(true)
  })
})
