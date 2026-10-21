// @vitest-environment jsdom
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// `$dataStatus` — a view may not state a fact about RESOLVED data while data is RESOLVING.
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The defect this pins was LIVE, and it was live in the most ordinary project there is: one
// candidate. `artifact_ref` pre-selects when a source offers exactly ONE, so on first mount
// the input control lands a value the instant the catalog does — and the axis frame that
// value anchors is still in flight for a beat afterwards. The alert under test was gated on
// `$derived.columns.length == 0`, which is TRUE in that beat, so a user opening a project
// was told their dataset carries no measurements about a dataset that carries dozens.
//
// The sentence was not wrong; it was said in a state it does not name. "No columns yet"
// (`$derived.columns.length == 0`) is the union of two situations — the axis resolved and
// carries nothing, and the axis has not answered yet — and only the first is what the
// sentence is about. Nothing in the `when` grammar could tell them apart: the store has
// tracked `dataStatus` since the rendering-hardening slice, but a VIEW had no way to read
// it. `$dataStatus` is that reading, and this file is the reason to believe it.
//
// ── Why MOUNTED, and why a HELD fetch ────────────────────────────────────────────────
//
// A test that asserts the predicate parses, or that `evalWhen('$dataStatus == empty', …)`
// answers correctly over a hand-built scope, proves nothing about this defect: the bug was
// never in the evaluator, it was WHICH STATE the region is in when the widget renders. So
// every assertion below is made against the MOUNTED pane, driven through the real
// pre-selection, and the in-flight window is made observable by HOLDING the data plane's
// list read rather than by hoping a fake is slow. A plane that answers in a microtask skips
// the window entirely — the same reason the sibling conformance tier gates its preview read
// (`shippedFormConformance.test.tsx::gatePreview`); measured there, a fake that answers
// instantly let a stale-value mutation survive.
//
// ── Why the subject is named by WIDGET ID, and everything else derived ───────────────
//
// This is a REGRESSION pin for one reported defect, so it has to be able to fail when that
// defect returns. A loop over "every alert whose `when` mentions `$dataStatus`" would go
// vacuously green the moment someone reverted the very predicate the file exists to hold in
// place, and a loop over "every alert" cannot state what any of them MEAN. So the ONE thing
// named is the widget id; the package that declares it, the view it sits in, the data-slice
// keys, and the datatypes its controls ask for are all found at runtime. Nothing here spells
// a datatype, an axis or a column name — the same discipline (and the same guard,
// `scripts/lint-no-domain-in-builtin.mjs`) the rest of the workbench builtin is held to.
//
// ── Relationship to `shippedFormConformance.test.tsx` ────────────────────────────────
//
// That tier is BREADTH — every shipped view × every affordance × every candidate
// cardinality, with the fetch always settled. This one is one view, one widget, one
// TIMING. It carries a trimmed copy of that file's wire fixture deliberately rather than
// widening `mountPane` with a gate and a bare-axis arm no other assertion there wants; the
// property that matters is kept, though — the fixture is typed as the WIRE response
// (`ProjectCatalog`) and mapped through the SAME `toProjectCatalog` / `toArtifactRow` the
// app uses, so it can never hand the app data the endpoint could not deliver.

import * as React from 'react'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'

// The ONE external boundary this file mocks: the artifact BYTE read. The
// present-but-unreadable arm below needs every column artifact on the axis to be findable
// in the catalog and unreadable when opened, and that is the only seam where the two come
// apart. Every other arm declares no column artifact at all, so nothing reaches it.
const readerMock = vi.hoisted(() => ({ readColumn: vi.fn() }))
vi.mock('@/core/workstore', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/workstore')>()),
  readColumn: readerMock.readColumn,
}))

