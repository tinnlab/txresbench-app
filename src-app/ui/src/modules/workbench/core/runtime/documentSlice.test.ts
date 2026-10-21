import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readSliceFromApi } from './viewData'
import type { DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createCapabilityBroker } from '@/modules/workbench/core'

// A `job.result` slice can bind a DOCUMENT, and saying so is mandatory.
//
// The generic tail used to have exactly one reading of an artifact: a columnar table. An
// `opaque` JSON blob that is a discriminated object with members of unequal length — which is
// what several producers write — went through that reader and came back as a table with
// phantom blank rows and no discriminator, and every layer reported success. So the shape is
// now DECLARED (`args.shape`), defaults to the historical `table`, and a mismatch between what
// the binding declared and what the artifact holds is `unsupported` (deterministic; retrying
// cannot clear it) with a dev-warn — never a best-effort decode.

const rows = [{ id: 'doc', created_at: '2026-08-17T10:00:00Z', generator_id: 'p.analysis', structure: {} }]

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

const query = () => vi.fn().mockResolvedValue(rows)

describe('shape: document binds the object itself', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('declares `expect: "document"` to the typed read, not "table"', async () => {
    readColumn.mockResolvedValue({ kind: 'k', a: ['x', 'y'], b: [1] })
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque', shape: 'document' }))
    expect(res?.status).toBe('ready')
    expect(readColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc', expect: 'document' }))
  })

  it('lands the members at their OWN lengths, discriminator included', async () => {
    readColumn.mockResolvedValue({ kind: 'k', a: ['x', 'y'], b: [1] })
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque', shape: 'document' }))
    // The three assertions the columnar decode could not satisfy: the discriminator survives,
    // the short member keeps its own length, and no null was invented to pad it.
    expect((res?.payload as Record<string, unknown>).kind).toBe('k')
    expect((res?.payload as Record<string, unknown>).b).toEqual([1])
    expect((res?.payload as Record<string, unknown>).a).toEqual(['x', 'y'])
  })

  // POSITIVE CONTROL for the default: an undeclared shape is still the historical table read,
  // so the assertions above cannot pass against a resolver that reads documents unconditionally.
  it('an UNDECLARED shape is still a table read — the default did not move', async () => {
    readColumn.mockResolvedValue({ columns: ['a'], rows: [[1]] })
    await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' }))
    expect(readColumn).toHaveBeenCalledWith(expect.objectContaining({ expect: 'table' }))
  })

  it('an empty document is `empty`, not a ready binding over nothing', async () => {
    readColumn.mockResolvedValue({})
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque', shape: 'document' }))
    expect(res?.status).toBe('empty')
  })
})

describe('the declared `kind` discriminator is CHECKED, because it is the field that used to vanish', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('binds when the document carries the declared kind', async () => {
    readColumn.mockResolvedValue({ kind: 'expected', a: [1] })
    const res = await readSliceFromApi(
      api(query()),
      'd',
      slice({ datatype: 'data/opaque', shape: 'document', kind: 'expected' }),
    )
    expect(res?.status).toBe('ready')
  })

  it('refuses a document of a DIFFERENT kind as unsupported, naming both', async () => {
    readColumn.mockResolvedValue({ kind: 'other', a: [1] })
    const res = await readSliceFromApi(
      api(query()),
      'd',
      slice({ datatype: 'data/opaque', shape: 'document', kind: 'expected' }),
    )
    expect(res?.status).toBe('unsupported')
    expect(res?.error).toMatch(/expected/)
    expect(res?.error).toMatch(/other/)
  })

  it('refuses a document carrying NO kind when one was declared', async () => {
    readColumn.mockResolvedValue({ a: [1] })
    const res = await readSliceFromApi(
      api(query()),
      'd',
      slice({ datatype: 'data/opaque', shape: 'document', kind: 'expected' }),
    )
    expect(res?.status).toBe('unsupported')
  })
})

