// ACCEPTANCE (INV-4, "what is launched is what was shown") — a Visium HD import run carries
// the CHOSEN bin to the compute, as the STRING the picker actually sends.
//
// The whole point of issue #361 is that a human can launch the importer AT A CHOSEN BIN.
// The declarative select is STRING-valued at the kit level (`ValueBinding<string>`), so the
// renderer's `toOption` coerces every option value through `String(...)` and the value that
// reaches `params.bin_um` is a STRING — "8", not 8. The compute's `select_bin` parses an
// exact-integer string (see `spatial-import-visium-hd/tests/test_bin_selection.py`), so a
// regression to `type: number` in the view would diverge from what the picker actually
// sends.
//
// This drives the WHOLE chain with no assertion on the YAML's text:
//
//   the SHIPPED view spec  →  the REAL view store ($state.bin, $state.bundle)
//                           →  the REAL interpreter over the SHIPPED `hd.setBin` + `hd.run`
//                              bodies (the picker's `onChange` and the Run button)
//                           →  the REAL `hostCtx.runProcessor` → `resolveInputs`
//                           →  the `RunInput[]` + params handed to `jobs.run`
//
// and asserts on that last call. Every link is production code; the only mocks are the
// `jobs`/`data` capabilities' backends. The offered bins are DERIVED from the SHIPPED
// `spatial-types` manifest (the same declaration the `container_members` source reads), so
// "the largest offered bin" is whatever the container actually declares — never a literal.
// The container's id is read from the SHIPPED analysis manifest's `appliesTo[].type_id` and
// CROSS-CHECKED against the view and the container declaration, so a divergence between the
// view's declared datatype and the container's declaration fails here rather than drifting.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { ArtifactRow, DataApi } from '@/modules/workbench/extensions/data/contract'
import type { JobFrame, JobHandle, JobsApi, RunInput } from '@/modules/workbench/extensions/jobs/contract'
import { createWorkbenchInterpreterCtx } from './hostCtx'
import { interpretBody } from './interpreter'
import { resolveViewData, readSliceFromApi } from './viewData'
import { createViewStore, type ViewStore } from './store'
import type { Scope } from './expr'
import { resolveContainerMembers } from './containerMembers'
import { datatypeRegistry } from '@/core/datatypes/registry'
import type { Datatype, InputRequirements } from '@/core/datatypes/types'

const HD_UI = fileURLToPath(
  new URL('../../../../../../packages/spatial-import-visium-hd/ui/import-hd.yaml', import.meta.url),
)
const HD_MANIFEST = fileURLToPath(
  new URL('../../../../../../packages/spatial-import-visium-hd/manifest.yaml', import.meta.url),
)
const SPATIAL_TYPES_MANIFEST = fileURLToPath(
  new URL('../../../../../../packages/spatial-types/manifest.yaml', import.meta.url),
)

const spec = parseViewSpec(parseYaml(readFileSync(HD_UI, 'utf8'))).value as ViewSpec
const manifest = parseYaml(readFileSync(HD_MANIFEST, 'utf8')) as {
  contributes: { analyses: Array<Record<string, unknown>> }
}
/** The SHIPPED analysis contribution — `appliesTo` and all, so `resolveInputs` runs against
 *  the real declaration rather than a fixture that might be more permissive than it. */
const HD_ANALYSIS = manifest.contributes.analyses.find(a => a.id === 'spatial.import-visium-hd') as Record<
  string,
  unknown
>

/** The SHIPPED container's id, read from the analysis manifest's `appliesTo[].type_id` —
 *  the slot the bundle binds to. The view and the container declaration are then
 *  CROSS-CHECKED against it, so a divergence between the view's declared datatype and the
 *  container's declaration fails here rather than drifting. */
const HD_BUNDLE_ID = (() => {
  const appliesTo = HD_ANALYSIS?.appliesTo as Array<{ type_id?: string }> | undefined
  const id = appliesTo?.[0]?.type_id
  if (!id) {
    throw new Error(
      'the shipped analysis manifest must declare appliesTo[].type_id — the derivation would be vacuous',
    )
  }
  return id
})()

// ── the offered bins, DERIVED from the SHIPPED container declaration ───────────────────
//
// The same declaration the `container_members` source reads at runtime: the test computes
// the offer from the parsed members, so "the largest offered bin" is whatever the container
// actually declares — never a literal `[2,8,16]`.

const spatialTypes = parseYaml(readFileSync(SPATIAL_TYPES_MANIFEST, 'utf8')) as {
  contributes: { datatypes: Array<Record<string, unknown>> }
}
const hdBundle = spatialTypes.contributes.datatypes.find(d => d.id === HD_BUNDLE_ID)
const hdRequirements = hdBundle?.input_requirements as
  | { requires?: string; members?: string[]; allow_archive?: boolean }
  | undefined

