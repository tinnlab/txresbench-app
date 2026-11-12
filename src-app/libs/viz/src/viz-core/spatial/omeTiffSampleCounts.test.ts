// omeTiffSampleCounts.test.ts — #288 TEST-1/2/3/6/7/8/10/12.
//
// Realizes `docs/design/ome-tiff-reader-sample-counts.md` §9 (*"Verification standard"*).
//
// ── WHY THIS FILE EXISTS AND WHAT IT REFUSES TO BE ────────────────────────────────────────
// The defect it covers is *"it renders, so no test noticed"*. On `origin/main` a
// `SamplesPerPixel = 2` or `>= 5` OME-TIFF opened cleanly, declared `[1, height, width]`, and
// returned SAMPLE 0 for every channel — a plausible greyscale picture of something the file
// does not claim to be. Two kinds of test pass against that and are therefore worthless here:
//
//   * one that exercises only 3 and 4 samples (the counts that already worked), and
//   * one that asserts a `PixelSource` resolved or a layer was constructed.
//
// So every assertion below is either DECODED PIXEL CONTENT against a closed form this file
// re-derives, or a refusal BY NAME reached through the real `loadOmeTiffPyramid`.
//
// ── THE FIXTURE FAMILY AND ITS ORACLE ─────────────────────────────────────────────────────
// `fixtures/samples-per-pixel-{1,2,3,4,5,11}.ome.tif`, written by
// `scripts/make-sample-count-fixtures.py`, which CALLS the shipped writer's own
// `_sample_layout` for the counts it emits (`READABLE_SAMPLE_COUNTS == (1, 3, 4)`) so those
// three cannot drift from what the importer writes, and uses the arm that module documents as
// the one that would emit the others if #266's refusal were lifted.
//
// Sample `s` of pixel `(x, y)` is `(37s + 5x + 3y) mod 251`. 251 is prime and coprime with
// 37/5/3, so sample 0 substituted for sample `c` differs in EVERY pixel: the defect cannot
// survive here as a near-miss that a tolerance would swallow.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromArrayBuffer } from 'geotiff'
import {
  assertLevelSampleLayout,
  ByteRangeGeoTiffSource,
  DEFAULT_OME_TIFF_LIMITS,
  assertUniformSampleFormat,
  loadOmeTiffPyramid,
  MAX_RENDERABLE_CHANNELS,
  OmeTiffLoadError,
  type ByteRangeSource,
  type OmeTiffPyramid,
} from './omeTiffPyramid'
import { buildRasterImageLayers } from './rasterImageLayers'
// From the LEAF, not through `grid/gridModel` — the reader's own suite has no business
// reaching its channel helpers through the grid model, the chart registry and `@txresbench/dock`.
import { reconcileChannelsToLoader, seedChannelsForLoader } from './channelState'
import type { RasterChannelState } from './channelState'
import type { GridCell } from '../grid/gridModel'
import { buildImagePaneLayers } from '../grid/useGridDeckInputs'
import { omeTiffUnderlayMeta } from './omeTiffUnderlay'
import { resolvePaneFrame } from './coordinateBinding'
// Through the PACKAGE BARREL on purpose — see TEST-1. `core.ts` is the deck-free entry, so this
// costs the node suite nothing beyond what it already imports.
import {
  SampleCountUnsupportedError as ExportedSampleCountUnsupportedError,
  MAX_RENDERABLE_CHANNELS as EXPORTED_MAX_RENDERABLE_CHANNELS,
} from '../../core'
import {
  level0Sample,
  sampleAtLevel,
  sampleCountFixtureFile,
  SAMPLE_FIXTURE_HEIGHT,
  SAMPLE_FIXTURE_LEVEL1_HEIGHT,
  SAMPLE_FIXTURE_LEVEL1_WIDTH,
  SAMPLE_FIXTURE_WIDTH,
} from './sampleCountFixture'

const FIXTURES = path.resolve(process.cwd(), 'src/viz-core/spatial/fixtures')

const WIDTH = SAMPLE_FIXTURE_WIDTH
const HEIGHT = SAMPLE_FIXTURE_HEIGHT
const LEVEL1_WIDTH = SAMPLE_FIXTURE_LEVEL1_WIDTH
const LEVEL1_HEIGHT = SAMPLE_FIXTURE_LEVEL1_HEIGHT

function bytesOf(file: string) {
  return readFileSync(path.join(FIXTURES, file))
}

