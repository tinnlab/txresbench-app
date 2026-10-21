// omeTiffPyramid.test.ts — #158 TEST-2..TEST-7, TEST-11..TEST-15; #259 TEST-1..TEST-6, TEST-14.
//
// Every fixture here is REAL: `spatial-image-{hires,lowres}.ome.tif` are the literal output
// of running the shipped Visium importer, and the other two come out of the shipped
// `ome_writer.py`. See `fixtures/README.md`. A hand-made TIFF would let this suite pass
// against a file the system never emits.
//
// ── THE CORPUS SAMPLES A TILED WRITER NOW, AND CARRIES THE STRIPPED ARTIFACT TOO (#259) ───
// #227 made `write_ome_tiff` pass `tile=(512, 512)` at every `writer.write` call site, so the
// emitted layout went from full-width STRIPS to 512x512 TILES at every pyramid level. The
// fixtures above were frozen before that and had stopped sampling the producer; #259
// regenerated them through the shipped writer (`scripts/make-emitted-image-fixtures.py`) and
// kept the pre-#227 emit beside them as `spatial-image-hires-stripped.ome.tif`.
//
// That pair is the point. It is the SAME IMAGE in both layouts — identical pixels, identical
// placement, identical OME magnitudes — so every assertion below that contrasts them isolates
// the layout and nothing else. Measured on it, for one 512x512 level-0 tile:
//
//     STRIPPED (pre-#227)   36,444 bytes over  9 ranged reads   (nine full-width strips)
//     TILED    (post-#227)  11,120 bytes over  1 ranged read    (one TIFF tile)
//
// THE CORPUS DISCRIMINATES, AND THAT IS SHOWN BY MUTATION, NOT CLAIMED. A fixture no
// fixture-consuming test can fail on is decoration, and the corpus was in exactly that state
// before this branch: `tiled` was asserted `false` for artifacts that had become tiled, and the
// byte bound was `4 x (512 x 1400 x 3)` = 8.6 MB against a 167 KB file, which cannot bind. The
// battery is INLINE here rather than in a process artifact, because `.lifecycle/` is stripped at
// merge and a shipped file citing a stripped path is the exact defect #259 was filed about:
//
//   mutation                                              tests reddened (40 here + 11 in staleClaims)
//   ────────────────────────────────────────────────────  ────────────────────────────────────────
//   (none — baseline)                                     0
//   `tiledOfDirectory` -> constant `false`                4   TEST-1, TEST-2, TEST-14, TEST-16
//   `tiledOfDirectory` -> `RowsPerStrip != null`          5   the above + TEST-3
//   `DEFAULT_OME_TIFF_LIMITS.tileSize` 512 -> 32          8   TEST-3..TEST-6, TEST-14..TEST-16, +1
//   `DEFAULT_OME_TIFF_LIMITS.tileSize` 512 -> 256         8   same set
//   the corpus regressed to STRIPPED (pre-#227 bytes)     7   TEST-13 first, then TEST-1, TEST-2,
//                                                             TEST-4, TEST-5, TEST-14, TEST-15
//   every range read widened to the whole object          22  the whole reader suite
//
// The rows that carry the argument. **The stripped-corpus row reddened NOTHING before this
// branch — it *was* the committed state**, and it is now caught first by TEST-13, which
// re-emits through the shipped writer and names the cause. The two `tileSize` rows answer the
// "is the 512 override still needed now that Viv would derive 512" question executably: if the
// override were redundant, replacing it with the value Viv derives would be a no-op, and #259
// TEST-6 goes red in both directions — at 32 (`RowsPerStrip = 62` on the pre-#227 emit) and at
// 256 (`TileWidth = 256` on `tiled-deflate.ome.tif`), both read off committed files. #259
// TEST-14 is the stripped-corpus row made PERMANENT and in-process.
//
// TWO NON-VACUITY RULES THIS FILE IS WRITTEN UNDER, both from measurements on this branch:
//
//   1. A tile read can legitimately cost ZERO requests — geotiff's block reader caches, and
//      opening a 167 KB file at the default 64 KiB block pulls most of it. Measured: level-2
//      tile (0,0) after an open → 0 requests. So the byte-accounting test uses a SMALL block
//      (stated at the call site) so that what it measures is the TILE read and not the open's
//      prefetch, and it asserts a NON-ZERO lower bound. Without that, "it fetches by range"
//      would pass with the range path deleted.
//   2. Every span assertion is on the RECORDED spans, not on a rendered result. A loader that
//      fetched the whole file would produce identical pixels.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { fromArrayBuffer } from 'geotiff'
import { MultiscaleImageLayer, ImageLayer, isInterleaved } from '@hms-dbmi/viv'
import {
  loadOmeTiffPyramid,
  assertHalvingPyramid,
  assertDecodableCodec,
  dtypeOfDirectory,
  tiledOfDirectory,
  omeTiffModelMatrix,
  ngffForLevels,
  OmeTiffLoadError,
  UnsupportedImageCodecError,
  NonHalvingPyramidError,
  MultiPlaneImageUnsupportedError,
  DEFAULT_OME_TIFF_LIMITS,
  type ByteRangeSource,
} from './omeTiffPyramid'
import { buildRasterImageLayers, type RasterChannelState } from './rasterImageLayers'
import { parseMultiscales } from './imageMeta'
import type { Affine } from '../data/image'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const HIRES = `${FIXTURES}spatial-image-hires.ome.tif`
const LOWRES = `${FIXTURES}spatial-image-lowres.ome.tif`
const GREYSCALE = `${FIXTURES}spatial-image-greyscale.ome.tif`
const JPEG2000 = `${FIXTURES}unsupported-jpeg2000.ome.tif`
const MANIFEST_ENTRIES = `${FIXTURES}emitted-manifest-entries.json`
const TILED = `${FIXTURES}tiled-deflate.ome.tif`
/**
 * The pre-#227 emit of `spatial-image-hires.ome.tif`, kept verbatim (#259).
 *
 * Not a hand-made stripped file and not a re-encode: it is the artifact this system itself put
 * on disk before `write_ome_tiff` passed `tile=`, preserved by `git show`. It therefore carries
 * the SAME PIXELS as `HIRES` — asserted below against the independent oracle, not assumed — so
 * the two differ in layout and in nothing else.
 */
const HIRES_STRIPPED = `${FIXTURES}spatial-image-hires-stripped.ome.tif`
const NON_HALVING = `${FIXTURES}malformed-non-halving.ome.tif`
const MULTI_PLANE = `${FIXTURES}multi-plane-channels.ome.tif`
const PLANAR_RGB = `${FIXTURES}planar-rgb.ome.tif`
const MIXED_CODEC = `${FIXTURES}mixed-codec-levels.ome.tif`
const SHORT_FILE = `${FIXTURES}short-not-a-tiff.bin`
/**
 * THE THIRD-PARTY STRIPPED OME-TIFF (#322) — the corpus's first successful read of a stripped
 * file laid out by a writer this project does NOT control.
 *
 * `HIRES_STRIPPED` above closed half of `docs/design/ome-tiff-tile-layout.md` §5's rationale and
 * §5 said so in as many words: it is OUR OWN pre-#227 emit, so it proves the reader is not
 * confined to its writer's CURRENT layout and proves nothing about a writer we do not control.
 * The other four stripped files in this directory are all shapes the reader REFUSES at open
 * (asserted per file, per level, by #259 TEST-1), so before this fixture NO successful read went
 * through a stripped file this system did not write.
 *
 * WHAT IT IS, EXACTLY — the provenance is the whole value of the file, so it is stated here and
 * not only in `fixtures/README.md`:
 *
 *   * **Pillow** wrote the TIFF — header, IFD, every tag's type/count/value layout, the strip
 *     geometry and the DEFLATE payloads. Nothing in this repo's producer path imports Pillow, and
 *     `ome_writer.py` has never emitted these bytes. More precisely, and it is checkable in the
 *     artifact: `TiffImagePlugin._save` routes a COMPRESSED write to the libtiff Pillow bundles
 *     (4.7.1), not to its own pure-Python IFD writer — `StripOffsets[0] = 8` with the IFD at the
 *     end of the file is libtiff's data-first layout. That is further from this project rather
 *     than nearer to it (§5 named `libtiff` itself as an acceptable writer), but the generator's
 *     provenance block names the right codebase rather than the convenient one.
 *   * **We supplied two inputs**: the PIXELS (the level-0 raster of our own committed
 *     `spatial-image-lowres.ome.tif`, carried over verbatim — §5's rationale is about a writer we
 *     do not control, not about someone else's pixels) and the TEXT of the OME-XML, which is
 *     hand-authored because Pillow will not author OME-XML.
 *   * Which makes the pair a controlled experiment with the same shape as the
 *     `HIRES`/`HIRES_STRIPPED` pair: the SAME IMAGE through two unrelated writers, so what the
 *     assertions below isolate is the writer and nothing else.
 *
 * And the honest limit, because a passing test here must not be read as more than it is: this
 * loader never parses OME-XML at all (see `omeTiffPyramid.ts`'s header), so this fixture
 * exercises a foreign TIFF TAG LAYOUT and a foreign STRIP GEOMETRY. It says nothing about
 * parsing a vendor's OME-XML, because there is no OME-XML parsing to say anything about.
 *
 * Its tag layout is one this codebase has never produced, and BOTH sides of that were measured
 * rather than remembered. It carries `256 257 258 259 262 270 273 277 278 279 284`; our own
 * `spatial-image-hires.ome.tif` carries `256 257 258 259 262 270 277 282 283 284 296 305 322 323
 * 324 325 330`. So this file has the STRIP tags and our writer has the TILE tags plus `SubIFDs`,
 * `XResolution`/`YResolution`, `ResolutionUnit` and `Software` — four tags our writer always
 * stamps and this one has none of. (`SampleFormat` is deliberately not in that list: neither
 * writer emits it, so it discriminates nothing. Nor is "no `SubIFDs`" a provenance marker on its
 * own — `spatial-image-lowres.ome.tif`, our own emit and the source of these pixels, is
 * single-level too; here it is a consequence of Pillow being unable to write SubIFDs at all.)
 * `RowsPerStrip = 40` over 540 rows is 14 strips whose last one is SHORT, and 40 is none of the
 * numbers already in this corpus (not the writer's 512, not the pre-#227 emit's 62, not
 * `tiled-deflate`'s 256).
 *
 * Written by `scripts/make-third-party-stripped-fixture.py`, whose `--check` #322 TEST-3 runs.
 */
const THIRD_PARTY_STRIPPED = `${FIXTURES}third-party-stripped.ome.tif`

/**
 * THE OME-TIFF WHOSE `<OME>` DOCUMENT THIS PROJECT DID NOT AUTHOR (#346).
 *
 * `THIRD_PARTY_STRIPPED` above closed one half of #322 and its own provenance note says which:
 * a foreign TIFF **tag layout** and a foreign **strip geometry**, over OUR raster, with an
 * OME-XML string our generator hand-composed because Pillow will not write one. So the corpus
 * held no `<OME>` document composed outside this project — the hole #346 calls the sharpest of
 * the two it was split to track.
 *
 * WHAT IT IS, EXACTLY, because the provenance is the whole value of the file:
 *
 *   * **Every byte is upstream's.** Not generated, not converted, not trimmed, not re-encoded —
 *     `tubhiswt_C0.ome.tif` from the OME sample tree, saved verbatim, 269,568 bytes, sha256
 *     `a1d99f06…`, under **CC BY 4.0** (*"Sample OME-TIFF files (c) by the OME Consortium"*).
 *     `fixtures/README.md` carries the URL, the licence, the credit and the retrieval date, and
 *     `scripts/fetch-vendor-ome-fixture.py` carries them again beside the checks. The verbatim
 *     rule is load-bearing rather than tidy: the moment one of our tools rewrites this file to
 *     shrink it, the OME-XML becomes OURS and the file stops being what it is committed for.
 *   * **The document is `OME Bio-Formats 5.2.0-m4`'s**, over a real acquisition, and it carries
 *     what a round trip of ours has no call site for: `<Instrument>` with
 *     `<Microscope Manufacturer="Nikon" Model="Eclipse TE300">`, `<Detector>`, `<Objective>`,
 *     `<Experimenter>`, `<Plane TheC/TheZ/TheT>`, `DimensionOrder="XYZTC"`, and `<TiffData>`
 *     elements whose `<UUID FileName=…>` children name TWO FILES — one of which is not this one.
 *   * **The container is a shape no writer of ours emits**: `Compression = 1` (uncompressed —
 *     an arm of `DECODABLE_COMPRESSION` that until this file no committed byte reached),
 *     `RowsPerStrip = 1` (512 single-row strips, so one 512-row viewport tile resolves to 512
 *     ranged reads against `THIRD_PARTY_STRIPPED`'s 13 and our own tiled copy's 1), a
 *     `SampleFormat` tag — the only one in this directory — and `Software = "OME Bio-Formats
 *     5.2.0-m4"`, a third writer family beside `tifffile` and Pillow.
 *
 * AND THE LIMIT, stated as plainly as #322's is, because it is the same limit. `loadOmeTiffPyramid`
 * still does not parse OME-XML, so committing a foreign-authored document does not make an XML
 * PARSER pass anything — there is no parser. What the tests below can and do check is the
 * CONTAINER (read successfully, at a geometry and a codec ours never emits), the DOCUMENT's
 * presence and foreignness as bytes, and the DIVERGENCE between the two: the document says two
 * channels across two files, this file holds one IFD, and the reader answers the container.
 *
 * It is also NOT an instrument vendor's own writer. Bio-Formats is the OME reference
 * implementation; the pixels and the instrument metadata are a real acquisition's, the container
 * is Bio-Formats'. #346 names "a Bio-Formats export" as one of the shapes it wants and this is
 * that one; a file written by an instrument's own OME-TIFF writer is a further step, and
 * `fixtures/README.md` records what stands in the way of it.
 */
const VENDOR_OME_XML = `${FIXTURES}bioformats-tubhiswt.ome.tif`

/**
 * An INDEPENDENT oracle. These digests were produced by `tifffile` (a different decoder, in a
 * different language) over the same fixtures, and are the only thing in this suite that can
 * tell "the loader decoded the right pixels" from "the loader decoded pixels self-
 * consistently". Every other pixel assertion here compares the loader against itself and
 * would agree with it while it read the wrong bytes — measured: a mutation that shifted every
 * requested span by one byte survived the whole suite until these landed.
 */
const ORACLE = JSON.parse(readFileSync(`${FIXTURES}pixel-oracle.json`, 'utf8')) as Record<
  string,
  // `number` joined this union in #259, and it is not cosmetic: the oracle now carries BYTE
  // QUANTITIES (a tile's stored length, its offset, the coarsest level's size, the file's
  // non-pixel bytes) alongside the digests and shapes, and the bounds that consume them are
  // arithmetic. Without it every consumer needs an `as number` the compiler is right to refuse,
  // and `npx tsc --noEmit` in this package — which `just check-packages` runs per package since
  // #276 — fails while `vitest run` stays green, because vitest transpiles without typechecking.
  string | number | number[]
>

