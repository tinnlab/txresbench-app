// omeTiffUnderlay.ts — the raster → `ImageUnderlay` reduction (#159).
//
// #158 shipped the READER (`omeTiffPyramid.ts`): a lazy, range-reading `PixelSource[]` that the
// tiled `MultiscaleImageLayer` consumes. This is the OTHER half the wire declares — the
// single-texture `ImageUnderlay` (`data/wire.ts`), which is what `DataSource.imageUnderlay()`
// returns and what the raster pane falls back to when a source offers no pyramid.
//
// It lives beside the reader, and NOT in `src-app/ui`, for one concrete reason: every type it
// needs — `Affine`, `invertAffine`, `IDENTITY_AFFINE`, `ImageUnderlay` — is internal to this
// package. Putting the reduction in the app would mean exporting three internals so that pixel
// arithmetic and affine inversion could happen one layer up, in the module that is supposed to
// know only about transport.
//
// ── TWO THINGS THIS FILE REFUSES TO DO, AND WHY ────────────────────────────────────────────
//
// 1. IT NEVER READS LEVEL 0. The underlay is ONE materialized texture; whatever level it names,
//    it decodes in full. Level 0 of the Visium hires fixture is 1400x1800x4 = 10 MB, and of a
//    whole-slide raster it is gigabytes. `docs/design/spatial-storage-layout.md` §2.4 —
//    *"a browser can read a slice of a multi-GB artifact without materializing it"* — is the
//    invariant that forbids it, and it is invisible from the rendered output: a level-0 underlay
//    looks IDENTICAL, just sharper, right up until the artifact is big. So the coarsest level is
//    the contract, asserted by name in the tests, not an optimization to be tuned away later.
//
// 2. IT NEVER COMPOSES A PIXEL SIZE OVER THE PLACEMENT. `omeTiffPyramid.ts`'s
//    `omeTiffModelMatrix` doc-comment records it: the OME `PhysicalSizeX`, the coordinate
//    space's `microns_per_pixel` and `to_space[0]` are three different numbers, the third being
//    exactly the ratio of the first two. `to_space` ALREADY maps emitted pixels into the space.
//    Composing a pixel size over it multiplies the placement by that pitch and draws a perfectly
//    plausible tissue image at the wrong size in the wrong place. Nothing here touches
//    `physicalSize`.
//
//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]
//    For the committed vendor bundle the importer derives 4.4149 / 0.88298 / 5.0 today, i.e. a
//    4.41x error if composed.
//    [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]
//    #158 measured 3.7357 / 0.7471 / 5.0 on the pre-#222 emit. The two
//    micron magnitudes are slide-dependent and moved at #222; `to_space[0]` did not, and cannot —
//    it is `1/tissue_hires_scalef`, and `PhysicalSizeX` is `microns_per_pixel` over that same
//    scalefactor, so it is their ratio by construction. `omeTiffUnderlay.test.ts` asserts that
//    the artifact's three DECLARED fields really do agree that way, rather than taking it from
//    this comment.

import type { ImageMeta, ImageUnderlay } from '../data/wire'
import { IDENTITY_AFFINE, invertAffine, type Affine } from '../data/image'
import type { OmeTiffPyramid } from './omeTiffPyramid'

/**
 * The largest single texture this reduction will materialize, in PIXELS (16 MB as RGBA).
 *
 * ── WHY AN ABSOLUTE CAP AND NOT JUST "THE COARSEST LEVEL" ──────────────────────────────────
 * "The coarsest level" is a RELATIVE rule and it was, for one round, dressed up here as an
 * absolute one. The number of levels is chosen by the WRITER: a three-level pyramid over a
 * 100k x 100k raster has a 25k x 25k coarsest level, which is a 2.5 GB RGBA allocation — yielded
 * as one chunk and copied again downstream. That is precisely the materialization
 * `docs/design/spatial-storage-layout.md` §2.4 forbids, and the coarsest-level rule does not
 * prevent it; it only makes it less likely on the images we happen to emit today.
 *
 * Over the cap, the single-texture reduction REFUSES. It does not degrade to a coarser
 * approximation (there is none — this IS the coarsest level) and it does not silently truncate.
 * Refusing is the correct outcome and it costs nothing a user can see: the tiling
 * `imagePixelSource()` path renders exactly this image, from the viewport, at any size. The
 * single texture is the FALLBACK, and an image too large to materialize is exactly the image
 * that must not use it.
 */
