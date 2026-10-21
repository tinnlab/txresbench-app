import { describe, it, expect } from 'vitest'

import {
  PROJECT_PRODUCED_LABEL,
  sharesSourceDataset,
  sourceDatasetGroupKey,
  sourceDatasetIds,
  sourceDatasetLabel,
  sourceDatasetNames,
  sourceDatasetsLabel,
} from './sourceDataset'
import type { ArtifactRefCandidate } from '@/modules/workbench/core/runtime/axisSource'
import { groupCandidates } from '@/modules/workbench/core/runtime/candidateGroups'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { groupRowsByDataset } from '@/modules/workbench/extensions/widgets/form/fields/artifactLabel'
import type { ListedArtifact } from '@/api-client/types'
import { groupArtifactsByScope } from '@/modules/workstore/project-extension/grouping'

// The invariant this file exists for: THREE surfaces group a project's artifacts by
// dataset, and a user must read ONE sentence for the bucket that has no dataset. This
// asserts it on the OUTPUT of all three grouping functions rather than on their
// constants, because a shared constant nobody calls proves nothing — the surfaces could
// each import it and still label a group by hand.
//
// It lives here, beside the shared vocabulary, rather than inside any one of the three:
// the property is BETWEEN them, so a test owned by one of them cannot see it break.

const candidate = (over: Partial<ArtifactRefCandidate> & { id: string }): ArtifactRefCandidate => ({
  label: 'counts',
  datatype: 'demo/matrix',
  ...over,
})

const row = (over: Partial<ArtifactRow>): ArtifactRow => ({
  id: 'a1',
  project_id: 'p1',
  // A placeholder id no package speaks for: what is under test is the GROUPING, never a
  // vocabulary this app is not entitled to carry.
  datatype: 'ns/alpha',
  structure: { encoding: 'opaque', media_type: 'application/json' },
  created_at: '2026-07-16T12:00:00Z',
  ...over,
})

const listed = (over: Partial<ListedArtifact>): ListedArtifact =>
  ({
    id: 'l1',
    project_id: 'p1',
    datatype: 'ns/alpha',
    structure: { encoding: 'opaque', media_type: 'application/json' },
    created_at: '2026-07-16T12:00:00Z',
    logical_bytes: 1,
    ...over,
  }) as ListedArtifact

describe('the two LINEAGE surfaces say the same sentence; the SCOPE surface does not', () => {
  it('both artifact pickers agree — they group by the same key and mean the same thing', () => {
    // One fact, one sentence. Before this was unified the multi-select picker said
    // "No source dataset" while the other two said "Produced in this project", so which
    // description a user got depended on which picker they opened. That unification still
    // stands for the two surfaces it was actually about.
    const fromRefPicker = groupCandidates([candidate({ id: 'a' })])[0].label
    const fromMultiSelect = groupRowsByDataset([row({})])[0].label

    expect(fromRefPicker).toBe(PROJECT_PRODUCED_LABEL)
    expect(fromMultiSelect).toBe(PROJECT_PRODUCED_LABEL)
  })

  it('the Artifacts pane does NOT — its empty bucket is a different claim (ITEM-48)', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right when it was written. The
    // three surfaces were unified because one fact was being described by two sentences.
    // What changed is that it stopped being one fact:
    //
    //   · the two PICKERS group by LINEAGE (`source_dataset_id`). Empty means no dataset
    //     fed this artifact, and "a run in this project made it" is true and useful.
    //   · the PANE groups by SCOPE (`dataset_id`). Under DEC-C/ITEM-47 empty means the
    //     subject dataset could not be DERIVED — the row is unassigned, and claiming the
    //     project produced it asserts a provenance nobody established.
    //
    // So the agreement is retired deliberately, not eroded. Keeping it would have made
    // the pane keep lying in order to keep a test green — the shape where a shipped bug
    // has a PASSING test asserting it.
    const fromPane = groupArtifactsByScope([listed({})])[0].label
    expect(fromPane).not.toBe(PROJECT_PRODUCED_LABEL)
    expect(fromPane.toLowerCase()).not.toContain('project')
  })

  it('never claims THIS project produced an artifact that has a dataset', () => {
    // The unified sentence is an assertion, not a shrug, so it must be true wherever it
    // appears. A dataset whose NAME did not travel is still a dataset: the group is
    // titled by the id. (The multi-select picker used to drop such a row into its
    // no-source bucket, which the old vague wording hid and the new wording would lie
    // about.)
    expect(groupCandidates([candidate({ id: 'a', datasetId: 'ds1' })])[0].label).toBe('ds1')
    expect(groupRowsByDataset([row({ source_dataset_id: 'ds1' })])[0].label).toBe('ds1')
    expect(groupArtifactsByScope([listed({ dataset_id: 'ds1' })])[0].label).toBe('ds1')
  })
})

