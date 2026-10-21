// omeTiffPyramid.ts — the production OME-TIFF `PixelSource[]` loader (#158).
//
// The tree already ships the RENDERER: Viv's `MultiscaleImageLayer` / `ImageLayer` are
// imported by `rasterImageLayers.ts`, the grid's dense `image` cell builds them, and there
// is a GPU label-mask shader beside them. What it did NOT ship is a READER — no
// `loadOmeTiff` call, no `ZarrPixelSource`, and `imageMeta.parseMultiscales` with exactly
// two callers, a fixture and its own test. Nothing in the tree ever issued a tile request
// for an image. This module is that reader.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────────────────
// Given a `ByteRangeSource` (a byte length + an inclusive-span read) it opens an OME-TIFF
// over HTTP RANGE READS and returns the resolution pyramid the seam declares:
//
//     imagePixelSource?(): Promise<PixelSource<['c']>[]>
//     "index 0 = full resolution, each subsequent entry half-scale"   — data/wire.ts:263-266
//
// A pyramidal image behaves like a map: zoomed out you fetch a few tiles of a low-resolution
// level; zoomed in you fetch only the tiles covering the viewport at the level matching the
// zoom. Same as map tiles, except the whole pyramid is ONE file, and the TIFF's own IFD
// directory gives the byte offset of every strip/tile — so a tile is a byte span, and a byte
// span is a range request.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────
// * It does not know what an artifact is. `ByteRangeSource` is the ONLY seam to storage, and
//   `viz-core` may not import a backend or a storage module (the rule every file in this
//   directory carries). The app supplies the source; this file supplies the pixels.
// * It does not parse the OME-XML placement. The SAME dict the writer puts in the file's
//   `<Description>` is also the artifact's declared `meta` on the wire, and the registration
//   QC already cross-checks the two copies and fails on divergence — so there is no reason
//   for a second grammar over those bytes. `omeTiffModelMatrix` takes the affine as data.
// * It does not decode a lossy codec. See `UnsupportedImageCodecError`.
//
// ── WHY IT BUILDS ITS OWN `TiffPixelSource` INSTEAD OF CALLING `loadOmeTiff` ──────────────
// Viv derives the tile edge as `prevPowerOf2(min(getTileWidth(), getTileHeight()))`, i.e. it
// reads the FILE's storage layout and requests whatever that layout happens to be. This
// module supplies 512 itself instead, and the reason is that those are two different
// questions — what the bytes are stored in, and what the viewer should ask for.
//
// Since #227 every image this system emits is tiled at 512 (`ome_writer.TILE`), so on OUR
// artifacts Viv's rule now lands on 512 too and the two agree. That agreement is not the
// justification and must not be mistaken for one: `ome_writer.py`'s own comment on `TILE`
// says the causality runs the other way — *"512 here is not 'agreeing with a value the reader
// computes'; it is agreeing with the value the reader REQUESTS."* Deriving the request from
// the file would close that loop with nothing pinning either end.
//
// It also only agrees for files WE wrote, and this reader is deliberately not confined to
// those (see `tiledOfDirectory`). Measured on the committed corpus, both files real:
//
//   `spatial-image-hires-stripped.ome.tif`  RowsPerStrip=62   -> prevPowerOf2(62)  =  32
//   `tiled-deflate.ome.tif`                 TileWidth=256     -> prevPowerOf2(256) = 256
//
// The first is the layout this system itself emitted before #227 and is what a stripped vendor
// file looks like: 32 is ~2040 deck tiles for one 1920x1080 full-resolution viewport. The
// second is a third-party file tiled at an edge that is not ours, and it shows the derived
// value is a per-FILE lottery rather than a two-way choice between 512 and a disaster.
// `TiffPixelSource` is exported with a public constructor that takes the tile size,
// so we supply our own level indexer (IFD 0 + `SubIFDs`, which is exactly what Viv's own
// indexer does, via public geotiff API) and keep every byte of Viv's `_readRasters`,
// interleave handling and tile-extent maths.
//
// ── THE viz-core DEPENDENCY RULE, RESTATED FOR THIS FILE ─────────────────────────────────
// Its siblings say "depends ONLY on @deck.gl/core + @math.gl + @hms-dbmi/viv. No
// backend/storage import." This file adds a FOURTH runtime dependency, `geotiff` — the TIFF
// container reader Viv itself decodes with, and the one the design names by name ("Viv reads
// it via geotiff.js range requests"). It is a pure FORMAT library: it parses bytes handed to
// it and knows nothing about this application. The half of the rule that carries the weight
// — no backend, no storage, no app import — is unchanged and is asserted by a test that
// scans this file's static AND dynamic import specifiers.
//
// DEC-28 generic naming: this file knows about images, levels, channels and codecs, and
// nothing about biology.

import { GeoTIFF, GeoTIFFImage } from 'geotiff'
import { TiffPixelSource, MAX_CHANNELS } from '@hms-dbmi/viv'
import type { PixelSource, SupportedDtype } from '@vivjs/types'
import { affineToModelMatrix } from '../data/affineMatrix'
import type { Affine } from '../data/image'
import {
  parseMultiscales,
  type NgffImage,
  type NgffArrayMeta,
  type NormalizedImageMeta,
} from './imageMeta'

/** The label set the seam and `buildRasterImageLayers` accept: channel selection only. */
export type ChannelLabels = ['c']

// ── the storage seam ─────────────────────────────────────────────────────────────────────

/**
 * The ONE thing this loader needs from storage: how long the file is, and how to read an
 * inclusive byte span of it. Deliberately two members and nothing else — no URL, no auth, no
 * artifact id, no member path. `src-app/ui` supplies an implementation over the artifact
 * byte plane; a test supplies one over an `ArrayBuffer` or a local HTTP server; neither is
 * visible from here.
 *
 * `byteLength` is REQUIRED rather than discovered, and that is load-bearing rather than
 * convenient: the `?range=` dialect refuses `a-b` when `b >= total` with a **416** (it does
 * not clamp — only the `Range:` HEADER form clamps), while geotiff's block reader aligns
 * every fetch to a block boundary and therefore asks past the end of the file routinely. The
 * last block of a file is where the pyramid's SubIFD directories live, so without a length
 * to clamp against, every pyramidal image would fail on the one read it cannot do without.
 */
export interface ByteRangeSource {
  /** total size of the file, in bytes. */
  readonly byteLength: number
  /**
   * The bytes `[start, endInclusive]`. `endInclusive` is already clamped by the caller.
   *
   * `signal` is the one geotiff hands down from `getTile({ signal })`, which is how deck.gl
   * abandons a tile the user has panned away from. Forwarding it is what stops an abandoned
   * viewport's reads from competing with the live one; an implementation that cannot cancel
   * may ignore it.
   */
  read(start: number, endInclusive: number, signal?: AbortSignal): Promise<ArrayBuffer>
}

// ── errors ───────────────────────────────────────────────────────────────────────────────

/**
 * Base for every refusal this loader itself states, so a caller can branch on one type.
 *
 * A TRANSPORT failure is deliberately NOT wrapped in one of these: the byte source's own
 * typed error — a `WorkstoreHttpError` carrying a status and an error code, say — reaches the
 * caller unchanged, because that is what tells a caller to refresh a token rather than to
 * show an error. Preserving it is one of the reasons this module implements geotiff's byte
 * source directly: the shipped remote path collects failures with `Promise.allSettled` and
 * re-raises `AggregateError('Request failed')` whose `errors` array is `[undefined]`, which
 * turns an expired token, an unclamped span and a dead socket into the same three words.
 */
export class OmeTiffLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OmeTiffLoadError'
  }
}

