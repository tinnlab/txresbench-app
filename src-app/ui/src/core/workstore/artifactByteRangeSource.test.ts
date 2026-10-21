// artifactByteRangeSource.test.ts — #158 TEST-8, TEST-10.
//
// Only the TRANSPORT is stubbed (`fetchArtifactRange`, the generated-client wrapper — the
// external boundary). Everything this file asserts about clamping, refusal and span spelling
// is the real module's own logic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchArtifactRange = vi.fn<
  (id: string, member: string | undefined, range: { start: number; end: number }) => Promise<ArrayBuffer>
>()

vi.mock('./binaryClient', async importOriginal => {
  const actual = await importOriginal<typeof import('./binaryClient')>()
  return { ...actual, fetchArtifactRange }
})

const { artifactByteRangeSource, UnknownArtifactLengthError } = await import(
  './artifactByteRangeSource'
)

const ID = '11111111-2222-3333-4444-555555555555'
/** the real hires fixture's size — a number that is not a multiple of any block size */
const LENGTH = 167_778

beforeEach(() => {
  fetchArtifactRange.mockReset()
  fetchArtifactRange.mockImplementation(async (_id, _member, range) =>
    new ArrayBuffer(range.end - range.start + 1),
  )
})

describe('TEST-8 the source speaks the cacheable `?range=` dialect, clamped', () => {
  it('sends INCLUSIVE spans through the guarded transport, spelled `start-end`', async () => {
    const source = artifactByteRangeSource(ID, LENGTH)
    const bytes = await source.read(1024, 2047)
    expect(bytes.byteLength).toBe(1024)
    expect(fetchArtifactRange).toHaveBeenCalledTimes(1)
    expect(fetchArtifactRange).toHaveBeenCalledWith(ID, undefined, { start: 1024, end: 2047 })
    // The `?range=` SPELLING is deliberately not asserted here. An earlier cut exported a
    // `spanParam` helper and checked `spanParam(1024, 2047) === '1024-2047'` — but nothing in
    // the production path called it, so the dialect claim was made against a parallel dead
    // function while the real one was mocked one layer above. The spelling is decided by
    // `fetchArtifactRange` (`byteRangeParam`), is that module's own to test, and is observed
    // for real on the wire by the e2e.
  })

  it('CLAMPS a block-aligned overrun to the last byte — the request the byte plane 416s', async () => {
    const source = artifactByteRangeSource(ID, LENGTH)
    // What a 64 KiB block reader really asks for on the LAST block of this file: block 2
    // starts at 131072 and the reader asks through 131072 + 65536 = 196608, which is 28831
    // bytes past the end. Unclamped, `?range=131072-196608` is a 416 — and that block is
    // where a pyramid's level directories live, so it is the read a multi-level image
    // cannot do without.
    await source.read(131_072, 196_608)
    expect(fetchArtifactRange).toHaveBeenCalledWith(ID, undefined, {
      start: 131_072,
      end: LENGTH - 1,
    })
    // the un-clamped end must never appear
    const ends = fetchArtifactRange.mock.calls.map(call => call[2].end)
    expect(ends.every(end => end < LENGTH)).toBe(true)
  })

  it('REFUSES a bad start rather than repairing it — a shift is worse than a failure', async () => {
    const source = artifactByteRangeSource(ID, LENGTH)
    // Clamping a negative start up to 0 would silently SHIFT the read, and the TIFF reader
    // records the response under the offset it ASKED for — so the wrong bytes land in the
    // right slot and decode as plausible garbage. Nothing is sent at all.
    await expect(source.read(-16, 31)).rejects.toThrow(RangeError)
    await expect(source.read(-16, 31)).rejects.toThrow(/would shift every byte/)
    await expect(source.read(1.5, 31)).rejects.toThrow(RangeError)
    await expect(source.read(LENGTH, LENGTH + 10)).rejects.toThrow(/inside the object/)

    // An empty span must never be sent either. `?range=` with no value is a 400, and OMITTING
    // the parameter is a request for the WHOLE object — the silent whole-file read this item
    // exists to prevent. Refusing is the only answer that cannot degrade into it.
    await expect(source.read(500, 499)).rejects.toThrow(/at least one byte/)
    expect(fetchArtifactRange).not.toHaveBeenCalled()
  })

  it('refuses to start a read for a tile the viewport has already abandoned', async () => {
    const source = artifactByteRangeSource(ID, LENGTH)
    const controller = new AbortController()
    controller.abort()
    await expect(source.read(0, 31, controller.signal)).rejects.toThrow()
    expect(
      fetchArtifactRange,
      'an already-aborted read costs no request — deck.gl aborts a tile on every pan',
    ).not.toHaveBeenCalled()
    // …and a LIVE signal does not block anything
    await source.read(0, 31, new AbortController().signal)
    expect(fetchArtifactRange).toHaveBeenCalledTimes(1)
  })

  it('reads ONE object, never a member — the length it clamps against is the object’s', async () => {
    const source = artifactByteRangeSource(ID, LENGTH)
    expect(source.byteLength).toBe(LENGTH)
    await source.read(0, 7)
    // `undefined` in the member position, always. An earlier cut accepted a member path while
    // clamping against the ARTIFACT's `stored_bytes` — the SUM over all members — so the
    // clamp was too large for the member and the last read reached past its end, producing
    // exactly the 416 this module exists to prevent, by the one route nothing checks.
    expect(fetchArtifactRange).toHaveBeenCalledWith(ID, undefined, { start: 0, end: 7 })
    expect(
      (artifactByteRangeSource as unknown as { length: number }).length,
      'the factory takes an id and a length, and no member path',
    ).toBe(2)
  })

  it('refuses to build a source over an unknown or impossible length', () => {
    expect(() => artifactByteRangeSource(ID, 0)).toThrow(UnknownArtifactLengthError)
    expect(() => artifactByteRangeSource(ID, -1)).toThrow(UnknownArtifactLengthError)
    expect(() => artifactByteRangeSource(ID, Number.NaN)).toThrow(/stored_bytes/)
    expect(() => artifactByteRangeSource(ID, 1.5)).toThrow(UnknownArtifactLengthError)
  })
})