const sha256 = (data: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex')

/** One recorded read. `end` is INCLUSIVE, exactly as the source's contract states. */
interface RecordedRead {
  start: number
  end: number
  length: number
}

/** A `ByteRangeSource` over a file on disk that REMEMBERS every span it was asked for. */
function recordingSource(path: string): ByteRangeSource & {
  reads: RecordedRead[]
  totalBytes(): number
} {
  const bytes = readFileSync(path)
  const reads: RecordedRead[] = []
  return {
    reads,
    byteLength: bytes.byteLength,
    totalBytes: () => reads.reduce((sum, read) => sum + read.length, 0),
    async read(start: number, end: number): Promise<ArrayBuffer> {
      reads.push({ start, end, length: end - start + 1 })
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

/**
 * The TIFF directory of EVERY pyramid level of `path`, read with geotiff directly (#259).
 *
 * `loadOmeTiffPyramid` reports one `tiled` flag, taken from level 0, which cannot see a file
 * that is tiled at the base and stripped below it — the per-level drift `ome_writer.py`'s own
 * comment on `TILE` warns about. The walk here is IFD 0 plus each `SubIFDs` offset, which is
 * the same walk the module performs, done independently of it so a bug in that walk cannot
 * hide behind this assertion.
 */
async function levelDirectories(path: string): Promise<
  {
    ImageWidth?: number
    // ── WIDENED BY #322, and only widened ────────────────────────────────────────────────
    // `ImageLength` + `StripByteCounts` are what let a stripped file's strip COUNT be DERIVED
    // from its own tags (`ceil(ImageLength / RowsPerStrip)`) instead of transcribed, and
    // `Software` is the tag OUR writer stamps on everything it emits, so its presence is a
    // provenance predicate rather than a formatting detail. Each of the three is READ by an
    // assertion below; a field nothing reads is a claim the type system cannot make.
    //
    // ── WIDENED AGAIN BY #346, AND ONE OF #322'S OWN NOTES RETRACTED HERE ─────────────────
    // #322 declined to project `SampleFormat` and said why: *tag 339 is absent from EVERY
    // fixture in this corpus, our own writer's included, so it discriminates nothing.* That was
    // measured and was true of the twenty-one files that existed then. It is FALSE now.
    // `bioformats-tubhiswt.ome.tif` carries tag 339, it is the ONLY file here that does, and
    // `#346 TEST-2` asserts that over the directory rather than over a list — so 339 went from
    // discriminating nothing to being a one-file discriminator, and the projection has to be
    // able to see it. `Compression`, `SamplesPerPixel` and `BitsPerSample` join it for the same
    // reason and no other: #346 reads all four. (`Compression` and `SamplesPerPixel` were
    // already being reached through inline casts at two call sites in #322 TEST-2, which is a
    // worse way to say the same thing; those casts are gone.)
    //
    // Adding fields to this projection cannot change what any existing assertion sees.
    ImageLength?: number
    StripByteCounts?: ArrayLike<number>
    Software?: string
    Compression?: number
    SamplesPerPixel?: number
    BitsPerSample?: ArrayLike<number>
    SampleFormat?: ArrayLike<number>
    TileWidth?: number
    TileLength?: number
    RowsPerStrip?: number
    SubIFDs?: number[]
  }[]
> {
  const bytes = readFileSync(path)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const tiff = await fromArrayBuffer(buffer as ArrayBuffer)
  const base = await tiff.getImage(0)
  const directories = [base.fileDirectory as { SubIFDs?: number[] }]
  for (const offset of base.fileDirectory.SubIFDs ?? []) {
    const level = await tiff.parseFileDirectoryAt(offset)
    directories.push(level.fileDirectory)
  }
  return directories
}

/**
 * Viv's tile-edge rule, RE-IMPLEMENTED here — and that is a real limit, so it is stated.
 *
 * `@vivjs/loaders` computes `prevPowerOf2(min(getTileWidth(), getTileHeight()))`, where a
 * stripped file's `getTileHeight()` is its `RowsPerStrip` and its `getTileWidth()` is the image
 * width. Nothing imports that function, so this copy cannot notice Viv changing the rule; what
 * it does is evaluate the rule over the CONTROL FIXTURE'S OWN directory, so at least the inputs
 * are the file's rather than a remembered pair. The load-bearing half of #259 TEST-6 is the
 * loop above it — the reader still asks for 512 on a file whose derived edge is not 512 — which
 * exercises production code and would go red if the override were removed.
 */
/**
 * THE THREE PREDICATES #259 TEST-14 flips, named once so the claim is over an ENUMERABLE set.
 *
 * NOT for sharing — nothing else asserts through them, deliberately. Two earlier cuts added call
 * sites in TEST-1/TEST-2/TEST-4 to make a "the same objects" claim true, and a mutation showed
 * each of those sites sat beside a direct assertion of the identical thing and could not fail
 * independently of it. TEST-14 itself runs every predicate in BOTH directions on BOTH files, so
 * it is self-guarding and needs no second site.
 *
 * What declaring them buys is stated once, at the single call site (#259 TEST-14), rather than
 * here as well.
 */
const TILING_PREDICATES: readonly {
  name: string
  /** `true` for the layout #227 emits. */
  holds(file: string): Promise<boolean>
}[] = [
  {
    name: 'every pyramid level is tiled at 512, with no RowsPerStrip anywhere',
    async holds(file) {
      const directories = await levelDirectories(file)
      return directories.every(
        d => d.TileWidth === 512 && d.TileLength === 512 && d.RowsPerStrip === undefined,
      )
    },
  },
  {
    name: 'the loader reports the file as tiled',
    async holds(file) {
      return (await loadOmeTiffPyramid(recordingSource(file))).tiled
    },
  },
  {
    name: 'one 512x512 tile costs exactly ONE ranged read',
    async holds(file) {
      return (await tileReadCost(file, 1, 2)).reads === 1
    },
  },
]

/** What one level-0 tile of `file` costs the transport, with the open's cost excluded. */
async function tileReadCost(
  file: string,
  x: number,
  y: number,
): Promise<{ bytes: number; reads: number }> {
  const source = recordingSource(file)
  const { pyramid } = await loadOmeTiffPyramid(source)
  const openBytes = source.totalBytes()
  const openReads = source.reads.length
  await pyramid[0].getTile({ x, y, selection: { c: 0 } })
  return { bytes: source.totalBytes() - openBytes, reads: source.reads.length - openReads }
}

function prevPowerOfTwo(value: number): number {
  return 2 ** Math.floor(Math.log2(value))
}

const CHANNEL: RasterChannelState = {
  name: 'Channel 0',
  color: [255, 255, 255],
  contrastLimits: [0, 255],
  visible: true,
}

// ── TEST-2 — INV-1 ───────────────────────────────────────────────────────────────────────

describe('TEST-2 [acceptance] [invariant: INV-1] the pyramid is full-res-first and halves', () => {
  it('resolves a real emitted 3-level artifact into a halving PixelSource[] that drives MultiscaleImageLayer', async () => {
    const source = recordingSource(HIRES)
    const { pyramid } = await loadOmeTiffPyramid(source)

    // The producer's own declaration, read from the run's real manifest — so the expected
    // dimensions come from the ARTIFACT, not from this test's idea of it.
    const entries = JSON.parse(readFileSync(MANIFEST_ENTRIES, 'utf8')) as {
      id: string
      meta: { extent: { width: number; height: number } }
    }[]
    const declared = entries.find(entry => entry.id === 'spatial-image-hires')!.meta.extent

    expect(pyramid).toHaveLength(3)
    // index 0 is FULL resolution — the artifact's own declared extent.
    expect(sizeOf(pyramid[0])).toEqual({ width: declared.width, height: declared.height })
    // and every subsequent entry is half-scale, on BOTH axes.
    for (let level = 1; level < pyramid.length; level++) {
      const previous = sizeOf(pyramid[level - 1])
      expect(sizeOf(pyramid[level])).toEqual({
        width: Math.floor(previous.width / 2),
        height: Math.floor(previous.height / 2),
      })
    }

    // …and that array is what the shipped layer builder turns into a TILED multiscale layer.
    const layers = buildRasterImageLayers({ loader: pyramid, channels: [CHANNEL], cellId: 'c1' })
    expect(layers).toHaveLength(1)
    expect(layers[0]).toBeInstanceOf(MultiscaleImageLayer)
    expect((layers[0].props as unknown as { loader: unknown[] }).loader).toHaveLength(3)
  })

  it('resolves a real single-level artifact into the ImageLayer branch — the trivial case', async () => {
    const { pyramid } = await loadOmeTiffPyramid(recordingSource(LOWRES))
    expect(pyramid).toHaveLength(1)
    const layers = buildRasterImageLayers({ loader: pyramid, channels: [CHANNEL], cellId: 'c2' })
    expect(layers[0]).toBeInstanceOf(ImageLayer)
    expect(layers[0]).not.toBeInstanceOf(MultiscaleImageLayer)
  })
})

/** `[c, y, x]` or `[c, y, x, _c]` — Viv's own rule for reading a size off a shape. */
function sizeOf(source: { shape: number[] }): { width: number; height: number } {
  const [height, width] = source.shape.slice(isInterleaved(source.shape) ? -3 : -2)
  return { width, height }
}

// ── TEST-3 ───────────────────────────────────────────────────────────────────────────────

describe('TEST-3 the normalized metadata comes from the shipped parseMultiscales', () => {
  it('reports the artifact’s real per-level dimensions, downsample factors, dtype and channel', async () => {
    const { meta } = await loadOmeTiffPyramid(recordingSource(HIRES))
    expect(meta.levels.map(level => [level.width, level.height])).toEqual([
      [1400, 1800],
      [700, 900],
      [350, 450],
    ])
    expect(meta.levels.map(level => level.downsample)).toEqual([1, 2, 4])
    expect(meta.dtype).toBe('Uint8')
    expect(meta.channels).toHaveLength(1)
    expect(meta.axisIndex).toMatchObject({ c: 0, y: 1, x: 2 })
  })

  it('plumbs the caller’s pixel pitch into the per-level scale, and omits it when absent', async () => {
    // The pitch below is the FROZEN fixture's own OME `PhysicalSizeX`, checked against the TIFF
    // bytes by `scripts/check-viz-producer-magnitudes.mjs` (#277).
    // [frozen-magnitude: spatial-image-hires.PhysicalSizeX]
    const withScale = await loadOmeTiffPyramid(recordingSource(HIRES), {
      micronsPerPixel: 3.7356857014116684,
    })
    expect(withScale.physicalSize).toEqual({ x: 3.7356857014116684, y: 3.7356857014116684 })
    // a coarser level's pixel covers twice as much, which is what NGFF's per-level scale says
    expect(withScale.meta.levels.map(level => level.scale[0])).toEqual([
      3.7356857014116684,
      3.7356857014116684 * 2,
      3.7356857014116684 * 4,
    ])

    // Absent, zero and NaN all mean "not declared" — array-index units, never a fabricated 1.0
    // presented as a measurement. (`physicalSize` is ABSENT, not 1.)
    for (const bad of [undefined, 0, Number.NaN, -1]) {
      const plain = await loadOmeTiffPyramid(recordingSource(HIRES), { micronsPerPixel: bad })
      expect(plain.physicalSize).toBeUndefined()
      expect(plain.meta.levels.map(level => level.scale[0])).toEqual([1, 2, 4])
    }
  })

  it('the NGFF it hands parseMultiscales is well formed for every level', () => {
    const sizes = [
      { width: 1400, height: 1800 },
      { width: 700, height: 900 },
    ]
    const ngff = ngffForLevels(sizes, {
      channels: 1,
      samples: 3,
      interleaved: true,
      dtype: 'Uint8',
      scale: 2,
    })
    // parseMultiscales THROWS on a dataset with no matching array metadata; this is the
    // guard that a level added to `sizes` cannot silently arrive without its array entry.
    expect(Object.keys(ngff.arrays)).toEqual(['0', '1'])
    const meta = parseMultiscales(ngff)
    // by MAP rather than by index: a level's physical scale doubles with its depth, and the
    // whole sequence is the claim.
    expect(meta.levels.map(level => level.scale)).toEqual([
      [2, 2],
      [4, 4],
    ])
  })
})

// ── TEST-4 — INV-5 ───────────────────────────────────────────────────────────────────────

describe('TEST-4 [acceptance] [invariant: INV-5] one non-Zarr file, read by bounded ranges', () => {
  it('#259 TEST-5 decodes a level-0 tile using bytes bounded by the SLICE, not merely by the file', async () => {
    const source = recordingSource(HIRES)
    const { pyramid } = await loadOmeTiffPyramid(source)
    const afterOpen = source.reads.length
    const afterOpenBytes = source.totalBytes()
    expect(afterOpen).toBeGreaterThan(0)

    const tile = await pyramid[0].getTile({ x: 1, y: 2, selection: { c: 0 } })
    // every span the TILE read cost, separated from the open's — #259 TEST-5 below is about the
    // tile, and folding the open into it is what let the old bound describe nothing.
    const tileReads = source.reads.slice(afterOpen)
    // The CONCRETE edge, not `DEFAULT_OME_TIFF_LIMITS.tileSize` — that spelling mutates with
    // the constant, so it held while the tile size was changed to Viv's own derived value.
    expect(tile.width).toBe(512)
    expect(tile.height).toBe(512)
    // …and specifically NOT the value Viv's `loadOmeTiff` derives for a STRIPPED file. It
    // computes `prevPowerOf2(min(TileWidth ?? width, TileLength ?? RowsPerStrip))`; since #227
    // this artifact is tiled at 512, so that rule now agrees here — but on the pre-#227 emit
    // kept as `spatial-image-hires-stripped.ome.tif` it says 32, ~2000 deck tiles for one
    // full-resolution viewport. Choosing the tile size, rather than reading it off whatever
    // file arrived, is the reason this loader does not call `loadOmeTiff` (#259 TEST-6).
    expect(tile.width).not.toBe(32)
    expect(DEFAULT_OME_TIFF_LIMITS.tileSize).toBe(512)
    // the tile really cost network, rather than being already-resident
    expect(source.reads.length).toBeGreaterThan(afterOpen)
    // and the pixels are the RIGHT ones, checked against a decoder that is not this one
    expect(ORACLE.hires_level0_tile_x1_y2_shape).toEqual([tile.height, tile.width, 3])
    expect(sha256(tile.data)).toBe(ORACLE.hires_level0_tile_x1_y2_512)

    // every read is a BOUNDED span inside the file — never an unbounded whole-object read…
    for (const read of source.reads) {
      expect(read.start).toBeGreaterThanOrEqual(0)
      expect(read.end).toBeLessThan(source.byteLength)
      expect(read.length).toBeGreaterThan(0)
    }

    // …and the bytes moved are bounded by the SLICE, not by the file.
    //
    // ── #259 TEST-5: THE BOUND, RE-DERIVED AGAINST THE TILED ARTIFACT ──────────────────────
    //
    // `< byteLength` was the original bound and it is far too weak: a loader that fetched 99%
    // of the object per tile would satisfy it, and on the multi-gigabyte images this design
    // exists for that is the whole failure.
    //
    // What replaced it was `4 x (512 x 1400 x 3)` — a 512-row FULL-WIDTH band, times four,
    // because the file was stripped and a band cost whole strips. That expression is
    // 8,601,600 bytes against a 166,838-byte file: it could not bind, and once #227 made the
    // emit tiled it had also stopped describing the artifact. A bound left loose after the
    // reason for looseness is gone is a check that has stopped discriminating.
    //
    // The bound below is the file's OWN statement of what this tile costs. `TileByteCounts[i]`
    // is the stored length of tile `i`, so "one tile, one range request" is expressible as an
    // EQUALITY rather than as a multiple — and it stays true at any artifact size, because it
    // is read out of the artifact rather than computed from a viewport guess.
    //
    // Measured on this branch, tile (1, 2) of the hires artifact: the open costs 5,508 bytes
    // over 5 reads, and the tile then costs 11,120 bytes over exactly ONE read, which is
    // `TileByteCounts[7]` to the byte. The same tile on the pre-#227 stripped artifact costs
    // 36,444 bytes over 9 reads (#259 TEST-4).
    const base = (await levelDirectories(HIRES))[0] as unknown as {
      ImageWidth: number
      TileWidth: number
      TileByteCounts: ArrayLike<number>
    }
    // Both operands out of the file. Tile `(x, y)` of a TIFF is index `y * tilesAcross + x`,
    // and this test asked for (1, 2).
    const tilesAcross = Math.ceil(base.ImageWidth / base.TileWidth)
    const storedTileBytes = Number(base.TileByteCounts[2 * tilesAcross + 1])
    expect(storedTileBytes).toBeGreaterThan(0)
    // …and the same length, arrived at by a DIFFERENT decoder. `geotiff` parses the directory
    // here and `geotiff` also computes the loader's span, so a tag misparse would move both
    // sides of the equality below together and it would still pass. `tifffile` produced the
    // oracle entry, so this line is what closes that.
    expect(storedTileBytes).toBe(ORACLE.hires_level0_tile_x1_y2_stored_bytes)
    // ONE span, of exactly the tile's stored length. This is the assertion a stripped file, a
    // block-reader, or a whole-object read each fail — the first two by span count, the third
    // by both.
    expect(tileReads).toHaveLength(1)
    expect(tileReads[0].length).toBe(storedTileBytes)
    // The OPEN is bounded SEPARATELY, and it has to be: with the tile pinned exactly above,
    // any bound on the total reduces to a bound on the open, and an earlier cut wrote it as
    // `total < storedTileBytes + 2 * openBytes` — which is `openBytes < 2 * openBytes`, i.e.
    // a tautology sitting in the block whose whole subject is bounds that stopped binding.
    //
    // What an open is ALLOWED to read is a real quantity and it is in the file: the TIFF
    // header, the OME-XML and every level's directory, i.e. everything that is not pixel
    // payload. `hires_non_pixel_bytes` is that figure, derived from the artifact by
    // `make-emitted-image-fixtures.py --oracle` (2,296 B here). The open costs more than once
    // that because geotiff re-reads its fixed 1024-byte window per level; measured 5,508 B
    // over 5 reads, i.e. 2.4x. The bound is 3x, and it refuses an open that started pulling
    // pixel data.
    const nonPixelBytes = ORACLE.hires_non_pixel_bytes as number
    expect(nonPixelBytes).toBeGreaterThan(0)
    // RE-DERIVED here, the same way the tile length above is. Three e2e byte budgets are stated
    // in this entry, and an oracle entry that nothing recomputes is a constant with a JSON file
    // around it: inflate it and every one of those budgets loosens with nothing red. So it is
    // recomputed from the artifact's own directories at run time and required to agree.
    //
    // ONE PAGE PER LEVEL is assumed here and is true of everything `write_ome_tiff` emits — the
    // generator's own sum walks every page of every level instead, because it is written for a
    // shape this writer does not produce today. If that ever changes, this line goes red on a
    // CORRECT corpus and the fix is to widen it, not to delete it.
    const pixelBytes = (await levelDirectories(HIRES))
      .map(d => (d as unknown as { TileByteCounts: ArrayLike<number> }).TileByteCounts)
      .reduce((sum, counts) => sum + Array.from(counts).reduce((a, b) => a + Number(b), 0), 0)
    expect(readFileSync(HIRES).byteLength - pixelBytes).toBe(nonPixelBytes)
    expect(afterOpenBytes).toBeLessThan(3 * nonPixelBytes)
    expect(source.totalBytes()).toBe(afterOpenBytes + storedTileBytes)
  })

  it('never asks for a byte past the end of the file — the span the byte plane answers 416', async () => {
    const source = recordingSource(HIRES)
    const { pyramid } = await loadOmeTiffPyramid(source)
    await pyramid[pyramid.length - 1].getRaster({ selection: { c: 0 } })
    expect(source.reads.length).toBeGreaterThan(0)
    const overruns = source.reads.filter(read => read.end >= source.byteLength)
    expect(overruns).toEqual([])
    // and the clamp really was exercised: at least one read ends exactly at the last byte,
    // which is what an un-clamped request would have overshot.
    expect(source.reads.some(read => read.end === source.byteLength - 1)).toBe(true)
  })

})

// ── TEST-17 ─────────────────────────────────────────────────────────────────────────────

describe('TEST-17 the transport’s own failure survives, and the header window is clamped', () => {
  it('clamps the FIXED header window on a file shorter than it', async () => {
    // The case where the reader genuinely asks past the end and no `fileSize` can stop it:
    // geotiff opens EVERY file by reading a fixed 1024-byte window at offset 0, so a file
    // shorter than that is over-asked on its very first read. Unclamped, that span is a 416
    // from the byte plane rather than a short body — so this is the one place the clamp is
    // not merely defensive, and it is why this fixture is 512 bytes.
    const source = recordingSource(SHORT_FILE)
    expect(source.byteLength).toBe(512)
    expect(source.byteLength).toBeLessThan(1024)
    // it is not a TIFF, so it is refused — AFTER the read that this case is about
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow()
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.filter(read => read.end >= source.byteLength)).toEqual([])
    expect(source.reads[0]).toMatchObject({ start: 0, end: 511 })
  })

  it('surfaces the TRANSPORT’s OWN typed failure, not an opaque one', async () => {
    // The reason the loader implements geotiff's byte source directly rather than going
    // through `fromCustomClient`: that path wraps every failure with `Promise.allSettled` and
    // re-raises `AggregateError('Request failed')` carrying `[undefined]`, so a 401 that wants
    // a re-login, a 416 that means a span was not clamped, and a dead socket all arrive as the
    // same three words with the transport's typed error already destroyed. Here the original
    // object reaches the caller intact — `status` included, which is what a caller needs to
    // decide between "refresh the token" and "tell the user".
    class ExpiredToken extends Error {
      readonly status = 401
      readonly errorCode = 'MISSING_TOKEN'
    }
    const source: ByteRangeSource = {
      byteLength: 4096,
      async read() {
        throw new ExpiredToken('the access token expired')
      },
    }
    const error = await loadOmeTiffPyramid(source).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ExpiredToken)
    expect((error as ExpiredToken).status).toBe(401)
    expect((error as ExpiredToken).errorCode).toBe('MISSING_TOKEN')
    expect((error as Error).message).toBe('the access token expired')
    // …and specifically NOT geotiff's aggregate, which is what the discarded path produced
    expect((error as Error).name).not.toBe('AggregateError')
    expect((error as Error).message).not.toMatch(/Request failed/)
  })
})

// ── TEST-5 — INV-2 ───────────────────────────────────────────────────────────────────────

describe('TEST-5 [acceptance] [invariant: INV-2] the loader is storage-agnostic', () => {
  it('produces identical pixels over an in-memory source and over a real HTTP socket', async () => {
    const bytes = readFileSync(HIRES)

    // Source A: memory.
    const memory = recordingSource(HIRES)

    // Source B: a REAL http server, real sockets, real Range headers. Nothing about it is
    // shared with source A beyond the bytes on disk — which is the point: if the loader knew
    // anything about how bytes arrive, these two could not agree.
    const server = createServer((request, response) => {
      const match = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '')
      if (!match) {
        response.writeHead(400).end()
        return
      }
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), bytes.byteLength - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
        'content-type': 'application/octet-stream',
      })
      response.end(bytes.subarray(start, end + 1))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const http: ByteRangeSource = {
        byteLength: bytes.byteLength,
        async read(start, end) {
          const response = await fetch(`http://127.0.0.1:${port}/image.ome.tif`, {
            headers: { Range: `bytes=${start}-${end}` },
          })
          expect(response.status).toBe(206)
          return await response.arrayBuffer()
        },
      }

      const fromMemory = await loadOmeTiffPyramid(memory)
      const fromHttp = await loadOmeTiffPyramid(http)

      expect(fromHttp.pyramid.map(level => level.shape)).toEqual(
        fromMemory.pyramid.map(level => level.shape),
      )
      expect(fromHttp.meta.dtype).toBe(fromMemory.meta.dtype)
      expect(fromHttp.interleaved).toBe(fromMemory.interleaved)

      const a = await fromMemory.pyramid[0].getTile({ x: 1, y: 1, selection: { c: 0 } })
      const b = await fromHttp.pyramid[0].getTile({ x: 1, y: 1, selection: { c: 0 } })
      expect(b.width).toBe(a.width)
      expect(b.height).toBe(a.height)
      expect(Array.from(b.data.slice(0, 4096))).toEqual(Array.from(a.data.slice(0, 4096)))
      // non-vacuity: the tile is real image content, not a zero-filled buffer.
      expect(a.data.some(value => value !== 0)).toBe(true)

      // Agreeing with each other is not enough — two sources through one loader are wrong
      // together. Both are therefore also checked against the independent decoder.
      const coarseA = await fromMemory.pyramid[2].getRaster({ selection: { c: 0 } })
      const coarseB = await fromHttp.pyramid[2].getRaster({ selection: { c: 0 } })
      expect(sha256(coarseA.data)).toBe(ORACLE.hires_level2_raster)
      expect(sha256(coarseB.data)).toBe(ORACLE.hires_level2_raster)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ── TEST-6 ───────────────────────────────────────────────────────────────────────────────

describe('TEST-6 the model matrix places pixels by the declared affine ALONE', () => {
  const entries = JSON.parse(readFileSync(MANIFEST_ENTRIES, 'utf8')) as {
    id: string
    meta: { to_space: number[]; microns_per_pixel: number }
  }[]
  const hires = entries.find(entry => entry.id === 'spatial-image-hires')!

  it('maps pixel (0,0) to the space origin — the CORNER convention, inherited', () => {
    const matrix = omeTiffModelMatrix(hires.meta.to_space as unknown as Affine)
    expect(apply(matrix, 0, 0)).toEqual([0, 0])
  })

  it('scales by the declared to_space and NOT by the image’s own micron pitch', () => {
    const matrix = omeTiffModelMatrix(hires.meta.to_space as unknown as Affine)
    // The artifact declares to_space = [5,0,0,0,5,0].
    expect(apply(matrix, 1, 0)).toEqual([5, 0])
    expect(apply(matrix, 0, 1)).toEqual([0, 5])

    // The trap, named with the number it would produce. #258 TEST-3.
    //
    // [frozen-magnitude: spatial-image-hires.PhysicalSizeX] [frozen-magnitude: microns_per_pixel]
    // OME PhysicalSizeX on this artifact is 3.7356857 um/px and the SPACE's scale is 0.7471371
    // um/px; their ratio IS the declared 5.0.
    // [frozen-magnitude: spatial-image-hires.composed_pitch_over_affine]
    // Composing the pixel pitch over the affine — which is what the NGFF path does — would
    // place the image at 18.678… instead of 5, and it would still look like a tissue image,
    // just in the wrong place at the wrong size.
    //
    // [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]
    // THOSE TWO MAGNITUDES ARE THIS FIXTURE'S, AND THIS FIXTURE IS PRE-#222 — the importer's
    // output as of #154/#155/#176, kept byte-identical under #222's fix-forward-only ruling.
    // For the same bundle the importer today derives 4.4149… and 0.88298… (#222 changed the
    // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
    // numerator from the 55 µm capture footprint to the 65 µm rendered spot diameter, which is
    // what `spot_diameter_fullres` measures). Read the RATIO, not the pair: it is 5.0 either
    // way, because `to_space[0]` is `1/tissue_hires_scalef` and `PhysicalSizeX` is
    // `microns_per_pixel` over that same scalefactor.
    //
    // [frozen-magnitude: spatial-image-hires.PhysicalSizeX]
    // The literal below is a hand-copy and is SAFE, for TWO reasons now. The first is #277's
    // guard, which checks it against the fixture's own TIFF bytes. The second is local: the last
    // assertion in this test divides it by the artifact's own `microns_per_pixel` and pins the
    // quotient to a hardcoded 5, so a regenerated fixture turns it red rather than leaving it
    // quietly stale. (`omeTiffUnderlay.test.ts` reaches the same safety differently — it reads
    // the quantity off the artifact instead of copying it. Two mechanisms, one requirement.)
    const physicalSizeX = 3.7356857014116684
    expect(apply(matrix, 1, 0)[0]).not.toBeCloseTo(5 * physicalSizeX, 6)
    // and the declared numbers really are related that way — so the trap is real, not hypothetical
    expect(physicalSizeX / hires.meta.microns_per_pixel).toBeCloseTo(5, 9)
  })

  it('carries the SHEAR and the TRANSLATION, not just the diagonal', () => {
    // The artifact's own affine is diagonal, symmetric and untranslated — so every assertion
    // above survives a TRANSPOSED linear part and a DROPPED translation, which are exactly
    // the two errors that put an image in the wrong place. This case is asymmetric in both
    // off-diagonal terms and has a non-zero, unequal translation, so nothing about it can be
    // satisfied by an implementation that loses either.
    const affine: Affine = [2, 0.5, 7, -0.25, 3, 11]
    const matrix = omeTiffModelMatrix(affine)
    // `x' = a·x + b·y + tx ; y' = c·x + d·y + ty`
    expect(apply(matrix, 0, 0)).toEqual([7, 11]) // the translation alone
    expect(apply(matrix, 1, 0)).toEqual([2 + 7, -0.25 + 11]) // the FIRST column
    expect(apply(matrix, 0, 1)).toEqual([0.5 + 7, 3 + 11]) // the SECOND column
    // the transpose is a different matrix, and this case can tell them apart
    const transposed = omeTiffModelMatrix([2, -0.25, 7, 0.5, 3, 11])
    expect(apply(transposed, 1, 0)).not.toEqual(apply(matrix, 1, 0))
  })
})

/** apply a deck.gl 16-element COLUMN-major matrix to a 2-D point. */
function apply(matrix: number[], x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[4] * y + matrix[12], matrix[1] * x + matrix[5] * y + matrix[13]]
}

// ── TEST-7 ───────────────────────────────────────────────────────────────────────────────

describe('TEST-7 an undecodable codec is refused at OPEN, naming it', () => {
  it('refuses a real JPEG-2000 OME-TIFF before any tile is requested', async () => {
    const source = recordingSource(JPEG2000)
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow(UnsupportedImageCodecError)
    await expect(loadOmeTiffPyramid(recordingSource(JPEG2000))).rejects.toThrow(/34712/)
    await expect(loadOmeTiffPyramid(recordingSource(JPEG2000))).rejects.toThrow(/JPEG-2000/)
    // …and it failed while reading IFD 0's directory — BEFORE the pyramid was walked and
    // before any pixel was asked for. Asserted positionally rather than as a count, because
    // `reads.length > 0` is a lower bound no loader can fail: the specific mutation this
    // catches is moving `assertDecodableCodec` after the SubIFD loop, which is why the fixture
    // deliberately HAS a SubIFD, and its offset is recorded by the independent tool.
    const firstSubIfd = ORACLE.jpeg2000_first_subifd_offset as number
    expect(source.byteLength).toBe(ORACLE.jpeg2000_byte_length)
    expect(firstSubIfd).toBeGreaterThan(0)
    expect(firstSubIfd).toBeLessThan(source.byteLength) // the level directory really is inside
    expect(source.reads.length).toBeGreaterThan(0)
    // NOT "no read past that offset" — tifffile writes IFD 0's own directory AFTER the pixel
    // data, so the main directory legitimately lives beyond it. The precise claim is that the
    // bytes AT the level directory were never fetched, i.e. `parseFileDirectoryAt` never ran.
    expect(
      source.reads.filter(read => read.start <= firstSubIfd && read.end >= firstSubIfd),
      'the level directory at its recorded offset was never read — the refusal happened first',
    ).toEqual([])
    // non-vacuity: the loader really does read that offset when it gets far enough. The same
    // shape of file with a codec it CAN read walks the pyramid, so the assertion above is
    // discriminating rather than true of every run.
    const tiledReads = recordingSource(TILED)
    const tiledPyramid = await loadOmeTiffPyramid(tiledReads)
    expect(tiledPyramid.pyramid.length).toBe(2)
    expect(tiledReads.reads.length).toBeGreaterThan(source.reads.length)
  })

  it('accepts every codec the writer is allowed to emit and refuses the lossy ones by name', () => {
    expect(() => assertDecodableCodec(32946)).not.toThrow() // Deflate — what the writer emits
    expect(() => assertDecodableCodec(8)).not.toThrow() // Deflate (Adobe)
    expect(() => assertDecodableCodec(5)).not.toThrow() // LZW — the declared alternative
    expect(() => assertDecodableCodec(1)).not.toThrow() // uncompressed
    expect(() => assertDecodableCodec(undefined)).not.toThrow() // absent tag means 1
    expect(() => assertDecodableCodec(34712)).toThrow(/JPEG-2000/)
    expect(() => assertDecodableCodec(33005)).toThrow(/JPEG-2000/)
    expect(() => assertDecodableCodec(7)).toThrow(/JPEG/)
    expect(() => assertDecodableCodec(99999)).toThrow(/unknown codec/)
  })

  it('derives the Viv dtype from BitsPerSample and SampleFormat', () => {
    expect(dtypeOfDirectory({ BitsPerSample: [8], SampleFormat: [1] })).toBe('Uint8')
    expect(dtypeOfDirectory({ BitsPerSample: [16], SampleFormat: [1] })).toBe('Uint16')
    expect(dtypeOfDirectory({ BitsPerSample: [16], SampleFormat: [2] })).toBe('Int16')
    expect(dtypeOfDirectory({ BitsPerSample: [32], SampleFormat: [3] })).toBe('Float32')
    expect(dtypeOfDirectory({})).toBe('Uint8')
  })
})

// ── TEST-11 ──────────────────────────────────────────────────────────────────────────────

// TEST-11 is a FIXTURE-INTEGRITY guard, not a behaviour test, and is labelled as one: its
// assertions are over the committed bytes, so no mutation of the loader can turn them red.
// It earns its place by making the rest of the suite's "a REAL emitted artifact" claim
// checkable — without it, someone could regenerate the fixtures by hand and every other test
// would keep passing against a file the system never produces. INV-5's executable proof is
// TEST-4 (bounded spans over one file), not this.
describe('TEST-11 the fixtures are genuinely emitted artifacts, not hand-made TIFFs', () => {
  it('carries the producer’s own OME-XML placement, agreeing with the run’s manifest', () => {
    const raw = readFileSync(HIRES).toString('latin1')
    const marker = 'cyto-spatial/1 '
    const at = raw.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    const json = raw.slice(at + marker.length, raw.indexOf('</Description>', at))
    const placement = JSON.parse(json) as {
      coordinate_space: string
      to_space: number[]
      extent: { width: number; height: number }
      display_derivative: { is_display_derivative: boolean }
    }
    expect(placement.coordinate_space).toMatch(/^visium:/)
    expect(placement.to_space).toHaveLength(6)
    expect(placement.display_derivative.is_display_derivative).toBe(true)

    // the file's OWN copy and the manifest's copy agree — the same cross-check the
    // registration QC makes on the producer side.
    const entries = JSON.parse(readFileSync(MANIFEST_ENTRIES, 'utf8')) as {
      id: string
      structure: { encoding: string; media_type: string }
      meta: { to_space: number[]; extent: { width: number; height: number } }
    }[]
    const hires = entries.find(entry => entry.id === 'spatial-image-hires')!
    expect(placement.to_space).toEqual(hires.meta.to_space)
    expect(placement.extent).toEqual(hires.meta.extent)
    expect(hires.structure).toEqual({
      encoding: 'opaque',
      media_type: 'image/tiff; application=ome',
    })
  })

  it('is a SINGLE non-Zarr file — the property that lets an image be declared opaque', () => {
    for (const path of [HIRES, LOWRES, GREYSCALE]) {
      const bytes = readFileSync(path)
      expect(bytes.includes(Buffer.from('zarr.json'))).toBe(false)
      // little-endian classic TIFF (`II*\0`) or BigTIFF (`II+\0`)
      expect([0x2a, 0x2b]).toContain(bytes[2])
    }
  })
})

// ── TEST-12 ──────────────────────────────────────────────────────────────────────────────

describe('TEST-12 interleaved and planar sources are shaped for the layer that renders them', () => {
  it('an interleaved RGB artifact presents ONE channel with a trailing sample axis', async () => {
    const { pyramid, interleaved } = await loadOmeTiffPyramid(recordingSource(HIRES))
    expect(interleaved).toBe(true)
    expect(pyramid[0].labels).toEqual(['c', 'y', 'x', '_c'])
    expect(isInterleaved(pyramid[0].shape)).toBe(true)
    // ONE channel, not three: `buildRasterImageLayers` derives one selection per channel and
    // Viv's interleaved path reads only the first, so three would triple the tile requests
    // and throw two thirds away.
    expect(pyramid[0].shape[0]).toBe(1)
    const tile = await pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
    expect(tile.data.length).toBe(tile.width * tile.height * 3)
    expect(tile.data.some(value => value !== 0)).toBe(true)
  })

  it('a greyscale artifact from the same writer presents a planar single-sample source', async () => {
    const { pyramid, interleaved, meta } = await loadOmeTiffPyramid(recordingSource(GREYSCALE))
    expect(interleaved).toBe(false)
    expect(pyramid[0].labels).toEqual(['c', 'y', 'x'])
    expect(isInterleaved(pyramid[0].shape)).toBe(false)
    expect(meta.dtype).toBe('Uint16')
    expect(sizeOf(pyramid[0])).toEqual({ width: 768, height: 1024 })
    const tile = await pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
    expect(tile.data.length).toBe(tile.width * tile.height)
    expect(tile.data.constructor.name).toBe('Uint16Array')
    expect(sha256(tile.data)).toBe(ORACLE.greyscale_level0_tile_x0_y0_512)
  })

  it('#259 TEST-2 reports whether the file stores tiles or full-width strips — BOTH branches', async () => {
    // Since #227 the emitted artifact is TILED — `write_ome_tiff` passes `tile=(512, 512)` at
    // every `writer.write` call site — and #259 regenerated these fixtures so they sample that.
    // These two assertions used to read `false`; they are the reason the corpus needed
    // refreshing, because static bytes cannot go red on their own.
    expect((await loadOmeTiffPyramid(recordingSource(HIRES))).tiled).toBe(true)
    expect((await loadOmeTiffPyramid(recordingSource(GREYSCALE))).tiled).toBe(true)
    expect((await loadOmeTiffPyramid(recordingSource(TILED))).tiled).toBe(true)
    // The false branch is asserted against a fixture a successful read actually goes through,
    // not only against a directory literal. Without one it would be satisfiable by the constant
    // `false` everywhere a real file is involved, which is the state this corpus was in for
    // `true`. `docs/design/ome-tiff-tile-layout.md` §5 is why the branch is permanent: OME-TIFFs
    // in the wild are routinely stripped, and this reader is not confined to its own writer.
    expect((await loadOmeTiffPyramid(recordingSource(HIRES_STRIPPED))).tiled).toBe(false)
    // and the derivation itself, so neither branch depends on a fixture existing
    expect(tiledOfDirectory({ TileWidth: 256 })).toBe(true)
    expect(tiledOfDirectory({ RowsPerStrip: 62 })).toBe(false)
    expect(tiledOfDirectory({})).toBe(false)
  })

  it('#259 TEST-15 the regeneration moved the BYTES and moved no PIXEL', async () => {
    // The claim #227 made about the writer, re-proven here on the reader side and against the
    // independent decoder rather than against this loader's own earlier output. Every digest is
    // `tifffile`'s, over the committed bytes; `hires_stripped_level0_tile_x1_y2_512` is computed
    // from the pre-#227 file and `hires_level0_tile_x1_y2_512` from the tiled one, so their
    // being equal is a measurement of two files and not an alias.
    // Two entries, computed from TWO DIFFERENT FILES by `tifffile` in
    // `make-emitted-image-fixtures.py --oracle`. Their equality is a measurement of the corpus,
    // and it is what stops the loop below being self-referential: the loop compares this loader
    // against itself across two files, and would agree with itself while reading both of them
    // wrongly in the same way.
    expect(ORACLE.hires_stripped_level0_tile_x1_y2_512).toBe(ORACLE.hires_level0_tile_x1_y2_512)
    const stripped = await loadOmeTiffPyramid(recordingSource(HIRES_STRIPPED))
    const tiled = await loadOmeTiffPyramid(recordingSource(HIRES))
    for (const { pyramid } of [stripped, tiled]) {
      const tile = await pyramid[0].getTile({ x: 1, y: 2, selection: { c: 0 } })
      expect([tile.height, tile.width, 3]).toEqual(ORACLE.hires_level0_tile_x1_y2_shape)
      expect(sha256(tile.data)).toBe(ORACLE.hires_level0_tile_x1_y2_512)
    }
    // …and the two files really are different files, so the equality above is not trivial.
    expect(readFileSync(HIRES_STRIPPED).byteLength).not.toBe(readFileSync(HIRES).byteLength)
  })

  it('#259 TEST-3 [acceptance] [invariant: INV-5] reads a STRIPPED file the writer can no longer produce', async () => {
    // INV-5, verbatim from `docs/design/ome-tiff-tile-layout.md` §5: *"a reader that only
    // handles the layout its own writer emits is a reader that breaks on the first third-party
    // OME-TIFF."* `write_ome_tiff` has passed `tile=` at every call site since #227, so this
    // layout is now unreachable from our own producer — which is exactly why a committed sample
    // of it is the only thing keeping the branch honest.
    const source = recordingSource(HIRES_STRIPPED)
    const { pyramid, tiled, interleaved, meta } = await loadOmeTiffPyramid(source)
    expect(tiled).toBe(false)
    expect(interleaved).toBe(true)
    expect(pyramid).toHaveLength(3)
    expect(sizeOf(pyramid[0])).toEqual({ width: 1400, height: 1800 })
    expect(meta.dtype).toBe('Uint8')
    const tile = await pyramid[0].getTile({ x: 1, y: 2, selection: { c: 0 } })
    expect(sha256(tile.data)).toBe(ORACLE.hires_stripped_level0_tile_x1_y2_512)
    // the coarsest level decodes too, so the SubIFD walk is exercised on this layout and not
    // only on the tiled one
    const coarsest = await pyramid[pyramid.length - 1].getRaster({ selection: { c: 0 } })
    expect(sha256(coarsest.data)).toBe(ORACLE.hires_level2_raster)
  })

  it('#259 TEST-4 [acceptance] [invariant: INV-1] a tiled tile costs ONE read; the same tile stripped costs nine', async () => {
    // INV-1, verbatim from `docs/design/ome-tiff-tile-layout.md` §4: *"A tiled TIFF lets a
    // viewer fetch `tileSize × tileSize`. A stripped one forces `imageWidth × stripHeight` —
    // the full width of the image, every time, no matter how narrow the viewport."*
    //
    // Asserted as a CONTROLLED EXPERIMENT rather than as a bound: the two fixtures are the same
    // image, the same pixels and the same placement, differing only in layout, so the delta
    // below cannot be anything but the layout. Both figures are measured on this branch:
    //
    //     STRIPPED   36,444 bytes over 9 reads   (nine consecutive full-width strips)
    //     TILED      11,120 bytes over 1 read    (one 512x512 TIFF tile)
    //
    // 3.28x the bytes and 9x the requests. The byte ratio is close to the `imageWidth /
    // tileSize` = 1400 / 512 = 2.73 the defect predicts and slightly above it, because a strip
    // read also drags the rows of the partially-covered strips at each end of the band.
    //
    // AND THE OTHER TILE, because a design correction rests on it. #259 amended
    // `docs/design/ome-tiff-tile-layout.md` §2 from "ten … consecutive full-width strips" to
    // NINE, on the arithmetic that #158's recorded 41,891 B / 14 GETs decomposes as a 5,508 B /
    // 5-GET open plus nine strips. Tile (0, 0) is the one that spec reads, so the decomposition
    // is asserted here rather than left as a paragraph: nine reads, 36,383 bytes, and the whole
    // transaction 41,891 over 14. Ten strips would be 40,439, which does not balance.
    const stripped = await tileReadCost(HIRES_STRIPPED, 1, 2)
    const tiled = await tileReadCost(HIRES, 1, 2)
    // ONE range request per tile is the whole promise, and it is the assertion that would fail
    // first if the tiling were ever dropped from the writer or mishandled by the reader.
    expect(tiled.reads).toBe(1)
    // EXACTLY nine, not `>= 9`: a regression that read MORE strips is a regression, and the
    // measured value is nine on every full 512-row band of this file.
    expect(stripped.reads).toBe(9)
    // …and the bytes follow. A `<` alone would pass on a 1% difference, so the measured ratio is
    // asserted with a margin rather than the direction alone.
    expect(stripped.bytes / tiled.bytes).toBeGreaterThan(3)

    const strippedAtOrigin = await tileReadCost(HIRES_STRIPPED, 0, 0)
    expect(strippedAtOrigin.reads).toBe(9)
    expect(strippedAtOrigin.bytes).toBe(36_383)
    const openSource = recordingSource(HIRES_STRIPPED)
    await loadOmeTiffPyramid(openSource)
    expect(openSource.reads.length).toBe(5)
    expect(openSource.totalBytes()).toBe(5_508)
    // (5,508 + 36,383 = 41,891 over 5 + 9 = 14 is #158's recorded figure, and it is deliberately
    // NOT asserted as a fifth line: it is an arithmetic consequence of the four above and could
    // not fail independently of them — the decoration this suite removed elsewhere.)

    // ── AND THE FIGURE THAT LOOKS LIKE A COUNTER-EXAMPLE, DECOMPOSED ──────────────────────
    // Run the render specs against the stripped artifact instead of the emitted one and the
    // stripped run comes out CHEAPER: 18,754 B over 7 GETs against 18,950 B over 6. That is
    // recorded in `docs/design/ome-tiff-tile-layout.md` §6 so nobody finds it and reads it as
    // INV-1 failing, and the reason it is not is asserted here rather than narrated there.
    //
    // Those specs drive a fit-to-viewport camera, so NEITHER run fetches a full-resolution tile
    // at all — the whole transaction is an open plus the COARSEST level (350x450). The tiled
    // file stores that level as ONE padded 512x512 tile; the stripped file as exactly 450 rows
    // in TWO strips (`RowsPerStrip = 249`).
    //
    // ── AND THE 196 IS A NET OF TWO EFFECTS, NOT "the pad" ────────────────────────────────
    // Measured by re-encoding the same level-2 pixels with the file's own codec settings, which
    // reproduce the committed byte counts exactly:
    //
    //     one padded 512x512 tile      13,442 B   (= the committed TileByteCounts)
    //     one UNPADDED stream          12,714 B   (neither file stores this; the reference)
    //     two strips, 249 + 201 rows   13,246 B   (= the committed StripByteCounts, 7,272+5,974)
    //
    // So the pad costs +728 and splitting one deflate stream into two costs +532, and 196 is
    // what is left. Saying "the 196 is the pad" names a real cause with a number 3.7x too small,
    // and an earlier cut of this comment, of the design's §6 and of the render spec said exactly
    // that. Both terms are stated here because the whole point of quoting this figure is that
    // someone will check it.
    //
    // What the layout buys HERE is one fewer request, and that is `RowsPerStrip` granularity
    // (249 < 450) rather than regional addressability — at a 350-wide level a full-width strip
    // and a 512 tile cover the same width, so INV-1 makes no prediction about this level at all.
    // INV-1 is a claim about a viewport tile at FULL resolution, which is what the assertions
    // above measure.
    const coarsest = async (file: string) => {
      const source = recordingSource(file)
      const { pyramid } = await loadOmeTiffPyramid(source)
      const open = { bytes: source.totalBytes(), reads: source.reads.length }
      await pyramid[pyramid.length - 1].getRaster({ selection: { c: 0 } })
      return {
        open,
        level: {
          bytes: source.totalBytes() - open.bytes,
          reads: source.reads.length - open.reads,
        },
      }
    }
    // Both opens, so BOTH rows of the design's decomposition table balance from assertions
    // rather than one row balancing and the other being narrated.
    const tiledRun = await coarsest(HIRES)
    const strippedRun = await coarsest(HIRES_STRIPPED)
    expect(tiledRun).toEqual({ open: { bytes: 5_508, reads: 5 }, level: { bytes: 13_442, reads: 1 } })
    expect(strippedRun).toEqual({
      open: { bytes: 5_508, reads: 5 },
      level: { bytes: 13_246, reads: 2 },
    })
  })

  it('#259 TEST-6 the tileSize override is LOAD-BEARING, not redundant with the file', async () => {
    // The interesting half of #259: with a 512-tiled file Viv's own derivation
    // `prevPowerOf2(min(TileWidth ?? width, TileLength ?? RowsPerStrip))` now yields 512 — the
    // same number `DEFAULT_OME_TIFF_LIMITS.tileSize` names — so the override LOOKS removable.
    //
    // It is not, and this is the case that decides it. The stripped control has
    // `RowsPerStrip = 62`, for which that derivation gives 32: a 1920x1080 full-resolution
    // viewport would be ~2040 deck tiles. The reader asks for 512 on BOTH files, because the
    // request size is a contract this module states and not a property of whatever file it was
    // handed. Delete the override and this assertion is the one that goes red.
    expect(DEFAULT_OME_TIFF_LIMITS.tileSize).toBe(512)
    for (const file of [HIRES, HIRES_STRIPPED]) {
      const { pyramid } = await loadOmeTiffPyramid(recordingSource(file))
      const tile = await pyramid[0].getTile({ x: 1, y: 2, selection: { c: 0 } })
      expect(tile.width).toBe(512)
      expect(tile.height).toBe(512)
    }
    // …and the derivation this override REPLACES really would have said 32 here, read out of
    // the control's own directory rather than asserted from memory.
    const [level0] = await levelDirectories(HIRES_STRIPPED)
    expect(level0.RowsPerStrip).toBe(62)
    // Both operands read out of the file, not typed here: `getTileWidth()` on a stripped TIFF
    // is `ImageWidth` and `getTileHeight()` is `RowsPerStrip`, which is the whole reason the
    // derivation collapses on this layout.
    expect(prevPowerOfTwo(Math.min(level0.ImageWidth!, level0.RowsPerStrip!))).toBe(32)
    // …and the OTHER arm of the answer, which is a third-party file tiled at an edge that is
    // not ours. `DEFAULT_OME_TIFF_LIMITS`'s doc quotes this number; an earlier cut quoted the
    // same 256 against a fixture that did not exist, so it is derived here rather than
    // transcribed a second time.
    const [tiledLevel0] = await levelDirectories(TILED)
    expect(tiledLevel0.TileWidth).toBe(256)
    expect(prevPowerOfTwo(Math.min(tiledLevel0.TileWidth!, tiledLevel0.TileLength!))).toBe(256)
  })

  it('#259 TEST-16 reads a TILED file identically — the layout the writer now emits everywhere', async () => {
    const { pyramid, tiled, interleaved } = await loadOmeTiffPyramid(recordingSource(TILED))
    expect(tiled).toBe(true)
    expect(interleaved).toBe(false)
    expect(pyramid).toHaveLength(2)
    const tile = await pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
    expect([tile.height, tile.width]).toEqual(ORACLE.tiled_level0_tile_x0_y0_shape)
    expect(sha256(tile.data)).toBe(ORACLE.tiled_level0_tile_x0_y0_512)
  })

})

// ── #259 TEST-1 ──────────────────────────────────────────────────────────────────────────

describe('#259 TEST-1 [acceptance] [invariant: INV-2] every emitted fixture is tiled at EVERY level', () => {
  it('reads the layout off each level of each writer-emitted fixture', async () => {
    // INV-2, verbatim from `docs/design/ome-tiff-tile-layout.md` §4: *"Both this and the pyramid
    // levels below it should be tiled consistently."*
    //
    // Read per LEVEL, not through `loadOmeTiffPyramid`'s `tiled` flag — that flag is level 0's
    // value alone, so a file tiled at level 0 and stripped below it (the drift `ome_writer.py`'s
    // own comment on `TILE` warns about, and the shape a one-call-site fix would produce) would
    // satisfy it while forcing a consumer to branch per level to read one image.
    // The level COUNT is asserted per fixture, not merely `>= 1`. `levelDirectories` always
    // pushes IFD 0 before walking `SubIFDs`, so `>= 1` cannot bind — and it was the only
    // level-count check in this file for `lowres` and `greyscale`, which meant a regression
    // that dropped `SubIFDs` from the greyscale emit would leave the test titled "tiled at
    // EVERY level" checking exactly one level and still passing.
    for (const [name, file, levels] of [
      ['hires', HIRES, 3],
      ['lowres', LOWRES, 1],
      ['greyscale', GREYSCALE, 2],
    ] as const) {
      const directories = await levelDirectories(file)
      expect(directories.length, `${name} level count`).toBe(levels)
      for (const [index, directory] of directories.entries()) {
        expect(directory.TileWidth, `${name} level ${index} TileWidth`).toBe(512)
        expect(directory.TileLength, `${name} level ${index} TileLength`).toBe(512)
        expect(directory.RowsPerStrip, `${name} level ${index} RowsPerStrip`).toBeUndefined()
        expect(tiledOfDirectory(directory), `${name} level ${index}`).toBe(true)
      }
    }
    // The control that keeps the loop above from being vacuous: the same walk over the stripped
    // artifact reports the opposite at every level. A `levelDirectories` that silently returned
    // an empty list, or a `TileWidth` the walk never actually read, would pass the loop and fail
    // here.
    const stripped = await levelDirectories(HIRES_STRIPPED)
    expect(stripped).toHaveLength(3)
    for (const directory of stripped) {
      expect(directory.TileWidth).toBeUndefined()
      expect(directory.RowsPerStrip).toBeGreaterThan(0)
    }

    // ── AND THE PREMISE OF THE WHOLE CONTROL, WHICH WAS A PARAGRAPH AND IS NOW A CHECK ─────
    // `docs/design/ome-tiff-tile-layout.md` §5 argues that a stripped control has to be kept
    // because the four OTHER stripped files in this directory are all shapes the reader REFUSES
    // — so without it no successful read would go through a stripped file at all. That is the
    // premise of the argument, and it was measured once and then written down. If any of the
    // four were regenerated tiled the argument would lose its premise with nothing red.
    for (const file of [NON_HALVING, MIXED_CODEC, MULTI_PLANE, PLANAR_RGB]) {
      // EVERY level, not just IFD 0 — two of these four have a level 1, and §5's sentence is
      // about the files. A level-0-only check would stay green on one of them regenerated
      // tiled below the base, which is the same per-level blindness #259 TEST-1's main loop
      // exists to avoid.
      for (const [index, directory] of (await levelDirectories(file)).entries()) {
        expect(tiledOfDirectory(directory), `${file} level ${index}`).toBe(false)
      }
      await expect(loadOmeTiffPyramid(recordingSource(file)), file).rejects.toThrow(
        OmeTiffLoadError,
      )
    }
  })
})

// ── TEST-16 ─────────────────────────────────────────────────────────────────────────────

describe('TEST-16 a file this loader cannot honour is REFUSED by name, never read partially', () => {
  it('REFUSES a PLANAR multi-sample file, by name', async () => {
    // `PlanarConfiguration = 2` puts each sample in its own plane. Viv's `isInterleaved` is
    // false for it, so without this refusal the source would advertise 3 channels and answer
    // every one of them with plane 0 — three times the reads, two thirds of them wrong, and
    // nothing said.
    const source = recordingSource(PLANAR_RGB)
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow(MultiPlaneImageUnsupportedError)
    await expect(loadOmeTiffPyramid(recordingSource(PLANAR_RGB))).rejects.toThrow(
      /PlanarConfiguration=2 with SamplesPerPixel=3/,
    )
  })

  it('REFUSES a pyramid whose LEVEL uses a codec it cannot read', async () => {
    // Level 0 is deflate and decodes fine; the reduced level is JPEG-2000. Checking only IFD 0
    // would let this open cleanly and then fail per tile from inside the render loop — the
    // exact failure the codec check exists to move forward to the open call.
    const source = recordingSource(MIXED_CODEC)
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow(UnsupportedImageCodecError)
    await expect(loadOmeTiffPyramid(recordingSource(MIXED_CODEC))).rejects.toThrow(/34712/)
  })

  it('REFUSES a file whose channels are separate planes, by name', async () => {
    // Two shapes, both of which would otherwise produce a source that ADVERTISES N channels
    // and returns channel 0's pixels for every one of them — right pixels, wrong meaning,
    // with nothing said. The multi-IFD case is the standard OME multichannel layout and is
    // what a raw vendor morphology file is.
    const source = recordingSource(MULTI_PLANE)
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow(MultiPlaneImageUnsupportedError)
    await expect(loadOmeTiffPyramid(recordingSource(MULTI_PLANE))).rejects.toThrow(
      /2 image plane\(s\)/,
    )
    await expect(loadOmeTiffPyramid(recordingSource(MULTI_PLANE))).rejects.toThrow(
      /top-level IFDs/,
    )
  })
})

// ── TEST-13 ──────────────────────────────────────────────────────────────────────────────

describe('TEST-13 a pyramid that does not halve is refused', () => {
  it('accepts the real artifact’s level sizes', () => {
    expect(() =>
      assertHalvingPyramid([
        { width: 1400, height: 1800 },
        { width: 700, height: 900 },
        { width: 350, height: 450 },
      ]),
    ).not.toThrow()
  })

  it('refuses a level that is not the previous one halved, naming which', () => {
    expect(() =>
      assertHalvingPyramid([
        { width: 1400, height: 1800 },
        { width: 900, height: 900 },
      ]),
    ).toThrow(NonHalvingPyramidError)
    expect(() =>
      assertHalvingPyramid([
        { width: 1400, height: 1800 },
        { width: 700, height: 900 },
        { width: 350, height: 400 },
      ]),
    ).toThrow(/level 2/)
  })

  it('the LOADER calls the guard — a real non-halving file is refused at open', async () => {
    // The guard's CALL SITE, not the exported function. Measured before this case existed:
    // commenting out `assertHalvingPyramid(sizes)` left the whole suite green, because the
    // only other halving assertion is over a fixture that halves by construction — a
    // property of the fixture, not of the loader.
    const source = recordingSource(NON_HALVING)
    await expect(loadOmeTiffPyramid(source)).rejects.toThrow(NonHalvingPyramidError)
    // …naming the offending level and both sizes, so the message is actionable
    await expect(loadOmeTiffPyramid(recordingSource(NON_HALVING))).rejects.toThrow(
      /level 1 is 450x600, but level 0 is 600x800, which halves to 300x400/,
    )
  })

  it('halves an odd dimension downwards', () => {
    expect(() =>
      assertHalvingPyramid([
        { width: 1401, height: 1801 },
        { width: 700, height: 900 },
      ]),
    ).not.toThrow()
  })
})

// ── TEST-14 ──────────────────────────────────────────────────────────────────────────────

describe('TEST-14 the TIFF reader is a DECLARED dependency', () => {
  it('declares geotiff directly, and adds exactly one dependency', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { name: string; dependencies: Record<string, string> }
    expect(manifest.name).toBe('@ziee/viz')
    // a real semver range, not merely "defined" — `toBeDefined()` passes for `''`
    expect(manifest.dependencies.geotiff).toMatch(/^[~^]?\d+\.\d+\.\d+/)
    // BASE.md's counting rule, made executable — but as a SET DIFFERENCE against the base,
    // so an unrelated dependency arriving through a clean merge names ITSELF in the failure
    // instead of moving a number nobody can attribute.
    const BASE_DEPENDENCIES = [
      '@deck.gl/aggregation-layers', '@deck.gl/core', '@deck.gl/extensions', '@deck.gl/layers',
      '@deck.gl/react', '@hms-dbmi/viv', '@luma.gl/core', '@luma.gl/engine',
      '@luma.gl/shadertools', '@luma.gl/webgl', '@math.gl/core', '@vivjs/types', '@ziee/dock',
      '@ziee/kit', 'd3-array', 'd3-polygon', 'd3-scale-chromatic', 'flatbush', 'jspdf',
      'lucide-react', 'react-resizable-panels', 'zustand',
    ]
    const added = Object.keys(manifest.dependencies).filter(name => !BASE_DEPENDENCIES.includes(name))
    expect(added).toEqual(['geotiff'])
    expect(BASE_DEPENDENCIES).toHaveLength(22)
  })
})

// ── TEST-15 — INV-6 ──────────────────────────────────────────────────────────────────────

describe('TEST-15 [acceptance] [invariant: INV-6] the loader imports no backend or storage', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('./omeTiffPyramid.ts', import.meta.url)), 'utf8')

  /** Every module specifier the file names, in EVERY form a module can name one. */
  const specifiersOf = (text: string): string[] => {
    const found: string[] = []
    for (const pattern of [
      /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g, // static import/export-from
      /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, // bare side-effect import
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // DYNAMIC import
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]) {
      for (const match of text.matchAll(pattern)) found.push(match[1])
    }
    return found
  }

  const allowed = (specifier: string): boolean =>
    specifier === 'geotiff' ||
    specifier === '@hms-dbmi/viv' ||
    specifier.startsWith('@vivjs/') ||
    specifier.startsWith('@deck.gl/') ||
    specifier.startsWith('@math.gl/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')

  it('the extractor MATCHES a leak in every form — proving it is not a no-op regex', () => {
    // The failure this rules out is the one the original version had: a scan that saw only
    // line-initial static `import`, so a dynamic `await import('@/core/workstore')` inside the
    // function — the most natural way this invariant would actually be broken — was invisible
    // and the acceptance test stayed green. Assembled at runtime so this file's own scan set
    // is unaffected by the strings.
    const q = String.fromCharCode(39)
    const spec = (name: string) => `${q}${name}${q}`
    const synthetic = [
      `import { fetchArtifactRange } from ${spec('@/core/workstore')}`,
      `export { readOpaque } from ${spec('@ziee/app/core/workstore')}`,
      `const m = await import(${spec('@/core/workstore/binaryClient')})`,
      `const r = require(${spec('react')})`,
      `import ${spec('@ziee/kit/side-effect')}`,
    ].join('\n')
    // as a SET: the scan runs one pattern per form, so the order is the patterns' order, not
    // the source's, and asserting a sequence would be asserting the scanner's internals.
    const leaked = [...new Set(specifiersOf(synthetic).filter(specifier => !allowed(specifier)))].sort()
    expect(leaked).toEqual([
      '@/core/workstore',
      '@/core/workstore/binaryClient',
      '@ziee/app/core/workstore',
      '@ziee/kit/side-effect',
      'react',
    ])
    // …and the negative control: a legitimate specifier is NOT flagged.
    expect(specifiersOf(`import { x } from ${spec('./imageMeta')}`).filter(y => !allowed(y))).toEqual([])
  })

  it('names only viz-core-legal specifiers', () => {
    const specifiers = specifiersOf(SOURCE)
    expect(specifiers.length).toBeGreaterThan(3) // non-vacuity: the scan found real imports
    expect(specifiers.filter(specifier => !allowed(specifier))).toEqual([])

    // the forbidden families named explicitly, so a future edit that adds one fails with a
    // legible cause rather than a silently widened allowlist
    for (const forbidden of ['@ziee/', '@/', 'core/workstore', 'api-client']) {
      expect(specifiers.some(specifier => specifier.includes(forbidden))).toBe(false)
    }
    expect(specifiers).not.toContain('react')
    // relative imports may not escape viz-core either
    expect(specifiers.filter(specifier => specifier.startsWith('../../'))).toEqual([])
  })

  it('the FOURTH dependency is geotiff and is named, so the rule and the allowlist agree', () => {
    // The sibling files in this directory say "depends ONLY on @deck.gl/core + @math.gl +
    // @hms-dbmi/viv". This file adds `geotiff`. That divergence is stated in its header rather
    // than quietly admitted by an allowlist, and this asserts the header really says so — a
    // widened allowlist with no explanation is how an invariant stops meaning anything.
    expect(specifiersOf(SOURCE)).toContain('geotiff')
    expect(SOURCE).toContain('THE viz-core DEPENDENCY RULE, RESTATED FOR THIS FILE')
    expect(SOURCE).toMatch(/pure FORMAT library/)
  })
})

