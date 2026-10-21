// omeTiffUnderlay.test.ts — #159 TEST-8, TEST-9, TEST-10.
//
// The reduction of a real emitted OME-TIFF to the single texture `ImageUnderlay` declares.
// Everything here runs the SHIPPED loader over REAL emitted bytes; nothing is mocked, and the
// pixel assertions are anchored on `fixtures/pixel-oracle.json`, whose digests were computed by
// `tifffile` — a decoder that is not the one under test.
//
// ── WHY THE AFFINE TEST NAMES ITS WRONG ANSWERS ──────────────────────────────────────────────
// Every failure mode of a placement affine produces a well-formed 6-number array. Inverted the
// wrong way, taken at the wrong pyramid level, or composed with the OME pixel size, it still
// type-checks, still renders, and still looks like a tissue image — just in the wrong place at
// the wrong size. A test that only asserted the RIGHT value would pass with three of those four
// bugs present in some other code path; so TEST-9 states each wrong number explicitly and
// asserts the result is not it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { loadOmeTiffPyramid, type ByteRangeSource } from './omeTiffPyramid'
import {
  omeTiffUnderlay,
  omeTiffUnderlayMeta,
  underlayAffine,
  MAX_UNDERLAY_PIXELS,
  OmeTiffUnderlayError,
  OmeTiffTooLargeForOneTextureError,
  OmeTiffPlacementError,
} from './omeTiffUnderlay'
import type { OmeTiffPyramid } from './omeTiffPyramid'
import {
  sampleAtLevel,
  sampleCountFixtureFile,
  SAMPLE_FIXTURE_LEVEL1_HEIGHT,
  SAMPLE_FIXTURE_LEVEL1_WIDTH,
} from './sampleCountFixture'

/**
 * A pyramid stood up from a typed array, so a case can control the ONE property it is about —
 * the value range, the sample count, the declared extent — without needing a fixture file for
 * every shape. Every case that is about REAL pixels still runs on a real emitted `.ome.tif`;
 * this exists for the shapes no fixture has.
 */
function syntheticPyramid(opts: {
  data: ArrayLike<number> & { length: number }
  width: number
  height: number
  samples: number
  interleaved: boolean
  dtype: string
  /** declare a different extent than the data actually holds — the disagreement case */
  declaredWidth?: number
  declaredHeight?: number
  /**
   * COARSER levels to prepend, largest first, so the served level is not index 0.
   *
   * Every synthetic case was single-level for one round, which meant `shrinkOf` returned `1`
   * in all of them and the level-scaling arithmetic had no test that could fail on it — the
   * one function the fix round rewrote for correctness. Each entry is `[width, height]` of a
   * level ABOVE the served one; the served level lands at index `coarserThan.length`.
   */
  coarserThan?: readonly (readonly [number, number])[]
  /** override the declared sample count independently of the data, for the guard cases */
  declaredSamples?: number
  /**
   * planar CHANNELS (#288). `> 1` makes this a sample stack: the level's `'c'` axis and the
   * pyramid's own `channels` both carry it, and `planes` supplies one buffer per channel so a
   * case can control what each channel holds — which is the only way to reach the reduction's
   * constant-channel and per-channel-guard arms, since every committed fixture varies in every
   * plane by construction.
   */
  channels?: number
  /** per-channel buffers for a stack; `planes[c]` answers `getRaster({c})`. */
  planes?: (ArrayLike<number> & { length: number })[]
  /** override ONE channel's decoded extent, for the disagreement guard */
  planeExtent?: Record<number, { width: number; height: number }>
  /** make one channel's read reject, for the wrap-the-cause guard */
  planeThrows?: Record<number, Error>
}): OmeTiffPyramid {
  const width = opts.declaredWidth ?? opts.width
  const height = opts.declaredHeight ?? opts.height
  const samples = opts.declaredSamples ?? opts.samples
  const channels = opts.channels ?? 1
  const labels = opts.interleaved ? ['c', 'y', 'x', '_c'] : ['c', 'y', 'x']
  const shape = opts.interleaved
    ? [channels, opts.height, opts.width, samples]
    : [channels, opts.height, opts.width]
  const above = opts.coarserThan ?? []
  const planeFor = async (c: number) => {
    const thrown = opts.planeThrows?.[c]
    if (thrown) throw thrown
    const extent = opts.planeExtent?.[c] ?? { width: opts.width, height: opts.height }
    const data = c === 0 ? opts.data : (opts.planes?.[c] ?? opts.data)
    return { data, width: extent.width, height: extent.height }
  }
  const level = {
    labels,
    shape,
    dtype: opts.dtype,
    getRaster: async (args?: { selection?: { c?: number } }) => planeFor(args?.selection?.c ?? 0),
    getTile: async (args?: { selection?: { c?: number } }) => planeFor(args?.selection?.c ?? 0),
    onTileError: () => {},
    tileSize: 512,
  }
  return {
    // The coarser entries only have to EXIST — the reduction always serves the last one, so
    // they are stand-ins that establish the served level's INDEX.
    pyramid: [...above.map(() => level), level],
    meta: {
      levels: [
        ...above.map(([w, h], i) => ({
          path: String(i),
          width: w,
          height: h,
          scale: [1, 1],
          translation: [0, 0],
          downsample: 2 ** i,
        })),
        {
          path: String(above.length),
          width,
          height,
          scale: [1, 1],
          translation: [0, 0],
          downsample: 2 ** above.length,
        },
      ],
      channels: [],
      dtype: opts.dtype,
      axisIndex: { y: 1, x: 2 },
    },
    interleaved: opts.interleaved,
    channels,
    tiled: false,
    tileSize: 512,
  } as unknown as OmeTiffPyramid
}

const FIXTURES = path.resolve(process.cwd(), 'src/viz-core/spatial/fixtures')

const ORACLE = JSON.parse(readFileSync(path.join(FIXTURES, 'pixel-oracle.json'), 'utf8')) as Record<
  string,
  number | string | number[]
>

/** The producer's OWN manifest entries from the same real run — the declared placement is read
 *  from there rather than typed in here, so this test cannot drift from what is emitted. */
const MANIFEST = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as {
  id: string
  meta: {
    to_space: number[]
    extent: { width: number; height: number }
    microns_per_pixel: number
    display_derivative: { original_resolution_um: number }
  }
}[]

