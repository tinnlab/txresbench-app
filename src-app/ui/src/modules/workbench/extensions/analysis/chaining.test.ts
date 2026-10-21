// TEST-312 (ITEM-27) — light chaining. "Start next analysis" resolves the analyses
// whose `appliesTo` (or `consumes`) matches a produced artifact's datatype and builds an
// `analysis.launch` payload pre-seeding that artifact into the matching input SLOT.
//
// The slot is now carried by the `appliesTo` selector itself, where it used to be an
// artifact-ref FIELD id that had to agree with a separate mount key. So these fixtures
// declare `slot` — without it every selector matches and `chainSlotFor` still returns
// `undefined`, which makes the seeding assertions pass over nothing.

import { describe, expect, it } from 'vitest'
import type { AnalysisContribution, DatatypeLattice } from '@/modules/workbench/core'
import { acceptsDatatype, buildChainLaunch, chainSlotFor, nextAnalyses } from './chaining'

const lattice: DatatypeLattice = {
  isA: (sub, sup) => sub === sup,
  matches: (id, sel) => id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
}

function analysis(over: Partial<AnalysisContribution> & Pick<AnalysisContribution, 'id' | 'title'>): AnalysisContribution {
  return {
    extensionId: 'test',
    apiVersion: '^1.0',
    category: 'test',
    appliesTo: [],
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
    ...over,
  } as AnalysisContribution
}

// No `required:` — every `appliesTo` entry is required by definition (DEC-5).
const de = analysis({
  id: 'de.wilcoxon',
  title: 'DE',
  appliesTo: [{ slot: 'clusters', subtypes_of: 'grouping' }],
})
const enrich = analysis({
  id: 'enrich.gsea',
  title: 'Enrichment',
  appliesTo: [{ slot: 'de', subtypes_of: 'de-table' }],
})
const importer = analysis({ id: 'io.import', title: 'Import' }) // applies to nothing

describe('nextAnalyses — chaining candidates (ITEM-27)', () => {
  it('resolves only analyses whose accepts matches the produced datatype', () => {
    const next = nextAnalyses([de, enrich, importer], 'grouping', lattice, 'cluster.choice_a')
    expect(next.map(a => a.id)).toEqual(['de.wilcoxon'])
  })

  it('excludes the producing analysis itself', () => {
    const next = nextAnalyses([de], 'grouping', lattice, 'de.wilcoxon')
    expect(next).toEqual([])
  })

  it('acceptsDatatype is the predicate', () => {
    expect(acceptsDatatype(enrich, 'de-table', lattice)).toBe(true)
    expect(acceptsDatatype(enrich, 'grouping', lattice)).toBe(false)
  })
})

describe('buildChainLaunch — pre-seed the artifact (ITEM-27)', () => {
  it('pre-seeds the upstream artifact into the matching input slot', () => {
    const launch = buildChainLaunch(de, 'grouping', 'artifact-123', lattice)
    expect(launch).toEqual({ analysis_id: 'de.wilcoxon', inputs: { clusters: 'artifact-123' } })
  })

  it('chainSlotFor finds the slot of the appliesTo selector that matches', () => {
    expect(chainSlotFor(enrich, 'de-table', lattice)).toBe('de')
  })

  // Was "no matching artifact-ref FIELD"; the unseeded case is now a selector that MATCHES
  // the datatype but names no slot — there is nowhere to seed it, so the chain still
  // launches, just without a pre-selection.
  it('launches unseeded when the matching selector declares no slot', () => {
    const noSlot = analysis({ id: 'x', title: 'X', appliesTo: [{ subtypes_of: 'grouping' }] })
    expect(buildChainLaunch(noSlot, 'grouping', 'a1', lattice)).toEqual({ analysis_id: 'x' })
  })

  // ── TEST-14 (ITEM-11a) — two matching selectors do NOT resolve to the first one ──────
  //
  // `chainSlotFor` was `.find(…)`: an analysis declaring two `appliesTo` selectors that a
  // produced datatype satisfies got ONE of its slots pre-seeded, picked by the order the
  // selectors happen to appear in the manifest. The user then met a launched form with an
  // artifact already sitting in a slot they never chose — and both slots accept it, so
  // nothing downstream can tell the wrong one from the right one.
  //
  // The refusal is `undefined`, which is the state the case above already exercises: the
  // chain launches, unseeded, and the user picks. That is why refusing is affordable here.
  it('TEST-14: refuses to seed when SEVERAL appliesTo selectors match the datatype', () => {
    const twoSlots = analysis({
      id: 'integrate',
      title: 'Integrate',
      appliesTo: [
        { slot: 'reference', subtypes_of: 'grouping' },
        { slot: 'query', subtypes_of: 'grouping' },
      ],
    })
    expect(chainSlotFor(twoSlots, 'grouping', lattice)).toBeUndefined()
    // …and the launch is the already-handled unseeded one, not a half-filled form.
    expect(buildChainLaunch(twoSlots, 'grouping', 'a1', lattice)).toEqual({ analysis_id: 'integrate' })
    // Positive control: the SOLE-match case still seeds, so the refusal above is not the
    // resolver having stopped resolving.
    expect(chainSlotFor(de, 'grouping', lattice)).toBe('clusters')
  })
})