// ── #259 TEST-13, TEST-14 ────────────────────────────────────────────────────────────────

describe('#259 TEST-14 the corpus DISCRIMINATES — substituting the pre-#227 bytes flips every tiling predicate', () => {
  it('every predicate that holds for the emitted artifact fails for the stripped one', async () => {
    // A fixture no fixture-consuming test can fail on is decoration, and this corpus WAS in that
    // state: before #259 the committed hires artifact was the stripped bytes, `tiled` was
    // asserted `false`, and swapping the two layouts reddened nothing. This is that swap, made
    // permanent and in-process — the one row of the mutation battery in this file's header that
    // needs no external process to reproduce, so it survives the merge that strips the record.
    //
    // ── WHY THE PREDICATES ARE OBJECTS AT ALL, stated accurately at the third attempt ─────
    // NOT for corroboration. The loop below runs each predicate in BOTH directions on BOTH
    // files, so a predicate stuck at `true` fails the negative leg and one stuck at `false`
    // fails the positive leg: this test is self-guarding and needs no second site.
    //
    // What the objects buy is that "the corpus discriminates" is stated over a NAMED, ENUMERABLE
    // set with a length assertion on it, so a predicate cannot be quietly dropped from the claim
    // — which is what an inline sequence of three `expect`s would allow.
    //
    // Two earlier cuts got this wrong in opposite directions. The first claimed all three
    // predicates were shared with TEST-1/TEST-2/TEST-4; only one was. The second added two
    // lines to make the claim true, and a mutation showed they could not fail independently of
    // the direct assertions beside them (gutting predicate 1 reddened ONLY this test). The
    // third site, in TEST-1, had the same property and is gone too. The claim now matches the
    // code rather than the code being bent to match the claim.
    expect(TILING_PREDICATES.length).toBeGreaterThanOrEqual(3)
    for (const predicate of TILING_PREDICATES) {
      expect(await predicate.holds(HIRES), `emitted: ${predicate.name}`).toBe(true)
      expect(await predicate.holds(HIRES_STRIPPED), `pre-#227: ${predicate.name}`).toBe(false)
    }
    // …and the two files really are the same image, so what flipped is the LAYOUT and not the
    // subject. Without this the loop above would also pass for two unrelated files.
    for (const file of [HIRES, HIRES_STRIPPED]) {
      const { pyramid } = await loadOmeTiffPyramid(recordingSource(file))
      const tile = await pyramid[0].getTile({ x: 1, y: 2, selection: { c: 0 } })
      expect(sha256(tile.data), file).toBe(ORACLE.hires_level0_tile_x1_y2_512)
    }
  })
})

