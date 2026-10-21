import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { getActionMeta, runAction } from '@/core/actions/defineAction'
import {
  interpretBody,
  launchIdentityForAction,
  registerViewSpecActions,
  __resetRegisteredSpecsForTests,
  type InterpreterCtx,
  type InterpreterStore,
} from './interpreter'
import { registerViewStore, __resetViewStoresForTests } from './viewStores'
import { strongerOrigin, type BindingOrigin } from './bindingOrigin'
import { createViewStore } from './store'
import { namespaceActionId, describeActionId } from '@/modules/workbench/core/spec/ids'
import {
  capabilitySnapshot,
  __resetCapabilityReportForTests,
} from '@/core/actions/capabilityReport'

// TEST-5 (PLAN.md ITEM-5) — the action-body interpreter: body ops
// `set`/`api`/`run_processor`/`wait_for`/`progress`/`toast` interpret over a mock
// `ctx`; declared-action registration is idempotent (no dup-throw on re-mount).

/** Dotted immutable-ish set for the mock store. */
function setIn(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function mockStore(initial: Record<string, unknown> = {}): InterpreterStore & { state: Record<string, unknown> } {
  const state: Record<string, unknown> = { ...initial }
  return {
    state,
    derived: {},
    token: 'view-1@0',
    set(field, value) {
      setIn(state, field, value)
    },
  }
}

/** A store whose `state` getter returns the LIVE value and whose `set` REPLACES
 *  the state object (like the real reactive `createViewStore`) — so a scope
 *  captured before a `set` is stale unless the interpreter re-reads per effect. */
function liveMockStore(initial: Record<string, unknown> = {}): InterpreterStore {
  let s: Record<string, unknown> = { ...initial }
  return {
    get state() {
      return s
    },
    derived: {},
    token: 'live@0',
    set(field, value) {
      const next = { ...s }
      setIn(next, field, value)
      s = next
    },
  }
}

function makeCtx(over: Partial<InterpreterCtx> = {}): InterpreterCtx {
  return {
    navigate: () => {},
    progress: () => {},
    log: () => {},
    instance: () => undefined,
    instances: () => [],
    stores: { instance: () => undefined, instances: () => [] },
    ...over,
  }
}

beforeEach(() => {
  __resetRegisteredSpecsForTests()
  __resetViewStoresForTests()
})

describe('interpretBody — effect ops (ITEM-5)', () => {
  it('`set` writes a resolved value into the target view store', async () => {
    const store = mockStore({ selectedLayout: 'layout-a' })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ set: { selectedLayout: '$params.value' } }], { view_id: 'view-1', value: 'layout-b' }, ctx)
    expect(store.state.selectedLayout).toBe('layout-b')
  })

  it('`set` interpolates a `{expr}` field path', async () => {
    const store = mockStore({ ranges: {} })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody(
      [{ set: { 'ranges.{$params.criterion}': '$params.range' } }],
      { view_id: 'view-1', criterion: 'metric_a', range: [1, 5] },
      ctx,
    )
    expect((store.state.ranges as Record<string, unknown>).metric_a).toEqual([1, 5])
  })

  it('`api` calls the wired hook with resolved args and captures `into`', async () => {
    const api = vi.fn().mockResolvedValue({ id: 'job-1' })
    const ctx = makeCtx({ viewStore: () => mockStore(), api })
    const bag = await interpretBody(
      [{ api: { call: 'Job.save', args: { jobId: '$params.jobId' }, into: 'saveJob' } }],
      { view_id: 'view-1', jobId: 'j42' },
      ctx,
    )
    expect(api).toHaveBeenCalledWith('Job.save', { jobId: 'j42' })
    expect(bag.saveJob).toEqual({ id: 'job-1' })
  })

  it('`run_processor` + `wait_for` sequence, `wait_for` reads the captured job', async () => {
    const runProcessor = vi.fn().mockResolvedValue({ id: 'run-9' })
    const waitFor = vi.fn().mockResolvedValue({ status: 'completed' })
    const ctx = makeCtx({ viewStore: () => mockStore(), runProcessor, waitFor })
    await interpretBody(
      [
        { run_processor: { id: 'analysis.run', params: { pattern: '$params.pattern' }, into: 'job' } },
        { wait_for: { job: '$job', until: 'completed' } },
      ],
      { view_id: 'view-1', pattern: '^X-' },
      ctx,
    )
    // The 4th argument is the PER-SLOT binding origin (binding-origin ITEM-12); the 5th is the
    // per-slot fused MEMBER SET (ITEM-35, DEC-D). This mock store has neither `originOf` nor
    // `artifactsOf`, so both report nothing — a store that cannot answer must never produce a
    // defaulted `'user'` or an invented set, either of which records something nobody chose.
    expect(runProcessor).toHaveBeenCalledWith('analysis.run', { pattern: '^X-' }, {}, {}, {})
    expect(waitFor).toHaveBeenCalledWith({ id: 'run-9' }, 'completed')
  })

  // The `inputs:` block is a SEPARATE channel from `params` (INV-4) and had NO coverage
  // here, which is how it came to be dropped: the op destructured `{ id, params, into }`,
  // so both shipped views declared `inputs:` and the host received nothing. A merged bag
  // cannot substitute — a plain string param is indistinguishable from an artifact id.
  it('`run_processor` forwards the declared `inputs` as its own argument, refs resolved', async () => {
    const runProcessor = vi.fn().mockResolvedValue({ id: 'run-9' })
    const store = mockStore({ many: ['a1', 'a2'], one: 'a3' })
    const ctx = makeCtx({ viewStore: () => store, runProcessor })
    await interpretBody(
      [
        {
          run_processor: {
            id: 'p.one',
            // A LIST slot and a SINGLE slot, both `$`-refs into view state.
            inputs: { many: '$state.many', one: '$state.one' },
            // A plain-value param. It must stay on the params side: a string param is
            // indistinguishable from an artifact id once the two channels are merged.
            params: { label: 'run A' },
          },
        },
      ],
      { view_id: 'view-1' },
      ctx,
    )
    expect(runProcessor).toHaveBeenCalledWith(
      'p.one',
      { label: 'run A' },
      { many: ['a1', 'a2'], one: 'a3' },
      {},
      {},
    )
  })

  it('`progress` + `toast` route through the wired hooks', async () => {
    const progress = vi.fn()
    const toast = vi.fn()
    const ctx = makeCtx({ viewStore: () => mockStore(), progress, toast })
    await interpretBody(
      [{ progress: '$params.msg' }, { toast: { success: 'Saved' } }],
      { view_id: 'view-1', msg: 'Working…' },
      ctx,
    )
    expect(progress).toHaveBeenCalledWith('Working…')
    expect(toast).toHaveBeenCalledWith({ success: 'Saved' })
  })

  it('throws a clear error when an effect needs an unwired capability', async () => {
    const ctx = makeCtx({ viewStore: () => mockStore() })
    await expect(
      interpretBody([{ api: { call: 'X' } }], { view_id: 'view-1' }, ctx),
    ).rejects.toThrow(/ctx.api is not wired/)
  })

  it('a later `set` in the same body observes an earlier `set` (finding: stale state)', async () => {
    // The store REPLACES its state object on `set`; the second effect reads
    // `$state.a` (written by the first) — only works if the scope is refreshed
    // from the live store per effect, not captured once at body start.
    const store = liveMockStore({ a: 'old', b: 'unset' })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody(
      [{ set: { a: '$params.value' } }, { set: { b: '$state.a' } }],
      { view_id: 'view-1', value: 'fresh' },
      ctx,
    )
    expect(store.state.a).toBe('fresh')
    expect(store.state.b).toBe('fresh') // saw the first effect's write, not the stale 'old'
  })

  it('rejects an interpolated `__proto__` set-path segment (finding: path injection)', async () => {
    const store = mockStore({ ranges: {} })
    const ctx = makeCtx({ viewStore: () => store })
    await expect(
      interpretBody(
        [{ set: { 'ranges.{$params.k}': '$params.value' } }],
        { view_id: 'view-1', k: '__proto__', value: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/illegal interpolated set-path segment/)
    // Object.prototype was not polluted.
    expect(({} as Record<string, unknown>).value).toBeUndefined()
  })

  it('rejects an interpolated segment that injects extra path structure (a dot)', async () => {
    const store = mockStore({ ranges: {} })
    const ctx = makeCtx({ viewStore: () => store })
    await expect(
      interpretBody(
        [{ set: { 'ranges.{$params.k}': '$params.value' } }],
        { view_id: 'view-1', k: 'a.b', value: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/must not contain '\.'/)
  })
})

function specFixture(): ViewSpec {
  return {
    id: 'test/interp',
    title: 'Interp test view',
    permission: 'jobs::use',
    state: { selectedLayout: { type: 'string', default: 'layout-a' } },
    const: {},
    derived: {},
    widgets: [],
    actions: [
      {
        id: 'analysis.setLayout',
        title: 'Set layout',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { value: 'string' },
        body: [{ set: { selectedLayout: '$params.value' } }],
      },
    ],
  }
}

describe('registerViewSpecActions — live registry integration (ITEM-5)', () => {
  it('registers namespaced actions + a describe, and is idempotent (no dup-throw)', () => {
    const spec = specFixture()
    const actionId = namespaceActionId(spec.id, 'analysis.setLayout')

    expect(getActionMeta(actionId)).toBeUndefined()
    registerViewSpecActions(spec)
    // Re-mount: a second call must NOT throw the registry's duplicate-id error.
    expect(() => registerViewSpecActions(spec)).not.toThrow()

    const meta = getActionMeta(actionId)
    expect(meta?.kind).toBe('instance')
    expect(meta?.permission).toBe('jobs::use')
    expect(meta?.stateful).toBe(true)
    // describe synthesized (ITEM-11), AI-only.
    const describe = getActionMeta(describeActionId(spec.id))
    expect(describe?.surfaces).toEqual({ palette: false, ai: true })
  })

  it('a registered declared action drives the live view store through runAction', async () => {
    const spec = specFixture()
    registerViewSpecActions(spec)
    const store = createViewStore(spec, 'live-view-1')
    registerViewStore('live-view-1', store)

    await runAction(namespaceActionId(spec.id, 'analysis.setLayout'), {
      view_id: 'live-view-1',
      value: 'layout-c',
    })
    expect(store.state.selectedLayout).toBe('layout-c')
    store.dispose()
  })

  /// Registration and REPORTING are one act. The backend no longer derives this
  /// population by re-parsing the view_spec; it is told, at the moment the real
  /// set is known. A registration that published nothing would leave the agent
  /// blind to an action the browser can dispatch — invisible to every other test
  /// here, because they all read the local registry.
  it('publishes the projected capabilities for what it just registered', () => {
    __resetCapabilityReportForTests()
    const spec = specFixture()
    // A fresh id per run: `defineAction` is a module-global add-only registry.
    spec.id = `test/report-${Math.random().toString(36).slice(2)}`
    __resetRegisteredSpecsForTests()

    expect(capabilitySnapshot()).toEqual([])
    registerViewSpecActions(spec)

    const reported = capabilitySnapshot()
    expect(reported.map(c => c.id)).toEqual([
      namespaceActionId(spec.id, 'analysis.setLayout'),
      describeActionId(spec.id),
    ])
    // Every reported id resolves in the live registry — "advertised" and
    // "dispatchable" are the same set, which is the whole claim the catalog makes.
    for (const capability of reported) {
      expect(getActionMeta(capability.id)).toBeDefined()
    }
    const [setLayout] = reported
    expect(setLayout).toMatchObject({
      kind: 'instance',
      permission: 'jobs::use',
      stateful: true,
      mutating: true,
    })
    expect(setLayout.params_schema).toMatchObject({ required: ['view_id', 'value'] })
  })

  it('a call_action cycle (A→B→A) trips the depth guard instead of overflowing (finding: recursion)', async () => {
    const specId = 'test/recur'
    const aId = namespaceActionId(specId, 'a')
    const bId = namespaceActionId(specId, 'b')
    const spec: ViewSpec = {
      id: specId,
      title: 'Recursion test',
      permission: 'jobs::use',
      state: {},
      const: {},
      derived: {},
      widgets: [],
      actions: [
        {
          id: 'a',
          title: 'A',
          permission: 'jobs::use',
          params: {},
          body: [{ call_action: { id: bId, params: { view_id: '$params.view_id' } } }],
        },
        {
          id: 'b',
          title: 'B',
          permission: 'jobs::use',
          params: {},
          body: [{ call_action: { id: aId, params: { view_id: '$params.view_id' } } }],
        },
      ],
    }
    registerViewSpecActions(spec)
    const store = createViewStore(spec, 'recur-1')
    registerViewStore('recur-1', store)

    await expect(runAction(aId, { view_id: 'recur-1' })).rejects.toThrow(/recursion too deep/)
    store.dispose()
  })
})

describe('listAppend / listRemove effects (DEC-9)', () => {
  it('listAppend appends an evaluated element to a $state list (creating it if absent)', async () => {
    const store = liveMockStore({ criteria: [{ id: 'metric_a' }] })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody(
      [{ listAppend: { path: 'criteria', value: { id: '$params.id' } } }],
      { view_id: 'v', id: 'metric_b' },
      ctx,
    )
    expect(store.state.criteria).toEqual([{ id: 'metric_a' }, { id: 'metric_b' }])
  })

  it('listAppend on a missing path initializes a fresh list', async () => {
    const store = liveMockStore({})
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ listAppend: { path: 'metrics', value: 'metric_total' } }], { view_id: 'v' }, ctx)
    expect(store.state.metrics).toEqual(['metric_total'])
  })

  it('listRemove by index drops that position', async () => {
    const store = liveMockStore({ criteria: ['a', 'b', 'c'] })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ listRemove: { path: 'criteria', index: '$params.i' } }], { view_id: 'v', i: 1 }, ctx)
    expect(store.state.criteria).toEqual(['a', 'c'])
  })

  it('listRemove by match drops elements whose fields all equal (remove-by-id)', async () => {
    const store = liveMockStore({ criteria: [{ id: 'metric_a' }, { id: 'metric_b' }, { id: 'metric_c' }] })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ listRemove: { path: 'criteria', match: { id: '$params.id' } } }], { view_id: 'v', id: 'metric_b' }, ctx)
    expect(store.state.criteria).toEqual([{ id: 'metric_a' }, { id: 'metric_c' }])
  })

  it('listRemove on a non-array path is a no-op (not an error)', async () => {
    const store = liveMockStore({ criteria: 'not-a-list' })
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ listRemove: { path: 'criteria', index: '0' } }], { view_id: 'v' }, ctx)
    expect(store.state.criteria).toBe('not-a-list')
  })

  it('listAppend without a live store throws (a bounded op needs the instance store)', async () => {
    const ctx = makeCtx({ viewStore: () => undefined })
    await expect(
      interpretBody([{ listAppend: { path: 'x', value: 1 } }], { view_id: 'missing' }, ctx),
    ).rejects.toThrow(/no live view store/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// `run_processor.inputs_from` — the DATA-DRIVEN input repeater.
//
// `inputs` is a literal map, so it can only name slots the author knew at authoring time.
// Some slots are named by the user's own selection: a compute resolves each metadata
// column on `column:<name>`, because a `demo/column` store keeps its values under the
// constant member `values` and cannot carry its own name. `inputs_from` is how a view binds
// those, from the two constructs a spec author already writes (`for_each` + `when`) plus
// `{expr}` slot interpolation.
describe('run_processor.inputs_from — slots whose NAME is data', () => {
  const storeWithColumns = (criteria: unknown[]) => ({
    ...mockStore({ criteria, matrix: 'art-matrix' }),
    data: { sources: { metric_a: 'art-metric', label_a: 'art-label' } },
  })

  const launch = async (
    store: InterpreterStore,
    inputs_from: unknown,
    inputs: Record<string, unknown> = { matrix: '$state.matrix' },
  ): Promise<Record<string, unknown>> => {
    const runProcessor = vi.fn().mockResolvedValue({ id: 'run-1' })
    const ctx = makeCtx({ viewStore: () => store, runProcessor })
    await interpretBody(
      [{ run_processor: { id: 'p.one', inputs, inputs_from } } as never],
      { view_id: 'view-1' },
      ctx,
    )
    return runProcessor.mock.calls[0][2] as Record<string, unknown>
  }

  const COLUMN_BINDING = [
    {
      for_each: '$state.criteria as $c',
      when: '$c.column',
      slot: 'column:{$c.column}',
      artifact: '$data.sources[$c.column]',
    },
  ]

  it('expands one binding per list element, interpolating the slot NAME', async () => {
    const inputs = await launch(
      storeWithColumns([{ column: 'metric_a' }, { column: 'label_a' }]),
      COLUMN_BINDING,
    )
    expect(inputs).toEqual({
      matrix: 'art-matrix',
      'column:metric_a': 'art-metric',
      'column:label_a': 'art-label',
    })
  })

  it('MERGES into the literal `inputs` rather than replacing it', async () => {
    const inputs = await launch(storeWithColumns([{ column: 'metric_a' }]), COLUMN_BINDING, {
      matrix: '$state.matrix',
      rows_index: '',
    })
    // the literal bindings survive verbatim — including an empty one, which the launcher
    // (not this layer) reads as "slot unbound".
    expect(inputs.matrix).toBe('art-matrix')
    expect(inputs.rows_index).toBe('')
    expect(inputs['column:metric_a']).toBe('art-metric')
  })

  it('SKIPS an iteration its `when` gate rejects (a half-built row is not an input)', async () => {
    const inputs = await launch(storeWithColumns([{ column: '' }, { column: 'metric_a' }]), COLUMN_BINDING)
    expect(inputs).toEqual({ matrix: 'art-matrix', 'column:metric_a': 'art-metric' })
  })

  it('THROWS when a gated-in binding resolves no artifact — never a silent drop', async () => {
    // This is the whole point of the construct. A column the user filtered on that never
    // reaches the run produces a keep-EVERYTHING mask at rc=0: the compute treats an absent
    // `column:<name>` as "no constraint" by design ("an unresolved column must never
    // silently hide the dataset"), so the failure has no symptom anywhere else.
    await expect(
      launch(storeWithColumns([{ column: 'not_in_catalog' }]), COLUMN_BINDING),
    ).rejects.toThrow(/column:not_in_catalog.*no artifact/s)
  })

  it('THROWS when the slot name interpolates to nothing', async () => {
    await expect(
      launch(storeWithColumns([{ column: 'metric_a' }]), [
        { for_each: '$state.criteria as $c', slot: '{$c.missing}', artifact: '$state.matrix' },
      ]),
    ).rejects.toThrow(/empty slot name/)
  })

  it('collapses an EXACT duplicate binding (two criteria on one column = one mount)', async () => {
    const inputs = await launch(
      storeWithColumns([{ column: 'metric_a' }, { column: 'metric_a' }]),
      COLUMN_BINDING,
    )
    expect(inputs['column:metric_a']).toBe('art-metric')
  })

  it('accumulates a LIST slot when one slot takes two DIFFERENT artifacts', async () => {
    const store = { ...mockStore({ picks: ['a1', 'a2'] }), data: {} }
    const inputs = await launch(
      store,
      [{ for_each: '$state.picks as $p', slot: 'matrices', artifact: '$p' }],
      {},
    )
    expect(inputs).toEqual({ matrices: ['a1', 'a2'] })
  })

  it('a binding with no `for_each` is a one-shot binding', async () => {
    const store = { ...mockStore({ idx: 'art-idx' }), data: {} }
    expect(await launch(store, [{ slot: 'rows_index', artifact: '$state.idx' }], {})).toEqual({
      rows_index: 'art-idx',
    })
  })

  it('a run_processor with NO inputs_from is byte-identical to before', async () => {
    const store = { ...mockStore({ matrix: 'art-matrix' }), data: {} }
    expect(await launch(store, undefined)).toEqual({ matrix: 'art-matrix' })
  })

  // ── the SAME bindings, read from RENDER ──────────────────────────────────────────────
  //
  // `launchIdentityForAction` evaluates these bindings on EVERY repaint, to answer "is an
  // identical launch already in the air". It is called from `WidgetHost`'s render, so the
  // throws above — correct on the launch path — escaped into the widget error boundary and
  // replaced the Run control with "failed to render".
  //
  // That is a reachable state, not a corner: a binding gated in by `when` whose artifact
  // cannot be resolved is exactly what a form holds when one of its rows names something the
  // currently selected input does not carry. The user loses the one control that would have
  // told them so — and loses it silently, since a boundary placeholder says only that a
  // widget failed.
  describe('the identity read at RENDER time is TOTAL', () => {
    /** Register a one-off spec whose run action carries these bindings, and ask for the
     *  identity the way the host asks for it. A fresh id per case: the action registry is a
     *  module-global add-only map. */
    const identityFor = (
      criteria: unknown[],
      sources: Record<string, string>,
    ): string | undefined => {
      const id = `test/launch-${Math.random().toString(36).slice(2)}`
      const spec = {
        id,
        title: 'Launch',
        permission: 'jobs::use',
        state: {},
        widgets: [],
        actions: [
          {
            id: 'go',
            title: 'Go',
            permission: 'jobs::use',
            mutating: true,
            params: {},
            body: [
              {
                run_processor: {
                  id: 'p.one',
                  inputs: { matrix: '$state.matrix' },
                  inputs_from: COLUMN_BINDING,
                  params: {},
                },
              },
            ],
          },
        ],
      } as unknown as ViewSpec
      registerViewSpecActions(spec)
      return launchIdentityForAction(namespaceActionId(id, 'go'), {
        params: {},
        state: { criteria, matrix: 'art-matrix' },
        derived: {},
        const: {},
        data: { sources },
      })
    }

    it('an UNRESOLVABLE binding yields NO identity instead of throwing', () => {
      // `undefined` is the honest answer, not a swallow: a submission that cannot be built
      // matches nothing in flight, so the in-flight guard has nothing to say.
      expect(() => identityFor([{ column: 'not_in_catalog' }], { metric_a: 'art-metric' })).not.toThrow()
      expect(identityFor([{ column: 'not_in_catalog' }], { metric_a: 'art-metric' })).toBeUndefined()
    })

    it('a RESOLVABLE binding still yields the identity it always did (the control case)', () => {
      const identity = identityFor([{ column: 'metric_a' }], { metric_a: 'art-metric' })
      expect(identity).toContain('p.one::')
      expect(identity).toContain('column:metric_a')
    })

    it('the LAUNCH still refuses the same unresolvable binding — loudly', async () => {
      // The negative control for the totality above: making the render path quiet must not
      // make the run path quiet, because a column that never reaches the run is the silent
      // keep-everything the throw exists to prevent.
      await expect(
        launch(storeWithColumns([{ column: 'not_in_catalog' }]), COLUMN_BINDING),
      ).rejects.toThrow(/no artifact/)
    })
  })
})

// `$data` in an action body's scope. It was absent, so the only artifact ids a view could
// pass were ones already copied into `state` — impossible for a catalog fact the user never
// picks (WHICH artifact a column lives in). Additive: nothing else resolves differently.
describe('$data in the action-body scope', () => {
  it('resolves `$data.<slice>` refs in an effect', async () => {
    const store = { ...mockStore({ k: 'metric_a' }), data: { sources: { metric_a: 'art-metric' } } }
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ set: { picked: '$data.sources[$state.k]' } }], { view_id: 'view-1' }, ctx)
    expect(store.state.picked).toBe('art-metric')
  })

  it('a store exposing no `data` resolves `$data.*` to undefined rather than throwing', async () => {
    const store = mockStore({})
    const ctx = makeCtx({ viewStore: () => store })
    await interpretBody([{ set: { picked: '$data.nope' } }], { view_id: 'view-1' }, ctx)
    expect(store.state.picked).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// binding-origin — the ctx-borne gesture origin, and the per-slot origin of a run's inputs.
//
// (`TEST-5` at the top of this file belongs to the visualize-pane namespace; IDs restart per
// lifecycle. Everything below is the `binding-origin` namespace.)
// ══════════════════════════════════════════════════════════════════════════════════════════

/** A mock store that RECORDS the origin each `set` was given — the thing under test. */
function originRecordingStore(
  initial: Record<string, unknown> = {},
  origins: Record<string, string> = {},
): InterpreterStore & { writes: Array<{ field: string; origin: string | undefined }> } {
  const state: Record<string, unknown> = { ...initial }
  const writes: Array<{ field: string; origin: string | undefined }> = []
  return {
    state,
    derived: {},
    token: 'origin@0',
    writes,
    set(field, value, origin) {
      setIn(state, field, value)
      writes.push({ field, origin })
    },
    originOf(field) {
      // Folds over the SUBTREE, exactly as `createViewStore` does — a mock that answered only
      // the exact key would make the parent-path case above pass against a store nothing
      // ships, which is the opposite of what the test is for.
      //
      // The fold itself is the SHIPPED `strongerOrigin`, not a hand-rolled twin: a mock that
      // re-implements the rule can drift from it, and then the mock is what the test proves.
      let out = origins[field] as BindingOrigin | undefined
      for (const [path, o] of Object.entries(origins)) {
        if (path.startsWith(`${field}.`)) out = strongerOrigin(out, o as BindingOrigin)
      }
      return out
    },
  }
}

describe('TEST-7 (binding-origin / ITEM-4) — the gesture origin reaches every set', () => {
  it("a body run with ctx.__bindingOrigin='auto' stamps every set it performs", () => {
    const store = originRecordingStore()
    const ctx = {
      viewStore: () => store,
      __bindingOrigin: 'auto',
    } as unknown as InterpreterCtx
    return interpretBody([{ set: { a: 'x', b: 'y' } }] as never, { view_id: 'v' }, ctx).then(() => {
      // BOTH — one gesture writes one origin however many fields it touches.
      expect(store.writes).toEqual([
        { field: 'a', origin: 'auto' },
        { field: 'b', origin: 'auto' },
      ])
    })
  })

  it('a body with no ctx origin passes undefined, leaving the store default to decide', () => {
    // Deliberately `undefined` rather than a literal `'user'` here: the fallback is decided
    // in exactly ONE place (`ViewStore.set`'s default parameter). Two places deciding it is
    // how the two come to disagree.
    const store = originRecordingStore()
    const ctx = { viewStore: () => store } as unknown as InterpreterCtx
    return interpretBody([{ set: { a: 'x' } }] as never, { view_id: 'v' }, ctx).then(() => {
      expect(store.writes).toEqual([{ field: 'a', origin: undefined }])
    })
  })

  it('the origin PROPAGATES into a nested call_action', async () => {
    // Conservative direction, on purpose: a chain begun by an auto-bind writes auto
    // throughout. Over-reporting an unreviewed binding is a false alarm; under-reporting one
    // is the defect this change exists to fix.
    __resetRegisteredSpecsForTests()
    const store = originRecordingStore()
    const spec = {
      id: `origin/chain-${Math.random().toString(36).slice(2)}`,
      title: 'Chain',
      permission: 'studies::use',
      state: {},
      const: {},
      derived: {},
      actions: [{ id: 'inner', title: 'Inner', mutating: true, body: [{ set: { inner: 'z' } }] }],
      widgets: [],
    } as unknown as ViewSpec
    registerViewSpecActions(spec)

    const ctx = {
      viewStore: () => store,
      __bindingOrigin: 'auto',
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ call_action: { id: namespaceActionId(spec.id, 'inner'), params: { view_id: 'v' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(store.writes.some(w => w.field === 'inner' && w.origin === 'auto')).toBe(true)
  })
})

describe('TEST-8 (binding-origin / ITEM-12) — a run_processor slot reports how its binding was chosen', () => {
  it('derives the per-slot origin from the DECLARED inputs: expression', async () => {
    const store = originRecordingStore(
      { picked: 'artifact-1', chosen: 'artifact-2' },
      { picked: 'auto', chosen: 'user' },
    )
    const calls: Array<{ inputs: unknown; origins: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_id: string, _p: unknown, inputs: unknown, origins: unknown) => {
        calls.push({ inputs, origins })
        return {}
      },
    } as unknown as InterpreterCtx

    await interpretBody(
      [
        {
          run_processor: {
            id: 'proc',
            inputs: { guessed: '$state.picked', deliberate: '$state.chosen' },
          },
        },
      ] as never,
      { view_id: 'v' },
      ctx,
    )

    // The two slots hold DIFFERENT artifacts here only to keep the fixture readable; what is
    // asserted is that the origins arrive per slot from the declaration, not from the values.
    expect(calls[0].inputs).toEqual({ guessed: 'artifact-1', deliberate: 'artifact-2' })
    expect(calls[0].origins).toEqual({ guessed: 'auto', deliberate: 'user' })
  })

  it('the SAME artifact in two slots is still reported per slot', async () => {
    // The case that makes attributing a resolved VALUE back to a field unsound: with one
    // compatible candidate in the project, two slots holding the same artifact is the common
    // case rather than a corner one.
    const store = originRecordingStore(
      { picked: 'artifact-1', chosen: 'artifact-1' },
      { picked: 'auto', chosen: 'user' },
    )
    const calls: Array<{ origins: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_i: string, _p: unknown, _in: unknown, origins: unknown) => {
        calls.push({ origins })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { a: '$state.picked', b: '$state.chosen' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].origins).toEqual({ a: 'auto', b: 'user' })
  })

  it('a slot CANNOT name several state paths — the language refuses it, so the fold is single-ref', async () => {
    // Written after the multi-ref case was attempted and found unreachable, and kept because
    // the REASON is the interesting part. `inputs:` values go through `evalExpr`, which admits
    // exactly one clean `$`-reference and rejects anything else as arbitrary code — so a slot
    // can never name two paths, and `declaredInputOrigins`' fold across references is
    // defensive rather than load-bearing HERE. (The fold that IS load-bearing is the one in
    // `ViewStore.originOf`, over a path's subtree — the next test is its shape.)
    //
    // Asserting the constraint keeps this honest: if the language ever admits a compound
    // expression, this goes red and the fold's reachability gets re-decided deliberately.
    const store = originRecordingStore({ a: 'art-1', b: 'art-2' }, { a: 'user', b: 'auto' })
    const ctx = {
      viewStore: () => store,
      runProcessor: () => ({}),
    } as unknown as InterpreterCtx
    await expect(
      interpretBody(
        [{ run_processor: { id: 'p', inputs: { both: '$state.a and $state.b' } } }] as never,
        { view_id: 'v' },
        ctx,
      ),
    ).rejects.toThrow(/no arbitrary code allowed/)
  })

  it('a slot whose declaration reads a PARENT path reports what was written beneath it', async () => {
    // The shape a shipped view actually has: it declares its input as a bare `$state.<field>`
    // while the control filling it writes an INDEXED child, one entry per repeated row. An
    // exact-key lookup answered `undefined` for the very slot the run consumes, so a DECLARED
    // auto-bind could never report its own origin and the launch went out claiming nothing
    // was guessed.
    const store = originRecordingStore({ picked: ['col'] }, { 'picked.0': 'auto' })
    const calls: Array<{ origins: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_i: string, _p: unknown, _in: unknown, origins: unknown) => {
        calls.push({ origins })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { chosen: '$state.picked' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].origins).toEqual({ chosen: 'auto' })
  })

  it('a slot whose declaration reads no state gets NO origin — absent is not auto', async () => {
    const store = originRecordingStore({ picked: 'artifact-1' }, { picked: 'auto' })
    const calls: Array<{ origins: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_i: string, _p: unknown, _in: unknown, origins: unknown) => {
        calls.push({ origins })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { literal: 'artifact-9' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].origins).toEqual({})
  })

  it('a store that cannot answer yields nothing rather than a guess', async () => {
    // `originOf` is OPTIONAL on `InterpreterStore` so a mock may omit it (DEC-4). A store
    // that cannot answer must produce no origins at all — never a defaulted `'user'`, which
    // would record a review nobody performed.
    const bare = mockStore({ picked: 'artifact-1' })
    const calls: Array<{ origins: unknown }> = []
    const ctx = {
      viewStore: () => bare,
      runProcessor: (_i: string, _p: unknown, _in: unknown, origins: unknown) => {
        calls.push({ origins })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { s: '$state.picked' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].origins).toEqual({})
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// TEST-43 (member-set carry / ITEM-35, DEC-D) — the gesture's fused member set reaches every
// set, and a run_processor slot reports its members from the DECLARED expression.
//
// The exact twin of TEST-7/TEST-8 above, one channel over: `__bindingArtifacts` rides the ctx
// like `__bindingOrigin`, and `declaredInputArtifacts` reads `artifactsOf` off the declaration
// like `declaredInputOrigins` reads `originOf`. This is the interpreter link between TEST-43's
// two ends (the widget writes the set; `resolveInputs` binds every member).
// ══════════════════════════════════════════════════════════════════════════════════════════

/** A mock store recording the ARTIFACTS each set was given, and answering `artifactsOf` from a
 *  provided map (folding a bare field's indexed children, as the real store does). */
function memberSetRecordingStore(
  initial: Record<string, unknown> = {},
  sets: Record<string, readonly string[]> = {},
): InterpreterStore & { writes: Array<{ field: string; artifacts: readonly string[] | undefined }> } {
  const state: Record<string, unknown> = { ...initial }
  const writes: Array<{ field: string; artifacts: readonly string[] | undefined }> = []
  return {
    state,
    derived: {},
    token: 'members@0',
    writes,
    set(field, _value, _origin, artifacts) {
      setIn(state, field, _value)
      writes.push({ field, artifacts })
    },
    artifactsOf(field) {
      const exact = sets[field]
      if (exact) return exact
      const prefix = `${field}.`
      const children = Object.keys(sets)
        .filter(p => p.startsWith(prefix))
        .sort()
      if (children.length === 0) return undefined
      const seen = new Set<string>()
      const out: string[] = []
      for (const path of children) for (const id of sets[path]) if (!seen.has(id)) (seen.add(id), out.push(id))
      return out.length > 0 ? out : undefined
    },
  }
}

describe('TEST-43 (member-set carry / ITEM-35) — the gesture member set reaches every set', () => {
  it("a body run with ctx.__bindingArtifacts stamps the set it performs", () => {
    const store = memberSetRecordingStore()
    const ctx = {
      viewStore: () => store,
      __bindingArtifacts: ['a1', 'b1'],
    } as unknown as InterpreterCtx
    return interpretBody([{ set: { picked: 'a1' } }] as never, { view_id: 'v' }, ctx).then(() => {
      expect(store.writes).toEqual([{ field: 'picked', artifacts: ['a1', 'b1'] }])
    })
  })

  it('a body with no ctx member set passes undefined — the unfused common case', () => {
    const store = memberSetRecordingStore()
    const ctx = { viewStore: () => store } as unknown as InterpreterCtx
    return interpretBody([{ set: { picked: 'a1' } }] as never, { view_id: 'v' }, ctx).then(() => {
      expect(store.writes).toEqual([{ field: 'picked', artifacts: undefined }])
    })
  })

  it('the member set attaches ONLY to the field that NAMES a member, not a sibling reset (FIX_ROUND-1)', () => {
    // A fused-pick onChange that also resets a dependent list writes TWO fields in one gesture.
    // The member set describes the fused VALUE, so it must land on `picked` (which holds `a1`, a
    // member) and NOT on `dependent` (reset to []). Broadcasting it — the way `origin` is — would
    // let a run declaring `$state.dependent` bind artifacts that field's value never named.
    const store = memberSetRecordingStore()
    const ctx = {
      viewStore: () => store,
      __bindingArtifacts: ['a1', 'b1'],
    } as unknown as InterpreterCtx
    return interpretBody([{ set: { picked: 'a1', dependent: [] } }] as never, { view_id: 'v' }, ctx).then(() => {
      expect(store.writes).toEqual([
        { field: 'picked', artifacts: ['a1', 'b1'] },
        { field: 'dependent', artifacts: undefined },
      ])
    })
  })
})

describe('TEST-43 (member-set carry / ITEM-35) — a run_processor slot reports its members', () => {
  it('derives the per-slot member set from the DECLARED inputs: expression', async () => {
    const store = memberSetRecordingStore({ picked: 'a1', plain: 'c1' }, { picked: ['a1', 'b1'] })
    const calls: Array<{ inputs: unknown; members: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_id: string, _p: unknown, inputs: unknown, _o: unknown, members: unknown) => {
        calls.push({ inputs, members })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'proc', inputs: { colour: '$state.picked', other: '$state.plain' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    // The stored values stay the single primary ids; only the FUSED slot carries a member set.
    expect(calls[0].inputs).toEqual({ colour: 'a1', other: 'c1' })
    expect(calls[0].members).toEqual({ colour: ['a1', 'b1'] })
  })

  it('a slot whose declaration reads a PARENT path reports the members written beneath it', async () => {
    const store = memberSetRecordingStore({ picked: ['a1'] }, { 'picked.0': ['a1', 'b1'] })
    const calls: Array<{ members: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_i: string, _p: unknown, _in: unknown, _o: unknown, members: unknown) => {
        calls.push({ members })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { chosen: '$state.picked' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].members).toEqual({ chosen: ['a1', 'b1'] })
  })

  it('an UNFUSED slot gets NO member set — absent is not an empty set (negative control)', async () => {
    const store = memberSetRecordingStore({ picked: 'a1' }, {})
    const calls: Array<{ members: unknown }> = []
    const ctx = {
      viewStore: () => store,
      runProcessor: (_i: string, _p: unknown, _in: unknown, _o: unknown, members: unknown) => {
        calls.push({ members })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { s: '$state.picked' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].members).toEqual({})
  })

  it('a store that cannot answer artifactsOf yields nothing rather than a guess', async () => {
    const bare = mockStore({ picked: 'a1' })
    const calls: Array<{ members: unknown }> = []
    const ctx = {
      viewStore: () => bare,
      runProcessor: (_i: string, _p: unknown, _in: unknown, _o: unknown, members: unknown) => {
        calls.push({ members })
        return {}
      },
    } as unknown as InterpreterCtx
    await interpretBody(
      [{ run_processor: { id: 'p', inputs: { s: '$state.picked' } } }] as never,
      { view_id: 'v' },
      ctx,
    )
    expect(calls[0].members).toEqual({})
  })
})

describe('TEST-9 (binding-origin / DEC-6) — the render-path identity guard is untouched by origin', () => {
  beforeEach(() => {
    __resetRegisteredSpecsForTests()
    __resetViewStoresForTests()
  })

  it('two form states differing ONLY in origin produce the SAME launch identity', async () => {
    // A run is the same run whoever bound it. Folding origin into the identity would silently
    // stop the duplicate-launch guard from matching, disabling nothing and re-enabling a
    // double-submit — a behaviour change nobody asked for. It would also put a store lookup
    // on a function that runs from RENDER on every repaint, where a throw replaces the Run
    // control with "failed to render".
    const specId = `origin/identity-${Math.random().toString(36).slice(2)}`
    const spec = {
      id: specId,
      title: 'Identity',
      permission: 'studies::use',
      state: { picked: { type: 'string', default: null } },
      const: {},
      derived: {},
      actions: [
        {
          id: 'go',
          title: 'Go',
          mutating: true,
          body: [{ run_processor: { id: 'proc', inputs: { s: '$state.picked' } } }],
        },
      ],
      widgets: [],
    } as unknown as ViewSpec
    registerViewSpecActions(spec)

    const chosen = createViewStore(spec, 'id-user')
    const guessed = createViewStore(spec, 'id-auto')
    chosen.set('picked', 'artifact-1')
    guessed.set('picked', 'artifact-1', 'auto')

    const actionId = namespaceActionId(specId, 'go')
    const idUser = launchIdentityForAction(actionId, {
      state: chosen.state,
      derived: {},
      data: {},
      params: {},
    })
    const idAuto = launchIdentityForAction(actionId, {
      state: guessed.state,
      derived: {},
      data: {},
      params: {},
    })

    expect(idUser).toBeTruthy()
    expect(idAuto).toBe(idUser)

    chosen.dispose()
    guessed.dispose()
  })
})