function offeredBins(): Array<{ value: number; label: string }> {
  if (!hdRequirements || hdRequirements.requires !== 'manifest' || !hdRequirements.members?.length) {
    throw new Error(
      'the shipped manifest must declare the derived container as a manifest container',
    )
  }
  // Rebuild the narrowed manifest variant — the parsed record's optional fields are not
  // assignable to the `InputRequirements` union as-is.
  const requirements: InputRequirements = {
    requires: 'manifest',
    members: hdRequirements.members,
    allow_archive: hdRequirements.allow_archive ?? true,
  }
  return resolveContainerMembers(requirements) as Array<{ value: number; label: string }>
}

/** The id the SHIPPED view declares for the container — the `container_members` slice's
 *  `args.datatype` and the bundle picker's `source.datatype`. */
function viewDeclaredId(): string {
  const sliceDatatype = spec.data?.bins?.args?.datatype as string | undefined
  const picker = spec.widgets.find(w => w.kind === 'artifact_ref')
  const pickerDatatype = picker && picker.kind === 'artifact_ref' ? picker.source?.datatype : undefined
  if (!sliceDatatype || !pickerDatatype) {
    throw new Error(
      'the shipped view must declare the container datatype in the data slice and the picker source — the cross-check would be vacuous',
    )
  }
  if (sliceDatatype !== pickerDatatype) {
    throw new Error(
      'the shipped view declares two different container datatypes — the cross-check would be vacuous',
    )
  }
  return sliceDatatype
}

// Seed the client datatype registry with the SHIPPED declaration, so the view's
// `container_members` slice resolves against the real container rather than resolving empty.
// Only `input_requirements` is load-bearing for this test; the rest is the registry's
// minimal shape.
datatypeRegistry.replaceAll([
  {
    id: HD_BUNDLE_ID,
    extends: 'data/opaque',
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: 'spaceranger-hd',
      selector_map: {},
      file_layout: 'manifest',
      tiers: [],
    },
    capabilities: ['spatial-bundle-target'],
    viewers: [],
    converters: [],
    input_requirements: hdRequirements ?? null,
  } as unknown as Datatype,
])

// ── the project catalog these tests resolve against ────────────────────────────────────
//
// One bundle artifact of the container's datatype — the upload the run imports.

const DS = 'ds-1'
const BUNDLE_ARTIFACT: ArtifactRow = {
  id: 'art-bundle',
  project_id: 'p-1',
  datatype: HD_BUNDLE_ID,
  structure: {},
  created_at: '2026-08-01T00:00:00Z',
  source_dataset_id: DS,
}

interface Captured {
  spec: unknown
  inputs: RunInput[]
  params: Record<string, unknown>
  opts?: { schedule?: unknown; name?: string; analysisId?: string }
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
    catalog: async () => ({ project_id: 'p-1', axes: [], artifacts: [BUNDLE_ARTIFACT] }),
    artifacts: { query: async () => [BUNDLE_ARTIFACT] },
  } as unknown as DataApi)
  broker.publish('jobs', '1.0.0', {
    run: (async (
      spec: unknown,
      inputs: RunInput[],
      params: Record<string, unknown>,
      opts?: { schedule?: unknown; name?: string; analysisId?: string },
    ) => {
      captured.push({ spec, inputs, params, opts })
      return fakeHandle('job-1')
    }) as unknown as JobsApi['run'],
  } as unknown as JobsApi)
  return {
    version: '1',
    extensionId: 'test',
    registry: {
      analyses: { get: (id: string) => (id === 'spatial.import-visium-hd' ? HD_ANALYSIS : undefined) },
    },
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
  const store = createViewStore(spec, `hd-inputs-${Math.random()}`, res.data)
  for (const [k, v] of Object.entries(state)) store.set(k, v)
  return store
}

/** Interpret the SHIPPED `hd.run` action's `run_processor` effect over the real ctx, and
 *  return what reached `jobs.run`.
 *
 *  Only the `run_processor` effect is interpreted, not the whole body: the trailing
 *  `wait_for`/`toast` are not the seam under test. The effect under test is the SHIPPED one,
 *  taken from the shipped body — not a re-spelling of it. */