describe('#259 TEST-13 the three EMITTED-IMAGE fixtures are what today’s writer emits', () => {
  it('runs the generator’s own staleness gate, and its oracle re-derivation, over the committed bytes', () => {
    // The gate that closes #259's own failure mode rather than only its instance. #259 happened
    // because #227 changed the producer and NOTHING regenerated or re-checked the corpus — the
    // fixtures are static bytes, so the drift was silent by construction. `--check` re-emits each
    // fixture through the SHIPPED `ome_writer.write_ome_tiff` and compares it, UUID-blanked,
    // against the committed file; `--oracle --check` re-derives every entry of
    // `pixel-oracle.json` from those bytes and reports any that moved. Running both from the
    // package's own suite is what makes the next producer change red HERE instead of a year later.
    //
    // Not gated on Python being present, deliberately: this package's `npm test` already runs
    // `scripts/check-viz-producer-magnitudes.mjs`, which EXECUTES the producer's Python harness,
    // so python3 + tifffile are a hard dependency of this suite already. A `skip` here would be a
    // vacuous pass on exactly the check that matters.
    //
    // WHAT IT COVERS, stated so the title is not read as more: the THREE `spatial-image-*`
    // fixtures `make-emitted-image-fixtures.py` owns. The ten `samples-per-pixel-*.ome.tif`
    // files are also built out of `ome_writer`'s `TILE`/`CODEC`/`_sample_layout`, by
    // `make-sample-count-fixtures.py`, and that generator has no `--check` mode — so a producer
    // change staleifies them with nothing red. That is #288's corpus and its own generator's
    // gap; it is named here rather than silently implied to be covered.
    const script = fileURLToPath(new URL('../../../scripts/make-emitted-image-fixtures.py', import.meta.url))
    for (const args of [['--check'], ['--oracle', '--check']]) {
      const run = spawnSync('python3', [script, ...args], { encoding: 'utf8' })
      expect(run.error, `spawning python3 ${args.join(' ')}`).toBeUndefined()
      expect(
        run.status,
        `python3 make-emitted-image-fixtures.py ${args.join(' ')} exited ${run.status}\n` +
          `${run.stdout}\n${run.stderr}`,
      ).toBe(0)
    }
  }, 120_000)
})


