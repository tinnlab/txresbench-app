import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ITEM-41 / INV-9 — **the blank-pane regression test.**
//
// `dataHost.readOpaque` used to be `catch { return new Uint8Array() }`. A condemned or
// unresolvable artifact therefore reached the viewer as an EMPTY payload, which every
// viewer in the tree treats as "no data yet" — so the user got a blank pane, with no
// console error, no failed request surfaced, and no crash.
//
// **That is why it survived: a blank surface passes every health check there is.** The
// runtime-health pass, the gallery capture, axe, tsc, the e2e smoke — none of them can
// see this break, because nothing is broken as far as they can tell. Only an assertion
// shaped like this one can.
//
// So this test is written against the SWALLOW, not against the rendering: it asserts the
// failure PROPAGATES, and — the part that makes it a real control — that the error still
// carries the machine-readable code that says which remedy applies. A future refactor
// that reinstates `catch { return new Uint8Array() }` turns both legs red.

const fetchArtifactRange = vi.fn()

vi.mock('@/core/workstore', () => ({
  fetchArtifactRange: (...args: unknown[]) => fetchArtifactRange(...args),
  parseStructure: vi.fn(),
  previewableColumn: vi.fn(),
  previewColumnValues: vi.fn(),
}))

vi.mock('@/core/datatypes', () => ({ fetchColumn: vi.fn() }))

vi.mock('@/api-client', () => ({
  ApiClient: { Workstore: { getArtifact: vi.fn() } },
}))

/** The shape `binaryClient` throws: status + the code the server sent. */
class FakeWorkstoreHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorCode?: string,
  ) {
    super(message)
    this.name = 'WorkstoreHttpError'
  }
}

async function readOpaqueOf(artifactId: string): Promise<Uint8Array> {
  const { createDataHost } = await import('./dataHost')
  const host = createDataHost() as unknown as { readOpaque(id: string): Promise<Uint8Array> }
  return host.readOpaque(artifactId)
}

describe('readOpaque never turns a refusal into an empty payload (INV-9)', () => {
  beforeEach(() => {
    fetchArtifactRange.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  // POSITIVE CONTROL. Without it, every assertion below would pass just as happily
  // against a `readOpaque` that always throws — including one that is broken.
  it('returns the bytes when the read succeeds', async () => {
    fetchArtifactRange.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    await expect(readOpaqueOf('good')).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('PROPAGATES an unresolvable refusal instead of returning an empty array', async () => {
    const refusal = new FakeWorkstoreHttpError(
      409,
      'artifact X is status=unresolvable … missing or changed source: source-dataset-A',
      'ARTIFACT_UNRESOLVABLE',
    )
    fetchArtifactRange.mockRejectedValue(refusal)

    // The whole bug in one assertion: this used to RESOLVE, to an empty Uint8Array.
    await expect(readOpaqueOf('gone')).rejects.toBe(refusal)
  })

  it('PROPAGATES a condemned-bytes refusal too', async () => {
    const refusal = new FakeWorkstoreHttpError(409, 'not conforming', 'ARTIFACT_NOT_CONFORMING')
    fetchArtifactRange.mockRejectedValue(refusal)
    await expect(readOpaqueOf('bad')).rejects.toBe(refusal)
  })

  // The code has to SURVIVE the hop, not merely exist at the transport. If `readOpaque`
  // ever re-wraps into a bare `Error`, the caller is back to parsing prose.
  it('preserves the error code across the host boundary, so the caller need not parse prose', async () => {
    fetchArtifactRange.mockRejectedValue(
      new FakeWorkstoreHttpError(409, 'x', 'ARTIFACT_UNRESOLVABLE'),
    )
    await expect(readOpaqueOf('gone')).rejects.toMatchObject({
      errorCode: 'ARTIFACT_UNRESOLVABLE',
      status: 409,
    })
  })

  it('still propagates a plain transport failure (not only the two 409s)', async () => {
    fetchArtifactRange.mockRejectedValue(new FakeWorkstoreHttpError(500, 'boom'))
    await expect(readOpaqueOf('boom')).rejects.toMatchObject({ status: 500 })
  })
})
