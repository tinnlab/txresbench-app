// ACCEPTANCE (INV-4, "what is launched is what was shown") — a cell-filter run BINDS the
// artifact behind every obs column the user's criteria actually reference.
//
// This is the ONE property that was silently false. `cell-filter.py` resolves every obs
// column by SLOT — `column:<name>`, the slot carrying the name because the STORE cannot
// (`_lib/cyto_columns.py::write_metadata_column` writes one artifact per column whose sole
// member path is the constant `"values"`). The `expression` input is a CSC matrix store and
// carries no obs at all. So a view that binds only `{expression}` gives the compute zero
// columns; `criteria_keep_mask` skips a criterion on an absent column ("an unresolved column
// must never silently hide the dataset"), every criterion resolves to nothing, and the run
// commits a keep-ALL mask. A filter that does nothing, at rc=0, with a green report.
//
// A test asserting "cell-filter.yaml has an inputs block", or that the spec parses, passes
// against exactly that broken spec. So this drives the WHOLE chain with no assertion on the
// YAML's text:
//
//   catalog rows  →  the view's DECLARED `axis_columns` data slices (readSliceFromApi)
//                 →  the REAL view store ($state.criteria, $data)
//                 →  the REAL interpreter over the SHIPPED `cf.run` body
//                 →  the REAL `hostCtx.runProcessor` → `resolveInputs`
//                 →  the `RunInput[]` handed to `jobs.run`
//
// and asserts on that last list. Every link is production code; the two mocks are the byte
// read (`readColumn`) and the `jobs`/`data` capabilities' backends.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'

// The ONE external boundary mocked for the VALUES slice: the artifact byte read. The
// `sources` slice reads no bytes at all (it resolves ids off the producers' declarations),
// which is exactly why it costs one catalog call and no fetches.
const readerMock = vi.hoisted(() => ({ readColumn: vi.fn() }))
vi.mock('@/core/workstore', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/workstore')>()),
  readColumn: readerMock.readColumn,
}))

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { ArtifactRow, DataApi } from '@/modules/workbench/extensions/data/contract'
import type { JobFrame, JobHandle, JobsApi, RunInput } from '@/modules/workbench/extensions/jobs/contract'
import { resolveArtifactRefSource } from './axisSource'
import { createWorkbenchInterpreterCtx } from './hostCtx'
import { interpretBody } from './interpreter'
import { resolveViewData, readSliceFromApi } from './viewData'
import { createViewStore, type ViewStore } from './store'
import type { Scope } from './expr'

const CF_UI = fileURLToPath(new URL('../../../../../../packages/cell-filter/ui/cell-filter.yaml', import.meta.url))
const CF_MANIFEST = fileURLToPath(
  new URL('../../../../../../packages/cell-filter/manifest.yaml', import.meta.url),
)

const spec = parseViewSpec(parseYaml(readFileSync(CF_UI, 'utf8'))).value as ViewSpec
const manifest = parseYaml(readFileSync(CF_MANIFEST, 'utf8')) as {
  contributes: { analyses: Array<Record<string, unknown>> }
}
/** The SHIPPED analysis contribution — `appliesTo` and all, so `resolveInputs` runs against
 *  the real declaration rather than a fixture that might be more permissive than it. */
const CELL_FILTER_ANALYSIS = manifest.contributes.analyses.find(a => a.id === 'cell.filter') as Record<
  string,
  unknown
>

// ── the project catalog these tests resolve against ──────────────────────────────────
//
// One dataset: a CSC count matrix on (cells, genes) plus THREE per-column `metadata-column`
// artifacts on the cells axis. One artifact per column is the real storage shape, and it is
// the whole reason a slot has to carry the name.

const DS = 'ds-1'
const row = (
  id: string,
  datatype: string,
  structure: unknown,
  created_at = '2026-08-01T00:00:00Z',
): ArtifactRow => ({ id, project_id: 'p-1', datatype, structure, created_at, source_dataset_id: DS })

const column = (id: string, name: string, kind: string): ArtifactRow =>
  row(id, 'metadata-column', { axis: 'cells', columns: [{ name, kind, path: 'values' }] })