// ── #322 TEST-1..TEST-3 — the THIRD-PARTY stripped control ───────────────────────────────
//
// `docs/design/ome-tiff-tile-layout.md` §5's rationale is the reason a stripped file is kept in
// this corpus at all, and until #322 the corpus met one half of it. `HIRES_STRIPPED` is our own
// pre-#227 emit, so it answers "is the reader confined to its writer's CURRENT layout?" and
// cannot answer "does it survive a writer we do not control?". Every other stripped fixture here
// is refused at open (#259 TEST-1 asserts that per file, per level), so no successful read went
// through a stripped file this system did not write.
//
// MEASURED WHILE WRITING THESE TESTS, AND WORTH STATING BECAUSE IT IS WORSE THAN §5 IMPLIED:
// this directory's two "not written by this system" files are not written by a third-party
// WRITER either. `tiled-deflate.ome.tif` and `unsupported-jpeg2000.ome.tif` both carry
// `Software = tifffile.py` and a `Creator="tifffile.py …"` OME-XML stamp — the same library
// `ome_writer.py` writes through, at the same version, driven with different keywords. So before
// this fixture, EVERY committed `.ome.tif` in this corpus came off one writer. #322 TEST-2 is
// that measurement made permanent, over the directory rather than over a list.

describe('#322 TEST-1 [acceptance] [invariant: INV-322-1] a THIRD-PARTY stripped OME-TIFF is read successfully', () => {
  it('opens, reports it stripped, and decodes the same pixels our own writer stored tiled', async () => {
    // INV-322-1, verbatim from `docs/design/ome-tiff-tile-layout.md` §5: *"a reader that only
    // handles the layout its own writer emits is a reader that breaks on the first third-party
    // OME-TIFF."*
    //
    // ── WHY THE TAG IS `INV-322-1` AND NOT A BARE NUMBER ──────────────────────────────────
    // `INV-<n>` in this file is a PER-ISSUE namespace and the numbers are already triple-booked:
    // `TEST-4 [invariant: INV-5]` is #158's INV-5 (one non-Zarr file read by bounded ranges),
    // `#259 TEST-3 [invariant: INV-5]` is #259's, which is THIS sentence, and §4 of the design
    // enumerates its own INV-1..INV-4, of which INV-1 (the tiled-vs-stripped cost claim) is what
    // `#259 TEST-4` pins, several hundred lines up in this same file. A fourth bare number in one
    // file would be unreadable, so #322's ids carry their issue.
    //
    // ── IDENTITY FIRST, THEN NUMBERS DERIVED FROM IT ──────────────────────────────────────
    // Every quantity below is either read out of the file's own directory at run time or taken
    // from `pixel-oracle.json`, where `tifffile` derived it from these committed bytes. The one
    // literal is the byte length, and it is the ANCHOR: a digest assertion over a file that was
    // swapped underneath it is an assertion about nothing, which is why `jpeg2000_byte_length`
    // exists for the same purpose one describe block up.
    expect(readFileSync(THIRD_PARTY_STRIPPED).byteLength).toBe(
      ORACLE.third_party_stripped_byte_length,
    )

    const directories = await levelDirectories(THIRD_PARTY_STRIPPED)
    // ONE level, and that is legal on the reader's own terms — "a file with no `SubIFDs` is a
    // legal single-level pyramid". Asserted rather than implied because Pillow CANNOT write
    // SubIFDs, so this is a property of the writer, not an accident of this image's size.
    expect(directories).toHaveLength(1)
    const [level0] = directories
    // STRIPPED, read off the file: `RowsPerStrip` present and no tile tags anywhere.
    expect(level0.TileWidth).toBeUndefined()
    expect(level0.TileLength).toBeUndefined()
    expect(level0.RowsPerStrip).toBe(ORACLE.third_party_stripped_rows_per_strip)
    // …and the strip COUNT is DERIVED from this file's own two tags rather than transcribed, then
    // cross-checked against what a second, unrelated TIFF parser (`tifffile`, via the oracle) read
    // off the same tags. A count typed into a test is a count that outlives the file.
    const rowsPerStrip = level0.RowsPerStrip as number
    const samplesOf = async (file: string) => {
      const [directory] = await levelDirectories(file)
      const samples = directory.SamplesPerPixel
      expect(samples, `${file} SamplesPerPixel`).toBeGreaterThan(0)
      return samples as number
    }
    const strips = Math.ceil((level0.ImageLength as number) / rowsPerStrip)
    expect(level0.StripByteCounts).toHaveLength(strips)
    expect(strips).toBe(ORACLE.third_party_stripped_strip_count)
    // The FINAL STRIP IS SHORT — the case a `RowsPerStrip` that divides the height would hide,
    // and the reason the generator refuses to write one that does. Labelled for what it is: a
    // FIXTURE-INTEGRITY assertion over the committed bytes, which no mutation of the reader can
    // turn red. It earns its place by making the geometry claim above checkable rather than
    // remembered. (A `tileCost.reads < strips` line sat here too and is gone: both operands are
    // pinned to exact values three lines apart, so it could not fail independently of them.)
    expect(strips * rowsPerStrip).toBeGreaterThan(level0.ImageLength as number)

    // ── AND IT IS READ SUCCESSFULLY, which is the half the four refused fixtures cannot give ──
    const source = recordingSource(THIRD_PARTY_STRIPPED)
    const { pyramid, tiled, interleaved, meta } = await loadOmeTiffPyramid(source)
    expect(tiled).toBe(false)
    expect(interleaved).toBe(true)
    expect(pyramid).toHaveLength(1)
    expect(meta.dtype).toBe('Uint8')
    // the extent the source declares is the extent the FILE declares — not a remembered pair
    expect(sizeOf(pyramid[0])).toEqual({
      width: level0.ImageWidth,
      height: level0.ImageLength,
    })

    // ── THE PIXELS, AGAINST AN INDEPENDENT DECODER AND AGAINST OUR OWN WRITER ─────────────
    // `third_party_stripped_level0_raster` and `lowres_level0_raster` are computed by `tifffile`
    // from TWO DIFFERENT FILES in `make-emitted-image-fixtures.py --oracle`, so their equality is
    // a measurement of the corpus and not an alias — the same discipline #259 TEST-15 states for
    // the pre-#227 pair. That is what stops the loop below from being self-referential: the loop
    // compares this loader against itself across two files and would agree with itself while
    // reading both of them wrongly in the same way.
    // (This line compares two constants in a committed JSON file and exercises no reader code —
    // its liveness comes entirely from the separate `--oracle --check` leg that re-derives both
    // from the bytes, which `#259 TEST-13` runs. It is here because it states the corpus
    // property the loop below rests on, where a reader can see it.)
    expect(ORACLE.third_party_stripped_level0_raster).toBe(ORACLE.lowres_level0_raster)
    for (const [file, shapeKey] of [
      [THIRD_PARTY_STRIPPED, ORACLE.third_party_stripped_level0_raster_shape],
      [LOWRES, ORACLE.lowres_level0_raster_shape],
    ] as const) {
      // `filePyramid`, and NOT `levels`, and that is a real rule rather than taste — see the
      // note at the second alias below.
      const { pyramid: filePyramid } = await loadOmeTiffPyramid(recordingSource(file))
      const raster = await filePyramid[0].getRaster({ selection: { c: 0 } })
      // The FULL shape against the oracle's, sample count included — read off EACH FILE's own
      // `SamplesPerPixel`, and against EACH FILE's own oracle shape entry. An earlier cut typed
      // the `3` as a literal (comparing only two thirds of the shape); the cut after that
      // replaced it with the third-party file's value reused for both legs, which is the same
      // literal laundered through a variable, and left `lowres_level0_raster_shape` — an entry
      // the oracle derives and nothing read — unused.
      expect([raster.height, raster.width, await samplesOf(file)], file).toEqual(shapeKey)
      expect(sha256(raster.data), file).toBe(ORACLE.third_party_stripped_level0_raster)
    }
    // …and the two files really are different files, so the equality above is not trivial.
    expect(readFileSync(THIRD_PARTY_STRIPPED).byteLength).not.toBe(
      readFileSync(LOWRES).byteLength,
    )

    // ── THE FOREIGN GEOMETRY IS ADDRESSED, NOT MERELY DECODED ─────────────────────────────
    // A whole-raster digest would still pass for a reader that fetched the entire object and
    // sliced it in memory. A TILE is the thing this reader promises, and on this file that means
    // resolving a 512-row band to a run of 40-row strips the reader did not choose. Both the
    // count and the pixels are checked, and the count is derived from the file's own
    // `RowsPerStrip` — a band of `tileSize` rows starting at row 0 spans `ceil(512 / 40)` = 13 of
    // them, one short of the file's 14 because the last strip lies below the band.
    const tileCost = await tileReadCost(THIRD_PARTY_STRIPPED, 0, 0)
    expect(tileCost.reads).toBe(Math.ceil(DEFAULT_OME_TIFF_LIMITS.tileSize / rowsPerStrip))
    // The SAME tile out of our own writer's copy of the same image costs ONE read, because that
    // file is tiled — so the pair isolates the layout exactly as the `HIRES`/`HIRES_STRIPPED`
    // pair does, and this time across two WRITERS rather than across one writer's two eras.
    expect((await tileReadCost(LOWRES, 0, 0)).reads).toBe(1)
    // …and the tile that cost 13 reads is the same tile, pixel for pixel, as the one that cost 1.
    const tiles = await Promise.all(
      [THIRD_PARTY_STRIPPED, LOWRES].map(async file => {
        // ── WHY THIS ALIAS IS NOT `levels` ───────────────────────────────────────────
        // `src-app/ui/scripts/lint-positional-declaration.mjs` refuses `<field>[<int>]` for
        // the 22 field names that ARE the declaration layer, and `levels` is one of them —
        // it is in that guard's `STRUCTURE_COLLECTIONS`, naming the producer-declared
        // artifact `structure.levels`, a collection a CONTRIBUTOR authors in a manifest and
        // whose order the contract promises nothing about.
        //
        // What this binds is not that. It is `OmeTiffPyramid.pyramid`, a runtime
        // `PixelSource[]` this module builds from the FILE's own IFD 0 plus its `SubIFDs`,
        // and whose index 0 is a contract the module states and `TEST-2` pins: *"index 0 is
        // FULL resolution"*. Position is the meaning here, which is exactly the property a
        // declared collection lacks. The alias existed only to avoid shadowing the outer
        // `pyramid`, and borrowing a declared collection's NAME for it made correct code
        // read as a violation. Renaming is the fix; recording a baseline note would have put
        // a false claim ("this file indexes a declared collection") into a shared 151-entry
        // ledger. `pyramid[0]` itself is clean and is used throughout this file.
        const { pyramid: filePyramid } = await loadOmeTiffPyramid(recordingSource(file))
        return filePyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
      }),
    )
    // clipped to the image's own width and to the reader's own requested edge — read off the
    // file and off the module's contract, not typed here
    expect([tiles[0].width, tiles[0].height]).toEqual([
      level0.ImageWidth,
      DEFAULT_OME_TIFF_LIMITS.tileSize,
    ])
    expect(sha256(tiles[0].data)).toBe(sha256(tiles[1].data))
    // non-vacuity: a tile of all-zeros would satisfy every equality above.
    expect(tiles[0].data.some(value => value !== 0)).toBe(true)
  })
})