/**
 * The file holds more than one image PLANE — a multi-channel OME-TIFF whose channels are
 * separate top-level IFDs, or a planar (`PlanarConfiguration = 2`) multi-sample file.
 *
 * Refused by NAME rather than read partially, and that is the whole point of it existing.
 * The pyramid this loader returns declares a channel axis, and `buildRasterImageLayers`
 * derives one selection per channel from it; a loader that returned a source whose declared
 * channel count it cannot honour would render channel 1 with channel 0's pixels — the same
 * "right pixels, wrong meaning" class the halving guard refuses, and strictly worse than the
 * codec refusal beside it, because nothing would say so.
 *
 * ── WHAT THIS REFUSAL DOES *NOT* COVER ANY MORE (#288) ────────────────────────────────
 * This block used to end: *"Every image this system EMITS is a single plane (interleaved RGB
 * or one greyscale sample), so this refusal names a raw vendor file reaching the reader, not
 * one of our artifacts."* That was a claim about the WRITER, and #266 changed what holds it
 * up. It was true then because the writer MIS-DECLARED any other sample count (it wrote
 * `SizeX = S`); it is true today because the writer REFUSES them by name
 * (`ome_writer.READABLE_SAMPLE_COUNTS == (1, 3, 4)`), which is a very different guarantee,
 * and it was never a property this reader could rely on for a raw vendor file.
 *
 * So the reader no longer rests on it. `SamplesPerPixel` outside `{1, 3, 4}` is handled here
 * rather than left to the writer: 2 and 5..10 samples are READ, as one channel per sample
 * (`docs/design/ome-tiff-reader-sample-counts.md` §3), and a count this application cannot
 * render is `SampleCountUnsupportedError` below. The writer's refusal is NOT lifted by that
 * change — that is a `spatial-types` follow-up to #266, which this reader unblocks rather
 * than performs.
 *
 * This class keeps the two cases that are genuinely more than one PLANE: channels stored as
 * separate top-level IFDs, and `PlanarConfiguration = 2`. Neither is representable as the one
 * `GeoTIFFImage` per level this loader indexes.
 */
export class MultiPlaneImageUnsupportedError extends OmeTiffLoadError {
  constructor(
    readonly planes: number,
    readonly detail: string,
  ) {
    super(
      `this OME-TIFF holds ${planes} image plane(s) (${detail}). This loader indexes ONE ` +
        '`GeoTIFFImage` per pyramid level and refuses rather than return a pyramid whose ' +
        'declared channel axis it cannot honour, which would render every channel with the ' +
        'first one\'s pixels and report nothing.',
    )
    this.name = 'MultiPlaneImageUnsupportedError'
  }
}

/**
 * The renderer's channel ceiling — **Viv's own `MAX_CHANNELS`, imported, not restated.**
 *
 * An earlier cut of this was the literal `10` under a comment arguing that importing it would
 * not make it safer because "`@vivjs/constants` is not in this package's dependency list". That
 * was simply false: `@hms-dbmi/viv` — a declared dependency, already imported by
 * `rasterImageLayers.ts` — re-exports `MAX_CHANNELS`. The same comment claimed a test pinned
 * the number against the shipped layer builder, and no such test existed. Two wrong reasons for
 * a hard-coded copy of someone else's constant is exactly the rot this file's `[frozen-magnitude]`
 * neighbours exist to prevent, so the copy is gone.
 *
 * Taking it from Viv means a Viv upgrade that LOWERS the cap tightens this refusal in the same
 * commit, instead of leaving a window where a 7-sample file opens here and then throws
 * `${n} channels passed in, but only ${MAX_CHANNELS} are allowed.` from inside deck.gl's render
 * loop. `omeTiffSampleCounts.test.ts` covers BOTH sides of the boundary against real committed
 * files — a 10-sample one that must open and render, an 11-sample one that must be refused —
 * so a cap that moved in either direction reddens a test.
 */
export const MAX_RENDERABLE_CHANNELS: number = MAX_CHANNELS

/**
 * The file carries a sample count this application cannot RENDER (#288).
 *
 * ── WHY THIS IS AN OPEN-CALL REFUSAL AND NOT A RENDER-TIME ONE ────────────────────────────
 * `@vivjs/layers`' `padContrastLimits` throws ``\`${n} channels passed in, but only
 * ${MAX_CHANNELS} are allowed.\`` from inside deck.gl's render loop — once per tile, naming
 * no file. That is the same condition `assertDecodableCodec` exists to move forward, for the
 * same reason: it is knowable from the IFD before a single tile is fetched.
 *
 * ── AND WHY IT IS A REFUSAL AND NOT A PARTIAL RENDER ──────────────────────────────────────
 * The alternative this replaces was not "show the first ten channels" — it was `interleaved`
 * being false, the source being declared `[1, height, width]` over `N`-sample bytes, and
 * `TiffPixelSource._readRasters` taking `raster[0]`. **Sample 0 drawn as the whole image,
 * with nothing saying so.** A named refusal costs the user this one image and tells them
 * which; the partial render costs them the truth about every image like it.
 */
export class SampleCountUnsupportedError extends OmeTiffLoadError {
  constructor(readonly samples: number) {
    super(
      `this OME-TIFF declares SamplesPerPixel = ${samples}, which this application cannot ` +
        `render: a sample count must be an integer in 1..${MAX_RENDERABLE_CHANNELS} (1 is a ` +
        'greyscale plane, 3 and 4 are interleaved RGB/RGBA, and 2 or 5..' +
        `${MAX_RENDERABLE_CHANNELS} are read as one channel per sample). The ceiling is the ` +
        "RENDERER's, not the format's — Viv's layers cap a channel stack at " +
        `${MAX_RENDERABLE_CHANNELS} and throw from inside the render loop above it. Refusing ` +
        'here rather than declaring a one-channel source over interleaved bytes, which would ' +
        'draw sample 0 as the whole image and report nothing.',
    )
    this.name = 'SampleCountUnsupportedError'
  }
}

/**
 * The file's pixels are compressed with a codec no browser TIFF decoder can read.
 *
 * The case this exists for is JPEG-2000 (`34712`), which is what every 10x Xenium
 * morphology image ships as. That is an INPUT format: the importer decodes it with
 * `imagecodecs` and re-encodes losslessly as deflate, and a lossy codec is refused as an
 * emitted codec — so an imported image artifact is never JPEG-2000, and meeting one means
 * meeting a raw vendor file rather than one of ours.
 *
 * Raised from the OPEN call, once, naming the tag. Without it the same condition surfaces as
 * geotiff's bare `Unknown compression method identifier: 34712` from inside deck.gl's render
 * loop, once per tile, with nothing saying which file or why.
 */
export class UnsupportedImageCodecError extends OmeTiffLoadError {
  constructor(
    readonly compression: number,
    readonly codecName: string,
  ) {
    super(
      `this OME-TIFF is compressed with ${codecName} (TIFF Compression tag ${compression}), ` +
        'which no browser TIFF decoder in this application can read. Lossy codecs are ' +
        'refused as an emitted codec, so an image artifact is never stored this way — a ' +
        'file that is means a raw vendor image reached the reader instead of an imported one.',
    )
    this.name = 'UnsupportedImageCodecError'
  }
}

/** A pyramid level is not the previous level halved. See `assertHalvingPyramid`. */
export class NonHalvingPyramidError extends OmeTiffLoadError {
  constructor(message: string) {
    super(message)
    this.name = 'NonHalvingPyramidError'
  }
}

// ── limits (DEC-5 / DEC-6) ───────────────────────────────────────────────────────────────

/**
 * The loader's operational tunables, as a named struct rather than inline literals, so
 * promoting any of them to a configured value later is a wiring change and not a rewrite.
 *
 * They are deliberately NOT an admin settings row: the tree's settings-singleton pattern is
 * for SERVER tunables (a table, a migration, a permission pair, a sync entity, an admin
 * card), and every value here is a browser render knob with no cross-tenant consequence and
 * no operator failure mode.
 */
