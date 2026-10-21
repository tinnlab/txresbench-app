// ACCEPTANCE (INV-2/INV-4, "what is launched is what was shown") — a cellranger run CARRIES
// the tunables the user set in the form.
//
// The regression this pins: `manifest.yaml` used to declare a `params:` FORM SCHEMA
// (reference / chemistry / expected_cells / include_introns / create_bam). That key was
// removed feature-wide — correctly, it was presentation — but cellranger shipped no `ui/`
// view to move it into, so the controls simply vanished. The run stayed behaviourally
// unchanged (`compute/cellranger.sh` reads the identical `jqget` fallbacks), and that is
// exactly what makes it invisible: every run silently uses GRCh38 / auto / 3000 / introns-on
// / no-BAM, and a user with mouse data has no way to say so. The launcher's fallback form is
// derived from `appliesTo` alone (`extensions/analysis/inputEconomy.ts::fallbackParamsFor`),
// so it can only ever render one artifact-ref control per SLOT — there is no params escape
// hatch on that surface.
//
// A test asserting "cellranger.yaml has a params block", or that the spec parses, passes
// against a view whose params never reach the job. So this drives the WHOLE chain with no
// assertion on the YAML's text:
//
//   the SHIPPED ui/cellranger.yaml  →  the REAL view store (its declared state + defaults)
//                                   →  the REAL interpreter over the SHIPPED `cr.run` body
//                                   →  the REAL `hostCtx.runProcessor` → `resolveInputs`
//                                   →  the (inputs, params) pair handed to `jobs.run`
//
// and asserts on that pair. Every link is production code; the only mock is the `jobs`/`data`
// capability backend.
//
// It also pins the ONE thing a view that restates a compute default has to guarantee: the
// two copies AGREE. `params` is emitted unconditionally (there is no per-key `when` on the
// `run_processor.params` map), so whatever the view holds IS what the compute receives, and
// `jqget`'s `//` only substitutes on JSON `null`/`false` — an empty-string param sails
// through verbatim and would run `--transcriptome /refdata/`. The view therefore MUST carry
// real defaults, and `the view's defaults ARE the compute's defaults` below is what keeps the
// second copy from drifting.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { ArtifactRow, DataApi } from '@/modules/workbench/extensions/data/contract'
import type { JobFrame, JobHandle, JobsApi, RunInput } from '@/modules/workbench/extensions/jobs/contract'
import { processorAnalysisToContribution } from './loadProcessors'
import { resolveArtifactRefSource } from './axisSource'
import { createWorkbenchInterpreterCtx } from './hostCtx'
import { interpretBody } from './interpreter'
import { resolveViewData, readSliceFromApi } from './viewData'
import { createViewStore, type ViewStore } from './store'
import type { Scope } from './expr'
import { evaluateForm } from '@/modules/workbench/core/form/validity'

const PKG = fileURLToPath(new URL('../../../../../../packages/cellranger/', import.meta.url))
const CR_UI = `${PKG}ui/cellranger.yaml`
const CR_MANIFEST = `${PKG}manifest.yaml`
const CR_COMPUTE = `${PKG}compute/cellranger.sh`

const parsed = parseViewSpec(parseYaml(readFileSync(CR_UI, 'utf8')))
const spec = parsed.value as ViewSpec

const manifest = parseYaml(readFileSync(CR_MANIFEST, 'utf8')) as {
  contributes: { analyses: Array<Record<string, unknown>> }
}
const CELLRANGER_DATA = manifest.contributes.analyses.find(a => a.id === 'cellranger.count') as Record<
  string,
  unknown
>
/** The SHIPPED analysis contribution, built through the REAL loader — so `appliesTo` (and the
 *  `methodsText` template the params feed) are the registered ones, not a fixture. */
const CELLRANGER_ANALYSIS = processorAnalysisToContribution(CELLRANGER_DATA as never, 'cellranger')

// ── the compute's own fallbacks, read out of its source ──────────────────────────────────
//
// The compute is the OTHER copy of every default below. Reading it here (rather than
// restating the five values a third time) is what makes the parity check a real seam: if
// somebody edits `cellranger.sh` and not the view, this file goes red instead of the two
// quietly disagreeing.