describe('a shape mismatch or an unreadable declaration is `unsupported`, never `error`', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([['columns'], [''], [{}], [42], [['document']]])(
    'refuses shape=%j rather than silently reading a table',
    async raw => {
      const res = await readSliceFromApi(
        api(query()),
        'd',
        slice({ datatype: 'data/opaque', shape: raw }),
      )
      expect(res?.status).toBe('unsupported')
      expect(readColumn, 'nothing is read against an unreadable declaration').not.toHaveBeenCalled()
    },
  )

  it.each([[''], [42], [null]])('refuses kind=%j as unreadable', async raw => {
    const res = await readSliceFromApi(
      api(query()),
      'd',
      slice({ datatype: 'data/opaque', shape: 'document', kind: raw }),
    )
    expect(res?.status).toBe('unsupported')
    expect(readColumn).not.toHaveBeenCalled()
  })

  it('a reader refusing the artifact STRUCTURE is unsupported, not a retryable error', async () => {
    // `UnsupportedArtifactStructure` means this build cannot decode what the producer declared
    // — deterministic, so `error` would send someone to debug a backend that is fine.
    const { UnsupportedArtifactStructure } = await import('@/core/workstore')
    readColumn.mockRejectedValue(new UnsupportedArtifactStructure('doc', {}, 'is a JSON DOCUMENT'))
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' }))
    expect(res?.status).toBe('unsupported')
    expect(res?.error).toMatch(/DOCUMENT/)
  })

  it('a TYPE MISMATCH from the typed read is unsupported too', async () => {
    const { WorkstoreTypeMismatch } = await import('@/core/workstore')
    readColumn.mockRejectedValue(new WorkstoreTypeMismatch('document', 'table', 'artifact doc', 'kind'))
    const res = await readSliceFromApi(
      api(query()),
      'd',
      slice({ datatype: 'data/opaque', shape: 'document' }),
    )
    expect(res?.status).toBe('unsupported')
  })

  // NEGATIVE CONTROL for the classification above: a genuine transport failure must STAY
  // `error`, or "unsupported" would just be the new name for every failure.
  it('a transport failure is still `error` — the two are not merged', async () => {
    readColumn.mockRejectedValue(new Error('socket hang up'))
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' }))
    expect(res?.status).toBe('error')
  })
})

// ── ITEM-41 / INV-9 — the server FOUND it and refused ────────────────────────────────────
//
// A 409 carrying an artifact refusal code is not a transport fault: the artifact was located
// and the server answered definitively. Reporting it as `error` puts "the server may be
// unavailable, or you may not have access" over a server that is fine — vaguer than what is
// known, and pointing at the wrong thing to fix.
describe('a located-and-refused artifact is `unreadable`, and keeps the server\'s sentence', () => {
  beforeEach(() => {
    readColumn.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const refusal = async (code: string, sentence: string) => {
    const { WorkstoreHttpError } = await import('@/core/workstore')
    readColumn.mockRejectedValue(new WorkstoreHttpError(409, `workstore read → ${sentence}`, code, sentence))
    return readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' }))
  }

  it('an unresolvable refusal resolves `unreadable`, NOT `error`', async () => {
    const res = await refusal('ARTIFACT_UNRESOLVABLE', 'missing or changed source: ds-alpha')
    expect(res?.status).toBe('unreadable')
    expect(res?.status).not.toBe('error')
  })

  it('carries the server\'s own sentence as the hint, so the missing source reaches the surface', async () => {
    // INV-9's core. Taken from the error's OWN field, never by regexing the wrapped message —
    // recovering a fact by parsing prose is exactly what the error code was plumbed to stop.
    const res = await refusal('ARTIFACT_UNRESOLVABLE', 'missing or changed source: ds-alpha')
    expect(res?.hint).toContain('ds-alpha')
    // …and the technical string stays available for the details disclosure.
    expect(res?.error).toContain('data/opaque')
  })

  it('a condemned-bytes refusal is `unreadable` too — a region cannot offer either remedy', async () => {
    const res = await refusal('ARTIFACT_NOT_CONFORMING', 'bytes do not conform')
    expect(res?.status).toBe('unreadable')
  })

  // THE CONTROLS that keep the arm narrow. Without these, "unreadable" becomes the new name
  // for every failure and the vocabulary stops meaning anything.
  it('a 409 with NO error code stays `error` — an uncoded refusal is not a diagnosis', async () => {
    const { WorkstoreHttpError } = await import('@/core/workstore')
    readColumn.mockRejectedValue(new WorkstoreHttpError(409, 'conflict'))
    const res = await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' }))
    expect(res?.status).toBe('error')
  })

  it('a 500 carrying no code stays `error`, and a structure refusal stays `unsupported`', async () => {
    const { WorkstoreHttpError, UnsupportedArtifactStructure } = await import('@/core/workstore')
    readColumn.mockRejectedValue(new WorkstoreHttpError(500, 'boom'))
    expect((await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' })))?.status).toBe('error')

    readColumn.mockRejectedValue(new UnsupportedArtifactStructure('a', {}, 'is a JSON DOCUMENT'))
    expect((await readSliceFromApi(api(query()), 'd', slice({ datatype: 'data/opaque' })))?.status).toBe('unsupported')
  })
})
