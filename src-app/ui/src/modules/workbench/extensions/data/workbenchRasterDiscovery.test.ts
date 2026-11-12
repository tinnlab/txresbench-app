// workbenchRasterDiscovery.test.ts — #159 TEST-11, TEST-12.
//
// How the production data source FINDS a project's renderable raster, and — more importantly —
// what it refuses to find.
//
// ── WHY THIS TEST IS SHAPED AROUND AN UNKNOWN DATATYPE ───────────────────────────────────────
// Two shipped guards, pulling in opposite directions, leave exactly one legal discovery route.
// A raster container declares no capability and is forbidden from declaring one (the
// contribution gate asserts an opaque descendant's capability list is empty), and this workspace
// may not spell a contributed datatype id at all (the vocabulary guard derives its forbidden
// tokens from the package manifests, and scans this file too). So discovery runs on the
// PRODUCER-DECLARED LAYOUT — the same thing the byte plane itself routes on.
//
// A test that seeded the real datatype id could not tell that rule apart from "it happens to
// match the id we shipped". So the positive case here is deliberately typed as something the
// registry has NEVER heard of: if it is still discovered, discovery is structural. And the
// negative cases carry plausible-looking ids with the wrong declared layout, so an
// implementation that regressed to matching on the id would go red in both directions.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@txresbench/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  NotReachableError,
  WorkbenchDataSource,
  type DataPlaneArtifact,
  type WorkbenchDataSourceDeps,
} from './workbenchDataSource'

// Importing the viz barrel under the node runner costs a few seconds of transform; every case
// that touches it says so rather than inheriting the 5 s default and flaking.
const SLOW = 120_000

const FIXTURES = path.resolve(
  process.cwd(),
  '../libs/viz/src/viz-core/spatial/fixtures',
)

/** The producer's OWN declaration for a real emitted raster, read from the real run's manifest
 *  entries rather than typed here — so a change to what the producer emits shows up as a
 *  failure instead of as a fixture that quietly no longer resembles production. */
const EMITTED = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; structure: unknown; meta: unknown }[]

const emitted = (id: string) => EMITTED.find(e => e.id === id)!

const HIRES_FIXTURE = path.join(FIXTURES, 'spatial-image-hires.ome.tif')

/**
 * The hires artifact's own on-disk length, READ from it (#259 TEST-9).
 *
 * This was the bare literal 167778, with nothing linking it to the file it was measured on.
 * `stored_bytes` is what `workbenchDataSource` hands the reader as `byteLength` and what the
 * reader clamps every span against, so a value that quietly stops describing the artifact is a
 * defect generator — and #259 is the regeneration that would have desynchronised it: #227's
 * tiled emit is 166,838 bytes where the frozen stripped one was 167,778. Derived rather than
 * transcribed, it cannot desynchronise again.
 */
const HIRES_STORED_BYTES = statSync(HIRES_FIXTURE).size

async function realPyramid() {
  const { loadOmeTiffPyramid } = await import('@txresbench/viz/core')
  const bytes = readFileSync(path.join(FIXTURES, 'spatial-image-hires.ome.tif'))
  return loadOmeTiffPyramid({
    byteLength: bytes.byteLength,
    async read(start: number, end: number) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  })
}

interface Probe {
  source: WorkbenchDataSource
  opened: string[]
}

/** A source over a fake control plane. `openPyramid` records WHICH artifact it was asked to
 *  open — the observation that distinguishes "discovered the right row" from "discovered
 *  something". */
function probe(
  artifacts: DataPlaneArtifact[],
  /** #229 — the declared VIEW KINDS per datatype id, as the lattice would resolve them.
   *  Omitted ⇒ none, which is the fail-open state every case written before #229 ran under. */
  viewKinds: Record<string, readonly string[]> = {},
): Probe {
  const opened: string[] = []
  const deps: Partial<WorkbenchDataSourceDeps> = {
    getCatalog: async () => ({ axes: [], artifacts }),
    getArtifact: async id => artifacts.find(a => a.id === id) ?? { id, datatype: 'x/y' },
    openPyramid: async id => {
      opened.push(id)
      return await realPyramid()
    },
    hasCapability: () => false,
    viewKindsFor: id => viewKinds[id] ?? [],
  }
  return { source: new WorkbenchDataSource('p1', deps), opened }
}