/** `jqget <key> <default>` — the `/inputs/params.json` fallbacks `compute/cellranger.sh` owns. */
export function computeParamDefaults(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  // `jqget() { … }` (the definition) has `(` where this needs whitespace, so it drops out.
  for (const m of source.matchAll(/\bjqget\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^)\s]+)/g)) out[m[1]] = m[2]
  return out
}
const COMPUTE_DEFAULTS = computeParamDefaults(readFileSync(CR_COMPUTE, 'utf8'))

/** The `run_processor` block the shipped `cr.run` action declares. */
const RUN_ACTION = spec.actions.find(a => a.id === 'cr.run')
const RUN_BLOCK = (RUN_ACTION?.body ?? []).flatMap(e =>
  'run_processor' in e ? [(e as { run_processor: { params?: Record<string, string> } }).run_processor] : [],
)[0]

// ── the project catalog these tests resolve against ──────────────────────────────────────

const DS = 'ds-1'
const row = (id: string, datatype: string, structure: unknown): ArtifactRow => ({
  id,
  project_id: 'p-1',
  datatype,
  structure,
  created_at: '2026-08-01T00:00:00Z',
  source_dataset_id: DS,
})

const ARTIFACTS: ArtifactRow[] = [
  row('art-fastqs', 'sequence/fastq', { encoding: 'opaque' }),
  row('art-fastqs-2', 'sequence/fastq', { encoding: 'opaque' }),
  // A non-FASTQ artifact in the same project — the picker must not offer it.
  row('art-matrix', 'single-cell/expression', { kind: 'sparse_csc', axes: ['cells', 'genes'], shape: [4, 9] }),
]

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
    artifacts: { query: async () => ARTIFACTS.filter(a => a.datatype === 'sequence/fastq') },
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
    registry: {
      analyses: { get: (id: string) => (id === 'cellranger.count' ? CELLRANGER_ANALYSIS : undefined) },
    },
    capabilities: broker,
    ui: { notify: () => {} },
  } as unknown as WorkbenchAPI
}

/** Resolve the SHIPPED spec's declared `data` slices through the real resolver, then build the
 *  real store over them — so the store's starting state is the spec's OWN declared defaults. */
async function mountedStore(api: WorkbenchAPI, state: Record<string, unknown>): Promise<ViewStore> {
  const scope: Scope = { state }
  const res = await resolveViewData(spec, (key, decl) => readSliceFromApi(api, key, decl, scope))
  const store = createViewStore(spec, `cr-params-${Math.random()}`, res.data)
  for (const [k, v] of Object.entries(state)) store.set(k, v)
  return store
}

/** Interpret the SHIPPED `cr.run` body over the real ctx and return the (inputs, params) pair
 *  that reached `jobs.run`. The WHOLE body runs — `run_processor` → `wait_for` → `toast` —
 *  because none of it needs the global action registry a unit context has not booted. */
async function launch(state: Record<string, unknown>): Promise<Captured> {
  const captured: Captured[] = []
  const api = fakeApi(captured)
  const store = await mountedStore(api, state)
  try {
    expect(RUN_ACTION, 'the view declares no `cr.run` action').toBeTruthy()
    const ctx = { ...createWorkbenchInterpreterCtx({ api }), viewStore: () => store }
    await interpretBody(RUN_ACTION!.body, { view_id: 'v' }, ctx)
  } finally {
    store.dispose()
  }
  expect(captured.length).toBe(1)
  return captured[0]
}

/** Every state field the shipped view declares, with its declared default. */
function declaredDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(spec.state ?? {})) out[k] = (f as { default?: unknown }).default
  return out
}

describe('cellranger view — it PARSES and declares the run', () => {
  it('parses LOUD-clean through parseViewSpec', () => {
    expect(parsed.errors ?? []).toEqual([])
    expect(parsed.ok).toBe(true)
  })

  it('the manifest LISTS it in `ui:` (a view file nothing selects is never registered)', () => {
    expect(CELLRANGER_DATA.ui).toEqual(['ui/cellranger.yaml'])
  })

  it('reads a non-empty default set out of compute/cellranger.sh (vacuity guard)', () => {
    // A reader that silently extracted nothing would make every parity assertion below
    // vacuously true — the same failure the view↔compute seam's vocabulary guard prevents.
    expect(Object.keys(COMPUTE_DEFAULTS).sort()).toEqual([
      'chemistry',
      'create_bam',
      'expected_cells',
      'include_introns',
      'reference',
    ])
  })
})