export interface OmeTiffPyramidLimits {
  /**
   * The tile edge, in pixels, that each level's `PixelSource` reports and that deck.gl's
   * tile layer therefore requests. 512 is deck/Viv's conventional edge.
   *
   * ── IS THIS OVERRIDE STILL NEEDED AFTER #227? YES (#259). ──────────────────────────────
   * The question is worth writing down because the obvious reading says no. Since #227 the
   * writer tiles every emitted image at 512, so Viv's own derivation
   * (`prevPowerOf2(min(TileWidth ?? width, TileLength ?? RowsPerStrip))`) now yields 512 for
   * our artifacts — the same number this constant names. Three reasons it is not therefore
   * redundant, in increasing order of how much they would cost to learn the hard way:
   *
   *   1. **The agreement is only over files WE emit.** This reader handles third-party
   *      OME-TIFFs on purpose, and those are routinely stripped or tiled at some other edge.
   *      Measured on the committed corpus: `spatial-image-hires-stripped.ome.tif`
   *      (`RowsPerStrip = 62`, the pre-#227 emit) derives **32**, i.e. ~2000 deck tiles for one
   *      full-resolution viewport; `tiled-deflate.ome.tif` (`TileWidth = 256`) derives **256**.
   *      A derived edge is a per-file lottery; this one is a contract.
   *   2. **Deriving it would be circular.** The writer chose 512 to MATCH this request size,
   *      not the other way round (`ome_writer.py`, `TILE`). Reading it back off the file
   *      would leave the pair defined only in terms of each other.
   *   3. **There is no simplification on the other side of it.** This module never calls
   *      `loadOmeTiff` — it builds `TiffPixelSource` with its own level indexer for reasons
   *      unrelated to tile size (up-front codec and sample-count refusals, its own
   *      `ByteRangeGeoTiffSource`). Removing the constant would replace a named value with a
   *      per-file derivation and delete no code.
   *
   * Pinned executably rather than left as prose: #259 TEST-6 asserts the source built over
   * the STRIPPED control still reports 512, which is exactly the case a derived edge loses.
   */
  tileSize: number
  /**
   * How many distinct byte spans the client remembers within one open image.
   *
   * There is deliberately no geotiff block layer under this at all — the module implements
   * geotiff's byte source itself (see `ByteRangeGeoTiffSource`), which is a correctness
   * decision rather than a tuning one. Two measured reasons:
   *
   *   1. **`BlockedSource` throws on a block boundary.** In the pinned geotiff (2.1.3) a slice
   *      whose end lands exactly on a multiple of the block size computes a `blockIdHigh` for
   *      a block `fetch()` never fetched, and dereferences `undefined`. Reproduced against the
   *      pinned version for an interior slice and for a slice ending at an EOF that is a block
   *      multiple; a non-multiple end is fine. Each strip read is an independent chance, so it
   *      is invisible on a 30-strip image and likely on a real one — arriving as a bare
   *      `TypeError` from inside the render loop, naming neither the file nor the span.
   *   2. **It made the caching claim false.** `groupBlocks` merges CONSECUTIVE MISSING blocks
   *      into one span whose length depends on what happens to be cached at that instant, so
   *      "the same block is always the same URL" — the reason to prefer the cacheable `?range=`
   *      dialect at all — did not hold.
   *
   * Without that layer, every request is exactly the span the TIFF reader asked for: one strip
   * or one tile, at a byte offset the file's own directory fixes. Those URLs are stable across
   * sessions, which is what makes the byte plane's `immutable` header do real work, and it is
   * the model the design describes — one tile, one range request.
   */
  spanCacheSize: number
}

export const DEFAULT_OME_TIFF_LIMITS: Readonly<OmeTiffPyramidLimits> = Object.freeze({
  tileSize: 512,
  spanCacheSize: 256,
})

// ── the geotiff byte source ──────────────────────────────────────────────────────────────

/**
 * The byte source geotiff reads the TIFF through: `fetch(slices)` in, `ArrayBuffer[]` out.
 *
 * ── WHY THIS AND NOT `fromUrl` / `fromCustomClient` ──────────────────────────────────────
 * geotiff's shipped remote path is `BaseClient -> RemoteSource -> BlockedSource`, and all
 * three layers are wrong for this transport:
 *
 *   * `BaseClient` speaks HTTP responses — a status line, a `Content-Range`. Our byte plane
 *     answers a span with a **200**, because the URL names the span; going through that layer
 *     means manufacturing a 206 for a response that is not one, to satisfy a check that only
 *     exists to catch a server ignoring `Range:`.
 *   * `RemoteSource` asks for `bytes=<offset>-<offset + length>` — an INCLUSIVE end, i.e. one
 *     byte more than it will use, on every single read.
 *   * `BlockedSource` **throws** on a block boundary. In the pinned geotiff (2.1.3) a slice
 *     whose end lands exactly on a multiple of the block size computes a `blockIdHigh` for a
 *     block `fetch()` never fetched and dereferences `undefined`. REPRODUCED against the
 *     pinned version, for an interior slice and for a slice ending at an EOF that is a block
 *     multiple; a non-multiple end is fine. One strip read is one chance, so it is invisible
 *     on a 30-strip image and likely on a real one — arriving as a bare `TypeError` from
 *     inside the render loop, naming neither the file nor the span. It also merges
 *     consecutive missing blocks into groups whose length depends on what happens to be
 *     cached, so the `?range=` dialect's whole point — the same bytes are always the same
 *     cacheable URL — did not hold.
 *
 * Implementing the source directly removes all three at once, and what is left is the model
 * the design actually describes: geotiff asks for a strip or a tile, and that span, exactly,
 * becomes one range request at a byte offset the file's own directory fixes. Errors propagate
 * unwrapped, so a 401 that wants a re-login still arrives as the transport's own typed error
 * instead of geotiff's `AggregateError('Request failed')` carrying `[undefined]`.
 *
 * EXPORTED for the same reason `assertHalvingPyramid` and `dtypeOfDirectory` are: its caching
 * contract — one transport read per span, a join for a concurrent duplicate, and a SEPARATE
 * buffer per caller — is a decision with a failure mode no fixture can reach (it needs an
 * uncompressed file with a `Predictor`, which no writer here emits), so it is pinned as the
 * unit it is rather than left to be inferred from a render. Not exported from the package.
 */
export class ByteRangeGeoTiffSource {
  /** span key -> bytes, so one strip shared by adjacent tiles is fetched once per session. */
  private readonly spans = new Map<string, ArrayBuffer>()
  /**
   * span key -> the read that is CURRENTLY IN FLIGHT for it, with the signal it was issued
   * under. The resolved-bytes cache above is consulted synchronously and populated only after
   * an `await`, so N reads of one span issued in the same microtask all miss it and all go to
   * the network. That is not hypothetical: Viv fetches one deck tile as
   * `Promise.all(selections.map(getTile))`, so an N-channel source issues N SIMULTANEOUS reads
   * of the SAME byte span for every tile — measured at 5 parallel reads of 1 unique span on
   * the 5-sample fixture.
   *
   * (An earlier version of this paragraph appended "each miss also runs the FIFO eviction below,
   * so one tile evicted N-1 spans that adjacent tiles were about to reuse" as if it were part of
   * that measurement. It is not, and it is false as stated: the eviction below fires only at
   * `spans.size >= spanCacheSize`, and that run touched a handful of spans against a 256-entry
   * cache. Eviction thrash IS real — it belongs to `omeTiffUnderlay`'s SEQUENTIAL per-channel
   * scan at cache saturation, where it is measured and stated.)
   *
   * ── WHY THE SIGNAL IS PART OF THE KEY, AND NOT JUST THE SPAN ────────────────────────────
   * `signal` is how deck.gl abandons a tile the user has panned away from. Two callers that
   * share a promise share its cancellation, so de-duplicating across DIFFERENT signals would
   * let one abandoned viewport abort a live one's read — a new failure in exchange for the one
   * being fixed. Viv passes ONE `AbortController`'s signal to every selection of a tile, which
   * is exactly the case this collapses; reads under different signals stay independent.
   *
   * ── WHAT IT IS NOT, STATED SO THE NAME IS NOT READ AS MORE THAN IT IS ───────────────────
   * The map holds ONE entry per span, carrying the most recently issued signal — not one entry
   * per (span, signal) pair. Interleaved callers under different signals therefore each miss
   * and each overwrite, so the join DEGRADES TO NOTHING for them rather than mis-sharing. That
   * is the safe direction, and it is the whole benefit for the case that motivated this (Viv's
   * N selections of one tile, issued together under one signal); a per-pair map would buy the
   * interleaved case a saving it does not need at the cost of a second dimension of state.
   *
   * It is BOUNDED only by how many reads are outstanding at once — unlike `spans`, which is
   * capped. Each entry holds a reference to its caller's `AbortSignal` and is removed in the
   * creator's `finally`, so a read that never settles (a transport with no timeout) retains
   * one for the life of the source. Bounded in practice by the transport, not by this class.
   */
  private readonly inFlight = new Map<string, { signal?: AbortSignal; bytes: Promise<ArrayBuffer> }>()

  private readonly spanCacheSize: number

  /**
   * `spanCacheSize` is NORMALIZED, which it did not need to be while this class had one call
   * site that always passed `limits.spanCacheSize`. Exporting it makes the constructor a
   * contract, and `loadOmeTiffPyramid` merges the caller's `limits` unchecked, so anything a
   * caller writes reaches here.
   *
   * The rule is `Number.isFinite ? max(1, floor(n)) : DEFAULT`, and it is that rather than
   * `max(1, floor(n) || DEFAULT)` because the shorter form was measurably wrong twice:
   *
   *   * `0` — and `0.5`, and `0.9` — landed on `|| DEFAULT`, i.e. **256**, so a caller asking
   *     for no caching silently got the largest cache the class offers, and the function was
   *     non-monotonic (`0.5 -> 256` while `1.5 -> 1`);
   *   * `Infinity` sailed through both `floor` and `max`, leaving `spans.size >= Infinity`
   *     permanently false — an UNBOUNDED cache, which is precisely the failure the
   *     normalization exists to close, reached by a number rather than by a non-number.
   *
   * `undefined`, `null` and `NaN` take the default; everything finite is floored and floored
   * again at 1, so a bound below one span degenerates to one span rather than to none.
   */
  constructor(
    private readonly source: ByteRangeSource,
    spanCacheSize: number = DEFAULT_OME_TIFF_LIMITS.spanCacheSize,
  ) {
    this.spanCacheSize = Number.isFinite(spanCacheSize)
      ? Math.max(1, Math.floor(spanCacheSize))
      : DEFAULT_OME_TIFF_LIMITS.spanCacheSize
  }