export const MAX_UNDERLAY_PIXELS = 4_194_304 // 2048 x 2048

/** Thrown when a resolved pyramid cannot be reduced to a displayable single texture. */
export class OmeTiffUnderlayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OmeTiffUnderlayError'
  }
}

/**
 * The image is FINE — it is simply too large to be one texture.
 *
 * Its own class because a caller must be able to tell it from every other refusal, and the
 * first cut of the cap did not let it: a catalog that treated "too big for a fallback texture"
 * as "cannot be opened" reported `hasImage: false`, which withdrew the raster chart type
 * entirely and left the ONE case the tiling path exists for — the gigapixel image — with no way
 * to render at all. The repair had disabled exactly what it was protecting.
 */
export class OmeTiffTooLargeForOneTextureError extends OmeTiffUnderlayError {
  constructor(message: string) {
    super(message)
    this.name = 'OmeTiffTooLargeForOneTextureError'
  }
}

/**
 * A producer-declared placement this reader will not guess at.
 *
 * Also its own class: it is a PRODUCER BUG, and a consumer that files it next to a busy object
 * store loses the one distinction the refusal exists to draw.
 */
export class OmeTiffPlacementError extends OmeTiffUnderlayError {
  constructor(message: string) {
    super(message)
    this.name = 'OmeTiffPlacementError'
  }
}

/**
 * The affine an `ImageUnderlay` carries, for the level actually being served.
 *
 * ── THE DIRECTION, STATED, BECAUSE BOTH ARE PLAUSIBLE AND ONLY ONE IS RIGHT ────────────────
 * `ImageUnderlay.affine` is declared in `data/wire.ts` as *"mapping point coords → image px"*,
 * and its one consumer proves that reading: `RasterUnderlayScatterView` applies it to the
 * POSITIONS (`transformPositions(positions, affine)`) while the bitmap sits at raw pixel bounds.
 * The artifact's declared `to_space` runs the OTHER way — emitted pixels → the coordinate space.
 * So it is INVERTED here. Getting this backwards does not throw and does not look broken in any
 * unit test that round-trips its own value; it silently scales every overlay by the square of
 * the scalefactor.
 *
 * ── AND THE LEVEL ──────────────────────────────────────────────────────────────────────────
 * `to_space` is stated for LEVEL 0. The underlay is the COARSEST level, whose pixels are
 * `downsample` times bigger, so the space→pixel map is divided by that factor. A correct
 * inversion at the wrong level is the second way to be plausibly wrong here.
 *
 * `toSpace` absent ⇒ array-index units (identity at level 0), which is the honest answer for an
 * artifact that declares no placement — the same stance `omeTiffPyramid.ts` takes for an absent
 * `micronsPerPixel`. It is NOT a fabricated placement: an un-placed raster is un-overlayable,
 * and pretending otherwise is what would make the wrongness invisible.
 */
export function underlayAffine(
  toSpace: readonly number[] | undefined,
  /**
   * The level's shrink factor PER AXIS — `[level0Width / levelWidth, level0Height / levelHeight]`.
   *
   * Two numbers, not one, because the shipped level table derives its single `downsample` from
   * the WIDTH alone. On an odd-width chain (1401 -> 700 -> 350) that is 2.0014, not 2, and using
   * it for the y rows applies a width-derived factor to a height whose true ratio is different.
   * Sub-pixel on realistic images, and exactly the kind of quietly-wrong number this function is
   * otherwise written to refuse.
   */
  downsample: readonly [number, number],
): Affine {
  const [dx, dy] = downsample
  for (const d of [dx, dy]) {
    if (!Number.isFinite(d) || d <= 0) {
      throw new OmeTiffUnderlayError(`underlayAffine: a level shrink factor must be positive (got ${d})`)
    }
  }
  const spaceToLevel0 = toSpace === undefined ? IDENTITY_AFFINE : invertAffine(asAffine(toSpace))
  // Row 1 maps into the level's X, row 2 into its Y — so each row scales by its OWN axis factor.
  const kx = 1 / dx
  const ky = 1 / dy
  return [
    spaceToLevel0[0] * kx,
    spaceToLevel0[1] * kx,
    spaceToLevel0[2] * kx,
    spaceToLevel0[3] * ky,
    spaceToLevel0[4] * ky,
    spaceToLevel0[5] * ky,
  ]
}