function fileSource(file: string): ByteRangeSource {
  const bytes = bytesOf(file)
  return {
    byteLength: bytes.byteLength,
    async read(start, end) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

const fixture = sampleCountFixtureFile

// The ORACLE, from `sampleCountFixture.ts` — the closed form the generator writes, restated
// as arithmetic rather than as a digest, and SHARED with `omeTiffUnderlay.test.ts` so the two
// suites that read these bytes cannot drift apart on what the bytes mean.
const sampleAt = sampleAtLevel

/** The §3 table, as data. Every row is asserted; a suite covering only 3 and 4 proves nothing. */
const TABLE = [
  { samples: 1, interleaved: false, channels: 1, labels: ['c', 'y', 'x'] },
  { samples: 2, interleaved: false, channels: 2, labels: ['c', 'y', 'x'] },
  { samples: 3, interleaved: true, channels: 1, labels: ['c', 'y', 'x', '_c'] },
  { samples: 4, interleaved: true, channels: 1, labels: ['c', 'y', 'x', '_c'] },
  { samples: 5, interleaved: false, channels: 5, labels: ['c', 'y', 'x'] },
  // The CEILING ITSELF, inclusive. Without it the whole 6..10 band is unguarded: a blind audit
  // showed that BOTH `samples > 5` in place of the refusal (refusing what §3 says to display)
  // AND `sampleStack && samples <= 5` (reinstating the #288 defect for 6..10) left every test
  // in this package green. This row is also what ties the ceiling to Viv's `MAX_CHANNELS`
  // rather than to a literal — a Viv upgrade that LOWERED it reddens this row.
  { samples: 10, interleaved: false, channels: 10, labels: ['c', 'y', 'x'] },
] as const

const open = (samples: number, tileSize?: number): Promise<OmeTiffPyramid> =>
  loadOmeTiffPyramid(fileSource(fixture(samples)), tileSize ? { limits: { tileSize } } : {})

const asNumbers = (data: unknown): ArrayLike<number> => data as ArrayLike<number>

// ── TEST-1 [acceptance] [invariant: INV-1] ────────────────────────────────────────────────

describe('TEST-1 [acceptance] [invariant: INV-1] a sample count this reader cannot render is refused BY NAME', () => {
  it('the committed 11-sample file is refused from the OPEN call, naming the count and the ceiling', async () => {
    // Reached through the SHIPPED entry point over the SHIPPED byte-range source, not by
    // calling a guard directly: a refusal only counts if the real path arrives at it.
    const failure = await open(11).then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(OmeTiffLoadError)
    expect((failure as Error).name).toBe('SampleCountUnsupportedError')
    // …by CLASS, through the package's own public barrel — which is the only reason the export
    // exists (a consumer must be able to tell "too many channels to render" from "could not be
    // opened"). Comparing `.name` to a string, which is all this asserted at first, leaves the
    // export unexercised and therefore free to be dropped.
    //
    // WHAT IT CAN AND CANNOT CATCH: `core.ts` re-exports the same binding from the same module,
    // so these two can never DIVERGE and this is not a consistency check. What they pin is that
    // the barrel lines EXIST — delete either and the import is `undefined`, `toBeInstanceOf`
    // throws and `toBe` fails. That is the whole risk being managed: an export with no consumer
    // in this repo is exactly the kind that gets tidied away.
    expect(failure).toBeInstanceOf(ExportedSampleCountUnsupportedError)
    expect(EXPORTED_MAX_RENDERABLE_CHANNELS).toBe(MAX_RENDERABLE_CHANNELS)
    // The MESSAGE, because a refusal whose text does not say what was wrong is a stack trace.
    expect((failure as Error).message).toContain('SamplesPerPixel = 11')
    expect((failure as Error).message).toContain(String(MAX_RENDERABLE_CHANNELS))
    // …and it says WHY it is not simply drawing what it can, which is the decision #288 asked
    // for. Without this the next reader re-litigates it from scratch.
    expect((failure as Error).message).toContain('draw sample 0 as the whole image')

  })

  it('it costs strictly FEWER byte-range reads than opening the file would — an OPEN-call refusal', async () => {
    // The claim "this is an open-call refusal, not a per-tile one" needs evidence, and the
    // assertion that used to stand here — `expect(failure).not.toBeInstanceOf(Promise)` — was
    // not it: a rejection reason is never a Promise, so it passed for any input whatsoever.
    //
    // The measurable form is the READS. A refusal that fires from the IFD 0 directory has
    // touched the header and nothing else; a source that came into existence and then failed
    // would have walked `SubIFDs` and decoded at least one tile. So the 11-sample file's read
    // count is compared against the 10-sample file's, which differs from it in one tag and is
    // opened all the way.
    const count = async (samples: number): Promise<number> => {
      const bytes = bytesOf(fixture(samples))
      let reads = 0
      const counting: ByteRangeSource = {
        byteLength: bytes.byteLength,
        async read(start, end) {
          reads++
          return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
        },
      }
      const pyramid = await loadOmeTiffPyramid(counting).catch(() => null)
      if (pyramid) {
        // The successful control decodes a tile, which is the work the refusal must not do.
        await pyramid.pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
      }
      return reads
    }
    const refused = await count(11)
    const opened = await count(10)
    expect(refused).toBeGreaterThan(0) // it did read the header — this is not a transport stub
    expect(refused).toBeLessThan(opened)

    // THE LIMIT OF THIS ORACLE, STATED. It compares two DIFFERENT files (15,668 B and
    // 14,526 B), so the margin is not size-controlled and a fixture regeneration could move it.
    // A stronger form was attempted and abandoned rather than left in looking convincing: "the
    // refusal never reads a byte at or past the first tile offset" is FALSE, because geotiff's
    // block reader aligns its fetches and the block carrying the IFD/SubIFD directory of a
    // 15 KB file also carries pixels — measured, the refusal's high-water read is the end of
    // the file. What this assertion does show is that the refusal does strictly less work than
    // a full open plus one tile, which is the difference between an open-call refusal and a
    // per-tile one; the fact that no source object exists to call `getTile` on is the rejection
    // itself, one line above.
  })

  it('the ceiling is exclusive above and INCLUSIVE at itself — both sides, against real files', async () => {
    // Both sides, because only one of them was ever asserted. `MAX_RENDERABLE_CHANNELS` is
    // Viv's `MAX_CHANNELS`, imported rather than restated, so this test is what makes a Viv
    // upgrade that moved the cap redden something instead of rotting a comment.
    expect(MAX_RENDERABLE_CHANNELS).toBe(10)

    // INCLUSIVE: a file AT the ceiling opens, declares one channel per sample, and serves
    // each one's own pixels. Asserting the message text alone (which is built from the same
    // constant) would be true by construction of the harness.
    const atCeiling = await open(MAX_RENDERABLE_CHANNELS)
    expect(atCeiling.channels).toBe(MAX_RENDERABLE_CHANNELS)
    const distinct = new Set<number>()
    for (let c = 0; c < MAX_RENDERABLE_CHANNELS; c++) {
      const data = asNumbers((await atCeiling.pyramid[0].getRaster({ selection: { c } })).data)
      expect(data[0]).toBe(level0Sample(c, 0, 0))
      distinct.add(data[0])
    }
    expect(distinct.size).toBe(MAX_RENDERABLE_CHANNELS)

    // …and the shipped layer builder really does issue that many selections for it, which is
    // the half that would break if Viv's cap dropped below the ceiling this file enforces.
    const layers = buildRasterImageLayers({
      loader: atCeiling.pyramid,
      channels: seedChannelsForLoader(atCeiling.pyramid),
      cellId: 'ceiling',
    })
    const props = (layers[0] as unknown as { props: { selections: { c: number }[] } }).props
    expect(props.selections).toHaveLength(MAX_RENDERABLE_CHANNELS)

    // EXCLUSIVE above: one more sample is refused.
    const failure = await open(MAX_RENDERABLE_CHANNELS + 1).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure?.name).toBe('SampleCountUnsupportedError')
  })
})

// ── the per-level and per-sample-format refusals (#288 FIX_ROUND-1) ───────────────────────

describe('TEST-13 a level whose sample layout disagrees with level 0 is refused BY NAME', () => {
  it('the committed mismatched-levels fixture never opens', async () => {
    // Before this guard the file opened with NO refusal, declared level 1 as `[2, h, w]` over
    // one-sample bytes — a shape contradicting its own bytes, verbatim #288's diagnosis — and
    // channel 1 of that level rejected with geotiff's bare `RangeError: Invalid sample index`
    // from inside the render loop, per tile, naming no file and no class.
    const failure = await loadOmeTiffPyramid(
      fileSource('samples-per-pixel-mismatched-levels.ome.tif'),
    ).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure?.name).toBe('MultiPlaneImageUnsupportedError')
    expect(failure?.message).toContain('SamplesPerPixel=1')
    expect(failure?.message).toContain('one image cannot have two sample layouts')
  })

  it('a level whose PlanarConfiguration disagrees is refused too, from the same real path', async () => {
    // This arm was pinned by a hand-built literal on the stated ground that a planar sub-level
    // is "a shape `tifffile` will not write". A blind audit wrote one in twelve lines, so the
    // claim is retracted and the file is committed. (`tifffile` genuinely does refuse a MIXED
    // `BitsPerSample` — "not writing extratag 258" — which is why THAT fixture is a byte patch.)
    const failure = await loadOmeTiffPyramid(
      fileSource('samples-per-pixel-planar-sublevel.ome.tif'),
    ).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure?.name).toBe('MultiPlaneImageUnsupportedError')
    expect(failure?.message).toContain('pyramid level 1 is PlanarConfiguration=2')
  })

  it('and the level-0-only sibling with the SAME level 0 opens fine — so it is the LEVEL that is refused', async () => {
    // The control. `samples-per-pixel-2.ome.tif` has a byte-identical level 0; if the refusal
    // above were firing on level 0 (or on anything about a 2-sample file) this would fail too.
    const ok = await open(2)
    expect(ok.channels).toBe(2)
  })
})

