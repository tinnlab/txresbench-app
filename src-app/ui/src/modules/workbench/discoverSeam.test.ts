// @vitest-environment jsdom
//
// The `window.__workbenchRegistry` availability seam answers "is this analysis available",
// and the ONLY honest input to that question is what the PROJECT has produced. This pins the
// default a no-argument call uses, because the default it used to have could never be wrong
// in a way a POSITIVE assertion would notice.
//
// It was `datatypeRegistry.all()` — every datatype the DEPLOYMENT knows. The lattice always
// contains the input type of every shipped analysis (shipping one is what puts it there), so
// `available` was a constant TRUE: for every analysis, in every project, seeded or empty.
// Every spec that seeded an input and asked "is it available now?" got `true` for the wrong
// reason. It took a NEGATIVE assertion to see it — `14-workbench/analysis-launcher.spec.ts`'s
// guard that at least one analysis must stay GATED, which with the lattice as the input can
// never pass because the gated set is empty by construction.
//
// So the arms below are deliberately weighted toward the negatives (`toBe(false)`): the
// positive arm alone passes under BOTH the old default and the new one, and is kept only so a
// seam that answered `false` unconditionally could not pass either.

import { beforeEach, describe, expect, it } from 'vitest'
import { workbenchRegistry, type AnalysisContribution } from '@/modules/workbench/core'
import { datatypeRegistry } from '@/core/datatypes'
import type { Datatype, LayoutKind } from '@/core/datatypes'
import { publishProducedTypeIds } from '@/modules/workbench/core/shell/seam'
import { installWindowSeam } from '@/modules/workbench/discover'

const OPAQUE: LayoutKind = { kind: 'opaque_as_is' }

/** A minimal lattice entry — this suite exercises the availability INPUT, not the lattice. */
function lite(id: string, ext: string | null): Datatype {
  return {
    id,
    extends: ext,
    title: id,
    description: '',
    storage: { layout: OPAQUE, format: '', selector_map: {}, file_layout: 'single', tiers: ['tier1_range_client_decode'] },
    capabilities: [],
    viewers: [],
    converters: [],
    is_abstract: false,
  }
}

/** Deliberately domain-FREE ids: this is a statement about the seam, not about a domain. */
const ROOT = 'seamprobe/root'
const NEEDED = 'seamprobe/needed'
const OTHER = 'seamprobe/other'
const ANALYSIS_ID = 'seamprobe.analysis'

interface Seam {
  available: (id: string, typeIds?: string[]) => boolean
  catalog: (typeIds?: string[]) => { entries: { id: string; available: boolean }[] }
}
const seam = (): Seam =>
  (window as unknown as { __workbenchRegistry: Seam }).__workbenchRegistry

const catalogSaysAvailable = (): boolean =>
  seam().catalog().entries.find(e => e.id === ANALYSIS_ID)?.available ?? false

describe('the `__workbenchRegistry` availability seam defaults to the PROJECT, not the lattice', () => {
  beforeEach(() => {
    datatypeRegistry.replaceAll([lite(ROOT, null), lite(NEEDED, ROOT), lite(OTHER, ROOT)])
    workbenchRegistry.analyses.register({
      id: ANALYSIS_ID,
      extensionId: 'seamprobe',
      apiVersion: '1.0.0',
      title: 'Seam probe',
      appliesTo: [{ slot: 'input', type_id: NEEDED }],
    } as unknown as AnalysisContribution)
    installWindowSeam()
    publishProducedTypeIds(null)
  })

  it('NO workbench mounted ⇒ NOT available (nothing produced, so nothing applies)', () => {
    // The old default answered `true` here: `NEEDED` is in the lattice, because the analysis
    // that needs it ships. "The deployment knows this type" is not "this project has one".
    expect(seam().available(ANALYSIS_ID)).toBe(false)
    expect(catalogSaysAvailable()).toBe(false)
  })

  it('a workbench over an EMPTY project ⇒ NOT available', () => {
    publishProducedTypeIds([])
    expect(seam().available(ANALYSIS_ID)).toBe(false)
    expect(catalogSaysAvailable()).toBe(false)
  })

  it('a project holding a DIFFERENT datatype ⇒ still NOT available (the gated set is reachable)', () => {
    // This is the arm `analysis-launcher.spec.ts`'s guard needs: an analysis that STAYS gated
    // while others are available, so its list-and-explain assertion has a subject.
    publishProducedTypeIds([OTHER])
    expect(seam().available(ANALYSIS_ID)).toBe(false)
    expect(catalogSaysAvailable()).toBe(false)
  })

  it('a project holding the required datatype ⇒ available', () => {
    publishProducedTypeIds([OTHER, NEEDED])
    expect(seam().available(ANALYSIS_ID)).toBe(true)
    expect(catalogSaysAvailable()).toBe(true)
  })

  it('an EXPLICIT typeIds argument still wins over the mounted default', () => {
    publishProducedTypeIds([NEEDED])
    expect(seam().available(ANALYSIS_ID, [])).toBe(false)
    expect(seam().catalog([]).entries.find(e => e.id === ANALYSIS_ID)?.available).toBe(false)
  })

  it('a retracted publication (workbench unmounted) does not leave the last project answering', () => {
    publishProducedTypeIds([NEEDED])
    expect(seam().available(ANALYSIS_ID)).toBe(true)
    publishProducedTypeIds(null)
    expect(seam().available(ANALYSIS_ID)).toBe(false)
  })
})