/**
 * How much smaller level `index` is than full resolution: **2^index, on both axes.**
 *
 * ── THIS IS THE ONE NUMBER IN THIS FILE THAT LOOKS DERIVABLE AND IS NOT ────────────────────
 * It went through two wrong answers before this one, and both were plausible:
 *
 *   * the level table's own `downsample` scalar, which is `width0 / width` — width-derived, so
 *     applying it to the y rows uses a width ratio on a height with a different one;
 *   * then a per-axis ratio, `width0/width` and `height0/height` — which fixes the axis mismatch
 *     and CEMENTS a wrong quantity. On an odd chain (1401 -> 700 -> 350) that ratio is 4.00286,
 *     and 4.00286 is an ARTEFACT of integer truncation, not a measurement of anything.
 *
 * The truth is upstream and it is exact. The writer crops from the end and box-means by exactly
 * `factor`, and `assertHalvingPyramid` REFUSES any level that is not `floor(previous / 2)` —
 * its own message says why: *"The image layer places every tile on the assumption that each
 * level is the previous one halved, so a level that is not would render in the wrong place
 * rather than fail."* So level-`index` pixel *i* covers full-resolution pixels
 * `[2^index · i, 2^index · (i+1))`, exactly, and `ngffForLevels` declares the same thing when
 * it writes each level's scale as `scale * 2 ** index`.
 *
 * Taking the dimension ratio instead would put this reduction's placement ~0.3% away from the
 * TILED path's on any odd-dimension chain — two renderings of one artifact disagreeing, with
 * nothing anywhere saying so.
 */
function shrinkOf(pyramid: OmeTiffPyramid, index: number): readonly [number, number] {
  const level = pyramid.meta.levels[index]
  if (!level || level.width <= 0 || level.height <= 0) {
    throw new OmeTiffUnderlayError(`omeTiffUnderlay: level ${index} declares no usable extent`)
  }
  const factor = 2 ** index
  return [factor, factor]
}

/**
 * A producer-declared placement, validated.
 *
 * A DECLARED-BUT-MALFORMED placement throws; only an ABSENT one falls back to array-index units.
 * The distinction is the whole point: absence is a fact about the artifact (it declares no
 * placement, so it is un-overlayable and says so), while a 4-element or NaN-bearing `to_space` is
 * a producer bug, and quietly substituting identity for it would render the raster in the wrong
 * place with nothing anywhere saying so — the failure mode this epic has paid for twice.
 *
 * Six elements specifically, because that is also the length `compact_declaration` truncates: a
 * `to_space` read off a summary row instead of the full `Artifact.meta` arrives MISSING, not
 * short. Both routes land here.
 */
function asAffine(toSpace: readonly number[]): Affine {
  if (toSpace.length !== 6 || !toSpace.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new OmeTiffPlacementError(
      `omeTiffUnderlay: the artifact declares a placement of ${toSpace.length} value(s) ` +
        `(${JSON.stringify(toSpace)}) — a 2x3 row-major affine [a,b,tx,c,d,ty] has exactly 6 finite ` +
        'numbers. Reading it off a compacted summary row rather than the full artifact metadata ' +
        'produces exactly this.',
    )
  }
  return [toSpace[0], toSpace[1], toSpace[2], toSpace[3], toSpace[4], toSpace[5]]
}

/**
 * The underlay's SHAPE — everything `DatasetCatalog.image` needs — WITHOUT decoding a pixel.
 *
 * Split out from {@link omeTiffUnderlay} because `catalog()` has to state `width`/`height`/
 * `channels`/`affine` for the texture it will later serve, and a catalog that decoded a raster to
 * answer that would put a full level decode on the path of merely opening a project. Everything
 * here comes from the pyramid's already-resolved level table.
 *
 * The two functions MUST agree, and a test pins that they do — a catalog describing a different
 * texture than the one `imageUnderlay()` returns is the shape that makes
 * `asDataSource.imageUnderlay()` reconstitute a correctly-sized header over the wrong bytes.
 */
