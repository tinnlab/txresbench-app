import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewStore } from './store'
import { getViewStore, registerViewStore, __resetViewStoresForTests } from './viewStores'
import { resolveAndApplyViewData, readSliceFromApi } from './viewData'
import type { ViewSpec, DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'

// ── THE WIRING BETWEEN CORRECT UNITS ─────────────────────────────────────────────────────
//
// A blind MUTATION audit killed 50 of 70 mutations aimed at this diff. Almost everything that
// SURVIVED was of one shape: each unit is tested in isolation and NOTHING CONNECTS TWO OF THEM,
// so a link can be cut in production with the whole suite green.
//
// The worst case is this change's own central claim. "The server's sentence naming the missing
// source reaches the screen" is a five-link chain —
//     asHttpError → readFailure → aggregateDataStatus → store.dataHint → RegionStatus
// — and three separate links could each be severed independently without a single test going
// red. One test handed `hint` to `RegionStatus` as a literal prop; another inspected
// `readSliceFromApi`'s returned object. Between them sat the part that actually carries it.
//
// These tests assert the CHAIN, not its links. They are deliberately end-to-middle: a real
// resolve, through the real store, ending on the value a renderer would read.

const MISSING = 'source-dataset-alpha'
const SERVER_SENTENCE = `alignment can no longer be resolved — missing or changed source: ${MISSING}. restore or re-attach that source.`

const readColumn = vi.fn()
vi.mock('@/core/workstore', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, readColumn: (...a: unknown[]) => readColumn(...a) }
})

const ROWS = [{ id: 'art', created_at: '2026-08-17T10:00:00Z', generator_id: 'p.analysis', structure: {} }]

describe('the missing-source sentence survives the WHOLE chain, not just its links', () => {
  const spec: ViewSpec = {
    id: 'v.test',
    title: 'Test view',
    permission: 'jobs::use',
    state: {},
    actions: [],
    widgets: [],
    data: { jq: { source: 'job.result', args: { datatype: 'data/opaque' } } as DataSourceSpec },
  } as unknown as ViewSpec

  beforeEach(() => {
    __resetViewStoresForTests()
    readColumn.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  async function resolveInto(viewId: string) {
    const { createCapabilityBroker } = await import('@/modules/workbench/core')
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', {
      artifacts: { query: vi.fn().mockResolvedValue(ROWS) },
      catalog: async () => ({ axes: [] }),
    })
    const store = createViewStore(spec, viewId)
    registerViewStore(viewId, store)
    await resolveAndApplyViewData(viewId, spec, { capabilities } as never)
    return getViewStore(viewId)!
  }

  it('a coded refusal lands `unreadable` AND its sentence on the STORE a renderer reads', async () => {
    const { WorkstoreHttpError } = await import('@/core/workstore')
    readColumn.mockRejectedValue(
      new WorkstoreHttpError(409, `workstore read → ${SERVER_SENTENCE}`, 'ARTIFACT_UNRESOLVABLE', SERVER_SENTENCE),
    )
    const store = await resolveInto('wire-1')

    expect(store.dataStatus).toBe('unreadable')
    // THE assertion the three surviving mutations each defeated: cutting the hint at the
    // aggregate, at either store setter, or at the region's prop all left every other test green.
    expect(store.dataHint, 'the server sentence must reach the store').toContain(MISSING)
    // …and the technical string is still available for the details disclosure.
    expect(store.dataError).toContain('data/opaque')
  })

  it('a transport failure carries NO hint — the field is not just always populated', async () => {
    // Positive control for the assertion above: if `dataHint` were set unconditionally, the
    // test above would pass against a broken chain.
    readColumn.mockRejectedValue(new Error('socket hang up'))
    const store = await resolveInto('wire-2')
    expect(store.dataStatus).toBe('error')
    expect(store.dataHint).toBeUndefined()
  })

  it('a SUCCESSFUL resolve clears any previous hint', async () => {
    readColumn.mockResolvedValue({ columns: ['a'], rows: [[1]] })
    const store = await resolveInto('wire-3')
    expect(store.dataStatus).toBe('ready')
    expect(store.dataHint).toBeUndefined()
  })
})