/**
 * THE PROVENANCE PREDICATES #322 TEST-2 flips, named once so the claim is over an ENUMERABLE set.
 *
 * Each is a marker THIS SYSTEM's writer leaves and a foreign writer need not. They are stated as
 * objects for the same reason `TILING_PREDICATES` is: "the corpus contains a file no writer of
 * ours produced" is then a claim over a named set with a length assertion on it, rather than an
 * inline sequence of `expect`s a later edit can quietly shorten. TEST-2 runs every one of them in
 * BOTH directions over EVERY committed `.ome.tif`, so a predicate stuck at either constant fails
 * one of the two legs and the set is self-guarding.
 *
 * ── WHAT THREE PREDICATES DO NOT BUY, STATED SO THE COUNT IS NOT READ AS CORROBORATION ────
 * #322 wrote this paragraph as *"they are near-perfectly correlated, so the effective strength is
 * the strongest single one rather than three independent measurements"*, and noted that only the
 * FIRST probes the TIFF WRITER — tag 305, which the writer itself stamps.
 *
 * ⚠️ **#346 MEASURED THE THIRD ONE AND IT IS NOT A PRODUCER STAMP AT ALL.** `urn:uuid:` is the
 * OME-TIFF specification's own way of writing a document identifier, not a `tifffile` signature,
 * and `bioformats-tubhiswt.ome.tif` — written by OME Bio-Formats, and the file this corpus has
 * precisely because nothing of ours authored its `<OME>` document — carries it. Measured over the
 * committed directory: 21 of the 22 `.ome.tif` here contain `urn:uuid:`, and the ONE that does
 * not is `third-party-stripped.ome.tif`, whose document our own generator hand-composed without
 * one. So that predicate never distinguished "written through `tifffile`" from "not"; it
 * distinguished "hand-authored OME-XML" from "OME-XML written by software that follows the spec".
 * #322's own note that *"a re-emit through `tifffile.TiffWriter` moves all three"* is true, and
 * was read as if the converse held — it does not.
 *
 * The fix is not to delete it. It is to stop stating the claim as an AND across three predicates
 * and give each its own expected set, which is what `absentFrom` below is: then a predicate that
 * discriminates one file says so, a predicate that discriminates two says so, and neither can
 * borrow the other's strength. The `Software` tag remains the only one that probes a WRITER, and
 * `#322 TEST-2` now asserts that separately over the whole foreign set.
 */
const PRODUCER_STAMPS: readonly {
  name: string
  /**
   * The committed `.ome.tif` files this stamp is ABSENT from — sorted, because it is compared
   * against a filtered `readdirSync`. Per-predicate rather than one shared list, for the reason
   * the block comment above gives: these three do not measure the same thing and an AND across
   * them silently promoted the weakest to the strength of the strongest.
   */
  absentFrom: readonly string[]
  /** `true` for a file carrying this stamp. */
  holds(file: string): Promise<boolean>
}[] = [
  {
    name: 'the TIFF Software tag names tifffile',
    // THE ONLY ONE THAT PROBES A WRITER: tag 305 is stamped by the code that lays the bytes
    // down. Absent from both foreign fixtures — Pillow writes no `Software` at all, and
    // Bio-Formats writes its own name there.
    absentFrom: ['bioformats-tubhiswt.ome.tif', 'third-party-stripped.ome.tif'],
    async holds(file) {
      const [level0] = await levelDirectories(file)
      return (level0.Software ?? '').includes('tifffile')
    },
  },
  {
    name: 'the OME-XML carries a Creator="tifffile…" stamp',
    // Scanned as BYTES, not as a decoded string. The description sits in a binary file beside
    // DEFLATE payloads, so decoding the whole file as text is both wasteful and locale-shaped;
    // `Buffer.includes` is exact and is what TEST-11 already uses on this corpus.
    absentFrom: ['bioformats-tubhiswt.ome.tif', 'third-party-stripped.ome.tif'],
    async holds(file) {
      return readFileSync(file).includes(Buffer.from('Creator="tifffile'))
    },
  },
  {
    name: 'the OME-XML carries a urn:uuid document identifier',
    // RENAMED from "the per-write urn:uuid stamp" — see the ⚠️ above. It is a spec convention,
    // so its expected set is ONE file: the only committed document nothing but our own generator
    // wrote. Kept, because it still fires on a real regression (a hand-swapped description in
    // `third-party-stripped.ome.tif`), and kept HONEST by having its own set: the day it is
    // deleted or inverted, this list's length assertion and its two-directional leg both say so.
    absentFrom: ['third-party-stripped.ome.tif'],
    async holds(file) {
      return readFileSync(file).includes(Buffer.from('urn:uuid:'))
    },
  },
]

/**
 * The committed `.ome.tif` files whose bytes were laid down by a writer outside `tifffile`.
 *
 * TWO entries since #346, and the list existing rather than the literal being inlined is what
 * made that a one-line change: #322 wrote *"when the REAL VENDOR file §5 still records as missing
 * lands, it is added here, in the same commit that adds it to the directory"*, and this is that
 * commit. Sorted, because the assertion compares it against a sorted `readdirSync`.
 *
 * The two are foreign in DIFFERENT ways and the difference is the whole of #346:
 * `third-party-stripped.ome.tif` is our raster and our hand-authored `<OME>` document laid out by
 * a writer we do not control, and `bioformats-tubhiswt.ome.tif` is upstream's bytes end to end —
 * including the `<OME>` document, which is the half a generator of ours could never supply.
 */
const FOREIGN_WRITER_FIXTURES: readonly string[] = [
  'bioformats-tubhiswt.ome.tif',
  'third-party-stripped.ome.tif',
]