describe('TEST-14 samples that do not share ONE numeric format are refused BY NAME', () => {
  it('the committed mixed-BitsPerSample file is refused from the REAL open call', async () => {
    // The WIRING, which a direct call cannot prove — a function that is never called also
    // leaves every other test green, and a blind audit showed exactly that: deleting either
    // call site left the whole package passing.
    //
    // `samples-per-pixel-mixed-bits.ome.tif` is the real 5-sample fixture with ONE tag value
    // rewritten to `(8, 16, 8, 8, 8)`, located by `tifffile`'s own parse. No writer emits a
    // mixed `BitsPerSample`, so a malformed vendor directory is the only way this arrives —
    // which is the input class, not a forgery of the behaviour under test.
    const failure = await loadOmeTiffPyramid(fileSource('samples-per-pixel-mixed-bits.ome.tif'))
      .then(
        () => null,
        (error: unknown) => error as Error,
      )
    expect(failure?.name).toBe('OmeTiffLoadError')
    expect(failure?.message).toContain('sample 1 is 16 where sample 0 is 8')
    // The message must show the caller their own array — geotiff hands these tags over as a
    // `Uint16Array`, and `JSON.stringify` renders a typed array as `{"0":8,"1":16,…}`.
    expect(failure?.message).toContain('[8,16,8,8,8]')

    // The CONTROL: the file it was forged from opens cleanly, so the refusal is the tag and
    // not anything else about a 5-sample file.
    await expect(open(5)).resolves.toBeTruthy()
  })

  it('the rule itself: three malformations, and the ONE exemption geotiff actually gives', () => {
    // (3) samples that disagree with each other.
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 16, 8], SampleFormat: [1, 1, 1] }, 3))
      .toThrow(/sample 1 is 16 where sample 0 is 8/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [16, 16], SampleFormat: [1, 3] }, 2))
      .toThrow(/SampleFormat/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1] }, 3))
      .not.toThrow()

    // (2) a tag whose LENGTH is not the sample count. Short leaves the reader indexing past its
    // end; LONG over-counts `getBytesPerPixel()` and decodes a silently wrong image, which is
    // why the rule is `!==` and not `<`.
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 8] }, 5))
      .toThrow(/its BitsPerSample tag carries 2 value\(s\)/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8] }, 5))
      .toThrow(/carries 1 value\(s\)/)
    // …at EVERY sample count, including 1. An earlier cut returned early at `samples <= 1` on
    // the ground that "one entry cannot disagree with itself" — true of the uniformity check
    // and not of the length check, which left the commonest shape this system emits unguarded.
    // Measured through the real open path with a 3-entry tag on a 1-sample fixture: it opened,
    // then threw `RangeError: Offset is outside the bounds of the DataView` per tile.
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 16], SampleFormat: [1, 1] }, 1))
      .toThrow(/carries 2 value\(s\)/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8], SampleFormat: [1] }, 1))
      .not.toThrow()
    // …and a LONG tag that is internally UNIFORM, which is the shape the `!==`-not-`<` decision
    // exists for and the only one the uniformity arm cannot also catch. The reason is measured
    // in `assertUniformSampleFormat`'s own docblock: the tag's length IS the pixel stride, so a
    // LONG one decodes every channel wrong with NOTHING thrown, while a short one at least
    // throws for the samples past its end. Every other long-tag case in this suite is also
    // non-uniform, so a `<` mutant survived them all on behaviour and differed only in message.
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 8, 8] }, 1))
      .toThrow(/carries 3 value\(s\)/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 8, 8, 8] }, 2))
      .toThrow(/carries 4 value\(s\)/)
    // A `Uint16Array`, which is what geotiff ACTUALLY supplies (both tags are in its
    // `arrayFields`) — the declared type says `ArrayLike<number>` for that reason, and
    // `Array.from` reads it. An earlier cut typed these `number[]`, which was wrong about the
    // only producer that exists, and carried a scalar branch the type made unreachable.
    expect(() => assertUniformSampleFormat({ BitsPerSample: Uint16Array.from([8, 8]) }, 2))
      .not.toThrow()
    expect(() => assertUniformSampleFormat({ BitsPerSample: Uint16Array.from([8, 16]) }, 2))
      .toThrow(/sample 1 is 16 where sample 0 is 8/)

    // (1) ABSENT. The asymmetry is geotiff's, not a preference: it defaults `SampleFormat` to 1
    // and has NO default for `BitsPerSample` — `getBitsPerSample(k)` is a bare index — so an
    // absent one opens and then throws `TypeError: Cannot read properties of undefined` per
    // tile. An earlier cut exempted BOTH, and a test asserted positively that it should.
    expect(() => assertUniformSampleFormat({}, 5)).toThrow(/carries no BitsPerSample tag/)
    expect(() => assertUniformSampleFormat({}, 1)).toThrow(/carries no BitsPerSample tag/)
    expect(() => assertUniformSampleFormat({ BitsPerSample: [8, 8] }, 2)).not.toThrow()
  })

  it('and the PER-LEVEL rule, all three arms', () => {
    // `assertLevelSampleLayout` is reached from the real open path by the mismatched-levels
    // fixture (TEST-13); its other two arms are shapes `tifffile` will not write, so they are
    // pinned here rather than by a second and third hand-patched file.
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 1 }, 1, 2))
      .toThrow(/one image cannot have two sample layouts/)
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2, PlanarConfiguration: 2 }, 1, 2))
      .toThrow(/PlanarConfiguration=2/)
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2, BitsPerSample: [8, 16] }, 1, 2))
      .toThrow(/sample 1 is 16/)
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2, BitsPerSample: [8, 8] }, 1, 2))
      .not.toThrow()
    // An omitted `SamplesPerPixel` is TIFF 6.0's default of 1, so against a 2-sample base it is
    // malformed — NOT a shorthand for "same as level 0".
    expect(() => assertLevelSampleLayout({}, 1, 2)).toThrow(/declares SamplesPerPixel=1/)
    // …and a level carrying no `BitsPerSample` at all is refused by the format rule it
    // delegates to, at every sample count. Every committed pyramid level carries one.
    expect(() => assertLevelSampleLayout({}, 1, 1)).toThrow(/carries no BitsPerSample tag/)
    expect(() => assertLevelSampleLayout({ BitsPerSample: [8] }, 1, 1)).not.toThrow()
    // …and every one of those messages NAMES THE LEVEL. Its two sibling refusals always did;
    // the format arms said "this OME-TIFF", which tells a user with a level-3-only defect that
    // their whole file is malformed and gives them no way to find it — in the branch that added
    // the two arms most likely to differ BETWEEN levels.
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2 }, 3, 2))
      .toThrow(/pyramid level 3 of this OME-TIFF declares SamplesPerPixel = 2 and carries no BitsPerSample/)
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2, BitsPerSample: [8] }, 3, 2))
      .toThrow(/pyramid level 3 of this OME-TIFF .* carries 1 value/)
    expect(() => assertLevelSampleLayout({ SamplesPerPixel: 2, BitsPerSample: [8, 16] }, 3, 2))
      .toThrow(/pyramid level 3 of this OME-TIFF declares BitsPerSample/)
    // …while the BASE directory's own messages do not, because there is no level to name.
    expect(() => assertUniformSampleFormat({}, 2)).toThrow(/^this OME-TIFF declares/)
  })
})