  /** geotiff consults this to bound reads; we always know it. */
  get fileSize(): number {
    return this.source.byteLength
  }

  async fetch(
    slices: readonly { offset: number; length: number }[],
    signal?: AbortSignal,
  ): Promise<ArrayBuffer[]> {
    return await Promise.all(slices.map(slice => this.fetchSlice(slice, signal)))
  }

  async fetchSlice(
    slice: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const total = this.source.byteLength
    const start = slice.offset
    // The CLAMP, and it is the reason `byteLength` is required rather than discovered. geotiff
    // reads a fixed-size header window and a directory whose declared length can reach past
    // the end of a short file; the `?range=` dialect answers `a-b` with `b >= total` as a
    // **416** rather than clamping (only the `Range:` HEADER form clamps). Unclamped, the last
    // read of every file fails — and for a pyramid that read is where the level directories are.
    const end = Math.min(start + slice.length - 1, total - 1)
    if (start < 0 || start >= total) {
      throw new OmeTiffLoadError(
        `the TIFF reader asked for ${slice.length} bytes at offset ${start} of a ` +
          `${total}-byte file, which begins outside it.`,
      )
    }
    const key = `${start}-${end}`
    const cached = this.spans.get(key)
    // ── EVERY CALLER GETS ITS OWN BUFFER ────────────────────────────────────────────────
    // The cache and the in-flight join both hand the SAME `ArrayBuffer` to more than one
    // decode, and geotiff's decoders are not all pure: `RawDecoder.decodeBlock` returns its
    // INPUT, and `applyPredictor` then accumulates the differencing IN PLACE. So for
    // `Compression = 1` (which `DECODABLE_COMPRESSION` admits) with `Predictor` 2 or 3, a
    // second decode of a shared span double-applies the prediction — silently wrong pixels,
    // no error. That was already reachable through the span cache (adjacent tiles share a
    // strip); the in-flight join makes it certain for every tile of a multi-channel file,
    // because all N channel decodes provably receive one buffer.
    //
    // ── WHAT THE COPY COSTS, MEASURED, BECAUSE "a memcpy" UNDERSTATES IT ────────────────
    // It is paid PER CALLER, not per span, so `omeTiffUnderlay`'s sequential per-channel scan
    // pays it once per channel per span. Measured on one `loadOmeTiffPyramid` +
    // `omeTiffUnderlay` of the 10-sample fixture: 5 transport reads / 8,781 bytes fetched
    // against 14 `fetchSlice` calls / 54,204 bytes copied — 6.2x the bytes actually fetched.
    //
    // Paid anyway, and the narrower alternative is deliberately NOT taken: copying only for the
    // one shape that can be corrupted (`Compression = 1` with a `Predictor`) would require this
    // class to know the file's codec, and it is a TRANSPORT — it answers byte spans and parses
    // nothing. Threading the codec in would buy allocations at the cost of the property that
    // makes this class reviewable. It costs no range request either way, which is the expensive
    // thing the cache exists to save.
    if (cached) return cached.slice(0)
    // Join an identical read already on the wire under the SAME signal, rather than issuing a
    // second one — see `inFlight`.
    const live = this.inFlight.get(key)
    if (live && live.signal === signal) return (await live.bytes).slice(0)
    const pending = this.source.read(start, end, signal)
    this.inFlight.set(key, { signal, bytes: pending })
    let bytes: ArrayBuffer
    try {
      bytes = await pending
    } finally {
      // Cleared on failure TOO, and that is the half that matters: a retained rejected promise
      // would make every later read of that span replay the original failure — an expired token
      // that a refresh has since fixed would keep failing until the source was rebuilt.
      if (this.inFlight.get(key)?.bytes === pending) this.inFlight.delete(key)
    }
    // A plain FIFO bound: the read order is the TIFF's own directory order, so the oldest span
    // is the least likely to be asked for again.
    if (this.spans.size >= this.spanCacheSize) {
      const oldest = this.spans.keys().next().value
      if (oldest !== undefined) this.spans.delete(oldest)
    }
    this.spans.set(key, bytes)
    return bytes.slice(0)
  }

  /**
   * Release the caches. Nothing in this repo calls it — geotiff's own `close()` is the only
   * caller and is never invoked — and the limits of what it does are recorded rather than
   * implied: it does NOT cancel reads that are already outstanding, so one resuming after a
   * close re-populates `spans`, and because `inFlight` was cleared a concurrent caller for the
   * same span will issue a duplicate read rather than join. Both are consequences of clearing
   * a map that exists to be joined; neither is reachable today.
   */
  async close(): Promise<void> {
    this.spans.clear()
    this.inFlight.clear()
  }
}

// ── TIFF facts ───────────────────────────────────────────────────────────────────────────

/**
 * TIFF `Compression` tags whose pixels a browser decoder in this application can read.
 * Deflate is what the writer emits; LZW is the writer's declared alternative and Viv
 * registers a decoder for it; 1 is uncompressed.
 *
 * An allowlist rather than a denylist: an unknown codec must be REFUSED with a name, not
 * attempted and then failed per-tile from inside the render loop.
 */
const DECODABLE_COMPRESSION: ReadonlyMap<number, string> = new Map([
  [1, 'none'],
  [5, 'LZW'],
  [8, 'Deflate (Adobe)'],
  [32946, 'Deflate'],
])

/** Names for the codecs we expect to REFUSE, so the error can say what it met. */
const KNOWN_UNDECODABLE: ReadonlyMap<number, string> = new Map([
  [6, 'old-style JPEG'],
  [7, 'JPEG'],
  [33003, 'JPEG-2000 (Aperio YCbCr)'],
  [33005, 'JPEG-2000 (Aperio RGB)'],
  [34712, 'JPEG-2000'],
  [34887, 'LERC'],
  [50001, 'WebP'],
  [50002, 'JPEG XL'],
])

/** A minimal view of the TIFF directory fields this module reads. */
interface TiffDirectory {
  // `ArrayLike`, not `number[]`: geotiff puts both of these in its `arrayFields`, so a real
  // directory hands over a `Uint16Array`. Typing them as `number[]` was wrong about the only
  // producer that exists, and it made the defensive scalar branch in `assertUniformSampleFormat`
  // unreachable through the type it was written to protect.
  BitsPerSample?: ArrayLike<number>
  SampleFormat?: ArrayLike<number>
  SamplesPerPixel?: number
  PlanarConfiguration?: number
  PhotometricInterpretation?: number
  Compression?: number
  SubIFDs?: number[]
  TileWidth?: number
  RowsPerStrip?: number
}

function directoryOf(image: GeoTIFFImage): TiffDirectory {
  return (image as unknown as { fileDirectory: TiffDirectory }).fileDirectory
}

/**
 * The Viv dtype for a directory, from `BitsPerSample` + `SampleFormat` (TIFF 6.0 §19:
 * 1 = unsigned int, 2 = two's-complement int, 3 = IEEE float).
 */
export function dtypeOfDirectory(directory: TiffDirectory): SupportedDtype {
  const bits = directory.BitsPerSample?.[0] ?? 8
  const format = directory.SampleFormat?.[0] ?? 1
  if (format === 3) return bits <= 32 ? 'Float32' : 'Float64'
  if (format === 2) return bits <= 8 ? 'Int8' : bits <= 16 ? 'Int16' : 'Int32'
  return bits <= 8 ? 'Uint8' : bits <= 16 ? 'Uint16' : 'Uint32'
}

