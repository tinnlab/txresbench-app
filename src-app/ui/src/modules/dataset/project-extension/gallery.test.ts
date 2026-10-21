// The gallery seed is the ONE surface that renders this panel in a browser — it is
// what `preland-frontend` drives, what the runtime-health pass reads and what a
// reviewer looks at. So a fixture that quietly renders the DEGRADED line is a
// reference image certifying the wrong thing, and nothing else in the tree would say
// so: a cassette is data, and no suite had ever read it.
//
// It happened. The seed carried the producer's dimension list but not the axis names
// declared beside it, so the contributed phrase was dropped for missing values and
// every screenshot of the flagship row showed the app's count-and-title fallback.
//
// The assertion is therefore the property the fixture exists to demonstrate: at least
// one seeded row resolves a CONTRIBUTED phrase. Nothing here names a datatype, a key
// or a word — the registry is the app-wide one the panel itself uses, and the titles
// are the raw ids, because what is under test is whether a contribution SPOKE.

import { expect, it } from 'vitest'
import type { DatasetArtifactSummary } from '@/api-client/types'
import { gallery } from './gallery'
import { datasetPreviewRegistry } from './preview/registry'
import { describeSummary, type SummaryDeps } from './preview/summary'

const deps: SummaryDeps = {
  lattice: { ancestors: () => [] },
  title: (id: string) => id,
  registry: datasetPreviewRegistry,
}

/** The seeded artifact summaries, read through the cassette exactly as the harness
 *  would call it. */
function seededSummaries(): DatasetArtifactSummary[] {
  const entry = gallery.cassette?.['Dataset.artifactSummaries']
  if (typeof entry !== 'function') throw new Error('the gallery seeds no artifact summaries')
  const value = (entry as (ctx: { params: Record<string, string> }) => unknown)({ params: {} })
  return (value as { summaries: DatasetArtifactSummary[] }).summaries
}

it('seeds artifact summaries at all (a zero would make the rest vacuous)', () => {
  const summaries = seededSummaries()
  expect(summaries.length).toBeGreaterThan(0)
  expect(summaries.some(s => s.groups.length > 0)).toBe(true)
})

it('seeds at least one row a package really SPEAKS for — not a wall of fallbacks', () => {
  const spoke = seededSummaries().flatMap(
    s => describeSummary(s, deps)?.parts.filter(p => p.contributed) ?? [],
  )
  expect(spoke.length).toBeGreaterThan(0)
})
