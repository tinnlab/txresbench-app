// spotOverlayRegistration.test.ts — #228 TEST-4 [acceptance] [invariant: INV-5].
//
// > *"the spot centres drawn on the tissue image at the declared transform, exactly as Space
// >  Ranger's own `detected_tissue_image.jpg` does. A human sees a misregistration instantly and
// >  sees nothing else about it."*   — design §7.5
//
// ── THE STANDARD, AND WHY THIS FILE IS SHAPED THE WAY IT IS ─────────────────────────────────
//
// #156's TEST-9: a deliberately wrong affine passed every check that system had, and its blind
// auditor's mutation — ignore the mapping and draw circles on an arbitrary lattice — left all 38
// tests green, because the acceptance test was sensitive to the circle RADIUS rather than the spot
// POSITION. An overlay test that cannot distinguish correct placement from arbitrary placement is
// worse than none, because it certifies the defect.
//
// So this file scores a mark by WHERE IT LANDS, against the image's OWN DECODED PIXELS, and it
// carries its negative controls in-band: the SAME scorer is re-run against (a) the pre-#228
// identity placement and (b) an arbitrary lattice, and both are asserted to fail the assertion the
// correct placement passes. Every run therefore demonstrates that the oracle is sharp, rather than
// asking a reader to believe it.
//
// ── WHAT IS REAL HERE, STATED PRECISELY (this matters, and it is a finding of its own) ───────
//
// * REAL: the OME-TIFF is the literal output of the shipped writer over the shipped Visium
//   importer (`fixtures/README.md`). Its pyramid, strips, codec, interleave and IFD layout are
//   what the system emits, and it is opened by the REAL `loadOmeTiffPyramid` over range reads.
// * REAL: the placement — `to_space [5,0,0,0,5,0]` — and the `coordinate_space` id come from the
//   producer's own emitted `manifest.json` entry.
// * REAL: the 160 spot positions are 10x's own `pxl_col_in_fullres` / `pxl_row_in_fullres`.
// * SYNTHESIZED: the image PIXELS. `visium_fixtures.make_imaged` says why.
//
// ── THE REASON THIS FILE USED TO GIVE IS FALSE, AND IS RETRACTED (#294 / #243) ───────────────
//
// This block used to end: *"There is NO committed artifact in this repo where a real tissue image
// and its real spots are geometrically coherent."* **That is no longer true, and it was the
// STATED JUSTIFICATION for scoring a synthetic marker instead of real tissue** — which is why it
// is retracted by name here rather than quietly deleted. #243 replaced
// `spatial-import-visium/tests/fixtures/visium-outs/spatial/tissue_hires_image.png` with 10x
// Genomics' own **2000x2000** emission for the same bundle (the file it replaced was measured to
// be a bit-identical PIL BICUBIC 10x downscale of it), and **all 160 of the bundle's spots land
// on it**: `spatial-import-visium/tests/test_image_coherence.py` asserts the coherence directly,
// and `test_registration_qc.py` asserts it end-to-end through the importer
// (`spots_inside_image == 160` on the real vendor bundle).
//
// #243's own diagnosis is that this sentence, restated in several places, is HOW two independent
// items each settled for a weaker oracle — #228 for the marker below, #156 for a circular R^2
// control. Leaving it in place tells the next reader the unlock never happened. The retired
// sentences are now machine-checked in this package by `staleClaims.test.ts`, so this correction
// cannot rot back in silently the way the original claim did.
//
// ── SO WHY IS THE ORACLE STILL THE MARKER? TWO REASONS SURVIVE, AND ONE DID NOT ──────────────
//
// 1. **The coherent vendor image is SQUARE (2000x2000); this fixture is 1400x1800.**
//    `spatial-import-visium/tests/test_spatial_image.py` says it in as many words — the vendor
//    image "cannot serve here even now that it is real and coherent (#243): it is 2000x2000, i.e.
//    square" — and design §7.3 rule 5 demands a NON-SQUARE fixture, because a transposed extent
//    is invisible on a square one. `productMatrix` runs through `omeTiffUnderlayMeta` and
//    `resolvePaneFrame`, both of which carry width and height separately.
// 2. **The marker is EXACT; a tissue score is statistical.** It is asserted to 6 decimal places,
//    in both directions, with two negative controls that must FAIL it (the pre-#228 identity, and
//    an arbitrary 160-point lattice over the same bounding box). #156's TEST-9 is the reason that
//    standard exists: a deliberately wrong affine passed every check that system had.
// 3. **What did NOT survive: "no coherent artifact exists".** It does. What acting on it COSTS is
//    measured rather than waved at: the vendor `tissue_hires_image.png` is 4,343,953 B as PNG, so
//    an emitted DEFLATE OME-TIFF pyramid of it is several megabytes, against a fixture directory
//    whose largest member is 167,778 B — a fixture ~30x anything here, to buy a statistically
//    weaker oracle on a square image. That is #228's budget to spend; #294 says the substantive
//    follow-on "probably belongs on #228 itself", and this file records the measurement rather
//    than the excuse.
//
// `make_imaged` paints one saturated square at a known FULL-RESOLUTION coordinate into every image
// it writes, at that image's own scalefactor — so the same physical feature exists in the hires
// image at one pixel address and in the lowres image at a different one. Reading it back out of
// the decoded pixels is an observation of the artifact, not of any code under test.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOmeTiffPyramid, type ByteRangeSource, type OmeTiffPyramid } from './omeTiffPyramid'
import { omeTiffUnderlayMeta } from './omeTiffUnderlay'
import { resolvePaneFrame } from './coordinateBinding'
import { buildImagePaneLayers } from '../grid/useGridDeckInputs'
import type { GridCell } from '../grid/gridModel'

/** THIS module's own directory. The source assertions below resolve from here rather than from
 *  `process.cwd()`, so they cannot silently read the wrong file under a different runner root. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

const FIXTURES = path.join(HERE, 'fixtures')

function fileSource(file: string): ByteRangeSource {
  const bytes = readFileSync(file)
  return {
    byteLength: bytes.byteLength,
    async read(start, end) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

const ENTRIES = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; meta: Record<string, unknown> }[]

const VENDOR = JSON.parse(
  readFileSync(path.join(FIXTURES, 'vendor-spot-positions.json'), 'utf8'),
) as { coordinate_space: string; count: number; spots: { barcode: string; in_tissue: number; x: number; y: number }[] }

const metaOf = (id: string): Record<string, unknown> => {
  const e = ENTRIES.find(x => x.id === id)
  if (!e) throw new Error(`fixture has no entry "${id}"`)
  return e.meta
}

/**
 * The marker's FULL-RESOLUTION coordinate, from the fixture generator that paints it:
 * `spatial-import-visium/tests/visium_fixtures.py` — `IMAGED_MARKER_XY = (4900, 2700)`.
 *
 * Written here as a citation, and then INDEPENDENTLY re-derived below from the two images'
 * disagreeing pixel addresses, so the test does not rest on a constant a reader has to trust.
 */