/**
 * Refuse a directory whose per-SAMPLE format tags this reader cannot honour (#288).
 *
 * Three separate malformations, separate because geotiff treats them separately.
 * `BitsPerSample` and `SampleFormat` are PER-SAMPLE arrays in TIFF 6.0 and geotiff honours
 * that — `getArrayForSample(k)` builds channel k's output from `getSampleFormat(k)` and
 * `getBitsPerSample(k)`, and `getBytesPerPixel()` sums the whole array for the pixel stride —
 * while `dtypeOfDirectory` reads index 0 and declares ONE dtype for the whole `PixelSource`.
 *
 * 1. **`BitsPerSample` ABSENT.** Refused, and an earlier cut had this arm backwards, exempting
 *    it as "TIFF's own default". geotiff has NO default for it: `getBitsPerSample(k)` is a bare
 *    `this.fileDirectory.BitsPerSample[k]`, so an absent tag is a `TypeError` from inside the
 *    render loop, per tile, naming nothing — measured on a real fixture with the tag removed.
 *    `SampleFormat` genuinely does default (to 1, unsigned integer), so an absent one stays
 *    exempt. The asymmetry is the library's, not a preference.
 * 2. **A tag whose LENGTH is not `SamplesPerPixel`.** The length IS the pixel stride —
 *    `getBytesPerPixel()` sums the whole array — so ANY mismatch decodes the wrong pixels, in
 *    both directions. Measured against the vendored geotiff, by handing it a real committed
 *    fixture's directory with the tag rewritten and reading 8 pixels of row 0 (the family's own
 *    closed form gives sample 0 as `0,5,10,15,20,25,30,35`):
 *
 *        BPS=[8,8,8]   SPP=1  ->  stride 3, c0 = 0,15,30,45,60,75,90,105   (silently wrong)
 *        BPS=[8,8]     SPP=3  ->  stride 2, c0 = 0,74,42,10,84,52,20,94    (silently wrong)
 *                                          c2 = Error: Unsupported data format/bitsPerSample
 *        BPS=[8,8,8,8] SPP=3  ->  stride 4, all three channels wrong, NOTHING thrown
 *
 *    So `!==` rather than `<`, and the reason is the last row: a SHORT tag at least throws for
 *    the samples past its end, while a LONG one corrupts every channel with no error anywhere.
 *    (Two earlier versions of this note had it backwards in opposite directions — one said short
 *    merely "resolves to nothing", the other that long "never decodes at all". Both were guesses
 *    dressed as measurements; the table above is the run.)
 *
 *    This runs at EVERY sample count including 1 — an earlier cut returned early at
 *    `samples <= 1` and left the commonest shape this system emits unguarded, which is the first
 *    row of that table.
 * 3. **Samples that disagree with each other.** Reachable only at `samples > 1`, by 2. With
 *    `BitsPerSample = [8,16,8,8,8]` channel 1 comes back a `Uint16Array` while the source — and
 *    the layer, via `dtype: loader[0].dtype` — says `Uint8`: right bytes, wrong meaning, with
 *    nothing saying so, which is the class this whole module refuses by name.
 *
 * Exported so all three are pinned as the decision they are; the committed
 * `samples-per-pixel-mixed-bits.ome.tif` is what proves the loader REACHES it.
 */
export function assertUniformSampleFormat(
  directory: TiffDirectory,
  samples: number,
  /**
   * Which pyramid LEVEL this directory is, when it is not level 0. Named in every message,
   * because `assertLevelSampleLayout` calls this per level and its two sibling refusals already
   * say "pyramid level N" — a user told "this OME-TIFF is malformed" for a defect that exists
   * only at level 3 has been given no way to find it, and this branch is what added the two arms
   * most likely to differ BETWEEN levels.
   */
  level?: number,
): void {
  const where = level === undefined ? 'this OME-TIFF' : `pyramid level ${level} of this OME-TIFF`
  for (const [tag, raw, hasLibraryDefault] of [
    ['BitsPerSample', directory.BitsPerSample, false],
    ['SampleFormat', directory.SampleFormat, true],
  ] as const) {
    if (raw == null) {
      if (hasLibraryDefault) continue
      throw new OmeTiffLoadError(
        `${where} declares SamplesPerPixel = ${samples} and carries no ${tag} tag. The ` +
          'TIFF reader in this application has no default for it — it indexes the tag per ' +
          'sample — so the file would open here and then fail on every tile from inside the ' +
          'render loop, naming neither the file nor the tag.',
      )
    }
    // `Array.from` handles both shapes the type admits — a plain array from a hand-built
    // literal, and the `Uint16Array` geotiff actually supplies. An earlier cut also carried a
    // `typeof raw === 'number'` branch for a scalar tag; the declared type forbids one, so it
    // was unreachable without an `as unknown as`, and the comment justified it by a caller the
    // type does not allow. Removed rather than kept as a guard against a shape nothing produces.
    const declared: number[] = Array.from(raw)
    if (declared.length !== samples) {
      throw new OmeTiffLoadError(
        `${where} declares SamplesPerPixel = ${samples} but its ${tag} tag carries ` +
          `${declared.length} value(s) (${JSON.stringify(declared)}). TIFF 6.0 makes that tag ` +
          'one entry per sample; a short one leaves the reader indexing past its end, and a ' +
          'long one over-counts the pixel stride and decodes a silently wrong image.',
      )
    }
    // No `length <= 1` short-circuit: after the length check `declared.length === samples`, so
    // at `samples === 1` the loop below runs once and cannot find a disagreement, and at
    // `samples > 1` it is exactly the comparison that matters. A `continue` here was dead code.
    const first = declared[0]
    const at = declared.findIndex(v => v !== first)
    if (at > 0) {
      throw new OmeTiffLoadError(
        `${where} declares ${tag} ${JSON.stringify(declared)} — sample ${at} is ` +
          `${declared[at]} where sample 0 is ${first}. A pyramid reports ONE dtype to the image ` +
          'layer, so the samples of a channel stack must share a numeric format; reading them ' +
          "anyway would hand the layer sample 1's bytes under sample 0's type.",
      )
    }
  }
}

/**
 * Refuse a codec we cannot read, from the OPEN call, naming it.
 *
 * Exported so the refusal is testable as the pure decision it is, independently of whether a
 * fixture in that codec happens to exist.
 */
export function assertDecodableCodec(compression: number | undefined): void {
  const tag = compression ?? 1
  if (DECODABLE_COMPRESSION.has(tag)) return
  throw new UnsupportedImageCodecError(tag, KNOWN_UNDECODABLE.get(tag) ?? 'an unknown codec')
}

/** One level's pixel dimensions. */
export interface LevelSize {
  width: number
  height: number
}

/**
 * Refuse a pyramid whose levels are not successive halvings.
 *
 * The seam's contract is "index 0 = full resolution, each subsequent entry half-scale", and
 * `MultiscaleImageLayer` does not merely prefer that — it DERIVES a tile's world position
 * from it. A level that is not the previous one halved therefore does not error; it draws
 * the right pixels in the wrong place, which is the failure mode this epic has already paid
 * for twice. The writer guarantees the halving and its own tests pin it, so a violation
 * reaching here means the bytes are not what this system emits.
 *
 * `Math.floor` on both axes, because an odd dimension halves down (1801 -> 900).
 */
export function assertHalvingPyramid(levels: readonly LevelSize[]): void {
  for (let i = 1; i < levels.length; i++) {
    const previous = levels[i - 1]
    const current = levels[i]
    const width = Math.floor(previous.width / 2)
    const height = Math.floor(previous.height / 2)
    if (current.width !== width || current.height !== height) {
      throw new NonHalvingPyramidError(
        `pyramid level ${i} is ${current.width}x${current.height}, but level ${i - 1} is ` +
          `${previous.width}x${previous.height}, which halves to ${width}x${height}. The ` +
          'image layer places every tile on the assumption that each level is the previous ' +
          'one halved, so a level that is not would render in the wrong place rather than ' +
          'fail.',
      )
    }
  }
}

// ── the loader ───────────────────────────────────────────────────────────────────────────

/** What `loadOmeTiffPyramid` resolves to. */
export interface OmeTiffPyramid {
  /**
   * The resolution pyramid, index 0 = full resolution, each subsequent entry half-scale.
   * Feed it straight to `buildRasterImageLayers` — `length > 1` takes the tiled
   * `MultiscaleImageLayer` path, `length === 1` the single `ImageLayer` path.
   */
  readonly pyramid: PixelSource<ChannelLabels>[]
  /** the pyramid normalized through the shipped `imageMeta.parseMultiscales`. */
  readonly meta: NormalizedImageMeta
  /** `true` when the samples are interleaved in one plane (RGB/RGBA). */
  readonly interleaved: boolean
  /**
   * How many CHANNELS the pyramid's sources declare on their `'c'` axis — i.e. how many
   * selections a consumer must issue to see every sample the file carries (#288).
   *
   * `1` for a greyscale plane and for interleaved RGB/RGBA (three or four samples of ONE
   * channel, rendered together by a `BitmapLayer`). `SamplesPerPixel` for the planar
   * sample-stack case (2, or 5..`MAX_RENDERABLE_CHANNELS`), where each sample IS a channel.
   *
   * Separate from `interleaved` on purpose: `interleaved` answers "is the trailing axis a
   * per-pixel component axis?", which is what `omeTiffUnderlay`'s stride and Viv's own
   * `isInterleaved` are asking, and redefining it to mean "more than one sample" would
   * silently change both.
   */
  readonly channels: number
  /** `true` when the file stores TILES; `false` when it stores full-width STRIPS. */
  readonly tiled: boolean
  /** the tile edge every level reports (`limits.tileSize`). */
  readonly tileSize: number
  /** physical size of one full-resolution pixel, from OME `PhysicalSizeX/Y`, when declared. */
  readonly physicalSize?: { readonly x: number; readonly y: number }
}