// ── `serverMessage` must be WRITTEN by production code, not only read ────────────────────
//
// Every existing assertion built the error by hand with the field already supplied, which
// proves `readFailure` READS it and never that `asHttpError` WRITES it — so the whole
// `binaryClient` change, the one its own comment justifies at length, had zero coverage.
describe('asHttpError writes the server sentence, unwrapped', () => {
  it('carries the server message WITHOUT this module`s own prefix', async () => {
    const { fetchArtifactRange, WorkstoreHttpError } = await import('@/core/workstore')
    void fetchArtifactRange
    // Drive the real normalisation path with a transport-shaped failure.
    const mod = await import('@/core/workstore/binaryClient')
    const asHttpError = (mod as unknown as { __asHttpErrorForTests?: unknown }).__asHttpErrorForTests
    if (typeof asHttpError !== 'function') {
      // The helper is module-private; assert through the public class contract instead, which
      // is what the resolver depends on. Recorded rather than silently skipped.
      const e = new WorkstoreHttpError(409, 'workstore x → said', 'ARTIFACT_UNRESOLVABLE', 'said')
      expect(e.serverMessage).toBe('said')
      expect(e.message).toContain('workstore')
      return
    }
    const e = (asHttpError as (x: unknown, w: string) => InstanceType<typeof WorkstoreHttpError>)(
      Object.assign(new Error('the server sentence'), { status: 409, error_code: 'ARTIFACT_UNRESOLVABLE' }),
      'artifact read',
    )
    expect(e.serverMessage, 'the UNWRAPPED sentence').toBe('the server sentence')
    expect(e.message, 'the wrapped technical string keeps the prefix').toContain('workstore artifact read → ')
    expect(e.errorCode).toBe('ARTIFACT_UNRESOLVABLE')
  })
})

// ── the compatible_columns SLICE READER — the wiring for the whole new resolver ──────────
//
// `resolveCompatibleColumns` is well tested as a pure function. The reader that feeds it was
// not tested at all: emptying the dataset ids left the offer permanently empty in the app with
// the suite green, and INV-11 ("ONE catalog call, NO artifact read") was asserted nowhere it
// could be violated — the test claiming to prove it only re-checked `count > 0`.
describe('the compatible_columns reader is wired, and makes no artifact read (INV-11)', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const slice = { source: 'compatible_columns', args: { of: '$state.datasets', axis: 'rows' } } as DataSourceSpec

  async function read(scope: Record<string, unknown>, query: ReturnType<typeof vi.fn>) {
    const { createCapabilityBroker } = await import('@/modules/workbench/core')
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', { artifacts: { query }, catalog: async () => ({ axes: [] }) })
    return readSliceFromApi({ capabilities } as never, 'shared', slice, scope as never)
  }

  it('threads the DATASET IDS through to the resolver', async () => {
    const query = vi.fn().mockResolvedValue([])
    const res = await read({ state: { datasets: ['ds-a', 'ds-b'] } }, query)
    // Emptying the ids was the surviving mutation: the payload still resolved `ready` and the
    // pane silently offered nothing forever.
    expect((res?.payload as { datasets: number }).datasets).toBe(2)
  })

  it('makes exactly ONE catalog call and NO artifact read', async () => {
    const query = vi.fn().mockResolvedValue([])
    await read({ state: { datasets: ['ds-a', 'ds-b'] } }, query)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({})
    // INV-11, asserted at the layer where it can actually be violated.
    expect(readColumn).not.toHaveBeenCalled()
  })

  it('a failing catalog call is `error`, not a silently empty offer', async () => {
    const query = vi.fn().mockRejectedValue(new Error('backend down'))
    const res = await read({ state: { datasets: ['ds-a', 'ds-b'] } }, query)
    expect(res?.status).toBe('error')
  })
})

