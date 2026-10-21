// staleClaims.test.ts — #294 TEST-5 [acceptance] [invariant: INV-4], and #288/#294 TEST-11.
//
// Realizes `docs/design/ome-tiff-reader-sample-counts.md` §7.
//
// ── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────
// The PROSE analogue of `scripts/check-viz-producer-magnitudes.mjs` (#277). That guard exists
// because a quoted MAGNITUDE can be true when written and false later; this one exists because
// a quoted CLAIM can, and #294 is a live instance: `spotOverlayRegistration.test.ts` went on
// stating that no committed artifact in this repo pairs a real tissue image with its real
// spots for months after #243 made one, and that sentence was the stated justification for the
// oracle the file uses.
//
// ── WHY IT IS HERE AND NOT IN `spatial-import-visium` ─────────────────────────────────────
// It already IS there — `tests/test_image_coherence.py`'s
// `test_no_stale_claim_that_the_shipped_image_is_incoherent_survives`, whose docstring says it
// "scans the WHOLE package recursively". Its `CLAIM_SCAN_ROOT` is `VF.PKG`, i.e. that package.
// It cannot see `libs/viz`, which is exactly why this copy of the claim survived #243 while
// five copies inside that package were corrected. A guard rooted at one package does not
// protect another; the second root is the fix, not a second opinion.
//
// ── AND WHY IT NORMALIZES ──────────────────────────────────────────────────────────────────
// The visium guard matches EXACT substrings, and its docstring is careful that this "does NOT
// catch a REWORDED restatement". That is an accepted limit for Python, where the sentences sat
// inside docstrings on one line. Here they sat inside `//` comments and were LINE-WRAPPED, so
// the retired sentence spanned a newline plus a `//` prefix — a raw substring scan would have
// missed the one instance this guard was written for. So the text is normalized (newlines,
// comment prefixes and runs of whitespace collapse to single spaces) BEFORE matching, which is
// what the second control below demonstrates rather than asserts.
//
// It is still a cheap tripwire on known-false sentences, not a semantic matcher, and it
// inherits the visium guard's stance on that: a false positive on a correctly past-tense use
// is accepted, and the fix when one trips is to reword.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The `@ziee/viz` package root — this guard's `CLAIM_SCAN_ROOT`.
 *
 * Derived from THIS FILE's own location, not from `process.cwd()`. The package's `test` script
 * runs vitest from the package directory, so `cwd` happens to be right today; a run from the
 * repo root would silently re-scope the whole guard (and break the reads in TEST-11) while
 * still reporting green, which is the one failure mode a tripwire like this cannot afford.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * The DESIGN directory, scanned alongside the package.
 *
 * A blind audit made the point that this guard reproduces, one level up, the very defect it
 * exists for: `spatial-import-visium`'s scanner is rooted at that package and could not see
 * `libs/viz`, and a scanner rooted at `libs/viz` cannot see `docs/design`. A design document is
 * exactly where a retired claim would next be restated as if it were still true, so the root is
 * widened rather than the observation merely noted. Verified by mutation: with the retraction
 * document's exemption removed, the scan reports it.
 */
const DESIGN_ROOT = path.resolve(PACKAGE_ROOT, '../../../docs/design')

/**
 * Sentences that were TRUE when written and are FALSE since #243, verbatim.
 *
 * Kept in sync with `spatial-import-visium/tests/test_image_coherence.py`'s
 * `FALSIFIED_CLAIMS` — deliberately the same list, because the claim is one claim and a viz
 * file restating it is the same defect as a visium file restating it. Two entries are added
 * for the spellings that only ever appeared on this side of the tree.
 */
const FALSIFIED_CLAIMS: readonly string[] = [
  'the image does not even cover the spots it is supposed to sit under',
  'of its 160 spots land on its own image',
  'shipped 200x200 vendor',
  'The RAW vendor fixture PNG is 200x200',
  // NOT also the longer "its `tissue_hires_image.png` is 200x200": that is a strict superstring
  // of this entry and could never fire independently of it. (The same note the visium guard
  // carries, for the same reason.)
  '`tissue_hires_image.png` is 200x200',
  'every spot maps outside the 200x200 frame',
  'zero of its spots land on its own image',
  // The two spellings that lived only here. The first is the sentence #294 was filed for.
  'There is NO committed artifact in this repo where a real tissue image and its real spots are geometrically coherent',
  'no committed fixture in this tree is',
]

/**
 * Files the scan does not judge, as paths RELATIVE to `PACKAGE_ROOT`.
 *
 * Relative rather than by basename, for the reason the visium guard states: a basename
 * exemption silently excuses every same-named file, which switches a guard off somewhere
 * nobody looked.
 *
 * * this file, which is ABOUT the falsified claims and must contain them to match them;
 * * `spotOverlayRegistration.test.ts`, which RETRACTS one of them by quoting it. That
 *   retraction is the whole point of #294, so the guard must not forbid it — and the
 *   exemption is not a hole, because TEST-11 below asserts POSITIVELY that the retraction and
 *   its replacement reasons are present. Absence-checking alone would go green on a file that
 *   deleted the paragraph entirely.
 *
 * **Every exempt file gets a positive assertion in TEST-11, and that is what makes an
 * exemption something other than a hiding place.** The design document was exempted with none
 * for one round, under a comment claiming otherwise — the same shape of false justification
 * this whole guard exists to catch.
 */
const EXEMPT: readonly string[] = [
  'src/viz-core/spatial/staleClaims.test.ts',
  'src/viz-core/spatial/spotOverlayRegistration.test.ts',
  // The design document that RETRACTS the claim (§7). Same disposition and same reason as the
  // overlay suite: a retraction has to quote what it retracts. TEST-11 asserts positively that
  // it still frames them as retracted, so the exemption is not a place to hide a live claim.
  '../../../docs/design/ome-tiff-reader-sample-counts.md',
]

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.mjs', '.js', '.py'])
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.vite-temp', 'coverage'])

/**
 * Collapse a source file to one line of comparable prose.
 *
 * Newlines, leading `//` / `#` / `*` comment markers and runs of whitespace all become a single
 * space, so a sentence that was wrapped across a comment boundary reads the same as one that
 * was not. This is the ONE thing this guard does that the visium one does not, and the second
 * control below is what proves it rather than asserting it.
 */
export function normalizeClaimText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    // `>` (markdown blockquote) is here because the scan root was widened to `docs/design`, and
    // a design document is the one place these sentences get quoted. Without it the guard's
    // headline capability — catching a spelling wrapped across a line — did not extend to `.md`
    // at all: the retired "NO committed artifact …" sentence sits wrapped across a blockquote in
    // this feature's own design document and the scanner could not see it. The third control
    // below is what holds that shut.
    //
    // A `-` alternative was added beside it for markdown LIST items and is deliberately gone
    // again: it was IDLE (a list marker is leading, so the claim substring starts after it and
    // matches either way — removing the alternative left every test green) and it was UNANCHORED,
    // so it stripped the hyphen out of every compound in every scanned file, turning
    // `samples-per-pixel-5` into `samples per pixel 5`. That widens matching, never narrows it,
    // which for a three-word entry like `shipped 200x200 vendor` is a false-positive hazard in
    // exchange for nothing.
    //
    // The other three are unanchored TOO — `#288` normalizes to ` 288`, and a `//` inside a URL
    // splits it — and they stay, so the distinction is stated rather than left to look like an
    // inconsistency. `//`, `#` and `*` are COMMENT MARKERS in the languages this scan walks
    // (TypeScript, Python, JSDoc continuations, markdown emphasis and headings), and stripping
    // them is the entire reason this function exists: the sentences being hunted live inside
    // comments and are wrapped by them. `-` is not a comment marker in any of them; its only
    // role would have been the markdown list item, which needs no rule. The widening the three
    // do buy is the price of the capability; the widening `-` bought was the price of nothing.
    .replace(/\s*(?:\/\/+|#+|>+|\*)\s*/g, ' ')
    .replace(/\s+/g, ' ')
}

/** Every retired sentence present in `text`, after normalization. */
function claimsIn(text: string): string[] {
  const normalized = normalizeClaimText(text)
  return FALSIFIED_CLAIMS.filter(claim => normalized.includes(normalizeClaimText(claim)))
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (SCANNED_EXTENSIONS.has(path.extname(entry))) yield full
  }
}

/**
 * The `workstore` e2e specs — a THIRD root, added by #259.
 *
 * Not all of `src-app/ui`: these are the specs that consume this fixture corpus and describe
 * its layout, and three of the sentences #259 retired lived in them, outside both existing
 * roots. The reasoning is this file's own, one level out again — "A guard rooted at one package
 * does not protect another; the second root is the fix, not a second opinion." A guard rooted at
 * `@ziee/viz` + `docs/design` could not see the specs that quote the corpus, so the correction
 * there could rot back with nothing noticing, which is the entire failure class this file exists
 * for.
 */