describe('TEST-15 one deck tile of an N-channel file costs ONE byte-range read per span', () => {
  it('N simultaneous channel reads of the same tile de-duplicate to one transport read', async () => {
    // Viv fetches a deck tile as `Promise.all(selections.map(getTile))`, so an N-channel source
    // issues N SIMULTANEOUS reads of the SAME span. The span cache is consulted synchronously
    // and populated only after the await, so before the in-flight join every one of them missed:
    // measured at 5 parallel transport reads of 1 unique span for one tile of the 5-sample file,
    // each of which also evicted a span an adjacent tile was about to reuse.
    const bytes = bytesOf(fixture(5))
    const spans: string[] = []
    const counting: ByteRangeSource = {
      byteLength: bytes.byteLength,
      async read(start, end) {
        spans.push(`${start}-${end}`)
        // A real transport is not synchronous. Without a turn of the event loop here the reads
        // would serialize on the microtask queue and the de-duplication would be untested.
        await new Promise(resolve => setTimeout(resolve, 0))
        return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
      },
    }
    const pyramid = await loadOmeTiffPyramid(counting)
    spans.length = 0

    // Exactly what `MultiscaleImageLayerBase` does for one tile.
    await Promise.all(
      Array.from({ length: 5 }, (_, c) => pyramid.pyramid[0].getTile({ x: 0, y: 0, selection: { c } })),
    )
    const unique = new Set(spans)
    expect(unique.size).toBeGreaterThan(0)
    expect(spans.length).toBe(unique.size)
  })
})

// ── TEST-2 [acceptance] [invariant: INV-2] ────────────────────────────────────────────────

describe('TEST-2 [acceptance] [invariant: INV-2] every declared channel decodes its OWN sample', () => {
  for (const row of TABLE) {
    it(`S=${row.samples}: declares ${row.channels} channel(s), and each one's PIXELS are that sample`, async () => {
      const pyramid = await open(row.samples)

      // (1) The declaration matches the §3 table, on every field a consumer reads.
      expect(pyramid.interleaved).toBe(row.interleaved)
      expect(pyramid.channels).toBe(row.channels)
      const level0 = pyramid.pyramid[0]
      expect(level0.labels).toEqual(row.labels)
      expect(level0.shape).toEqual(
        row.interleaved
          ? [row.channels, HEIGHT, WIDTH, row.samples]
          : [row.channels, HEIGHT, WIDTH],
      )

      // (2) The BYTES answer that declaration. This is the half `origin/main` failed: it
      // declared one channel over `samples`-sample bytes and served sample 0 for it.
      const perPixel = row.interleaved ? row.samples : 1
      for (let c = 0; c < row.channels; c++) {
        const raster = await level0.getRaster({ selection: { c } })
        expect(raster.width).toBe(WIDTH)
        expect(raster.height).toBe(HEIGHT)
        const data = asNumbers(raster.data)
        expect(data.length).toBe(WIDTH * HEIGHT * perPixel)

        // EVERY pixel, not a spot check: the substitution this catches differs everywhere, so
        // a sampled assertion would only be cheaper, never safer — and a full comparison over
        // 300x200 is microseconds.
        let mismatches = 0
        let firstBad = ''
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < WIDTH; x++) {
            for (let k = 0; k < perPixel; k++) {
              // An interleaved raster carries all `samples` of one pixel consecutively; a
              // planar channel carries one value per pixel, and WHICH sample it is is the
              // property under test.
              const sample = row.interleaved ? k : c
              const want = level0Sample(sample, x, y)
              const got = data[(y * WIDTH + x) * perPixel + k]
              if (got !== want) {
                if (mismatches === 0) firstBad = `at (${x},${y}) k=${k}: got ${got}, want ${want}`
                mismatches++
              }
            }
          }
        }
        expect(`${mismatches} mismatches ${firstBad}`).toBe('0 mismatches ')
      }
    })
  }
})

// ── TEST-3 [acceptance] [invariant: INV-2] ────────────────────────────────────────────────

describe('TEST-3 [acceptance] [invariant: INV-2] the same identity through getTile, on BOTH levels', () => {
  it('…at the SHIPPED tile size, which is the only one production ever asks for', async () => {
    // The parameterised cases below open at `tileSize: 128` to reach a multi-tile grid and a
    // partial remainder window. Production passes NO `limits`, so it gets
    // `DEFAULT_OME_TIFF_LIMITS.tileSize = 512` — at which this fixture is ONE tile and the
    // window arithmetic takes a different branch of Viv's `_getTileExtent`. Exercising only
    // 128 would leave the shipped geometry untested through `getTile`.
    for (const row of TABLE) {
      const pyramid = await open(row.samples)
      expect(pyramid.tileSize).toBe(512)
      const perPixel = row.interleaved ? row.samples : 1
      for (let c = 0; c < row.channels; c++) {
        const tile = await pyramid.pyramid[0].getTile({ x: 0, y: 0, selection: { c } })
        expect([row.samples, c, tile.width, tile.height]).toEqual([row.samples, c, WIDTH, HEIGHT])
        const data = asNumbers(tile.data)
        expect(data.length).toBe(WIDTH * HEIGHT * perPixel)
        for (const [x, y] of [[0, 0], [WIDTH - 1, HEIGHT - 1], [17, 91]]) {
          for (let k = 0; k < perPixel; k++) {
            const sample = row.interleaved ? k : c
            expect([row.samples, c, x, y, k, data[(y * WIDTH + x) * perPixel + k]]).toEqual([
              row.samples, c, x, y, k, level0Sample(sample, x, y),
            ])
          }
        }
      }
    }
  })

  // `getTile` is the call deck.gl actually makes; `getRaster` is the fallback path. They go
  // through different Viv code (`_getTileExtent` + a `window`), so proving one proves nothing
  // about the other — and the per-sample view has to survive both.
  //
  // `tileSize: 128` rather than the default 512 so the fixtures are genuinely MULTI-TILE
  // (level 0 is 300x200 -> x in 0..2, y in 0..1; level 1 is 150x100 -> x in 0..1, y = 0).
  // At 512 every tile is the whole image and the window arithmetic is never exercised.
  const TILE = 128

  for (const row of TABLE) {
    it(`S=${row.samples}: the origin AND the remainder tile of every level decode that channel's own sample`, async () => {
      const pyramid = await open(row.samples, TILE)
      expect(pyramid.pyramid).toHaveLength(2)
      const perPixel = row.interleaved ? row.samples : 1

      for (let level = 0; level < 2; level++) {
        const width = level === 0 ? WIDTH : LEVEL1_WIDTH
        const height = level === 0 ? HEIGHT : LEVEL1_HEIGHT
        // Viv's own tile-extent rule: the LAST tile on an axis carries the remainder. Both
        // tiles are read — the origin one (a full 128x128 window) and the far corner one
        // (a partial window at a non-zero offset), because a reader that ignored the window
        // entirely would still satisfy the first.
        const maxX = Math.floor(width / TILE)
        const maxY = Math.floor(height / TILE)
        for (const [tileX, tileY] of [
          [0, 0],
          [maxX, maxY],
        ]) {
          const tileW = tileX === maxX ? width % TILE : TILE
          const tileH = tileY === maxY ? height % TILE : TILE

          for (let c = 0; c < row.channels; c++) {
            const tile = await pyramid.pyramid[level].getTile({ x: tileX, y: tileY, selection: { c } })
            expect([level, tileX, tileY, c, tile.width, tile.height]).toEqual([
              level,
              tileX,
              tileY,
              c,
              tileW,
              tileH,
            ])
            const data = asNumbers(tile.data)
            expect(data.length).toBe(tileW * tileH * perPixel)

            let mismatches = 0
            let firstBad = ''
            for (let ty = 0; ty < tileH; ty++) {
              for (let tx = 0; tx < tileW; tx++) {
                for (let k = 0; k < perPixel; k++) {
                  const sample = row.interleaved ? k : c
                  // The tile's own origin, so a reader that returned the whole image, or the
                  // WRONG tile, fails here rather than passing on length.
                  const want = sampleAt(level, sample, tileX * TILE + tx, tileY * TILE + ty)
                  const got = data[(ty * tileW + tx) * perPixel + k]
                  if (got !== want) {
                    if (mismatches === 0) {
                      firstBad = `level ${level} tile (${tileX},${tileY}) c=${c} at (${tx},${ty}) k=${k}: got ${got}, want ${want}`
                    }
                    mismatches++
                  }
                }
              }
            }
            expect(`${mismatches} mismatches ${firstBad}`).toBe('0 mismatches ')
          }
        }
      }
    })
  }
})