/** A raster row: the REAL producer-declared structure, under whatever datatype the case wants. */
function raster(over: Partial<DataPlaneArtifact> = {}): DataPlaneArtifact {
  return {
    id: 'r1',
    // A datatype id the registry has never heard of, on purpose — see the header.
    datatype: 'nobody/has-ever-registered-this',
    structure: emitted('spatial-image-hires').structure,
    meta: emitted('spatial-image-hires').meta,
    stored_bytes: HIRES_STORED_BYTES,
    ...over,
  }
}

describe('TEST-11 — discovery is on the DECLARED LAYOUT, never on the datatype id', () => {
  it('finds a raster whose datatype the registry has never heard of', async () => {
    const { source, opened } = probe([raster()])

    const catalog = await source.catalog()
    expect(
      catalog.hasImage,
      'discovery must key on the producer-declared structure; a datatype the registry does ' +
        'not know is still a readable raster if its declaration says so',
    ).toBe(true)
    expect(opened).toEqual(['r1'])
    expect(catalog.image).toMatchObject({ width: 350, height: 450, channels: 4 })
  }, SLOW)

  it('refuses an artifact that declares a JSON opaque blob, however it is named', async () => {
    // The SAME encoding (`opaque`), a different media type. This is the case a naive
    // `encoding === 'opaque'` check would accept and then hand a JSON document to a TIFF
    // reader — which fails deep inside the decoder rather than at discovery.
    const { source, opened } = probe([
      raster({
        id: 'j1',
        datatype: 'looks/like-a-raster',
        structure: { encoding: 'opaque', media_type: 'application/json' },
      }),
    ])

    expect((await source.catalog()).hasImage).toBe(false)
    expect(opened, 'nothing should have been opened').toEqual([])
    await expect(source.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)
    await expect(source.imagePixelSource()).rejects.toBeInstanceOf(NotReachableError)
  })

  it('refuses a NON-OME TIFF, which the reader itself would refuse later and less usefully', async () => {
    const { source, opened } = probe([
      raster({ id: 't1', structure: { encoding: 'opaque', media_type: 'image/tiff' } }),
    ])
    expect((await source.catalog()).hasImage).toBe(false)
    expect(opened).toEqual([])
  })

  it('refuses a columnar artifact even when its datatype LOOKS like a raster', async () => {
    const { source, opened } = probe([
      raster({
        id: 'z1',
        datatype: 'raster/image',
        structure: { encoding: 'zarr_v3', kind: 'table', arrays: [] },
      }),
    ])
    expect((await source.catalog()).hasImage).toBe(false)
    expect(opened).toEqual([])
  })

  it('accepts equivalent spellings of the same media type', async () => {
    // The declaration is a media TYPE with parameters, not an opaque string. A producer that
    // writes it without the space, in a different case, or with the parameters in another
    // order is declaring the identical thing, and a string comparison would silently drop it.
    for (const spelling of [
      'image/tiff; application=ome',
      'image/tiff;application=ome',
      'IMAGE/TIFF; APPLICATION=OME',
      'image/tiff; charset=binary; application=ome',
      // A QUOTED parameter value is the same media type, and a naive string comparison drops it.
      'image/tiff; application="ome"',
    ]) {
      const { source } = probe([raster({ structure: { encoding: 'opaque', media_type: spelling } })])
      expect((await source.catalog()).hasImage, `spelling: ${spelling}`).toBe(true)
    }
  }, SLOW)

  it('a project with no artifacts at all reports no raster, and refuses by name', async () => {
    const { source, opened } = probe([])
    const catalog = await source.catalog()
    expect(catalog.hasImage).toBe(false)
    expect(catalog.image).toBeUndefined()
    expect(opened).toEqual([])
    await expect(source.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)
  })
})