const WORKSTORE_E2E_ROOT = path.resolve(PACKAGE_ROOT, '../../ui/tests/e2e/workstore')

/**
 * The PRODUCER package — a FOURTH root, and the one most likely to restate the claim.
 *
 * This guard's subject is what THE WRITER EMITS, and the writer is `ome_writer.py`. A guard
 * about the writer that cannot see the writer is the same shape as the two roots above it
 * ("A guard rooted at one package does not protect another"), one package further out. The
 * root is `spatial-types/compute`, where the writer and its declarations live — not all of
 * `src-app/packages`, which would sweep in every producer's prose for no gain.
 *
 * Scanned READ-ONLY. Nothing in this branch edits that package; the root exists so a future
 * edit that reinstates "the writer emits stripped bytes" there reddens here.
 */
const PRODUCER_ROOT = path.resolve(PACKAGE_ROOT, '../../packages/spatial-types/compute')

/**
 * #158's wire measurement, corrected by #259 — a retired claim WITH a shrinking allowlist.
 *
 * The sentence says one 512x512 level-0 tile cost 14 ranged GETs of which *"ten of them
 * consecutive full-width strips"*. It is NINE: on `spatial-image-hires-stripped.ome.tif` (the
 * artifact #158 measured, kept byte-identical) a 512-row band spans nine 62-row strips summing
 * to 36,383 B, and 41,891 - 36,383 = 5,508 over 14 - 9 = 5 GETs is exactly this file's measured
 * open. Ten would leave a 1,452-byte 4-GET open, which no measurement of this reader produces.
 * `docs/design/ome-tiff-tile-layout.md` §2 carries the correction; #259 TEST-4 asserts it.
 *
 * ── WHY IT IS A RETIRED CLAIM WITH AN ALLOWLIST RATHER THAN A DEFERRAL ────────────────────
 * Six copies of the sentence existed when #259 retired it. Five were under `src-app/packages/`,
 * which #259 was scoped out of (#300); **#321** corrected all five to "nine" and **#333** deleted
 * the `spatial-types/compute/ome_writer.py` entry this allowlist carried for them, in the same
 * commit. The sixth is §2 of the design document, which QUOTES it in order to retract it — the
 * same disposition `EXEMPT` above gives the #294 retraction, for the same reason — and it is now
 * the ONLY copy left outside this file.
 *
 * That last clause is a COUNT, which is exactly the kind of sentence this file exists to catch
 * going stale — and it did: #334 is this paragraph, which went on counting the five package
 * copies as unfixed for as long as it took someone to read it after #321 landed. (Its exact
 * pre-#321 wording is deliberately NOT quoted back here; TEST-11's #334 case treats those
 * sentences as retired, and this docstring is inside the corpus that case reads.) So it is not
 * prose you have to trust, and it holds no number of its own: `CORRECTED_BY_259_ALLOWED` IS the
 * register of surviving copies, and it is pinned in BOTH directions — the offenders scan fails on
 * a carrier that is not listed, the "must still contain" loop fails on a listed path that no
 * longer carries it, and TEST-11's #334 case fails if this paragraph stops NAMING what the list
 * holds, or keeps saying "ONLY copy" once the list grows. What this paragraph says about where
 * the copies are is therefore checked against the list on every run, not maintained by hand.
 *
 * Outside the four scan roots, `src-app/packages/` is the authority of
 * `spatial-types/tests/test_wire_measurement_strip_count.py` (#321/#333), which walks the WHOLE
 * package tree and DERIVES the count from the artifact #158 measured rather than restating it, so
 * no number about that subtree is written down here either. `PRODUCER_ROOT` below still walks
 * `spatial-types/compute` from this side; the other twenty-odd packages are that guard's.
 *
 * An earlier cut left the sentence OUT of the retired list entirely and marked the gap with two
 * assertions instead. One — that the producer still contains the sentence — was sound, and it
 * survives here as the "must still contain" loop below. The other, that the sentence was absent
 * from the retired list, was DOMINATED: both its operands were literals in this file, and the
 * only edit that could falsify it made the offenders check fail five lines earlier. And the
 * shape as a whole bought nothing the list buys — a SEVENTH copy could be added to any scanned
 * file with the guard green. Listing the sentence and enumerating its known homes gives that
 * protection now, expires by shrinking, and asserts no falsehood.
 *
 * WHAT IT STILL DOES NOT COVER, because an allowlist's honest description is its holes: the
 * exemption is per FILE, so a second copy inside `ome-tiff-tile-layout.md` — since #333 the one
 * allowlisted file — is not caught. Narrowing that would mean counting matches rather than testing
 * membership, and the design document legitimately quotes the sentence more than once in the
 * course of retracting it. What this buys is protection against the sentence spreading to a NEW
 * file. That is the whole of it.
 */
const CORRECTED_BY_259 = 'ten of them consecutive full-width strips'

/**
 * The ONLY files allowed to contain `CORRECTED_BY_259`, as paths relative to `PACKAGE_ROOT`.
 *
 * Each is asserted to STILL contain it, so the list cannot outlive the sentence: fix a copy
 * without shrinking this list and the test fails and says which entry to delete. The last
 * `src-app/packages/` entry went with #321/#333; only the retraction in §2 remains, and TEST-11's
 * #334 case requires the paragraph above to name whatever this list holds.
 */
const CORRECTED_BY_259_ALLOWED: readonly string[] = [
  // The retraction. It must quote what it retracts.
  '../../../docs/design/ome-tiff-tile-layout.md',
]

/**
 * Sentences that were TRUE when written and are FALSE since #227, verbatim (#259 TEST-7).
 *
 * #227 made `ome_writer.write_ome_tiff` pass `tile=(512, 512)` at every `writer.write` call
 * site, so every image this system emits is a TILED OME-TIFF at every pyramid level. These are
 * the sentences that said otherwise. They are a SEPARATE list from `FALSIFIED_CLAIMS` above
 * because they are a separate falsification with a separate cause, a separate date and a
 * separate scan root; merging them would make one liveness bound stand for two guards.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────
 * "stripped" is not a retired WORD. `docs/design/ome-tiff-tile-layout.md` §5 keeps a stripped
 * file in the corpus permanently, `tiledOfDirectory`'s false branch is the vendor-file branch,
 * and `spatial-image-hires-stripped.ome.tif` is described accurately as stripped in this
 * directory's README. Each entry below therefore says something about what THE WRITER EMITS or
 * about work that is now DONE — the claims #227 falsified — and none of them is satisfiable by
 * a correct present-tense sentence about a third-party layout.
 */
const LAYOUT_CLAIMS_RETIRED_BY_227: readonly string[] = [
  'every image this system currently emits is STRIPPED',
  // Covers both spellings that shipped — "the writer emits STRIPPED OME-TIFFs" and "the writer
  // currently emits STRIPPED OME-TIFFs" — which are not superstrings of each other, so one
  // entry at their common core is what makes the pair a single check rather than a pair that
  // can be half-satisfied.
  'emits STRIPPED OME-TIFFs',
  'because the emitted file is STRIPPED',
  // TWO entries for one sentence, and the reason is a real hole an earlier cut had. The
  // sentence shipped in two places in `spatial-coordinate-binding.spec.ts`: once as contiguous
  // comment prose, and once SPLIT ACROSS A STRING CONCATENATION —
  // `` `… — measured against #227's STRIPPED ` + 'layout, …' `` — which no amount of
  // comment-prefix normalization rejoins. An earlier version listed only the contiguous
  // spelling and asserted in a comment that the split one was "covered by
  // `emits STRIPPED OME-TIFFs` in the same file". Replayed against `origin/main`, it is not:
  // that entry matches only `spatial-image-render.spec.ts`. So the concatenated occurrence was
  // covered by NOTHING and could be reintroduced verbatim with the guard green — a phantom leg
  // in the guard written to catch phantom claims.
  "against #227's STRIPPED layout",
  // …and the fragment that survives the concatenation boundary. Three words, and the distinctive
  // literal is `227`.
  "measured against #227's STRIPPED",
  'the layout the writer does not currently emit',
  'Making the bytes tiled is a one-line change to the writer',
  '`loadOmeTiff` yields `tileSize = 32`',
  // Retired by #259 rather than by #227, and allowlisted where it legitimately survives — see
  // `CORRECTED_BY_259_ALLOWED`.
  CORRECTED_BY_259,
]

/** Every retired-layout sentence present in `text`, after the same normalization. */
function layoutClaimsIn(text: string): string[] {
  const normalized = normalizeClaimText(text)
  return LAYOUT_CLAIMS_RETIRED_BY_227.filter(claim => normalized.includes(normalizeClaimText(claim)))
}