// ── TEST-6 — the defect itself, re-run as a control ───────────────────────────────────────

describe('TEST-6 the exact observation that was true on origin/main is now false', () => {
  for (const samples of [2, 5]) {
    it(`S=${samples}: no longer declares [1,h,w], and channel 1 is not channel 0`, async () => {
      const pyramid = await open(samples)
      const level0 = pyramid.pyramid[0]

      // On `origin/main` this was EXACTLY `[1, 200, 300]` for both files — byte-identical to
      // the 1-sample fixture's declaration, over bytes carrying `samples` values per pixel.
      expect(level0.shape).not.toEqual([1, HEIGHT, WIDTH])

      const first = asNumbers((await level0.getRaster({ selection: { c: 0 } })).data)
      const second = asNumbers((await level0.getRaster({ selection: { c: 1 } })).data)
      expect(second.length).toBe(first.length)

      // "Renders sample 0 as the whole image" IS this equality. It held for every channel of
      // every one of these files before #288.
      let identical = 0
      for (let i = 0; i < first.length; i++) if (first[i] === second[i]) identical++
      expect(identical).toBe(0)
    })
  }

  it('the CONTROL: at S=1 the same comparison is degenerate — which is the pre-#288 state', async () => {
    // This assertion holds with the entire feature deleted, and that is the POINT of it: it is
    // a statement of what `origin/main` did to every one of these files, kept in-band so the
    // two assertions above are read as a difference rather than as a bare fact.
    // The control on the control, and it is the clearest statement of the defect in the file.
    // A single-plane source declares ONE channel and its indexer ignores the selection, so
    // "channel 1 is byte-identical to channel 0" is TRUE here and always was. That is exactly
    // the state the 2- and 5-sample files were in on `origin/main`: a source declaring one
    // channel over multi-sample bytes, answering every selection with sample 0.
    //
    // Without this, the assertions above would be satisfied by any two buffers that happen to
    // differ, and would say nothing about which sample each one is.
    const pyramid = await open(1)
    expect(pyramid.channels).toBe(1)
    const first = asNumbers((await pyramid.pyramid[0].getRaster({ selection: { c: 0 } })).data)
    const second = asNumbers((await pyramid.pyramid[0].getRaster({ selection: { c: 1 } })).data)
    let identical = 0
    for (let i = 0; i < first.length; i++) if (first[i] === second[i]) identical++
    expect(identical).toBe(first.length)
  })
})

// ── TEST-7 — the REAL render path, with no call-site change ───────────────────────────────

describe('TEST-7 the shipped layer builder issues one selection per SAMPLE', () => {
  for (const row of TABLE) {
    it(`S=${row.samples}: seeds ${row.channels} channel state(s) and covers every sample`, async () => {
      const pyramid = await open(row.samples)

      // `seedChannelsForLoader` is what `useGridRaster` calls when a `DataSource` supplies no
      // channel state, and it reads the count off the source's own `'c'` axis — so this is the
      // production derivation, not a re-implementation of it.
      const channels = seedChannelsForLoader(pyramid.pyramid)
      expect(channels).toHaveLength(row.channels)

      const layers = buildRasterImageLayers({
        loader: pyramid.pyramid,
        channels,
        cellId: 'pane-1',
      })
      expect(layers).toHaveLength(1)
      const props = (layers[0] as unknown as { props: { selections: { c: number }[] } }).props
      expect(props.selections).toEqual(
        Array.from({ length: row.channels }, (_, c) => ({ c })),
      )

      // …and every selection the layer will issue is ANSWERABLE, WITH ITS OWN SAMPLE. A layer
      // carrying N selections over a source that serves sample 0 for all of them is exactly
      // the state this whole item exists to end, and it would satisfy the assertion above.
      //
      // Asserted against the CLOSED FORM per channel rather than by counting distinct values:
      // `new Set(...).size === row.channels` is trivially satisfied at `row.channels === 1`,
      // which is three of the six rows, so it asserted nothing for exactly the cases that were
      // already working.
      const first = await Promise.all(
        props.selections.map(async selection =>
          asNumbers((await pyramid.pyramid[0].getRaster({ selection })).data)[0],
        ),
      )
      expect(first).toEqual(
        props.selections.map(({ c }) => level0Sample(row.interleaved ? 0 : c, 0, 0)),
      )
    })
  }
})

// ── TEST-8 — the three shipped shapes do not move ─────────────────────────────────────────