/** The column NO processor in this tree emits — a pre-existing annotation that arrived with
 *  the import (or a supporting-file upload) and was never forecast by anything. Its name is
 *  deliberately outside every shipped package's vocabulary, so it can only be offerable
 *  because an ARTIFACT declaring it is present on the axis. TEST-22's subject. */
const UNFORECAST_COLUMN = 'probe_label'

const ARTIFACTS: ArtifactRow[] = [
  row('art-matrix', 'single-cell/expression', { kind: 'sparse_csc', axes: ['cells', 'genes'], shape: [4, 9] }),
  column('art-mito', 'pct_mito', 'numeric'),
  column('art-genes', 'n_genes_by_counts', 'numeric'),
  column('art-type', 'cell_type', 'categorical'),
  column('art-barcode', 'barcode', 'string'),
  column('art-extra', UNFORECAST_COLUMN, 'categorical'),
]

/** The per-column VALUES the mocked byte read serves (one table per column artifact). */
const VALUES: Record<string, unknown[]> = {
  'art-mito': [1, 5, 20, 40],
  'art-genes': [900, 800, 300, 120],
  'art-type': ['T', 'B', 'T', 'B'],
  'art-barcode': ['AAAC', 'AAAG', 'AACC', 'AACG'],
  'art-extra': ['p', 'q', 'p', 'q'],
}

interface Captured {
  inputs: RunInput[]
  params: Record<string, unknown>
}

function fakeHandle(jobId: string): JobHandle {
  return {
    jobId,
    onProgress(cb) {
      cb({ phase: 'completed', pct: 100 } as JobFrame)
      return { dispose: () => {} }
    },
  }
}

function fakeApi(captured: Captured[]): WorkbenchAPI {
  const broker = createCapabilityBroker()
  broker.publish('data', '1.0.0', {
    catalog: async () => ({ project_id: 'p-1', axes: [], artifacts: ARTIFACTS }),
    artifacts: { query: async () => ARTIFACTS },
  } as unknown as DataApi)
  broker.publish('jobs', '1.0.0', {
    run: (async (_spec: unknown, inputs: RunInput[], params: Record<string, unknown>) => {
      captured.push({ inputs, params })
      return fakeHandle('job-1')
    }) as unknown as JobsApi['run'],
  } as unknown as JobsApi)
  return {
    version: '1',
    extensionId: 'test',
    registry: { analyses: { get: (id: string) => (id === 'cell.filter' ? CELL_FILTER_ANALYSIS : undefined) } },
    capabilities: broker,
    ui: { notify: () => {} },
  } as unknown as WorkbenchAPI
}

/** Resolve the SHIPPED spec's declared `data` slices through the real resolver, then build
 *  the real view store over them. */
async function mountedStore(api: WorkbenchAPI, state: Record<string, unknown>): Promise<ViewStore> {
  // `of` anchors resolve against the view's own state, exactly as `resolveAndApplyViewData`
  // threads it from the live store.
  const scope: Scope = { state }
  const res = await resolveViewData(spec, (key, decl) => readSliceFromApi(api, key, decl, scope))
  const store = createViewStore(spec, `cf-inputs-${Math.random()}`, res.data)
  for (const [k, v] of Object.entries(state)) store.set(k, v)
  return store
}

/** Interpret the SHIPPED `cf.run` action's `run_processor` effect over the real ctx, and
 *  return the `RunInput[]` that reached `jobs.run`.
 *
 *  Only the `run_processor` effect is interpreted, not the whole body: the trailing
 *  `call_action: provenance.record-selection` resolves against the GLOBAL action registry,
 *  which a unit context has not booted. The effect under test is the SHIPPED one, taken
 *  from the shipped body — not a re-spelling of it. */