import type {
  Artifact as WireArtifact,
  ListedArtifact,
  ProjectCatalog as WireProjectCatalog,
} from '@/api-client/types'
import { datatypeRegistry } from '@/core/datatypes/registry'
import { BOOTSTRAP_LATTICE } from '@/core/datatypes/builtin'
import type { Datatype } from '@/core/datatypes/types'
import type {
  ArtifactRefWidget,
  ViewSpec,
  WidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import type { ProcessorPackage } from '@/modules/workbench/core/manifest/processorPackage'
import { registerProcessorPackage } from '@/modules/workbench/core/runtime/loadProcessors'
import { workbenchRegistry, createWorkbenchApi, type WorkbenchHost } from '@/modules/workbench/core'
import { isDeclarativeRenderSpec, type DeclarativeRenderSpec } from '@/modules/workbench/core/runtime/seam'
import { isAxisScopedSource } from '@/modules/workbench/core/runtime/axisSource'
import { evalWhen, type Scope } from '@/modules/workbench/core/runtime/expr'
import {
  getDeclarativeCanvasHost,
  registerDeclarativeCanvasHost,
  type DeclarativeCanvasHost,
} from './canvasHost'
import { peekStore, __resetDeclarativeMountsForTests } from './declarativeMount'
import { DeclarativeStack } from './DeclarativeRegion'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { workbenchLattice } from '@/modules/workbench/core/host/createHost'
import { toArtifactRow, toProjectCatalog, makeFakeDataHost } from '@/modules/workbench/extensions/data/dataHost'
import type { DataHost } from '@/modules/workbench/extensions/data/contract'
import { DATA_CAPABILITY_ID, JOBS_CAPABILITY_ID } from '@/modules/workbench/extensions'
import type { ComputeHost } from '@/modules/workbench/extensions/jobs/contract'

/** The ONE named thing (see the header): the widget whose sentence this is. */
const ALERT_ID = 'noCriteriaColumnsAlert'
const ALERT_TESTID = `widget-${ALERT_ID}`

/** ITEM-1's sibling: the sentence for the state where the sources ARE there and could not
 *  be read. Named for the same reason the one above is — this file is a regression pin, and
 *  a loop over "every alert mentioning `$dataStatus`" goes vacuously green the moment
 *  someone reverts the predicate it exists to hold in place. */
const UNREADABLE_ALERT_ID = 'unreadableColumnsAlert'
const UNREADABLE_ALERT_TESTID = `widget-${UNREADABLE_ALERT_ID}`

/** The synthetic column name the host-supplied `data` arm lands. Any name would do — it is
 *  read back only through `$derived`, never asserted on. */
const SYNTHETIC_COLUMN = 'measure_a'

// ── jsdom gaps the kit's base-ui controls probe at mount (same set as the sibling tier) ──
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// The shipped package that declares the widget — FOUND, never named
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Resolved from the RUNNER's cwd rather than `import.meta.url`: under jsdom the module URL
 *  is an `http:` one and `fileURLToPath` refuses it. */
function findProcessorsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages')
    if (existsSync(candidate) && readdirSync(candidate).some(d => existsSync(join(candidate, d, 'manifest.yaml')))) {
      return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error('dataStatus gate: no packages/ package root found from ' + process.cwd())
}
const PROCESSORS_DIR = findProcessorsDir()
const ALL_PACKAGE_DIRS = readdirSync(PROCESSORS_DIR).sort()

function readShippedPackage(dir: string): ProcessorPackage | undefined {
  const manifestPath = join(PROCESSORS_DIR, dir, 'manifest.yaml')
  if (!existsSync(manifestPath)) return undefined
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'))
  if (!manifest || typeof manifest.id !== 'string') return undefined
  const uiDir = join(PROCESSORS_DIR, dir, 'ui')
  const views: Record<string, unknown> = {}
  if (existsSync(uiDir)) {
    for (const f of readdirSync(uiDir).filter(x => x.endsWith('.yaml')).sort()) {
      views[`ui/${f}`] = parseYaml(readFileSync(join(uiDir, f), 'utf8'))
    }
  }
  return { manifest, views } as ProcessorPackage
}

/** The shipped package whose view declares {@link ALERT_ID}. Located by walking the shipped
 *  set, so this file names no package, no view file and no datatype. */
function packageDeclaringAlert(): ProcessorPackage {
  for (const dir of ALL_PACKAGE_DIRS) {
    const pkg = readShippedPackage(dir)
    if (!pkg) continue
    for (const raw of Object.values(pkg.views)) {
      if (((raw as ViewSpec).widgets ?? []).some(w => (w as { id?: string }).id === ALERT_ID)) return pkg
    }
  }
  throw new Error(`dataStatus gate: no shipped view declares a widget with id "${ALERT_ID}"`)
}

/** The whole contributed lattice — without it `isA(x, x)` is false for every id and a picker
 *  that is working looks exactly like one that offers nothing. */
function contributedDatatypes(): Datatype[] {
  const out: Datatype[] = []
  for (const dir of ALL_PACKAGE_DIRS) {
    const manifestPath = join(PROCESSORS_DIR, dir, 'manifest.yaml')
    if (!existsSync(manifestPath)) continue
    const manifest = parseYaml(readFileSync(manifestPath, 'utf8'))
    for (const dt of (manifest as { contributes?: { datatypes?: Datatype[] } })?.contributes?.datatypes ?? []) {
      out.push(dt)
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The catalog, shaped as the WIRE carries it
// ═══════════════════════════════════════════════════════════════════════════════════════

const DATASET = 'ds-datastatus'
let artifactSeq = 0

function wireArtifact(over: Partial<WireArtifact> & { datatype: string }): WireArtifact {
  const id = `art-${++artifactSeq}`
  return {
    id,
    content_hash: `sha256:${id}`,
    created_at: '2026-01-01T00:00:00Z',
    dataset_id: DATASET,
    hidden: false,
    is_multifile: true,
    meta: {},
    object_key: `sha256:${id}`,
    output_id: id,
    role: 'artifact',
    logical_bytes: 1,
    status: 'ready',
    structure: {},
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as WireArtifact
}

const matrixStructure = (axes: string[]): unknown => ({
  encoding: 'zarr_v3',
  kind: 'sparse_csc',
  axes,
  shape: axes.map((_, i) => 10 * (i + 1)),
})

/** What a view's controls and slices ask the catalog for — read off their own declarations. */
interface Demand {
  /** the datatype ids the project-wide `artifact_ref` sources ask for. */
  catalogTypes: Set<string>
  /** the axes the `axis_columns` data slices read. */
  axes: Set<string>
  /** every `axis_columns` slice key, split by whether it asks for VALUES or for SOURCES. */
  frameSlices: string[]
  sourceSlices: string[]
}

function demandsOf(specs: ViewSpec[]): Demand {
  const demand: Demand = { catalogTypes: new Set(), axes: new Set(), frameSlices: [], sourceSlices: [] }
  for (const spec of specs) {
    const visit = (widgets: WidgetSpec[] | undefined): void => {
      for (const w of widgets ?? []) {
        if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
        if (w.kind !== 'artifact_ref') continue
        const src = (w as ArtifactRefWidget).source
        if (!src || isAxisScopedSource(src)) continue
        const t = src.subtypes_of ?? src.datatype
        if (t) demand.catalogTypes.add(t)
      }
    }
    visit(spec.widgets)
    for (const [key, decl] of Object.entries(spec.data ?? {})) {
      const d = decl as { source?: string; args?: { axis?: string; as?: string } }
      if (d?.source !== 'axis_columns' || typeof d.args?.axis !== 'string') continue
      demand.axes.add(d.args.axis)
      if (d.args.as) demand.sourceSlices.push(key)
      else demand.frameSlices.push(key)
    }
  }
  return demand
}

/**
 * ONE anchor of each datatype the view's catalog-scoped sources ask for, and NOTHING on the
 * axes its slices read.
 *
 * Both halves are the point. Exactly one anchor is the AUTO-SELECT arm — the arm every
 * one-candidate project hits, and the one the defect was reachable from (with two candidates
 * the control waits for a click and there is no first-mount window at all). A BARE axis is
 * the state the alert's sentence actually names: the slices resolve, find no column artifact,
 * and land an authoritative `empty`.
 */
function wireCatalog(demand: Demand, opts: { columnSources?: number } = {}): WireProjectCatalog {
  const axes = [...demand.axes]
  const artifacts: WireArtifact[] = []
  for (const datatype of demand.catalogTypes) {
    artifacts.push(wireArtifact({ datatype, structure: matrixStructure(axes.length ? axes : ['a', 'b']) }))
  }
  // …and, for the present-but-unreadable arm, N single-member table artifacts sitting on
  // the axis the view's own slices read. They are what makes the two slices DISAGREE: the
  // ids answer straight off these rows, the values need the bytes behind them.
  for (const axis of axes) {
    for (let i = 0; i < (opts.columnSources ?? 0); i++) {
      artifacts.push(
        wireArtifact({
          datatype: 'demo/column',
          meta: { name: `${SYNTHETIC_COLUMN}_${i}` },
          structure: {
            encoding: 'zarr_v3',
            kind: 'table',
            axis,
            columns: [{ name: 'values', kind: 'numeric' }],
          } as never,
        }),
      )
    }
  }
  return {
    project_id: 'p-datastatus',
    axes: axes.map((name, i) => ({ content_hash: `sha256:axis-${name}`, name, length: 10 * (i + 1) })),
    artifacts,
  }
}

/** The host-supplied `data` override for the "columns have landed" arm, keyed by the slices
 *  the view ITSELF declares (a value frame per frame slice, an artifact id per sources
 *  slice) — so this arm needs no knowledge of what those slices are called. */
function resolvedSlices(demand: Demand): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of demand.frameSlices) out[key] = { [SYNTHETIC_COLUMN]: [1, 2, 3] }
  for (const key of demand.sourceSlices) out[key] = { [SYNTHETIC_COLUMN]: 'art-synthetic' }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The HOLD gate over the plane's list read
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * A hold/release gate over `listArtifacts` — the ONE read both the picker's catalog
 * (`useArtifactCatalog`) and the `axis_columns` resolver (`readAxisColumnsSlice`) go
 * through. They cannot be told apart by their arguments (both ask unfiltered), and they must
 * not be: the whole window under test is the one BETWEEN them, so the gate releases in
 * ROUNDS instead. `flushPending` answers whatever is waiting right now and keeps holding, so
 * the first round answers the picker (which pre-selects) and whatever the pre-selection then
 * kicks off is caught by the gate — in flight, observable, and not yet landed.
 */
interface QueryGate {
  /** Hold every subsequent read. */
  hold(): void
  /** How many reads are waiting right now — the proof a fetch is genuinely OUTSTANDING, so
   *  an "alert is absent" assertion cannot pass vacuously against a region that never
   *  started fetching. */
  pending(): number
  /** Answer what is waiting, keep holding what comes next. */
  flushPending(): Promise<void>
  /** Stop holding and let everything settle. */
  release(): Promise<void>
}

function gateQueries(plane: DataHost): { plane: DataHost; gate: QueryGate } {
  let holding = false
  let waiters: Array<() => void> = []
  return {
    plane: {
      ...plane,
      listArtifacts: async (scope, query) => {
        const answer = plane.listArtifacts(scope, query)
        if (holding) await new Promise<void>(resolve => waiters.push(resolve))
        return answer
      },
    },
    gate: {
      hold() {
        holding = true
      },
      pending: () => waiters.length,
      async flushPending() {
        const pending = waiters
        waiters = []
        await act(async () => {
          for (const resolve of pending) resolve()
          // Three microtask turns: the read resolves, the effect it feeds re-renders, and
          // the effect THAT schedules issues its own read (which the gate then holds).
          await Promise.resolve()
          await Promise.resolve()
          await Promise.resolve()
        })
      },
      async release() {
        const pending = waiters
        waiters = []
        holding = false
        await act(async () => {
          for (const resolve of pending) resolve()
          await new Promise(resolve => setTimeout(resolve, 30))
        })
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The harness
// ═══════════════════════════════════════════════════════════════════════════════════════

interface Mounted {
  render: DeclarativeRenderSpec
  viewId: string
  gate: QueryGate
  /** the scope the region published to the canvas host on its last publish. */
  canvasScope(): Scope | undefined
}

function hostFor(wire: WireProjectCatalog): { host: WorkbenchHost; gate: QueryGate } {
  const mapped = toProjectCatalog(wire)
  // `catalog()` (the project OVERVIEW) cannot carry `source_dataset_id`; the LIST read can,
  // and an axis-scoped question is scoped by it. Modelled separately, mapped by the same
  // functions production uses — see `shippedFormConformance.test.tsx::hostFor`.
  const listed: ListedArtifact[] = wire.artifacts.map(a => ({
    ...a,
    source_dataset_ids: [a.dataset_id ?? DATASET],
    source_dataset_names: [a.dataset_id ?? DATASET],
    source_dataset_id: a.dataset_id ?? DATASET,
    source_dataset_name: a.dataset_id ?? DATASET,
  }))
  const rows = listed.map(toArtifactRow)
  const fake = makeFakeDataHost({
    projectId: mapped.project_id,
    artifacts: rows,
    axes: mapped.axes,
    isA: (sub, sup) => workbenchLattice.isA(sub, sup),
  })
  const gated = gateQueries({ ...fake, catalog: async () => mapped })
  const compute = {
    createJob: async () => ({ jobId: 'job-1' }),
    streamJob: (_id: string, onFrame: (f: { phase: string }) => void) => {
      onFrame({ phase: 'completed' })
      return { dispose: () => {} }
    },
  } as unknown as ComputeHost
  const host = {
    projectId: mapped.project_id,
    events: { on: () => ({ dispose: () => {} }), emit: () => {} },
    storage: { get: () => null, set: () => {}, remove: () => {} },
    ui: { notify: () => {}, confirm: async () => true },
    datatypes: workbenchLattice,
    planes: { [DATA_CAPABILITY_ID]: gated.plane, [JOBS_CAPABILITY_ID]: compute },
  } as unknown as WorkbenchHost
  return { host, gate: gated.gate }
}

/** Register a canvas host that RECORDS what core published, restoring whatever was
 *  registered before (the real provider, installed by the extensions barrel) on teardown. */
let restoreCanvasHost: (() => void) | undefined
function recordCanvasPublishes(): () => Scope | undefined {
  const previous = getDeclarativeCanvasHost()
  let last: Scope | undefined
  registerDeclarativeCanvasHost({
    publish: input => {
      last = input.scope
    },
    clear: () => {},
  } satisfies DeclarativeCanvasHost)
  restoreCanvasHost = () => {
    if (previous) registerDeclarativeCanvasHost(previous)
  }
  return () => last
}

async function mountPane(
  options: { resolved?: boolean; hold?: boolean; columnSources?: number } = {},
): Promise<Mounted> {
  const pkg = packageDeclaringAlert()
  const specs = Object.values(pkg.views) as ViewSpec[]
  const demand = demandsOf(specs)
  const wire = wireCatalog(demand, { columnSources: options.columnSources })
  const { host, gate } = hostFor(wire)
  const api = createWorkbenchApi(host, 'datastatus')

  const result = registerProcessorPackage(pkg, workbenchRegistry)
  expect(result.errors, 'the shipped package must register cleanly').toEqual([])
  const contribution = workbenchRegistry.views.all().find(v => result.viewContributionIds.includes(v.id))
  const spec = (contribution as { render?: { spec?: unknown } } | undefined)?.render?.spec
  if (!isDeclarativeRenderSpec(spec)) throw new Error('the package under test is not a declarative pane')

  const canvasScope = recordCanvasPublishes()
  if (options.hold) gate.hold()
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={wire.project_id} viewId="wb" canEdit>
        <DeclarativeStack render={spec} data={options.resolved ? resolvedSlices(demand) : undefined} />
      </WorkbenchProvider>,
    )
  })
  if (!options.hold) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }
  // The view is found by the WIDGET it declares, not by position: a package's `ui:` list is
  // authored in whatever order its contributor wrote it, and the pane may stack several
  // files (INV-3). Position would silently pick the wrong store the day a second file is
  // added ahead of this one.
  const view = spec.views.find(v => (v.view_spec.widgets ?? []).some(w => (w as { id?: string }).id === ALERT_ID))
  if (!view) throw new Error(`dataStatus gate: the registered pane declares no "${ALERT_ID}" widget`)
  return { render: spec, viewId: view.view_id, gate, canvasScope }
}

const alertOnScreen = (): boolean => document.querySelector(`[data-testid="${ALERT_TESTID}"]`) !== null
const unreadableAlertOnScreen = (): boolean =>
  document.querySelector(`[data-testid="${UNREADABLE_ALERT_TESTID}"]`) !== null
/** Whether the pane rendered its FORM at all — the widgets below the status surface. The
 *  `loading` arm of `DeclarativeRegion` unmounts them, so a new status value that fell into
 *  that arm would take the picker the user just used away with it. */
const anyWidgetOnScreen = (): boolean => document.querySelector('[data-testid^="widget-"]') !== null
/** That the view's own input control landed SOMETHING in state — asked without naming the
 *  field, so this file stays free of the view's vocabulary too. */
const anyStateValue = (viewId: string): boolean =>
  Object.values((peekStore(viewId)?.state ?? {}) as Record<string, unknown>).some(v => typeof v === 'string' && v !== '')
/** The lengths of every list-valued `$derived` — the option lists the form offers. */
const derivedListLengths = (viewId: string): number[] =>
  Object.values((peekStore(viewId)?.derived ?? {}) as Record<string, unknown>)
    .filter(Array.isArray)
    .map(v => (v as unknown[]).length)

beforeEach(() => {
  datatypeRegistry.replaceAll([...BOOTSTRAP_LATTICE, ...contributedDatatypes()])
})
afterEach(() => {
  cleanup()
  __resetDeclarativeMountsForTests()
  restoreCanvasHost?.()
  restoreCanvasHost = undefined
})

describe('a view observes its own data status (`$dataStatus`)', () => {
  it('says nothing about a dataset it has not finished reading — the first-mount pre-selection window', async () => {
    const { viewId, gate } = await mountPane({ hold: true })

    // ROUND 1 answers the picker's catalog read. With exactly ONE candidate the control
    // pre-selects, so the input is chosen WITHOUT a user gesture — this is the arm every
    // one-candidate project takes, and the arm the defect was reachable from.
    await gate.flushPending()
    expect(anyStateValue(viewId), 'one candidate ⇒ the picker pre-selects on first mount').toBe(true)

    // …and the read that choice anchors is now IN FLIGHT. Both facts are asserted rather
    // than assumed: without them, "the alert is absent" could pass for a region that never
    // fetched at all, or one that already finished.
    expect(gate.pending(), 'the read the pre-selection anchors is outstanding').toBeGreaterThan(0)
    expect(peekStore(viewId)?.dataStatus, 'nothing has resolved to empty yet').not.toBe('empty')
    expect(
      derivedListLengths(viewId).every(n => n === 0),
      'nothing has landed yet — exactly what the old gate fired on',
    ).toBe(true)

    // THE DEFECT. The sentence is a claim about a dataset that has been READ. Nothing has
    // been read yet.
    expect(alertOnScreen(), 'a view may not state a fact about resolved data mid-fetch').toBe(false)
  })

  it('states it once the declared slices resolve and genuinely carry nothing', async () => {
    const { viewId, gate } = await mountPane({ hold: true })
    await gate.flushPending()
    await gate.release()

    // The slices answered: this project's axis carries no metadata column at all. That is
    // exactly the situation the sentence describes, and it must still be said — a gate that
    // silenced the alert everywhere would "fix" the defect by deleting the affordance.
    expect(peekStore(viewId)?.dataStatus, 'a bare axis resolves to an authoritative empty').toBe('empty')
    expect(alertOnScreen(), 'resolved AND empty is the state the sentence names').toBe(true)
  })

  it('says nothing once the columns have landed', async () => {
    // The host-supplied `data` path (the same one the gallery uses): the slices are already
    // resolved, so the store starts `ready` with real columns. The alert must stay away —
    // this is the arm that catches a gate loosened until it fires unconditionally.
    const { viewId } = await mountPane({ resolved: true })
    expect(anyStateValue(viewId), 'the picker still pre-selects').toBe(true)
    expect(peekStore(viewId)?.dataStatus).toBe('ready')
    expect(Math.max(0, ...derivedListLengths(viewId)), 'the frame landed a column').toBeGreaterThan(0)
    expect(alertOnScreen(), 'a dataset that carries measurements is not told it carries none').toBe(false)
  })

  it('reaches a canvas `when` too — the scope core publishes carries the same reading', async () => {
    // A `when` on a canvas series is evaluated by the SAME `evalWhen` over the scope core
    // publishes to the canvas host (`canvasBinding.ts`). If `$dataStatus` were wired into
    // the render scope only, a series gated on it would resolve `undefined` and silently
    // never draw — the "reads correctly, means something else" failure this grammar has
    // already been extended twice to remove.
    const { viewId, canvasScope } = await mountPane({ resolved: true })
    const scope = canvasScope()
    expect(scope, 'the region publishes its canvas').toBeTruthy()
    expect((scope as Scope).dataStatus).toBe(peekStore(viewId)?.dataStatus)
    expect(evalWhen('$dataStatus == ready', scope as Scope)).toBe(true)
    expect(evalWhen('$dataStatus == empty', scope as Scope)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// ITEM-1 — a region whose FRAME cannot be read reports THAT, not `ready`, and not `empty`.
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The shape, driven end to end rather than argued: the view declares TWO slices over the
// same axis relation. One is answered off the catalog rows alone and resolves `ready`; the
// other opens each of those rows and none of them yields bytes. Worst-of ranked `ready`
// above everything below it, so the region reported a clean `ready` with an empty frame —
// and every sentence in the view is gated on a status, so NOTHING said why the form was
// blank. `empty` would have been worse and was the behaviour before that: it tells the user
// to go and produce an input that has already been produced.
//
// The reads are made to fail at the ONE seam where "findable" and "readable" come apart
// (`readColumn`), so the rows are genuinely present in the catalog throughout — asserted,
// not assumed, by the `as: sources` slice resolving to a non-empty payload in the same run.
//
// ── ITEM-34 UPDATE: the same claim, reached through the LAZY seam ────────────────────────
//
// The shipped view now reads column bodies lazily (`values_for`), so mounting it alone opens
// NO artifact — there is nothing to refuse yet, and the frame is correctly `ready` because
// every column is still described from its declaration. Reaching the unreadable state
// therefore requires what a user does to reach it: NAME a column in a criterion, which is
// what asks for a body.
//
// The claim is unchanged and is still asserted in full — sources resolve, the body refuses,
// the status is `unreadable` (not `ready`, not `empty`), the form stays mounted and the view
// says so. What changed is WHEN a user learns it: eagerly on mount before, on naming a column
// now. That is the direct, accepted cost of not reading 65 bodies to populate a picker, and it
// is recorded as a drift rather than absorbed silently here.
describe('a region reports that its frame could not be READ', () => {
  /** Name a column in a criterion — the gesture that asks for a body under the lazy read. */
  const nameAColumn = async (viewId: string): Promise<void> => {
    const store = peekStore(viewId)
    const offered = (store?.derived?.columns ?? []) as Array<{ value: string }>
    // Non-vacuity: if the picker offered nothing, the criterion below would name nothing and
    // every assertion after it would pass for the wrong reason.
    expect(offered.length, 'the picker must offer a column to name').toBeGreaterThan(0)
    await act(async () => {
      store?.set('criteria', [{ column: offered[0].value, control: '', min: '', max: '', keep: [] }])
      await new Promise(resolve => setTimeout(resolve, 40))
    })
  }

  beforeEach(() => {
    readerMock.readColumn.mockReset()
    readerMock.readColumn.mockRejectedValue(new Error('no bytes for this artifact'))
  })
  afterEach(() => {
    readerMock.readColumn.mockReset()
  })

  it('sources resolve while the frame does not → `unreadable`, and the form stays mounted', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { viewId } = await mountPane({ columnSources: 2 })
    await nameAColumn(viewId)

    expect(anyStateValue(viewId), 'one candidate ⇒ the picker pre-selects').toBe(true)
    // The rows ARE there: the id-answering slice landed a non-empty payload in this very
    // run. Without this the whole scenario could be an empty axis wearing a fault's clothes.
    const landed = Object.values((peekStore(viewId)?.data ?? {}) as Record<string, unknown>)
    expect(
      landed.some(v => v !== null && typeof v === 'object' && Object.keys(v as object).length > 0),
      'the slice that reads no bytes still resolved — the sources are present in the catalog',
    ).toBe(true)
    // …and every one of them was opened and refused.
    expect(readerMock.readColumn.mock.calls.length, 'each source was opened').toBeGreaterThan(0)

    expect(peekStore(viewId)?.dataStatus, 'THE DEFECT: this used to read `ready`').toBe('unreadable')
    // The status must not fall into the arm that unmounts the widgets — that arm would take
    // away the picker the user just used, on a status that is terminal, not in flight.
    expect(anyWidgetOnScreen(), 'a terminal status never unmounts the form').toBe(true)
    errSpy.mockRestore()
  })

  it('the view SAYS it — a state nothing names is a state a user cannot act on', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { viewId } = await mountPane({ columnSources: 2 })
    await nameAColumn(viewId)
    expect(peekStore(viewId)?.dataStatus).toBe('unreadable')
    expect(unreadableAlertOnScreen(), 'the sentence for this state is authored and reached').toBe(true)
    // …and the sentence for the OTHER blank state stays away. Both are "no rows here"; only
    // one of them is answered by "run the analysis that produces the input".
    expect(alertOnScreen(), 'the no-data sentence is not borrowed to explain a failed read').toBe(false)
    errSpy.mockRestore()
  })

  it('reaches a canvas `when` too, and `== empty` stays false there', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { viewId, canvasScope } = await mountPane({ columnSources: 2 })
    await nameAColumn(viewId)
    const scope = canvasScope()
    expect((scope as Scope).dataStatus).toBe(peekStore(viewId)?.dataStatus)
    expect(evalWhen('$dataStatus == unreadable', scope as Scope)).toBe(true)
    expect(evalWhen('$dataStatus == empty', scope as Scope)).toBe(false)
    expect(evalWhen('$dataStatus == ready', scope as Scope)).toBe(false)
    errSpy.mockRestore()
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// TEST-9 (incremental-landing #29, ITEM-1) — under `partial` the region renders a DELIBERATE
// surface: RegionStatus renders its OWN partial copy (not nothing, not a raw status string), and
// the form is NOT unmounted (only `loading` unmounts it — DEC-2). The negative control: a `partial`
// with no arm hits RegionStatus's exhaustive `default` and renders NOTHING — so asserting the
// partial surface RENDERS, and DIFFERS from both loading and ready, is what a missing arm fails.
// ════════════════════════════════════════════════════════════════════════════════════════════

import { RegionStatus, REGION_STATUS_COPY } from './RegionStatus'

describe('TEST-9 — the partial render arm (RegionStatus + the loading gate)', () => {
  afterEach(() => cleanup())

  it('RegionStatus renders its own partial copy — a live, non-blocking "loading more" strip', () => {
    const { getByTestId, queryByTestId } = render(
      <RegionStatus status="partial" viewId="v1" resource="Rows" />,
    )
    const strip = getByTestId('declarative-status-partial-v1')
    // A live region (announced) with the partial copy — deliberate, not a fallthrough to null.
    expect(strip.getAttribute('role')).toBe('status')
    expect(strip.textContent).toContain(REGION_STATUS_COPY.partialLabel)
    // It is NOT the loading skeleton and NOT the empty/error surface — its own arm.
    expect(queryByTestId('declarative-status-loading-v1')).toBeNull()
    expect(queryByTestId('declarative-status-empty-v1')).toBeNull()
  })

  it('partial is a DISTINCT surface from loading (the deliberate-arm proof)', () => {
    const partial = render(<RegionStatus status="partial" viewId="vp" resource="Rows" />)
    expect(partial.queryByTestId('declarative-status-partial-vp')).not.toBeNull()
    cleanup()
    const loading = render(<RegionStatus status="loading" viewId="vl" resource="Rows" />)
    // loading renders the skeleton; partial does not — two different renderings, not one fold.
    expect(loading.queryByTestId('declarative-status-loading-vl')).not.toBeNull()
    expect(loading.queryByTestId('declarative-status-partial-vl')).toBeNull()
  })

  it('the REAL DeclarativeRegion keeps the form mounted under partial, and unmounts it ONLY under loading (DEC-2)', async () => {
    // Mount the actual shipped declarative pane, then drive its store through the lifecycle and read
    // the RENDERED DOM — not a reimplemented predicate. `partial` and `ready` must both keep the
    // widgets on screen (the landed rows paint); `loading` is the ONE arm that unmounts them.
    const { viewId } = await mountPane({ resolved: true })
    expect(peekStore(viewId)?.dataStatus).toBe('ready')
    expect(anyWidgetOnScreen(), 'ready renders the form').toBe(true)

    await act(async () => {
      peekStore(viewId)?.setDataStatus('partial')
    })
    expect(peekStore(viewId)?.dataStatus).toBe('partial')
    expect(anyWidgetOnScreen(), 'partial must NOT unmount the form — the landed rows keep painting').toBe(true)

    await act(async () => {
      peekStore(viewId)?.setDataStatus('loading')
    })
    expect(anyWidgetOnScreen(), 'loading is the one arm that unmounts the form').toBe(false)
  })
})