async function launch(state: Record<string, unknown>): Promise<Captured> {
  const captured: Captured[] = []
  const api = fakeApi(captured)
  const store = await mountedStore(api, state)
  try {
    const run = spec.actions.find(a => a.id === 'hd.run')!
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

/** Drive the REAL widget path: the picker's option value as the renderer's `toOption`
 *  produces it (coerced through `String(...)`), dispatched through the SHIPPED `hd.setBin`
 *  action, then the SHIPPED `hd.run` action interpreted. This is the path a human pick
 *  actually takes — the defect the direct-seed test missed. */
async function launchViaPicker(bundle: string, optionValue: string | number): Promise<Captured> {
  const captured: Captured[] = []
  const api = fakeApi(captured)
  const store = await mountedStore(api, { bundle })
  try {
    const ctx = { ...createWorkbenchInterpreterCtx({ api }), viewStore: () => store }
    // The renderer's `toOption` coerces the option value through `String(...)` — reproduce
    // that coercion here, so the value dispatched is exactly what a real pick would send.
    const setBin = spec.actions.find(a => a.id === 'hd.setBin')!
    await interpretBody(setBin.body, { view_id: 'v', value: String(optionValue) }, ctx)
    const run = spec.actions.find(a => a.id === 'hd.run')!
    const runProcessorEffects = run.body.filter(e => 'run_processor' in e)
    expect(runProcessorEffects.length).toBe(1)
    await interpretBody(runProcessorEffects, { view_id: 'v' }, ctx)
  } finally {
    store.dispose()
  }
  expect(captured.length).toBe(1)
  return captured[0]
}

describe('visium-hd run inputs — the CHOSEN bin reaches the job as the STRING the picker sends (INV-4)', () => {
  it('the derived container id is the one the shipped view and the container declaration agree on', () => {
    // NON-VACUITY: a derivation that silently returned `undefined` would make every other
    // assertion pass trivially. The id must be a non-empty string that the SHIPPED view
    // declares (the `container_members` slice args and the bundle picker's source) and that
    // the container declaration in the spatial-types manifest actually holds.
    expect(HD_BUNDLE_ID).toBeTruthy()
    expect(typeof HD_BUNDLE_ID).toBe('string')
    expect(viewDeclaredId()).toBe(HD_BUNDLE_ID)
    expect(hdBundle, 'the derived id must name a datatype the shipped manifest declares').toBeTruthy()
    expect(hdRequirements?.requires).toBe('manifest')
  })

  it('launches `spatial.import-visium-hd` with the chosen bin as the STRING the picker sends, and the bundle bound', async () => {
    // The largest bin the SHIPPED container declares — the non-default choice a human would
    // make. Derived, never a literal.
    const bins = offeredBins()
    const chosen = bins[bins.length - 1].value
    // THE REAL WIDGET PATH: the renderer's `toOption` coerces every option value through
    // `String(...)`, so a real pick dispatches the STRING "16", not the number 16. Drive
    // that path — dispatch the SHIPPED `hd.setBin` action with the coerced value, then
    // interpret the SHIPPED `hd.run` body — rather than seeding state directly, which is
    // exactly how the number-vs-string defect escaped the earlier version of this test.
    const { inputs, params, opts } = await launchViaPicker('art-bundle', String(chosen))

    // THE STRING-VALUED SELECT (issue #361): the declarative select is string-valued at the
    // kit level, so `params.bin_um` reaches the compute as the STRING "16" — and the
    // compute's `select_bin` accepts exactly that (see
    // `spatial-import-visium-hd/tests/test_bin_selection.py::test_TEST_16b_*`: an
    // exact-integer string is parsed and imported, returning an `int` with
    // `chose_by == "parameter"`). A regression to a NUMBER here would diverge from what the
    // picker actually sends.
    expect(params.bin_um).toBe(String(chosen))
    expect(typeof params.bin_um).toBe('string')

    // The bundle the user picked is bound to the slot the manifest declares (`appliesTo`).
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'bundle', artifactId: 'art-bundle' }))

    // The processor launched is the one the view's `run_processor` names.
    expect(opts?.analysisId).toBe('spatial.import-visium-hd')
  })

  it('at the DEFAULT (no explicit set) the run carries NO chosen bin', async () => {
    // The defect this catches: the default drifting to a number (8) or to a different
    // string than the importer's own `DEFAULT_BIN_UM`. The store seeds `bin` from the
    // SHIPPED spec's `default` — which is NULL, so an untouched form sends NO bin and the
    // compute takes its own `DEFAULT_BIN_UM`, recording `chose_by == "default"` (D1).
    // Prefilling "8" would make every launch look like a deliberate choice.
    const { params } = await launch({ bundle: 'art-bundle' })
    expect(params.bin_um).toBeNull()
  })

  it('the view’s `container_members` slice resolves against the SHIPPED declaration', async () => {
    // The defect this catches: the `container_members` source wired to the wrong datatype,
    // or the registry lookup broken — the picker would then offer nothing (or the wrong
    // set) while the launch still worked. The resolved slice must be exactly the offer the
    // shipped container's own members imply.
    const api = fakeApi([])
    const store = await mountedStore(api, {})
    try {
      expect(store.data?.bins).toEqual(offeredBins())
    } finally {
      store.dispose()
    }
  })
})
