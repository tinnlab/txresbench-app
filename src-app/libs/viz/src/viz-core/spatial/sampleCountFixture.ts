// sampleCountFixture.ts — the ORACLE for the `samples-per-pixel-<S>.ome.tif` family (#288).
//
// A sibling of `imageFixture.ts` / `labelMaskFixture.ts` / `categoricalPointsFixture.ts`: a
// pure, dependency-free description of a committed fixture, kept beside the fixture rather
// than inside one suite, because TWO suites read these files — `omeTiffSampleCounts.test.ts`
// (the reader) and `omeTiffUnderlay.test.ts` (the single-texture reduction of the same bytes).
// Two hand-copied restatements of the closed form below would be free to drift apart, and a
// drifted oracle silently weakens whichever copy is wrong.
//
// It is NOT exported from `src/index.ts` or `src/core.ts`: nothing outside this directory has
// any use for it, and a fixture description is not public API.
//
// ── WHY A CLOSED FORM AND NOT A DIGEST ────────────────────────────────────────────────────
// A digest of the decoded raster answers "did these bytes change?"; it does not answer "is
// this the sample that was asked for?". The defect #288 covers is the reader returning sample
// 0 for every channel, which a per-channel digest would catch only if the digests were
// themselves derived from the right samples — i.e. it moves the question rather than answering
// it. The arithmetic below is checkable by reading it.

/**
 * Sample `s` of pixel `(x, y)` at LEVEL 0, exactly as
 * `scripts/make-sample-count-fixtures.py` writes it: `(37s + 5x + 3y) mod 251`, uint8.
 *
 * The constants are not arbitrary. 251 is the largest prime under 256 and is coprime with 37,
 * 5 and 3, so the map is injective in `s` at every pixel: sample 0 substituted for sample `c`
 * differs in EVERY pixel of the plane, not merely on average. That is what makes a partial
 * render impossible to pass off as a near-miss.
 */
export function level0Sample(s: number, x: number, y: number): number {
  return (37 * s + 5 * x + 3 * y) % 251
}

/**
 * `np.rint` — round-half-to-EVEN.
 *
 * The writer's `downsample` ends `np.rint(mean).astype(arr.dtype)` for an integer dtype, and
 * `Math.round` is NOT that function: `Math.round(0.5) === 1` while `np.rint(0.5) === 0`. A
 * mean of four uint8 values lands on a quarter-integer, so the half case is reached and the
 * difference is real — a quiet one-count error on exactly those pixels, which is the same
 * class the writer's own comment says a bare `astype` introduces.
 */
export function rintHalfToEven(value: number): number {
  const floor = Math.floor(value)
  const frac = value - floor
  if (frac > 0.5) return floor + 1
  if (frac < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Sample `s` of pixel `(x, y)` at LEVEL 1 — the writer's 2x2 BOX MEAN of level 0
 * (`ome_writer.downsample`, factor 2), rounded half-to-even.
 *
 * Not decimation. `downsample`'s own docstring says why: *"Decimation (`arr[::f, ::f]`) would
 * be cheaper ... but it throws away all but one of every `f x f` measurements and makes a thin
 * bright feature blink in and out as the viewer changes zoom."* An oracle that decimated would
 * agree with the file on a smooth gradient and disagree on anything else.
 */
export function level1Sample(s: number, x: number, y: number): number {
  const sum =
    level0Sample(s, 2 * x, 2 * y) +
    level0Sample(s, 2 * x + 1, 2 * y) +
    level0Sample(s, 2 * x, 2 * y + 1) +
    level0Sample(s, 2 * x + 1, 2 * y + 1)
  return rintHalfToEven(sum / 4)
}

/** Sample `s` of pixel `(x, y)` at pyramid level `level` (0 or 1). */
export function sampleAtLevel(level: number, s: number, x: number, y: number): number {
  return level === 0 ? level0Sample(s, x, y) : level1Sample(s, x, y)
}

/** The family's level-0 extent. Level 1 is `floor(level0 / 2)` — `assertHalvingPyramid`'s rule. */
export const SAMPLE_FIXTURE_WIDTH = 300
export const SAMPLE_FIXTURE_HEIGHT = 200
export const SAMPLE_FIXTURE_LEVEL1_WIDTH = 150
export const SAMPLE_FIXTURE_LEVEL1_HEIGHT = 100

/** The committed file for a sample count, relative to `src/viz-core/spatial/fixtures`. */
export const sampleCountFixtureFile = (samples: number): string =>
  `samples-per-pixel-${samples}.ome.tif`