const MARKER_XY: readonly [number, number] = [4900, 2700]

/** The oracle: the marker's pixel centroid, read out of the DECODED raster. */
async function markerPixel(pyramid: OmeTiffPyramid): Promise<{ x: number; y: number; count: number }> {
  const level0 = pyramid.pyramid[0]
  const raster = await level0.getRaster({ selection: { c: 0 } })
  const data = raster.data as unknown as ArrayLike<number>
  const labels = (level0.labels ?? []) as readonly string[]
  // BY NAME, never positionally. An interleaved RGB raster is `['c','y','x','_c']`, and a
  // positional read takes the SAMPLE COUNT (3) as the width — the #159 defect that drew a
  // 1400x1800 image as 3x1800 with a clean console.
  const componentAxis = labels.lastIndexOf('_c')
  const samples = componentAxis >= 0 ? level0.shape[componentAxis] : 1
  let sx = 0
  let sy = 0
  let count = 0
  for (let p = 0; p < raster.width * raster.height; p++) {
    let saturated = true
    for (let k = 0; k < Math.min(3, samples); k++) {
      if (data[p * samples + k] !== 255) {
        saturated = false
        break
      }
    }
    if (!saturated) continue
    sx += p % raster.width
    sy += Math.floor(p / raster.width)
    count++
  }
  if (count === 0) throw new Error('no saturated marker pixel found in the decoded raster')
  return { x: sx / count, y: sy / count, count }
}

/** Apply a COLUMN-MAJOR 4x4 to a 2-D point. Written out so it is not the module's own transform. */
function through(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]]
}

/** Invert the 2-D part of a column-major 4x4 — space -> the raster's own pixel grid. */
function inverseThrough(m: readonly number[], x: number, y: number): [number, number] {
  const [a, c, b, d, tx, ty] = [m[0], m[1], m[4], m[5], m[12], m[13]]
  const det = a * d - b * c
  const ux = x - tx
  const uy = y - ty
  return [(d * ux - b * uy) / det, (-c * ux + a * uy) / det]
}

const CELL: GridCell = { id: 'pane-1', kind: 'image', layoutId: 'coords' }

/** The matrix the PRODUCT puts on the raster layer, for a given declared placement. */
function productMatrix(pyramid: OmeTiffPyramid, meta: Record<string, unknown>): number[] {
  const image = omeTiffUnderlayMeta(
    pyramid,
    meta.to_space as number[],
    meta.coordinate_space as string,
  )
  const frame = resolvePaneFrame(
    {
      image,
      // The coordinates artifact's own declaration: the same space, and — as `import_visium.py`
      // writes — its positions stated IN that space, i.e. an identity `to_space` (§6.6).
      layouts: [
        { id: 'coords', space: meta.coordinate_space as string, toSpace: [1, 0, 0, 0, 1, 0] },
      ],
    },
    'coords',
  )
  expect(frame.binding.bound).toBe(true)
  const emit = buildImagePaneLayers({
    cell: CELL,
    frame,
    pyramid: { loader: pyramid.pyramid, channels: [], contrastMax: 255 } as never,
    underlay: undefined,
  })
  const layer = emit.layers[0] as { props: { modelMatrix?: { toArray?: () => number[] } | number[] } }
  const raw = layer.props.modelMatrix
  const m = Array.isArray(raw) ? raw : raw?.toArray?.()
  if (!m) throw new Error('the emitted raster layer carries no modelMatrix')
  return m
}

/**
 * THE SCORER. Does any mark in `marks` (coordinate-space positions) land on a saturated pixel of
 * the decoded raster, under `matrix`?
 *
 * This is the whole assertion: a mark lands where the picture says the thing it names is. It is
 * indifferent to how big the mark is drawn, which is exactly what #156's TEST-9 was not.
 */
function marksOnMarker(
  matrix: readonly number[],
  marks: readonly (readonly [number, number])[],
  marker: { x: number; y: number },
  tolerancePx: number,
): number {
  let hits = 0
  for (const [x, y] of marks) {
    const [px, py] = inverseThrough(matrix, x, y)
    if (Math.hypot(px - marker.x, py - marker.y) <= tolerancePx) hits++
  }
  return hits
}

