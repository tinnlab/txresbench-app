// workbenchStreamingSource.image.test.ts — #159 TEST-15.
//
// The streaming half of the raster wiring. Two edits live here and they are ONE change:
//
//   * `catalog()` now carries an `image` block through from the pull source, and
//   * the `image` byte channel now SERVES instead of refusing.
//
// Landing either alone is the failure mode this file exists to pin. The refusal's own comment
// used to say the three unserved channels were unreachable *because* `hasImage` was hardcoded
// false — so advertising the raster without serving it converts a never-reached error into a
// reachable one, and it surfaces as a throwing `imageUnderlay()` on the object the grid holds,
// which looks exactly like the defect this item was written to remove.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@ziee/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WorkbenchDataSource, type DataPlaneArtifact, type WorkbenchDataSourceDeps } from './workbenchDataSource'
import { WorkbenchStreamingSource } from './workbenchStreamingSource'

const SLOW = 120_000
const FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
const RASTER_BYTES = readFileSync(path.join(FIXTURES, 'spatial-image-hires.ome.tif'))
const EMITTED = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; structure: unknown; meta: unknown }[]
const HIRES = EMITTED.find(e => e.id === 'spatial-image-hires')!

const RASTER_ROW: DataPlaneArtifact = {
  id: 'r1',
  datatype: 'nobody/has-ever-registered-this',
  structure: HIRES.structure,
  meta: HIRES.meta,
  stored_bytes: RASTER_BYTES.byteLength,
}

async function realPyramid() {
  const { loadOmeTiffPyramid } = await import('@ziee/viz/core')
  return loadOmeTiffPyramid({
    byteLength: RASTER_BYTES.byteLength,
    async read(start: number, end: number) {
      return RASTER_BYTES.buffer.slice(RASTER_BYTES.byteOffset + start, RASTER_BYTES.byteOffset + end + 1)
    },
  })
}

function sources(artifacts: DataPlaneArtifact[]) {
  const deps: Partial<WorkbenchDataSourceDeps> = {
    getCatalog: async () => ({ axes: [], artifacts }),
    getArtifact: async id => artifacts.find(a => a.id === id) ?? { id, datatype: 'x/y' },
    openPyramid: async () => await realPyramid(),
    hasCapability: () => false,
  }
  const pull = new WorkbenchDataSource('p1', deps)
  return { pull, streaming: new WorkbenchStreamingSource('p1', { pull }) }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of stream) {
    parts.push(part)
    total += part.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

describe('TEST-15 — the raster rides the streaming plane intact', () => {
  it('carries the image block through `catalog()` unchanged', async () => {
    const { pull, streaming } = sources([RASTER_ROW])
    const fromPull = await pull.catalog()
    const fromStream = await streaming.catalog()

    expect(fromStream.hasImage).toBe(true)
    // Identical, not merely similar: the adapter pairs THIS header with the streamed bytes, so
    // any transformation on the way through would describe a different texture than the one
    // served.
    expect(fromStream.image).toEqual(fromPull.image)
    expect(fromStream.image).toMatchObject({ width: 350, height: 450, channels: 4 })
  }, SLOW)

  it('SERVES the image channel with exactly the pull source’s bytes', async () => {
    const { pull, streaming } = sources([RASTER_ROW])
    const expected = (await pull.imageUnderlay()).data

    const served = await collect(streaming.stream({ kind: 'image' }))

    expect(served.byteLength).toBe(expected.byteLength)
    expect(served.byteLength).toBe(350 * 450 * 4)
    // Byte-for-byte. A same-length buffer of different pixels satisfies every length assertion
    // and renders a different picture.
    expect(Buffer.from(served).equals(Buffer.from(expected))).toBe(true)
  }, SLOW)

  it('delegates the pyramid seam to the pull source', async () => {
    const { pull, streaming } = sources([RASTER_ROW])
    const [viaStream, viaPull] = await Promise.all([streaming.imagePixelSource(), pull.imagePixelSource()])
    // Identity, not equality: two independently-opened readers would each hold their own byte
    // cache and issue their own requests for the same tiles.
    expect(viaStream).toBe(viaPull)
    expect(viaStream).toHaveLength(3)
  }, SLOW)

  it('a project with no raster still refuses the channel, by name', async () => {
    // The other half of the pairing: `catalog()` does not advertise, so nothing reaches this —
    // but if something does, it must refuse in the source's own taxonomy rather than yield
    // empty bytes, which would decode as a zero-size texture instead of as "not here".
    const { streaming } = sources([
      { id: 'c1', datatype: 'demo/column', structure: { encoding: 'opaque', media_type: 'application/json' } },
    ])
    expect((await streaming.catalog()).hasImage).toBe(false)
    await expect(collect(streaming.stream({ kind: 'image' }))).rejects.toThrow(/image/i)
  })
})