export function omeTiffUnderlayMeta(
  pyramid: OmeTiffPyramid,
  toSpace?: readonly number[],
  space?: string,
): ImageMeta {
  const index = pyramid.pyramid.length - 1
  const level = pyramid.meta.levels[index]
  if (!level) throw new OmeTiffUnderlayError('omeTiffUnderlayMeta: the pyramid resolved no levels')
  assertMaterializable(level.width, level.height, index)
  return {
    width: level.width,
    height: level.height,
    channels: 4,
    affine: underlayAffine(toSpace, shrinkOf(pyramid, index)),
    // ── THE FRAME, CARRIED (#228) ─────────────────────────────────────────────────────────
    // The space id and the FULL-RESOLUTION placement ride out on the SAME call, from the SAME
    // artifact row, as the served level's `affine` above. That is deliberate and it is the
    // #214 rule: one route to one fact. A second reader that fetched the placement separately
    // would be a second route, and two routes to one fact is how they come to disagree.
    //
    // `toSpace` is passed through UNVALIDATED here, exactly as it already is for `affine` —
    // `underlayAffine` refuses a malformed one, and the consumer that builds a model matrix
    // refuses it again. This function's job is to carry the declaration, not to judge it.
    ...(space === undefined ? {} : { space }),
    ...(toSpace === undefined ? {} : { toSpace }),
  }
}

/** The cap, applied identically by both entry points — so a catalog can never advertise a
 *  texture the reduction would then refuse to build. */
function assertMaterializable(width: number, height: number, index: number): void {
  const pixels = width * height
  if (pixels > MAX_UNDERLAY_PIXELS) {
    throw new OmeTiffTooLargeForOneTextureError(
      `omeTiffUnderlay: the coarsest level (${index}) is ${width}x${height} = ${pixels} pixels, ` +
        `over the ${MAX_UNDERLAY_PIXELS}-pixel single-texture cap. This image is too large to ` +
        'materialize as one texture and must be rendered from its resolution pyramid, which ' +
        'reads only the viewport. Refusing rather than allocating ' +
        `${(pixels * 4) / 1e6} MB.`,
    )
  }
}

/**
 * `[min, max]` over the first `used` samples of every pixel, or `[0, 0]` for an empty raster.
 *
 * STRIDED, and that is the correction: the first version scanned the whole buffer, which on an
 * interleaved raster mixes every channel into one window. `used < stride` is the case where that
 * matters — a raster whose extra samples are not being displayed must not drag the window of the
 * ones that are.
 */
