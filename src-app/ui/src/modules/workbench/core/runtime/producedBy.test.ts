import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readSliceFromApi } from './viewData'
import type { DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createCapabilityBroker } from '@/modules/workbench/core'

// `job.result` narrowed to the PRODUCING ANALYSIS.
//
// Without it a slice says only "the newest artifact of this datatype", and a datatype is not
// a selector: `data/opaque` alone is emitted by the demo analysis, by a sibling integrator's
// `integration_summary`, and by that same analysis' OWN summary sidecar. So a form reading
// its preflight bound correctly until the first real run, after which a different artifact of
// the same datatype became newest, the expected keys were absent, and the table rendered its
// empty state — a correct-looking form over the wrong artifact, failing no gate.
//
// It is also invisible to a test written against a fresh database, because the artifact that
// shadows it does not exist until a run happens. These tests therefore seed BOTH.

const rows = [
  { id: 'preflight', created_at: '2026-08-17T10:00:00Z', generator_id: 'preflight.analysis', structure: {} },
  // NEWER, same datatype, different producer — the shadowing artifact.
  { id: 'sidecar', created_at: '2026-08-17T11:00:00Z', generator_id: 'other.analysis', structure: {} },
]

// The real broker, published exactly as `viewData.test.ts`'s own fixture does — a
// hand-rolled `resolve` stub would test my stub rather than the accessor the code uses.
function api(query: ReturnType<typeof vi.fn>) {
  const capabilities = createCapabilityBroker()
  capabilities.publish('data', '1.0.0', {
    artifacts: { query },
    catalog: async () => ({ axes: [] }),
  })
  return { capabilities } as never
}

const readColumn = vi.fn()
vi.mock('@/core/workstore', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, readColumn: (...a: unknown[]) => readColumn(...a) }
})

function slice(args: Record<string, unknown>): DataSourceSpec {
  return { source: 'job.result', args } as DataSourceSpec
}

describe('produced_by narrows a job.result slice to its producing analysis', () => {
  beforeEach(() => {
    readColumn.mockReset()
    readColumn.mockResolvedValue({ columns: ['candidates'], rows: [[{ key: 'ensembl_id' }]] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  // POSITIVE CONTROL, and it is the pre-fix behaviour: with no narrowing the slice binds the
  // NEWEST row — the sidecar. Without this the assertions below would pass against a resolver
  // that always picked the preflight for unrelated reasons.
  it('without produced_by, binds the newest of the datatype (the shadowing artifact)', async () => {
    const query = vi.fn().mockResolvedValue(rows)
    const res = await readSliceFromApi(api(query), 'jq', slice({ datatype: 'data/opaque' }))
    expect(res?.status).toBe('ready')
    expect(readColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'sidecar' }))
  })

  it('with produced_by, binds the named analysis OVER a newer artifact of the same datatype', async () => {
    const query = vi.fn().mockResolvedValue(rows)
    const res = await readSliceFromApi(
      api(query),
      'jq',
      slice({ datatype: 'data/opaque', produced_by: 'preflight.analysis' }),
    )
    expect(res?.status).toBe('ready')
    // The whole defect in one assertion.
    expect(readColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'preflight' }))
  })

  it('accepts a LIST of producers', async () => {
    const query = vi.fn().mockResolvedValue(rows)
    await readSliceFromApi(
      api(query),
      'jq',
      slice({ datatype: 'data/opaque', produced_by: ['nope.analysis', 'preflight.analysis'] }),
    )
    expect(readColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'preflight' }))
  })

  // The constraint that matters most: a declared narrowing matching nothing must NOT widen
  // back to the newest. That fallback is the original defect wearing a parameter that looks
  // like it is working.
  it('a produced_by matching NOTHING resolves to empty — it never falls back to newest', async () => {
    const query = vi.fn().mockResolvedValue(rows)
    const res = await readSliceFromApi(
      api(query),
      'jq',
      slice({ datatype: 'data/opaque', produced_by: 'never.ran' }),
    )
    expect(res?.status).toBe('empty')
    expect(readColumn).not.toHaveBeenCalled()
  })

  it('ignores a row carrying no generator_id rather than counting it as a match', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'orphan', created_at: '2026-08-17T12:00:00Z', structure: {} }])
    const res = await readSliceFromApi(
      api(query),
      'jq',
      slice({ datatype: 'data/opaque', produced_by: 'preflight.analysis' }),
    )
    expect(res?.status).toBe('empty')
  })
})

describe('a malformed produced_by is LOUD, never a silent widening', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([[''], [[]], [[123]], [{}], [['ok', '']]])(
    'refuses produced_by=%j as unsupported instead of widening to newest',
    async raw => {
      const query = vi.fn().mockResolvedValue(rows)
      const res = await readSliceFromApi(
        api(query),
        'jq',
        slice({ datatype: 'data/opaque', produced_by: raw }),
      )
      expect(res?.status).toBe('unsupported')
      expect(res?.error).toContain('produced_by')
      // The point: it did NOT bind the newest row anyway.
      expect(readColumn).not.toHaveBeenCalled()
    },
  )

  it('a well-formed produced_by is not flagged (the control for the refusals above)', async () => {
    readColumn.mockResolvedValue({ columns: ['c'], rows: [[1]] })
    const query = vi.fn().mockResolvedValue(rows)
    const res = await readSliceFromApi(
      api(query),
      'jq',
      slice({ datatype: 'data/opaque', produced_by: 'preflight.analysis' }),
    )
    expect(res?.status).toBe('ready')
  })
})