describe('cellranger run params — what the user SET is what the run CARRIES (INV-4)', () => {
  it('every tunable the form holds reaches the launched run’s `params`', async () => {
    const { params } = await launch({
      fastqs: ['art-fastqs'],
      reference: 'refdata-gex-GRCm39-2024-A',
      chemistry: 'SC3Pv3',
      expected_cells: '8000',
      include_introns: 'false',
      create_bam: 'true',
    })

    // THE property. Without these the run silently uses the compute's fallbacks and a user
    // with mouse data cannot say so.
    expect(params.reference).toBe('refdata-gex-GRCm39-2024-A')
    expect(params.chemistry).toBe('SC3Pv3')
    expect(params.expected_cells).toBe('8000')
    expect(params.include_introns).toBe('false')
    expect(params.create_bam).toBe('true')
  })

  it('the FASTQs travel on the `inputs` channel, never as a param (INV-4 — separate channels)', async () => {
    const { inputs, params } = await launch({ fastqs: ['art-fastqs', 'art-fastqs-2'] })
    // `appliesTo` declares slot `fastqs` (`multiple: true`), so both selected lane sets bind.
    // The `origin` on each entry is binding-origin ITEM-11/ITEM-12: how that slot's
    // binding was chosen. Asserted with `objectContaining` so this test keeps saying what
    // it is about — WHICH artifact lands in WHICH slot — rather than re-asserting a
    // neighbouring change's field on every row.
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'fastqs', artifactId: 'art-fastqs' }))
    expect(inputs).toContainEqual(expect.objectContaining({ slot: 'fastqs', artifactId: 'art-fastqs-2' }))
    // …and an artifact id is never mistaken for a plain value, nor a plain value for an id.
    expect(Object.keys(params)).not.toContain('fastqs')
    const slots = inputs.map(i => i.slot)
    for (const key of Object.keys(COMPUTE_DEFAULTS)) expect(slots).not.toContain(key)
  })

  it('binds ONLY the FASTQs the form selected (the second lane set is not shipped uninvited)', async () => {
    const { inputs } = await launch({ fastqs: ['art-fastqs'] })
    expect(inputs).toEqual([expect.objectContaining({ slot: 'fastqs', artifactId: 'art-fastqs' })])
  })

  // ── the NEGATIVE CONTROL ───────────────────────────────────────────────────────────────
  //
  // An untouched form must produce the run today's users already get: every `jqget` falling
  // to its own fallback. Asserted against the values read out of the compute, not against a
  // list retyped here — a restated list would agree with itself forever.
  it('an UNTOUCHED form launches today’s run — every param equals the compute’s own fallback', async () => {
    const { params } = await launch({ fastqs: ['art-fastqs'] })
    for (const [key, fallback] of Object.entries(COMPUTE_DEFAULTS)) {
      expect(params[key], `untouched \`${key}\` must equal the compute's own fallback`).toBe(fallback)
    }
    // …and it introduces no param the compute does not read: a key with no `jqget` is a
    // control that does nothing, which is the defect class this round removes.
    expect(Object.keys(params).sort()).toEqual(Object.keys(COMPUTE_DEFAULTS).sort())
  })

  it('the view’s DEFAULTS ARE the compute’s defaults (the two copies may not drift)', () => {
    // The view restates them because it must: `run_processor.params` has no per-key `when`,
    // so every key is emitted on every launch, and `jq`'s `// $d` substitutes only on
    // `null`/`false` — a blank view field would reach the compute as "" and NOT be defaulted.
    // Since the second copy is unavoidable, it is PINNED rather than trusted.
    const defaults = declaredDefaults()
    for (const [key, fallback] of Object.entries(COMPUTE_DEFAULTS)) {
      expect(RUN_BLOCK?.params?.[key], `params.${key} must be bound to view state`).toBe(`$state.${key}`)
      expect(defaults[key], `state.${key}.default must equal compute jqget \`${key} ${fallback}\``).toBe(
        fallback,
      )
    }
  })

  it('the params satisfy the manifest’s methodsText template (no literal `$ref` survives)', async () => {
    // `methodsText: "…against $reference (chemistry $chemistry)."` had no way to be satisfied
    // before: the fallback form cannot produce either param, so the sentence rendered its own
    // placeholders. It is a second, independent consumer of this params channel.
    const { params } = await launch({ fastqs: ['art-fastqs'], chemistry: 'SC5P-PE' })
    const text = CELLRANGER_ANALYSIS.methodsText?.(params as never) ?? ''
    expect(text).toContain(COMPUTE_DEFAULTS.reference)
    expect(text).toContain('SC5P-PE')
    expect(text).not.toContain('$reference')
    expect(text).not.toContain('$chemistry')
  })
})

