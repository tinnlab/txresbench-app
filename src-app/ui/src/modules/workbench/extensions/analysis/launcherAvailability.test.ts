// TEST-301 (ITEM-20) + TEST-314 (ITEM-28) — the launcher's grouping + availability
// gating. `byCategory` groups the registry by `category` and tags each row available
// / needs-<type> / arch-disabled (partitioning the launcher list); the `backendArch`
// argument (fed from `WorkbenchContextValue`, ITEM-28) flows into
// `computeAvailabilityWithArch` so an arch-unsupported analysis resolves to
// arch-disabled (still LISTED, disabled — never hidden).

import { describe, expect, it } from 'vitest'
import type {
  AnalysisContribution,
  DatatypeLattice,
  WhenContext,
} from '@/modules/workbench/core'
import {
  byCategory,
  isLaunchable,
  isLauncherVisible,
  launcherVisibleAnalyses,
  matchesQuery,
  missingInputs,
  rowAvailability,
} from './launcherAvailability'
// Cell filter is a DATA package (declarative-processor-ui Slice 4): its contribution is
// built from `packages/cell-filter/manifest.yaml` via the SAME loader the runtime uses.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { processorAnalysisToContribution } from '@/modules/workbench/core/runtime/loadProcessors'

const cfManifest = parseYaml(
  readFileSync(fileURLToPath(new URL('../../../../../../packages/cell-filter/manifest.yaml', import.meta.url)), 'utf8'),
) as { contributes: { analyses: Array<Record<string, unknown>> } }
// The shipped contribution is generic over its typed params; the availability
// predicates are param-agnostic, so view it as the base contribution.
const cellFilterAnalysis = processorAnalysisToContribution(
  cfManifest.contributes.analyses[0] as never,
  'cell-filter',
) as unknown as AnalysisContribution

// A trivial lattice: exact-id match only (enough to gate `subtypes_of`/`type_id`).
const lattice: DatatypeLattice = {
  isA: (sub, sup) => sub === sup,
  matches: (id, sel) => id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
}

function analysis(
  over: Partial<AnalysisContribution> & Pick<AnalysisContribution, 'id' | 'title' | 'category'>,
): AnalysisContribution {
  return {
    extensionId: 'test',
    apiVersion: '^1.0',
    appliesTo: [],
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
    ...over,
  } as AnalysisContribution
}

const ctx = (producedTypeIds: string[]): WhenContext => ({ producedTypeIds })

describe('byCategory — group + availability partition (TEST-301)', () => {
  const embeddingReq = analysis({
    id: 'cluster.leiden',
    title: 'Leiden',
    category: 'clustering',
    appliesTo: [{ subtypes_of: 'embedding', required: true }],
  })
  const noReq = analysis({ id: 'io.import', title: 'Import', category: 'data' })

  it('groups analyses by category, sorted', () => {
    const groups = byCategory([embeddingReq, noReq], ctx([]), lattice, 'x86_64')
    expect(groups.map(g => g.category)).toEqual(['clustering', 'data'])
  })

  it('tags a row available when its required input is produced', () => {
    const groups = byCategory([embeddingReq], ctx(['embedding']), lattice, 'x86_64')
    const row = groups[0].rows[0]
    expect(row.availability.status).toBe('available')
    expect(row.launchable).toBe(true)
  })

  it('tags a row needs-<type> (disabled) when a required input is missing', () => {
    const groups = byCategory([embeddingReq], ctx([]), lattice, 'x86_64')
    const row = groups[0].rows[0]
    expect(row.availability).toEqual({ status: 'needs-type', missing: ['embedding'] })
    expect(row.launchable).toBe(false)
  })

  it('a no-requirement analysis is always available', () => {
    const groups = byCategory([noReq], ctx([]), lattice, 'x86_64')
    expect(groups[0].rows[0].availability.status).toBe('available')
  })
})

describe('rowAvailability — arch lens fed by backendArch (TEST-314 / ITEM-28)', () => {
  const x86Only = analysis({
    id: 'cellranger.count',
    title: 'Cell Ranger',
    category: 'alignment',
    arch: ['x86_64'],
  })

  it('applicable + arch-INCOMPATIBLE → arch-disabled, still listed (not hidden)', () => {
    const a = rowAvailability(x86Only, ctx([]), lattice, 'aarch64')
    expect(a.status).toBe('arch-disabled')
    if (a.status === 'arch-disabled') expect(a.reason).toContain('x86_64')
  })

  it('applicable + arch-compatible → available', () => {
    const a = rowAvailability(x86Only, ctx([]), lattice, 'x86_64')
    expect(a.status).toBe('available')
  })
})