const entry = (id: string) => MANIFEST.find(m => m.id === id)!

function fileSource(name: string): ByteRangeSource {
  const bytes = readFileSync(path.join(FIXTURES, name))
  return {
    byteLength: bytes.byteLength,
    async read(start, end) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

const sha256 = (data: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex')

/** RGBA → RGB, so the result can be held against `tifffile`'s digest of the same level. */
function dropAlpha(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3)
  for (let p = 0; p < rgba.length / 4; p++) {
    out[p * 3] = rgba[p * 4]
    out[p * 3 + 1] = rgba[p * 4 + 1]
    out[p * 3 + 2] = rgba[p * 4 + 2]
  }
  return out
}

describe('TEST-8 — the underlay is the COARSEST level, and its pixels are the file’s', () => {
  it('reduces a real emitted RGB raster to the coarsest level, byte-for-byte', async () => {
    const pyramid = await loadOmeTiffPyramid(fileSource('spatial-image-hires.ome.tif'))
    const declared = entry('spatial-image-hires').meta

    const underlay = await omeTiffUnderlay(pyramid, declared.to_space)

    // THE LOAD-BEARING ASSERTION. Level 0 is 1400x1800; the coarsest is 350x450. An underlay
    // that named level 0 would look identical on this fixture and would materialize gigabytes
    // on a whole-slide raster — the whole-object read the range-reading design forbids, and it
    // is invisible from the rendered output.
    expect(
      [underlay.width, underlay.height],
      'the underlay must be the COARSEST level, never level 0 — a level-0 texture is the ' +
        'materialization the range-reading design exists to prevent, and it renders identically',
    ).toEqual([350, 450])
    expect([declared.extent.width, declared.extent.height]).toEqual([1400, 1800])

    // Always RGBA, whatever the file holds — which is what lets `catalog()` state `channels`
    // before a pixel is read.
    expect(underlay.channels).toBe(4)
    expect(underlay.data).toBeInstanceOf(Uint8Array)
    expect(underlay.data.length).toBe(350 * 450 * 4)

    // THE RIGHT pixels, against a decoder that is not this one. `tifffile`'s digest of level 2
    // is over interleaved RGB, so the alpha this reduction synthesizes is dropped first. A
    // `> 0` or `not all zero` assertion would pass with the channels permuted or the rows
    // reversed; a digest cannot.
    expect(sha256(dropAlpha(underlay.data))).toBe(ORACLE.hires_level2_raster)
    expect(ORACLE.hires_level2_shape).toEqual([450, 350, 3])

    // The synthesized alpha is opaque everywhere — a texture that is 25% transparent renders
    // as a washed-out image rather than as an error.
    for (let p = 0; p < underlay.data.length / 4; p++) expect(underlay.data[p * 4 + 3]).toBe(255)
  })

  it('the meta-only reduction describes exactly the texture the full one returns', async () => {
    // The two MUST agree: `catalog().image` states the header that `asDataSource` later pairs
    // with the streamed bytes, so a disagreement means a correctly-sized header over the wrong
    // buffer — which decodes into a sheared picture, not an error.
    //
    // HONEST NOTE ON WHAT THIS CAN AND CANNOT CATCH. The two functions now read their dimensions
    // from the SAME level table by construction, so this comparison is close to a tautology and
    // is kept as a smoke check on the shape of both return values. The property it names is
    // ENFORCED rather than tested — `omeTiffUnderlay` cross-checks the decoded raster against
    // the declared extent and refuses on a mismatch (see the disagreement case below), which is
    // the assertion that can actually fail.
    const pyramid = await loadOmeTiffPyramid(fileSource('spatial-image-hires.ome.tif'))
    const toSpace = entry('spatial-image-hires').meta.to_space

    const meta = omeTiffUnderlayMeta(pyramid, toSpace)
    const underlay = await omeTiffUnderlay(pyramid, toSpace)

    expect(meta.width).toBe(underlay.width)
    expect(meta.height).toBe(underlay.height)
    expect(meta.channels).toBe(underlay.channels)
    expect(meta.affine).toEqual(underlay.affine)
    expect(meta.width * meta.height * meta.channels).toBe(underlay.data.length)
  })

  it('a single-level raster is the trivial pyramid, and level 0 IS the coarsest', async () => {
    // `spatial-image-lowres` has ONE level, so "coarsest" and "level 0" coincide. This is the
    // control for the assertion above: it proves the rule is "the last level" and not "always
    // index >= 1", which would break every small image.
    const pyramid = await loadOmeTiffPyramid(fileSource('spatial-image-lowres.ome.tif'))
    expect(pyramid.pyramid.length).toBe(1)
    const underlay = await omeTiffUnderlay(pyramid, entry('spatial-image-lowres').meta.to_space)
    expect([underlay.width, underlay.height]).toEqual([420, 540])
    expect(underlay.data.length).toBe(420 * 540 * 4)
  })
})

describe('TEST-9 — the placement affine, and the three ways to be plausibly wrong', () => {
  // The real declared placement of the real emitted hires raster: emitted pixels -> the
  // coordinate space, at 5 space-units per level-0 pixel.
  const TO_SPACE = [5, 0, 0, 0, 5, 0] as const
  const DOWNSAMPLE = 4 // the coarsest level of the 3-level hires pyramid

  it('matches the producer’s own declaration, so this test cannot drift from what is emitted', () => {
    expect(entry('spatial-image-hires').meta.to_space).toEqual([...TO_SPACE])
  })

  it('inverts the placement AND rescales it to the served level', async () => {
    const pyramid = await loadOmeTiffPyramid(fileSource('spatial-image-hires.ome.tif'))
    const underlay = await omeTiffUnderlay(pyramid, entry('spatial-image-hires').meta.to_space)

    // space -> level-0 px is 1/5; space -> coarsest px is 1/(5*4) = 0.05.
    const right = [0.05, 0, 0, 0, 0.05, 0]
    underlay.affine.forEach((v, i) => expect(v).toBeCloseTo(right[i], 12))

    // ── AND IT IS NONE OF THESE ────────────────────────────────────────────────────────────
    // (a) the placement used as-is. `to_space` maps pixels -> space; `ImageUnderlay.affine` is
    //     declared the other way and its one consumer applies it to the POINTS. Using it
    //     un-inverted scales every overlay by the square of the scalefactor and throws nothing.
    expect(underlay.affine[0]).not.toBeCloseTo(5, 6)
    // (b) the right inversion at the WRONG level — correct for level 0, four times too big for
    //     the texture actually being served.
    expect(underlay.affine[0]).not.toBeCloseTo(0.2, 6)
    // (c) THE MEASURED TRAP — #258 TEST-1 [acceptance] [invariant: INV-1].
    //     Composing the pixel-size affine over the placement is what `imageModelMatrix` does for
    //     an NGFF image, and it draws a perfectly plausible tissue image at the wrong size.
    //
    //     WHAT EACH LINE BELOW ACTUALLY DOES, because they are not equals. The exact assertion
    //     15 lines up (`affine` pinned to `[0.05, …]` at 12 digits) is what FAILS if the code
    //     composes the pitch — a mutation that commits the trap reddens there, and the two
    //     `not.toBeCloseTo` calls never even evaluate. Those two are DOCUMENTARY: they name the
    //     wrong answers by value so a reader learns them. That is worth having, and it is
    //     precisely why the operand must not be a hand-copied literal — a stale literal does not
    //     break a test, it makes the DOCUMENTATION wrong, which is the failure this file is
    //     being edited for. So `PHYSICAL_SIZE_X` is read from the artifact's own declaration.
    //
    //     The ratio line is a producer-consistency check, not a guard on the read: it asserts
    //     the manifest's three declared fields agree the way the importer computes them
    //     (`original_resolution_um = microns_per_pixel / scalef`, `to_space = 1/scalef`). It is
    //     satisfied identically by any correctly-emitted bundle and fires only on an internally
    //     inconsistent one — verified by forcing `original_resolution_um` to 1.0, which reddens
    //     it. (`omeTiffPyramid.test.ts` keeps a hand-copied literal for the same quantity and is
    //     safe for a DIFFERENT reason: it divides that literal by the artifact's own
    //     `microns_per_pixel` and pins the quotient to a hardcoded 5, so a regenerated fixture
    //     turns it red. Two different mechanisms, not two positions.)
    //
    //     THE MAGNITUDES ARE THE FROZEN PRE-#222 ONES, DELIBERATELY. This fixture is the Visium
    //     importer's output as of #154/#155/#176, kept byte-identical under #222's
    //     fix-forward-only ruling, so it declares
    //     [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]
    //     `original_resolution_um = 3.7356857…` and `microns_per_pixel = 0.7471371…` (ratio 5.0).
    //     [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]
    //     The importer TODAY derives `4.4149…` and `0.88298…` for the same bundle — #222 changed
    //     [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
    //     the numerator from the 55 µm capture footprint to the 65 µm rendered spot diameter.
    //     Neither pair is "the" answer and this
    //     test does not care which: `to_space[0]` is their ratio by construction at any micron
    //     scale, and nothing on this path can read a micron scale in the first place — the
    //     signatures (`omeTiffUnderlayMeta(pyramid, toSpace, space)`, `underlayAffine`) do not
    //     accept one.
    //
    //     [frozen-magnitude: spatial-image-hires.PhysicalSizeX]
    //     NOTE `original_resolution_um` is the MANIFEST's field. The hires TIFF's OME-XML
    //     independently carries `PhysicalSizeX="3.7356857014116684"`, and the two agree — but
    //     nothing here asserts that they do, and the loader never parses `PhysicalSizeX` at all
    //     (`loadOmeTiffPyramid` takes `micronsPerPixel` from its CALLER). Read "the artifact"
    //     below as the manifest entry, not the TIFF.
    const hiresMeta = entry('spatial-image-hires').meta
    const PHYSICAL_SIZE_X = hiresMeta.display_derivative.original_resolution_um
    expect(PHYSICAL_SIZE_X / hiresMeta.microns_per_pixel).toBeCloseTo(hiresMeta.to_space[0], 9)
    expect(underlay.affine[0]).not.toBeCloseTo(0.05 / PHYSICAL_SIZE_X, 6)
    expect(underlay.affine[0]).not.toBeCloseTo(0.05 * PHYSICAL_SIZE_X, 6)
  })

  it('a NON-SQUARE, anisotropic, rotated placement round-trips — a transpose cannot pass', () => {
    // The diagonal fixture above cannot catch a transposed affine: `[a,0,0,0,d,0]` transposed is
    // itself when a == d. So the direction is proven on a placement whose four linear entries
    // are all different, over a non-square level.
    const skewed = [2, 0.5, 7, -0.25, 4, -3]
    const got = underlayAffine(skewed, [2, 2])

    // The definition, applied: `got` must map a SPACE point back to the level-2 pixel that
    // `skewed` sends to it. Round-tripping through the actual arithmetic is what makes this
    // independent of how the inverse happens to be spelled.
    const px = 37
    const py = 11
    const sx = skewed[0] * px + skewed[1] * py + skewed[2]
    const sy = skewed[3] * px + skewed[4] * py + skewed[5]
    expect(got[0] * sx + got[1] * sy + got[2]).toBeCloseTo(px / 2, 9)
    expect(got[3] * sx + got[4] * sy + got[5]).toBeCloseTo(py / 2, 9)

    // and the transpose of the linear part is a DIFFERENT map here, so the test can see one
    const transposed = underlayAffine([skewed[0], skewed[3], skewed[2], skewed[1], skewed[4], skewed[5]], [2, 2])
    expect(transposed[1]).not.toBeCloseTo(got[1], 9)
  })

  it('an ABSENT placement is array-index units; a MALFORMED one is refused', () => {
    // Absence is a fact about the artifact — it declares no placement, so it is un-overlayable
    // and says so in the only honest way: identity at level 0.
    expect(underlayAffine(undefined, [1, 1])).toEqual([1, 0, 0, 0, 1, 0])
    expect(underlayAffine(undefined, [4, 4])).toEqual([0.25, 0, 0, 0, 0.25, 0])

    // A DECLARED but malformed placement is a producer bug, and substituting identity for it
    // would render the raster in the wrong place with nothing saying so. Four elements is the
    // specific shape a `to_space` read off a compacted summary row would arrive as.
    expect(() => underlayAffine([1, 0, 0, 1], [1, 1])).toThrow(OmeTiffUnderlayError)
    expect(() => underlayAffine([1, 0, 0, 0, Number.NaN, 0], [1, 1])).toThrow(OmeTiffUnderlayError)
    // A singular placement cannot be inverted at all — surfaced, not silently identity.
    expect(() => underlayAffine([0, 0, 0, 0, 0, 0], [1, 1])).toThrow()
  })
})

describe('TEST-10 — a non-interleaved, non-8-bit raster still reduces to a legible texture', () => {
  it('windows a uint16 single-sample plane through THAT level’s own extremes', async () => {
    const pyramid = await loadOmeTiffPyramid(fileSource('spatial-image-greyscale.ome.tif'))
    expect(pyramid.interleaved).toBe(false)
    expect(pyramid.meta.dtype).toBe('Uint16')

    const underlay = await omeTiffUnderlay(pyramid)
    expect([underlay.width, underlay.height]).toEqual([384, 512])
    expect(underlay.data.length).toBe(384 * 512 * 4)
    expect(underlay.channels).toBe(4)

    // Grey: R == G == B at EVERY pixel, alpha opaque everywhere. Bounded at 512 for one round,
    // which checked the first row and a half of 196,608 pixels — a channel permutation confined
    // to the lower rows would have passed. Counted rather than asserted per pixel so a failure
    // says how many, not just that there was one.
    let notGrey = 0
    let notOpaque = 0
    for (let p = 0; p < underlay.data.length / 4; p++) {
      const d = p * 4
      if (underlay.data[d + 1] !== underlay.data[d] || underlay.data[d + 2] !== underlay.data[d]) notGrey++
      if (underlay.data[d + 3] !== 255) notOpaque++
    }
    expect(notGrey).toBe(0)
    expect(notOpaque).toBe(0)

    // THE WINDOW ACTUALLY SPANS. A fixed 0..65535 window renders a typical 16-bit plane as
    // near-flat black: the failure would be a picture, not an error. The level's own extremes
    // must therefore reach both ends of the 8-bit range.
    let lo = 255
    let hi = 0
    for (let p = 0; p < underlay.data.length / 4; p++) {
      const v = underlay.data[p * 4]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    expect(lo).toBe(0)
    expect(hi).toBe(255)
  })

  it('the window MOVES with the data — TWO rasters, and the same input value maps differently', async () => {
    // The earlier version of this case loaded ONE raster and re-asserted the preceding test's
    // conclusion, while its comment promised a comparison. It could not distinguish its own two
    // hypotheses: a plane spanning the full 16-bit range windows identically under a per-image
    // window and under a hardcoded 0..65535 one.
    //
    // So: two rasters, deliberately different ranges, and the SAME raw value in both. Under a
    // per-image window it maps to two different display values; under any fixed window it maps
    // to the same one. That is the difference this test now measures.
    const shared = 1000
    const narrow = new Uint16Array([0, shared, 2000])
    const wide = new Uint16Array([0, shared, 60000])

    const a = await omeTiffUnderlay(
      syntheticPyramid({ data: narrow, width: 3, height: 1, samples: 1, interleaved: false, dtype: 'Uint16' }),
    )
    const b = await omeTiffUnderlay(
      syntheticPyramid({ data: wide, width: 3, height: 1, samples: 1, interleaved: false, dtype: 'Uint16' }),
    )

    // Both span the full display range — each windowed by its OWN extremes.
    expect([a.data[0], a.data[8]]).toEqual([0, 255])
    expect([b.data[0], b.data[8]]).toEqual([0, 255])

    // …and the shared raw value lands in a different place in each. A hardcoded window makes
    // these two equal, which is exactly the failure the name claims to catch.
    expect(a.data[4]).toBe(Math.round((shared / 2000) * 255))
    expect(b.data[4]).toBe(Math.round((shared / 60000) * 255))
    expect(a.data[4]).not.toBe(b.data[4])
  })

  it('a 16-BIT INTERLEAVED colour raster keeps its colour, windowed across the three channels', async () => {
    // The branch that decided "is this display colour?" on the sample WIDTH rather than the
    // sample LAYOUT. A 16-bit RGB file — which the loader accepts without complaint — fell into
    // the greyscale arm, was reduced to its RED channel, and was windowed against extremes
    // computed over all three channels mixed together: a plausible grey picture that did not
    // even span the display range.
    const px = [
      [0, 30000, 60000],
      [60000, 0, 30000],
    ]
    const data = Uint16Array.from(px.flat())
    const underlay = await omeTiffUnderlay(
      syntheticPyramid({ data, width: 2, height: 1, samples: 3, interleaved: true, dtype: 'Uint16' }),
    )

    // COLOUR, not grey: the three channels of a pixel differ.
    expect(underlay.data[0]).not.toBe(underlay.data[1])
    // ONE window shared across R/G/B, so the channel BALANCE survives — three independent
    // per-channel windows would re-tint the image.
    expect([underlay.data[0], underlay.data[1], underlay.data[2]]).toEqual([0, 128, 255])
    expect([underlay.data[4], underlay.data[5], underlay.data[6]]).toEqual([255, 0, 128])
    expect(underlay.data[3]).toBe(255)
  })

  it('refuses an over-long buffer — the signature of a wrong sample count', async () => {
    // `<` let this through, and the consequence is silent: consecutive sample PAIRS read as
    // consecutive PIXELS, i.e. a horizontally squashed, duplicated image with no error anywhere.
    const twoSamples = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await expect(
      omeTiffUnderlay(
        syntheticPyramid({ data: twoSamples, width: 4, height: 1, samples: 1, interleaved: false, dtype: 'Uint8' }),
      ),
    ).rejects.toThrow(/decoded 8 values/)
  })

  it('refuses when the DECLARED extent and the decoded raster disagree', async () => {
    // The two entry points are documented as MUST agree; the catalog states the header and the
    // reduction states the bytes, and a consumer pairs them. A disagreement is a correctly-sized
    // header over the wrong buffer, which renders as a sheared picture rather than an error.
    const data = new Uint8Array(4 * 4)
    await expect(
      omeTiffUnderlay(
        syntheticPyramid({
          data,
          width: 4,
          height: 4,
          samples: 1,
          interleaved: false,
          dtype: 'Uint8',
          declaredWidth: 8,
          declaredHeight: 2,
        }),
      ),
    ).rejects.toThrow(/declares 8x2 but decoded 4x4/)
  })

  it('REFUSES a coarsest level too large to materialize, rather than allocating it', async () => {
    // "The coarsest level" is a RELATIVE rule: the level count is the WRITER's choice, so a
    // three-level pyramid over a 100k x 100k raster still has a 25k x 25k coarsest level — a
    // 2.5 GB allocation. Refusing is correct and costs nothing visible: the tiling path renders
    // exactly this image from the viewport, at any size.
    const side = 4096 // 16.7M pixels, over the 4.19M cap
    const fake = syntheticPyramid({
      data: new Uint8Array(1),
      width: side,
      height: side,
      samples: 1,
      interleaved: false,
      dtype: 'Uint8',
    })
    await expect(omeTiffUnderlay(fake)).rejects.toThrow(/single-texture cap/)
    // And the CATALOG refuses identically, so it can never advertise a texture the reduction
    // would then decline to build.
    expect(() => omeTiffUnderlayMeta(fake)).toThrow(/single-texture cap/)

    // ── ITS OWN CLASS, AND THAT IS LOAD-BEARING ──────────────────────────────────────────
    // A caller has to tell "too big for one texture" from every other refusal. The first cut of
    // this cap did not let it, and the consequence was that a catalog treated the size refusal
    // as "cannot open", reported no raster at all, and withdrew the view from exactly the image
    // the tiling path exists for. The repair had disabled what it was protecting.
    expect(() => omeTiffUnderlayMeta(fake)).toThrow(OmeTiffTooLargeForOneTextureError)
    await expect(omeTiffUnderlay(fake)).rejects.toBeInstanceOf(OmeTiffTooLargeForOneTextureError)
    // …and a MALFORMED PLACEMENT is a different class again — a producer bug, not a size.
    expect(() => underlayAffine([1, 2, 3], [1, 1])).toThrow(OmeTiffPlacementError)
    expect(new OmeTiffPlacementError('x')).toBeInstanceOf(OmeTiffUnderlayError)
    expect(new OmeTiffTooLargeForOneTextureError('x')).not.toBeInstanceOf(OmeTiffPlacementError)
    // The cap is a real bound, not a formality: the fixture is comfortably inside it.
    expect(350 * 450).toBeLessThan(MAX_UNDERLAY_PIXELS)
    expect(side * side).toBeGreaterThan(MAX_UNDERLAY_PIXELS)
  })

  it('the affine can scale its two axes independently, and refuses a non-positive factor', () => {
    // `underlayAffine` in isolation: row 1 produces x' and row 2 produces y', so each row must
    // scale by its own axis factor. Kept as a direct unit even though the SHIPPED shrink is
    // isotropic — this is the function's contract, not the wiring's.
    const anisotropic = underlayAffine([1, 0, 0, 0, 1, 0], [2, 5])
    expect(anisotropic[0]).toBeCloseTo(0.5, 12)
    expect(anisotropic[4]).toBeCloseTo(0.2, 12)
    expect(() => underlayAffine([1, 0, 0, 0, 1, 0], [2, 0])).toThrow(OmeTiffUnderlayError)
  })

  it('the SHIPPED shrink is 2^index — NOT the dimension ratio, on an odd chain', async () => {
    // ── THE FINDING THIS CASE EXISTS FOR ──────────────────────────────────────────────────
    // The level scaling went through two wrong answers, both plausible, and neither had a test
    // that could fail on it: the level table's width-derived `downsample` scalar, then a
    // per-axis dimension ratio. On an ODD chain the ratio is an artefact of integer truncation
    // — 1401 -> 700 -> 350 gives 4.00286, not 4 — and the truth is upstream and exact: the
    // writer box-means by exactly `factor`, and `assertHalvingPyramid` refuses any level that
    // is not `floor(previous / 2)` because *the image layer places every tile on the assumption
    // that each level is the previous one halved*. So the TILED path uses 2^index, and a
    // fallback texture that used the ratio would be placed ~0.3% away from it — two renderings
    // of one artifact disagreeing, with nothing saying so.
    //
    // Every synthetic case was single-level before this, so `shrinkOf` returned 1 in all of
    // them and none of this was observable.
    const data = new Uint8Array(4 * 4)
    const odd = syntheticPyramid({
      data,
      width: 4,
      height: 4,
      samples: 1,
      interleaved: false,
      dtype: 'Uint8',
      // An odd chain: 1401x903 -> 700x451 -> (served) 4x4. The declared ratios are wildly
      // non-integral; the level INDEX is 2, so the shrink must be exactly 4.
      coarserThan: [
        [1401, 903],
        [700, 451],
      ],
    })

    const meta = omeTiffUnderlayMeta(odd, [1, 0, 0, 0, 1, 0])
    // 2^2 = 4 on BOTH axes.
    expect(meta.affine[0]).toBeCloseTo(0.25, 12)
    expect(meta.affine[4]).toBeCloseTo(0.25, 12)

    // AND IT IS NEITHER RATIO. Both are well-formed numbers that render a plausible picture.
    expect(meta.affine[0], 'not the width ratio 1401/4').not.toBeCloseTo(4 / 1401, 6)
    expect(meta.affine[4], 'not the height ratio 903/4').not.toBeCloseTo(4 / 903, 6)
    // …and the two axes agree, which a per-axis dimension ratio on this chain would not.
    expect(meta.affine[0]).toBeCloseTo(meta.affine[4], 12)

    // The full reduction agrees with the header, on the same multi-level pyramid.
    const underlay = await omeTiffUnderlay(odd, [1, 0, 0, 0, 1, 0])
    expect(underlay.affine).toEqual(meta.affine)
  })

  it('a 16-bit RGBA raster keeps its ALPHA, windowed on its own range', async () => {
    // The deeper-than-8-bit colour branch wrote 255 unconditionally for one round — in the very
    // branch added because 16-bit colour was being mishandled — so a 16-bit RGBA raster rendered
    // fully opaque with nothing saying so. And the colour window must still exclude alpha:
    // opacity is not intensity, and letting it in re-scales the picture by how transparent it is.
    const px = [
      [0, 30000, 60000, 0],
      [60000, 0, 30000, 60000],
    ]
    const underlay = await omeTiffUnderlay(
      syntheticPyramid({
        data: Uint16Array.from(px.flat()),
        width: 2,
        height: 1,
        samples: 4,
        interleaved: true,
        dtype: 'Uint16',
      }),
    )
    // The COLOUR channels are windowed over 0..60000 — the alpha values do not widen or shift
    // it (they happen to share the range here, which is why the alpha assertion below is the
    // one that discriminates).
    expect([underlay.data[0], underlay.data[1], underlay.data[2]]).toEqual([0, 128, 255])
    // …and alpha is carried, not invented: transparent stays transparent.
    expect(underlay.data[3]).toBe(0)
    expect(underlay.data[7]).toBe(255)
  })

  it('refuses a level that declares a non-positive sample count', async () => {
    // `?? 1` covers null and undefined and nothing else. A component axis declaring 0 makes
    // `pixels * samples` zero, satisfies the exact length guard against an empty buffer, and
    // renders the whole texture flat mid-grey with no error — the same silent-wrong-picture
    // class the length guard was rewritten to close.
    await expect(
      omeTiffUnderlay(
        syntheticPyramid({
          data: new Uint8Array(0),
          width: 2,
          height: 2,
          samples: 3,
          declaredSamples: 0,
          interleaved: true,
          dtype: 'Uint8',
        }),
      ),
    ).rejects.toThrow(/samples per pixel/)
  })
})

// ── #288 TEST-4 [acceptance] [invariant: INV-3] / TEST-9 ──────────────────────────────────
//
// The single-texture reduction is the SECOND render path off one pyramid, and it had the same
// defect from the other end: it read `{c: 0}` and windowed that one buffer into grey. Handed a
// 2- or 5-sample file — files the loader now READS as one channel per sample — that draws
// sample 0 and calls it the image, which is precisely what #288 is about. Nothing in #288
// mentions this path; `omeTiffUnderlay.ts`'s own header did
// (*"a loader change that admitted a 2-sample interleaved file would make the difference
// real"*), and this is that change.

describe('#288 TEST-4 [acceptance] [invariant: INV-3] a multi-sample file reduces from EVERY sample', () => {
  /** The served level is the COARSEST — index 1 for this family (150x100). */
  const LEVEL = 1

  /** The reduction's own rule, restated: window each channel on ITS OWN extremes, take the max. */
  function expectedComposite(channels: number): Uint8Array {
    const pixels = SAMPLE_FIXTURE_LEVEL1_WIDTH * SAMPLE_FIXTURE_LEVEL1_HEIGHT
    const planes: number[][] = []
    for (let c = 0; c < channels; c++) {
      const plane: number[] = []
      for (let y = 0; y < SAMPLE_FIXTURE_LEVEL1_HEIGHT; y++) {
        for (let x = 0; x < SAMPLE_FIXTURE_LEVEL1_WIDTH; x++) plane.push(sampleAtLevel(LEVEL, c, x, y))
      }
      planes.push(plane)
    }
    const windows = planes.map(plane => [Math.min(...plane), Math.max(...plane)])
    const out = new Uint8Array(pixels * 4)
    for (let p = 0; p < pixels; p++) {
      let v = 0
      for (let c = 0; c < channels; c++) {
        const [lo, hi] = windows[c]
        const span = hi - lo
        const scaled = span > 0 ? Math.round((planes[c][p] - lo) * (255 / span)) : 128
        if (scaled > v) v = scaled
      }
      out[p * 4] = v
      out[p * 4 + 1] = v
      out[p * 4 + 2] = v
      out[p * 4 + 3] = 255
    }
    return out
  }

  /** THE NEGATIVE CONTROL: what the pre-#288 code produced — sample 0, windowed, as the image. */
  function sampleZeroOnly(): Uint8Array {
    const pixels = SAMPLE_FIXTURE_LEVEL1_WIDTH * SAMPLE_FIXTURE_LEVEL1_HEIGHT
    const plane: number[] = []
    for (let y = 0; y < SAMPLE_FIXTURE_LEVEL1_HEIGHT; y++) {
      for (let x = 0; x < SAMPLE_FIXTURE_LEVEL1_WIDTH; x++) plane.push(sampleAtLevel(LEVEL, 0, x, y))
    }
    const lo = Math.min(...plane)
    const span = Math.max(...plane) - lo
    const out = new Uint8Array(pixels * 4)
    for (let p = 0; p < pixels; p++) {
      const v = span > 0 ? Math.round((plane[p] - lo) * (255 / span)) : 128
      out[p * 4] = v
      out[p * 4 + 1] = v
      out[p * 4 + 2] = v
      out[p * 4 + 3] = 255
    }
    return out
  }

  for (const samples of [2, 5]) {
    it(`S=${samples}: the texture is the per-sample-windowed maximum, and is NOT sample 0 alone`, async () => {
      const pyramid = await loadOmeTiffPyramid(
        fileSource(sampleCountFixtureFile(samples)),
      )
      expect(pyramid.channels).toBe(samples)
      const underlay = await omeTiffUnderlay(pyramid)

      expect([underlay.width, underlay.height, underlay.channels]).toEqual([
        SAMPLE_FIXTURE_LEVEL1_WIDTH,
        SAMPLE_FIXTURE_LEVEL1_HEIGHT,
        4,
      ])

      // (1) PIXEL CONTENT, computed independently from the closed form — not "a texture was
      // produced", which is what passes against the broken code.
      const want = expectedComposite(samples)
      expect(underlay.data.length).toBe(want.length)
      let mismatches = 0
      let firstBad = ''
      for (let i = 0; i < want.length; i++) {
        if (underlay.data[i] !== want[i]) {
          if (mismatches === 0) firstBad = `at ${i}: got ${underlay.data[i]}, want ${want[i]}`
          mismatches++
        }
      }
      expect(`${mismatches} mismatches ${firstBad}`).toBe('0 mismatches ')

      // (2) …and it DEPENDS on the samples beyond the first. The control is the exact output
      // the pre-#288 code produced for these same bytes; if the new branch quietly fell back to
      // channel 0 the assertion above could still pass on a file whose samples happened to
      // agree, and this one could not.
      const zeroOnly = sampleZeroOnly()
      let differing = 0
      for (let i = 0; i < zeroOnly.length; i++) if (underlay.data[i] !== zeroOnly[i]) differing++
      expect(differing).toBeGreaterThan(0)
    })
  }
})

describe('#288 TEST-9 the three shipped sample layouts reduce exactly as they did', () => {
  it('S=1, S=3 and S=4 take the branches they always took', async () => {
    // The sample-stack branch sits between the colour branches and the greyscale one, so it is
    // reachable ONLY when `interleaved` is false AND the channel axis is > 1. These three
    // fixtures are the proof that it did not swallow anything: 3 and 4 are interleaved colour,
    // 1 is a single plane, and all three must be byte-identical to the pre-#288 reduction.
    //
    // The expected bytes are derived from the SAME closed form the other suite uses, through
    // the branch each file is supposed to take — a literal digest would only say "unchanged",
    // never "unchanged AND still correct".
    const pixels = SAMPLE_FIXTURE_LEVEL1_WIDTH * SAMPLE_FIXTURE_LEVEL1_HEIGHT

    for (const samples of [1, 3, 4]) {
      const pyramid = await loadOmeTiffPyramid(
        fileSource(sampleCountFixtureFile(samples)),
      )
      // NOT `[samples, pyramid.channels, …]` against `[samples, 1, …]` — that compared
      // `samples` with itself in position 0 and asserted nothing there.
      expect([pyramid.channels, pyramid.interleaved]).toEqual([1, samples !== 1])
      const underlay = await omeTiffUnderlay(pyramid)
      expect(underlay.data.length).toBe(pixels * 4)

      const at = (c: number, p: number): number =>
        sampleAtLevel(
          1,
          c,
          p % SAMPLE_FIXTURE_LEVEL1_WIDTH,
          Math.floor(p / SAMPLE_FIXTURE_LEVEL1_WIDTH),
        )

      if (samples === 1) {
        // The greyscale branch: one plane, windowed on its own extremes, replicated to R/G/B.
        const plane = Array.from({ length: pixels }, (_, p) => at(0, p))
        const lo = Math.min(...plane)
        const span = Math.max(...plane) - lo
        for (let p = 0; p < pixels; p++) {
          const v = span > 0 ? Math.round((plane[p] - lo) * (255 / span)) : 128
          expect([underlay.data[p * 4], underlay.data[p * 4 + 3]]).toEqual([v, 255])
        }
      } else {
        // The 8-bit interleaved-colour branch: copied THROUGH, with an opaque alpha
        // synthesized for RGB. No windowing — the pixels a user sees are the pixels in the
        // file, which is the property that would break if a stack branch had claimed them.
        for (let p = 0; p < pixels; p++) {
          expect([
            underlay.data[p * 4],
            underlay.data[p * 4 + 1],
            underlay.data[p * 4 + 2],
            underlay.data[p * 4 + 3],
          ]).toEqual([at(0, p), at(1, p), at(2, p), samples >= 4 ? at(3, p) : 255])
        }
      }
    }
  })
})

// ── #288 FIX_ROUND-1 — the arms the committed fixtures cannot reach ───────────────────────
//
// A blind audit mutated each of the four guards this branch added to `false` and every one of
// the package's spatial tests stayed green: they were present, reasoned about, and untested.
// The reason is structural — every plane of `(37s + 5x + 3y) mod 251` varies, every channel of
// a real file has the same extent, and no committed file has a channel that fails to read — so
// the cases live here, on the synthetic pyramid this file already keeps for "the shapes no
// fixture has".

describe('#288 TEST-16 a channel with no structure contributes nothing, not a floor of 128', () => {
  const ramp = (n: number, step: number): Uint8Array =>
    Uint8Array.from({ length: n }, (_, i) => i * step)

  it('a blank channel beside a signal channel does not flatten the bottom half of the range', async () => {
    // The rule the single-plane branch uses — a zero-span plane windows to mid-grey — is right
    // when that plane IS the image and wrong as a contributor to a MAXIMUM, where it becomes a
    // FLOOR at 128. One dead channel in a 10-plex panel is the norm, not an edge case.
    const signal = ramp(8, 10) // 0,10,…,70
    const blank = new Uint8Array(8) // all zero: no structure
    const withBlank = await omeTiffUnderlay(
      syntheticPyramid({
        data: signal,
        planes: [signal, blank],
        channels: 2,
        width: 8,
        height: 1,
        samples: 1,
        interleaved: false,
        dtype: 'Uint8',
      }),
    )
    const alone = await omeTiffUnderlay(
      syntheticPyramid({
        data: signal,
        channels: 1,
        width: 8,
        height: 1,
        samples: 1,
        interleaved: false,
        dtype: 'Uint8',
      }),
    )

    // The signal windows to its own extremes either way; the blank channel must not move it.
    const red = (u: { data: Uint8Array }): number[] =>
      Array.from({ length: 8 }, (_, p) => u.data[p * 4])
    expect(red(alone)).toEqual([0, 36, 73, 109, 146, 182, 219, 255])
    // Before this fix: [128,128,128,128,146,182,219,255] — half the image flattened by a
    // channel carrying no information at all.
    expect(red(withBlank)).toEqual(red(alone))
  })

  it('…but an ALL-constant stack is still mid-grey, exactly as a constant single plane is', async () => {
    // A PROPERTY assertion, not a control: it holds against the pre-fix rule too (which mapped
    // every constant channel to 128 and would reach the same answer here). Its job is to pin
    // the `anyStructure` fallback — deleting that flag turns this black — while the case ABOVE
    // is the one that discriminates the fix. Said out loud so it is not read as a second
    // control.
    // The other half of the rule. "No channel has structure" is a legitimate image (an empty
    // tile, a saturated one) and must read as flat grey rather than as black, which is what
    // dropping every contribution would give.
    const flat = Uint8Array.from({ length: 4 }, () => 42)
    const other = Uint8Array.from({ length: 4 }, () => 200)
    const underlay = await omeTiffUnderlay(
      syntheticPyramid({
        data: flat,
        planes: [flat, other],
        channels: 2,
        width: 4,
        height: 1,
        samples: 1,
        interleaved: false,
        dtype: 'Uint8',
      }),
    )
    expect(Array.from(underlay.data.slice(0, 8))).toEqual([128, 128, 128, 255, 128, 128, 128, 255])
  })
})

describe('#288 TEST-17 the sample-stack reduction refuses what it cannot composite, by name', () => {
  const base = {
    data: Uint8Array.from({ length: 4 }, (_, i) => i),
    width: 4,
    height: 1,
    samples: 1,
    interleaved: false,
    dtype: 'Uint8' as const,
  }

  it('a channel whose decoded extent disagrees with channel 0', async () => {
    await expect(
      omeTiffUnderlay(
        syntheticPyramid({
          ...base,
          channels: 2,
          planes: [base.data, base.data],
          planeExtent: { 1: { width: 2, height: 2 } },
        }),
      ),
    ).rejects.toThrow(/channel 1 decoded 2x2 but channel 0 decoded 4x1/)
  })

  it('a channel whose decoded LENGTH is not one sample per pixel', async () => {
    await expect(
      omeTiffUnderlay(
        syntheticPyramid({
          ...base,
          channels: 2,
          planes: [base.data, Uint8Array.from({ length: 8 }, (_, i) => i)],
        }),
      ),
    ).rejects.toThrow(/channel 1 decoded 8 values for 4x1/)
  })

  it("a channel the source cannot serve at all — wrapped, so the caller's type does not change", async () => {
    // `getRaster` can now reject with the LOADER's `OmeTiffLoadError` (an out-of-range
    // selection) or a bare geotiff `RangeError` (a level whose sample layout disagrees).
    // Every other failure in this function is an `OmeTiffUnderlayError`, and a caller
    // discriminating on that must not start seeing types it never saw before because this
    // branch added a read.
    const failure = await omeTiffUnderlay(
      syntheticPyramid({
        ...base,
        channels: 2,
        planes: [base.data, base.data],
        planeThrows: { 1: new RangeError("Invalid sample index '1'.") },
      }),
    ).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure).toBeInstanceOf(OmeTiffUnderlayError)
    expect(failure?.message).toContain("RangeError: Invalid sample index '1'.")
  })

  it('a pyramid whose declared channel count disagrees with the served level’s own axis', async () => {
    // This state and the one below are NOT states `loadOmeTiffPyramid` can produce — it derives
    // `channels` and the level shapes together. They are assertions about THIS FUNCTION's
    // contract against a hand-assembled pyramid, which is what the seam accepts: `omeTiffUnderlay`
    // takes an `OmeTiffPyramid`, and a caller that builds one (a test, a future second reader)
    // must not be able to make it reduce from fewer channels than the file carries in silence.
    // ONE route to the fact plus a CHECK on it (#214). The loader's `channels` is
    // authoritative; the level's `'c'` axis is what catches a pyramid assembled inconsistently,
    // which would otherwise reduce from fewer channels than the file carries and say nothing.
    const pyramid = syntheticPyramid({ ...base, channels: 2, planes: [base.data, base.data] })
    const tampered = { ...pyramid, channels: 3 } as unknown as OmeTiffPyramid
    await expect(omeTiffUnderlay(tampered)).rejects.toThrow(
      /declares 3 channel\(s\) but level 0's own 'c' axis is 2/,
    )
  })

  it('a pyramid declaring a non-positive channel count — by ITS OWN message', async () => {
    // `/declares 0 channel\(s\)/` alone is an EQUIVALENT MUTANT: delete this guard entirely and
    // control falls through to the axis cross-check below, whose message is
    // "…declares 0 channel(s) but level 0's own 'c' axis is 1…" — which the same regex matches.
    // So the assertion is on the clause only THIS guard emits.
    const pyramid = syntheticPyramid({ ...base, channels: 1 })
    const tampered = { ...pyramid, channels: 0 } as unknown as OmeTiffPyramid
    const failure = await omeTiffUnderlay(tampered).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure?.message).toContain('a raster has at least one')
    expect(failure?.message).not.toContain("'c' axis")
  })
})

describe('#288 TEST-18 the reduction covers the CEILING, not just the small counts', () => {
  it('the 10-sample committed file reduces from all ten channels', async () => {
    // The underlay's most expensive new path — ten sequential full-level decodes on the call
    // that runs when a project is opened — and the one the fixture family stopped short of.
    const pyramid = await loadOmeTiffPyramid(fileSource(sampleCountFixtureFile(10)))
    expect(pyramid.channels).toBe(10)
    const underlay = await omeTiffUnderlay(pyramid)
    expect([underlay.width, underlay.height, underlay.channels]).toEqual([
      SAMPLE_FIXTURE_LEVEL1_WIDTH,
      SAMPLE_FIXTURE_LEVEL1_HEIGHT,
      4,
    ])

    // Pixel content, from all ten planes, computed independently.
    const pixels = SAMPLE_FIXTURE_LEVEL1_WIDTH * SAMPLE_FIXTURE_LEVEL1_HEIGHT
    const want = new Uint8Array(pixels * 4)
    for (let c = 0; c < 10; c++) {
      const plane = Array.from({ length: pixels }, (_, p) =>
        sampleAtLevel(
          1,
          c,
          p % SAMPLE_FIXTURE_LEVEL1_WIDTH,
          Math.floor(p / SAMPLE_FIXTURE_LEVEL1_WIDTH),
        ),
      )
      const lo = Math.min(...plane)
      const span = Math.max(...plane) - lo
      if (span <= 0) continue
      for (let p = 0; p < pixels; p++) {
        const v = Math.round((plane[p] - lo) * (255 / span))
        if (v > want[p * 4]) want[p * 4] = v
      }
    }
    for (let p = 0; p < pixels; p++) {
      const v = want[p * 4]
      want[p * 4 + 1] = v
      want[p * 4 + 2] = v
      want[p * 4 + 3] = 255
    }
    let mismatches = 0
    for (let i = 0; i < want.length; i++) if (underlay.data[i] !== want[i]) mismatches++
    expect(mismatches).toBe(0)
  })
})
