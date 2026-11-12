import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from '../14-workbench/_dock'
import { postSeedPlan, seedPlottableProject, seededId } from '../14-declarative-qc/_seed'

// TEST-1 [acceptance] [invariant: INV-4] [covers: ITEM-2, ITEM-9, ITEM-10] — #158.
//
// > *"So a browser can read a slice of a multi-GB artifact without materializing it."*
// >   — `docs/design/spatial-storage-layout.md` §2.4
//
// The tree has always shipped the RENDERER for a pyramidal raster — Viv's layers, a GPU
// label-mask shader, e2e coverage — and never a READER. Nothing in it had ever issued a tile
// request for an image. This is the test that says it now does, and says it by COUNTING.
//
// Everything here is real and nothing is mocked (`page.route()` is not used, per this
// suite's standing rule):
//
//   * the ARTIFACT is a real emitted `.ome.tif` — the literal output of running the shipped
//     importer — POSTed byte-for-byte into a real project through the generic seed engine,
//     so the backend holds exactly the bytes the system produces;
//   * the TRANSPORT is the shipped byte plane, with the shipped bearer auth;
//   * the READER is the shipped loader, running in a real browser;
//   * the OBSERVATION is `page.on('request')`, i.e. what actually left the browser.
//
// ── WHY EVERY ASSERTION BELOW IS ABOUT THE NETWORK AND NOT ABOUT THE RESULT ──────────────
// A loader that fetched the whole object and then sliced it in memory would return an
// IDENTICAL pyramid and an identical tile. It would also be catastrophic on the multi-
// gigabyte images this whole design exists for, and completely invisible from the rendered
// output. So "it worked" is asserted, and then set aside; the load-bearing assertions are
// that every request carried a span, that none of them fetched the object whole, and that
// the bytes moved add up to less than the object.

// Anchored on the runner's cwd (`src-app/ui`, the config's own directory) rather than on
// `import.meta.url`: playwright's transform does not preserve this file's directory, so a
// relative URL resolves against the wrong root — and the failure mode is a COLLECTION error
// that prints "No tests found" and can be mistaken for a pass.
const VIZ_FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
const FIXTURE = path.join(VIZ_FIXTURES, 'spatial-image-hires.ome.tif')

/** Digests + sums computed by `tifffile` — a decoder that is not the one under test. */
const ORACLE = JSON.parse(
  readFileSync(path.join(VIZ_FIXTURES, 'pixel-oracle.json'), 'utf8'),
) as Record<string, number | string | number[]>