function extremes(data: ArrayLike<number>, pixels: number, stride: number, used: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let p = 0; p < pixels; p++) {
    const base = p * stride
    for (let k = 0; k < used; k++) {
      const v = data[base + k]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : [0, 0]
}

/**
 * Reduce a resolved pyramid to the single RGBA texture `ImageUnderlay` declares.
 *
 * ALWAYS RGBA (`channels: 4`), whatever the file holds — which is what lets a caller state
 * `DatasetCatalog.image.channels` before any pixel is read. Two paths, and the split is on
 * whether the bytes ARE already display colour:
 *
 *   * 8-bit interleaved colour (RGB / RGBA, i.e. every H&E raster this system emits) is copied
 *     THROUGH, with an opaque alpha synthesized for the 3-sample case. No windowing, no
 *     rescaling — the pixels a user sees are the pixels in the file.
 *   * a PLANAR SAMPLE STACK (a 2-sample or 5..10-sample file, which the loader reads as one
 *     channel per sample since #288) is reduced by reading EVERY channel, windowing each on its
 *     own extremes, and taking the per-pixel MAXIMUM into grey. Also a display decision, and
 *     stated for the same reason: what it must not do is read `{c: 0}` and call that the image,
 *     which is exactly the #288 defect one layer up. A per-sample COLOUR assignment (channel 0
 *     -> red, ...) is the other candidate and is refused on this file's own standard — it would
 *     be a fabrication about data this function has been told nothing about, and the place a
 *     user gets per-channel colour is `imagePixelSource()`, which now serves every sample.
 *   * anything else (a 16-bit morphology/DAPI plane, a single-sample greyscale) is windowed
 *     through THAT LEVEL'S OWN extremes and replicated into R/G/B. This is a display decision
 *     and it is a real one, so it is stated rather than hidden: a fixed 0..65535 window renders
 *     a typical fluorescence plane as flat black, and hard-coding an instrument's range would be
 *     a fabrication about data this function has not been told anything about. The pyramid path
 *     (`imagePixelSource()`) is the one that gives a user real per-channel contrast control;
 *     this is the fallback texture, and its job is to be legible.
 */
export async function omeTiffUnderlay(
  pyramid: OmeTiffPyramid,
  toSpace?: readonly number[],
): Promise<ImageUnderlay> {
  const index = pyramid.pyramid.length - 1
  const level = pyramid.pyramid[index]
  if (!level) throw new OmeTiffUnderlayError('omeTiffUnderlay: the pyramid resolved no levels')

  // The DECLARED extent of the level, not the decoded raster's own report. The two functions in
  // this file are documented as MUST agree — the catalog states the header and this states the
  // bytes, and a consumer pairs them — so they now read the SAME source, and the decoded raster
  // is checked against it below rather than trusted to match.
  const declared = pyramid.meta.levels[index]
  if (!declared) throw new OmeTiffUnderlayError(`omeTiffUnderlay: level ${index} declares no extent`)
  const width = declared.width
  const height = declared.height
  const pixels = width * height
  if (pixels <= 0) {
    throw new OmeTiffUnderlayError(`omeTiffUnderlay: level ${index} declares an empty extent (${width}x${height})`)
  }
  assertMaterializable(width, height, index)

  const raster = await level.getRaster({ selection: { c: 0 } })
  if (raster.width !== width || raster.height !== height) {
    throw new OmeTiffUnderlayError(
      `omeTiffUnderlay: level ${index} declares ${width}x${height} but decoded ` +
        `${raster.width}x${raster.height} — the catalog header and the served bytes would ` +
        'describe different textures, which renders as a sheared picture rather than an error',
    )
  }

  const source = raster.data as unknown as ArrayLike<number>
  // Samples per pixel, read through the level's own AXIS LABELS. An interleaved raster carries a
  // trailing per-pixel component axis (`_c`); a planar one does not. Positionally — which this
  // read used to be — the same expression is the latent hazard that framed a raster pane on its
  // sample count one layer up, so it is not repeated here.
  const labels = (level.labels ?? []) as readonly string[]
  const componentAxis = labels.lastIndexOf('_c')
  const declaredSamples = pyramid.interleaved
    ? (componentAxis >= 0 ? level.shape[componentAxis] : level.shape[level.shape.length - 1]) ?? 1
    : 1
  // `?? 1` covers null and undefined and nothing else — a component axis declaring 0 would make
  // `pixels * samples` zero, satisfy the exact length guard against an empty buffer, and render
  // the whole texture flat mid-grey with no error. The guard is rewritten precisely to close
  // that class, so it may not have a hole of its own.
  if (!Number.isInteger(declaredSamples) || declaredSamples < 1) {
    throw new OmeTiffUnderlayError(
      `omeTiffUnderlay: level ${index} declares ${String(declaredSamples)} samples per pixel; ` +
        'a raster has at least one',
    )
  }
  const samples = declaredSamples
  // …and the CHANNEL count. `'c'` is the axis `buildRasterImageLayers` issues one selection
  // per, so it is the axis that says how many reads this reduction owes the file. It is 1 for
  // a greyscale plane and for interleaved RGB/RGBA; it is `SamplesPerPixel` for a planar
  // sample stack (#288).
  //
  // ── ONE ROUTE TO THE FACT, PLUS A CROSS-CHECK — NOT TWO ROUTES ─────────────────────────
  // The loader already states it, as `pyramid.channels`, and an earlier cut of this branch
  // re-derived it here off the level's own labels instead. Two routes to one fact is how they
  // come to disagree (#214), and the disagreement would be invisible: a re-derivation that
  // read 1 where the loader declared 5 reduces the texture from sample 0 and reports nothing —
  // the exact defect this branch exists to close. So the LOADER's declaration is authoritative
  // and the level's own axis is the CHECK on it, exactly as `width`/`height` above are declared
  // by `meta.levels` and checked against the decoded raster.
  const channels = pyramid.channels ?? 1
  if (!Number.isInteger(channels) || channels < 1) {
    throw new OmeTiffUnderlayError(
      `omeTiffUnderlay: the pyramid declares ${String(channels)} channel(s); ` +
        'a raster has at least one',
    )
  }
  const channelAxis = labels.indexOf('c')
  const axisChannels = (channelAxis >= 0 ? level.shape[channelAxis] : 1) ?? 1
  if (axisChannels !== channels) {
    throw new OmeTiffUnderlayError(
      `omeTiffUnderlay: the pyramid declares ${channels} channel(s) but level ${index}'s own ` +
        `'c' axis is ${String(axisChannels)}. The header and the served bytes would describe ` +
        'different images, and the reduction would read only the channels one of them names.',
    )
  }

  // EXACT, not `<`. An over-long buffer is the actual signature of a wrong sample count: a
  // buffer of `2 * pixels` values against an expected `pixels` passes a `<` guard, after which
  // consecutive sample PAIRS are read as consecutive PIXELS — a squashed, duplicated image and
  // no error anywhere.
  //
  // The example this used to give was "a 2-sample interleaved file (which the loader does not
  // refuse)". That is no longer the case and the sentence is corrected rather than left: since
  // #288 a 2-sample file is a planar STACK, never classified interleaved, so `samples` is 1 for
  // it and its channel-0 buffer is `pixels` long. What the guard now catches is a source whose
  // declared `_c` extent disagrees with the bytes it serves — still reachable, still silent.
  if (source.length !== pixels * samples) {
    throw new OmeTiffUnderlayError(
      `omeTiffUnderlay: level ${index} decoded ${source.length} values for ${width}x${height}x${samples}. ` +
        'A shorter buffer would build the texture from whatever follows it in memory; a longer one ' +
        'means the sample count is not what the level says it is, and the pixels would be read at ' +
        'the wrong stride.',
    )
  }

  const out = new Uint8Array(pixels * 4)
  // Colour is a property of the SAMPLE LAYOUT, not of the sample WIDTH. The first cut required
  // `Uint8` here, which sent a 16-bit RGB raster — a file the loader accepts without complaint —
  // down the greyscale branch, where it was reduced to its RED channel and windowed against
  // extremes computed over all three. That is a plausible picture and a wrong one.
  const colour = pyramid.interleaved && samples >= 3
  const eightBit = pyramid.meta.dtype === 'Uint8'

  if (colour && eightBit) {
    // Already display colour: copied THROUGH, with an opaque alpha synthesized for RGB.
    for (let p = 0; p < pixels; p++) {
      const s = p * samples
      const d = p * 4
      out[d] = source[s]
      out[d + 1] = source[s + 1]
      out[d + 2] = source[s + 2]
      out[d + 3] = samples >= 4 ? source[s + 3] : 255
    }
  } else if (colour) {
    // Deeper-than-8-bit colour: one window SHARED across R/G/B, so the channel balance survives
    // (three independent per-channel windows would re-tint the image).
    // The window spans the COLOUR channels only — alpha is opacity, not intensity, and letting
    // it into the window re-scales the picture by how transparent it happens to be.
    const [lo, hi] = extremes(source, pixels, samples, 3)
    const span = hi - lo
    const scale = span > 0 ? 255 / span : 0
    // …and a 4th sample is still HONOURED, windowed on its own range, exactly as the 8-bit
    // branch honours it. Writing 255 unconditionally — which this branch did for one round —
    // renders a 16-bit RGBA raster fully opaque with nothing saying so, in the very branch that
    // was added because 16-bit colour was being mishandled.
    const alpha = samples >= 4 ? extremes(source, pixels, samples, 4) : null
    const alphaLo = alpha ? alpha[0] : 0
    const alphaSpan = alpha ? alpha[1] - alpha[0] : 0
    for (let p = 0; p < pixels; p++) {
      const s = p * samples
      const d = p * 4
      for (let k = 0; k < 3; k++) {
        out[d + k] = span > 0 ? Math.round((source[s + k] - lo) * scale) : 128
      }
      out[d + 3] =
        samples >= 4
          ? alphaSpan > 0
            ? Math.round(((source[s + 3] - alphaLo) * 255) / alphaSpan)
            : 255
          : 255
    }
  } else if (channels > 1) {
    // ── THE PLANAR SAMPLE STACK (#288) ──────────────────────────────────────────────────
    //
    // The loader declared `[channels, height, width]` and can serve each sample as its own
    // channel; this reduction owes the file ONE READ PER CHANNEL. Reading `{c: 0}` and
    // windowing it — which is what the branch below would do, and what this function did
    // before #288 — draws sample 0 and calls it the image, silently, which is the whole
    // defect. So every channel is read, windowed on ITS OWN extremes (they are independent
    // measurements; one shared window would let a bright channel flatten a dim one), and the
    // per-pixel MAXIMUM is written to R/G/B.
    //
    // Maximum rather than mean: a mean dilutes a feature present in one channel by the number
    // of channels, which on a 10-channel stack makes a real signal invisible in the very
    // texture whose job is to be legible.
    // ── TWO PLANES RESIDENT, NOT N ──────────────────────────────────────────────────────
    // An earlier cut gathered every channel into an array and composited at the end. The cap
    // above bounds the OUTPUT ("Refusing rather than allocating N MB") and says nothing about
    // the inputs, so at the cap a 10-channel `Uint16` stack held ~84 MB live where the previous
    // code held ~8.4 MB — on `imageUnderlay()`, which runs when a project is opened. The
    // running maximum lives in `out` instead.
    //
    // TWO and not one, stated exactly because an earlier version of this comment said one:
    // `source` is channel 0's raster and stays referenced for the whole loop, so from `c = 1`
    // the peak is two decoded planes plus the texture — ~33.6 MB at the cap, against ~100.7 MB
    // for the gather-everything shape and ~25.2 MB a true one-plane loop would reach. (An
    // earlier version of this line said ~92 MB, which is NINE planes plus the texture: it
    // understated the alternative being argued against by exactly one plane, in the comment
    // whose stated purpose is being exact about the plane count.)
    //
    // ── WHAT THIS COSTS IN READS, AND WHERE IT BITES ────────────────────────────────────
    // The channels are read SEQUENTIALLY, so the in-flight join in `ByteRangeGeoTiffSource`
    // cannot help (nothing is ever concurrently in flight) and the only thing between this and
    // N full re-reads of the level is that source's FIFO span cache. A full-level scan repeated
    // per channel is FIFO's worst case once the level has MORE spans than the cache holds:
    // measured on a 10-sample 2-level pyramid whose coarsest level is 400 strips, transport
    // reads were 400 at a 4096-entry cache, 1696 at the shipped 256, and 3424 at 64.
    //
    // It does not bite the artifacts this system emits, and that is why it is accepted rather
    // than traded away: #227 made every emitted level TILED at 512x512, and `MAX_UNDERLAY_PIXELS`
    // caps the served level at 2048x2048 — 16 tiles, against a 256-entry cache, so every channel
    // after the first is served entirely from it. It degrades on a raw vendor file with a small
    // `RowsPerStrip`, where `limits.spanCacheSize` is the caller's knob. The alternative —
    // reading the channels concurrently so the in-flight join collapses the duplicates — trades
    // the read count back for the N-planes-resident memory this loop was rewritten to remove,
    // and an OOM is not recoverable where a slow open is.
    //
    // ── AND A CONSTANT CHANNEL CONTRIBUTES NOTHING, RATHER THAN 128 ─────────────────────
    // The single-plane branch below maps a zero-span plane to mid-grey, which is right when it
    // IS the whole image. Imported into a MAXIMUM it is a FLOOR: one dead channel — an empty
    // marker, a saturated one, a sparse channel flattened by downsampling, which in a 10-plex
    // panel is the norm rather than the exception — would put 128 at every pixel and cost the
    // texture the bottom half of its range. Measured on an 8-pixel probe: a signal ramping
    // [0,36,73,109,146,182,219,255] became [128,128,128,128,146,182,219,255] beside one blank
    // channel. A channel with no structure contributes NO intensity; `anyStructure` below keeps
    // the all-constant case landing on the same mid-grey the single-plane branch gives it, so
    // "every channel is flat" still reads as a flat image rather than a black one.
    let anyStructure = false
    for (let c = 0; c < channels; c++) {
      let plane: ArrayLike<number>
      if (c === 0) {
        plane = source
      } else {
        // WRAPPED, because `getRaster` can now reject with the loader's own `OmeTiffLoadError`
        // (an out-of-range selection) or a bare geotiff `RangeError` (a level whose sample
        // layout disagrees with level 0). Every other failure in this function is an
        // `OmeTiffUnderlayError`, and a caller discriminating on it must not start seeing types
        // it never saw before because this branch added a read.
        let raster: { data: unknown; width: number; height: number }
        try {
          raster = await level.getRaster({ selection: { c } })
        } catch (cause) {
          throw new OmeTiffUnderlayError(
            `omeTiffUnderlay: level ${index} channel ${c} could not be read ` +
              `(${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}). ` +
              'The pyramid declares this channel, so a source that cannot serve it describes an ' +
              'image it cannot produce.',
          )
        }
        if (raster.width !== width || raster.height !== height) {
          throw new OmeTiffUnderlayError(
            `omeTiffUnderlay: level ${index} channel ${c} decoded ${raster.width}x${raster.height} ` +
              `but channel 0 decoded ${width}x${height} — channels of one image that disagree on ` +
              'their extent would composite pixel n of one against pixel m of another',
          )
        }
        const data = raster.data as unknown as ArrayLike<number>
        if (data.length !== pixels) {
          throw new OmeTiffUnderlayError(
            `omeTiffUnderlay: level ${index} channel ${c} decoded ${data.length} values for ` +
              `${width}x${height}. A channel of a planar stack is one sample per pixel; a ` +
              'different length means the per-sample read returned an interleaved buffer.',
          )
        }
        plane = data
      }
      const [lo, hi] = extremes(plane, pixels, 1, 1)
      const span = hi - lo
      if (span <= 0) continue // no structure: contributes no intensity to a maximum
      anyStructure = true
      const scale = 255 / span
      for (let p = 0; p < pixels; p++) {
        const scaled = Math.round((plane[p] - lo) * scale)
        if (scaled > out[p * 4]) out[p * 4] = scaled
      }
    }
    for (let p = 0; p < pixels; p++) {
      const d = p * 4
      const v = anyStructure ? out[d] : 128
      out[d] = v
      out[d + 1] = v
      out[d + 2] = v
      out[d + 3] = 255
    }
  } else {
    // `samples` is the stride, and it is ALWAYS 1 on this branch: `interleaved` is false here
    // (the colour branches above took every 3- and 4-sample file) and `channels` is 1 (the
    // sample-stack branch above took every planar file with more than one), so a raster
    // reaching this line is single-sample by construction. It is passed rather than hardcoded
    // because it is the CORRECT expression either way. A mutation to `1` survives the suite,
    // and that is an equivalent mutant rather than a coverage hole.
    const [lo, hi] = extremes(source, pixels, samples, 1)
    const span = hi - lo
    // A CONSTANT plane (span 0) windows to mid-grey rather than dividing by zero. It is a
    // legitimate image — an empty tile, a saturated one — not an error.
    const scale = span > 0 ? 255 / span : 0
    for (let p = 0; p < pixels; p++) {
      const v = span > 0 ? Math.round((source[p * samples] - lo) * scale) : 128
      const d = p * 4
      out[d] = v
      out[d + 1] = v
      out[d + 2] = v
      out[d + 3] = 255
    }
  }

  return {
    data: out,
    width,
    height,
    channels: 4,
    affine: underlayAffine(toSpace, shrinkOf(pyramid, index)),
  }
}