async function launch(state: Record<string, unknown>): Promise<Captured> {
  const captured: Captured[] = []
  const api = fakeApi(captured)
  const store = await mountedStore(api, state)
  try {
    const run = spec.actions.find(a => a.id === 'cf.run')!
    const runProcessorEffects = run.body.filter(e => 'run_processor' in e)
    expect(runProcessorEffects.length).toBe(1)
    const ctx = { ...createWorkbenchInterpreterCtx({ api }), viewStore: () => store }
    await interpretBody(runProcessorEffects, { view_id: 'v' }, ctx)
  } finally {
    store.dispose()
  }
  expect(captured.length).toBe(1)
  return captured[0]
}

beforeEach(() => {
  readerMock.readColumn.mockReset()
  readerMock.readColumn.mockImplementation(async ({ id }: { id: string }) => {
    const values = VALUES[id]
    if (!values) throw new Error(`no fixture values for artifact ${id}`)
    const name = (ARTIFACTS.find(a => a.id === id)!.structure as { columns: Array<{ name: string }> }).columns[0]
      .name
    return { columns: [name], rows: values.map(v => [v]) }
  })
})

describe('cell-filter run inputs — the criterion columns are BOUND, not lost (INV-4)', () => {
  it('binds one `column:<name>` slot per criterion column, pointing at that column’s artifact', async () => {
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [
        { column: 'pct_mito', control: '', min: '', max: '10', keep: [] },
        { column: 'cell_type', control: '', min: '', max: '', keep: ['T'] },
      ],
      label: 'strict',
    })

    // THE property. Without these two bindings the compute sees no obs at all and the run
    // commits a keep-ALL mask — the filter silently does nothing.
    // The `origin` on each entry is binding-origin ITEM-11/ITEM-12: how that slot's
    // binding was chosen. Asserted with `objectContaining` so this test keeps saying what
    // it is about — WHICH artifact lands in WHICH slot — rather than re-asserting a
    // neighbouring change's field on every row.
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'column:pct_mito', artifactId: 'art-mito' }))
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'column:cell_type', artifactId: 'art-type' }))
    // …and the matrix the user picked, on the slot the compute REQUIRES.
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'expression', artifactId: 'art-matrix' }))
    // …and the origin the shipped spec's own declaration produces, asserted once at this
    // layer: `expression: "$state.expression"` reads a path the form wrote, so the launch
    // states who chose it. An `inputs_from` slot resolves out of `$data` — a catalog fact no
    // picker writes — so it carries none, and absent is not `auto` (INV-4).
    expect(inputs.find(i => i.slot === 'expression')?.origin).toBe('user')
    expect(inputs.find(i => i.slot.startsWith('column:'))?.origin).toBeUndefined()
  })

  it('binds ONLY the columns the criteria reference — an unreferenced column is not shipped', async () => {
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [{ column: 'pct_mito', control: '', min: '', max: '10', keep: [] }],
      label: '',
    })
    const slots = inputs.map(i => i.slot)
    expect(slots).toContain('column:pct_mito')
    // `n_genes_by_counts` and `cell_type` exist on the axis and are OFFERED by the picker;
    // the user referenced neither, so neither is mounted. "Exactly the inputs the user
    // selected" cuts both ways.
    expect(slots).not.toContain('column:n_genes_by_counts')
    expect(slots).not.toContain('column:cell_type')
  })

  // The view NEVER binds `cells_index`. Two tests here used to assert that it did — one
  // proving the slot was bound, one proving the empty case left it unbound — and both
  // passed, which is what let a dead control look tested. The compute keeps the optional
  // slot for its gate / allow-list path; this VIEW cannot reach that path (its run action
  // sends empty params and binds no allow-list slot), so the keys were read, length-checked,
  // and used for nothing on every run it could launch.
  it('never binds `cells_index` — the run this view launches has no use for it', async () => {
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [{ column: 'pct_mito', control: '', min: '', max: '10', keep: [] }],
      label: '',
    })
    expect(inputs.map(i => i.slot)).not.toContain('cells_index')
    // …and the criterion column IS still bound, so this asserts an absence inside a
    // launch that really happened rather than one that produced nothing at all.
    expect(inputs.map(i => i.slot)).toContain('column:pct_mito')
  })

  it('a BLANK criterion (a freshly-added row) binds nothing and does not fail the launch', async () => {
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [{ column: '', control: '', min: '', max: '', keep: [] }],
      label: '',
    })
    expect(inputs).toEqual([expect.objectContaining({ slot: 'expression', artifactId: 'art-matrix' })])
  })

  it('two criteria on ONE column bind that column once (a slot is a mount, not a criterion)', async () => {
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [
        { column: 'pct_mito', control: '', min: '5', max: '', keep: [] },
        { column: 'pct_mito', control: '', min: '', max: '30', keep: [] },
      ],
      label: '',
    })
    expect(inputs.filter(i => i.slot === 'column:pct_mito')).toEqual([
      { slot: 'column:pct_mito', artifactId: 'art-mito' },
    ])
  })

  it('the params channel is untouched — criteria/label still travel as PARAMS, not inputs', async () => {
    const { params, inputs } = await launch({
      expression: 'art-matrix',
      criteria: [{ column: 'pct_mito', control: '', min: '', max: '10', keep: [] }],
      label: 'strict',
    })
    expect(params.label).toBe('strict')
    expect((params.criteria as unknown[]).length).toBe(1)
    // a plain param is never mistaken for an artifact id.
    expect(inputs.map(i => i.slot)).not.toContain('label')
    expect(inputs.map(i => i.slot)).not.toContain('criteria')
  })

  // ITEM-34 rewrote the SEAM this asserts through; the CLAIM is unchanged.
  //
  // It used to walk every column's values, because every body was fetched. Under lazy bodies
  // that set is only the criterion-named columns, so the original loop would still pass and
  // assert NOTHING — with no criterion it iterates an empty object. A vacuous green is worse
  // than the red it replaced, so the claim is split in two and each half is guarded against
  // emptiness.
  //
  // It also stopped naming a column literal. The column under test is now taken from what the
  // picker actually OFFERS, which is both stricter (it cannot drift away from the offered set)
  // and free of the package vocabulary this file is otherwise budgeted for.
  //
  // (This is one of the 8 tests that inject at the `@/core/workstore` boundary, and it is what
  // caught the real regression in this change: the slice reported no data for a frame carrying
  // declarations and no bodies, which blanks the builder. It was NOT weakened to accommodate
  // that — the resolver was fixed.)
  it('every OFFERED column has a source artifact, and naming one in a criterion fetches THAT artifact', async () => {
    const api = fakeApi([])
    // ── half 1: OFFERED — from the declaration, with nothing downloaded ────────────────────
    let firstOffered = ''
    const idle = await mountedStore(api, { expression: 'art-matrix' })
    try {
      const offered = (idle.derived?.columns ?? []) as Array<{ value: string }>
      // Non-vacuity, and the blank-picker regression guard: the builder must still offer
      // columns when no body has been fetched. That is the whole point of the lazy read.
      expect(offered.length, 'the picker offers columns from metadata alone').toBeGreaterThan(0)
      const sources = (idle.data?.obsSources ?? {}) as Record<string, string>
      for (const { value: name } of offered) {
        expect(sources[name], `column "${name}" is offered but has no source artifact`).toBeTruthy()
      }
      firstOffered = offered[0].value
    } finally {
      idle.dispose()
    }

    // ── half 2: naming it in a criterion FETCHES it — asserted by behaviour, not by peeking ──
    //
    // The gate closing (`pendingColumns` empty) is what proves the body arrived, and the mask
    // spanning the source artifact's rows is what proves the body is THAT artifact's. Reading
    // the slice directly would prove neither: an empty slice and a fetched one look the same
    // to a `Object.keys(...).length >= 0` check.
    const named = await mountedStore(api, {
      expression: 'art-matrix',
      criteria: [{ column: firstOffered, control: '', min: '', max: '', keep: [] }],
    })
    try {
      const sources = (named.data?.obsSources ?? {}) as Record<string, string>
      expect(
        named.derived?.pendingColumns,
        'the criterion-named body must ARRIVE — a criterion left pending is the loading gate ' +
          'stuck shut, which reads to the user as a filter that never applies',
      ).toEqual([])
      // MEMBERSHIP, not size. `keptMask.length === VALUES[src].length` cannot tell the five
      // fixtures apart — every one of them is length 4 — so it is satisfied by ANY artifact's
      // body arriving, including the wrong one. WHEN THE DEFECT IS PRESENT (the criterion
      // fetches some other offered column's artifact, or a stale one) the size check stays green
      // while the mask is computed over the wrong column. So assert the reader was actually
      // asked for THIS column's source artifact, by id.
      const requestedIds = readerMock.readColumn.mock.calls.map(
        args => (args[0] as { id: string }).id,
      )
      expect(
        requestedIds,
        `naming "${firstOffered}" must fetch its OWN source artifact ` +
          `("${sources[firstOffered]}"); the reader was asked for [${requestedIds.join(', ')}]`,
      ).toContain(sources[firstOffered])
      expect((named.derived?.keptMask as boolean[]).length).toBe(VALUES[sources[firstOffered]].length)
    } finally {
      named.dispose()
    }
  })
})