describe('TEST-4 [acceptance] [invariant: INV-5] a mark lands on the feature it names, on a REAL artifact', () => {
  it('the declared placement puts the marker mark on the marker pixels; identity and an arbitrary lattice do not', async () => {
    const hiresMeta = metaOf('spatial-image-hires')
    const pyramid = await loadOmeTiffPyramid(fileSource(path.join(FIXTURES, 'spatial-image-hires.ome.tif')))
    const marker = await markerPixel(pyramid)

    // The observation, before any code under test is involved: a 3x3 saturated block at (980,540)
    // in the emitted 1400x1800 grid.
    expect(marker.count).toBe(9)
    expect(marker.x).toBeCloseTo(980, 6)
    expect(marker.y).toBeCloseTo(540, 6)

    const matrix = productMatrix(pyramid, hiresMeta)

    // ── (1) THE PLACEMENT IS RIGHT, checked against the image's own pixels ──────────────────
    // Round trip: the declared marker coordinate, pushed through the product's matrix INVERSE,
    // must land on the pixels that are actually saturated. Tolerance is ONE emitted pixel — the
    // marker block's own half-width — not a fudge factor.
    const hits = marksOnMarker(matrix, [MARKER_XY], marker, 1)
    expect(hits).toBe(1)
    // …and forward, so the two directions are both pinned: the saturated centroid placed into the
    // space IS the declared marker coordinate.
    const placed = through(matrix, marker.x, marker.y)
    expect(placed[0]).toBeCloseTo(MARKER_XY[0], 6)
    expect(placed[1]).toBeCloseTo(MARKER_XY[1], 6)

    // ── (2) NEGATIVE CONTROL A — the pre-#228 IDENTITY placement ────────────────────────────
    // This is exactly what the grid did before this item: the raster drawn at its own pixel
    // bounds while the points sit at their declared coordinates. It is the mutation "ignore the
    // mapping", and it must fail the assertion above.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(marksOnMarker(identity, [MARKER_XY], marker, 1)).toBe(0)
    // …by a LOT, and the amount is stated so a shrinking failure is visible: 4900-980 = 3920 px.
    const [ix, iy] = inverseThrough(identity, MARKER_XY[0], MARKER_XY[1])
    expect(Math.abs(ix - marker.x)).toBeCloseTo(3920, 6)
    expect(Math.abs(iy - marker.y)).toBeCloseTo(2160, 6)

    // ── (3) NEGATIVE CONTROL B — an ARBITRARY LATTICE ───────────────────────────────────────
    // #156's auditor's exact mutation: ignore the mapping and draw on an evenly spaced lattice
    // over the same bounding box. 160 marks, the same count as the real spot table, spread over
    // the identical extent — so nothing about SIZE, COUNT or RANGE distinguishes them from the
    // real ones. Only WHERE they are does, which is the property under test.
    const xs = VENDOR.spots.map(s => s.x)
    const ys = VENDOR.spots.map(s => s.y)
    const lattice: [number, number][] = []
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 10; j++) {
        lattice.push([
          Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * i) / 15,
          Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * j) / 9,
        ])
      }
    }
    expect(lattice).toHaveLength(160)
    expect(marksOnMarker(matrix, lattice, marker, 1)).toBe(0)
  })

  it('every REAL vendor spot lands inside the placed raster — and under identity almost none does', async () => {
    const hiresMeta = metaOf('spatial-image-hires')
    const extent = hiresMeta.extent as { width: number; height: number }
    const pyramid = await loadOmeTiffPyramid(fileSource(path.join(FIXTURES, 'spatial-image-hires.ome.tif')))
    const matrix = productMatrix(pyramid, hiresMeta)

    // The spot table and the image are two artifacts of one import that never reference each
    // other; that all 160 of 10x's own positions fall inside the placed picture is a property of
    // the PLACEMENT, and it is not true of the un-placed one.
    expect(VENDOR.count).toBe(160)
    expect(VENDOR.coordinate_space).toBe(hiresMeta.coordinate_space)
    const inside = (m: readonly number[]) =>
      VENDOR.spots.filter(s => {
        const [px, py] = inverseThrough(m, s.x, s.y)
        return px >= 0 && px < extent.width && py >= 0 && py < extent.height
      }).length

    expect(inside(matrix)).toBe(160)

    // Pre-#228: the raster at identity. The spots run to x=6911, y=8668 against a 1400x1800 grid,
    // so the overlay would sit almost entirely off the picture — which is a thing a human would
    // see instantly (INV-5) and which no assertion in the tree noticed before this one.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(inside(identity)).toBe(0)
  })

  it('the marker coordinate is re-derived from TWO artifacts, so it rests on no constant', async () => {
    // The hires and lowres images of the same section carry the same physical marker at DIFFERENT
    // pixel addresses (980,540) and (294,162). Each placed by its OWN declared affine, they must
    // agree — and what they agree on is the coordinate the citation names. Two artifacts, two
    // grids, one space: this is what the binding MEANS, and no pixel frame can express it.
    const hires = await loadOmeTiffPyramid(fileSource(path.join(FIXTURES, 'spatial-image-hires.ome.tif')))
    const lowres = await loadOmeTiffPyramid(fileSource(path.join(FIXTURES, 'spatial-image-lowres.ome.tif')))
    const hm = await markerPixel(hires)
    const lm = await markerPixel(lowres)
    expect(Math.abs(hm.x - lm.x)).toBeGreaterThan(600) // the grids genuinely disagree: 686 px

    const hPlaced = through(productMatrix(hires, metaOf('spatial-image-hires')), hm.x, hm.y)
    const lPlaced = through(productMatrix(lowres, metaOf('spatial-image-lowres')), lm.x, lm.y)
    expect(hPlaced[0]).toBeCloseTo(lPlaced[0], 6)
    expect(hPlaced[1]).toBeCloseTo(lPlaced[1], 6)
    expect(hPlaced[0]).toBeCloseTo(MARKER_XY[0], 6)
    expect(hPlaced[1]).toBeCloseTo(MARKER_XY[1], 6)
  })

  // ── #278: WHAT USED TO STAND HERE, WHY IT COULD NOT FAIL, AND WHAT REPLACED IT ────────────
  //
  // The retired assertion was:
  //
  //     const perturbed = productMatrix(pyramid, { ...hiresMeta, microns_per_pixel: <x> })
  //     expect(perturbed).toEqual(base)
  //
  // `productMatrix` is a helper in THIS file and forwards only `meta.to_space` and
  // `meta.coordinate_space` to `omeTiffUnderlayMeta(pyramid, toSpace, space)`. The perturbed
  // field was therefore dropped at that call site, BY THIS FILE, before any shipped code saw
  // it — so the equality held by construction of the harness and NO change to any production
  // file could turn it red. Setting the field to `NaN` and deleting two others left the suite
  // green. That is a check indistinguishable from no check (`docs/design/derived-guards.md`
  // §1), and it was nevertheless CITED as the proof of the property, by #258.
  //
  // It cannot be repaired by passing a different VALUE, because production has nowhere to put
  // one. Per §4 — *"The repair is not to raise the number. It is to assert the relation."* —
  // the relation is asserted from two directions, and neither leg stands alone:
  //
  //   * BEHAVIOURALLY, through a micron scale that DOES reach production.
  //     `loadOmeTiffPyramid(source, { micronsPerPixel })` is a declared parameter of a shipped
  //     entry point, and it lands in `pyramid.physicalSize` and `pyramid.meta.levels[].scale` —
  //     the two quantities `omeTiffModelMatrix`'s own doc-comment names as the composition trap
  //     ("composing `pixelSizeAffine(meta)` over `toSpace` … would multiply the placement by
  //     that pitch and draw a perfectly plausible tissue image at the wrong size in the wrong
  //     place"). The SAME fixture bytes are opened at three different micron scales and the
  //     emitted matrix must not move. The FIRST of the two assertions is the positive control
  //     that the perturbation ARRIVED — without it this would be #278 again in a new costume.
  //   * STRUCTURALLY, over the DECLARED parameter lists of the path's entry points and over the
  //     `ImageMeta` the path carries: the artifact's own micron scale has no slot to enter
  //     through, and a widened signature is what that leg turns red on.
  //
  // Honest limit, stated rather than implied: no production CALLER supplies `micronsPerPixel`
  // today (`workbenchDataSource.ts` and `workstore/index.ts` both call `loadOmeTiffPyramid`
  // with the source alone). The behavioural leg therefore proves "the placement path does not
  // READ the micron scale it is handed", which is the property under test, and not "a live
  // caller's micron scale is ignored". The day a caller supplies one — which is what the option
  // exists for — this is the assertion that catches it.

  /**
   * Strip TypeScript comments, STRING-AWARE, preserving line structure.
   *
   * The two regexes this replaces were the naive tokenizer the shell guard's own header names
   * as a live FAIL-OPEN in a sibling guard: a line-comment marker inside a quoted URL blanks
   * the rest of its own line, and a block-comment opener inside a string literal eats live
   * code until the next closer. Neither is hypothetical here — a declaration whose default
   * value is a URL threw `unbalanced parameter list`, a cry-wolf on ordinary code.
   */
  /**
   * One escaped character, resolved for the sweep, using JavaScript's OWN escape table.
   *
   * Blanking every alphanumeric — which this did — is the blanket rule the shell guard's own
   * header records as a demonstrated fail-open: an escaped letter outside the table is the
   * IDENTITY escape (`"\d" === "d"`), so blanking it deletes a real character. Only a genuine
   * escape sequence is blanked; everything else is the character it denotes. TypeScript is
   * JavaScript here, so there is no keep-the-backslash case.
   */
  const JS_ESCAPES = 'bfnrtv01234567xu'
  const unescapeChar = (ch: string | undefined): string =>
    ch === undefined || JS_ESCAPES.includes(ch) ? ' ' : ch

  function stripTs(src: string): string {
    let out = ''
    let i = 0
    let quote = ''
    let block = false
    while (i < src.length) {
      const c = src[i]
      const d = src.slice(i, i + 2)
      if (block) {
        if (d === '*/') {
          block = false
          i += 2
          out += '  '
          continue
        }
        out += c === '\n' ? '\n' : ' '
        i++
        continue
      }
      if (quote) {
        if (c === '\\') {
          out += unescapeChar(src[i + 1])
          i += 2
          continue
        }
        if (c === quote) quote = ''
        out += c
        i++
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        out += c
        i++
        continue
      }
      // An escape OUTSIDE a string — which in TypeScript means a regex literal. Without this
      // the `//` an escaped slash makes (`/^https:\/\//`) read as a comment marker and
      // truncated the line, so a micron parameter after one was invisible to the sweep. That
      // is the same defect this file's own doc-comment claims to have fixed, in the same file.
      if (c === '\\') {
        out += unescapeChar(src[i + 1])
        i += 2
        continue
      }
      if (d === '/*') {
        block = true
        i += 2
        out += '  '
        continue
      }
      if (d === '//') {
        while (i < src.length && src[i] !== '\n') {
          out += ' '
          i++
        }
        continue
      }
      out += c
      i++
    }
    // An UNTERMINATED block comment means this stripper mis-lexed the file and blanked the
    // rest of it — the sweep below would then pass over nothing and look green. The usual
    // cause is a regex character class holding a slash-star, which is legal TypeScript this
    // stripper cannot parse. Refusing is the only honest answer; guessing is what produced a
    // silent whole-file blanking in the shell guard for the same reason.
    //
    // KNOWN LIMIT, stated rather than discovered later: a phantom open that a LATER genuine
    // `*/` closes blanks only the span between them and is NOT caught here. That direction is
    // fail-open, it is the same residual the shell guard carries, and it is filed as #312
    // rather than papered over.
    if (block) {
      throw new Error(
        'spotOverlayRegistration: stripTs ended inside an unterminated block comment, so the ' +
          'rest of the file was blanked and the micron sweep would have passed over nothing. ' +
          'The usual cause is a regex character class containing a slash-star; escape the ' +
          'slash. This refuses rather than reporting a green sweep over blanked code.',
      )
    }
    return out
  }

  /**
   * One of this package's spatial modules, read as SOURCE, with comments already removed.
   *
   * Resolved from THIS MODULE's own location, not from `process.cwd()`: a source assertion that
   * silently depends on the runner's working directory is one `vitest --root` away from reading
   * a file that does not exist, and the failure would look like a signature change.
   *
   * Comments go FIRST, before any bracket scanning. The first cut scanned raw source and then
   * stripped, so a doc-comment containing an unbalanced `(` threw `unbalanced parameter list`
   * on a perfectly ordinary declaration.
   */
  const sourceOf = (file: string): string => stripTs(readFileSync(path.join(HERE, file), 'utf8'))

  /**
   * The DECLARED parameter list of `export function <name>` in `file`, comments stripped and
   * whitespace collapsed.
   *
   * THROWS when the name resolves to nothing, and that is the ungated control rather than
   * defensive code: a check keyed on a name a rename has invalidated is not "a premise that no
   * longer holds", it is a check switched off, and it looks identical from the outside
   * (`derived-guards.md` §3 — "a marker naming nothing is not a branch whose premise does not
   * hold — it is a guard switched off").
   */
  /**
   * The index of a declaration's opening `(`, or -1.
   *
   * The generic list is walked with a BALANCE counter rather than matched by `<[^>]*>`, which
   * stops at the first `>` and so could not see `function f<T extends Record<string, number>>(`
   * — it reported that as "no such export", i.e. the renamed-entry-point message on a function
   * sitting right there.
   */
  function openParenOf(src: string, name: string): number {
    const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(src)
    if (!m) return -1
    let i = m.index + m[0].length
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] === '<') {
      let d = 0
      for (; i < src.length; i++) {
        if (src[i] === '<') d++
        // …and NOT the `>` of an arrow type inside the generic constraint, which would
        // otherwise close the list early and report the function as missing.
        else if (src[i] === '>' && src[i - 1] !== '=') {
          d--
          if (d === 0) {
            i++
            break
          }
        }
      }
      while (i < src.length && /\s/.test(src[i])) i++
    }
    return src[i] === '(' ? i : -1
  }

  const declaredParams = (file: string, name: string): string[] =>
    paramsFromSource(sourceOf(file), name)

  /**
   * The parameter-list parser, over a SOURCE STRING rather than a file.
   *
   * Split out so it can be driven with declaration shapes the tree does not currently contain.
   * A blind audit reverted three of its four fixes at once — the generic-aware declaration
   * match, the string skip in the closing-paren scan, and the quote/generic tracking in the
   * splitter — and the suite stayed green, because no function in these modules is generic,
   * has a string default, or takes an arrow type. A parser fix with no case that exercises it
   * is a claim, not a repair.
   */
  function paramsFromSource(src: string, name: string): string[] {
    const open = openParenOf(src, name)
    if (open < 0) {
      throw new Error(
        `spotOverlayRegistration: no \`export function ${name}\`. This assertion is ` +
          'keyed on that declaration; a renamed or moved entry point silently switches it off, ' +
          'so it fails loudly instead. Re-point it at the placement path as it now is.',
      )
    }
    // The CLOSING paren is found by counting brackets only — never `<`/`>`, which appear
    // unbalanced in comparisons and arrow types and would close the list early. String
    // literals are skipped, because a default value containing `)` truncated the list.
    let depth = 0
    let close = -1
    let quote = ''
    for (let p = open; p < src.length; p++) {
      const c = src[p]
      if (quote) {
        if (c === '\\') p++
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          close = p
          break
        }
      }
    }
    if (close < 0) throw new Error(`spotOverlayRegistration: unbalanced parameter list for ${name}`)
    const inner = src.slice(open + 1, close)
    // The SPLITTER does track `<`/`>`: a parameter typed `Record<string, number>` carries a
    // top-level-looking comma inside its own generic argument list, and splitting on it
    // produced two bogus parameters.
    const params: string[] = []
    let buf = ''
    let d = 0
    let q = ''
    for (const c of inner) {
      if (q) {
        buf += c
        if (c === q) q = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') q = c
      if (c === '(' || c === '[' || c === '{' || c === '<') d++
      // …but NOT the `>` of an arrow type: `cb: () => void` would otherwise drive the depth
      // negative and swallow every parameter after it.
      else if (c === '>' && buf.endsWith('=')) { /* arrow, not a generic close */ }
      else if (c === ')' || c === ']' || c === '}' || c === '>') d--
      if (c === ',' && d === 0) {
        params.push(buf)
        buf = ''
        continue
      }
      buf += c
    }
    params.push(buf)
    return params.map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0)
  }

  /**
   * THE PLACEMENT MODULES, swept AS CODE rather than as a list of declarations.
   *
   * Two earlier shapes were both wrong, and in the same direction:
   *   1. a frozen five-tuple of entry points — an enumeration of the SET (§2), so a sixth entry
   *      point taking a micron parameter was uncovered;
   *   2. "every `export [async] function` in the two modules" — better, but still a list of one
   *      DECLARATION FORM. A blind audit walked straight past it:
   *      `export const f = (micronsPerPixel: number) => …`, `export default function f(…)` and
   *      `export function* g(…)` were all invisible, so the vacuous-green it was written to
   *      close was still open.
   *
   * So the sweep is over the modules' CODE, comments stripped: no micron-scale token appears
   * anywhere in `coordinateBinding.ts` or `omeTiffUnderlay.ts` outside prose. That covers every
   * declaration form, every parameter, every local, every property read and every call — the
   * property "nothing in the placement path READS a micron scale" is exactly a statement about
   * the code, and this is that statement rather than a proxy for it.
   *
   * These two modules are the placement path: everything they hold exists to place a raster or
   * to bind a layout to one. Two siblings are deliberately OUTSIDE the sweep, and the reasons
   * are different — a blind audit asked, and "the list is short" is not an answer:
   *   * `omeTiffPyramid.ts` — `loadOmeTiffPyramid` legitimately TAKES a micron scale (it is
   *     what the perturbation above rides in on). What matters is that the placement never
   *     READS it, and `omeTiffModelMatrix` is pinned below as a frozen case.
   *   * `imageMeta.ts` — `imageModelMatrix` legitimately COMPOSES `pixelSizeAffine`, because
   *     the NGFF path's model matrix is supposed to carry the pixel size. That is a different
   *     path, and sweeping it would be cry-wolf on correct code.
   * The second one is exactly the composition `omeTiffModelMatrix`'s doc-comment refuses for
   * THIS path — "composing `pixelSizeAffine(meta)` over `toSpace` … would draw a perfectly
   * plausible tissue image at the wrong size in the wrong place" — so the boundary is not left
   * to a comment: the assertion below pins that the placement path REFERENCES neither
   * `pixelSizeAffine` nor `imageModelMatrix`, which is what "these two modules are the whole
   * path" MEANS, checked rather than asserted.
   */
  const PLACEMENT_MODULES: readonly string[] = ['coordinateBinding.ts', 'omeTiffUnderlay.ts']

  /** The NGFF compositions the OME-TIFF placement path must not reach for. Named here because
   *  the boundary of `PLACEMENT_MODULES` is only meaningful if the modules outside it cannot be
   *  called from inside it.
   *
   *  `pixelSizeAffine` is kept for readability but carries no independent weight: it matches
   *  `MICRON_CI`'s `pixel[_ ]?size`, so the per-line sweep above fires on it first and this
   *  assertion can never be the finding. `imageModelMatrix` is the one that adds coverage. */
  const FOREIGN_COMPOSITIONS: readonly string[] = ['pixelSizeAffine', 'imageModelMatrix']

  /** Anti-vacuity, per §2: a floor is the correct companion to a derived set — it detects a
   *  broken derivation instead of standing in for one. A stripper that returned "" would make
   *  the sweep below pass over nothing, which is the failure mode a floor exists for.
   *  MEASURED, with this file's own `stripTs`: 7,982 (`coordinateBinding.ts`) and 8,062
   *  (`omeTiffUnderlay.ts`) non-space code characters. The floor sits at ~3/4 rather than the
   *  usual ~2/3, because these two modules are stable and a 25% collapse is already a
   *  restructure somebody should have to look at. */
  const MIN_PLACEMENT_CODE_CHARS = 6000

  /**
   * …and the frozen CASES over that derived set. §4 asks for both, and says why: a derivation
   * whose two sides read the same source is a tautology in the direction that source changes,
   * so the membership sweep below cannot see a signature that is REWRITTEN rather than added.
   * These five are pinned verbatim, `omeTiffModelMatrix` included because it lives outside the
   * two modules the sweep derives from.
   */
  const PLACEMENT_PINS: readonly (readonly [string, string, readonly string[]])[] = [
    ['omeTiffUnderlay.ts', 'omeTiffUnderlayMeta', ['pyramid: OmeTiffPyramid', 'toSpace?: readonly number[]', 'space?: string']],
    ['omeTiffUnderlay.ts', 'underlayAffine', ['toSpace: readonly number[] | undefined', 'downsample: readonly [number, number]']],
    ['coordinateBinding.ts', 'imagePlacementMatrix', ['toSpace: readonly number[]']],
    ['coordinateBinding.ts', 'levelPlacementMatrix', ['affine: Affine']],
    ['omeTiffPyramid.ts', 'omeTiffModelMatrix', ['toSpace: Affine']],
  ]

  /**
   * What a micron quantity looks like WHEREVER it is spelled.
   *
   * ── THE MISTAKE THIS RECORDS, BECAUSE IT WAS MINE ─────────────────────────────────────
   * A previous round DELETED `resolution` from this set to make its own new whole-line sweep
   * pass, because `resolution` matched "its resolution pyramid" in a live refusal message.
   * That is `derived-guards.md` §5's "lowering a floor to fit", exactly, and it silently cost
   * real coverage: `(^|[^a-z])um` under `/i` cannot match a camelCase `…Um`, so
   * `originalResolutionUm` and `resolutionUm` — the spelling `wire.ts` actually uses, since it
   * camelCases every wire field — stopped matching too.
   *
   * The §5 repair is to fix the DERIVATION. Two changes, both measured:
   *   * `resolution` is back, as `resolution[_ ]?um` — the QUANTITY, not the English word, so
   *     the refusal-message prose is not a hit and nothing real is missed;
   *   * a case-SENSITIVE arm catches the camelCase and SHOUTED spellings the old set never
   *     saw (`originalResolutionUm`, `umPerPixel`, `VISIUM_CAPTURE_SPOT_DIAMETER_UM`).
   * The bare `per[_ ]?pixel` arm is dropped as redundant: every per-pixel micron quantity in
   * the tree already matches `micron`, while `per pixel` alone matched "samples per pixel" in
   * two live refusal messages.
   *
   * MEASURED on both placement modules: zero hits. MEASURED against every micron spelling in
   * the tree — `micronsPerPixel`, `microns_per_pixel`, `physicalSize`, `PhysicalSizeX`,
   * `pixelSizeAffine`, `original_resolution_um`, `originalResolutionUm`, `resolutionUm`,
   * `umPerPixel`, `VISIUM_*_SPOT_DIAMETER_UM` — all matched.
   *
   * NOT strictly broader, and the earlier draft of this comment said it was. Dropping the bare
   * `per[_]?pixel` arm also drops `bytesPerPixel`, `samplesPerPixel` and `bytes_per_pixel` —
   * which are not micron quantities and were the arm's only real hits, so the narrowing is
   * intended. It is stated because "strictly broader" inside a paragraph about not narrowing a
   * floor is exactly the sentence a later reader would trust without re-measuring.
   */
  const MICRON_CI = /micron|physical|pixel[_ ]?size|resolution[_ ]?um/i
  const MICRON_CS = /(^|[^A-Za-z])[uU][mM]([^A-Za-z]|[A-Z]|$)|[a-z]Um([^A-Za-z]|$)/
  const isMicron = (text: string): boolean => MICRON_CI.test(text) || MICRON_CS.test(text)

  // #278 TEST-1 + TEST-2. The two ids ride ONE spec on purpose: TEST-2 is TEST-1s in-band
  // POSITIVE CONTROL, and a control in a separate spec can be deleted without the claim it
  // vouches for noticing — which is how #278 happened in the first place.
  it('TEST-1 + TEST-2 [acceptance] [invariant: INV-2] the placement is INVARIANT under a micron scale that demonstrably reached production', async () => {
    const hiresMeta = metaOf('spatial-image-hires')
    const source = () => fileSource(path.join(FIXTURES, 'spatial-image-hires.ome.tif'))
    const declared = hiresMeta.microns_per_pixel as number

    // Three opens of the SAME bytes, differing ONLY in the micron scale handed to the shipped
    // loader: absent, the artifact's own, and a wildly wrong one. No new numeric literal is
    // written here — the perturbation is derived from the fixture's own value — so this block
    // states no producer magnitude of its own.
    const bare = await loadOmeTiffPyramid(source())
    const stated = await loadOmeTiffPyramid(source(), { micronsPerPixel: declared })
    const wrong = await loadOmeTiffPyramid(source(), { micronsPerPixel: declared * 3 })

    // ── (1) POSITIVE CONTROL: the perturbation ARRIVED ──────────────────────────────────────
    // This is the assertion #278's mechanism did not have, and its absence is the whole defect:
    // an invariance claim over an input nothing reads is vacuous no matter how large the
    // perturbation. Both fields below are on the object the placement path is handed.
    expect(bare.physicalSize).toBeUndefined()
    expect(stated.physicalSize?.x).toBe(declared)
    expect(wrong.physicalSize?.x).toBe(declared * 3)
    // The WHOLE level table, not element 0 of it. `levels` is a declared collection and
    // `lint-positional-declaration` refuses `levels[0]` for the reason that guard exists: the
    // order is the contributor's, and nothing in the contract promises position 0 means
    // anything. Comparing the whole table is also strictly stronger — a perturbation that
    // moved any level would be caught, not only one that moved the first.
    const scalesOf = (p: OmeTiffPyramid): readonly (readonly [number, number])[] =>
      p.meta.levels.map(l => l.scale)
    expect(scalesOf(stated)).not.toEqual(scalesOf(bare))
    expect(scalesOf(wrong)).not.toEqual(scalesOf(stated))
    expect(scalesOf(wrong)).toHaveLength(scalesOf(stated).length)
    for (let i = 0; i < stated.meta.levels.length; i++) {
      const [sx, sy] = stated.meta.levels[i].scale
      const [wx, wy] = wrong.meta.levels[i].scale
      expect(wx).toBeCloseTo(sx * 3, 9)
      expect(wy).toBeCloseTo(sy * 3, 9)
    }

    // ── (2) THE RELATION: and it moves NO number in the placement ───────────────────────────
    // Bit-identical, not approximately equal. Any code that folds `physicalSize` or
    // `levels[].scale` into the placement — the composition `omeTiffModelMatrix` refuses by name
    // — separates these three immediately, which is exactly what the retired perturbation could
    // not do: it drove all its cases off ONE pyramid, so a folded pitch moved every case alike
    // and the equality still held.
    const mBare = productMatrix(bare, hiresMeta)
    const mStated = productMatrix(stated, hiresMeta)
    const mWrong = productMatrix(wrong, hiresMeta)
    expect(mStated).toEqual(mBare)
    expect(mWrong).toEqual(mBare)

    // …and the same at the level the single-texture fallback is placed by, which is a DIFFERENT
    // matrix built from a different affine and could drift on its own.
    const uBare = omeTiffUnderlayMeta(bare, hiresMeta.to_space as number[], hiresMeta.coordinate_space as string)
    const uWrong = omeTiffUnderlayMeta(wrong, hiresMeta.to_space as number[], hiresMeta.coordinate_space as string)
    expect(uWrong.affine).toEqual(uBare.affine)

    // …and the placed MARKER coordinate, so the claim is about where the picture lands and not
    // only about sixteen numbers being equal to each other.
    const marker = await markerPixel(wrong)
    expect(through(mWrong, marker.x, marker.y)).toEqual(through(mBare, marker.x, marker.y))
  })

  // #278 TEST-3.
  // #278 TEST-19 — the STRIPPER and the vocabulary own controls, driven DIRECTLY.
  //
  // A blind audit reverted six hunks of `stripTs`/`openParenOf`/`isMicron` one at a time and
  // the suite stayed 7/7 green every time: they were exercised only through the four real
  // source files, none of which happens to contain the shapes they exist for. A mechanism
  // whose only test is "the real tree still passes" is untested for every input the real tree
  // does not currently hold — which is the whole subject of this branch.
  it('TEST-19 the stripper and the micron vocabulary, driven directly', () => {
    // ── escapes, both directions, both inside and outside a string ────────────────────────
    // A WORD character after a backslash is an escape SEQUENCE: blanked, so it cannot glue
    // onto the token before it and kill its boundary.
    expect(stripTs('const s = "abc\\ndef"')).toContain('abc ')
    expect(stripTs('const s = "abc\\ndef"')).not.toContain('abcn')
    // …and a NON-word character IS the character: kept, so an escaped separator cannot hide a
    // compound token.
    expect(stripTs('const s = "da\\/result"')).toContain('da/result')

    // ── an escape OUTSIDE a string, i.e. a regex literal ──────────────────────────────────
    // Without this branch the `//` an escaped slash makes reads as a comment marker and
    // truncates the line, so everything after it is invisible to the sweep.
    const rx = stripTs('const m = /^https:\\/\\//.test(u); const micronsPerPixel = 1')
    expect(rx).toContain('micronsPerPixel')

    // ── a block comment is stripped; an UNTERMINATED one is refused rather than blanking ──
    expect(stripTs('/* micronsPerPixel */ const a = 1')).not.toContain('micronsPerPixel')
    expect(() => stripTs('const CLS = /[/*]/\nconst micronsPerPixel = 1')).toThrow(
      /unterminated block comment/,
    )

    // ── a line comment inside a STRING is not a comment ───────────────────────────────────
    expect(stripTs(`const u = 'https://x/y'; const micronsPerPixel = 1`)).toContain('micronsPerPixel')

    // ── the generic scan must not close on an arrow type inside a constraint ──────────────
    const arrowGeneric = 'export function ag<T extends (a: number) => void>(micronsPerPixel: T) {}'
    expect(paramsFromSource(arrowGeneric, 'ag')).toEqual(['micronsPerPixel: T'])

    // ── the vocabulary's two arms, each with a case only IT matches ───────────────────────
    // The case-SENSITIVE arm is the one a previous round removed by accident; without it the
    // camelCase spelling `wire.ts` actually uses is invisible.
    // `scaleUm` is matched ONLY by MICRON_CS's second alternation (`[a-z]Um`) — the first needs
    // a non-letter before `um`, and MICRON_CI's `resolution[_ ]?um` does not apply. Without a
    // case like it that arm was dead: deleting it left the suite green.
    for (const spelled of ['originalResolutionUm', 'resolutionUm', 'umPerPixel', 'SPOT_DIAMETER_UM', 'scaleUm']) {
      expect({ spelled, micron: isMicron(spelled) }).toEqual({ spelled, micron: true })
    }
    // …the case-INSENSITIVE arm.
    for (const spelled of ['micronsPerPixel', 'microns_per_pixel', 'physicalSize', 'PhysicalSizeX', 'pixelSizeAffine', 'original_resolution_um']) {
      expect({ spelled, micron: isMicron(spelled) }).toEqual({ spelled, micron: true })
    }
    // …and the prose that must NOT fire, which is why `resolution` is matched as a quantity
    // (`resolution_um`) and not as an English word.
    // `samplesPerPixel`/`bytesPerPixel`/`bytes_per_pixel` are spelled the way the DROPPED
    // `per[_]?pixel` arm matched them; with only the space-spelled form these pinned nothing.
    for (const prose of ['its resolution pyramid', 'samplesPerPixel', 'bytesPerPixel', 'bytes_per_pixel', 'the resolution of the pyramid', 'volume', 'album', 'summary']) {
      expect({ prose, micron: isMicron(prose) }).toEqual({ prose, micron: false })
    }
  })

  // #278 TEST-15 — the PARSER own controls. Driven with declaration shapes the two placement
  // modules do not currently contain, so each fix is exercised by a case rather than asserted
  // in a comment. Every one of these was a demonstrated mis-parse before the fix.
  it('TEST-15 the signature parser reads the shapes the tree does not currently contain', () => {
    const src = [
      "export function plain(a: number, b: string) {}",
      "export async function asy(toSpace: readonly number[]) {}",
      "export function gen<T extends Record<string, number>>(x: T, y: number) {}",
      "export function urlish(u: string = 'https://x/y)z', micronsPerPixel = 1) {}",
      "export function arrow(cb: () => void, micronsPerPixel: number) {}",
      "export function recordy(m: Record<string, number>, n: boolean) {}",
    ].join('\n')

    expect(paramsFromSource(src, 'plain')).toEqual(['a: number', 'b: string'])
    // `async` — the only one of these the pre-fix parser handled.
    expect(paramsFromSource(src, 'asy')).toEqual(['toSpace: readonly number[]'])
    // A NESTED generic: matched by `<[^>]*>` the list stopped at the first `>` and the parser
    // reported "no such export" — the renamed-entry-point message on a function sitting there.
    expect(paramsFromSource(src, 'gen')).toEqual(['x: T', 'y: number'])
    // A string default containing `)`: the closing-paren scan used to stop inside the string
    // and silently drop every parameter after it — including a micron one.
    expect(paramsFromSource(src, 'urlish')).toEqual([
      "u: string = 'https://x/y)z'",
      'micronsPerPixel = 1',
    ])
    // An arrow type: `>` used to decrement the splitter's depth below zero and swallow the rest.
    expect(paramsFromSource(src, 'arrow')).toEqual(['cb: () => void', 'micronsPerPixel: number'])
    // A generic ARGUMENT list carries a top-level-looking comma of its own.
    expect(paramsFromSource(src, 'recordy')).toEqual(['m: Record<string, number>', 'n: boolean'])

    // …and the ungated control: a name that resolves to nothing THROWS rather than returning
    // an empty list, because a check keyed on a name a rename invalidated is a check switched
    // off (`derived-guards.md` §3).
    expect(() => paramsFromSource(src, 'notThere')).toThrow(/no .export function notThere/)

    // The micron sweep must SEE the parameters these shapes carry — that is the whole reason
    // the parser has to be right. Two of the six above hide a micron parameter behind exactly
    // the mis-parses listed, and both are visible now.
    for (const name of ['urlish', 'arrow']) {
      expect({ name, hit: paramsFromSource(src, name).some(p => isMicron(p)) }).toEqual(
        { name, hit: true },
      )
    }
  })

  it('TEST-3 the placement path DECLARES no micron parameter, and carries no micron field', async () => {
    // The complementary mutation shape: not "read the scale off an input you already have", but
    // "widen the signature and start taking one". The behavioural leg above cannot see that;
    // this one goes red the moment a parameter list changes at all.
    // (1) THE DERIVED SWEEP, over the modules' CODE. This is the leg that can fail on a
    // declaration form, a local variable or a property read that no list mentions.
    for (const file of PLACEMENT_MODULES) {
      const code = sourceOf(file)
      expect({ file, chars: code.replace(/\s/g, '').length > MIN_PLACEMENT_CODE_CHARS }).toEqual({
        file,
        chars: true,
      })
      code.split('\n').forEach((line, i) => {
        expect({ at: `${file}:${i + 1}`, micron: isMicron(line) }).toEqual({
          at: `${file}:${i + 1}`,
          micron: false,
        })
      })
      // …and the boundary of the swept set is itself checked: the placement path may not
      // reach for the NGFF pixel-size composition that lives one module over. Without this,
      // "these two files ARE the path" is a claim about a hand-drawn list.
      for (const fn of FOREIGN_COMPOSITIONS) {
        expect({ file, fn, referenced: code.includes(fn) }).toEqual({ file, fn, referenced: false })
      }
    }

    // The control that keeps the line above from being vacuous: those functions DO exist, and
    // they ARE composed — one module over, on the NGFF path, which is why the boundary is
    // drawn where it is rather than around everything.
    const ngff = sourceOf('imageMeta.ts')
    for (const fn of FOREIGN_COMPOSITIONS) {
      expect({ fn, definedInNgff: ngff.includes(`export function ${fn}`) }).toEqual({
        fn,
        definedInNgff: true,
      })
    }

    // (2) THE FROZEN CASES. Deliberately AFTER the sweep, and this ordering is the finding a
    // blind audit had to make: with the frozen `toEqual` first, the vocabulary check that
    // followed it could never fail — if the pin passed, the parameters WERE the pinned
    // literals, none of which matches. It was green for a reason unrelated to its own comment,
    // which is the exact class this branch exists to remove.
    for (const [file, name, expected] of PLACEMENT_PINS) {
      expect({ name, params: declaredParams(file, name) }).toEqual({ name, params: [...expected] })
    }

    // …and the DATA the path carries between those entry points. `resolvePaneFrame` and
    // `buildImagePaneLayers` see the artifact only through this object, so a key that is not on
    // it is a route that does not exist: the artifact's declared `microns_per_pixel` cannot
    // reach the matrix even if a future consumer wanted it to.
    const hiresMeta = metaOf('spatial-image-hires')
    const pyramid = await loadOmeTiffPyramid(fileSource(path.join(FIXTURES, 'spatial-image-hires.ome.tif')))
    const carried = omeTiffUnderlayMeta(
      pyramid,
      hiresMeta.to_space as number[],
      hiresMeta.coordinate_space as string,
    )
    // Two legs again, and the first is the one that can fail on a field nobody listed: the
    // DECLARED shape of `ImageMeta` in `data/wire.ts` — the type every consumer on this path
    // sees — must name no micron quantity. Adding `micronsPerPixel?: number` to that interface
    // reddens this without any edit here.
    const wire = stripTs(readFileSync(path.join(HERE, '..', 'data', 'wire.ts'), 'utf8'))
    const at = wire.search(/export interface ImageMeta\s*\{/)
    if (at < 0) {
      throw new Error(
        'spotOverlayRegistration: no `export interface ImageMeta` in data/wire.ts. This ' +
          'assertion is keyed on that declaration; a renamed or moved interface switches it ' +
          'off silently, so it fails loudly instead.',
      )
    }
    // Brace-MATCHED, not "up to the first column-0 `}`": a member with an inline object type
    // truncated the block there and hid every field after it.
    const brace = wire.indexOf('{', at)
    let depth = 0
    let end = -1
    let q = ''
    // String literals are SKIPPED, for the same reason the parameter scanner skips them: a
    // `{` or `}` inside a string-literal member type would unbalance the block and silently
    // truncate the field list. `stripTs` preserves string CONTENTS by design.
    for (let i = brace; i < wire.length; i++) {
      const ch = wire[i]
      if (q) {
        if (ch === '\\') i++
        else if (ch === q) q = ''
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        q = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end).toBeGreaterThan(brace)
    // `readonly` is OPTIONAL in the match. Requiring it meant a plain `micronsPerPixel?: number`
    // — ordinary TypeScript, and the likelier way someone adds a field in a hurry — was not
    // seen at all, while the `readonly` spelling reddened. A sweep that depends on a modifier
    // is not a sweep.
    const declaredFields = [
      ...wire.slice(at, end).matchAll(/^\s*(?:readonly\s+)?([A-Za-z0-9_$]+)\??:/gm),
    ].map(m => m[1])
    expect(declaredFields.length).toBeGreaterThanOrEqual(4)
    for (const f of declaredFields) {
      expect({ field: f, micron: isMicron(f) }).toEqual({ field: f, micron: false })
    }

    // …and the object the path actually carries holds nothing the interface does not declare,
    // so the sweep above is a statement about the real route and not only about a type.
    expect(Object.keys(carried).sort()).toEqual(['affine', 'channels', 'height', 'space', 'toSpace', 'width'])
    for (const k of Object.keys(carried)) expect(declaredFields).toContain(k)
  })

  it('the fixture really declares the number the retired perturbation named', () => {
    // #258 TEST-4. #222 is SETTLED, not a report: the Visium micron scale's numerator is the
    // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
    // RENDERED spot diameter (65 µm), the circle `spot_diameter_fullres` measures, not the 55 µm
    // capture footprint — so every scale DERIVED from `spot_diameter_fullres` moved by
    // 65/55 = +18.18%. A vendor-STATED `microns_per_pixel`, which `micron_scale()` takes
    // verbatim when the bundle carries one, did not move.

    // (The 15.6% the issue headlines is a THIRD number, deliberately outside the claim block
    // above: the OLD derived scale's error against the slide's 100 µm pitch on the committed
    // bundle — bundle-specific, not a quantity this producer exports. It was the factor the
    // retired perturbation reused, and #278 is the record that reusing it proved nothing.)

    // Both the image placement and the spot coordinates are stated in FULL-RESOLUTION PIXELS and
    // neither is derived from `microns_per_pixel`, so the binding rides the affine and inherits
    // none of that error. The two assertions above are what put THAT under guard; this one is
    // the HONEST half of the retired test, kept and retitled so it no longer stands next to a
    // claim it never supported. It shows the key exists in the fixture and nothing more.
    //
    // The value is the FROZEN PRE-#222 one and is CORRECT to assert: the fixture is a committed
    // artifact emitted before #222, and #222's ruling is fix-forward-only — already-emitted
    // artifacts keep their values.
    // [producer-magnitude: microns_per_pixel]
    // It is not a claim about what the importer derives today (0.8829802566973034).
    // [frozen-magnitude: microns_per_pixel]
    expect(metaOf('spatial-image-hires').microns_per_pixel).toBeCloseTo(0.7471371402823337, 12)
  })
})