describe('TEST-8 SamplesPerPixel 1, 3 and 4 declare exactly what they declared before', () => {
  // Written as LITERALS rather than derived from the table, so a change to the classification
  // rule cannot quietly redefine what "unchanged" means. DEC-11.
  const FROZEN = [
    { samples: 1, shape: [1, 200, 300], labels: ['c', 'y', 'x'], interleaved: false, channels: 1 },
    { samples: 3, shape: [1, 200, 300, 3], labels: ['c', 'y', 'x', '_c'], interleaved: true, channels: 1 },
    { samples: 4, shape: [1, 200, 300, 4], labels: ['c', 'y', 'x', '_c'], interleaved: true, channels: 1 },
  ] as const

  for (const frozen of FROZEN) {
    it(`S=${frozen.samples}`, async () => {
      const pyramid = await open(frozen.samples)
      expect(pyramid.pyramid[0].shape).toEqual(frozen.shape)
      expect(pyramid.pyramid[0].labels).toEqual(frozen.labels)
      expect(pyramid.interleaved).toBe(frozen.interleaved)
      expect(pyramid.channels).toBe(frozen.channels)
      expect(pyramid.tileSize).toBe(512)
      expect(pyramid.tiled).toBe(true)
      expect(pyramid.meta.levels.map(l => [l.width, l.height])).toEqual([
        [WIDTH, HEIGHT],
        [LEVEL1_WIDTH, LEVEL1_HEIGHT],
      ])
    })
  }

  it('the three PRE-EXISTING emitted fixtures still open unchanged', async () => {
    // The family above is new bytes. These are the artifacts the system actually shipped, and
    // they are the ones a regression here would cost.
    const hires = await loadOmeTiffPyramid(fileSource('spatial-image-hires.ome.tif'))
    expect([hires.interleaved, hires.channels, hires.pyramid[0].shape]).toEqual([
      true,
      1,
      [1, 1800, 1400, 3],
    ])
    const grey = await loadOmeTiffPyramid(fileSource('spatial-image-greyscale.ome.tif'))
    expect([grey.interleaved, grey.channels, grey.pyramid[0].shape]).toEqual([
      false,
      1,
      [1, 1024, 768],
    ])
    // …and the third, which the title claims and an earlier version of this test omitted.
    const lowres = await loadOmeTiffPyramid(fileSource('spatial-image-lowres.ome.tif'))
    expect([lowres.interleaved, lowres.channels, lowres.pyramid[0].shape]).toEqual([
      true,
      1,
      [1, 540, 420, 3],
    ])
  })
})

// ── TEST-10 — fixture provenance, read from the committed bytes ───────────────────────────

describe('TEST-10 the committed fixtures carry the headers the family claims', () => {
  for (const samples of [1, 2, 3, 4, 5, 10, 11]) {
    it(`samples-per-pixel-${samples}.ome.tif`, async () => {
      const bytes = bytesOf(fixture(samples))
      const tiff = await fromArrayBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
      // ONE top-level IFD: the pyramid rides `SubIFDs`, so a regenerated file that lost them
      // would present as a multi-plane image and hit a different refusal entirely.
      expect(await tiff.getImageCount()).toBe(1)
      const directory = (await tiff.getImage(0)).fileDirectory as Record<string, unknown>
      expect(directory.SamplesPerPixel).toBe(samples)
      // Absent at S=1, where TIFF 6.0 makes it meaningless; CONTIG (1) everywhere else.
      expect(directory.PlanarConfiguration ?? 1).toBe(1)
      expect((directory.SubIFDs as number[]).length).toBe(1)
      expect(directory.TileWidth).toBe(512)
      // 32946 is TIFF's `DEFLATE`, which is what `tifffile` writes for `compression='deflate'`
      // (the writer's `CODEC`) — NOT 8, `ADOBE_DEFLATE`. The number is asserted rather than
      // named because `assertDecodableCodec` branches on this exact tag value.
      expect(directory.Compression).toBe(32946)
      expect([directory.ImageWidth, directory.ImageLength]).toEqual([WIDTH, HEIGHT])
      // The two tags `fixtures/README.md` makes a per-row claim about, and which the generator
      // printed without asserting. Read here out of the COMMITTED bytes, so the claim holds
      // without the generator ever being run again. 2 = RGB, 1 = MINISBLACK; ExtraSamples
      // 2 = UNASSALPHA (TIFF 6.0's RGBA), 0 = UNSPECIFIED (the file declines to say).
      expect(directory.PhotometricInterpretation).toBe(samples === 3 || samples === 4 ? 2 : 1)
      const extras = (directory.ExtraSamples as number[] | undefined) ?? []
      expect(Array.from(extras)).toEqual(
        samples === 4 ? [2] : samples === 1 || samples === 3 ? [] : new Array(samples - 1).fill(0),
      )
    })
  }
})

// ── TEST-12 — the metadata and the sources describe ONE image ─────────────────────────────

describe('TEST-12 the normalized meta and the PixelSource shapes cannot describe different images', () => {
  for (const row of TABLE) {
    it(`S=${row.samples}`, async () => {
      const pyramid = await open(row.samples)
      expect(pyramid.channels).toBe(row.channels)
      expect(pyramid.meta.levels).toHaveLength(2)

      for (let level = 0; level < 2; level++) {
        const declared = pyramid.meta.levels[level]
        const raster = await pyramid.pyramid[level].getRaster({ selection: { c: 0 } })
        // The catalog states the header from `meta.levels`; `omeTiffUnderlay` serves bytes
        // from the source. A disagreement renders as a sheared picture rather than an error,
        // which is why the two are compared against each other rather than each against a
        // literal.
        expect([declared.width, declared.height]).toEqual([raster.width, raster.height])
      }
      expect(pyramid.meta.levels.map(l => [l.width, l.height])).toEqual([
        [WIDTH, HEIGHT],
        [LEVEL1_WIDTH, LEVEL1_HEIGHT],
      ])
      expect(pyramid.meta.dtype).toBe('Uint8')
      // The CHANNEL LIST, which is the part of the normalization this change can move: the
      // extent assertions above hold against the pre-#288 code too (level widths and heights
      // were always right), so on their own they say nothing about the classification.
      //
      // It is NOT an independent route, and an earlier version of this comment said it was:
      // `loadOmeTiffPyramid` computes `channels` once, hands that same value to `ngffForLevels`,
      // and `parseChannels` reads it back off the shape it wrote. That round trip can only
      // catch a plumbing bug between those two. So the INDEPENDENT check is the one below —
      // against the FILE's own `SamplesPerPixel` tag, parsed by geotiff directly, which is
      // where the classification's input actually comes from.
      expect(pyramid.meta.channels).toHaveLength(row.channels)

      const bytes = bytesOf(fixture(row.samples))
      const tiff = await fromArrayBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
      const declared = ((await tiff.getImage(0)).fileDirectory as { SamplesPerPixel?: number })
        .SamplesPerPixel
      expect([row.samples, declared]).toEqual([row.samples, row.samples])
      // The rule, restated against the file rather than against the loader: interleaved colour
      // is ONE channel of S samples; everything else is S channels of one sample.
      expect(pyramid.channels).toBe(declared === 3 || declared === 4 ? 1 : declared)
    })
  }
})

// ── TEST-19 — the out-of-range selection: refused here, prevented one layer up ────────────