describe('#259 TEST-9 — the declared `stored_bytes` IS the artifact, not a plausible number', () => {
  it('is the length the reader is handed, and is on the discovery path rather than an unused constant', async () => {
    // `workbenchDataSource` sets `byteLength = row.stored_bytes` and the OME-TIFF reader clamps
    // every span against it, so this field is load-bearing for a range read. The value used
    // throughout this file is now read from the fixture rather than transcribed.
    //
    // The line below is a WEAK corroboration and is labelled as one: `statSync().size` and
    // `readFileSync().byteLength` are the same quantity from the same path, so it catches a
    // truncation between the two reads and essentially nothing else. It is NOT a second
    // independent route, whatever an earlier draft of this comment said.
    //
    // (No commit archaeology here on purpose. Three successive attempts to narrate WHICH draft
    // said what got the attribution wrong three different ways — a lot of wrongness to spend on
    // a fact `git log` already holds and no reader of this test needs.)
    //
    // The assertion that carries this test is the discovery leg below; the HONEST LIMIT
    // paragraph under it is prose and is not counted as coverage.
    expect(HIRES_STORED_BYTES).toBeGreaterThan(0)
    expect(HIRES_STORED_BYTES).toBe(readFileSync(HIRES_FIXTURE).byteLength)

    // …and the number is on the path, not an unused constant: the row built from it is what
    // discovery accepts. Without this the binding above would be a fact about a file rather than
    // a fact about this test.
    const { source, opened } = probe([raster()])
    const catalog = await source.catalog()
    expect(catalog.hasImage).toBe(true)
    expect(opened).toEqual(['r1'])

    // HONEST LIMIT, because it is worth writing down rather than implying otherwise. This cannot
    // detect a WRONG-but-plausible declared length at run time: measured on the shipped loader,
    // opening this fixture with the retired 167,778 still resolves 3 levels and decodes a
    // correct 512x512 tile, because the transport clamps its spans to the real end of the
    // object. What the binding buys is that the number and the bytes cannot desynchronise in the
    // first place — which is the failure #259 filed, not a runtime detector for it.
  }, SLOW)
})

describe('TEST-12 — several rasters resolve to ONE, deterministically', () => {
  // What a real import emits: a full-detail raster and a small overview of the same ground.
  const big = raster({ id: 'aaa-big', meta: { ...(emitted('spatial-image-hires').meta as object) } })
  const small = raster({
    id: 'zzz-small',
    meta: { ...(emitted('spatial-image-lowres').meta as object) },
  })

  it('picks the largest declared extent, whatever order the rows arrive in', async () => {
    const forward = probe([big, small])
    const reversed = probe([small, big])

    expect((await forward.source.catalog()).hasImage).toBe(true)
    expect((await reversed.source.catalog()).hasImage).toBe(true)

    // THE POINT: the same project must render the same picture on two loads. An ordering that
    // is not a total order — or one that just takes the first row — makes this pair disagree,
    // and the disagreement is a different image, not an error.
    expect(forward.opened).toEqual(['aaa-big'])
    expect(reversed.opened).toEqual(['aaa-big'])
  }, SLOW)

  it('breaks a tie on artifact id, so two equal candidates still name exactly one', async () => {
    const meta = emitted('spatial-image-hires').meta as object
    const forward = probe([raster({ id: 'b', meta }), raster({ id: 'a', meta })])
    const reversed = probe([raster({ id: 'a', meta }), raster({ id: 'b', meta })])
    expect((await forward.source.catalog()).hasImage).toBe(true)
    expect((await reversed.source.catalog()).hasImage).toBe(true)
    expect(forward.opened).toEqual(['a'])
    expect(reversed.opened).toEqual(['a'])
  }, SLOW)
})