describe('the sentence itself', () => {
  it('says what the artifacts ARE, not that a field is absent', () => {
    // Pinned as a literal on purpose. The consistency test above only proves the three
    // surfaces AGREE — flip this one constant and all three change together, silently,
    // and the copy regresses to the "No source dataset" phrasing this unification
    // deliberately retired. The choice is argued in `sourceDataset.ts`; changing it means
    // editing that argument and this line, which is exactly the visibility it needs.
    expect(PROJECT_PRODUCED_LABEL).toBe('Produced in this project')
  })
})

describe('sourceDatasetLabel', () => {
  it('prefers the name, falls back to the id, and only then to the project sentence', () => {
    expect(sourceDatasetLabel('ds1', 'Batch A')).toBe('Batch A')
    expect(sourceDatasetLabel('ds1', null)).toBe('ds1')
    expect(sourceDatasetLabel('ds1', undefined)).toBe('ds1')
    expect(sourceDatasetLabel(null, null)).toBe(PROJECT_PRODUCED_LABEL)
    expect(sourceDatasetLabel(undefined, undefined)).toBe(PROJECT_PRODUCED_LABEL)
  })

  it('treats a name with no id as a named dataset, not as ungrouped', () => {
    // The two fields are independently nullable; a name is still a name.
    expect(sourceDatasetLabel(null, 'Batch A')).toBe('Batch A')
  })
})

// ── MULTI-SOURCE ────────────────────────────────────────────────────────────────
//
// An artifact that integrated two datasets is of BOTH. The wire used to answer "which
// dataset?" with the first-declared one, so it read as "Dataset 1" — confidently, decided
// by nothing but the order the producing run recorded its edges.
//
// Every case below carries TWO sources and names both halves, so an implementation that
// went back to picking one cannot pass by accident.