describe('#259 TEST-7 no retired claim that the writer emits STRIPPED bytes survives', () => {
  it('scans the package, the design docs AND the workstore e2e specs', () => {
    const offenders: string[] = []
    const scanned: Record<string, number> = {}
    // Each root is REQUIRED and counted on its own, for the reason TEST-5 records: a single
    // combined liveness bound is satisfiable by one root while another silently walks nothing.
    for (const root of [DESIGN_ROOT, WORKSTORE_E2E_ROOT, PRODUCER_ROOT]) {
      expect(existsSync(root)).toBe(true)
    }
    for (const [name, root] of [
      ['package', PACKAGE_ROOT],
      ['design', DESIGN_ROOT],
      ['workstore-e2e', WORKSTORE_E2E_ROOT],
      ['producer', PRODUCER_ROOT],
    ] as const) {
      scanned[name] = 0
      for (const file of walk(root)) {
        // This file is ABOUT the retired sentences and must contain them to match them. It is
        // the ONLY exemption, and it is not a hiding place: the control below asserts
        // positively that every entry is individually detectable.
        if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue
        scanned[name]++
        const relative = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/')
        for (const claim of layoutClaimsIn(readFileSync(file, 'utf8'))) {
          if (claim === CORRECTED_BY_259 && CORRECTED_BY_259_ALLOWED.includes(relative)) continue
          offenders.push(`${relative}: ${JSON.stringify(claim)}`)
        }
      }
    }
    // Liveness bounds set just under the REAL counts, not at a round number an emptied root
    // would still clear. Measured at the time of writing under this file's own walk: package 691, design 32,
    // workstore-e2e 10, producer 2 (`ome_writer.py` + `spatial_declarations.py`).
    // Re-measured by #322, which added files to two of these roots: package 692, design 35,
    // workstore-e2e 10, producer 2. The floors below are unchanged — they were set under the real
    // counts and still are — but the numbers in the sentence above are this walk's history, not
    // its present, and a measurement quoted as current is the defect this whole file is about. The e2e root previously carried a `> 3` floor, which it
    // would still have met after losing six of its ten files — including all three specs the
    // root was added for.
    // 680 and not a round 600: the whole `src/viz-core/spatial/` subtree — this corpus, the
    // reader, and both of the test files this guard exists for — is 47 scanned files, so a 600
    // floor would still pass with every one of them deleted. That is the failure mode the
    // paragraph above disavows, and an earlier cut had it.
    expect(scanned.package).toBeGreaterThanOrEqual(680)
    expect(scanned.design).toBeGreaterThanOrEqual(30)
    expect(scanned['workstore-e2e']).toBeGreaterThanOrEqual(9)
    expect(scanned.producer).toBeGreaterThanOrEqual(2)
    expect(offenders).toEqual([])

    // EVERY allowlisted path must STILL contain the sentence, so the exemption cannot outlive
    // what it exempts. This is how #321's correction of `ome_writer.py` was forced to shrink the
    // list in the same commit (#333): fix a copy and leave its entry and this fails, naming the
    // entry to delete — the opposite failure direction from the scan above, and the one an
    // allowlist normally gets wrong.
    expect(CORRECTED_BY_259_ALLOWED.length).toBeGreaterThan(0)
    for (const relative of CORRECTED_BY_259_ALLOWED) {
      const full = path.resolve(PACKAGE_ROOT, relative)
      expect([relative, existsSync(full)]).toEqual([relative, true])
      expect(
        [relative, layoutClaimsIn(readFileSync(full, 'utf8')).includes(CORRECTED_BY_259)],
        `${relative} no longer says "ten … strips" — remove it from CORRECTED_BY_259_ALLOWED`,
      ).toEqual([relative, true])
    }
  })

  it('THE CORRECTED RECORD IS PRESENT, not merely the false one absent', () => {
    // This file's own `EXEMPT` docstring states the rule and TEST-11 implements it for #294:
    // "Absence-checking alone would go green on a file that deleted the paragraph entirely."
    // TEST-7 had no counterpart, so deleting the corrected paragraphs — rather than correcting
    // them — left it green, which is the cheapest possible way to satisfy a stale-prose guard
    // and the one it must not accept.
    // BOTH sides normalized. The scanner strips comment markers, so `#227` reads as ` 227` in
    // the haystack; an un-normalized needle containing `#` would never match and this whole
    // test would be vacuous in the direction that matters.
    const read = (relative: string) =>
      normalizeClaimText(readFileSync(path.resolve(PACKAGE_ROOT, relative), 'utf8'))
    const says = (haystack: string, needle: string) =>
      expect([needle, haystack.includes(normalizeClaimText(needle))]).toEqual([needle, true])

    const reader = read('src/viz-core/spatial/omeTiffPyramid.ts')
    // `tiledOfDirectory` says the change was MADE, and says the false branch is permanent.
    says(reader, 'That change was made.')
    says(reader, '#227 passes `tile=(512, 512)` at every `writer.write` call site')
    says(reader, 'it is the vendor-file branch')
    // …and the tileSize override carries the answer #259 asked for, in both directions.
    says(reader, 'IS THIS OVERRIDE STILL NEEDED AFTER #227? YES (#259).')

    const design = normalizeClaimText(
      readFileSync(path.resolve(DESIGN_ROOT, 'ome-tiff-tile-layout.md'), 'utf8'),
    )
    // The design's §5 and §6 both make claims this branch falsified; each must now RETRACT
    // rather than merely have dropped the sentence — and the needles are the SUBSTANCE of each
    // retraction, not its heading. A heading is exactly what a reworded reversion keeps.
    says(design, "What stays is the invariant's INTENT, not")
    // §5's substance, REPOINTED BY #322 (and note what happened to the sentence it replaces).
    // This needle used to pin *"Nothing in the corpus decodes a stripped OME-TIFF from a third
    // party."* — §5's admission of the residual gap, which was the correct thing to require while
    // the gap was open. #322 CLOSED it, so requiring that sentence to be present would now be a
    // guard demanding a false statement. It is not merely dropped: it moves to
    // `CLAIMS_RETIRED_BY_322` below, where it is FORBIDDEN in every scanned root with its own
    // control — so one presence assertion became one presence assertion plus a repo-wide absence
    // scan, and strictly more is checked than before.
    says(design, 'a writer this project neither ships nor controls, and it is READ SUCCESSFULLY')
    // §6's substance: WHICH half of the trace was taken, and the refusal to quote the tiers
    // across each other — which is the specific error an earlier draft of that section made.
    says(design, '#259 TOOK THE TILED HALF OF THAT TRACE')
    // §6's stripped-wire figure is the awkward one — the stripped run is CHEAPER in bytes on
    // that camera — so the needle is the sentence carrying the MECHANISM that stops it being
    // read as a counter-example, not the heading above it and not the assurance beside it.
    // An earlier cut pinned "That is not a counter-example to INV-1", which is the assurance;
    // the sentence below is the one that would have to be RIGHT for the assurance to mean
    // anything, and a previous version of it named the wrong pyramid level. If §6 is reworded,
    // this is the line that must survive in substance.
    says(design, 'Neither run fetches a full-resolution tile at all.')
    // …and §2's corrected strip count, which is a number rather than a sentence and is the one
    // needle here that a reader can check against the bytes in a minute.
    says(design, 'of which **nine were consecutive full-width')

    const readme = read('src/viz-core/spatial/fixtures/README.md')
    says(readme, 'TILED 512² at every level')
    says(readme, 'spatial-image-hires-stripped.ome.tif')

    // ── AND AT LEAST ONE NEEDLE PER FILE ANCHORED ON A CHECKABLE PARTICULAR ───────────────
    // Presence-after-normalization cannot tell an assertion from its negation, nor a paragraph
    // whose headline is right and whose specifics are wrong — and that hazard was realized once
    // on this branch: a certified paragraph named a fixture that did not exist. So the files
    // this guard blesses must also NAME THE ARTIFACTS THEY DESCRIBE, and every artifact they
    // name must be on disk.
    const FIXTURE_DIR = path.resolve(PACKAGE_ROOT, 'src/viz-core/spatial/fixtures')
    // The DESIGN DOC is in this loop too, and it is the reason the loop needed widening: this
    // guard blesses it with content needles, and #259 added a paragraph there that names a
    // fixture. A guard that requires two of the three files it certifies to name only real
    // artifacts is a guard with a hole where the third is.
    //
    // ── ONE EXEMPTION, DERIVED FROM AN ARTIFACT RATHER THAN TYPED (#346) ─────────────────
    // #346 committed ONE MEMBER of a multi-file OME-TIFF set, renamed into this directory's
    // scheme, and the three files above have to quote two upstream names it does not cover: the
    // source URL (which ends in the upstream member's own file name) and the SIBLING member the
    // committed document's `<TiffData>` points at. Neither is a claim that this directory holds a
    // file by that name. For the sibling it is the OPPOSITE claim, and it is the whole subject of
    // the fixture: the document describes two files, this directory has one, and `#346 TEST-2`
    // pins that the reader answers the container rather than the document. A guard that required
    // both on disk would be demanding the existence of a file whose ABSENCE is the point.
    //
    // So the exemption is exactly the set of names THE COMMITTED FIXTURE'S OWN OME-XML uses for
    // its members, read out of its bytes. Deriving it means it cannot be widened by typing a name
    // into a list, which is the failure mode an allowlist has; and the two assertions under it —
    // it holds exactly two names, and NEITHER is a file in this directory — mean an entry can
    // never come to cover a real fixture that went missing, which is what this loop is for.
    const upstreamMembers = [
      ...readFileSync(path.join(FIXTURE_DIR, 'bioformats-tubhiswt.ome.tif'))
        .toString('latin1')
        .matchAll(/<UUID FileName="([^"]+)"/g),
    ].map(match => match[1])
    expect(upstreamMembers).toHaveLength(2)
    expect(new Set(upstreamMembers).size).toBe(2)
    for (const name of upstreamMembers) {
      expect([name, existsSync(path.join(FIXTURE_DIR, name))]).toEqual([name, false])
    }
    for (const [where, text] of [
      ['omeTiffPyramid.ts', reader],
      ['fixtures/README.md', readme],
      ['docs/design/ome-tiff-tile-layout.md', design],
    ] as const) {
      for (const named of text.match(/[A-Za-z0-9._-]+\.ome\.tif/g) ?? []) {
        if (upstreamMembers.includes(named)) continue
        expect([where, named, existsSync(path.join(FIXTURE_DIR, named))]).toEqual([
          where,
          named,
          true,
        ])
      }
    }
    // …and the reader really does name the two controls its answer rests on, so the loop above
    // is not vacuous on a file that stopped naming any fixture at all.
    says(reader, 'spatial-image-hires-stripped.ome.tif')
    says(reader, 'tiled-deflate.ome.tif')
  })

  it('THE CONTROL: the same scanner DOES report each retired sentence, and stays quiet on the true ones', () => {
    // Without this, an empty list or a matcher that never fires passes the scan above forever.
    for (const claim of LAYOUT_CLAIMS_RETIRED_BY_227) {
      expect(layoutClaimsIn(`prefix ${claim} suffix`)).toContain(claim)
      // …including LINE-WRAPPED across a comment boundary, which is the shape all of these had:
      // they lived inside `//` blocks in files whose lines are hard-wrapped at 96 columns, so a
      // raw substring scan would have missed most of them. The wrap is exercised at EVERY word
      // boundary rather than the first — a `.replace(' ', …)` replaces only one occurrence, so
      // the earlier version demonstrated the capability at position 1 and nowhere a 96-column
      // wrap would actually land.
      const words = claim.split(' ')
      for (let at = 1; at < words.length; at++) {
        const wrapped = `${words.slice(0, at).join(' ')}\n// ${words.slice(at).join(' ')}`
        expect(layoutClaimsIn(`// ${wrapped}`), `wrapped after word ${at}`).toContain(claim)
      }
    }
    // SPECIFICITY. Each of these states the TRUE, post-#227 version of a retired claim using as
    // many of its words as possible — and, critically, several are correct present-tense
    // sentences ABOUT A STRIPPED LAYOUT, which is what this guard must not forbid.
    const BENIGN = [
      'every image this system currently emits is TILED at 512, and #227 is why',
      'the writer emits TILED OME-TIFFs, so a viewport tile is one ranged read',
      'the corpus keeps a STRIPPED file on purpose — third-party OME-TIFFs routinely are one',
      'spatial-image-hires-stripped.ome.tif is STRIPPED (RowsPerStrip=62, 30 full-width strips)',
      'because the emitted file was STRIPPED, that bound was a full-width band times four',
      'making the bytes tiled was a one-line change to the writer, and #227 made it',
      'the layout the writer no longer emits, kept as the third-party control',
      'on a stripped file `loadOmeTiff` yields a tile edge of 32, which is why we override it',
    ]
    for (const sentence of BENIGN) {
      expect([sentence, layoutClaimsIn(sentence)]).toEqual([sentence, []])
    }
    // …and each entry is a PHRASE rather than a word: three words minimum, the same floor
    // TEST-5's list is held to.
    for (const claim of LAYOUT_CLAIMS_RETIRED_BY_227) {
      expect([claim, claim.trim().split(/\s+/).length >= 3]).toEqual([claim, true])
    }
  })
})