// The key-column picker is GONE, and this asserts its absence.
//
// A describe block here used to check that the picker was an `artifact_ref`, that it resolved
// real candidates off the axis, and that it offered nothing before a dataset was chosen. All three passed. They were careful about a control that sat directly above the
// criteria builder, argued in its own comment that the user must choose it, and fed a slot the
// run never read.
//
// Asserting the ABSENCE rather than deleting the tests is the point: one shared view file is
// edited by many hands, and a re-added picker would otherwise come back silently.
describe('the view declares no axis-key control', () => {
  it('has no key picker, no state field, and no setter action', () => {
    expect(spec.widgets.find(w => w.id === 'cellsIndexPicker')).toBeUndefined()
    expect((spec.state as Record<string, unknown>).cellsIndex).toBeUndefined()
    expect(spec.actions.some(a => a.id === 'cf.setCellsIndex')).toBe(false)
    // Nothing anywhere in the spec still names the slot or the field.
    const serialized = JSON.stringify(spec)
    for (const token of ['cellsIndex', 'cells_index']) {
      expect(serialized, `the view still names "${token}"`).not.toContain(token)
    }
  })

  it('still offers the DATASET picker — the input that is actually used', () => {
    // The negative control. "No key picker" must not be satisfiable by a view that
    // failed to parse or lost its widgets: the input the run really consumes is still here.
    expect(spec.widgets.find(w => w.id === 'expressionPicker')?.kind).toBe('artifact_ref')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-22 — the criteria column picker offers what is ON THE AXIS, not what a producer
// forecast.
//
// The defect: the criteria columns came from a FIXED report artifact
// (`{ source: job.result, args: { path: …, datatype: <a report kind> } }`), so only the
// producing analysis' OWN output columns were selectable. On a real import that is a
// handful instead of sixty-five — everything that arrived WITH the data was simply not
// offerable, though filtering on it is the stated point of the analysis.
//
// Two halves, and both are needed:
//   · STRUCTURAL — every declared slice is the AXIS relation, anchored on the input the
//     user chose. A fixed-artifact source would still parse, still resolve, and still
//     populate the builder with the producing analysis' columns, so "the builder has
//     options" proves nothing about WHERE they came from. Asserted over ALL declared
//     slices rather than one named key: a SECOND slice reverting is the same defect, and
//     naming the key would have exempted it.
//   · BEHAVIOURAL — a column NO shipped processor emits is offered, and a criterion built
//     on it BINDS. Its only route into the form is the artifact declaring it, which is the
//     invariant (INV-5): facts about produced data are read from artifacts.
//
// The e2e restatement of this (a browser-level "the picker lists it") is NOT covered — see
// the TEST-22 amendment in TESTS.md.
describe('criteria columns — read from the AXIS, not from a forecast (TEST-22)', () => {
  it('EVERY declared slice is the axis relation anchored on the CHOSEN input, not a fixed artifact', () => {
    const slices = Object.entries(spec.data ?? {}) as Array<
      [string, { source?: string; args?: Record<string, unknown> }]
    >
    expect(slices.length, 'the view declares no column slice at all').toBeGreaterThan(0)
    for (const [key, slice] of slices) {
      expect(slice.source, `slice "${key}" is not the axis relation`).toBe('axis_columns')
      // Anchored on the control the user actually operates — which is what makes the
      // option set follow the selection instead of a producer.
      expect(slice.args?.of, `slice "${key}" is not anchored on the chosen input`).toBe('$state.expression')
      // …and it names no producing analysis, no job result and no report kind. Each of
      // those is a way of asking a PRODUCER what exists instead of asking the data.
      expect(slice.args).not.toHaveProperty('datatype')
      expect(slice.args).not.toHaveProperty('path')
    }
  })

  it('offers a column NO shipped processor emits — its only route in is the artifact', async () => {
    const api = fakeApi([])
    const store = await mountedStore(api, { expression: 'art-matrix' })
    try {
      // The column names the resolved slices carry, found by SEARCHING the resolved data
      // rather than by naming a slice key — same reason as above.
      const offered = Object.values(store.data ?? {}).flatMap(v =>
        v && typeof v === 'object' ? Object.keys(v as Record<string, unknown>) : [],
      )
      expect(
        offered,
        `"${UNFORECAST_COLUMN}" is on the axis but is not offered — the builder is reading a forecast`,
      ).toContain(UNFORECAST_COLUMN)
      // NON-VACUITY, and the discrimination: the MATRIX is on the same axis and is NOT a
      // column, so "offers everything present" would be wrong too.
      expect(offered.length).toBeGreaterThan(1)
      expect(offered).not.toContain('art-matrix')
    } finally {
      store.dispose()
    }
  })

  it('a criterion built on that column BINDS its artifact — offered and runnable are the same set', async () => {
    // An offered column the run cannot mount is worse than an absent one: the criterion is
    // silently skipped and the committed mask keeps everything, at rc=0, with a green report.
    const { inputs } = await launch({
      expression: 'art-matrix',
      criteria: [{ column: UNFORECAST_COLUMN, control: '', min: '', max: '', keep: ['p'] }],
      label: '',
    })
    expect(inputs).toContainEqual(
      expect.objectContaining({ slot: `column:${UNFORECAST_COLUMN}`, artifactId: 'art-extra' }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-30's remaining clause — the INPUT control the whole surface hangs off.
//
// Its "…in ONE pane" half is structural now (INV-3 keys the pane on the ANALYSIS, and this
// one declares a single `ui:` file); its commit half — a run naming the committed column
// from the label the user typed — is asserted end-to-end in the REAL-compute e2e. What is
// left, and what nothing pinned, is that the dataset control is the VIEW's own: every
// axis-scoped slice above and both other pickers anchor on the state field this control
// writes, so a control that stopped writing it would leave the entire surface resolving
// against nothing — with an empty builder and no error.
describe('dataset picker — the anchor every other control resolves against (TEST-30)', () => {
  const picker = (spec.widgets.find(w => w.id === 'expressionPicker') ?? {}) as {
    kind?: string
    value?: string
    onChange?: string
    source?: Record<string, unknown>
  }

  it('is an artifact_ref declaring its OWN source and writing $state.expression', () => {
    expect(picker.kind).toBe('artifact_ref')
    expect(picker.value).toBe('$state.expression')
    expect(picker.source && typeof picker.source === 'object').toBe(true)
    // INV-2 — the option set is the view's own declaration, not a `slot:` handing the
    // question back to the manifest.
    expect(picker.source).not.toHaveProperty('slot')
    expect(spec.actions.some(a => a.id === picker.onChange)).toBe(true)
  })

  it('every axis-scoped slice and picker anchors on the field it writes', () => {
    const anchors = Object.values(spec.data ?? {}).map(
      d => (d as { args?: { of?: unknown } }).args?.of,
    )
    expect(anchors.length).toBeGreaterThan(0)
    for (const of of anchors) expect(of).toBe(picker.value)
  })
})