describe('sourceDatasetIds / sourceDatasetNames', () => {
  it('reads the set when the row carries one', () => {
    expect(sourceDatasetIds({ source_dataset_ids: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(sourceDatasetNames({ source_dataset_names: ['A', 'B'] })).toEqual(['A', 'B'])
  })

  it('falls back to the singular field — a row carrying only it IS single-source', () => {
    // The project OVERVIEW endpoint cannot carry the derived lineage at all, so "no array"
    // must not be read as "no dataset".
    expect(sourceDatasetIds({ source_dataset_id: 'a' })).toEqual(['a'])
    expect(sourceDatasetNames({ source_dataset_name: 'A' })).toEqual(['A'])
  })

  it('is empty when nothing is carried', () => {
    expect(sourceDatasetIds({})).toEqual([])
    expect(sourceDatasetIds({ source_dataset_ids: [], source_dataset_id: null })).toEqual([])
  })
})

describe('sourceDatasetsLabel', () => {
  it('reads exactly like the single-source label when there is one source', () => {
    expect(sourceDatasetsLabel({ source_dataset_ids: ['ds1'], source_dataset_names: ['Batch A'] })).toBe(
      'Batch A',
    )
    expect(sourceDatasetsLabel({ source_dataset_id: 'ds1' })).toBe('ds1')
    expect(sourceDatasetsLabel({})).toBe(PROJECT_PRODUCED_LABEL)
  })

  it('names BOTH datasets of a two-source artifact — never one of them', () => {
    const label = sourceDatasetsLabel({
      source_dataset_ids: ['ds1', 'ds2'],
      source_dataset_names: ['Dataset 1', 'Dataset 2'],
    })
    expect(label).toBe('Dataset 1 + Dataset 2')
    // The decisive half: the old answer was exactly the first name, alone.
    expect(label).not.toBe('Dataset 1')
  })

  it('elides beyond two with a COUNT, so "more than shown" stays distinguishable from "one"', () => {
    expect(
      sourceDatasetsLabel({
        source_dataset_ids: ['ds1', 'ds2', 'ds3'],
        source_dataset_names: ['Dataset 1', 'Dataset 2', 'Dataset 3'],
      }),
    ).toBe('Dataset 1 + 2 more')
  })

  it('counts a source whose dataset was DELETED, even though it cannot be named', () => {
    // Names may be shorter than ids; the total must still come from the ids, or a deleted
    // dataset would silently reduce a two-source artifact to a one-source claim.
    expect(sourceDatasetsLabel({ source_dataset_ids: ['ds1', 'ds2'], source_dataset_names: ['Dataset 1'] })).toBe(
      'Dataset 1 + 1 more',
    )
  })
})

describe('sourceDatasetGroupKey', () => {
  it('keys on the SET, so an integration is its own group and not filed under either source', () => {
    const both = sourceDatasetGroupKey({ source_dataset_ids: ['ds1', 'ds2'] })
    expect(both).not.toBe(sourceDatasetGroupKey({ source_dataset_ids: ['ds1'] }))
    expect(both).not.toBe(sourceDatasetGroupKey({ source_dataset_ids: ['ds2'] }))
  })

  it('two artifacts integrating the same datasets group together', () => {
    expect(sourceDatasetGroupKey({ source_dataset_ids: ['ds1', 'ds2'] })).toBe(
      sourceDatasetGroupKey({ source_dataset_ids: ['ds1', 'ds2'] }),
    )
  })
})

describe('sharesSourceDataset', () => {
  it('is plain equality for single-source rows on both sides', () => {
    expect(sharesSourceDataset({ source_dataset_id: 'a' }, { source_dataset_id: 'a' })).toBe(true)
    expect(sharesSourceDataset({ source_dataset_id: 'a' }, { source_dataset_id: 'b' })).toBe(false)
  })

  it('an integration shares with EITHER of its sources', () => {
    const both = { source_dataset_ids: ['a', 'b'] }
    expect(sharesSourceDataset(both, { source_dataset_id: 'a' })).toBe(true)
    expect(sharesSourceDataset(both, { source_dataset_id: 'b' })).toBe(true)
    expect(sharesSourceDataset({ source_dataset_id: 'b' }, both)).toBe(true)
  })

  it('shares nothing with a dataset it did not come from', () => {
    expect(sharesSourceDataset({ source_dataset_ids: ['a', 'b'] }, { source_dataset_id: 'c' })).toBe(false)
  })

  it('an unknown lineage matches NOTHING — not even another unknown', () => {
    expect(sharesSourceDataset({}, {})).toBe(false)
    expect(sharesSourceDataset({}, { source_dataset_id: 'a' })).toBe(false)
  })
})

describe('the picker groups a two-source artifact honestly', () => {
  it('gives it its OWN group, titled by both datasets', () => {
    const groups = groupRowsByDataset([
      row({ id: 'a', source_dataset_ids: ['ds1'], source_dataset_names: ['Dataset 1'] }),
      row({
        id: 'b',
        source_dataset_ids: ['ds1', 'ds2'],
        source_dataset_names: ['Dataset 1', 'Dataset 2'],
      }),
    ])
    expect(groups.map(g => g.label).sort()).toEqual(['Dataset 1', 'Dataset 1 + Dataset 2'])
    // Not merged into "Dataset 1" — which is what filing it under its first source would do.
    expect(groups.find(g => g.label === 'Dataset 1')?.rows.map(r => r.id)).toEqual(['a'])
    // And no group claims a single dataset id for it.
    expect(groups.find(g => g.label === 'Dataset 1 + Dataset 2')?.datasetId).toBeNull()
    expect(groups.find(g => g.label === 'Dataset 1 + Dataset 2')?.datasetIds).toEqual(['ds1', 'ds2'])
  })

  it('the candidate picker does the same', () => {
    const groups = groupCandidates([
      candidate({ id: 'a', datasetIds: ['ds1'], datasetNames: ['Dataset 1'], datasetId: 'ds1', datasetName: 'Dataset 1' }),
      candidate({ id: 'b', datasetIds: ['ds1', 'ds2'], datasetNames: ['Dataset 1', 'Dataset 2'] }),
    ])
    expect(groups.map(g => g.label)).toEqual(['Dataset 1', 'Dataset 1 + Dataset 2'])
    expect(groups[1].candidates.map(c => c.id)).toEqual(['b'])
  })
})