/**
 * Sentences that were TRUE when written and are FALSE since #322, verbatim.
 *
 * #322 committed `third-party-stripped.ome.tif` — a stripped OME-TIFF whose header, IFD, every
 * tag, strip geometry and payloads were laid out by Pillow (specifically by the libtiff it
 * bundles, which is where a compressed write is routed), a writer this project neither ships nor
 * controls — and `loadOmeTiffPyramid` reads it successfully. So every sentence that admits
 * the corpus has no such file, or that files #322 as the open work, is now false.
 *
 * A SEPARATE list from the two above, for the reason stated there: a separate falsification with
 * a separate cause, a separate date and its own control. Merging them would make one liveness
 * bound stand for three guards.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────
 * "#322" is not a retired TOKEN and neither is "vendor". §5, `omeTiffPyramid.ts` and
 * `fixtures/README.md` all still discuss #322 in the present tense, correctly. Each entry below
 * is a sentence that asserts the ABSENCE of a third-party-WRITER file, or that files that
 * absence as untracked work, and none of them is satisfiable by a correct present-tense
 * sentence about either.
 *
 * (When this list was written it also said the three files *"still record that a REAL VENDOR file
 * is absent from the corpus — which remains true"*. That was the half #322 did not close, it was
 * true then, and #346 closed it. The sentences that carried it are now on
 * `CLAIMS_RETIRED_BY_346` below, which is why they are gone from here rather than simply
 * unmentioned.)
 */
const CLAIMS_RETIRED_BY_322: readonly string[] = [
  // §5's and the reader's shared admission. It lived in BOTH, which is why the scan roots matter
  // more than the design doc alone: correcting one and not the other is the likely half-fix.
  'Nothing in the corpus decodes a stripped OME-TIFF from a third party',
  // The sentence that immediately followed it in both files. Kept as its own entry rather than
  // folded into the one above, because they were separated by different words in the two files
  // ("which is the invariant's own stated rationale" in §5, a bare full stop in the reader), so
  // no single superstring covers both occurrences.
  //
  // It carries the PRECEDING clause deliberately. The bare fragment "it does not prove it survives
  // a vendor's" would also forbid a sentence that is TRUE after #322 and that this branch's own
  // docs want to be able to write — "…it does not prove it survives a vendor's OME-XML", the
  // limit the fixture's provenance is explicit about. The clause below is unique to the retired
  // paragraph and appears verbatim in both files it lived in. The BENIGN list exercises exactly
  // that near-miss.
  "CURRENT layout; it does not prove it survives a vendor's",
  // §5's tracking sentences. Both retired: the work is done, and a design doc that still files
  // it as open sends the next reader to look for a fixture that is already committed.
  'Tracked as **#322** rather than left as a paragraph',
  '#322 carries both options',
  // `fixtures/README.md`'s opening claim about the whole directory — false since #322 by
  // construction, and (as that file now records) already false before it.
  'Every one was written by the **shipped** writer',
]

/** Every #322-retired sentence present in `text`, after the same normalization. */
function claims322In(text: string): string[] {
  const normalized = normalizeClaimText(text)
  return CLAIMS_RETIRED_BY_322.filter(claim => normalized.includes(normalizeClaimText(claim)))
}