describe('isLauncherVisible — launcher visibility filter (TEST-12 / ITEM-16)', () => {
  // Real, user-launchable analyses (no `launchable`/`trigger` opt-out).
  const qc = analysis({ id: 'qc.10x', title: 'Compute QC metrics', category: 'qc' })
  const filter = analysis({ id: 'cell.filter', title: 'Filter cells', category: 'qc' })
  const cellranger = analysis({ id: 'cellranger.count', title: 'Cell Ranger', category: 'alignment' })
  // Converters — run on ingest, not launched by the user.
  const anndataImport = analysis({ id: 'anndata.import', title: 'AnnData Import', category: 'data-io', trigger: 'on-ingest' })
  const h5adImport = analysis({ id: 'import.h5ad', title: 'Import AnnData', category: 'data-io', trigger: 'on-ingest' })
  // Demos / dogfood — registered but opted out of the launcher.
  const leiden = analysis({ id: 'demo.leiden', title: 'Demo Leiden', category: 'clustering', launchable: false })
  const selectionDemo = analysis({ id: 'selection.demo', title: 'Interactive selection (demo)', category: 'de', launchable: false })

  it('keeps real launchable analyses (no launchable/trigger opt-out)', () => {
    expect(isLauncherVisible(qc)).toBe(true)
    expect(isLauncherVisible(filter)).toBe(true)
    expect(isLauncherVisible(cellranger)).toBe(true)
  })

  it("drops trigger:'on-ingest' converters", () => {
    expect(isLauncherVisible(anndataImport)).toBe(false)
    expect(isLauncherVisible(h5adImport)).toBe(false)
  })

  it('drops launchable:false demos', () => {
    expect(isLauncherVisible(leiden)).toBe(false)
    expect(isLauncherVisible(selectionDemo)).toBe(false)
  })

  it('launcherVisibleAnalyses filters a mixed list to only the real launchable ones', () => {
    const all = [qc, anndataImport, leiden, filter, h5adImport, selectionDemo, cellranger]
    expect(launcherVisibleAnalyses(all).map(a => a.id)).toEqual(['qc.10x', 'cell.filter', 'cellranger.count'])
  })
})

describe('missingInputs + matchesQuery helpers', () => {
  // Was 'ignores optional selectors': an `accepts` entry with `required: false` did not
  // gate availability. `required` is gone from `appliesTo` (DEC-5) — every entry there IS
  // an applicability condition — so re-declaring the second selector as optional would
  // just be a field nothing reads, and the test would pass while asserting nothing.
  //
  // The PROPERTY is intact and worth keeping: a datatype an analysis merely READS must not
  // gate whether it is offered. That is exactly what `required: false` was smuggling, and
  // it now has its own key. cell-filter is the real instance — its `metadata-column` entry
  // moved from `accepts … required: false` to `consumes`.
  it('a `consumes` edge never gates availability — only `appliesTo` does', () => {
    const a = analysis({
      id: 'x',
      title: 'X',
      category: 'c',
      appliesTo: [{ slot: 'projection', subtypes_of: 'projection' }],
      consumes: ['grouping'],
    })
    expect(missingInputs(a, ctx([]), lattice)).toEqual(['projection'])
    // …and the `consumes` entry is genuinely being ignored rather than absent: satisfying
    // ONLY the `appliesTo` selector leaves nothing missing, though `grouping` is not
    // produced.
    expect(missingInputs(a, ctx(['projection']), lattice)).toEqual([])
  })

  it('search matches title / description / category, case-insensitively', () => {
    const a = analysis({ id: 'x', title: 'Leiden clustering', category: 'graph', description: 'group cells' })
    expect(matchesQuery(a, 'leid')).toBe(true)
    expect(matchesQuery(a, 'GROUP')).toBe(true)
    expect(matchesQuery(a, 'graph')).toBe(true)
    expect(matchesQuery(a, '')).toBe(true)
    expect(matchesQuery(a, 'volcano')).toBe(false)
  })
})

// TEST-301b — the reported live bug: an imported h5ad produces a
// `single-cell/expression` artifact, so once it's in the workbench's
// `producedTypeIds` (derived from the project catalog, incl. attached-dataset
// artifacts) the REAL `cell.filter` contribution must be AVAILABLE (launchable),
// not stuck disabled. Uses the shipped contribution + a type_id-exact lattice.
describe('cell.filter lights up on an imported single-cell/expression (TEST-301b)', () => {
  it('needs-type when no expression is produced, available once it is', () => {
    // No artifacts yet → the required `single-cell/expression` accept is unmet.
    const empty = rowAvailability(cellFilterAnalysis, ctx([]), lattice, 'x86_64')
    expect(empty.status).toBe('needs-type')
    expect(missingInputs(cellFilterAnalysis, ctx([]), lattice)).toEqual(['single-cell/expression'])

    // An expression artifact present in the catalog → available + launchable.
    const withExpr = rowAvailability(
      cellFilterAnalysis,
      ctx(['single-cell/expression']),
      lattice,
      'x86_64',
    )
    expect(withExpr.status).toBe('available')
    expect(isLaunchable(withExpr)).toBe(true)
  })
})