// A param binding is only reachable if a CONTROL feeds the state field it reads. A `params`
// block bound to state nothing can write is a run that is permanently on its defaults — the
// same dead-affordance shape as a picker that resolves to nothing.
describe('cellranger controls — every bound param has a control that can write it', () => {
  const widgets = spec.widgets as unknown as Array<Record<string, unknown>>
  const actionIds = new Set(spec.actions.map(a => a.id))

  it.each(Object.keys(COMPUTE_DEFAULTS))('`%s` is written by a declared control', key => {
    const control = widgets.find(w => w.value === `$state.${key}`)
    expect(control, `no widget is bound to $state.${key}`).toBeTruthy()
    expect(['select', 'text']).toContain(control!.kind)
    // …and its dispatch names a declared action, or the control is decorative.
    expect(actionIds.has(String(control!.onChange))).toBe(true)
  })

  it('the FASTQ picker offers the project’s fastq lane sets, and not the matrix', () => {
    const picker = widgets.find(w => w.id === 'fastqsPicker') as
      | { kind?: string; value?: string; multiple?: boolean; source?: Record<string, unknown> }
      | undefined
    expect(picker?.kind).toBe('artifact_ref')
    expect(picker?.value).toBe('$state.fastqs')
    expect(picker?.multiple).toBe(true)
    const ids = resolveArtifactRefSource(ARTIFACTS, picker!.source as never, { state: {} }).map(o => o.id)
    expect(ids).toContain('art-fastqs')
    expect(ids).toContain('art-fastqs-2')
    expect(ids).not.toContain('art-matrix')
  })

  it('the Run button stays VISIBLE and disabled until its requirements are met (never hidden — the deadlock)', () => {
    const run = widgets.find(w => w.onClick === 'cr.run') as
      | { when?: string; disabledWhen?: string }
      | undefined
    expect(run).toBeTruthy()
    expect(run?.when, 'a hidden Run button is the DeclarativeRegion deadlock').toBeUndefined()
    // The gate is DERIVED from what the controls declare, not restated beside them.
    expect(
      run?.disabledWhen,
      'a hand-written whole-form predicate is a second encoding of the controls\' own ' +
        'requirements, and two encodings of one rule can disagree',
    ).toBeUndefined()

    const gateFor = (state: Record<string, unknown>): boolean =>
      evaluateForm(spec, { params: {}, state, derived: {}, const: spec.const ?? {}, data: {} } as Scope)
        .gate.canSubmit

    // The launchable baseline is the view's OWN declared defaults, read out of the real store
    // — so "complete" means what the shipped view means by it, not what this test guesses.
    const complete = createViewStore(spec, 'cr-gate').state as Record<string, unknown>
    const inputKey = Object.keys(complete).find(k => Array.isArray(complete[k]))
    expect(inputKey, 'the view declares no list-valued input to gate on').toBeTruthy()

    expect(
      gateFor({ ...complete, [inputKey!]: ['art-1'] }),
      'with an input chosen and the declared defaults in place, Run must be launchable — ' +
        'otherwise every assertion below passes for a gate that is simply always closed',
    ).toBe(true)
    expect(gateFor(complete), 'no input — the run reaches the compute with an empty mount').toBe(false)

    // The tunable that goes STRAIGHT into a shell argument. `jqget` substitutes only on JSON
    // `null`/`false`, so an empty or ungrammatical value passes through verbatim — and until
    // now nothing looked at it.
    const numericKey = Object.keys(complete).find(k => {
      const w = widgets.find(x => (x as { value?: string }).value === `$state.${k}`) as
        | { require?: { number?: unknown } }
        | undefined
      return w?.require?.number !== undefined
    })
    expect(numericKey, 'the view declares no numeric requirement to drive').toBeTruthy()
    for (const bad of ['', '  ', '3O00', '1_000', '2.5', '0', '-5']) {
      expect(
        gateFor({ ...complete, [inputKey!]: ['art-1'], [numericKey!]: bad }),
        `${JSON.stringify(bad)} is not a whole positive count, and it would reach the shell verbatim`,
      ).toBe(false)
    }
    expect(
      gateFor({ ...complete, [inputKey!]: ['art-1'], [numericKey!]: '5000' }),
      'a plain whole number is accepted — the negative cases above are not a blanket refusal',
    ).toBe(true)
  })
})