describe('#322 TEST-2 [acceptance] [invariant: INV-322-2] the fixture is from a writer we do not control', () => {
  it('flips every producer stamp, and only the known-foreign fixtures do', async () => {
    // INV-322-2, verbatim from `docs/design/ome-tiff-tile-layout.md` §5: *"The invariant is about
    // **a writer we do not control**, not about someone else's copyrighted pixels."*
    //
    // This is the test that makes #322 mean something a year from now. The cheapest way to lose
    // the invariant is not to delete the fixture — it is to REGENERATE it through
    // `ome_writer.py`, which would leave a stripped-looking file in place, every pixel assertion
    // above green, and the corpus back to sampling one writer. Every predicate below goes red on
    // exactly that edit.
    //
    // Stated over the DIRECTORY rather than over a hand-kept list of files to CHECK, so a fixture
    // added later cannot sit outside the claim: every `.ome.tif` in here is measured.
    //
    // The EXPECTED result is a named list, and that is deliberate rather than an oversight an
    // earlier cut of this comment turned into a false promise ("a second file added later without
    // this provenance joins the claim automatically" — it does not; it fails the assertion). The
    // whole content of #322 is that this corpus contains a NAMED set of files from a writer
    // outside `tifffile`, so "which files are foreign" is the claim, and a claim has to be
    // written down. The maintenance that buys is one line, and #346 paid exactly that line: it
    // landed the real foreign-authored document #322 recorded as missing, and adding it here
    // beside `third-party-stripped.ome.tif` is the whole of what this block needed.
    const corpus = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.ome.tif'))
      .sort()
    // A liveness floor just under the real population (22 since #346; 21 when #322 set this), so
    // an empty or mis-rooted `readdirSync` cannot report "every file passes" over nothing. Not a
    // round number the directory would still clear after losing half of itself, and deliberately
    // NOT raised in step with the population: a floor pinned AT the population reddens a
    // provenance tripwire on any legitimate deletion, for a reason that has nothing to do with
    // provenance.
    expect(corpus.length).toBeGreaterThanOrEqual(20)
    expect(corpus).toContain('third-party-stripped.ome.tif')
    expect(corpus).toContain('bioformats-tubhiswt.ome.tif')

    expect(PRODUCER_STAMPS.length).toBeGreaterThanOrEqual(3)
    // Non-vacuity on the expected set itself: an emptied `FOREIGN_WRITER_FIXTURES` would turn
    // every leg below into "no file in this corpus is foreign", which is the pre-#322 state and
    // must not be reachable by deleting a line.
    expect(FOREIGN_WRITER_FIXTURES.length).toBeGreaterThan(0)
    // …and the list's own two invariants, so a failure says what is wrong instead of printing an
    // opaque array diff: it is SORTED (the comparison is against a sorted `readdirSync`) and every
    // member is really in the directory. The sort check is labelled, because without a label its
    // failure IS the opaque array diff it exists to replace. (#322 recorded it as "honestly
    // unfalsifiable at one entry"; at two it is falsifiable, and this is the commit that made it
    // so — `bioformats-…` sorts before `third-party-…`, which is not the order they were added.)
    expect(
      [...FOREIGN_WRITER_FIXTURES].sort(),
      `FOREIGN_WRITER_FIXTURES must be sorted (it is compared against a sorted readdirSync): ${FOREIGN_WRITER_FIXTURES.join(', ')}`,
    ).toEqual([...FOREIGN_WRITER_FIXTURES])
    for (const name of FOREIGN_WRITER_FIXTURES) expect(corpus, name).toContain(name)
    for (const predicate of PRODUCER_STAMPS) {
      const flipped: string[] = []
      for (const name of corpus) {
        if (!(await predicate.holds(`${FIXTURES}${name}`))) flipped.push(name)
      }
      // BOTH directions in one assertion: the files lacking the stamp are EXACTLY the ones that
      // predicate claims to discriminate. A predicate stuck at `true` yields `[]` and fails; one
      // stuck at `false` yields all 22.
      //
      // AGAINST ITS OWN `absentFrom` AND NOT AGAINST `FOREIGN_WRITER_FIXTURES` (#346). That was
      // one shared list until `bioformats-tubhiswt.ome.tif` landed and the third predicate held
      // on it — because `urn:uuid:` is the OME-TIFF spec's document identifier and Bio-Formats
      // writes one, so that predicate had never been measuring a writer. Rather than drop it or
      // exempt the file, each predicate now states the set it really discriminates, and the
      // sanity legs below stop the three sets from drifting apart into meaninglessness.
      expect(flipped, predicate.name).toEqual(predicate.absentFrom)
    }
    // ── AND THE SETS ARE STILL TIED TO THE FOREIGN LIST, or the block above says nothing ──
    // With per-predicate sets, "every predicate passes" is satisfiable by three predicates that
    // discriminate nothing anyone cares about. These two legs are what keep it about provenance:
    //
    //  1. the WRITER-probing predicate — the `Software` tag, the only one of the three that the
    //     code laying the bytes down actually stamps — must be absent from EVERY foreign fixture
    //     and from no other file. That is the claim #322 was really making, stated over the one
    //     predicate that can carry it instead of spread across three that cannot.
    //  2. every predicate's set must be a SUBSET of the foreign list, so no predicate can start
    //     "discriminating" one of our own emits and stay green.
    const writerStamp = PRODUCER_STAMPS[0]
    expect(writerStamp.name).toContain('Software')
    expect([...writerStamp.absentFrom].sort()).toEqual([...FOREIGN_WRITER_FIXTURES])
    for (const predicate of PRODUCER_STAMPS) {
      expect(
        predicate.absentFrom.filter(name => !FOREIGN_WRITER_FIXTURES.includes(name)),
        `${predicate.name}: absentFrom must not name a file outside FOREIGN_WRITER_FIXTURES`,
      ).toEqual([])
      expect(predicate.absentFrom.length, predicate.name).toBeGreaterThan(0)
    }

    // ── AND IT IS AN OME-TIFF, not merely a TIFF ─────────────────────────────────────────
    // The corpus is a corpus of OME-TIFFs and this file is named like one, so the claim is
    // checked rather than assumed. Pillow will not author OME-XML, so the document is
    // hand-authored and handed to Pillow as tag 270 — which is exactly why the next three
    // assertions matter more than usual: they are the ones that would catch the description
    // being empty, being some other writer's, or being ours.
    const bytes = readFileSync(THIRD_PARTY_STRIPPED)
    for (const marker of [
      '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"',
      '<Pixels ',
      '</OME>',
    ]) {
      expect(bytes.includes(Buffer.from(marker)), marker).toBe(true)
    }
    // It NAMES its writer, so the artifact carries a provenance note even separated from
    // `fixtures/README.md` and from the generator. Stated for exactly what it is: this string is
    // in the HAND-AUTHORED OME-XML our own generator composes, so it is a self-attestation, not a
    // measurement of who wrote the file. The measurement is `PRODUCER_STAMPS[0]` (the `Software`
    // tag, which the writer itself stamps) and the tag-set assertion below.
    expect(bytes.includes(Buffer.from('Creator="Pillow '))).toBe(true)
    // ── THE TAG SET ITSELF, ASSERTED HERE AND NOT ONLY IN THE GENERATOR ──────────────────
    // The eleven-tag layout, the missing `Software`, and `Compression = 8` are what make this
    // file's layout foreign, and until this block the ONLY thing enforcing them was the Python
    // generator's `EXPECTED_TAGS`, reached through `#322 TEST-3`'s exit status. That is a real
    // hole rather than a stylistic one: on a machine whose Pillow or libtiff differs, TEST-3 goes
    // red for a VERSION reason and takes the tag-layout check down with it, so the property this
    // fixture exists for would be unguarded exactly when the artifact is most likely to have
    // moved. Read through geotiff — the same parser the reader uses — and compared against our
    // own writer's set, so both sides are measured rather than remembered.
    //
    // Its one honest limit: geotiff names a tag only if it is in its own dictionary, and an
    // unknown code lands under the literal key `undefined` (two unknowns collapse into one). So
    // this measures "the tags geotiff recognises", not "the tags in the IFD". It is exact SET
    // EQUALITY, so it still fails closed on any surprise — and the generator's `EXPECTED_TAGS`,
    // read through `tifffile`, covers the codes geotiff would not name.
    const tagsOf = async (file: string) =>
      Object.keys((await levelDirectories(file))[0] as Record<string, unknown>).sort()
    const foreignTags = await tagsOf(THIRD_PARTY_STRIPPED)
    expect(foreignTags).toEqual([
      'BitsPerSample',
      'Compression',
      'ImageDescription',
      'ImageLength',
      'ImageWidth',
      'PhotometricInterpretation',
      'PlanarConfiguration',
      'RowsPerStrip',
      'SamplesPerPixel',
      'StripByteCounts',
      'StripOffsets',
    ])
    // Adobe Deflate (8), NOT the 32946 our writer emits — and this is the first committed file in
    // the corpus that exercises that arm of `DECODABLE_COMPRESSION` with real bytes rather than
    // with a literal. Both codec numbers read off their files.
    const compressionOf = async (file: string) =>
      (await levelDirectories(file))[0].Compression
    expect(await compressionOf(THIRD_PARTY_STRIPPED)).toBe(8)
    expect(await compressionOf(HIRES)).toBe(32946)
    // The whole set-difference, derived by subtraction rather than transcribed. NINE names, not
    // the four the provenance prose highlights: `Software`, `XResolution`, `YResolution` and
    // `ResolutionUnit` are the ones our writer stamps on EVERY file it emits, while the other
    // five (`SubIFDs` and the four `Tile*`) are properties of THIS artifact being tiled and
    // multi-level — `spatial-image-lowres.ome.tif`, also ours, has no `SubIFDs` either. The
    // assertion is over the full nine because it is a measurement of two specific files; the
    // four are what the claim about the WRITER rests on.
    const oursTags = await tagsOf(HIRES)
    expect(oursTags.filter(tag => !foreignTags.includes(tag)).sort()).toEqual([
      'ResolutionUnit',
      'Software',
      'SubIFDs',
      'TileByteCounts',
      'TileLength',
      'TileOffsets',
      'TileWidth',
      'XResolution',
      'YResolution',
    ])
    // …and NEITHER carries `SampleFormat`, which is why its absence is not on the provenance list
    // above. Asserted rather than merely noted, because an earlier cut of this feature used that
    // absence as a foreignness marker and was wrong.
    expect(foreignTags).not.toContain('SampleFormat')
    expect(oursTags).not.toContain('SampleFormat')

    // …and it carries none of the payload our own producer puts in an emitted image.
    expect(bytes.includes(Buffer.from('cyto-spatial/1'))).toBe(false)
    // The `cyto-spatial/1` control, so the line above is discriminating rather than true of any
    // file: our own emitted images DO carry it.
    expect(readFileSync(HIRES).includes(Buffer.from('cyto-spatial/1'))).toBe(true)
  })
})

describe('#322 TEST-3 [acceptance] [invariant: INV-322-3] the third-party fixture is a re-run, not archaeology', () => {
  it('runs the committed generator’s own reproducibility and staleness gate', () => {
    // INV-322-3, verbatim from `fixtures/README.md`: *"`scripts/make-emitted-image-fixtures.py`
    // is how, and it is a permanent committed path precisely so this is a re-run and not
    // archaeology."* This one is this DIRECTORY's rule rather than a `ome-tiff-tile-layout.md`
    // invariant, which is a second reason the tag is not a bare number. That rule is the directory's, not one generator's, and a binary committed
    // without it is the state #259 found the jpeg2000 fixture in — its recipe filed as LOST with
    // a stripped `.lifecycle/` file.
    //
    // `--check` emits twice into a temp dir (deterministic in one environment: there is no
    // `urn:uuid` to blank here, because the writer is not `tifffile`) and then compares a fresh
    // emit against the COMMITTED bytes, which is the staleness half and the one that matters. It
    // also re-asserts, inside the generator, every header the fixture is committed for — the tag
    // set, the absence of tile tags, `RowsPerStrip`, the short final strip, and the raster
    // surviving the round trip — and REFUSES to leave a file behind that fails any of them.
    //
    // Not gated on Python being present, for the reason #259 TEST-13 states one block up: this
    // package's `npm test` already executes a Python harness, so `python3` is a hard dependency
    // of this suite and a skip here would be a vacuous pass on the check that matters.
    const script = fileURLToPath(
      new URL('../../../scripts/make-third-party-stripped-fixture.py', import.meta.url),
    )
    const run = spawnSync('python3', [script, '--check'], { encoding: 'utf8' })
    expect(run.error, 'spawning python3 --check').toBeUndefined()
    expect(
      run.status,
      `python3 make-third-party-stripped-fixture.py --check exited ${run.status}\n` +
        `${run.stdout}\n${run.stderr}`,
    ).toBe(0)
  }, 120_000)
})

// ── #346 TEST-1..TEST-3 — the FOREIGN-AUTHORED OME-XML fixture ───────────────────────────
//
// #322 split into two halves and closed the writer one. Its own notes say what it left, in the
// design doc, in the reader's header and in `fixtures/README.md`: `loadOmeTiffPyramid` never
// parses OME-XML, Pillow will not author OME-XML, so the `<OME>` document in
// `third-party-stripped.ome.tif` is OUR generator's hand-written string handed to Pillow as tag
// 270 — and no committed file carried a document composed outside this project.
//
// `bioformats-tubhiswt.ome.tif` does. See the constant's own block comment for the provenance,
// the licence and the limit. What the three tests below are FOR, in one line each:
//
//   TEST-1  it is READ SUCCESSFULLY, at a codec and a strip geometry no writer of ours emits,
//           and the pixels match an independent decoder's digest of the same bytes.
//   TEST-2  the document is foreign, MEASURED over the directory rather than over a list — and
//           the reader answers the CONTAINER where the two disagree.
//   TEST-3  the committed provenance script's own identity-and-headers gate, so the file's
//           origin is a re-runnable check and not a paragraph.
//
// ── WHY A FOURTH REFUSED FIXTURE WOULD HAVE BEEN WORTHLESS ────────────────────────────────
// Four files here are shapes the reader refuses at open (#259 TEST-1 asserts that per file, per
// level). The reader accepts a narrow shape and most real OME-TIFFs miss it — a multichannel
// acquisition stores its channels as separate TOP-LEVEL IFDs, which `MultiPlaneImageUnsupportedError`
// refuses by name. So "find a foreign OME-TIFF" and "find one this reader reads" are different
// searches, and this file was chosen for the second: one IFD, `SamplesPerPixel = 1`, a codec on
// the allowlist. That is also why its document is interesting — it is ONE FILE OF A MULTI-FILE
// SET, so the document describes two channels across two files while the container holds one
// plane, which is a divergence no round trip of ours can produce.

// ── THE CORPUS DISCRIMINATES, SHOWN BY MUTATION AND NOT CLAIMED ──────────────────────────
// A fixture no fixture-consuming test can fail on is decoration, and #259 found this corpus in
// exactly that state once. The battery is INLINE here for the reason the header block gives:
// `.lifecycle/` is stripped at merge, and a shipped file citing a stripped path is the defect
// #259 was filed about. Measured on this branch, over `omeTiffPyramid.test.ts` (46) and
// `staleClaims.test.ts` (17); the tree was restored clean and re-verified green afterwards.
//
//   mutation                                                    tests reddened
//   ──────────────────────────────────────────────────────────  ───────────────────────────────
//   (none — baseline)                                           0
//   `DECODABLE_COMPRESSION` loses `[1, 'none']`                 3   #346 TEST-1, TEST-2, and
//                                                                   TEST-7 (which had been the
//                                                                   ONLY thing covering that arm,
//                                                                   and covers it with a literal)
//   the fixture re-emitted through `tifffile.TiffWriter` —      5   #346 TEST-1..TEST-3,
//   same pixels, same document text, same `RowsPerStrip = 1`        #322 TEST-2, #259 TEST-13
//   the fixture deleted from the directory                      6   the five above + #259 TEST-7
//                                                                   (its record names a file that
//                                                                   is no longer on disk)
//   `#322 TEST-2` reverted to the pre-#346 shared expectation   1   #322 TEST-2 — on the
//   (`toEqual(FOREIGN_WRITER_FIXTURES)` for every predicate)        `urn:uuid:` predicate exactly,
//                                                                   which is the measurement that
//                                                                   forced the restructure
//   the READER bakes in "no file carries `SampleFormat`"        2   #346 TEST-1, TEST-2 — AND
//   (`assertUniformSampleFormat` refuses tag 339)                   NOTHING ELSE
//
// THE ROWS THAT CARRY THE ARGUMENT are the last two.
//
// The `SampleFormat` row is the sharpest thing this fixture buys. Tag 339 was absent from all 21
// files that existed before it — #322 measured that and wrote it down — so a reader that REFUSED
// the tag outright passed the entire suite. It now reddens, and only these two tests see it. That
// is the literal shape of INV-5's rationale: a reader confined to the shapes its own writer emits.
//
// The `#322 TEST-2` row is a mutation of a TEST rather than of production code, which is unusual
// and is deliberate. It is the evidence that restructuring that block was forced by a measurement
// and is not a convenience: with the old shared expectation, the corpus containing one more
// foreign-but-spec-conformant document makes the assertion false, because `urn:uuid:` was never
// a `tifffile` signature.
//
// AND ONE MEASUREMENT WORTH RECORDING THAT IS NOT A ROW. The first attempt at the re-emit
// mutation FAILED TO WRITE AT ALL: `tifffile` refuses a non-ASCII TIFF string, and this document
// carries `WorkingDistanceUnit="µm"`. So the most likely regression — regenerating this fixture
// through the library our own writer writes through — cannot even preserve the document, quite
// apart from the five tests that catch it. The row above is the mutation run a second time with
// that one character replaced, so the battery measures the tests rather than the encoder.

