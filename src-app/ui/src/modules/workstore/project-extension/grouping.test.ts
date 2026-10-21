// The Artifacts pane's two pure decisions: WHERE a listed row belongs, and WHAT a
// group of rows of one datatype SAYS.
//
// Nothing here writes a datatype id or a display word of its own — the ids are
// placeholders (`ns/…`), the titles arrive through the injected resolver and the
// phrases through a registry this file builds, so what is under test is the app's
// arithmetic and its sorting, never a vocabulary the app is not entitled to.

import { describe, expect, it } from 'vitest'
import type { ListedArtifact } from '@/api-client/types'
import { DatasetPreviewRegistry, type SummaryDeps } from '@/modules/dataset/project-extension/preview'
import {
  UNASSIGNED_SCOPE_LABEL,
  describeReadiness,
  describeTypeSections,
  groupArtifactsByScope,
  typeGroupOf,
} from './grouping'

const A = 'ns/alpha'
const B = 'ns/beta'

let seq = 0
function row(partial: Partial<ListedArtifact> = {}): ListedArtifact {
  seq += 1
  return {
    id: `id-${seq}`,
    content_hash: `sha256:${seq}`,
    created_at: '2026-07-15T00:00:00Z',
    datatype: A,
    hidden: false,
    is_multifile: false,
    meta: {},
    object_key: `key-${seq}`,
    output_id: `out-${seq}`,
    role: 'artifact',
    // 0 stored bytes with a non-zero LOGICAL size is the gathered shape, and it is
    // the default here on purpose: any consumer that reads `stored_bytes` as a
    // display size sees 0 and fails these assertions instead of passing quietly.
    stored_bytes: 0,
    logical_bytes: 1,
    status: 'ready',
    structure: {},
    updated_at: '2026-07-15T00:00:00Z',
    // The wire always carries the source-dataset SET; a fixture that omitted it would be a
    // row no endpoint can produce. `...partial` still overrides it where a case needs to.
    source_dataset_ids: partial.source_dataset_id ? [partial.source_dataset_id] : [],
    source_dataset_names: partial.source_dataset_name ? [partial.source_dataset_name] : [],
    ...partial,
  }
}

function depsWith(
  registry: DatasetPreviewRegistry,
  titles: Record<string, string> = {},
): SummaryDeps {
  return {
    lattice: { ancestors: () => [] },
    title: (id: string) => titles[id] ?? id,
    registry,
  }
}

// ── WHERE a row belongs ─────────────────────────────────────────────────────────