// ── #229 — an INDEX raster is not a picture ────────────────────────────────────────────────
//
// A SEGMENTATION LABEL raster declares a container byte-identical to a tissue image's:
// `encoding: opaque`, `image/tiff;application=ome`, one file. Everything in TEST-11 above
// therefore matches BOTH, and the discovery had no sanctioned way to tell them apart — the
// ambiguity `declaresDisplayRole` narrows and does not close. What closes it is a declaration the
// type package makes and this workspace is allowed to read: the datatype's own `viewers` entry.
//
// (The two kind ids are deliberately NOT written anywhere in this file. The vocabulary guard
// scans a `.test.ts` sitting beside production code — only a `tests/` PATH SEGMENT is excluded —
// and it caught exactly that leak in this comment's first draft, which is the invariant doing its
// job from outside the package it protects.)
//
// The cases below are written the same way TEST-11 is, and for the same reason: the datatype ids
// are strings the registry has never heard of, so nothing here can pass by recognising a shipped
// id. The mask is also given the LARGER declared extent and the earlier artifact id, so it wins
// every pre-existing ordering rule — if it is not chosen, the reason can only be the view kind.
describe('#229 — a raster whose datatype declares the label-mask view kind is refused as an underlay', () => {
  const MASK_DT = 'nobody/has-ever-registered-this-mask'
  const IMAGE_DT = 'nobody/has-ever-registered-this-image'
  const hires = emitted('spatial-image-hires').meta as object

  /** The mask row: identical declared structure, identical meta shape, a BIGGER extent and an
   *  id that sorts first — i.e. the winner under extent-then-id, which is what the old rule was. */
  const mask = () =>
    raster({
      id: 'aaa-mask',
      datatype: MASK_DT,
      meta: { ...hires, extent: { width: 9999, height: 9999 } },
    })
  const image = () => raster({ id: 'zzz-image', datatype: IMAGE_DT, meta: hires })
  const declared = { [MASK_DT]: ['label-mask'] }

  it('a project whose ONLY raster is a mask reports no image, and opens nothing', async () => {
    // The case a preference cannot fix: "sorted last" is still "sorted first" when there is one
    // candidate, so a mask would have been painted as tissue with nothing saying so.
    const { source, opened } = probe([mask()], declared)
    const catalog = await source.catalog()
    expect(catalog.hasImage).toBe(false)
    expect(catalog.image).toBeUndefined()
    expect(opened, 'the mask must never reach the pyramid reader').toEqual([])
    await expect(source.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)
    await expect(source.imagePixelSource()).rejects.toBeInstanceOf(NotReachableError)
  })

  it('a project holding BOTH opens the tissue image, though the mask wins every older rule', async () => {
    const forward = probe([mask(), image()], declared)
    const reversed = probe([image(), mask()], declared)
    expect((await forward.source.catalog()).hasImage).toBe(true)
    expect((await reversed.source.catalog()).hasImage).toBe(true)
    expect(forward.opened).toEqual(['zzz-image'])
    expect(reversed.opened).toEqual(['zzz-image'])
  }, SLOW)

  it('WITHOUT the declaration the same two rows resolve to the mask — #229, reproduced', async () => {
    // The negative control, and the reason the two cases above mean anything. Same artifacts,
    // same order, the declaration alone removed: discovery falls back to extent-then-id and
    // hands the reader the label mask. A checker that cannot fail this way is not checking.
    const { source, opened } = probe([mask(), image()])
    expect((await source.catalog()).hasImage).toBe(true)
    expect(opened).toEqual(['aaa-mask'])
  }, SLOW)

  it('FAILS OPEN: a raster declaring some OTHER view kind, or none, is still an underlay', async () => {
    // The rule is one-sided on purpose. Excluding everything that does not positively declare
    // itself a picture would trade a hypothetical wrong picture for a certain absent one — and
    // would withdraw the image from every project emitted before this declaration existed.
    const other = probe([image()], { [IMAGE_DT]: ['matrix-grid', 'table'] })
    expect((await other.source.catalog()).hasImage).toBe(true)
    expect(other.opened).toEqual(['zzz-image'])

    const undeclared = probe([image()])
    expect((await undeclared.source.catalog()).hasImage).toBe(true)
    expect(undeclared.opened).toEqual(['zzz-image'])
  }, SLOW)
})