describe('#346 TEST-1 [acceptance] [invariant: INV-346-1] an OME-TIFF nothing of ours authored is read successfully', () => {
  it('opens it uncompressed at one row per strip, and decodes the pixels an independent decoder digests', async () => {
    // INV-346-1, verbatim from `docs/design/ome-tiff-tile-layout.md` §5 — the SAME sentence
    // #322's INV-322-1 cites, because this is the other half of one rationale: *"a reader that
    // only handles the layout its own writer emits is a reader that breaks on the first
    // third-party OME-TIFF."*
    //
    // ── IDENTITY FIRST, AND FOR THIS FILE THAT MEANS A DIGEST ────────────────────────────
    // #322's fixture is REGENERATED by a committed script, so its recipe is its identity and a
    // byte length is anchor enough beside it. This one is DOWNLOADED and committed verbatim:
    // there is nothing to re-derive it from, its identity IS its bytes, and the swap the anchor
    // has to refuse is a same-length substitution — a re-encode, or the sibling plane of the very
    // set this file comes from, which is 269,568 bytes as well. So both, before anything else.
    const bytes = readFileSync(VENDOR_OME_XML)
    expect(bytes.byteLength).toBe(ORACLE.vendor_ome_xml_byte_length)
    expect(sha256(bytes)).toBe(ORACLE.vendor_ome_xml_sha256)

    const directories = await levelDirectories(VENDOR_OME_XML)
    // ONE level, and legal on the reader's own terms — "a file with no `SubIFDs` is a legal
    // single-level pyramid". Upstream wrote no pyramid into this plane; the SubIFD walk over a
    // stripped layout stays `#259 TEST-3`'s job on `spatial-image-hires-stripped.ome.tif`.
    expect(directories).toHaveLength(1)
    const [level0] = directories

    // ── THE CODEC ARM NO COMMITTED BYTE REACHED BEFORE ──────────────────────────────────
    // `Compression = 1` is `none`. It has been in `DECODABLE_COMPRESSION` since #158 and until
    // this file every committed fixture was DEFLATE (32946), Adobe Deflate (8) or the refused
    // JPEG-2000 (34712) — so that arm was covered by a literal in a unit test and by no real
    // bytes at all. The claim is stated over the DIRECTORY so it cannot rot into a list: this is
    // the only uncompressed `.ome.tif` here, and if a second one lands this line says so.
    expect(level0.Compression).toBe(1)
    const corpus = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.ome.tif'))
      .sort()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
    const uncompressed: string[] = []
    for (const name of corpus) {
      if ((await levelDirectories(`${FIXTURES}${name}`))[0].Compression === 1) {
        uncompressed.push(name)
      }
    }
    expect(uncompressed).toEqual(['bioformats-tubhiswt.ome.tif'])

    // ── THE STRIP GEOMETRY, DERIVED FROM THE FILE'S OWN TAGS ────────────────────────────
    // One row per strip, which is the extreme end of the layout `docs/design/ome-tiff-tile-layout.md`
    // §5 keeps a fixture for. Every number is read off the file or cross-checked against the
    // oracle, where `tifffile` — a second, unrelated TIFF parser — read the same two tags.
    expect(level0.TileWidth).toBeUndefined()
    expect(level0.TileLength).toBeUndefined()
    expect(level0.RowsPerStrip).toBe(ORACLE.vendor_ome_xml_rows_per_strip)
    const rowsPerStrip = level0.RowsPerStrip as number
    expect(rowsPerStrip).toBe(1)
    const strips = Math.ceil((level0.ImageLength as number) / rowsPerStrip)
    expect(level0.StripByteCounts).toHaveLength(strips)
    expect(strips).toBe(ORACLE.vendor_ome_xml_strip_count)
    // …and it is a geometry none of the other three stripped-and-readable files in this corpus
    // has, derived from each of their own tags rather than transcribed from their prose (62, 40).
    const otherStrippedRows = await Promise.all(
      [HIRES_STRIPPED, THIRD_PARTY_STRIPPED].map(async file =>
        (await levelDirectories(file))[0].RowsPerStrip,
      ),
    )
    expect(otherStrippedRows).not.toContain(rowsPerStrip)

    // ── THE `SampleFormat` TAG, WHICH NO OTHER FILE HERE CARRIES ────────────────────────
    // Stated over the directory for the same reason the codec claim is, and it RETIRES a
    // measured note #322 left in `levelDirectories` above: *"tag 339 is absent from EVERY fixture
    // in this corpus"*. True then, false now. It matters because `assertUniformSampleFormat` has
    // a whole arm for that tag — the length of it must equal `SamplesPerPixel` — and until this
    // file that arm ran only against hand-built directories.
    expect(level0.SampleFormat).toBeDefined()
    expect(Array.from(level0.SampleFormat as ArrayLike<number>)).toEqual([1])
    const withSampleFormat: string[] = []
    for (const name of corpus) {
      if ((await levelDirectories(`${FIXTURES}${name}`))[0].SampleFormat !== undefined) {
        withSampleFormat.push(name)
      }
    }
    expect(withSampleFormat).toEqual(['bioformats-tubhiswt.ome.tif'])
    // …and it is the file's own `SamplesPerPixel` that the tag's length must match, which is the
    // condition `assertUniformSampleFormat` enforces. Read off the file, both sides.
    expect((level0.SampleFormat as ArrayLike<number>).length).toBe(level0.SamplesPerPixel)
    expect((level0.BitsPerSample as ArrayLike<number>).length).toBe(level0.SamplesPerPixel)

    // ── AND IT IS READ SUCCESSFULLY ─────────────────────────────────────────────────────
    const source = recordingSource(VENDOR_OME_XML)
    const { pyramid, tiled, interleaved, meta } = await loadOmeTiffPyramid(source)
    expect(tiled).toBe(false)
    // NOT interleaved, unlike #322's RGB fixture — one sample per pixel, so the corpus's foreign
    // set now covers both arms of `isInterleaved` rather than only the three-sample one.
    expect(interleaved).toBe(false)
    expect(pyramid).toHaveLength(1)
    expect(meta.dtype).toBe('Uint8')
    expect(sizeOf(pyramid[0])).toEqual({
      width: level0.ImageWidth,
      height: level0.ImageLength,
    })

    // ── THE PIXELS, AGAINST AN INDEPENDENT DECODER ──────────────────────────────────────
    // `vendor_ome_xml_level0_raster` is `tifffile`'s digest of THIS FILE's single IFD, derived in
    // `make-emitted-image-fixtures.py --oracle` and re-derived by `#259 TEST-13`'s `--check`
    // leg. It is the only thing here that can tell "the loader decoded the right pixels" from
    // "the loader decoded pixels self-consistently" — there is no same-image-twice pair for this
    // file the way #322 has one, because these bytes exist nowhere else in the corpus.
    //
    // NOTE the oracle digests the PAGE and not the OME series, and that is this fixture's own
    // subject seen from the other side: `tifffile.imread` PARSES the `<OME>` document, follows
    // its `<TiffData>` to `tubhiswt_C1.ome.tif`, does not find it here, and returns a
    // `(2, 512, 512)` array with the second plane zeroed. An OME-XML-aware decoder answers the
    // DOCUMENT; this reader answers the CONTAINER. TEST-2 pins that divergence directly.
    const raster = await pyramid[0].getRaster({ selection: { c: 0 } })
    expect([raster.height, raster.width]).toEqual(ORACLE.vendor_ome_xml_level0_raster_shape)
    expect(sha256(raster.data)).toBe(ORACLE.vendor_ome_xml_level0_raster)
    // non-vacuity: an all-zero raster would satisfy a shape assertion and, on the wrong oracle,
    // a digest one — this file's `(2, 512, 512)` series digest is a HALF-ZERO array.
    expect(raster.data.some(value => value !== 0)).toBe(true)

    // ── THE FOREIGN GEOMETRY IS ADDRESSED, NOT MERELY DECODED ───────────────────────────
    // A whole-raster digest would still pass for a reader that fetched the object and sliced it
    // in memory. A TILE is what this reader promises, and on this file the promise is expensive:
    // a 512-row band at one row per strip is 512 separate spans the reader did not choose. The
    // count is DERIVED from the file's own `RowsPerStrip`, and it is the corpus's worst case by
    // a wide margin — 13 for #322's fixture, 1 for our own tiled emit.
    const tileCost = await tileReadCost(VENDOR_OME_XML, 0, 0)
    expect(tileCost.reads).toBe(Math.ceil(DEFAULT_OME_TIFF_LIMITS.tileSize / rowsPerStrip))
    expect(tileCost.reads).toBeGreaterThan((await tileReadCost(THIRD_PARTY_STRIPPED, 0, 0)).reads)
    expect((await tileReadCost(LOWRES, 0, 0)).reads).toBe(1)
    // …and the tile that cost 512 reads is the WHOLE image, because the image is exactly one
    // tile edge square — so the tile digest can be checked against the independent oracle
    // DIRECTLY, which #322's fixture could not do (its 420 px width makes every 512-edge tile
    // overhang, and the oracle's helper zero-pads an overhang while the reader clips it).
    const tile = await pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
    expect([tile.width, tile.height]).toEqual([level0.ImageWidth, level0.ImageLength])
    expect([tile.width, tile.height]).toEqual([
      DEFAULT_OME_TIFF_LIMITS.tileSize,
      DEFAULT_OME_TIFF_LIMITS.tileSize,
    ])
    expect(sha256(tile.data)).toBe(ORACLE.vendor_ome_xml_level0_raster)
  })
})

describe('#346 TEST-2 [acceptance] [invariant: INV-346-2] the OME-XML is a document this project did not author', () => {
  it('carries author markers no other fixture has, and the reader answers the container where they disagree', async () => {
    // INV-346-2, verbatim from `#346`: *"`loadOmeTiffPyramid` **never parses OME-XML at all**, so
    // nothing in the corpus says anything about a vendor's `<OME>` document — its namespace, its
    // `TiffData` ordering, its `Plane`/`Channel` shapes, or the extensions real instruments
    // emit."* That sentence describes the corpus, not the reader, and this is the test that makes
    // it false about the corpus while leaving it true about the reader.
    //
    // ── WHAT THIS TEST CANNOT BE, SAID BEFORE IT IS READ AS MORE ────────────────────────
    // There is no OME-XML parser in this module, so nothing below exercises one. Two things are
    // checkable without one and both are done: that the DOCUMENT is foreign, measured over the
    // directory; and that where the document and the container DISAGREE, the reader answers the
    // container — which is the property that would break first if an XML path were wired in
    // carelessly, and the reason a foreign document is worth having in the corpus before there
    // is any code to read it.
    const bytes = readFileSync(VENDOR_OME_XML)
    const corpus = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.ome.tif'))
      .sort()
    expect(corpus.length).toBeGreaterThanOrEqual(20)

    // ── THE MARKERS, EACH MEASURED OVER THE WHOLE DIRECTORY, BOTH DIRECTIONS ────────────
    // Scanned as BYTES for the reason `PRODUCER_STAMPS` gives: the document sits in a binary file
    // beside raw strip payloads. Every entry is a construct our producer has no call site for —
    // `ome_writer.py` emits a `<Pixels>`, a `<Channel>` and a description payload and nothing
    // else — so each is simultaneously "present here" and "absent from all 21 others", and the
    // assertion says both at once. A marker that started appearing elsewhere would fail just as
    // loudly as one that vanished from here.
    const FOREIGN_DOCUMENT_MARKERS = [
      // WHO wrote it. The one marker that names the authoring software rather than a shape.
      'Creator="OME Bio-Formats 5.2.0-m4"',
      // A REAL INSTRUMENT, described in the document. Nothing of ours writes an `<Instrument>`
      // block at all, so these are the "extensions real instruments emit" #346 names.
      '<Instrument ',
      '<Microscope Manufacturer="Nikon" Model="Eclipse TE300"',
      '<Detector ',
      '<Objective ',
      '<Experimenter ',
      // THE DIMENSION MODEL. Our writer emits neither a `<Plane>` nor a `DimensionOrder` — it has
      // one plane per file and says so by omission.
      'DimensionOrder="XYZTC"',
      '<Plane ',
      // THE `TiffData` ORDERING #346 names by name, in its multi-file form: a `<UUID FileName=…>`
      // child pointing at a file that is NOT this one. The bare `<TiffData ` element is
      // deliberately NOT here — `tifffile` writes one too, so the whole corpus carries it, and
      // it is asserted below as NON-discriminating instead.
      '<UUID FileName="tubhiswt_C1.ome.tif">',
    ] as const
    for (const marker of FOREIGN_DOCUMENT_MARKERS) {
      const carrying: string[] = []
      for (const name of corpus) {
        if (readFileSync(`${FIXTURES}${name}`).includes(Buffer.from(marker))) carrying.push(name)
      }
      expect(carrying, marker).toEqual(['bioformats-tubhiswt.ome.tif'])
    }
    // …and the elements that are NOT discriminating, asserted as such so the list above is not
    // read as "everything in this document is unique". `<TiffData `, `<Channel ` and `<Pixels `
    // are written by `tifffile` too, so EVERY file here carries them. That is exactly why the
    // entry above is the multi-file `<UUID FileName=…>` form and not a bare `<TiffData `: the
    // ORDERING and the cross-file references are what #346 means by a foreign `TiffData`, not the
    // element name. Asserting the shared three against the whole corpus is what keeps the
    // discriminating list from being padded with elements that discriminate nothing.
    for (const shared of ['<TiffData ', '<Channel ', '<Pixels ']) {
      const carrying = corpus.filter(name =>
        readFileSync(`${FIXTURES}${name}`).includes(Buffer.from(shared)),
      )
      expect(carrying, `${shared} is written by tifffile too`).toEqual(corpus)
    }
    // …and none of OUR producer's payload is in it. The `cyto-spatial/1` control makes the line
    // discriminating rather than true of any file: our own emitted images DO carry it.
    expect(bytes.includes(Buffer.from('cyto-spatial/1'))).toBe(false)
    expect(readFileSync(HIRES).includes(Buffer.from('cyto-spatial/1'))).toBe(true)

    // ── THE WRITER STAMP: a third family, not merely "not ours" ─────────────────────────
    // `#322 TEST-2`'s `Software` predicate only asks whether the tag names `tifffile`. Absence is
    // what #322's fixture has (Pillow writes no `Software` at all); this file has the tag and it
    // names someone else, which is a strictly stronger statement and is worth its own assertion.
    // The trailing NUL is upstream's and is stripped rather than matched around.
    const [level0] = await levelDirectories(VENDOR_OME_XML)
    expect((level0.Software ?? '').replace(/\0+$/, '')).toBe('OME Bio-Formats 5.2.0-m4')
    expect((await levelDirectories(THIRD_PARTY_STRIPPED))[0].Software).toBeUndefined()
    expect((await levelDirectories(HIRES))[0].Software).toContain('tifffile')

    // ── THE DIVERGENCE: the document says two channels, the container holds one ─────────
    // THIS is what a foreign document buys today, with no parser in the module. `SizeC` is pulled
    // out of the FILE'S OWN bytes rather than typed, so a different upstream artifact moves the
    // expectation with it instead of making this test demand the wrong number.
    const description = bytes.toString('latin1')
    const sizeC = Number(/<Pixels [^>]*SizeC="(\d+)"/.exec(description)?.[1])
    expect(sizeC).toBe(2)
    // Two `<TiffData>` elements, naming two DIFFERENT files — the document describes a set, and
    // this is one member of it. Derived by counting, not asserted as a remembered pair.
    const fileNames = [...description.matchAll(/<UUID FileName="([^"]+)"/g)].map(m => m[1])
    expect(fileNames).toEqual(['tubhiswt_C0.ome.tif', 'tubhiswt_C1.ome.tif'])
    expect(new Set(fileNames).size).toBe(2)
    // …and the CONTAINER holds one IFD with one sample.
    expect(level0.SamplesPerPixel).toBe(1)
    // …so the reader reports ONE channel, not `SizeC`. If an OME-XML path were ever wired into
    // this module without handling multi-file `<TiffData>`, this is the line that goes red — it
    // would report two channels, the second of them a plane this file does not contain.
    const { pyramid, meta } = await loadOmeTiffPyramid(recordingSource(VENDOR_OME_XML))
    expect(meta.channels).toHaveLength(1)
    expect(pyramid[0].shape[pyramid[0].labels.indexOf('c')]).toBe(1)
    expect(meta.channels.length).not.toBe(sizeC)
  })
})

describe('#346 TEST-3 [acceptance] [invariant: INV-346-3] the fixture’s provenance is a re-runnable check, not a paragraph', () => {
  it('runs the committed script’s own identity-and-headers gate', () => {
    // INV-346-3, verbatim from `fixtures/README.md`: *"a binary fixture whose origin is
    // unrecorded is a liability"* — the rule #259 wrote after finding one here whose recipe was
    // filed as LOST. A DOWNLOADED artifact cannot have a generator, so the equivalent is a URL, a
    // licence and a checksum, and `scripts/fetch-vendor-ome-fixture.py --check` is the executable
    // form of all three. Offline: it re-derives the sha256 and byte length against the values
    // recorded in the script, then re-asserts every header the fixture is committed FOR — the
    // 16-tag set, `Compression = 1`, `RowsPerStrip = 1`, the derived strip count, `SampleFormat`,
    // the `Software` stamp, that the raster decodes non-zero, and that the OME-XML carries the
    // foreign-author markers and NONE of our producer's stamps.
    //
    // That last pair is the point of running it here rather than trusting the assertions above:
    // this script refuses the specific regression that would leave every other test green — the
    // file quietly re-emitted through one of our writers, which reproduces a plausible OME-TIFF
    // and destroys the only property it is committed for.
    //
    // `--fetch` is deliberately NOT run: it needs the network, and a suite that reddens when a
    // download fails is a suite people route around. Upstream moving is a thing to notice on
    // purpose, not a thing to discover from a red test.
    //
    // Not gated on Python being present, for the reason #259 TEST-13 states: this package's
    // `npm test` already executes a Python harness, so `python3` is a hard dependency of this
    // suite and a skip here would be a vacuous pass on the check that matters.
    const script = fileURLToPath(
      new URL('../../../scripts/fetch-vendor-ome-fixture.py', import.meta.url),
    )
    const run = spawnSync('python3', [script, '--check'], { encoding: 'utf8' })
    expect(run.error, 'spawning python3 --check').toBeUndefined()
    expect(
      run.status,
      `python3 fetch-vendor-ome-fixture.py --check exited ${run.status}\n` +
        `${run.stdout}\n${run.stderr}`,
    ).toBe(0)
  }, 120_000)
})