export interface LoadOmeTiffOptions {
  /** overrides for any of `DEFAULT_OME_TIFF_LIMITS`. */
  limits?: Partial<OmeTiffPyramidLimits>
  /**
   * Physical size of one full-resolution pixel, if the caller knows it. Used ONLY to fill
   * `meta.levels[].scale`; it is never folded into the model matrix — see
   * `omeTiffModelMatrix`.
   */
  micronsPerPixel?: number
}

/**
 * Open an OME-TIFF over range reads and resolve its resolution pyramid.
 *
 * Levels are IFD 0 plus each `SubIFDs` offset, which is how the writer stores them
 * (`subifds=` + `subfiletype=1`) and how Viv's own indexer reads them. A file with no
 * `SubIFDs` is a legal single-level pyramid — the trivial case of an image small enough that
 * halving it would go below the writer's minimum level side.
 */
export async function loadOmeTiffPyramid(
  source: ByteRangeSource,
  options: LoadOmeTiffOptions = {},
): Promise<OmeTiffPyramid> {
  const limits = { ...DEFAULT_OME_TIFF_LIMITS, ...options.limits }
  const bytes = new ByteRangeGeoTiffSource(source, limits.spanCacheSize)
  {
    const tiff: GeoTIFF = await GeoTIFF.fromSource(bytes)

    const base = await tiff.getImage(0)
    const baseDirectory = directoryOf(base)
    // Before anything else: a codec we cannot read is a refusal, not a per-tile surprise.
    assertDecodableCodec(baseDirectory.Compression)

    // ── ONE PLANE, or a named refusal ───────────────────────────────────────────────────
    //
    // Two different ways a file can hold more than one, and neither is representable in the
    // pyramid this loader returns:
    //
    //   * separate top-level IFDs (the standard OME multichannel layout, and what a raw
    //     vendor morphology file is). `getImageCount()` walks the IFD chain — SubIFDs are
    //     NOT on it, so the pyramid's own levels do not count towards this;
    //   * `PlanarConfiguration = 2`, where the samples of one image sit in separate planes.
    //
    // Without this, both cases produce a well-formed source that reports N channels and
    // returns channel 0's pixels for every one of them.
    const planes = await tiff.getImageCount()
    if (planes > 1) {
      throw new MultiPlaneImageUnsupportedError(
        planes,
        `${planes} top-level IFDs; channels stored as separate images are not read here`,
      )
    }
    const samples = baseDirectory.SamplesPerPixel ?? 1
    const planar = (baseDirectory.PlanarConfiguration ?? 1) === 2
    if (planar && samples > 1) {
      throw new MultiPlaneImageUnsupportedError(
        samples,
        `PlanarConfiguration=2 with SamplesPerPixel=${samples}`,
      )
    }
    // ── A SAMPLE COUNT WE CAN RENDER, or a named refusal (#288) ─────────────────────────
    //
    // The counts this leaves standing are 1..MAX_RENDERABLE_CHANNELS, and every one of them
    // reaches an explicit arm below. What is refused is a count no arm can serve: a
    // zero-sample (or fractional) directory, and a stack past the renderer's ceiling.
    //
    // This guard is what stops the silent case. Without it `SamplesPerPixel` 2 or >= 5 fell
    // through `interleaved` (Viv's rule is exactly 3 or 4), the source was declared
    // `[1, height, width]` over interleaved bytes, and Viv returned sample 0 for every
    // channel — a plausible greyscale picture of something the file does not claim to be.
    if (!Number.isInteger(samples) || samples < 1 || samples > MAX_RENDERABLE_CHANNELS) {
      throw new SampleCountUnsupportedError(samples)
    }
    // …and every sample of it must share ONE numeric format, because the source declares one
    // dtype for all of them. Only reachable once a channel selection can ask for sample k.
    assertUniformSampleFormat(baseDirectory, samples)

    const images: GeoTIFFImage[] = [base]
    for (const offset of baseDirectory.SubIFDs ?? []) {
      const level = await tiff.parseFileDirectoryAt(offset)
      // Each LEVEL carries its own codec, bit depth AND SAMPLE LAYOUT. Checking only IFD 0
      // would let a file whose reduced levels differ open cleanly and then fail per tile from
      // inside the render loop — which is the failure `assertDecodableCodec` exists to move
      // forward.
      //
      // `SamplesPerPixel` joined that set when the channel axis started resolving to a SAMPLE
      // (#288): `sampleView` closes over the BASE count and forces `samples: [k]` on every
      // level, so a level declaring fewer samples rejects with geotiff's bare
      // `RangeError: Invalid sample index 'k'` — untyped, per tile, naming no file, no level
      // and no channel. Measured on a hand-built 2-level file with `S=2` at level 0 and `S=1`
      // below it: it opened with no refusal, declared level 1 as `[2, h, w]` over one-sample
      // bytes — a shape contradicting its own bytes, verbatim the #288 diagnosis — and the
      // `RangeError` reached `omeTiffUnderlay`, which reported it to the catalog as "the
      // artifact could not be opened".
      assertDecodableCodec(level.fileDirectory.Compression)
      const levelDirectory = level.fileDirectory as TiffDirectory
      assertLevelSampleLayout(levelDirectory, images.length, samples)
      const levelDtype = dtypeOfDirectory(levelDirectory)
      const baseDtype = dtypeOfDirectory(baseDirectory)
      if (levelDtype !== baseDtype) {
        throw new OmeTiffLoadError(
          `pyramid level ${images.length} is ${levelDtype} but level 0 is ${baseDtype}; a ` +
            'pyramid reports ONE dtype to the image layer, so levels that disagree cannot be ' +
            'rendered from a single source.',
        )
      }
      images.push(
        new GeoTIFFImage(
          level.fileDirectory,
          level.geoKeyDirectory,
          (base as unknown as { dataView: DataView }).dataView,
          (tiff as unknown as { littleEndian: boolean }).littleEndian,
          (tiff as unknown as { cache: boolean }).cache,
          (tiff as unknown as { source: GeoTiffSource }).source,
        ),
      )
    }

    const sizes: LevelSize[] = images.map(image => ({
      width: image.getWidth(),
      height: image.getHeight(),
    }))
    assertHalvingPyramid(sizes)

    // Viv's own rule (`isInterleaved`): a trailing sample dimension of 3 or 4 means the
    // samples live in one plane, and its layers then render them through a BitmapLayer with
    // the file's `PhotometricInterpretation` instead of the per-channel shader.
    //
    // It is Viv's rule and not ours, and it is hard-coded to `{3, 4}` at every site that
    // matters inside `@vivjs`: `TiffPixelSource._readRasters` (which decides `interleave:`
    // and then takes `raster[0]`), `getImageSize` (which slices the shape -3 or -2), and four
    // branches of `@vivjs/layers`. So it is not a rule this file may widen — a shape declaring
    // a trailing 2 would be read by Viv as `[.., height=w, width=2]`, which is worse than the
    // bug it would be trying to fix.
    const interleaved = samples === 3 || samples === 4
    const dtype = dtypeOfDirectory(baseDirectory)
    const pixelMeta = {
      photometricInterpretation: baseDirectory.PhotometricInterpretation,
    }

    // ── ONE CHANNEL, OR ONE PER SAMPLE (#288) ────────────────────────────────────────────
    //
    // An INTERLEAVED image (3 or 4 samples) is ONE channel carrying three or four samples:
    // Viv renders it through a `BitmapLayer` using the file's `PhotometricInterpretation`,
    // and a second selection would issue a read this source cannot answer differently.
    // A single-sample image is one channel carrying one.
    //
    // Everything else — 2, and 5..MAX_RENDERABLE_CHANNELS — is a PLANAR SAMPLE STACK: the
    // samples are interleaved in the bytes but they are not colour, so each is its own
    // channel with its own contrast window, colour and visibility, through Viv's XRLayer.
    // Declaring `[samples, height, width]` is what routes it there, and it needs no call-site
    // change: `seedChannelsForLoader` reads the count off the `'c'` axis and
    // `buildRasterImageLayers` derives one selection per channel from that.
    const sampleStack = !interleaved && samples > 1
    const channels = sampleStack ? samples : 1

    const pyramid = images.map((image, index) => {
      const { width, height } = sizes[index]
      const shape = interleaved ? [channels, height, width, samples] : [channels, height, width]
      const labels = (interleaved ? ['c', 'y', 'x', '_c'] : ['c', 'y', 'x']) as
        | ['c', 'y', 'x']
        | ['c', 'y', 'x', '_c']
      return new TiffPixelSource<ChannelLabels>(
        sampleStack ? selection => sampleView(image, selection, samples) : async () => image,
        dtype,
        limits.tileSize,
        shape,
        labels,
        pixelMeta,
      ) as unknown as PixelSource<ChannelLabels>
    })

    const physical = physicalSizeOf(options.micronsPerPixel)
    const meta = parseMultiscales(
      ngffForLevels(sizes, { channels, samples, interleaved, dtype, scale: physical?.x ?? 1 }),
    )

    return {
      pyramid,
      meta,
      interleaved,
      channels,
      tiled: tiledOfDirectory(baseDirectory),
      tileSize: limits.tileSize,
      ...(physical ? { physicalSize: physical } : {}),
    }
  }
}

