// coordinateBinding.ts — the image↔coordinates binding (#228).
//
// #155 put a `to_space` affine in the emitted OME-XML, #176 settled its convention as CORNER by
// proof, #158 wrote `omeTiffModelMatrix` to turn it into a deck `modelMatrix`, and #159 made an
// image render from a real artifact. Every piece existed except the one that says the image and
// the coordinates are THE SAME PICTURE. This module is that piece.
//
// ── WHAT IT DECIDES, AND WHY THE OTHER ANSWER IS WRONG ───────────────────────────────────────
//
// A pane can have ONE frame. Today the raster pane's camera is in the image's own PIXELS and the
// coordinates are in the artifact's declared COORDINATE SPACE (full-resolution pixels for a
// Visium import, micrometres for Xenium). One of the two has to move, and this module moves the
// IMAGE — the camera lives in the coordinate space and the raster is placed into it.
//
// The reasons are read off the tree rather than reasoned (DEC-1):
//
//  1. A pixel frame belongs to ONE artifact; the binding does not. The design's §4 refuses
//     binding "by artifact adjacency in the same run" precisely because a second image
//     registered later to the same tissue shares the coordinate SPACE and nothing else. Two
//     images cannot both be right in "the" pixel frame — and this module's own test proves the
//     point with the two committed images of one space, whose markers are 686 pixels apart and
//     land on the SAME space coordinate.
//  2. "The image's pixel frame" is not even stable within one artifact. `imageUnderlay()` serves
//     the COARSEST level and `imagePixelSource()` serves the pyramid, so the pane's units would
//     change by the pyramid depth — 4x on the committed fixture — depending on which resolved
//     first.
//  3. `to_space` is DECLARED in the direction pixels -> space. A pixel-framed pane has to invert
//     it on the overlay path, and #159's DEC-6 already records what a wrong inversion looks like:
//     it "silently scales every overlay by the square of the scalefactor" and throws nothing.
//  4. Moving the POINTS is `transformPositions`, an O(2N) CPU pass per image — the pass DEC-26
//     retired from the hot path in favour of exactly the GPU model matrix used here. Moving the
//     image is one 4x4.
//  5. Everything downstream is denominated in the space: a micron scale bar, a neighbourhood
//     radius, `require_micron_scale(space, consumer=…)`. Pixels are a fact about a file.
//
// ── THE ONE TRAP, INHERITED AND NOT RELITIGATED ──────────────────────────────────────────────
// `to_space` is used ALONE. The OME `PhysicalSizeX` is a DIFFERENT number (the emitted image's
// own micron pitch) and the space has a third (`microns_per_pixel`). `to_space[0]` is exactly the
// ratio of the other two — so composing a pixel size over the placement multiplies it by that
// pitch and draws a perfectly plausible tissue image at the wrong size in the wrong place. #158
// measured that on the emit of the day; `omeTiffModelMatrix` refuses to compose it; this module
// does not compose it either, and a test names the wrong number by value so it cannot come back
// silently.
//
// ── THE MAGNITUDES, AND WHY THEY ARE NOT THE POINT ───────────────────────────────────────────
// Every magnitude in this block is CHECKED, not just written down: the tags below bind it to
// `scripts/check-viz-producer-magnitudes.mjs`, which derives the `producer-` values by running
// the importer and reads the `frozen-` values out of the committed fixture's bytes. #222 moved
// these numbers once and #258 repaired them by hand; a third such drift now reddens a gate.
// [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um] [producer-magnitude: spot_diameter_fullres] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
// For the committed Visium vendor bundle the shipped importer DERIVES 5.0, 4.4149 and 0.88298
// today, so the composed placement would be 4.41x too large. That is a derivation, not a
// measurement, and it is stated here only so the example is checkable:
//   `65.0 / 73.61433 = 0.8829802566973034` µm/px — `VISIUM_RENDERED_SPOT_DIAMETER_UM` in
//   `spatial-import-visium/compute/import_visium.py` over that package's committed
//   `scalefactors_json.json` — then `/ 0.2` (`tissue_hires_scalef`) for the emitted image's own
//   pitch, `4.4149012834865164`.
// [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]
// #158 measured 3.7357 and 0.7471 (ratio 3.74) because that is what the importer emitted BEFORE
// #222 moved the numerator, and it is still what every artifact emitted before then declares —
// including this package's committed fixtures. Both pairs are correct about their own era, and
// neither is a constant: they move with `spot_diameter_fullres`, i.e. with the slide.
//
// The RATIO is what this paragraph is actually about, and it is not a measurement at all:
// `to_space[0]` is `1/tissue_hires_scalef` and `PhysicalSizeX` is
// `microns_per_pixel / tissue_hires_scalef`, so the first is the ratio of the other two BY
// CONSTRUCTION, whatever the micron scale happens to be.
//
// ── AND THE ONE IT IS AGNOSTIC TO ────────────────────────────────────────────────────────────
// Nothing here reads `microns_per_pixel`, a spot diameter, or any micron quantity. #222 is
// [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
// SETTLED, not open: the numerator is the RENDERED spot diameter (65 µm), the circle
// `spot_diameter_fullres` actually measures, and not the 55 µm capture footprint. That moved
// every scale DERIVED from `spot_diameter_fullres` by 65/55 = +18.18% (equivalently, every prior
// such result was 15.4% low). It did NOT move a vendor-STATED `microns_per_pixel`, which
// `micron_scale()` still takes verbatim when the bundle carries one.