// TEST-10's [acceptance] leg for INV-3 lives in
// `libs/viz/src/viz-core/spatial/omeTiffFallback.test.tsx`, which MOUNTS the raster hook and
// asserts the fallback actually runs.
//
// ── THIS BLOCK'S PREMISE WAS RETIRED BY #159, DELIBERATELY AND ON THE RECORD ─────────────────
//
// It used to assert that no production `DataSource` carried `imagePixelSource` — a SCOPE guard,
// whose own comment named its expiry: *"Wiring it is a separate, dependent item; this asserts
// this branch did not quietly start doing that job."* #159 is that item. It wired the seam, and
// these two cases went red, which is exactly what a scope guard is for.
//
// They are NOT deleted, because the second one was never really about absence. Its subject is
// that importing the workstore barrel must not, as a side effect, ATTACH a resolver to the data
// source — an import-time monkey-patch that would silently switch every raster pane off the
// documented fallback. That risk is unchanged by the seam existing, and it is now stated in the
// form that survives: the seam must be a declared class METHOD, never an own property some
// module installed on an instance.
describe('the raster seam is a DECLARED method, never something a module attaches at import', () => {
  it('the production source declares the pyramid seam, and refuses per call without a raster', async () => {
    const { WorkbenchDataSource, NotReachableError } = await import(
      '@/modules/workbench/extensions/data/workbenchDataSource'
    )
    const source = new WorkbenchDataSource('00000000-0000-0000-0000-000000000000', {
      getCatalog: async () => ({ axes: [], artifacts: [] }),
      getArtifact: async id => ({ id, datatype: 'x/y' }),
      openPyramid: async () => {
        throw new Error('a project with no raster must never reach a reader')
      },
      hasCapability: () => false,
    })

    // PRESENT on the class — which is what makes the grid's opt-in (`if (!src?.imagePixelSource)
    // continue`) resolve to the pyramid path at all.
    expect(typeof source.imagePixelSource).toBe('function')

    // …and a project with NO raster still refuses, by name, rather than returning an empty
    // pyramid. An empty `PixelSource[]` would leave the pane reserving a slot for a picture that
    // is never coming; the named refusal is what routes it back to the fallback.
    await expect(source.imagePixelSource()).rejects.toBeInstanceOf(NotReachableError)
    await expect(source.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)

    // Non-vacuity: the object under test is really a DataSource.
    expect(typeof source.catalog).toBe('function')
  })

  it('the byte source is a FUNCTION a caller invokes, not a side effect that attaches itself', async () => {
    // The risk this rules out, unchanged since #158: a module that, merely by being imported
    // (and this one IS imported — the workstore barrel exports it), installs a resolver on the
    // production data source. Importing the barrel is what the app does.
    const barrel = await import('./index')
    expect(typeof barrel.artifactByteRangeSource).toBe('function')

    const { WorkbenchDataSource } = await import(
      '@/modules/workbench/extensions/data/workbenchDataSource'
    )
    const source = new WorkbenchDataSource('00000000-0000-0000-0000-000000000000')

    // The seam is on the PROTOTYPE — a method the class declares — and NOT an own property of
    // the instance. An import-time patch would land as an own property (or on some other
    // object entirely); a declared method cannot.
    expect(Object.getOwnPropertyNames(source)).not.toContain('imagePixelSource')
    expect(Object.getPrototypeOf(source)).toHaveProperty('imagePixelSource')
    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(source), 'imagePixelSource')).toBe(
      true,
    )
  })
})