/**
 * A per-SAMPLE view of one pyramid level, for the planar sample-stack case (#288).
 *
 * ── THE PROBLEM THIS SOLVES, IN ONE LINE ─────────────────────────────────────────────────
 * `TiffPixelSource._readRasters` calls `image.readRasters({ interleave })` and then takes
 * `raster[0]`. `interleave` is Viv's `isInterleaved(this.shape)`, which is false for a
 * `[N, height, width]` shape — so EVERY channel selection would decode sample 0. The channel
 * axis would be declared and unserviceable, which is the exact "right pixels, wrong meaning"
 * failure `MultiPlaneImageUnsupportedError` refuses one paragraph up.
 *
 * ── WHY A VIEW AND NOT A FORK OF `TiffPixelSource` ───────────────────────────────────────
 * The one thing that needs to change is the `samples:` argument to geotiff's `readRasters`,
 * and `TiffPixelSource` hands its INDEXER the selection before every read — so the selection
 * can be resolved to a sample here, and every byte of Viv's tile-extent maths, its
 * `SIGNAL_ABORTED` contract and its abort check is kept. That is the same trade the module
 * header states for building our own level indexer instead of calling `loadOmeTiff`.
 *
 * `Object.create(image)` rather than a hand-built object: the view must still BE the level for
 * every other property geotiff and Viv read off it, and only `readRasters` is intercepted. The
 * inner call is made on `image` itself, so `this` is the real level and there is no recursion.
 */
function sampleView(
  image: GeoTIFFImage,
  selection: { readonly c?: number } | undefined,
  samples: number,
): Promise<GeoTIFFImage> {
  // `?? 0` was here and is deliberately gone. An ABSENT channel key defaulted to sample 0 is
  // the SAME outcome as an out-of-range one clamped to 0 — sample 0 drawn as the whole image —
  // reached by a slightly different caller bug, and it sat two lines above a guard whose stated
  // reason is that clamping to 0 is what this file exists to stop. `NaN` fails the integer test
  // below, so both spellings land on the one refusal.
  const sample = selection?.c ?? NaN
  // A selection outside the declared channel axis is a CALLER bug, and it is refused rather
  // than clamped.
  //
  // ── AND IT IS REACHABLE, WHICH AN EARLIER VERSION OF THIS COMMENT DENIED ────────────────
  // It claimed the case "cannot be reached through `buildRasterImageLayers`, which derives its
  // selections from the same shape". `buildRasterImageLayers` derives them from the CHANNEL
  // STATE ARRAY, not from the shape, and `useGridRaster` / `useGridDeckInputs` take a
  // caller-supplied `cell.channels` — which can outlive the loader it was seeded against, and
  // which `propagateToLinked` copies from one cell to another. `buildRasterImageLayers` now
  // clamps the state to the loader's own `'c'` extent (`channelCountOfLoader`) before deriving
  // selections, so no call site can forget; this stays a refusal because a source that cannot
  // serve a selection must say so rather than serve a different one.
  if (!Number.isInteger(sample) || sample < 0 || sample >= samples) {
    throw new OmeTiffLoadError(
      `this OME-TIFF carries ${samples} sample(s) per pixel, so its channel axis runs ` +
        `0..${samples - 1}; a read was requested for channel ${String(sample)}. Serving ` +
        'sample 0 for it would render one channel with another\'s pixels and report nothing.',
    )
  }
  const view = Object.create(image) as GeoTIFFImage
  ;(view as unknown as { readRasters: (props?: Record<string, unknown>) => unknown }).readRasters = (
    props: Record<string, unknown> = {},
  ) =>
    (image as unknown as { readRasters: (props: Record<string, unknown>) => unknown }).readRasters({
      ...props,
      samples: [sample],
    })
  return Promise.resolve(view)
}

/** The geotiff byte source we hand back to a level's `GeoTIFFImage`; opaque to us. */
type GeoTiffSource = ConstructorParameters<typeof GeoTIFFImage>[5]

/**
 * `true` when the file stores TILES, `false` when it stores full-width STRIPS.
 *
 * Exported so both branches are pinned by a unit test rather than by whichever fixtures
 * happen to exist. It is reported rather than acted on, and the reason is worth stating where
 * the value is computed.
 *
 * ── WHAT THIS USED TO SAY, AND WHY IT NO LONGER DOES (#227 / #259) ────────────────────────
 * It used to say that every image this system emits stores full-width strips, because the
 * writer passed no `tile=`; that a viewport tile therefore cost `imageWidth x tileHeight`
 * pixels rather than `tileSize x tileSize`, a waste factor of `imageWidth / tileSize` (~3x at
 * the committed fixture's size, ~80x on a whole-slide image); and that making the bytes tiled
 * was a one-line change belonging to the writer's item rather than to this reader.
 *
 * **That change was made.** #227 passes `tile=(512, 512)` at every `writer.write` call site,
 * so every image this system emits is tiled at 512 on every pyramid level, and #259 refreshed
 * the fixture corpus so it samples that. The waste factor above is now a description of what
 * a THIRD-PARTY stripped file costs this reader, not of what our own artifacts cost it.
 *
 * ── AND THE FALSE BRANCH IS STILL LIVE, DELIBERATELY ──────────────────────────────────────
 * `docs/design/ome-tiff-tile-layout.md` §5: *"a reader that only handles the layout its own
 * writer emits is a reader that breaks on the first third-party OME-TIFF."* OME-TIFFs in the
 * wild are routinely stripped, so `false` is not a legacy branch waiting to be deleted — it
 * is the vendor-file branch. `spatial-image-hires-stripped.ome.tif` is committed to keep it
 * exercised by a fixture a successful read actually goes through: it is the pre-#227 emit of
 * `spatial-image-hires.ome.tif`, kept verbatim, so the pair carries the SAME PIXELS through
 * the two layouts and decides the layout question and nothing else.
 *
 * That control's honest limit was that it is a file THIS SYSTEM wrote, before #227 — so it shows
 * the reader is not confined to its writer's CURRENT layout and shows nothing about a writer
 * outside this project, which is the invariant's own rationale. **#322 closed that.**
 * `third-party-stripped.ome.tif` is committed alongside it: the same raster, laid out by Pillow —
 * header, IFD, every tag, strip geometry and payloads — and more precisely by the libtiff Pillow
 * bundles, which is where `TiffImagePlugin._save` routes a compressed write. Either way a writer
 * this project neither ships nor controls, read successfully by this function and pinned by
 * `#322 TEST-1`. Its layout is one
 * no call site here can produce: `RowsPerStrip = 40` with a short final strip, eleven tags
 * carrying the STRIP tags where our writer carries the TILE tags, and none of `Software`,
 * `XResolution`/`YResolution` or `ResolutionUnit`, which our writer stamps on everything. So the
 * false branch is now exercised by a foreign layout and not only by an older one of ours.
 * (`SampleFormat` is deliberately not in that list: NEITHER OF THOSE TWO writers emits it — see
 * `assertUniformSampleFormat` above, which is why an absent one is exempt. #346 landed a file
 * that DOES carry tag 339, and it is the only one in the corpus that does; what the tag cannot do
 * is separate `third-party-stripped.ome.tif` from our own emits, which is what that list is for.)
 *
 * ── AND THE SECOND HALF, #346: A DOCUMENT NOTHING OF OURS AUTHORED ────────────────────────
 * #322's own limit, recorded here and in two other files, was that the `<OME>` block in
 * `third-party-stripped.ome.tif` is OUR generator's hand-written string — Pillow will not author
 * OME-XML — so the corpus proved nothing about a document composed outside this project.
 * `bioformats-tubhiswt.ome.tif` is that document: upstream's bytes end to end, from the OME
 * sample tree under CC BY 4.0, written by `OME Bio-Formats 5.2.0-m4` over a real Nikon/Bio-Rad
 * acquisition, carrying `<Instrument>`, `<Microscope>`, `<Detector>`, `<Objective>`, `<Plane>`,
 * `DimensionOrder="XYZTC"` and multi-file `<TiffData>`/`<UUID FileName=…>` elements no call site
 * here can produce. It is read successfully and is pinned by `#346 TEST-1..TEST-3`. Its container
 * is foreign too, in ways #322's is not: `Compression = 1` (uncompressed — the arm of
 * `DECODABLE_COMPRESSION` no committed byte reached before it), `RowsPerStrip = 1`, and a
 * `SampleFormat` tag.
 *
 * The limits of THAT, so this comment is not read as more than it is, and they are real:
 *
 *   * **This function reads TIFF TAGS. Nothing here parses OME-XML**, so no fixture can make a
 *     claim about how a vendor's `<OME>` document would be PARSED — there is no parser. What the
 *     corpus now has is the document itself, and `#346 TEST-2` pins the one consequence that is
 *     checkable without a parser: that document says `SizeC="2"` across two files, this file
 *     holds one IFD, and this reader answers the CONTAINER.
 *   * **Bio-Formats is the OME reference implementation, not an instrument vendor's own writer.**
 *     The pixels and the instrument metadata are a real acquisition's; the container is
 *     Bio-Formats'. A file written by an instrument's own OME-TIFF writer — a 10x Xenium
 *     morphology TIFF — is a further step, and `fixtures/README.md` records what was
 *     searched for one, what the licences say, and why this file was the one that landed.
 */