describe('TEST-19 a selection outside the declared channel axis is refused, and the grid cannot make one', () => {
  it('the source refuses it by name rather than serving sample 0', async () => {
    // A blind audit mutated this guard to `false` and every test in the package stayed green,
    // and its comment claimed the case was unreachable. Both are now false: it is reachable
    // (below), and it is asserted here.
    const pyramid = await open(2)
    for (const c of [2, 5, -1, 1.5]) {
      const failure = await pyramid.pyramid[0]
        .getRaster({ selection: { c } })
        .then(
          () => null,
          (error: unknown) => error as Error,
        )
      expect([c, failure?.name]).toEqual([c, 'OmeTiffLoadError'])
      expect(failure?.message).toContain('channel axis runs 0..1')
    }
  })

  it('an ABSENT channel key is refused too, and is not defaulted to sample 0', async () => {
    // `selection?.c ?? 0` sat two lines above a guard whose stated reason is that clamping to 0
    // is the silent partial render this file exists to stop. Same outcome, different caller bug.
    const pyramid = await open(5)
    await expect(
      pyramid.pyramid[0].getRaster({ selection: {} as { c: number } }),
    ).rejects.toThrow(OmeTiffLoadError)
  })

  it('the SHIPPED emit PATH clamps a stale cell.channels, end to end', async () => {
    // The wiring, not the helper. `buildImagePaneLayers` is what `GridDeckLayer` calls, so this
    // asserts the OUTCOME of the whole emit path rather than any one function in it — and that
    // is stated precisely, because an earlier version of this test was titled "the emit SITE …
    // reverting it must go red" and did not: `buildRasterImageLayers` reconciles too, so the
    // site's own call was redundant and its removal was invisible here. (The redundant call is
    // gone; `rasterImageLayers.test.ts` pins the builder's own reconciliation directly.)
    const twoSample = await open(2)
    const fiveSample = await open(5)
    const staleFive = seedChannelsForLoader(fiveSample.pyramid)

    const emitFor = (pyramid: OmeTiffPyramid, channels: RasterChannelState[]) => {
      const image = omeTiffUnderlayMeta(pyramid)
      const frame = resolvePaneFrame({ image, layouts: [] }, 'none')
      const emit = buildImagePaneLayers({
        cell: { id: 'pane-1', kind: 'image', layoutId: 'none', channels } as GridCell,
        frame,
        pyramid: { loader: pyramid.pyramid, channels, contrastMax: 255 } as never,
        underlay: undefined,
      })
      return (emit.layers[0] as unknown as { props: { selections: { c: number }[] } }).props
        .selections
    }

    // TOO LONG for the loader: unreconciled this emitted {c:0}..{c:4} against a 2-channel
    // source, and every tile threw `OmeTiffLoadError` from inside the render loop.
    expect(emitFor(twoSample, staleFive)).toEqual([{ c: 0 }, { c: 1 }])
    // TOO SHORT: unreconciled this drew ONE of five samples and named none of the others —
    // INV-3, broken one layer above the reader that enforces it.
    expect(emitFor(fiveSample, staleFive.slice(0, 1))).toEqual([
      { c: 0 }, { c: 1 }, { c: 2 }, { c: 3 }, { c: 4 },
    ])
    // …and a cell whose channel state matches its loader is untouched.
    expect(emitFor(fiveSample, staleFive)).toHaveLength(5)
  })

  it('a stale MULTI-channel array on a single-channel loader now draws one channel', async () => {
    // A visible behaviour change for an existing saved cell, asserted rather than left to be
    // discovered: before the reconciliation this emitted N selections that all resolved to the
    // same plane and composited additively — a tinted, brightened picture produced by a stale
    // array rather than by the file. It is now one channel, which is what the file has.
    const oneSample = await open(1)
    const three = seedChannelsForLoader((await open(5)).pyramid).slice(0, 3)
    // Asserted through the LAYER, because the prose is about what is drawn. Calling the helper
    // and checking a length duplicates the pure coverage below and says nothing about a render.
    const layers = buildRasterImageLayers({
      loader: oneSample.pyramid,
      channels: three,
      cellId: 'stale',
    })
    const props = (layers[0] as unknown as { props: { selections: { c: number }[]; colors: unknown[] } }).props
    expect(props.selections).toEqual([{ c: 0 }])
    expect(props.colors).toHaveLength(1)
  })

  it('…and `reconcileChannelsToLoader`, as a function, extends as well as truncates', async () => {
    // THE REACHABLE PATH the guard's comment used to deny. `buildRasterImageLayers` derives
    // selections from the CHANNEL STATE ARRAY, and both grid call sites take a persisted
    // `cell.channels` (which `propagateToLinked` also copies between cells). A 5-channel array
    // on a 2-sample loader issued {c:2}..{c:4} and failed every tile; a 1-entry array on a
    // 5-sample loader left four samples neither displayed nor named — the #288 invariant,
    // reintroduced one layer up.
    const twoSample = await open(2)
    const fiveSample = await open(5)
    const staleFive = seedChannelsForLoader(fiveSample.pyramid)
    expect(staleFive).toHaveLength(5)

    // TOO LONG for its loader -> truncated to what the source can serve.
    const narrowed = reconcileChannelsToLoader(staleFive, twoSample.pyramid)
    expect(narrowed).toHaveLength(2)
    const narrowedLayer = buildRasterImageLayers({
      loader: twoSample.pyramid,
      channels: narrowed,
      cellId: 'narrow',
    })
    const narrowedProps = (narrowedLayer[0] as unknown as { props: { selections: { c: number }[] } }).props
    expect(narrowedProps.selections).toEqual([{ c: 0 }, { c: 1 }])
    // Every selection it will issue is answerable — which is the property that matters.
    for (const selection of narrowedProps.selections) {
      await expect(twoSample.pyramid[0].getRaster({ selection })).resolves.toBeTruthy()
    }

    // TOO SHORT -> extended from the seeded defaults, so the extra samples APPEAR rather than
    // silently vanish. Truncating in both directions would have been the easier fix and would
    // have re-created the defect this branch exists to remove.
    const widened = reconcileChannelsToLoader(staleFive.slice(0, 1), fiveSample.pyramid)
    expect(widened).toHaveLength(5)
    expect(widened[0]).toBe(staleFive[0]) // the caller's own state for channel 0 is kept
  })
})

// ── TEST-20 — the byte source's caching contract ──────────────────────────────────────────