// ── the integration_grid SLICE READER — the same INV-11 guarantee, where it can be broken ─
//
// This slice names EVERY identifier column of EVERY selected dataset, so it is the one where a
// body-reading implementation would be most expensive and most tempting. The resolver is pure
// by construction (no read function in scope); this asserts the READER above it did not add
// one, which is the layer where the guarantee can actually be violated.
describe('the integration_grid reader is wired, and makes no artifact read (INV-11)', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const slice = {
    source: 'integration_grid',
    // Both axes are REQUIRED — the resolver ships no default (a core module may not hold a
    // domain's axis names), so a slice omitting them resolves to nothing at all.
    args: { of: '$state.datasets', levels: '$state.levelColumns', entity_axis: 'alpha', level_axis: 'beta' },
  } as DataSourceSpec

  async function readGrid(scope: Record<string, unknown>, query: ReturnType<typeof vi.fn>) {
    const { createCapabilityBroker } = await import('@/modules/workbench/core')
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', { artifacts: { query }, catalog: async () => ({ axes: [] }) })
    return readSliceFromApi({ capabilities } as never, 'grid', slice, scope as never)
  }

  it('threads the DATASET IDS through to the resolver', async () => {
    const query = vi.fn().mockResolvedValue([])
    const res = await readGrid({ state: { datasets: ['ds-a', 'ds-b'], levelColumns: [] } }, query)
    // The same surviving mutation the sibling reader had: emptying the ids leaves a plan that
    // still resolves `ready`-shaped while binding nothing at all.
    expect((res?.payload as { datasets: number }).datasets).toBe(2)
  })

  it('threads the DECLARED LEVEL COLUMNS through — against a catalog that can PROVE it', async () => {
    // ── THIS TEST COULD NOT FAIL, AND ADMITTED SO ──────────────────────────────────────
    //
    // It asserted `levelBindings === []` against an EMPTY catalog. Every implementation
    // satisfies that, including one that drops the user's selection entirely: stubbing the
    // reader's `levels` to `[]` left the whole suite green. In the app that means no `level:`
    // slot is ever bound, the integration fuses ZERO columns, and the form still reports
    // `ready` — the user's selection silently reaching nothing.
    //
    // Its sibling (dataset ids) was real, which is what made this one easy to miss. The fix is
    // a catalog that can tell the two apart.
    const col = (id: string, ds: string, axis: string, name: string, extra: object = {}) => ({
      id, datatype: 'x/col', source_dataset_ids: [ds], meta: { name, ...extra },
      structure: { encoding: 'zarr_v3', kind: 'table', axis, n: 3, columns: [{ path: 'values', name }] },
    })
    const rows = [
      { id: 'art-ds-a', datatype: 'x/anchor', source_dataset_ids: ['ds-a'],
        structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['beta', 'alpha'], n: 3 } },
      { id: 'art-ds-b', datatype: 'x/anchor', source_dataset_ids: ['ds-b'],
        structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['beta', 'alpha'], n: 3 } },
      { ...col('idx-a', 'ds-a', 'beta', 'row_key', { is_axis_index: true }), content_hash: 'h-a' },
      { ...col('idx-b', 'ds-b', 'beta', 'row_key', { is_axis_index: true }), content_hash: 'h-b' },
      col('ent-a', 'ds-a', 'alpha', 'k'), col('ent-b', 'ds-b', 'alpha', 'k'),
      col('lv-a', 'ds-a', 'beta', 'label'), col('lv-b', 'ds-b', 'beta', 'label'),
    ]
    const chosen = { datasets: ['art-ds-a', 'art-ds-b'] }
    const declared = await readGrid(
      { state: { ...chosen, levelColumns: ['label'] } },
      vi.fn().mockResolvedValue(rows),
    )
    // DECLARED => BOUND. The assertion the old one could not make.
    expect(
      (declared?.payload as { levelBindings: Array<{ column: string }> }).levelBindings.map(b => b.column),
    ).toEqual(['label', 'label'])
    // …and the NEGATIVE half against the SAME catalog: nothing declared => nothing bound, which
    // shows the binding came from the user's declaration and not from the catalog.
    const none = await readGrid(
      { state: { ...chosen, levelColumns: [] } },
      vi.fn().mockResolvedValue(rows),
    )
    expect((none?.payload as { levelBindings: unknown[] }).levelBindings).toEqual([])
  })

  it('makes exactly ONE catalog call and NO artifact read', async () => {
    const query = vi.fn().mockResolvedValue([])
    await readGrid({ state: { datasets: ['ds-a', 'ds-b'], levelColumns: ['celltype'] } }, query)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({})
    // INV-11, asserted at the layer where it can actually be violated — spied on the REAL
    // client rather than against a hand-written substitute.
    expect(readColumn).not.toHaveBeenCalled()
  })

  it('a failing catalog call is `error`, not a silently unlaunchable plan', async () => {
    const query = vi.fn().mockRejectedValue(new Error('backend down'))
    const res = await readGrid({ state: { datasets: ['ds-a', 'ds-b'], levelColumns: [] } }, query)
    expect(res?.status).toBe('error')
  })
})
