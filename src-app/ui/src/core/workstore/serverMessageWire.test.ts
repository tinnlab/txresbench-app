import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// T2 — `serverMessage` must be WRITTEN by production code, not merely read.
//
// Every previous assertion about this field built the error BY HAND with the value already
// supplied, which proves the resolver READS it and never that the transport WRITES it. A
// mutation audit removed the argument at the single site that populates it and the whole suite
// stayed green: the entire `binaryClient` change — the one whose own comment argues at length
// that "a regex over `message` is parsing prose to recover a fact" — had zero coverage.
//
// So this drives the REAL normalisation path: the generated client rejects, and the error that
// comes out the other side is inspected.

// SPIED, not module-mocked: the generated client is a proxy whose shape a hand-written factory
// cannot reproduce, and a factory that fails to intercept leaves the real method in place — the
// mock silently does nothing and the test measures the wrong thing.
import { ApiClient } from '@/api-client'

let getArtifactData: ReturnType<typeof vi.spyOn>

/** The shape the framework client hands up: a message plus the two fields it stamps from the
 *  JSON error body. Built here as the TRANSPORT's output, never as this module's input. */
function serverRejection(message: string, code: string, status = 409): Error {
  return Object.assign(new Error(message), { status, error_code: code })
}

describe('the transport carries the server sentence, unwrapped, on every refusal', () => {
  beforeEach(() => {
    getArtifactData = vi.spyOn(ApiClient.Workstore, 'getArtifactData')
  })
  afterEach(() => vi.restoreAllMocks())

  const SENTENCE =
    "artifact 7f is status='unresolvable': the alignment it reads through can no longer be " +
    'resolved — missing or changed source: source-dataset-alpha. Its own declaration is intact; ' +
    'restore or re-attach that source.'

  it('populates `serverMessage` with the sentence and NOT with this module\'s prefix', async () => {
    const { fetchArtifactBytes, WorkstoreHttpError } = await import('./binaryClient')
    getArtifactData.mockRejectedValue(serverRejection(SENTENCE, 'ARTIFACT_UNRESOLVABLE'))

    const err = await fetchArtifactBytes('art-1').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err, 'the read must reject').toBeInstanceOf(WorkstoreHttpError)
    const e = err as InstanceType<typeof WorkstoreHttpError>

    // THE assertion the surviving mutation defeated: the field is populated by the code under
    // test, from the server's own text.
    expect(e.serverMessage).toBe(SENTENCE)
    // …and it is the UNWRAPPED form — the whole reason it exists rather than being recovered by
    // stripping a prefix off `message`.
    expect(e.serverMessage).not.toContain('workstore')
    expect(e.message, 'the wrapped technical string keeps the prefix').toContain('workstore')
    expect(e.message).toContain(SENTENCE)
    expect(e.errorCode).toBe('ARTIFACT_UNRESOLVABLE')
    expect(e.status).toBe(409)
  })

  it('carries it for the OTHER refusal code too — the arm is not one-code-shaped', async () => {
    const { fetchArtifactBytes } = await import('./binaryClient')
    getArtifactData.mockRejectedValue(serverRejection('the bytes do not conform', 'ARTIFACT_NOT_CONFORMING'))
    const e = (await fetchArtifactBytes('art-2').catch((x: unknown) => x)) as { serverMessage?: string }
    expect(e.serverMessage).toBe('the bytes do not conform')
  })

  it('a network failure carries a message but no CODE — the two are independent', async () => {
    // Positive control for the assertions above: `serverMessage` being populated must not be a
    // constant, and `errorCode` must stay absent when the body carried none.
    const { fetchArtifactBytes } = await import('./binaryClient')
    getArtifactData.mockRejectedValue(new Error('network down'))
    const e = (await fetchArtifactBytes('art-3').catch((x: unknown) => x)) as {
      serverMessage?: string
      errorCode?: string
    }
    expect(e.serverMessage).toBe('network down')
    expect(e.errorCode).toBeUndefined()
  })

  it('an already-normalised error passes through untouched, keeping its sentence', async () => {
    const { fetchArtifactBytes, WorkstoreHttpError } = await import('./binaryClient')
    getArtifactData.mockRejectedValue(new WorkstoreHttpError(409, 'wrapped', 'ARTIFACT_UNRESOLVABLE', 'inner'))
    const e = (await fetchArtifactBytes('art-4').catch((x: unknown) => x)) as { serverMessage?: string }
    // Double-wrapping would prepend a second prefix and bury the sentence one layer deeper.
    expect(e.serverMessage).toBe('inner')
  })
})