// (The 15.6% the issue headlines is a THIRD number and is deliberately outside the claim block
// above: it is the OLD derived scale's error against the slide's 100 µm pitch on the committed
// bundle — bundle-specific, not a quantity this producer exports, and so not something any
// gate here can re-derive.) A placement derived from that scale would have inherited the error
// uniformly and invisibly.
//
// Riding the declared affine alone means #222 changed NO number this module produces: the image
// placement and the spot coordinates are both stated in the same full-resolution frame, and
// neither is derived from the micron scale. The checkable form of that is the SIGNATURES on this
// path — `imagePlacementMatrix(toSpace)`, `omeTiffModelMatrix(toSpace)`,
// `omeTiffUnderlayMeta(pyramid, toSpace, space)` — none of which accepts a micron quantity, so
// there is nothing for a wrong scale to enter through. (`spotOverlayRegistration.test.ts`'s
// perturbation test READS as the proof of this and is not one — its helper drops the perturbed
// field before any of those functions is called. Filed as #278; do not cite it as evidence.)
//
// ── TWO WEAKNESSES THIS INHERITS, NAMED HERE BECAUSE THE DESIGN ASKED THE IMPLEMENTER TO ────
// §12.2: *"The affine is producer-declared and unverifiable. No gate can check a registration.
// The compensating control is the rendered overlay (§7.5) — a human check, not a mechanical one.
// This is a genuine weakening relative to every other artifact in the system, and it should be
// named in the item that implements it rather than discovered later."* This is that item. What
// is proven here is that the declared affine is APPLIED correctly — right direction, right scale,
// no composed pixel size, both render paths agreeing, checked against a real artifact's own
// decoded pixels. Nothing here can prove the declared affine is the RIGHT REGISTRATION.
//
// §12.3: *"`coordinate_space` is a string, and two artifacts agreeing on it is a convention.
// Unlike `aligned_to` (a digest of actual bytes), nothing recomputes it."* The binding below
// rests on exactly that convention. Two artifacts that agree by accident bind; two that describe
// one slide under two spellings do not. The mitigation is producer discipline (derive the id from
// the vendor's own slide/library id), and it is not an invariant.
//
// Framework-agnostic (viz-core): pure arithmetic over declared numbers. No React, no deck.gl
// context, no backend/storage import. DEC-28 generic naming — image / space / placement, nothing
// biological.

import { affineToModelMatrix } from '../data/affineMatrix'
import { invertAffine, type Affine } from '../data/image'
import { omeTiffModelMatrix } from './omeTiffPyramid'
import { OmeTiffPlacementError } from './omeTiffUnderlay'

/**
 * What one artifact declares about where it sits: the coordinate space it names, and (for a
 * raster) the affine into it.
 *
 * BOTH are optional and they are optional SEPARATELY, because the two absences mean different
 * things and the product does different things about them. An artifact declaring no `space` is
 * not in any shared frame and may not be overlaid on anything; a raster declaring a space but no
 * `toSpace` names a frame it cannot place itself in, which is a producer that stopped halfway.
 */
export interface DeclaredPlacement {
  /** the `coordinate_space` id from the artifact's `meta`; absent ⇒ it declares no frame. */
  readonly space?: string
  /** 2x3 row-major `[a,b,tx,c,d,ty]` mapping this raster's FULL-RESOLUTION pixels into `space`. */
  readonly toSpace?: readonly number[]
}