describe('groupArtifactsByScope', () => {
  it('puts a dataset-scoped row under its dataset, titled by the name the row carries', () => {
    const groups = groupArtifactsByScope([
      row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
      row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].datasetId).toBe('ds1')
    expect(groups[0].label).toBe('Batch One')
    expect(groups[0].artifacts).toHaveLength(2)
  })

  it('puts a row with no dataset scope in the UNASSIGNED bucket', () => {
    const groups = groupArtifactsByScope([row({ project_id: 'p1' })])
    expect(groups).toHaveLength(1)
    expect(groups[0].datasetId).toBeNull()
    expect(groups[0].label).toBe(UNASSIGNED_SCOPE_LABEL)
  })

  it('titles a dataset group by its id when no name travelled — never blank', () => {
    const groups = groupArtifactsByScope([row({ dataset_id: 'ds9' })])
    expect(groups[0].label).toBe('ds9')
  })

  it('keeps two datasets that share a name apart', () => {
    const groups = groupArtifactsByScope([
      row({ dataset_id: 'ds1', source_dataset_name: 'Same' }),
      row({ dataset_id: 'ds2', source_dataset_name: 'Same' }),
    ])
    expect(groups.map(g => g.datasetId)).toEqual(['ds1', 'ds2'])
  })

  it('orders groups by first appearance, so the server keeps its say', () => {
    const groups = groupArtifactsByScope([
      row({ project_id: 'p1' }),
      row({ dataset_id: 'ds2', source_dataset_name: 'Two' }),
      row({ dataset_id: 'ds1', source_dataset_name: 'One' }),
      row({ dataset_id: 'ds2', source_dataset_name: 'Two' }),
    ])
    expect(groups.map(g => g.label)).toEqual([UNASSIGNED_SCOPE_LABEL, 'Two', 'One'])
  })

  // ── the two rows the schema permits and the convention forbids ────────────────
  //
  // `project_id` and `dataset_id` are both nullable and there is NO CHECK: a row with
  // both, or with neither, is storable today. The rule is stated once — the DATASET
  // scope decides — so both fall out of it with no branch, and neither can be dropped.

  it('puts a row scoped to BOTH under its dataset', () => {
    const groups = groupArtifactsByScope([
      row({ project_id: 'p1', dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].datasetId).toBe('ds1')
  })

  it('puts a row scoped to NEITHER in the UNASSIGNED bucket', () => {
    const groups = groupArtifactsByScope([row({})])
    expect(groups).toHaveLength(1)
    expect(groups[0].datasetId).toBeNull()
    expect(groups[0].label).toBe(UNASSIGNED_SCOPE_LABEL)
  })

  // ── ITEM-48 — the no-dataset bucket is an ABSENCE, not a category ──────────────
  //
  // It used to be titled "Produced in this project", the same sentence the two artifact
  // PICKERS use for their own ungrouped bucket. That unification was right while both
  // buckets meant one thing. They no longer do, and this is the split-the-bucket rule
  // (`BASE.md`) applied to a LABEL rather than to an error:
  //
  //   · the pickers key on LINEAGE (`source_dataset_id`). Empty there means "no dataset
  //     fed this" — and "a run in this project made it" is a true, useful thing to say.
  //   · this pane keys on SCOPE (`dataset_id`). After DEC-C/ITEM-47 an empty scope means
  //     "the subject dataset could not be DERIVED" — the row is unassigned, and saying
  //     "produced in this project" asserts a provenance nobody established.
  //
  // Two claims, one sentence, and the sentence is false for this pane's members. So the
  // words fork here while `PROJECT_PRODUCED_LABEL` stays exactly as it is for the pickers.

  it('does not call the no-dataset bucket "Produced in this project"', () => {
    const groups = groupArtifactsByScope([row({ project_id: 'p1' })])
    expect(groups[0].datasetId).toBeNull()
    // The literal, not the constant: what is forbidden is the SENTENCE A READER SEES, so
    // re-pointing the constant at the same words must not make this pass.
    expect(groups[0].label).not.toBe('Produced in this project')
  })

  it('keys the no-dataset bucket as UNASSIGNED, so its testid does not read as a scope', () => {
    const groups = groupArtifactsByScope([row({ project_id: 'p1' })])
    expect(groups[0].key).toBe('unassigned')
  })

  it('says the bucket is an absence — it names no dataset and claims no producer', () => {
    const label = groupArtifactsByScope([row({ project_id: 'p1' })])[0].label.toLowerCase()
    // A heading that reads as a category is the defect; one that reads as "we do not know
    // what this is about" is the fix. Asserted as a property of the words rather than as
    // an exact string, so a better sentence is free to replace this one.
    expect(label).toContain('no dataset')
    expect(label).not.toContain('project')
  })

  // POSITIVE CONTROL for the three above. Without it they would pass just as well against
  // a `groupArtifactsByScope` that returned garbage for every input — "not that string" is
  // satisfied by nonsense. This one pins that the dataset arm still works, unchanged.
  it('still titles a DATASET group by its name — the change is to the empty bucket only', () => {
    const groups = groupArtifactsByScope([
      row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    ])
    expect(groups[0].key).toBe('ds1')
    expect(groups[0].label).toBe('Batch One')
  })

  it('never drops a row, whatever its scope', () => {
    const input = [
      row({ dataset_id: 'ds1' }),
      row({ project_id: 'p1' }),
      row({ project_id: 'p1', dataset_id: 'ds1' }),
      row({}),
    ]
    const seen = groupArtifactsByScope(input).flatMap(g => g.artifacts.map(a => a.id))
    expect(seen.sort()).toEqual(input.map(a => a.id).sort())
  })
})

// ── WHAT a group of one datatype says ───────────────────────────────────────────

describe('typeGroupOf', () => {
  it('counts the rows and sums their size', () => {
    const g = typeGroupOf([row({ logical_bytes: 3 }), row({ logical_bytes: 4 })])
    expect(g.count).toBe(2)
    expect(g.logical_bytes).toBe(7)
  })

  // The rule itself is `representativeOf` and is pinned in `core/workstore/
  // representative.test.ts` (including the negative control that size no longer
  // decides). What matters HERE is only that this pane DELEGATES to it rather than
  // re-deciding — a client-side group answering differently from the endpoint's would
  // put two representatives on screen for one set of rows.
  it("represents the group by the server's rule — the best-declared row, not the biggest", () => {
    const g = typeGroupOf([
      row({ logical_bytes: 9, output_id: 'large', structure: {} }),
      row({ logical_bytes: 1, output_id: 'small', structure: { rank: 1 } }),
    ])
    expect(g.representative_output_id).toBe('small')
    expect(g.representative_structure).toEqual({ rank: 1 })
  })

  it('is deterministic under a full tie, and independent of input order', () => {
    const first = row({ id: 'id-zzz', logical_bytes: 5, output_id: 'z' })
    const second = row({ id: 'id-aaa', logical_bytes: 5, output_id: 'a' })
    expect(typeGroupOf([first, second]).representative_output_id).toBe('a')
    expect(typeGroupOf([second, first]).representative_output_id).toBe('a')
  })

  // The POPULATION control (task #148). This pane counts what is THERE, while the
  // server's totals count what is USABLE — a deliberate difference, and the reason
  // `describeReadiness` exists to state it on screen. Pinning it here is what stops a
  // future "make the numbers match" from quietly deleting the pane's job.
  it('counts EVERY row it was given, including ones the server total excludes', () => {
    const g = typeGroupOf([
      row({ logical_bytes: 10, status: 'ready', role: 'artifact' }),
      row({ logical_bytes: 100, status: 'failed', role: 'artifact' }),
      row({ logical_bytes: 1000, status: 'ready', role: 'intermediate' }),
    ])
    expect(g.count).toBe(3)
    expect(g.logical_bytes).toBe(1110)
  })
})

describe('describeTypeSections', () => {
  it("shows the datatype's DECLARED TITLE, never its raw id", () => {
    const sections = describeTypeSections([row({ datatype: A })], depsWith(new DatasetPreviewRegistry(), { [A]: 'Alpha thing' }))
    expect(sections.map(s => s.title)).toEqual(['Alpha thing'])
    expect(sections[0].summary).not.toContain(A)
  })

  it('falls back to the raw id when the registry has never heard of the datatype', () => {
    const sections = describeTypeSections([row({ datatype: A })], depsWith(new DatasetPreviewRegistry()))
    expect(sections[0].title).toBe(A)
  })

  it("uses the owning package's phrase when one is contributed", () => {
    const registry = new DatasetPreviewRegistry()
    registry.register({
      datatype: A,
      order: 10,
      phrase: (group, title) => `${group.count} of ${title}, widest ${group.representative_output_id}`,
    })
    const sections = describeTypeSections(
      [
        row({ datatype: A, logical_bytes: 1, output_id: 'thin' }),
        row({ datatype: A, logical_bytes: 9, output_id: 'wide', structure: { dims: [2] } }),
      ],
      depsWith(registry, { [A]: 'Alpha thing' }),
    )
    expect(sections[0].summary).toBe('2 of Alpha thing, widest wide')
    expect(sections[0].contributed).toBe(true)
  })

  it('falls back to a count and the declared title when nothing contributes', () => {
    const sections = describeTypeSections(
      [row({ datatype: A }), row({ datatype: A })],
      depsWith(new DatasetPreviewRegistry(), { [A]: 'Alpha thing' }),
    )
    expect(sections[0].summary).toBe('2 Alpha thing')
    expect(sections[0].contributed).toBe(false)
  })

  it('sorts sections by the order their packages DECLARED', () => {
    const registry = new DatasetPreviewRegistry()
    registry.register({ datatype: A, order: 90, phrase: g => `A${g.count}` })
    registry.register({ datatype: B, order: 10, phrase: g => `B${g.count}` })
    const sections = describeTypeSections(
      [row({ datatype: A }), row({ datatype: B })],
      depsWith(registry),
    )
    expect(sections.map(s => s.datatype)).toEqual([B, A])
  })

  it('breaks a tie the way the server does — more rows first, then by id', () => {
    const sections = describeTypeSections(
      [row({ datatype: A }), row({ datatype: B }), row({ datatype: B })],
      depsWith(new DatasetPreviewRegistry()),
    )
    expect(sections.map(s => s.datatype)).toEqual([B, A])
  })

  it('survives a contribution that throws, and still says something true', () => {
    const registry = new DatasetPreviewRegistry()
    registry.register({
      datatype: A,
      order: 10,
      phrase: () => {
        throw new Error('a package display bug')
      },
    })
    const sections = describeTypeSections([row({ datatype: A })], depsWith(registry, { [A]: 'Alpha thing' }))
    expect(sections[0].summary).toBe('1 Alpha thing')
  })

  it('never drops a row', () => {
    const input = [row({ datatype: A }), row({ datatype: B }), row({ datatype: A })]
    const seen = describeTypeSections(input, depsWith(new DatasetPreviewRegistry())).flatMap(s =>
      s.artifacts.map(a => a.id),
    )
    expect(seen.sort()).toEqual(input.map(a => a.id).sort())
  })
})

// ── WHY the pane's number and the dataset summary's number differ ────────────────
//
// Both surfaces are individually right (the summary describes what is USABLE, the pane
// shows what is THERE); the defect was that the same datatype reported two numbers with
// nothing on screen accounting for the gap. These pin the account.

describe('describeReadiness', () => {
  it('says nothing when every row is a ready artifact — the two numbers then agree', () => {
    // The qualifier's PRESENCE is the signal "these will not match", so it must be absent
    // exactly when they do. `usable` still reports, so a caller can compare without it.
    const r = describeReadiness([row({}), row({})])
    expect(r).toEqual({ usable: 2, total: 2, text: null, detail: null })
  })

  it('breaks the count down when the rows are not all usable', () => {
    const r = describeReadiness([row({}), row({}), row({}), row({ status: 'failed' })])
    expect(r.text).toBe('3 ready · 1 failed')
    expect(r.usable).toBe(3)
    expect(r.total).toBe(4)
  })

  it('counts exactly what the endpoint counts as usable, and nothing else', () => {
    // The endpoint's predicate is `status='ready' AND NOT hidden AND role='artifact'`
    // (`dataset/repository.rs`). `hidden` is not represented: this pane's own read drops
    // those rows server-side, so they are never among the rows passed here.
    const r = describeReadiness([
      row({}),
      row({ status: 'pending' }),
      row({ status: 'failed' }),
      row({ role: 'intermediate' }),
    ])
    expect(r.usable).toBe(1)
    expect(r.text).toBe('1 ready · 1 pending · 1 failed · 1 intermediate')
  })

  // ITEM-41 — `unresolvable` is a RANKED bucket of its own.
  //
  // Before this it was absent from BUCKET_ORDER, so it still rendered (an unrecognised
  // status gets its own bucket named by the raw word) but sorted LAST, after
  // `intermediate` — i.e. the omission was purely presentational, which is exactly why
  // nobody noticed. These assert the rank, not merely the presence.
  it('gives `unresolvable` its own bucket, distinct from `failed`', () => {
    const r = describeReadiness([row({}), row({ status: 'failed' }), row({ status: 'unresolvable' })])
    // NOT merged: the two need opposite remedies, so a combined count cannot be acted on.
    expect(r.text).toBe('1 ready · 1 failed · 1 unresolvable')
    expect(r.usable).toBe(1)
  })

  it('ranks `unresolvable` with the other unreadable states, BEFORE `intermediate`', () => {
    const r = describeReadiness([
      row({ role: 'intermediate' }),
      row({ status: 'unresolvable' }),
      row({ status: 'pending' }),
      row({}),
    ])
    // The load-bearing assertion: drop `unresolvable` from BUCKET_ORDER and it sorts to
    // the end, after `intermediate`, and this goes red.
    expect(r.text).toBe('1 ready · 1 pending · 1 unresolvable · 1 intermediate')
  })

  it('classifies a row by ROLE first — a ready intermediate is still not usable', () => {
    // An intermediate is excluded for what it IS, not for what state it reached, so it
    // must not be counted among the ready rows just because its status says so.
    const r = describeReadiness([row({ role: 'intermediate', status: 'ready' })])
    expect(r.usable).toBe(0)
    expect(r.text).toBe('1 intermediate')
  })

  it('names an unrecognised status rather than dropping or excusing the row', () => {
    const r = describeReadiness([row({}), row({ status: 'quarantined' })])
    expect(r.total).toBe(2)
    expect(r.text).toBe('1 ready · 1 quarantined')
  })

  it('explains the gap in words, quantified', () => {
    const r = describeReadiness([row({}), row({ status: 'failed' })])
    expect(r.detail).toBe(
      'This list shows everything in the store; summaries count only ready artifacts (1 of 2 here).',
    )
  })

  it('rides along on every type section, so the pane never has to recompute it', () => {
    const sections = describeTypeSections(
      [row({ datatype: A }), row({ datatype: A, status: 'failed' }), row({ datatype: B })],
      depsWith(new DatasetPreviewRegistry()),
    )
    const byType = new Map(sections.map(s => [s.datatype, s.readiness]))
    expect(byType.get(A)!.text).toBe('1 ready · 1 failed')
    expect(byType.get(B)!.text).toBeNull()
  })
})
