import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { AnalysisContribution, DatatypeLattice } from '@/modules/workbench/core'
// QC is now a DATA package (declarative-processor-ui Slice 2): its contribution is
// built from `packages/qc/manifest.yaml` via the SAME loader the runtime uses, so
// this fixture proves the DATA registration yields the real produces→accepts graph.
import { processorAnalysisToContribution } from '@/modules/workbench/core/runtime/loadProcessors'
import { deriveNextSteps, producedSummary } from './nextSteps'

const qcManifest = parseYaml(
  readFileSync(fileURLToPath(new URL('../../../../../../packages/qc/manifest.yaml', import.meta.url)), 'utf8'),
) as { contributes: { analyses: Array<Record<string, unknown>> } }
const qcAnalysis = processorAnalysisToContribution(
  qcManifest.contributes.analyses[0] as never,
  'qc',
)
// Cell filter is a DATA package too (Slice 4) — built from its shipped manifest via the loader.
const cfManifest = parseYaml(
  readFileSync(fileURLToPath(new URL('../../../../../../packages/cell-filter/manifest.yaml', import.meta.url)), 'utf8'),
) as { contributes: { analyses: Array<Record<string, unknown>> } }
const cellFilterAnalysis = processorAnalysisToContribution(cfManifest.contributes.analyses[0] as never, 'cell-filter')

// TEST-38 (ITEM-35/37/38, DEC-17) — next-step targets are DERIVED from the producer→consumer type
// graph (analyses whose `accepts` match this one's `produces`), authored ONCE and shared by the run
// pane + the job details. The fixtures are the SHIPPED contributions (`qc.10x` / `cell.filter`)
// imported directly from their manifests, so the test proves the REAL graph — a divergent synthetic
// contract (the old phantom fixture) can never make it green while the ship graph is broken.

// QC annotates a dataset (produces `metadata-column`); Cell filter consumes obs metadata columns
// (declares `metadata-column` in `accepts`) → QC → Cell filter is the derived annotate-then-operate
// next step. `report/qc` has no consumer.
const qc = qcAnalysis as unknown as AnalysisContribution
const cellFilter = cellFilterAnalysis as unknown as AnalysisContribution

// The lattice mirrors the workbench's: a selector matches when the datatype equals its `type_id`
// or is-a its `subtypes_of` (exact here — the fixtures use exact type ids).
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

// A negative control: accepts a type nothing here produces.
const unrelated = analysis({ id: 'de.wilcoxon', title: 'DE', appliesTo: [{ type_id: 'clustering', required: true }] })
const all = [qc, cellFilter, unrelated]

describe('deriveNextSteps (ITEM-35/38)', () => {
  it('derives the SHIPPED consumers of the produced datatype (QC → Cell filter), excludes non-consumers', () => {
    const steps = deriveNextSteps(qc, all, lattice)
    expect(steps.map(s => s.analysisId)).toEqual(['cell.filter'])
    expect(steps[0].title).toBe('Cell filter')
    // QC produces `metadata-column` + `report/qc`; only `metadata-column` has a consumer.
    expect(steps[0].producedDatatype).toBe('metadata-column')
  })

  it('opens Cell filter UNSEEDED even with an artifact id — a `metadata-column` is a dataset annotation, not a passable artifact (no matching artifact-ref slot)', () => {
    const [step] = deriveNextSteps(qc, all, lattice, 'artifact-123')
    // cell.filter's only artifact-ref field (`expression`) accepts single-cell/expression, not
    // metadata-column, so `buildChainLaunch` finds no slot and the launch carries no `inputs`.
    expect(step.launch).toEqual({ analysis_id: 'cell.filter' })
  })

  it('opens the analysis UNSEEDED when no artifact id is supplied', () => {
    const [step] = deriveNextSteps(qc, all, lattice)
    expect(step.launch).toEqual({ analysis_id: 'cell.filter' })
  })

  it('dedups a consumer that matches multiple produced datatypes, excludes the producer itself', () => {
    const multi = analysis({ id: 'p', title: 'P', produces: ['metadata-column', 'metadata-column'] })
    const steps = deriveNextSteps(multi, [multi, cellFilter], lattice)
    expect(steps.filter(s => s.analysisId === 'cell.filter')).toHaveLength(1)
    expect(steps.some(s => s.analysisId === 'p')).toBe(false)
  })

  it('producedSummary uses the datatype\'s DECLARED registry title (DATA-driven, INV-6), falling back to the raw id', () => {
    // The friendly label is the datatype's declared `title` from the lattice — NOT a hardcoded
    // per-processor map in the engine. A lattice that declares titles yields those titles.
    const titled: DatatypeLattice = {
      isA: (sub, sup) => sub === sup,
      matches: (id, sel) => id === sel.type_id || id === sel.subtypes_of,
      get: (id: string) =>
        ({
          'metadata-column': { id, title: 'Metadata column' },
          'report/qc': { id, title: 'QC report' },
        }[id] as never),
    }
    expect(producedSummary(qc, titled)).toBe('Metadata column and QC report')
    // Absent lattice entry → raw id verbatim (no engine map).
    expect(producedSummary(qc, lattice)).toBe('metadata-column and report/qc')
    expect(producedSummary(analysis({ id: 'x', title: 'X' }), lattice)).toBe('nothing')
  })

  it('a BRAND-NEW datatype gets its declared label with ZERO edit to the engine (INV-6 zero-app-change)', () => {
    // Prove the general-engine claim: adding a datatype the engine has never heard of surfaces its
    // registry title through producedSummary WITHOUT touching nextSteps.ts.
    const noveltyLattice: DatatypeLattice = {
      isA: (sub, sup) => sub === sup,
      matches: (id, sel) => id === sel.type_id || id === sel.subtypes_of,
      get: (id: string) =>
        (id === 'spatial/niche' ? { id, title: 'Spatial niche map' } : undefined) as never,
    }
    const novel = analysis({ id: 'niche.detect', title: 'Niche detect', produces: ['spatial/niche'] })
    expect(producedSummary(novel, noveltyLattice)).toBe('Spatial niche map')
  })
})