describe('TEST-20 one transport read per span, and a SEPARATE buffer for every caller', () => {
  const spanSource = () => {
    const bytes = new Uint8Array(64).map((_, i) => i)
    const reads: string[] = []
    const source: ByteRangeSource = {
      byteLength: bytes.byteLength,
      async read(start, end) {
        reads.push(`${start}-${end}`)
        await new Promise(resolve => setTimeout(resolve, 0))
        return bytes.buffer.slice(start, end + 1)
      },
    }
    return { reads, source }
  }

  it('a cache hit and an in-flight join both return their OWN buffer', async () => {
    // Sharing one `ArrayBuffer` between decodes is not safe here and the reason is in the
    // vendored decoder: geotiff's `RawDecoder.decodeBlock` returns its INPUT, and
    // `applyPredictor` then accumulates the differencing IN PLACE. So for `Compression = 1`
    // (which `DECODABLE_COMPRESSION` admits) with a `Predictor`, a second decode of a shared
    // span double-applies it — wrong pixels, no error. It was already reachable through the
    // span cache; the in-flight join made it certain for every tile of a multi-channel file.
    //
    // No fixture can reach that (nothing here emits uncompressed-with-predictor), so the
    // property is asserted where it lives: identity, not content.
    const { reads, source } = spanSource()
    const cached = new ByteRangeGeoTiffSource(source, 256)

    // THREE return paths, each mutated separately, because an earlier version of this test
    // discriminated only ONE: the creator's. It took `a`/`b` from the creator/join and `c`/`d`
    // from the cache, then asserted `c !== a && c !== b` — true even when the cache hands back
    // its own shared buffer — and mutated only `a`. Removing the cache-hit copy or the join
    // copy left the whole package green.
    const [creator, joiner] = await Promise.all([
      cached.fetchSlice({ offset: 0, length: 16 }),
      cached.fetchSlice({ offset: 0, length: 16 }),
    ])
    expect(reads).toEqual(['0-15']) // ONE transport read for two concurrent callers
    const firstHit = await cached.fetchSlice({ offset: 0, length: 16 })
    const secondHit = await cached.fetchSlice({ offset: 0, length: 16 })
    expect(reads).toEqual(['0-15']) // both served from the cache

    // Pairwise distinct: no two callers hold the same buffer, whichever path served them.
    const all = [creator, joiner, firstHit, secondHit]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect([i, j, all[i] === all[j]]).toEqual([i, j, false])
      if (i > 0) expect(new Uint8Array(all[i])).toEqual(new Uint8Array(creator))
    }

    // …and a caller that MUTATES its buffer — which is exactly what geotiff's raw decoder path
    // does — cannot reach any OTHER caller or poison the cache, from ANY of the three paths.
    for (const [name, victim] of [
      ['creator', creator],
      ['joiner', joiner],
      ['cache-hit', firstHit],
    ] as const) {
      new Uint8Array(victim)[0] = 255
      for (const other of all) {
        if (other === victim) continue
        expect([name, new Uint8Array(other)[0]]).toEqual([name, 0])
      }
      const fresh = await cached.fetchSlice({ offset: 0, length: 16 })
      expect([name, new Uint8Array(fresh)[0]]).toEqual([name, 0])
      new Uint8Array(victim)[0] = 0 // restore, so each path is tested against a clean set
    }
  })

  it('reads under DIFFERENT abort signals are not joined', async () => {
    // Two callers sharing a promise share its cancellation, so joining across signals would let
    // one abandoned viewport abort a live one's read. The join is deliberately narrower than
    // "same span".
    const { reads, source } = spanSource()
    const cached = new ByteRangeGeoTiffSource(source, 256)
    const first = new AbortController()
    const second = new AbortController()
    await Promise.all([
      cached.fetchSlice({ offset: 32, length: 8 }, first.signal),
      cached.fetchSlice({ offset: 32, length: 8 }, second.signal),
    ])
    expect(reads).toEqual(['32-39', '32-39'])
  })

  it('the cache bound is defaulted and clamped, because the constructor is now public', async () => {
    // Exporting the class made `new ByteRangeGeoTiffSource(source, n)` a contract, and two
    // values a caller can supply are not requests anyone means. Both were reachable —
    // `loadOmeTiffPyramid` merges the caller's `limits` unchecked — and neither said anything.
    const build = (size?: number) => {
      const bytes = new Uint8Array(4096).map((_, i) => i & 0xff)
      const reads: string[] = []
      const source: ByteRangeSource = {
        byteLength: bytes.byteLength,
        async read(start, end) {
          reads.push(`${start}-${end}`)
          return bytes.buffer.slice(start, end + 1)
        },
      }
      return { reads, cached: new ByteRangeGeoTiffSource(source, size as number) }
    }

    // The failure this closes is UNBOUNDEDNESS: a bound that no `size >= bound` can ever reach
    // means nothing is evicted and the cache grows to the whole file. `undefined` reaches that
    // through a missing argument, `NaN` through a caller that computed its limit — and so does
    // `Infinity`, which is a NUMBER and therefore sailed through an earlier `max(1, floor(n) ||
    // DEFAULT)` untouched. All three must behave like the default: a 257th distinct span evicts
    // the first.
    for (const bound of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { reads, cached } = build(bound)
      for (let i = 0; i < DEFAULT_OME_TIFF_LIMITS.spanCacheSize + 1; i++) {
        await cached.fetchSlice({ offset: i * 4, length: 4 })
      }
      const before = reads.length
      await cached.fetchSlice({ offset: 0, length: 4 }) // evicted: costs a transport read
      expect([String(bound), reads.length]).toEqual([String(bound), before + 1])
      const after = reads.length
      await cached.fetchSlice({ offset: 1024, length: 4 }) // still resident: costs nothing
      expect([String(bound), reads.length]).toEqual([String(bound), after])
    }

    // ZERO, a SUB-1 FRACTION and a NEGATIVE all mean "as small as possible", and all three
    // reach a bound of ONE — which IS observable: with a bound of 1 a second distinct span
    // evicts the first, so re-reading span 0 costs a transport read. An earlier
    // `max(1, floor(n) || DEFAULT)` sent `0`, `0.5` and `0.9` to the `|| DEFAULT` arm instead,
    // i.e. to 256: a caller asking for no caching silently got the LARGEST cache the class
    // offers, and the function was non-monotonic (`0.5 -> 256` while `1.5 -> 1`).
    // A FRACTIONAL bound above 1 is floored, not rounded and not passed through: a caller that
    // computed a limit is the stated motivation for normalizing at all, and `3.9` must mean 3
    // spans rather than 3.9 of one.
    {
      const { reads, cached } = build(3.9)
      for (let i = 0; i < 3; i++) await cached.fetchSlice({ offset: i * 4, length: 4 })
      const before = reads.length
      await cached.fetchSlice({ offset: 0, length: 4 }) // still resident at a bound of 3
      expect(reads.length).toBe(before)
      await cached.fetchSlice({ offset: 12, length: 4 }) // the 4th distinct span evicts the 1st
      await cached.fetchSlice({ offset: 0, length: 4 })
      expect(reads.length).toBe(before + 2)
    }

    for (const bound of [0, 0.5, 0.9, -5]) {
      const { reads, cached } = build(bound)
      await cached.fetchSlice({ offset: 0, length: 4 })
      await cached.fetchSlice({ offset: 0, length: 4 })
      expect([bound, reads.length]).toEqual([bound, 1]) // same span twice: one read
      await cached.fetchSlice({ offset: 8, length: 4 }) // a second span evicts the first
      await cached.fetchSlice({ offset: 0, length: 4 })
      expect([bound, reads.length]).toEqual([bound, 3])
    }
  })

  it('a FAILED read is not sticky — the next caller retries', async () => {
    // A retained rejected promise would make every later read of that span replay a failure the
    // transport may since have fixed (an expired token, a refreshed session).
    let attempts = 0
    const source: ByteRangeSource = {
      byteLength: 64,
      async read(start, end) {
        attempts++
        if (attempts === 1) throw new Error('transport down')
        return new ArrayBuffer(end - start + 1)
      },
    }
    const cached = new ByteRangeGeoTiffSource(source, 256)
    await expect(cached.fetchSlice({ offset: 0, length: 8 })).rejects.toThrow('transport down')
    await expect(cached.fetchSlice({ offset: 0, length: 8 })).resolves.toBeTruthy()
    expect(attempts).toBe(2)
  })
})