describe('#322 TEST-4 no retired claim that the corpus lacks a third-party-WRITER file survives', () => {
  it('scans the package, the design docs, the workstore e2e specs AND the producer', () => {
    const offenders: string[] = []
    const scanned: Record<string, number> = {}
    for (const root of [DESIGN_ROOT, WORKSTORE_E2E_ROOT, PRODUCER_ROOT]) {
      expect(existsSync(root)).toBe(true)
    }
    for (const [name, root] of [
      ['package', PACKAGE_ROOT],
      ['design', DESIGN_ROOT],
      ['workstore-e2e', WORKSTORE_E2E_ROOT],
      ['producer', PRODUCER_ROOT],
    ] as const) {
      scanned[name] = 0
      for (const file of walk(root)) {
        // This file is ABOUT the retired sentences and must contain them to match them — the
        // same single exemption #259 TEST-7 takes, and not a hiding place: the control below
        // asserts positively that every entry is individually detectable.
        if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue
        scanned[name]++
        const relative = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/')
        for (const claim of claims322In(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative}: ${JSON.stringify(claim)}`)
        }
      }
    }
    // Per-root floors for the reason #259 TEST-7 states: one combined bound is satisfiable by a
    // single root while another silently walks nothing. Measured on this branch by instrumenting
    // THIS loop — not by counting files, which is where the previous cut of this comment went
    // wrong: it said 693, the raw file count, while `scanned.package` is 692 because the loop
    // skips this file two lines above the counter. The count a floor is set from has to be the
    // count the assertion reads.
    //
    // Real counts here: package 692, design 35, workstore-e2e 10, producer 2. Each floor is set a
    // little UNDER its population rather than at it — 690/692, 33/35, 9/10 — because a floor set
    // at the population reddens a retired-claim tripwire on any legitimate deletion, for a reason
    // that has nothing to do with a retired claim, and a tripwire that cries on unrelated work is
    // one people route around. The exception is `producer`, which is 2 of 2 and stays there: that
    // root is `ome_writer.py` + `spatial_declarations.py`, a set that does not grow or shrink
    // incidentally, and #259 TEST-7 pins it the same way. One or two files of slack cannot hide
    // an emptied walk, which is the only thing these bounds are for.
    // (An earlier cut of this paragraph said the small roots "keep #259 TEST-7's floors". Two of
    // them do — workstore-e2e 9 and producer 2 — and `design` does not: TEST-7's is 30 and this
    // is 33, freshly measured. Quoting a number as inherited when it is not is the same defect
    // the paragraph above it corrects.)
    expect(scanned.package).toBeGreaterThanOrEqual(690)
    expect(scanned.design).toBeGreaterThanOrEqual(33)
    expect(scanned['workstore-e2e']).toBeGreaterThanOrEqual(9)
    expect(scanned.producer).toBeGreaterThanOrEqual(2)
    expect(offenders).toEqual([])
  })

  it('THE CORRECTED RECORD IS PRESENT, not merely the false one absent', () => {
    // Deleting the paragraph is the cheapest way to satisfy an absence scan, and the one it must
    // not accept — the rule this file already applies to #227's and #294's retractions. So each
    // of the three files that carried the false admission must now carry the corrected one, and
    // must NAME the artifact that makes it true. `#259 TEST-7`'s own loop then checks that every
    // `.ome.tif` these files name is really on disk, so "names it" cannot become a phantom.
    const read = (relative: string) =>
      normalizeClaimText(readFileSync(path.resolve(PACKAGE_ROOT, relative), 'utf8'))
    const says = (haystack: string, needle: string) =>
      expect([needle, haystack.includes(normalizeClaimText(needle))]).toEqual([needle, true])

    const design = normalizeClaimText(
      readFileSync(path.resolve(DESIGN_ROOT, 'ome-tiff-tile-layout.md'), 'utf8'),
    )
    const reader = read('src/viz-core/spatial/omeTiffPyramid.ts')
    const readme = read('src/viz-core/spatial/fixtures/README.md')

    for (const [where, text] of [
      ['design §5', design],
      ['omeTiffPyramid.ts', reader],
      ['fixtures/README.md', readme],
    ] as const) {
      expect([where, text.includes('third-party-stripped.ome.tif')]).toEqual([where, true])
    }
    // …and one SUBSTANCE needle per file, not a heading — a heading is exactly what a reworded
    // reversion keeps. Each is the sentence that would have to be RIGHT for the file's claim to
    // mean anything.
    says(design, 'a writer this project neither ships nor controls, and it is READ SUCCESSFULLY')
    says(reader, 'the false branch is now exercised by a foreign layout and not only by an older one of ours')
    // Repointed once already, and the reason is recorded rather than the needle silently moved:
    // an earlier cut pinned "every row of the table below says WHOSE", which was FALSE — only a
    // handful of the twenty-one rows attribute a writer at all — and a guard that requires a false
    // sentence is the failure this file exists to prevent. The README now states the provenance as
    // a measured three-way count, and this is the sentence that carries it.
    says(readme, 'Before #322 there was no file here from a writer outside that library at all')
    // The half #322 did NOT close USED to be required here, in all three files, so the correction
    // could not drift into an overclaim. #346 closed it, so those three needles would now REQUIRE
    // A FALSE SENTENCE — the exact failure this file exists to prevent, arriving through the
    // guard rather than around it. They are retired on `CLAIMS_RETIRED_BY_346`, and #346 TEST-4
    // below carries the positive record that replaces them: each of the three files must now name
    // the artifact that made the admission false, and must still record the narrower limit that
    // is STILL true (this reader parses no OME-XML, and Bio-Formats is not an instrument vendor's
    // own writer).
  })

  it('THE CONTROL: the same scanner DOES report each retired sentence, and stays quiet on the true ones', () => {
    for (const claim of CLAIMS_RETIRED_BY_322) {
      expect(claims322In(`prefix ${claim} suffix`)).toContain(claim)
      // …including LINE-WRAPPED across a comment boundary at EVERY word boundary, which is the
      // shape all of these had: they lived in `//` blocks and markdown hard-wrapped at 96
      // columns, so a raw substring scan would have missed most of them.
      const words = claim.split(' ')
      for (let at = 1; at < words.length; at++) {
        const wrapped = `${words.slice(0, at).join(' ')}\n// ${words.slice(at).join(' ')}`
        expect(claims322In(`// ${wrapped}`), `wrapped after word ${at}`).toContain(claim)
      }
    }
    // SPECIFICITY. Each of these states the TRUE, post-#322 version of a retired claim using as
    // many of its words as possible — and several are correct present-tense sentences about what
    // #322 did NOT close, which this guard must not forbid.
    const BENIGN = [
      'the corpus decodes a stripped OME-TIFF from a third-party writer, and #322 TEST-1 is why',
      'third-party-stripped.ome.tif proves the reader survives a writer we do not control',
      // (Reworded by #346, which made the original — "a real vendor file is still absent from
      // this corpus…" — false. A BENIGN entry has to be a sentence someone could correctly
      // write, and that one no longer is; a control list carrying a false example teaches the
      // wrong sentence. It is still a near-miss for the same retired entries.)
      'a real vendor file was absent from this corpus until #346, and §5 recorded it as the remaining half of #322',
      'it does prove it survives a writer outside this project, which is what the rationale asks',
      '#322 committed the first of the two options; the vendor file is the second',
      'Every one is a REAL WRITER output, and every row of the table below says WHOSE',
      'this loader never parses OME-XML, so no fixture can make a claim about a vendor OME-XML',
      // THE near-miss for the narrowed entry above: true after #322, and one word away from the
      // fragment an unqualified entry would have forbidden.
      "this exercises a foreign tag layout, so it does not prove it survives a vendor's OME-XML",
      // …and a REAL near-miss for the tracking entry, two words away from it: the retired sentence
      // filed #322 as work nobody was assigned, and the true version says it was done. An earlier
      // cut put a sentence here that shared almost no vocabulary with any retired entry and so
      // tested nothing, which is the failure a specificity list has.
      'Tracked as **#322** and delivered rather than left as a paragraph',
      // …and the near-miss for the README's retired opening, likewise one clause away.
      'Every one was written by a real writer, and four of them by the shipped writer',
      // …and the README's real opening, quoted as it is actually written, so the list also
      // exercises the live text rather than only constructed variants. Labelled as DOMINATED:
      // the README is inside the scan two `it` blocks up, so if this sentence tripped a retired
      // entry `expect(offenders).toEqual([])` would already be red. It is here to make the
      // near-misses above legible against the real text, not as an independent check.
      "These are not hand-made TIFFs — every one is some real writer's output",
    ]
    for (const sentence of BENIGN) {
      expect([sentence, claims322In(sentence)]).toEqual([sentence, []])
    }
    // …and each entry is a PHRASE rather than a word: three words minimum, the floor the two
    // sibling lists are held to.
    for (const claim of CLAIMS_RETIRED_BY_322) {
      expect([claim, claim.trim().split(/\s+/).length >= 3]).toEqual([claim, true])
    }
  })
})

/**
 * Sentences that were TRUE when written and are FALSE since #346, verbatim.
 *
 * #346 committed `bioformats-tubhiswt.ome.tif` — upstream's bytes end to end, taken verbatim from
 * the OME sample tree under CC BY 4.0, whose `<OME>` document was written by `OME Bio-Formats
 * 5.2.0-m4` over a real acquisition and carries `<Instrument>`, `<Microscope>`, `<Detector>`,
 * `<Objective>`, `<Plane>`, `DimensionOrder="XYZTC"` and multi-file `<TiffData>`/`<UUID FileName=…>`
 * elements no call site here produces. `loadOmeTiffPyramid` reads it successfully. So every
 * sentence admitting that the corpus holds no permissively-licensed OME sample, or no file whose
 * document this project did not author, is now false.
 *
 * A SEPARATE list from the three above, for the reason each of those states: a separate
 * falsification with a separate cause, a separate date and its own control.
 *
 * ── WHY THESE THREE WERE THE DANGEROUS ONES ───────────────────────────────────────────────
 * They were not merely written down. `#322 TEST-4`'s positive-record block REQUIRED all three,
 * one per file, so that #322's retraction could not drift into an overclaim — a good rule, and it
 * meant that after #346 the guard itself demanded three false sentences. That is this file's own
 * failure mode arriving through the guard rather than around it, so the requirement moves here
 * and inverts: the same three files must now name the artifact that made the admission false, and
 * must STILL carry the narrower limits that remain true.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────
 * Neither "vendor" nor "#346" is a retired token, and neither is *"nothing here parses OME-XML"*.
 * That last one is the sharpest thing to get wrong: it is still TRUE, it is still written in all
 * three files, and #346 does not touch it — the fixture puts a foreign DOCUMENT in the corpus, it
 * does not add a PARSER. `#346 TEST-4`'s positive block requires that limit to survive, and the
 * BENIGN list below exercises the near-misses.
 */
const CLAIMS_RETIRED_BY_346: readonly string[] = [
  // §5's admission, in the paragraph headed "What #322 did NOT close". Short, and specific
  // enough that no true sentence contains it: it asserts the ABSENCE, in the present tense.
  'a REAL VENDOR FILE is still absent',
  // The reader's spelling of the same thing. A separate entry because the two files worded it
  // differently, which is exactly why the scan has more than one root.
  'the corpus still holds no file from a real VENDOR',
  // `fixtures/README.md`'s, carrying its trailing clause: the bare "is still absent" would forbid
  // sentences about other absences this directory legitimately records (there is still no foreign
  // PYRAMID here, and the README says so). The clause is unique to the retired sentence.
  'is still absent from this directory, and §5 records that as the remaining half of #322',
]

/** Every #346-retired sentence present in `text`, after the same normalization. */
function claims346In(text: string): string[] {
  const normalized = normalizeClaimText(text)
  return CLAIMS_RETIRED_BY_346.filter(claim => normalized.includes(normalizeClaimText(claim)))
}

describe('#346 TEST-4 no retired claim that the corpus lacks a foreign-AUTHORED OME-XML survives', () => {
  it('scans the package, the design docs, the workstore e2e specs AND the producer', () => {
    const offenders: string[] = []
    const scanned: Record<string, number> = {}
    for (const root of [DESIGN_ROOT, WORKSTORE_E2E_ROOT, PRODUCER_ROOT]) {
      expect(existsSync(root)).toBe(true)
    }
    for (const [name, root] of [
      ['package', PACKAGE_ROOT],
      ['design', DESIGN_ROOT],
      ['workstore-e2e', WORKSTORE_E2E_ROOT],
      ['producer', PRODUCER_ROOT],
    ] as const) {
      scanned[name] = 0
      for (const file of walk(root)) {
        // This file is ABOUT the retired sentences and must contain them to match them — the
        // same single exemption every sibling block here takes.
        if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue
        scanned[name]++
        const relative = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/')
        for (const claim of claims346In(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative}: ${JSON.stringify(claim)}`)
        }
      }
    }
    // Per-root floors, kept at #322 TEST-4's values rather than re-measured upward. These
    // populations only grow, and a floor pinned at the current count reddens a retired-claim
    // tripwire on any legitimate deletion — for a reason that has nothing to do with a retired
    // claim, which is how a tripwire becomes one people route around.
    expect(scanned.package).toBeGreaterThanOrEqual(690)
    expect(scanned.design).toBeGreaterThanOrEqual(33)
    expect(scanned['workstore-e2e']).toBeGreaterThanOrEqual(9)
    expect(scanned.producer).toBeGreaterThanOrEqual(2)
    expect(offenders).toEqual([])
  })

  it('THE CORRECTED RECORD IS PRESENT, and the STILL-TRUE limits survive with it', () => {
    // Deleting the paragraph is the cheapest way to satisfy an absence scan, and the one this
    // file must not accept. Each of the three files that carried the admission must now name the
    // artifact that makes it false — and `#259 TEST-7`'s own loop then checks that every
    // `.ome.tif` these files name is really on disk, so "names it" cannot become a phantom.
    const read = (relative: string) =>
      normalizeClaimText(readFileSync(path.resolve(PACKAGE_ROOT, relative), 'utf8'))
    const says = (haystack: string, needle: string) =>
      expect([needle, haystack.includes(normalizeClaimText(needle))]).toEqual([needle, true])

    const design = normalizeClaimText(
      readFileSync(path.resolve(DESIGN_ROOT, 'ome-tiff-tile-layout.md'), 'utf8'),
    )
    const reader = read('src/viz-core/spatial/omeTiffPyramid.ts')
    const readme = read('src/viz-core/spatial/fixtures/README.md')

    for (const [where, text] of [
      ['design §5', design],
      ['omeTiffPyramid.ts', reader],
      ['fixtures/README.md', readme],
    ] as const) {
      expect([where, text.includes('bioformats-tubhiswt.ome.tif')]).toEqual([where, true])
      // ── THE LIMIT THAT IS STILL TRUE, REQUIRED IN ALL THREE ─────────────────────────
      // This is the half that stops the correction becoming the overclaim the retired sentences
      // were guarding against. #346 landed a foreign-authored DOCUMENT; it did not land an
      // instrument vendor's own writer, and every one of these files has to keep saying so.
      says(text, "Bio-Formats is the OME reference implementation, not an instrument vendor's own writer")
    }
    // …and one SUBSTANCE needle per file, not a heading — a heading is exactly what a reworded
    // reversion keeps. Each is the sentence that would have to be RIGHT for that file's claim to
    // mean anything.
    says(design, 'AND THE DOCUMENT HALF IS NOW CLOSED TOO')
    says(design, 'Nothing in this repository produced a byte of it')
    says(reader, 'A DOCUMENT NOTHING OF OURS AUTHORED')
    says(reader, 'this reader answers the CONTAINER')
    says(readme, 'Nothing in this repository produced any byte of it')
    // The LICENCE, required in the README by name. A redistributed binary whose licence is not
    // written down is the liability this whole directory's provenance discipline exists to
    // prevent, and it is the one fact about this file that no code can re-derive.
    says(readme, 'Creative Commons Attribution 4.0 International (CC BY 4.0)')
    says(readme, 'Sample OME-TIFF files (c) by the OME Consortium')
    says(readme, 'a1d99f0651baad26a6b5004c115a9c3f4e33d3d6e0b279b34cabbbe88d813ef2')
    // …and the limit that is NOT about vendors and must also survive: there is no OME-XML parser
    // in this reader, so a foreign document proves nothing about parsing one.
    says(reader, 'Nothing here parses OME-XML')
  })

  it('THE CONTROL: the same scanner DOES report each retired sentence, and stays quiet on the true ones', () => {
    for (const claim of CLAIMS_RETIRED_BY_346) {
      expect(claims346In(`prefix ${claim} suffix`)).toContain(claim)
      // …including LINE-WRAPPED across a comment boundary at EVERY word boundary, which is the
      // shape all of these had: they lived in `//` blocks and in markdown hard-wrapped at 96
      // columns, so a raw substring scan would have missed most of them.
      const words = claim.split(' ')
      for (let at = 1; at < words.length; at++) {
        const wrapped = `${words.slice(0, at).join(' ')}\n// ${words.slice(at).join(' ')}`
        expect(claims346In(`// ${wrapped}`), `wrapped after word ${at}`).toContain(claim)
      }
    }
    // SPECIFICITY. Each states the TRUE, post-#346 version of a retired claim using as many of
    // its words as possible — and several are correct present-tense sentences about what #346 did
    // NOT close, which this guard must not forbid. The last three are the ones that carry the
    // work: they are the limits the positive block above REQUIRES, so a guard that forbade them
    // would be unsatisfiable in both directions at once.
    const BENIGN = [
      'a real VENDOR file was absent from this corpus until #346, and bioformats-tubhiswt.ome.tif is what closed it',
      'the corpus holds a file from a writer we do not control whose OME-XML we did not author',
      'a foreign PYRAMID is still absent from this directory, because every candidate is hundreds of megabytes',
      'a file written by an instrument vendor’s OWN OME-TIFF writer is still absent, and the README says what was searched',
      // THE near-misses for the README entry, which is the longest and the most easily
      // over-matched: both name an absence this directory legitimately still records.
      'a foreign pyramid is still absent from this directory, and the README records why',
      'a 10x Xenium morphology TIFF is still absent from this directory, and the licence is why',
      // …and the limits the positive block requires, which must not be forbidden here.
      "Bio-Formats is the OME reference implementation, not an instrument vendor's own writer",
      'Nothing here parses OME-XML, so no fixture can make a claim about how a vendor document would be PARSED',
      'this reader answers the CONTAINER, because the document and the container disagree',
    ]
    for (const sentence of BENIGN) {
      expect([sentence, claims346In(sentence)]).toEqual([sentence, []])
    }
    // …and each entry is a PHRASE rather than a word: three words minimum, the floor every
    // sibling list here is held to.
    for (const claim of CLAIMS_RETIRED_BY_346) {
      expect([claim, claim.trim().split(/\s+/).length >= 3]).toEqual([claim, true])
    }
  })
})

describe('TEST-5 [acceptance] [invariant: INV-4] no retired claim about the shipped Visium image survives in @ziee/viz', () => {
  it('scans the whole package and reports every offender by file and sentence', () => {
    const offenders: string[] = []
    const scanned: Record<string, number> = {}
    // REQUIRED, not `existsSync ? … : []`. An optional root reproduces exactly the failure the
    // `PACKAGE_ROOT` note above says a tripwire cannot afford: pointing `DESIGN_ROOT` at a
    // directory that does not exist left all five tests green, because the package's own file
    // count already satisfied a single combined liveness bound. Each root is counted on its own.
    expect(existsSync(DESIGN_ROOT)).toBe(true)
    for (const [name, root] of [
      ['package', PACKAGE_ROOT],
      ['design', DESIGN_ROOT],
    ] as const) {
      scanned[name] = 0
      for (const file of walk(root)) {
        const relative = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/')
        if (EXEMPT.includes(relative)) continue
        scanned[name]++
        for (const claim of claimsIn(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative}: ${JSON.stringify(claim)}`)
        }
      }
    }

    // Each scan has to have SEEN something. A walk that silently returned nothing — a wrong
    // root, a bad extension set, a `readdirSync` throw swallowed somewhere — would report zero
    // offenders forever, which is the failure mode a guard like this dies of.
    expect(scanned.package).toBeGreaterThan(100)
    expect(scanned.design).toBeGreaterThan(10)

    expect(offenders).toEqual([])
  })

  it('THE CONTROL: the same scanner DOES report a retired sentence', () => {
    // Without this, an empty `FALSIFIED_CLAIMS`, a broken normalizer or a matcher that never
    // fires all pass the assertion above, permanently and silently. This is the negative
    // control the visium guard's own docstring says a tripwire needs.
    const planted =
      'the shipped vendor `tissue_hires_image.png` is 200x200, i.e. a 1000-px full-res frame'
    expect(claimsIn(planted)).toEqual(['`tissue_hires_image.png` is 200x200'])
    // …and every entry is individually detectable.
    for (const claim of FALSIFIED_CLAIMS) {
      expect(claimsIn(`prefix ${claim} suffix`)).toContain(claim)
    }

    // SPECIFICITY, which the round-trip above does not show. An earlier attempt paired it with
    // "drop the claim's last word and it must stop matching" and called that a specificity
    // proof; it is a tautology — a shorter string is not a superstring of a longer one, so it
    // holds for `'is a'` as readily as for a real sentence. What actually distinguishes a
    // retired sentence from a fragment is that it does NOT fire on ordinary prose about the
    // same subject, so that is what is asserted.
    //
    // WRITTEN for this test, not quoted from the tree — an earlier version of this note claimed
    // they were "drawn from the very files this scan walks", and only one is even a paraphrase
    // of one. They are adversarial paraphrases: each states the TRUE, post-#243 version of a
    // retired claim, using as many of its words as possible.
    const BENIGN = [
      'the shipped vendor tissue_hires_image.png is 2000x2000 and all 160 spots land on it',
      'a real tissue image and its real spots are geometrically coherent, and #243 made them so',
      'the image covers the spots it is supposed to sit under',
      'this fixture exists to drive the plumbing over real ragged shapes',
      'the committed artifact in this repo is 10x Genomics own emission for the same bundle',
      // A hyphenated compound, so the corpus exercises the character the retired `-`
      // alternative used to collapse. Kept TRUE about the tree, unlike an earlier version of
      // this entry, which invented a 200x200-tile file with spots — a fabricated statement about
      // a real fixture, inside the suite whose whole subject is claim hygiene.
      'the samples-per-pixel-5 fixture is a 300x200 two-level file with five samples per pixel',
      // …and near-misses for the three entries the corpus did not otherwise come near. A
      // corpus that covers six of nine entries is not "each entry is checked".
      // NOT 'every spot maps INSIDE the 2000x2000 frame': that changes both the polarity word
      // AND the distinctive literal, so it shares no substring with the entry it is supposed to
      // guard and the fragment mutations `the 200x200 frame` / `maps outside the 200x200` both
      // stayed green under it. A near-miss has to keep the literals and move the MEANING.
      'no spot maps outside the 200x200 frame any more, and #243 is why',
      'all of its spots land on its own image, which is what test_image_coherence.py asserts',
      'The RAW vendor fixture PNG is 2000x2000 and is 10x Genomics own emission',
    ]
    for (const sentence of BENIGN) {
      expect([sentence, claimsIn(sentence)]).toEqual([sentence, []])
    }
    // …and each entry is a PHRASE rather than a word: three words minimum. Three and not four
    // because the shortest inherited entry — `shipped 200x200 vendor`, copied verbatim from
    // `spatial-import-visium`'s list so the two stay comparable — is exactly three, and it
    // carries a distinctive literal (`200x200`) that the corpus above exercises.
    for (const claim of FALSIFIED_CLAIMS) {
      expect([claim, claim.trim().split(/\s+/).length >= 3]).toEqual([claim, true])
    }
  })

  it('THE SECOND CONTROL: it catches the LINE-WRAPPED spelling a raw substring scan misses', () => {
    // This is the exact shape #294's instance had — the sentence split across a newline and a
    // `//` prefix. `spatial-import-visium`'s guard matches raw substrings, so it would report
    // NOTHING here even if its root could see this package; that gap is why this guard
    // normalizes, and this control is what would go red if the normalization were removed.
    const wrapped = [
      '// convenience — the shipped vendor `tissue_hires_image.png` is 200x200, i.e. a 1000-px full-res',
      "// frame, while the vendor's own positions run to x<=6911, y<=8668, so *\"the image does not even",
      '// cover the spots it is supposed to sit under"*.',
    ].join('\n')

    // The raw scan the other package performs: it finds the unwrapped sentence and MISSES the
    // wrapped one. Asserted, so the claim about the gap is demonstrated rather than believed.
    const rawHits = FALSIFIED_CLAIMS.filter(claim => wrapped.includes(claim))
    expect(rawHits).toEqual(['`tissue_hires_image.png` is 200x200'])

    // This guard finds both.
    expect(claimsIn(wrapped).sort()).toEqual(
      [
        '`tissue_hires_image.png` is 200x200',
        'the image does not even cover the spots it is supposed to sit under',
      ].sort(),
    )
  })

  it('THE FOURTH CONTROL: it catches a PYTHON-comment wrapping, which is why `#` is stripped', () => {
    // `#` is in the alternation because the scan walks `.py` files — the visium package's own
    // guard lives in one — and a retired sentence wrapped across a Python comment is exactly the
    // shape this normalizer exists for. Without this case `#` was IDLE by the same measurement
    // that condemned `-`: removing it left every test in this file green. The difference between
    // the two is that `#` is a comment marker in a language this scan reads and `-` is not, and
    // an argument like that has to be paid for with a control rather than with prose.
    const pythonComment = [
      '# the shipped vendor `tissue_hires_image.png` is 200x200, i.e. a 1000-px full-res',
      "# frame, while the vendor's own positions run to x<=6911 — so the image does not even",
      '# cover the spots it is supposed to sit under.',
    ].join('\n')

    const rawHits = FALSIFIED_CLAIMS.filter(claim => pythonComment.includes(claim))
    expect(rawHits).toEqual(['`tissue_hires_image.png` is 200x200'])

    expect(claimsIn(pythonComment).sort()).toEqual(
      [
        '`tissue_hires_image.png` is 200x200',
        'the image does not even cover the spots it is supposed to sit under',
      ].sort(),
    )
  })

  it('THE THIRD CONTROL: it catches the MARKDOWN spelling — a blockquote, wrapped', () => {
    // The scan root now includes `docs/design`, whose files are `.md`, and the normalizer was
    // written for `//` comments. A retired sentence quoted in a markdown BLOCKQUOTE is wrapped
    // across `>` prefixes, which the first version of the normalizer did not strip — so the
    // widened root would have walked those files and seen nothing, which is worse than not
    // widening it at all. This is the case that would go red if `>` came back out of the regex.
    const blockquote = [
      '> the shipped vendor `tissue_hires_image.png` is 200x200 […] There is NO committed',
      '> artifact in this repo where a real tissue image and its real spots are',
      '> geometrically coherent.',
    ].join('\n')

    const rawHits = FALSIFIED_CLAIMS.filter(claim => blockquote.includes(claim))
    expect(rawHits).toEqual(['`tissue_hires_image.png` is 200x200'])

    expect(claimsIn(blockquote).sort()).toEqual(
      [
        '`tissue_hires_image.png` is 200x200',
        'There is NO committed artifact in this repo where a real tissue image and its real spots are geometrically coherent',
      ].sort(),
    )

    // A markdown LIST item is the other wrapping this root introduces, and it needs NO extra
    // rule: the marker is leading, so the claim substring begins after it and the pre-existing
    // newline/whitespace collapse already joins the wrap. That is why the `-` alternative this
    // guard briefly carried was idle, and why it is gone.
    const listItem = '- There is NO committed artifact in this repo where a real tissue\n  image and its real spots are geometrically coherent.'
    expect(claimsIn(listItem)).toContain(
      'There is NO committed artifact in this repo where a real tissue image and its real spots are geometrically coherent',
    )
    // …and a hyphenated compound is NOT collapsed, so the guard cannot fire across one.
    expect(normalizeClaimText('samples-per-pixel-5')).toBe('samples-per-pixel-5')
  })
})

describe('TEST-11 the corrected record is present, not merely the false one absent', () => {
  const read = (relative: string): string =>
    readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')

  it('#294 — the overlay suite retracts the claim, names the coherent fixture, and keeps its reasons', () => {
    // An ABSENCE guard goes green on a file that deleted the paragraph. What #294 asks for is a
    // corrected RECORD: the retraction, the artifact that falsified it, and the reasons the
    // oracle is still the marker. Each is asserted separately so deleting any one goes red.
    const text = normalizeClaimText(read('src/viz-core/spatial/spotOverlayRegistration.test.ts'))

    expect(text).toContain('is no longer true')
    expect(text).toContain('tissue_hires_image.png')
    expect(text).toContain('2000x2000')
    expect(text).toContain("all 160 of the bundle's spots land on it")
    expect(text).toContain('test_image_coherence.py')
    expect(text).toContain('test_registration_qc.py')
    // The two surviving reasons, and the retracted one named as retracted. The first was
    // `toContain('square')`, which is far too weak — the word appears repeatedly in that file's
    // own prose, so it would have survived the reason being deleted.
    expect(text).toContain('The coherent vendor image is SQUARE (2000x2000); this fixture is 1400x1800')
    expect(text).toContain('The marker is EXACT; a tissue score is statistical')
    expect(text).toContain('What did NOT survive')
  })

  it('#294 — the DESIGN document frames the retired sentences as retracted, not as current', () => {
    // The other exempt file. It quotes the retired sentences, so the scan cannot judge it —
    // and for one round it was exempted under a comment claiming TEST-11 asserted something
    // about it, which TEST-11 did not do at all. It does now: the quotes must sit inside §7's
    // retraction, with the artifact that falsified them named.
    const text = normalizeClaimText(
      readFileSync(
        path.join(PACKAGE_ROOT, '../../../docs/design/ome-tiff-reader-sample-counts.md'),
        'utf8',
      ),
    )
    // Asserted through the SAME normalizer the scan uses, so `#` (a markdown heading marker
    // and a comment prefix) is already stripped — hence `243` rather than `#243`.
    expect(text).toContain('243 falsified that')
    expect(text).toContain('2000x2000')
    expect(text).toContain('all 160 spots land on it')
    expect(text).toContain('test_image_coherence.py')
    // …and the section that carries them is the one that says WHY it is quoting them.
    expect(text).toContain('The prose half')
  })

  it('#288 — the reader no longer asserts a property of the writer it cannot check', () => {
    const source = read('src/viz-core/spatial/omeTiffPyramid.ts')
    const text = normalizeClaimText(source)

    // The retired sentence, which was TRUE when written and whose BASIS #266 replaced. It is
    // still IN the file, and must be — that is how the correction records what it retracts. So
    // the guard is not absence but CONTEXT: every occurrence must sit inside the retraction,
    // i.e. be introduced by "This block used to end:". Restored as a live assertion, it would
    // appear somewhere else and this goes red.
    const retired =
      'Every image this system EMITS is a single plane (interleaved RGB or one greyscale ' +
      'sample), so this refusal names a raw vendor file reaching the reader, not one of our ' +
      'artifacts.'
    const occurrences: number[] = []
    for (let at = text.indexOf(retired); at !== -1; at = text.indexOf(retired, at + 1)) {
      occurrences.push(at)
    }
    expect(occurrences).toHaveLength(1)
    expect(text.slice(Math.max(0, occurrences[0] - 60), occurrences[0])).toContain(
      'This block used to end',
    )
    expect(text).toContain('That was a claim about the WRITER')
    expect(text).toContain('READABLE_SAMPLE_COUNTS')

    // …and it records the #266 disposition, which is the ordering the whole two-issue sequence
    // rests on: the reader is taught FIRST, and lifting the writer's refusal is a separate
    // change. A reader that silently lifted it would leave this sentence false.
    expect(text).toContain("The writer's refusal is NOT lifted")
  })

  it('#334 — THIS file, the third exempt one, describes the surviving copies as the allowlist has them', () => {
    // The `EXEMPT` docstring above states the rule — "Every exempt file gets a positive assertion
    // in TEST-11, and that is what makes an exemption something other than a hiding place" — and
    // until #334 this file, the first entry in that list, was the one exempt file with none. That
    // is not a cosmetic gap: `CORRECTED_BY_259`'s docstring told the reader how many copies of the
    // sentence survive and where, in a hand-written count, and it went false the moment #321/#333
    // landed and stayed false, in the one file in this repo whose entire job is catching a
    // sentence that a later change falsified. Nothing could have caught it: the scan skips this
    // file by path, and #321's whole-tree guard
    // (`spatial-types/tests/test_wire_measurement_strip_count.py`) walks only `src-app/packages/`.
    //
    // So the count is not maintained by hand any more, and this is what replaces it. The paragraph
    // is checked against `CORRECTED_BY_259_ALLOWED` — the list the scan and the "must still
    // contain" loop already pin in both directions — so the prose can only describe the set of
    // surviving copies that is actually enforced.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Only the docstring, NOT the whole file: the allowlist's own array literal names the same
    // path a few lines below it, and a `toContain` over the whole source would be satisfied by
    // that literal no matter what the prose said. Sliced, both operands are independent.
    const declaredAt = self.search(/const CORRECTED_BY_259 = '/)
    expect(declaredAt).toBeGreaterThan(0)
    const docstring = normalizeClaimText(self.slice(self.lastIndexOf('/**', declaredAt), declaredAt))

    // POSITIVE, and derived rather than typed: every path the allowlist holds must be NAMED in the
    // paragraph. Add an entry without rewriting the prose and this fails and says which path the
    // paragraph does not mention — where the copy is, not merely that the number moved.
    expect(CORRECTED_BY_259_ALLOWED.length).toBeGreaterThan(0)
    for (const relative of CORRECTED_BY_259_ALLOWED) {
      const named = relative.replace(/^(?:\.\.\/)+/, '')
      expect(
        [named, docstring.includes(named)],
        `CORRECTED_BY_259's docstring does not name ${named}, which CORRECTED_BY_259_ALLOWED holds`,
      ).toEqual([named, true])
    }

    // …and the one word in that paragraph that IS a count is tied to the list's length, so the two
    // cannot drift apart silently — which is the whole of #334 in one assertion.
    expect([
      'says "ONLY copy" (singular)',
      docstring.includes('the ONLY copy left outside this file'),
    ]).toEqual(['says "ONLY copy" (singular)', CORRECTED_BY_259_ALLOWED.length === 1])

    // NEGATIVE: the exact sentences #334 was filed for, which were true until #321/#333 landed.
    // Kept verbatim so a revert of that paragraph — or a copy-paste of it from the history — is
    // reported by name rather than merely leaving the positive checks above still passing.
    const retired = [
      'Six copies of the sentence exist.',
      'Five are under `src-app/packages/`',
      'and are filed as **#321**',
    ]
    expect(retired.filter(phrase => docstring.includes(normalizeClaimText(phrase)))).toEqual([])

    // The pointer to the guard that owns the rest of the tree must survive too. Without it the
    // paragraph would once again be the only account of `src-app/packages/` a reader has, and the
    // temptation to write a number back into it is exactly how #334 happened.
    expect(docstring).toContain('test_wire_measurement_strip_count.py')
  })
})