export function tiledOfDirectory(directory: TiffDirectory): boolean {
  return directory.TileWidth != null
}

/**
 * The physical size of one full-resolution pixel, when the caller knows it.
 *
 * It is a PARAMETER and not something read out of the file, and that is the same decision
 * as not parsing the OME-XML placement: the authoritative scale reaches the app as the
 * artifact's declared metadata, which the producer writes from the same values it puts in
 * the file and which the registration QC already cross-checks. Here it feeds ONLY
 * `meta.levels[].scale`; it is never folded into the model matrix (see `omeTiffModelMatrix`),
 * so a caller that does not supply it gets array-index units and a correct placement either
 * way.
 */
function physicalSizeOf(fallback: number | undefined): { x: number; y: number } | undefined {
  if (fallback != null && Number.isFinite(fallback) && fallback > 0) {
    return { x: fallback, y: fallback }
  }
  return undefined
}

/**
 * Refuse a pyramid LEVEL whose sample layout disagrees with level 0's (#288).
 *
 * Exported so all three of its arms are pinned by a unit test as well as by a fixture. Two of
 * the three now have a REAL committed file that proves the loader REACHES this function —
 * `samples-per-pixel-mismatched-levels.ome.tif` for the count arm and
 * `samples-per-pixel-planar-sublevel.ome.tif` for the planar one. An earlier version of this
 * note claimed a planar sub-level was "a shape `tifffile` will not write"; that was measured
 * false, and the fixture is twelve lines. The one shape `tifffile` genuinely refuses is a mixed
 * `BitsPerSample` (it declines the extratag outright), which is why THAT fixture is a one-field
 * byte patch of a real file rather than a fresh write.
 *
 * The SubIFD loop already re-checked the codec and the dtype per level, with the reason stated
 * there. This adds the sample layout, which became a per-level fact the read depends on the
 * moment a channel selection resolved to a SAMPLE: `sampleView` closes over the level-0 count.
 */
export function assertLevelSampleLayout(
  directory: TiffDirectory,
  level: number,
  baseSamples: number,
): void {
  // TIFF 6.0's own default for an omitted tag, so a level that omits it against a multi-sample
  // base is genuinely malformed rather than using a shorthand.
  const samples = directory.SamplesPerPixel ?? 1
  if (samples !== baseSamples) {
    throw new MultiPlaneImageUnsupportedError(
      samples,
      `pyramid level ${level} declares SamplesPerPixel=${samples} but level 0 declares ` +
        `${baseSamples}; one image cannot have two sample layouts`,
    )
  }
  if ((directory.PlanarConfiguration ?? 1) === 2 && samples > 1) {
    throw new MultiPlaneImageUnsupportedError(
      samples,
      `pyramid level ${level} is PlanarConfiguration=2 with SamplesPerPixel=${samples}`,
    )
  }
  assertUniformSampleFormat(directory, samples, level)
}

/**
 * Express the resolved levels in the NGFF shape the shipped `imageMeta.parseMultiscales`
 * consumes, so this loader normalizes its metadata through the tree's existing, tested
 * normalizer rather than through a second one.
 *
 * `scale` is the physical size of a full-resolution pixel; each coarser level's pixel covers
 * twice as much, which is exactly NGFF's per-dataset `scale` transform.
 */
export function ngffForLevels(
  sizes: readonly LevelSize[],
  spec: {
    channels: number
    samples: number
    interleaved: boolean
    dtype: string
    scale: number
  },
): NgffImage {
  const arrays: Record<string, NgffArrayMeta> = {}
  sizes.forEach((size, index) => {
    arrays[String(index)] = {
      shape: spec.interleaved
        ? [spec.channels, size.height, size.width, spec.samples]
        : [spec.channels, size.height, size.width],
      dtype: spec.dtype,
    }
  })
  return {
    multiscales: [
      {
        version: '0.4',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: sizes.map((_, index) => ({
          path: String(index),
          coordinateTransformations: [
            { type: 'scale', scale: [1, spec.scale * 2 ** index, spec.scale * 2 ** index] },
          ],
        })),
      },
    ],
    arrays,
  }
}

// ── placement ────────────────────────────────────────────────────────────────────────────

/**
 * The deck.gl `modelMatrix` (16, column-major) that places this image's FULL-RESOLUTION
 * pixel grid into its declared coordinate space.
 *
 * `toSpace` is the artifact's own declared 2x3 row-major affine `[a,b,tx,c,d,ty]`, taken as
 * DATA — it is the same value the file's OME-XML carries and the registration QC already
 * checks the two copies agree. Its convention is CORNER anchoring with the translation
 * identically zero at factor 1, settled upstream and inherited here, not relitigated: the
 * downsample crops from the end, so the emitted frame's origin IS the source frame's origin
 * and pixel (0,0) maps to (0,0).
 *
 * ── THE ONE TRAP, STATED ─────────────────────────────────────────────────────────────────
 * `toSpace` already maps EMITTED PIXELS to the space. The OME `PhysicalSizeX/Y` is a
 * DIFFERENT number — the emitted image's own micron pitch — and the space has a third,
 * `microns_per_pixel`. `toSpace[0]` is exactly the ratio of the other two. So composing
 * `pixelSizeAffine(meta)` over `toSpace`, which is what `imageModelMatrix` exists to do for an
 * NGFF image, would multiply the placement by that pitch and draw a perfectly plausible tissue
 * image at the wrong size in the wrong place. It is not composed here, and a test names the
 * wrong number.
 *
 * [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um] [producer-magnitude: spot_diameter_fullres]
 * For the committed Visium vendor bundle the shipped importer DERIVES 5.0, 4.4149 and 0.88298
 * today — a 4.41x error if composed — from `65.0 / 73.61433` then `/ 0.2`.
 * [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]
 * #158 measured 3.7357 and 0.7471 (ratio 3.74) on the pre-#222 emit, which is what every
 * artifact emitted before then still declares. Both are right about their own era and neither is a constant: they move with
 * `spot_diameter_fullres`, i.e. with the slide.
 *
 * Read the RATIO, not the magnitudes: `toSpace[0]` is `1/tissue_hires_scalef` and
 * `PhysicalSizeX` is `microns_per_pixel / tissue_hires_scalef`, so the identity holds by
 * construction at any micron scale. When the vendor declares neither `microns_per_pixel` nor
 * `spot_diameter_fullres`, the importer writes no `PhysicalSize` and no `microns_per_pixel` at
 * all — there is then no pixel size in existence to compose, and `toSpace` still places the
 * image. The trap is the composition, never a particular number.
 */
export function omeTiffModelMatrix(toSpace: Affine): number[] {
  return affineToModelMatrix(toSpace)
}