/** A rectangle in the coordinate space. */
export interface SpaceExtent {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
 * Whether a layout's points may be drawn over a raster — and, when they may not, WHY.
 *
 * A verdict rather than a boolean because the refusal has to be legible. A silent empty overlay
 * is indistinguishable from a product defect, and this repo has already chased one of those
 * (#154's "broken" colour-by, which was a locator matching nothing).
 */
export type OverlayBinding =
  | { readonly bound: true; readonly space: string }
  | { readonly bound: false; readonly reason: string }

/**
 * THE BINDING. Two artifacts share a frame IFF they declare the SAME `coordinate_space` id.
 *
 * Nothing else is consulted — not the run that produced them, not their dataset, not their order
 * in the catalog. That is the design's §4 binding (2), and its refusal of the alternative is
 * explicit: *"Anti-pattern to refuse explicitly: binding image to coords by artifact adjacency in
 * the same run. A user who later registers an H&E image to a Xenium run creates a second image
 * artifact in a different run that shares the coordinate space. Only binding (2) survives that."*
 *
 * An UNDECLARED space on either side is a refusal, never a match: two artifacts that both say
 * nothing have not agreed on anything, and treating `undefined === undefined` as agreement is how
 * an ordinary UMAP embedding would end up painted onto a tissue section.
 */
export function resolveOverlayBinding(input: {
  readonly imageSpace: string | undefined
  readonly layoutSpace: string | undefined
  /**
   * does the raster declare a `to_space` — i.e. can it actually PLACE itself in `imageSpace`?
   *
   * ── WHY THIS IS A THIRD INPUT AND NOT AN IMPLIED ONE ──────────────────────────────────────
   * A raster may declare a space and no placement, and the combination is not hypothetical: the
   * server's summary projection caps ARRAYS at four items, so a six-element `to_space` read off a
   * compacted row arrives MISSING while the `coordinate_space` STRING beside it survives intact.
   * A consumer that bound on the ids alone would then draw the points in the coordinate space
   * over a raster sitting at array-index units — a plausible wrong overlay, produced by a
   * declaration that was only half there. Found by TEST-12 before it could ship.
   */
  readonly imagePlaced: boolean
  /**
   * does the LAYOUT declare a `to_space` — i.e. does it state where in `layoutSpace` its numbers
   * sit? §6.6 requires it of every coordinate-bearing artifact and §5's axiom puts Points in that
   * set. Both shipped importers write identity, so this is satisfied in practice today — but
   * BINDING WITHOUT IT would mean drawing a non-identity-placed coordinate set unregistered, with
   * no error, on the strength of a habit rather than a declaration.
   */
  readonly layoutPlaced: boolean
  /**
   * is that layout placement the IDENTITY — i.e. are the positions stated directly IN the space?
   *
   * ── WHY A NON-IDENTITY PLACEMENT IS REFUSED RATHER THAN RENDERED (DEC-17) ─────────────────
   * Because this renderer cannot move points CONSISTENTLY, and a first attempt to make it proved
   * that empirically rather than in the abstract. Placing them with a deck `modelMatrix` moves
   * the marks on the GPU and leaves every CPU-side consumer of the raw position buffer exactly
   * where it was. Three successive blind audit rounds enumerated those consumers, and each round
   * found one the previous had missed: the lasso/rect mask, the hover-highlight ring, the
   * selection PROVENANCE replay, the cross-pane tooltip, the vector export. Each is a separate
   * module that reads `positions` and projects it itself, and "fix the next one" is a game with
   * no visible end — the shape this repo calls two consecutive fix rounds landing in the same
   * place.
   *
   * So the RASTER moves and the points never do, which is the design decision this whole module
   * rests on (see the header), applied consistently instead of almost-consistently. A layout that
   * needs moving is REFUSED, with its reason, which is the same stance taken everywhere else here:
   * a visible refusal beats a plausible wrong answer.
   *
   * The practical cost today is ZERO — both shipped importers state their coordinates directly in
   * the space (`to_space: [1,0,0,0,1,0]`) — and it is a real, stated narrowing tomorrow. The
   * declaration is still READ and still REQUIRED (`layoutPlaced`), so this refuses only what it
   * genuinely cannot draw, and it will say so out loud when it does.
   */
  readonly layoutIsIdentity: boolean
}): OverlayBinding {
  const { imageSpace, layoutSpace, imagePlaced, layoutPlaced, layoutIsIdentity } = input
  if (!imageSpace && !layoutSpace) {
    return {
      bound: false,
      reason:
        'neither the raster nor the layout declares a coordinate_space, so there is no frame to ' +
        'share. Two artifacts that both say nothing have not agreed on anything.',
    }
  }
  if (!imageSpace) {
    return {
      bound: false,
      reason:
        `the layout declares coordinate_space "${layoutSpace}" and the raster declares none, so ` +
        'nothing states where the raster sits in it.',
    }
  }
  if (!layoutSpace) {
    return {
      bound: false,
      reason:
        `the raster declares coordinate_space "${imageSpace}" and the layout declares none. An ` +
        'un-placed set of positions is not in that space just because it is the only one here.',
    }
  }
  if (imageSpace !== layoutSpace) {
    return {
      bound: false,
      reason:
        `the raster is in coordinate_space "${imageSpace}" and the layout is in "${layoutSpace}". ` +
        'Different spaces are different frames; adjacency in a project or a run does not place ' +
        'one in the other.',
    }
  }
  if (!imagePlaced) {
    return {
      bound: false,
      reason:
        `the raster names coordinate_space "${imageSpace}" but declares no to_space, so nothing ` +
        'states WHERE in that space it sits. It renders at array-index units; drawing points ' +
        'stated in the space over it would be an overlay assembled from half a declaration.',
    }
  }
  if (!layoutPlaced) {
    return {
      bound: false,
      reason:
        `the layout names coordinate_space "${layoutSpace}" but declares no to_space, so nothing ` +
        'states WHERE in that space its positions sit. Drawing them unplaced would assume an ' +
        'identity placement the producer never stated.',
    }
  }
  if (!layoutIsIdentity) {
    return {
      bound: false,
      reason:
        'the layout declares a NON-IDENTITY to_space, and this renderer cannot draw points that ' +
        'need moving. The raster is moved instead — see the module header for why the reverse is ' +
        'refused rather than approximated.',
    }
  }
  return { bound: true, space: imageSpace }
}

/**
 * A producer-declared 2x3 affine, validated.
 *
 * Six FINITE elements, and the reason six specifically is not tidiness: `compact_declaration`
 * (the server's summary-row projection) drops every array longer than four, so a `to_space` read
 * off a summary row instead of the full `Artifact.meta` arrives MISSING rather than short. Both
 * routes land here, and both are refused rather than silently replaced with identity — an
 * identity substitution renders the raster at array-index units with nothing anywhere saying so.
 *
 * Shares `OmeTiffPlacementError` with `omeTiffUnderlay` on purpose: it is the SAME producer bug,
 * and a caller that has to catch two classes for one fault will eventually catch one of them.
 */
export function asPlacementAffine(toSpace: readonly number[]): Affine {
  if (toSpace.length !== 6 || !toSpace.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new OmeTiffPlacementError(
      `coordinateBinding: the artifact declares a placement of ${toSpace.length} value(s) ` +
        `(${JSON.stringify(toSpace)}) — a 2x3 row-major affine [a,b,tx,c,d,ty] has exactly 6 ` +
        'finite numbers. Reading it off a compacted summary row rather than the full artifact ' +
        'metadata produces exactly this.',
    )
  }
  const a: Affine = [toSpace[0], toSpace[1], toSpace[2], toSpace[3], toSpace[4], toSpace[5]]
  // ── SIX FINITE NUMBERS IS NOT ENOUGH: THE 2x2 MUST BE INVERTIBLE ───────────────────────────
  // A rank-deficient placement — `[0,0,0,0,0,0]`, or `[5,0,0,0,0,0]` from a producer that dropped
  // one term — is six finite numbers and passes every check above. It then collapses the raster
  // onto a line, gives `imageExtentInSpace` a zero-area box, and seeds a camera at a zoom derived
  // from nothing. That is a plausible-looking refusal-free wrongness, which is the exact class
  // this module exists to close. The test is the SCALE-INVARIANT one `invertAffine` already uses
  // (conditioning, not magnitude), so a well-conditioned but tiny affine — an isotropic 1e-7
  // micron scale — is not falsely rejected.
  const det = a[0] * a[4] - a[1] * a[3]
  const norm2 = a[0] * a[0] + a[1] * a[1] + a[3] * a[3] + a[4] * a[4]
  if (!Number.isFinite(det) || Math.abs(det) <= norm2 * 1e-12) {
    throw new OmeTiffPlacementError(
      `coordinateBinding: the declared placement ${JSON.stringify(toSpace)} is singular ` +
        `(det=${det}) — its 2x2 linear part collapses the grid onto a line or a point. A raster ` +
        'placed by it has no extent to frame and no inverse to unproject through.',
    )
  }
  return a
}

/**
 * The deck `modelMatrix` that places a raster's FULL-RESOLUTION pixel grid into its declared
 * coordinate space.
 *
 * This is `omeTiffModelMatrix`'s consumer — the thing #228 exists because nothing was. It adds
 * exactly one thing to it: validation of a value that arrives from the wire. It composes NOTHING
 * over it; see this file's header for the multiplier that is what happens if you do (the header
 * states it, where it is checked; restating it here would be a fourth copy).
 */
export function imagePlacementMatrix(toSpace: readonly number[]): number[] {
  return omeTiffModelMatrix(asPlacementAffine(toSpace))
}

/**
 * The deck `modelMatrix` that places a SERVED LEVEL's pixel grid into the coordinate space, from
 * that level's `ImageUnderlay.affine`.
 *
 * The single-texture fallback path needs its own matrix and it is NOT the same one. `ImageMeta`'s
 * `affine` runs space -> the SERVED level's pixels (it is documented in `data/wire.ts` as
 * *"mapping point coords -> image px"*, and `omeTiffUnderlay.underlayAffine` builds it by
 * inverting `to_space` and dividing by that level's shrink). A `modelMatrix` runs the other way,
 * so this inverts it back.
 *
 * Leaving the fallback unplaced is not a smaller version of being wrong — it is the "two
 * renderings of one artifact disagreeing, with nothing anywhere saying so" hazard
 * `omeTiffUnderlay.ts` names, made real. Once the camera is in the coordinate space, a
 * `BitmapLayer` left at its raw pixel bounds draws the committed Visium fixture 20x too small in
 * the corner of its own pane (`to_space[0] = 5`, and the coarsest level is 4x down).
 */
export function levelPlacementMatrix(affine: Affine): number[] {
  return affineToModelMatrix(invertAffine(affine))
}

/**
 * The bounding box, IN THE COORDINATE SPACE, of a `width x height` full-resolution pixel grid
 * placed by `toSpace`.
 *
 * ALL FOUR CORNERS are mapped, and that is not defensive padding. NGFF RFC-5 admits rotation and
 * shear, `invertAffine` in this package was already written for the non-diagonal case, and the
 * cheap expression `[width * a, height * d]` is not the extent of a rotated rectangle — it is the
 * extent of a rectangle that was never rotated. A registration with any rotation in it would
 * frame the pane on a box that does not contain the image, which reads as "the picture is
 * half off the edge of its pane" — the exact symptom #159 spent a round on.
 *
 * The translation IS included (`tx`/`ty`), which matters for an image whose frame does not start
 * at the space's origin. #176's CORNER convention makes the translation identically zero for
 * everything this system emits today, so on every committed artifact this term contributes
 * nothing — it is here because the affine is a declaration from a producer, not a constant.
 */
export function imageExtentInSpace(
  width: number,
  height: number,
  toSpace: readonly number[],
): SpaceExtent {
  const a = asPlacementAffine(toSpace)
  if (!(width > 0) || !(height > 0)) {
    throw new OmeTiffPlacementError(
      `coordinateBinding: a raster extent must be positive on both axes (got ${width}x${height})`,
    )
  }
  const xs: number[] = []
  const ys: number[] = []
  for (const [px, py] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    xs.push(a[0] * px + a[1] * py + a[2])
    ys.push(a[3] * px + a[4] * py + a[5])
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

/**
 * The camera a pane should open at to frame `extent`: the extent's centre, and the zoom at which
 * its LONGER side just fits the pane's SHORTER side.
 *
 * Split out of the framing effect so the numbers are assertable without mounting React — the
 * framing was previously computed inline and nothing anywhere asserted it, which is how a pane
 * came to be framed on its own sample count (#159) with a clean console.
 *
 * `paneSidePx` is the pane's shorter measured side; a pane not yet measured passes the same
 * fallback the effect always used.
 */
export function frameExtent(
  extent: SpaceExtent,
  paneSidePx: number,
): { target: [number, number, number]; zoom: number } | null {
  const w = extent.maxX - extent.minX
  const h = extent.maxY - extent.minY
  const span = Math.max(w, h)
  // ── NO `Math.max(1, span)` ─────────────────────────────────────────────────────────────────
  // The old expression clamped the fitted span to 1, which was unit-safe while the extent was
  // always in image PIXELS (never below 1). #228 moves it into the DECLARED coordinate space,
  // whose unit the producer chooses: a space stated in millimetres, where a whole section spans
  // 0.9, would be framed at `log2(paneSidePx)` — the image drawn microscopically small — with
  // nothing anywhere saying so. A non-positive or non-finite span is not clamped either; it
  // returns `null` and the caller seeds NO camera, because there is no framing of a degenerate
  // extent that is better than leaving the pane where it is.
  if (!(span > 0) || !Number.isFinite(span) || !(paneSidePx > 0)) return null
  return {
    target: [(extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2, 0],
    zoom: Math.log2(paneSidePx / span),
  }
}

/**
 * One PANE's resolved frame: what its raster declares, what its LAYOUT declares, the ready-to-use
 * deck matrices for both raster render paths AND for the points, and the verdict.
 *
 * Read from ONE catalog — the cell's own dataset's (`catalogForCell`) — so the raster's
 * declaration and the layout's declaration always come from the same place. Reading them from two
 * catalogs is the multi-dataset shape of exactly the bug this module closes.
 *
 * The MATRICES are built here rather than at the emit site, and that is deliberate: building them
 * means VALIDATING a producer declaration, which can refuse, and the emit site is a pure `useMemo`
 * over every cell in the workspace. A refusal thrown from there would blank the entire grid over
 * one bad artifact. Here it becomes a per-path error — a refusal that costs that cell its render
 * and costs no other cell anything.
 */
// NAMED FOR THE PANE, NOT THE GRID CELL, AND THE REASON IS THE APP BOUNDARY. Inside this package
// a "cell" is a logical view bound to a pane (DEC-28's glossary) and the vocabulary is consistent.
// But this type and `resolvePaneFrame` are BARREL EXPORTS that `src-app/ui` consumes, and there
// `Cell` is the domain noun `lint-no-domain-in-builtin` exists to keep out of the app — the app
// must carry ZERO of the domain lattice. So the symbols that CROSS the boundary are pane-named;
// the ones that stay inside keep the grid's own words.
export interface PaneFrame {
  /**
   * has a catalog been READ for this cell at all?
   *
   * ── WHY AN EXPLICIT FLAG AND NOT "everything is undefined" ────────────────────────────────
   * "The catalog has not arrived" and "the catalog says this artifact declares no frame" produce
   * the same undefined fields and are completely different facts, and one caller must tell them
   * apart: the camera seed is IDEMPOTENT-ONCE. The raster fetch and the catalog pull are
   * independent async effects; if the raster lands first, a seed taken on the not-yet-known frame
   * fixes the pane in PIXEL units forever, because the placed frame that arrives a moment later
   * can no longer re-seed. So the framing effect waits on this, and nothing else needs to.
   */
  readonly catalogResolved: boolean
  /** the raster's declared `coordinate_space`, or `undefined` if it declares none. */
  readonly imageSpace?: string
  /** the layout's declared `coordinate_space`, or `undefined`. */
  readonly layoutSpace?: string
  /**
   * deck `modelMatrix` placing the raster's FULL-RESOLUTION grid into the space — the TILED
   * (`imagePixelSource`) path. Absent ⇒ the raster declared no placement and renders at
   * array-index units, which is the honest render for an artifact that never said where it sits.
   */
  readonly imageMatrix?: number[]
  /** deck `modelMatrix` placing the SERVED level's grid into the space — the single-texture path. */
  readonly levelMatrix?: number[]
  /**
   * the SERVED level's grid -> space affine (the inverse of `ImageMeta.affine`), carried for the
   * same reason `imageToSpace` is: a matrix places a grid, and FRAMING a camera needs the corners.
   * The single-texture path has no `to_space` of its own — this is it, at that level's scale.
   */
  readonly levelToSpace?: readonly number[]
  /** the raster's FULL-RESOLUTION `to_space`, carried so a camera can compute the placed EXTENT. */
  readonly imageToSpace?: readonly number[]
  /**
   * the LAYOUT's own declared `to_space`, VALIDATED — six finite, non-singular numbers.
   *
   * ── WHY THE POINTS GET ONE TOO, WHEN EVERY SHIPPED IMPORTER WRITES IDENTITY ────────────────
   * §6.6 requires `to_space` on EVERY coordinate-bearing artifact, and §5's axiom puts Points and
   * Shapes in that set alongside Images. Both shipped importers happen to state their coordinates
   * IN the space (`to_space: [1,0,0,0,1,0]`), so today this matrix is always identity — and
   * relying on that is producer discipline where the design supplies a declaration. A
   * coordinates artifact whose placement is NOT identity (a second section registered
   * into a shared frame, which is the case §4's anti-pattern is written about) would otherwise be
   * drawn unregistered, with no error and no refusal.
   *
   * ── IT IS READ AND IT IS NOT APPLIED, AND THAT IS THE POINT (DEC-17) ───────────────────────
   * Nothing renders with this. It exists so the binding can SEE the declaration and refuse a
   * non-identity one: this renderer moves the RASTER and never the points, because moving points
   * with a deck `modelMatrix` leaves every CPU-side consumer of the raw buffer behind it — the
   * lasso mask, the hover ring, the selection provenance replay, the cross-pane tooltip, the
   * vector export.
   *
   * It is the DECLARED ARRAY and not a 4x4, because a matrix would be sixteen numbers no renderer
   * reads — dead as a value, which this repo treats as an unfinished feature rather than a
   * finished one. Its PRESENCE is `layoutPlaced` (the producer said where its numbers sit) and
   * its CONTENT is `layoutIsIdentity` (whether they need moving); both are read, and it is
   * validated on the way in, so a malformed layout placement refuses exactly as a raster's does.
   */
  readonly layoutToSpace?: readonly number[]
  /**
   * set when the RASTER declared a placement this reader refuses (not six finite numbers, or
   * singular). The cell then renders nothing at all, because every alternative is worse: identity
   * would draw the picture in the wrong place, and drawing it unplaced under a space-framed
   * camera is the same thing with extra steps.
   */
  readonly placementError?: string
  /**
   * set when the SERVED-LEVEL affine cannot be inverted. Kept SEPARATE from `placementError` on
   * purpose: it disables only the single-texture fallback, and blanking the tiled path — whose
   * own `to_space` may be perfectly fine — over a fault in the other path's number is a refusal
   * wider than its cause.
   */
  readonly levelPlacementError?: string
  /** may this layout's points be drawn over this raster, and if not, why not. */
  readonly binding: OverlayBinding
}

/** The frame with nothing read yet. `catalogResolved: false` is the load-bearing field. */
const UNRESOLVED_FRAME: PaneFrame = {
  catalogResolved: false,
  binding: {
    bound: false,
    reason:
      'the cell has no resolved catalog yet, so neither the raster nor the layout has declared ' +
      'anything. Nothing is drawn on a frame that has not been read.',
  },
}

/** The shape `resolvePaneFrame` reads — a `DatasetCatalog`, narrowed to what a frame needs. */
export interface FrameCatalog {
  readonly image?: {
    readonly space?: string
    readonly toSpace?: readonly number[]
    readonly affine: readonly [number, number, number, number, number, number]
  }
  readonly layouts: readonly {
    readonly id: string
    readonly space?: string
    readonly toSpace?: readonly number[]
  }[]
}

/**
 * Resolve a cell's frame from its catalog and the id of the layout the cell actually DRAWS.
 *
 * `layoutId` must be the DRAWN layout, not merely the cell's declared one — see `layoutDrawnBy`
 * in `grid/gridModel.ts`. Binding on one layout while the pane paints another's positions is a
 * UMAP on tissue with no producer error anywhere, and it is reachable: for a default cell the
 * grid's owned pull reads `catalog.layouts[0]`, whatever the cell's `layoutId` says.
 *
 * Pure and total: a missing catalog, a missing image, a missing layout and a malformed
 * declaration all resolve to a REFUSAL carrying its reason, never to a fabricated identity.
 */
export function resolvePaneFrame(
  catalog: FrameCatalog | null | undefined,
  layoutId: string,
): PaneFrame {
  if (!catalog) return UNRESOLVED_FRAME
  const image = catalog.image
  const layout = catalog.layouts.find(l => l.id === layoutId)
  const imageSpace = typeof image?.space === 'string' && image.space ? image.space : undefined
  const layoutSpace = typeof layout?.space === 'string' && layout.space ? layout.space : undefined
  const declared = {
    catalogResolved: true,
    ...(imageSpace === undefined ? {} : { imageSpace }),
    ...(layoutSpace === undefined ? {} : { layoutSpace }),
    ...(image?.toSpace === undefined ? {} : { imageToSpace: image.toSpace }),
  }

  // THE RASTER'S OWN PLACEMENT. A refusal here is fatal to the cell: the primary declaration is
  // broken and there is no honest way to draw the picture.
  let imageMatrix: number[] | undefined
  if (image?.toSpace !== undefined) {
    try {
      imageMatrix = imagePlacementMatrix(image.toSpace)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return {
        ...declared,
        placementError: reason,
        binding: {
          bound: false,
          reason: `the raster declares a placement this reader refuses: ${reason}`,
        },
      }
    }
  }

  // THE SERVED LEVEL'S PLACEMENT, in its OWN try — it feeds only the single-texture fallback.
  let levelMatrix: number[] | undefined
  let levelToSpace: Affine | undefined
  let levelPlacementError: string | undefined
  if (image !== undefined) {
    try {
      levelToSpace = invertAffine(image.affine as Affine)
      levelMatrix = affineToModelMatrix(levelToSpace)
    } catch (e) {
      levelPlacementError = e instanceof Error ? e.message : String(e)
      levelToSpace = undefined
    }
  }

  // THE POINTS' OWN PLACEMENT (§6.6 / §5). A layout that declares a space MUST also declare where
  // in it its numbers sit; a malformed one refuses the overlay rather than drawing it unplaced.
  // VALIDATED, not built: `asPlacementAffine` is the same check the raster's placement gets
  // (six finite, non-singular numbers) and it is all this needs — nothing renders the result.
  let layoutToSpace: readonly number[] | undefined
  let layoutPlacementError: string | undefined
  if (layout?.toSpace !== undefined) {
    try {
      asPlacementAffine(layout.toSpace)
      layoutToSpace = layout.toSpace
    } catch (e) {
      layoutPlacementError = e instanceof Error ? e.message : String(e)
    }
  }

  const built = {
    ...declared,
    ...(imageMatrix === undefined ? {} : { imageMatrix }),
    ...(levelMatrix === undefined ? {} : { levelMatrix }),
    ...(levelToSpace === undefined ? {} : { levelToSpace }),
    ...(levelPlacementError === undefined ? {} : { levelPlacementError }),
    ...(layoutToSpace === undefined ? {} : { layoutToSpace }),
  }
  if (layoutPlacementError) {
    return {
      ...built,
      binding: {
        bound: false,
        reason: `the layout declares a placement this reader refuses: ${layoutPlacementError}`,
      },
    }
  }
  return {
    ...built,
    binding: resolveOverlayBinding({
      imageSpace,
      layoutSpace,
      imagePlaced: imageMatrix !== undefined,
      layoutPlaced: layoutToSpace !== undefined,
      layoutIsIdentity: layoutToSpace !== undefined && isIdentityAffine(layoutToSpace),
    }),
  }
}

/**
 * The `ImageMeta.toSpace` for a raster whose placement is stated as a SERVED-LEVEL affine.
 *
 * ── WHY THIS EXISTS RATHER THAN AN EXPORTED `invertAffine` ────────────────────────────────────
 * `omeTiffUnderlay.ts`'s header records the rule this follows: it lives in this package, and not
 * in the app, because *"putting the reduction in the app would mean exporting three internals so
 * that pixel arithmetic and affine inversion could happen one layer up, in the module that is
 * supposed to know only about transport."* `Affine` and `invertAffine` are deliberately internal.
 * So the app gets the one derived VALUE it needs, not the arithmetic to derive it.
 *
 * ── AND WHY A CALLER NEEDS IT ─────────────────────────────────────────────────────────────────
 * `toSpace` is what says a raster knows WHERE IN ITS SPACE IT SITS, and the binding refuses
 * without it (see `resolveOverlayBinding`'s `imagePlaced`). A source whose placement is natively
 * an `ImageUnderlay.affine` — the declarative `image` widget, whose spec relates its `points` to
 * its raster by exactly that affine — has a real declaration and must not be mistaken for one
 * that has none. Its single texture IS its level 0, so its `to_space` is that affine inverted.
 *
 * Throws on a singular affine, which a valid placement never is.
 */
export function toSpaceFromLevelAffine(
  affine: readonly [number, number, number, number, number, number],
): readonly number[] {
  // `-0` normalized to `0`. The 2x2 inverse produces it for any zero off-diagonal term
  // (`-m01 * inv`), and it is arithmetically identical but NOT `Object.is`-identical, so a value
  // that round-trips through a strict comparison anywhere downstream — a test, a memo key, a
  // declaration diff — would report a difference that is not one.
  return invertAffine(affine as Affine).map(v => (v === 0 ? 0 : v))
}

/**
 * WHY a pane draws no point overlay — the ONE derivation the emit and the refusal reporter share.
 *
 * They are two modules that may not import each other (INV-10 (d)) and they must say the same
 * thing: the emit decides whether to draw, the reporter explains an empty pane, and a round-4
 * audit found them already disagreeing on PRECEDENCE (one raster-first, one binding-first) so a
 * pane that was both un-drawable and unbound was refused for one reason and explained with
 * another. `paneRasterPresent` in `gridModel` shares the boolean half; this shares the message.
 *
 * `undefined` = nothing to explain: the overlay is drawn.
 */
export function overlayRefusal(
  frame: Pick<PaneFrame, 'levelPlacementError' | 'binding'>,
  rasterPresent: boolean,
): string | undefined {
  if (!rasterPresent) {
    return (
      frame.levelPlacementError ??
      'the pane resolved no raster to draw, so there is nothing for its points to sit on'
    )
  }
  return frame.binding.bound ? undefined : frame.binding.reason
}

/**
 * Is a declared placement the identity — the positions stated directly IN the space?
 *
 * EXACT equality, not a tolerance. A producer either wrote `[1,0,0,0,1,0]` or it wrote a
 * transform, and a near-identity affine is a transform the producer meant: approximating it away
 * is precisely the "plausible wrong answer" this module refuses everywhere else. A tolerance here
 * would also be a threshold, and thresholds are the thing DEC-10 records this feature as having
 * none of.
 */
export function isIdentityAffine(toSpace: readonly number[]): boolean {
  return (
    toSpace.length === 6 &&
    toSpace[0] === 1 &&
    toSpace[1] === 0 &&
    toSpace[2] === 0 &&
    toSpace[3] === 0 &&
    toSpace[4] === 1 &&
    toSpace[5] === 0
  )
}