/** The producer's own manifest entry for that file, from the same real run. */
const MANIFEST = JSON.parse(
  readFileSync(path.join(VIZ_FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as {
  id: string
  datatype: string
  structure: unknown
  meta: { extent: { width: number; height: number } }
}[]

interface DataRequest {
  url: string
  range: string | null
  rangeHeader: string | null
}

/** Every request the browser makes to the artifact byte plane, with its span. */
function trackDataRequests(page: import('@playwright/test').Page): {
  data: DataRequest[]
  statuses: { url: string; status: number }[]
} {
  const data: DataRequest[] = []
  const statuses: { url: string; status: number }[] = []
  page.on('request', request => {
    const url = request.url()
    if (!url.includes('/api/artifacts/') || !url.includes('/data')) return
    data.push({
      url,
      range: new URL(url).searchParams.get('range'),
      rangeHeader: request.headers()['range'] ?? null,
    })
  })
  page.on('response', response => {
    const url = response.url()
    if (url.includes('/api/artifacts/') && url.includes('/data')) {
      statuses.push({ url, status: response.status() })
    }
  })
  return { data, statuses }
}

test('a real emitted OME-TIFF artifact is read TILE-BY-TILE over byte ranges, never whole — TEST-1', async ({
  page,
  request,
}) => {
  const entry = MANIFEST.find(candidate => candidate.id === 'spatial-image-hires')!
  const bytes = readFileSync(FIXTURE)

  const token = await ownerToken(request)
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `OME-TIFF range read ${Date.now()}`, description: '' },
    })
  ).json()

  // Seed the REAL bytes, under the datatype and the decode declaration the producer itself
  // recorded for them, so what the backend holds is the artifact and not a lookalike.
  // A plottable dataset alongside it, so the workbench opens the way it always does and this
  // spec is not also a test of the empty state. The image is an EXTRA artifact in an
  // otherwise ordinary project — which is how a real import leaves one.
  await seedPlottableProject(request, project.id)

  const seeded = await postSeedPlan(
    request,
    project.id,
    {
      artifacts: [
        {
          output_id: entry.id,
          datatype: entry.datatype,
          structure: entry.structure,
          meta: entry.meta as unknown,
          content: { encoding: 'input' },
        },
      ],
    },
    bytes,
  )
  const artifactId = seededId(seeded, entry.id)
  expect(artifactId, 'the seed engine catalogued the image artifact').toBeTruthy()

  // The byte length the loader clamps against — read off the artifact row exactly as
  // production will. `stored_bytes` is exact for a single-file artifact.
  const row = await (
    await request.get(`${BACKEND}/api/artifacts/${artifactId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
  expect(row.stored_bytes, 'the row carries the exact object length').toBe(bytes.byteLength)

  await loginAsOwner(page)
  const errors = trackErrors(page)
  const net = trackDataRequests(page)
  await openWorkbench(page, project.id)
  await page.waitForFunction(
    () => !!(window as unknown as { __txr_read?: { omeTiffPyramid?: unknown } }).__txr_read
      ?.omeTiffPyramid,
    undefined,
    { timeout: 30_000 },
  )

  // Every assertion below is filtered to THIS artifact's id. The workbench reads other
  // artifacts on boot, and counting those would let this spec pass on someone else's
  // traffic — the "a locator that matches nothing looks exactly like a defect" failure,
  // inverted.
  //
  // ── THE BASELINE IS NO LONGER ZERO, AND #159 IS WHY ───────────────────────────────────
  // This was `.toEqual([])`. When this spec was written NOTHING in the app read a raster
  // artifact, so the loader's requests were the only ones there could be. #159 wired the
  // production data source, and its `catalog()` now opens the raster's HEADER on every
  // canvas mount — that is how it answers `hasImage` and describes the texture it will
  // serve, and neither fact is derivable from any declaration. Those reads are real,
  // bounded (a handful of small ranged GETs), and they arrive BEFORE this spec touches the
  // seam.
  //
  // The control's PURPOSE is unchanged — that the requests counted below are the LOADER's
  // and not somebody else's — so it is restated rather than dropped: the baseline is
  // recorded here, everything after is measured against it, and the pre-loader traffic is
  // still held to the range-read rule so it cannot hide a whole-object read.
  const forImage = (): DataRequest[] =>
    net.data.filter(item => item.url.includes(String(artifactId)))
  const beforeLoader = forImage().length
  for (const item of forImage()) {
    expect(
      item.range,
      'even the catalog probe reads by RANGE — an un-ranged GET arriving before this spec ' +
        'measures anything would be a whole-object read hiding behind the baseline',
    ).toMatch(/^\d+-\d+$/)
  }

  const result = await page.evaluate(
    async ([id, length]) =>
      await (
        window as unknown as {
          __txr_read: {
            omeTiffPyramid: (
              id: string,
              length: number,
            ) => Promise<{
              levels: number
              levelSizes: number[][]
              dtype: string
              tileSize: number
              interleaved: boolean
              tiled: boolean
              tile: { width: number; height: number; bytes: number }
              tileChecksum: number
            }>
          }
        }
      ).__txr_read.omeTiffPyramid(id as string, length as number),
    [artifactId as string, bytes.byteLength] as const,
  )

  // ── it worked ────────────────────────────────────────────────────────────────────────
  // Index 0 is the full resolution the producer declared, and every level halves.
  expect(result.levels).toBe(3)
  expect(result.levelSizes[0]).toEqual([entry.meta.extent.width, entry.meta.extent.height])
  for (let level = 1; level < result.levels; level++) {
    expect(result.levelSizes[level]).toEqual([
      Math.floor(result.levelSizes[level - 1][0] / 2),
      Math.floor(result.levelSizes[level - 1][1] / 2),
    ])
  }
  expect(result.tileSize).toBe(512)
  expect(result.tile).toMatchObject({ width: 512, height: 512 })
  // The RIGHT pixels, not merely some pixels. `> 0` was the original assertion and it is the
  // one an off-by-one in the span arithmetic slips past — measured on the unit suite, where a
  // ±1 shift survived everything until an independent decoder's digest landed. This is the
  // only test that exercises the whole chain (byte source → the real byte plane → the loader),
  // so it carries the same oracle: the byte sum of level-0 tile (0,0), from `tifffile`.
  expect(result.tileChecksum).toBe(ORACLE.hires_level0_tile_x0_y0_512_sum)

  // ── and it worked by READING A SLICE, which is the actual claim ──────────────────────
  const loaderRequests = forImage().slice(beforeLoader)
  expect(
    loaderRequests.length,
    'the loader issued real requests for this artifact — a count of 0 would mean the seam ' +
      'resolved from something already in memory and this test proved nothing',
  ).toBeGreaterThanOrEqual(3)

  // EVERY one of them named a byte span. This is the assertion that fails if the loader
  // ever degrades into fetching the object whole: an un-ranged GET of `/data` is a
  // perfectly ordinary request that returns perfectly correct pixels.
  const unranged = loaderRequests.filter(item => item.range === null)
  expect(unranged.map(item => item.url), 'no un-ranged whole-object read').toEqual([])

  // …and they are the CACHEABLE dialect, not the 206 one: the URL names the bytes, so every
  // block is an ordinary immutable GET a later read can reuse.
  for (const item of loaderRequests) {
    expect(item.range).toMatch(/^\d+-\d+$/)
    expect(item.rangeHeader, 'the query dialect is used, never the header').toBeNull()
  }

  // No span was refused. An unclamped block-aligned read of the last block would be a 416,
  // and a 416 is silent from the rendered output.
  expect(
    net.statuses.filter(entry => entry.url.includes(String(artifactId)) && entry.status !== 200),
  ).toEqual([])

  // The bytes actually moved are less than the object. This is INV-4 stated as arithmetic:
  // a slice, not a materialization.
  const transferred = loaderRequests.reduce((total, item) => {
    const [start, end] = item.range!.split('-').map(Number)
    return total + (end - start + 1)
  }, 0)
  expect(transferred).toBeGreaterThan(0)
  // ── #259 TEST-10: BOUNDED BY THE TILE, RE-DERIVED AGAINST THE TILED ARTIFACT ───────────
  //
  // `< byteLength` is far too weak — a loader that fetched 99% of the object would satisfy
  // it, and at the multi-gigabyte sizes this design exists for that IS the failure.
  //
  // What replaced it was `4 x (512 x imageWidth x 3)`, a full-width 512-row band times four,
  // because the emitted file was STRIPPED and a band cost whole strips. On this artifact that
  // expression is 8,601,600 bytes against a 166,838-byte object: it could not bind. #227 then
  // made the emit tiled and it stopped describing the artifact as well. This is the LIVE
  // re-measure `docs/design/ome-tiff-tile-layout.md` §6 deferred to #259 — that section is
  // explicit that #227 could only MODEL the wire from the file's tags, because the instrument
  // for a request trace is this spec and it ran against a stripped corpus. (The section now
  // records the outcome; it no longer says the measurement is outstanding.)
  //
  // The bound is now the artifact's OWN statement of what this tile costs:
  // `hires_level0_tile_x0_y0_stored_bytes` is `TileByteCounts[0]` read out of the committed
  // file by `make-emitted-image-fixtures.py --oracle`, so it cannot drift from the fixture and
  // it keeps its meaning at any artifact size.
  //
  // MEASURED on this branch, against exactly this transaction (open + one level-0 tile):
  // 5,508 bytes over 5 ranged GETs to open, then 11,060 bytes in ONE GET for the tile —
  // 16,568 bytes, 9.9% of the object.
  //
  // THIS SPEC'S TILE IS (0, 0), and the comparison figure has to be that tile's. On the pre-#227
  // stripped artifact the 512-row band at y=0 is strips 0..8 — nine of them, 36,383 bytes —
  // which with this file's 5,508-byte, 5-GET open is the 41,891-byte, 14-GET transaction
  // `docs/design/ome-tiff-tile-layout.md` §2 records as #158's original wire measurement.
  // (§2 said "ten … strips"; #259 corrected it to nine, with the arithmetic, in that document.)
  // 41,891 exceeds the bound below by 1.7x, which is what makes the bound a check rather than a
  // formality.
  //
  // An earlier cut of this comment quoted 36,444 / 9, which is the band at y=1024, i.e. TILE
  // (1, 2) — the UNIT tier's tile, transplanted onto the wire tier. Both figures are real; only
  // one is this spec's, and they differ by 61 bytes, which is exactly the sort of delta a
  // transplant survives unnoticed.
  const storedTileBytes = ORACLE.hires_level0_tile_x0_y0_stored_bytes as number
  expect(storedTileBytes).toBeGreaterThan(0)
  // The OPEN's own allowance, DERIVED — not the `2 * 5_508` an earlier cut transcribed into
  // three spec files at once, which is the species of un-anchored number this branch exists to
  // remove. `hires_non_pixel_bytes` is everything in the artifact that is not pixel payload —
  // the TIFF header, the OME-XML and every level's directory, i.e. exactly what an open has to
  // read — derived from the file by `make-emitted-image-fixtures.py --oracle` (2,296 B here).
  // An open costs more than once that because geotiff re-reads its fixed 1024-byte window per
  // level: measured at 5,508 B over 5 ranged GETs, i.e. 2.4x.
  //
  // The allowance here is **6x**, i.e. two opens, and the extra one is THIS SPEC'S accounting
  // rather than the loader's. `beforeLoader` is a SNAPSHOT of the request log, so any
  // catalog-probe request that lands after it is attributed to the loader — measured across
  // runs at 5,508 B (probe fully drained before the snapshot) and 7,556 B (a probe tail
  // attributed here). A budget tuned to the lower observation is a flake, and a flaky bound
  // gets loosened by whoever hits it rather than reasoned about.
  //
  // It stays a real check at 6x: the total budget is 24,836 B, and the same transaction against
  // the pre-#227 stripped artifact costs 41,891 B (5,508 open + 36,383 for the band at y=0,
  // over 14 GETs). What actually pins the tile is the pair of assertions after this one —
  // exactly ONE span of exactly `TileByteCounts[0]` bytes at `TileOffsets[0]`. That IDENTITY is
  // race-proof; the companion "and no span larger" is not strictly so — a probe read bigger than
  // one tile would reach it. What actually holds is weaker than "1 KiB windows" and is worth
  // stating as the weaker thing. An OPEN's five spans measure 1024, 1024, 1412, 1024, 1024, and
  // they are, in order: geotiff's fixed 1024-byte window; IFD 0 (whose offset is literally 8);
  // the OME-XML `ImageDescription`, read at its declared length of 1412; and the two SubIFD level
  // directories. So four are a FIXED SIZE and one — the OME-XML — is the only span whose LENGTH
  // grows with the artifact; the NUMBER of 1024-byte directory windows grows with pyramid depth,
  // so the open TOTAL is not fixed either. Nothing asserts any of that: if the OME-XML ever
  // exceeded one tile's stored length, this companion would start reporting a baseline race as a
  // tiling defect.
  const openBudget = 6 * (ORACLE.hires_non_pixel_bytes as number)
  expect(ORACLE.hires_non_pixel_bytes as number).toBeGreaterThan(0)
  expect(
    transferred,
    `the loader moved ${transferred} bytes for a 512x512 tile whose own stored length is ` +
      `${storedTileBytes}; anything beyond one tile plus the open's header window is the ` +
      'whole-object read this item exists to prevent, and it is invisible from the rendered output',
  ).toBeLessThan(storedTileBytes + openBudget)
  expect(transferred).toBeLessThan(bytes.byteLength)

  // ── AND THE REQUEST COUNT, WHICH IS THE OTHER HALF OF INV-6 ────────────────────────────
  // A byte total alone is silent on the shape of the traffic: a loader that split this one tile
  // into three ranged GETs summing to 11,060 satisfies the bound above and has thrown away the
  // property #227 exists for. INV-6 says "measure the wire, not just the tag", and on the wire
  // the claim is ONE TILE, ONE RANGED GET. So the tile's own span is identified among the
  // loader's requests and counted.
  const spanLength = (item: DataRequest) => {
    const [start, end] = item.range!.split('-').map(Number)
    return end - start + 1
  }
  // Identified by its OFFSET as well as its length — `TileOffsets[0]`, i.e. where the tile
  // actually lives — so a coincidental second span of the same length cannot make this read
  // "two tiles" and redden it with a message about the wrong thing.
  const tileStart = ORACLE.hires_level0_tile_x0_y0_offset as number
  expect(tileStart).toBeGreaterThan(0)
  const tileSpans = loaderRequests.filter(item => {
    const [start] = item.range!.split('-').map(Number)
    return start === tileStart && spanLength(item) === storedTileBytes
  })
  expect(
    tileSpans.length,
    `exactly one ranged GET should carry the ${storedTileBytes}-byte tile at offset ` +
      `${tileStart}; the loader issued ${loaderRequests.length} request(s): ` +
      `${loaderRequests.map(item => item.range).join(' ')}`,
  ).toBe(1)
  // …and nothing it asked for was LARGER than one tile, which is what a strip read, a block
  // reader, or a whole-object read each violate.
  expect(Math.max(...loaderRequests.map(spanLength))).toBe(storedTileBytes)

  // and no span ever reached past the end of the object
  for (const item of loaderRequests) {
    const [, end] = item.range!.split('-').map(Number)
    expect(end).toBeLessThan(bytes.byteLength)
  }

  // What actually went over the wire, printed. A range-read regression is invisible from the
  // rendered output, so when this test fails the FIRST question is "what did it ask for" —
  // and recovering that from a re-run costs a whole backend boot.
  // eslint-disable-next-line no-console
  console.log(
    `[TEST-1] ${loaderRequests.length} ranged GET(s) to /artifacts/${artifactId}/data — ` +
      `${transferred} of ${bytes.byteLength} bytes (` +
      `${((100 * transferred) / bytes.byteLength).toFixed(1)}%), spans: ` +
      loaderRequests.map(item => item.range).join(' '),
  )

  // A console error during the read would mean a request failed and the loader recovered
  // silently — exactly the shape that makes a byte-plane regression invisible.
  expect(errors.errors, 'a clean console while the pyramid resolved').toEqual([])
})
