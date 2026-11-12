#!/usr/bin/env node
/**
 * PRODUCER-MAGNITUDE GATE — `libs/viz`'s quoted producer magnitudes are BOUND to the
 * producer that makes them, BY DERIVATION.
 *
 * ── The bug this exists to stop (#277) ─────────────────────────────────────────
 * `src-app/libs/viz/src/viz-core/spatial/*` explains its placement invariants with a
 * worked example taken from the Visium importer's real output: the space's
 * `microns_per_pixel`, the emitted image's own OME `PhysicalSizeX` /
 * `original_resolution_um`, and the `to_space[0]` that is the ratio of the other two.
 * Those numbers are DERIVED, in `src-app/packages/spatial-import-visium`, from constants
 * that live there. Nothing connected the two trees.
 *
 * So when #222 changed the micron-scale numerator from the CAPTURE spot diameter to the
 * RENDERED spot diameter, eight sites in `libs/viz` kept quoting the old magnitudes as
 * current and every gate stayed green. #258 repaired those eight by hand — the SECOND
 * such repair — and could not stop a third, because the magnitudes live in PROSE, which
 * no gate reads, and the committed fixtures are frozen pre-#222 output, so the tests
 * agreed with the fixtures while the fixtures disagreed with the importer.
 *
 * A worked example with wrong numbers teaches the wrong invariant, and it presents as
 * measured fact from a real bundle — the kind of claim that gets trusted without
 * re-derivation.
 *
 * ── Why this is not a prose lint ───────────────────────────────────────────────
 * #277 rules out "pattern-match a micron magnitude in a comment": that catches the
 * spelling it was written for and nothing else. This gate never guesses what a sentence
 * MEANS. It derives three things and compares them:
 *
 *   LIVE    what the producer derives TODAY — obtained by EXECUTING it (rule D1)
 *   FROZEN  what the committed fixture actually CONTAINS — read from its bytes (rule D2)
 *   QUOTED  what `viz-core/spatial` says, at sites that SAY WHICH of the two they claim
 *
 * `docs/design/derived-guards.md` §2 is the rule being followed: a guard derives the set
 * it ranges over from the declaration that defines that set. §4 is the shape: *"The repair
 * is not to raise the number. It is to assert the relation."* #258 raised the numbers.
 * This asserts the relation, so the next producer-side change reports itself.
 *
 * ── The rules (all fail-closed, all with positive counts) ──────────────────────
 *  D1 LIVE      the expected CURRENT magnitudes are produced by RUNNING the producer.
 *               NOTHING about the scale rule is restated here — not the constant, not the
 *               vendor-image list, and NOT WHICH CONSTANT THE PRODUCER USES: the numerator
 *               symbol is read out of the producer's own `micron_scale(...)` CALL SITE by
 *               parsing its AST. That last part is load-bearing and was got wrong first
 *               time: #222 WAS a change of which symbol that call site passes, so a guard
 *               that names the post-#222 answer is vacuously green against a re-run of the
 *               very defect it exists to catch.
 *  D2 FROZEN    the expected FROZEN magnitudes are read from the committed fixture's own
 *               BYTES: the emitted manifest (parsed) and the OME-XML `PhysicalSize{X,Y}`
 *               inside each `*.ome.tif`. The `.ome.tif` half is the gap
 *               `fixtures/README.md` named as open in #277 and this closes it.
 *  D3 CLAIMED   a site that quotes a magnitude declares WHICH claim it makes, with
 *               `[producer-magnitude: <id>]` or `[frozen-magnitude: <id>]`. A tag governs a
 *               SCOPE — its own line through the line before the next tag, bounded by the
 *               paragraph — and the value must be rendered INSIDE that scope, to at least
 *               the precision the value itself needs (below). Scope, not paragraph: with a
 *               whole-paragraph rule the check degenerates to "this block mentions both
 *               eras' numbers somewhere", which is invariant under SWAPPING which sentence
 *               claims which — and a stale-era claim presented as current is the defect.
 *  D4 SWEPT     every numeric literal that renders a known magnitude (LIVE ∪ FROZEN, both
 *               derived) to >= MIN_SWEEP_SIG_DIGITS significant digits MUST fall in the
 *               scope of a tag for that side and id. An uncovered one is a HARD FAILURE.
 *               This is what stops D3's marker from being a dodge: declining to tag is
 *               itself the failure, so a new quoted magnitude cannot enter untagged.
 *  D5 NAMED     a line naming one of the producer's short-valued quantities — its
 *               `VISIUM_*_UM` constants AND every key of the vendor bundle it read, both READ
 *               OFF the producer, never listed — and STATING A VALUE must sit in a scope
 *               tagged for that name, carrying its CURRENT value. These carry too few
 *               significant digits for D4's sweep to see without matching every small integer
 *               in the tree, so their NAME is what binds them. Matching is word-boundaried;
 *               a sentence that mentions a name without stating a value at the precision that
 *               value needs is left alone — there is nothing there to be wrong.
 *  D6 FLOORS    committed minimum counts on the derived quantity sets, the tagged-site
 *               populations and the TAGGED-file count, each set AT the current population.
 *               Adding a site only moves the real number up, so an addition needs no edit
 *               here; REMOVING one fails. That ratchet is what makes D4 un-dodgeable from
 *               the other direction: you cannot delete a tag and rewrite the number.
 *               `python3` absent, a non-zero driver, an unreadable file and an unresolvable
 *               package are HARD FAILURES, never a skip. §3: "A skip is a skip, never a pass."
 *  D7 ADRIFT    inside a tagged COMMENT BLOCK, a FRACTIONAL literal of >= MIN_ADRIFT_SIG_DIGITS
 *               significant digits that renders NEITHER a live nor a frozen value is a
 *               magnitude that has come adrift from both sides. D4 cannot see this: it only
 *               fires on a literal that still MATCHES something, which a rotted one does not.
 *
 * ── Why a MARKER, and what it costs (the decision, stated) ─────────────────────
 * Some viz sites legitimately quote the OLD numbers and must keep quoting them: the
 * committed fixtures are frozen pre-#222 output under #222's fix-forward-only ruling, and
 * a site saying "on this exact image" stays factually correct forever. Only the generic
 * "what the importer derives today" claims track the producer. Three ways to tell them
 * apart were considered:
 *   1. infer from the PROSE ("today", "TODAY") — this is the unbounded-evasion text lint
 *      #277 rejects, and a rewording silently re-classifies the site;
 *   2. infer from the VALUE (in the fixture => frozen) — CIRCULAR: a drifted current
 *      claim quotes exactly the frozen value, so this rule classifies every instance of
 *      the defect as correct;
 *   3. require the site to SAY which claim it makes, and then verify that claim against
 *      the corresponding source.
 * (3) is what is implemented. Its cost is real and is not hidden: every new site quoting a
 * producer magnitude must carry a tag (D4 makes that mandatory rather than polite), the tag
 * must sit immediately above the sentence it vouches for (D3's scope rule), and a
 * genuinely-current claim MIS-tagged as frozen is checked against the fixture — which reds
 * wherever the two eras disagree, and is harmless where they agree. Neither tag is a pass:
 * both are verified against bytes the author does not control.
 *
 * ── Thresholds, and why each is where it is (all measured on this tree) ────────
 * MIN_CLAIM_SIG_DIGITS (D3) — a claim must be rendered to 4 significant digits, or to the
 * value's OWN precision where that is lower (an affine scale and a spot diameter are exactly
 * one and two digits, and demanding four of them would be unsatisfiable). Without the floor,
 * an incidental coarse ROUNDING elsewhere in the scope vouches for a precise quote: a
 * three-digit "Nx error if composed" aside satisfied the tag on a five-digit pitch beside it,
 * so corrupting that pitch passed green. This file states no magnitude of its own — that is
 * asserted by its test, and it is why these sentences describe digit counts rather than
 * values.
 * MIN_SWEEP_SIG_DIGITS (D4) — 5. At 4, ordinary numbers collide with derived values
 * (12.45, 16.67, 14.72, 3.736 are all correct 4-digit roundings of one), and a gate that
 * demands a tag on "the tile cache holds 12.45 MB" is a gate people switch off. At 5 the
 * collision surface is an order of magnitude smaller. The residue is stated below.
 * MIN_ADRIFT_SIG_DIGITS (D7) — 3, and ONLY inside a COMMENT BLOCK that carries a magnitude
 * tag. The restriction is what makes any threshold usable at all: tree-wide, a test asserting a
 * full-precision expected double (a coordinate, a tolerance, `Math.PI`) has nothing to do with
 * microns and reddens. The unit is the comment BLOCK rather than the tag's scope because
 * deleting a tag line and leaving a bare `//` in its place split the paragraph, and the
 * falsified sentence then sat in no scope at all while the floors were repaid elsewhere. The threshold started at 10 and
 * came down after a blind angle showed the 5-to-9-digit band was open in the direction that
 * matters most: D3 passes if ANY literal in scope renders the value, so where a scope carries
 * both a short prose form and the full-precision one, an ELEVEN PERCENT error in the short one
 * was green while a 0.02% typo was caught — sensitivity inverted. 6 is measured: this tree is
 * green at 6, and at 5 exactly two legitimate five-digit ratios red (a composed-error ratio and
 * a wrong composed placement) plus the percentage #222 moved the scale by. All three were
 * MAGNITUDES the gate simply had not derived yet — the trap's own composed placement, and the
 * constant-ratio shift — so they are derived now and checked like anything else, and the
 * threshold is **3**: the precision at which the shortest prose rendering in this tree is
 * written. The one remaining non-magnitude in a claim paragraph was a test perturbation factor,
 * and it was moved to its own paragraph, which is what it always should have been.
 *
 * ── What is NOT checked (stated so it is not mistaken for covered) ─────────────
 * A magnitude written in WORDS, or quoted at fewer than MIN_SWEEP_SIG_DIGITS significant
 * digits with no bindable name on the line, is invisible to D4.
 *
 * ONE-SIGNIFICANT-DIGIT QUANTITIES, and the substitution limit on the floors. Three quantities
 * here have a single significant digit: the two vendor scalefactors and the affine scale
 * `to_space[0]` (which is the one number #222 did NOT move). Nothing can bind them tightly:
 * D4's sweep cannot see two digits without matching every small integer in the tree, and D5's
 * name-binding cannot either, because with a one-digit value EVERY digit on the line counts as
 * stating it — binding them reddened sixteen sentences of correct relation prose
 * ("`to_space[0]` is `1/tissue_hires_scalef`" states no value at all) against four real
 * bindings. So they are checked only where they sit inside a scope tagged for them.
 *
 * That has a consequence for the floors, and it is stated rather than implied. A tag over such
 * a quantity is satisfied by any stray digit, so it is FREE TO MINT — which is why the floors
 * count only a tag whose SCOPE STATES the value to two or more significant digits (a property
 * of the claim, never of the value: testing the value made a floor unsatisfiable the moment a
 * producer constant became a round number). The cost of that choice
 * is the mirror image: deleting a one-digit quantity's tag AND falsifying what it claimed does
 * not move any floor. The floors detect NET LOSS of discriminating coverage; they do not detect
 * SUBSTITUTION within the non-discriminating part. Closing that would need a committed per-file
 * tag inventory, which is an enumeration §5 rules out and which would be lowered as paperwork
 * the first time prose was rewritten.
 *
 * Everything DERIVED from these three is checked, because those results carry enough digits for
 * D4, D7 and D8 to see.
 *
 * A micron quantity in the prose that COINCIDENTALLY equals one of the producer's spot
 * diameters will be asked for a tag it does not deserve — the unit-binding rule cannot tell
 * "the 55 um capture footprint" from an unrelated 55 um measurement. Measured on this tree the
 * population is zero, and the failure names the literal and the constant it matched, so it is a
 * visible, self-explaining minute rather than a silent wrong answer.
 *
 * A number that coincidentally renders a derived value at exactly 5 significant digits will
 * be asked for a tag it does not deserve. The failure names the literal and the value it
 * matched, so it is a visible, self-explaining thirty seconds — not a silent wrong answer.
 *
 * A brand-new, WRONG, UNTAGGED magnitude that matches nothing on either side. D4 needs a
 * match and D7 needs a scope. That is a number nobody asked for rather than a claim that
 * has rotted, and it is a different property from the one #277 is about.
 *
 * Anything outside the scanned tree. The scan is rooted at `@txresbench/viz`'s
 * `src/viz-core/spatial`, which is where every such quote lives today (verified by grep
 * over the whole package). D6's file floor makes a silently-empty scan impossible.
 *
 * Usage:
 *   node scripts/check-viz-producer-magnitudes.mjs             # gate; non-zero on any failure
 *   node scripts/check-viz-producer-magnitudes.mjs --list      # derive + report, assert nothing
 *   node scripts/check-viz-producer-magnitudes.mjs --json      # machine-readable (implies --list)
 *   node scripts/check-viz-producer-magnitudes.mjs --repo DIR  # run against another tree
 *                                                              # (the negative-control harness)
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── D6: the committed floors ─────────────────────────────────────────────────
// Each is set AT the current population, which is the ratchet §4 prescribes: adding a site
// only moves the real number up and needs no edit here, removing one fails. A floor set at
// a fraction of the population detects only total collapse, which is the one failure nobody
// commits. Lowering one is the non-repair `derived-guards.md` §5 names by name, and is why
// these are constants in a byte-pinned file rather than anything an operator can set.
const MIN_LIVE_QUANTITIES = 13
const MIN_FROZEN_QUANTITIES = 13
const MIN_PRODUCER_SITES = 41
const MIN_FROZEN_SITES = 30
/**
 * PER-QUANTITY floors — how many discriminating sites currently claim each derived id.
 *
 * The aggregate site floors above are payable: any TRUE statement can be tagged, so padding
 * one quantity buys the deletion of another's tag and the number it was checking. Demonstrated,
 * not feared — delete a frozen scope's tags, rewrite its magnitudes to nonsense, and add two
 * tags over a correctly-stated pitch elsewhere, and the totals came back to green.
 *
 * WHEN ONE OF THESE FIRES ON CORRECT WORK (a prose consolidation, a module merge), the
 * procedure is: run `node scripts/check-viz-producer-magnitudes.mjs --json` and read the new
 * census out of `sites`, change the number in the SAME commit as the prose change so the two
 * are reviewed together, and re-pin with `scripts/check-guard-integrity.sh --update`. What §5
 * forbids is lowering a floor to make an unrelated branch green; adjusting one alongside the
 * edit that legitimately moved it is the floor working.
 *
 * These are floors over a DERIVED set, which §2 blesses, not an enumeration of instances: the
 * IDS come from the producer and the fixture, an id gaining sites needs no edit here (a floor
 * is a minimum), and an id NOT listed is simply unfloored rather than forbidden. What they
 * refuse is a quantity's coverage dropping while another's rises to hide it.
 */
const PER_ID_FLOORS = {
  'frozen:microns_per_pixel': 10,
  'frozen:spatial-image-hires.PhysicalSizeX': 5,
  'frozen:spatial-image-hires.PhysicalSizeY': 1,
  'frozen:spatial-image-hires.affine_over_pitch': 1,
  'frozen:spatial-image-hires.composed_pitch_over_affine': 2,
  'frozen:spatial-image-hires.original_resolution_um': 7,
  'frozen:spatial-image-hires.to_space[0]': 1,
  'frozen:spatial-image-lowres.PhysicalSizeX': 1,
  'frozen:spatial-image-lowres.PhysicalSizeY': 1,
  'frozen:spatial-image-lowres.original_resolution_um': 1,
  'producer:VISIUM_CAPTURE_SPOT_DIAMETER_UM': 9,
  'producer:VISIUM_RENDERED_SPOT_DIAMETER_UM': 9,
  'producer:microns_per_pixel': 9,
  'producer:spatial-image-hires.original_resolution_um': 7,
  'producer:spatial-image-hires.to_space[0]': 1,
  'producer:spatial-image-lowres.original_resolution_um': 1,
  'producer:spot_diameter_fullres': 5,
}
/** Files that CARRY a tag. Not the raw file count: that is not derived from any declaration
 *  and shrinks legitimately when a source file is merged or removed. */
const MIN_TAGGED_FILES = 8
/** D3 — see "Thresholds" above. */
const MIN_CLAIM_SIG_DIGITS = 4
/** D4 — see "Thresholds" above. */
const MIN_SWEEP_SIG_DIGITS = 5
/** D7 — see "Thresholds" above. */
const MIN_ADRIFT_SIG_DIGITS = 3
/**
 * D8 — how close a literal must be to a claimed magnitude before it is read as a corrupted
 * copy of it rather than an unrelated number. 2% is measured on this tree in both directions:
 * every corruption of a quoted digit lands inside it (a single digit changed in the fourth or
 * fifth place moves a value by well under 1%), and every legitimate neighbour inside a tagged
 * scope is far outside it — the nearest is 4%.
 */
const NEAR_MISS_TOLERANCE = 0.02
/**
 * D5 — how far after a name its stated value may sit. Every assignment spelling in this tree
 * (`= n`, `: n`, `(n)`, `is n`, `is now n`, `-> n`, `equals n`) lands within a dozen
 * characters; a sentence that names one quantity while stating a different one puts its number
 * much further along. Measured: at this window the real tree has zero D5 findings, and every
 * connective an earlier allowlist missed is caught.
 */
const NAME_VALUE_WINDOW = 12
/**
 * A number stated as a micron quantity. Both mu spellings and both cases: `µ` (U+00B5 MICRO
 * SIGN) is what a keyboard produces, `μ` (U+03BC GREEK SMALL LETTER MU) is what most papers and
 * copy-paste produce, and they are visually identical — matching only the first meant the same
 * sentence was guarded or unguarded depending on which key had been pressed.
 */
const MICRON_QUANTITY_RE =
  /(?<![\w$#§])([+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?|(?<![\d.])\.\d[\d_]*))\s*(?:[µμ]m|[uU][mM])\b/g

/**
 * The producer this gate binds `viz` to, by PACKAGE ID — the id the package tree itself
 * uses. This is an anchor, not an enumeration: everything ranged over (the constants, the
 * numerator, the vendor images, the bundle inputs, the quantities, the claim sites) is
 * derived FROM it. An absent package, or an absent compute module inside it, is a hard
 * failure rather than an empty pass.
 */
const PRODUCER_PACKAGE = 'spatial-import-visium'
const PRODUCER_MODULE = 'import_visium'
/** The workspace whose prose is bound, by npm package NAME — resolved through the root
 *  `workspaces` globs, so a rename or a move fails loudly instead of scanning nothing. */
const SUBJECT_WORKSPACE = '@txresbench/viz'
/** The subtree of that workspace the claims live in. */
const SUBJECT_SUBDIR = 'src/viz-core/spatial'
/** Text the scan reads. Emitted artifacts (`*.json`, `*.ome.tif`) are DELIBERATELY not
 *  scanned: they are the fixture that D2 reads AS the source of truth, and demanding a tag
 *  inside producer output would be asking the producer to annotate itself. */
const SCANNED_EXT = new Set(['.ts', '.tsx', '.md'])
const SKIP_WALK = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.turbo', '.git'])

/**
 * A tag. The id must START WITH A LETTER, which is not decoration: documentation about this
 * mechanism writes `[producer-magnitude: ...]` with an ellipsis placeholder, and an id
 * pattern that accepted `...` would parse those sentences as real tags and fail on them.
 */
const TAG_SRC = String.raw`\[(producer|frozen)-magnitude:\s*([A-Za-z][A-Za-z0-9_.\-[\]]*)\]`
/**
 * NEVER share one `/g` instance across calls. `RegExp.prototype.test` ADVANCES `lastIndex` on
 * a global regex, and `matchAll` copies `lastIndex` from the source regex into its clone — so
 * a `test()` used to find tag lines left the index mid-string and the following `matchAll`
 * started past the tag it had just found. A tag on a paragraph's LAST content line therefore
 * produced an EMPTY tag list: the scope still existed (so it still bounded its neighbour) but
 * nothing was checked, nothing was reported, and the floor did not count it — a silent skip
 * that was self-consistent and thus invisible. Whether a claim was checked depended on whether
 * a sentence happened to follow it.
 */
const tagRe = () => new RegExp(TAG_SRC, 'g')

/**
 * A numeric literal, WITH its sign and exponent.
 *
 * Both parts were absent first time and both were exploitable. Without the sign, NEGATING a
 * quoted magnitude — an arithmetically false statement — still read as the correct value and
 * passed. Without the exponent, the same value written in exponent notation split into a
 * long mantissa matching nothing plus a stray exponent digit, so writing the RIGHT number in
 * the wrong notation reddened the gate.
 *
 * A LEADING-DOT mantissa counts. Without it `.7471` produced no token at all, so a scope
 * claiming the current producer could state the FROZEN value in that spelling and every rule —
 * the sweep, the adrift rules, the era rule that exists for exactly this — looked straight past
 * it. The lookbehind still rejects a preceding word char, `$` or `#`, and a preceding digit or
 * dot, so identifiers, version strings, dotted paths and issue numbers are not sliced up. `§`
 * joins that set: a design-section citation (`§12.2`, `§4`) is written constantly in this
 * codebase and is not a measurement of anything.
 */
const NUMBER_RE =
  /(?<![\w$#§])[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?|(?<![\d.])\.\d[\d_]*)(?:[eE][+-]?\d+)?/g
/** Numeric separators are legal TS and are used in this very tree (`120_000`). Without them a
 *  magnitude spelled `0.882_980_256_697_303_4` tokenized into fragments and matched nothing —
 *  invisible to every rule. Strip them before any numeric or precision judgement. */
const bare = lit => String(lit).replace(/_/g, '')

/**
 * Write and THEN exit. `console.log`/`console.error` to a PIPE are asynchronous in Node, and
 * `process.exit()` does not flush them — measured here, not feared: piping `--json` to a
 * parser truncated the output mid-token, so a machine consumer of this gate silently got a
 * malformed document. Everything this file emits goes through these two, which write
 * synchronously to the fd before any exit.
 */
const out = text => writeSync(1, text.endsWith('\n') ? text : text + '\n')
const err = text => writeSync(2, text.endsWith('\n') ? text : text + '\n')

const failures = []
const fail = (id, msg) => failures.push(`${id}: ${msg}`)

// ── argv ─────────────────────────────────────────────────────────────────────
// An unknown flag is FATAL, and so is a flag with a missing value. `just check-coercion
// --report` taught this repo that a caller flag a gate silently ignores turns the gate into
// a green no-op; `--repo` with nothing after it silently meaning "the current directory" is
// the same class one step down.
let REPO = path.resolve(HERE, '..')
let mode = 'gate'
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') mode = mode === 'json' ? 'json' : 'list'
    else if (a === '--json') mode = 'json'
    else if (a === '--repo') {
      if (i + 1 >= argv.length) die('`--repo` requires a directory argument.')
      REPO = path.resolve(argv[++i])
      if (!existsSync(REPO)) die(`--repo ${REPO} does not exist`)
      if (!statSync(REPO).isDirectory()) die(`--repo ${REPO} is not a directory`)
    } else die(`unknown flag \`${a}\`. Supported: --list, --json, --repo <dir>.`)
  }
}

function die(msg) {
  err(`check-viz-producer-magnitudes FAIL — ${msg}`)
  process.exit(1)
}

const rel = p => path.relative(REPO, p).split(path.sep).join('/')

function readText(p, what, encoding = 'utf8') {
  try {
    return readFileSync(p, encoding)
  } catch (e) {
    die(`could not read ${what} at ${rel(p)}: ${e.code ?? e.message}`)
  }
}

// ── significant-figure rendering ─────────────────────────────────────────────
// A site quotes a five-digit form of a value whose full precision is seventeen digits, and
// the five-digit form is ROUNDED, not a prefix — prefix matching would therefore miss the
// real prose. `renders()` asks the only meaningful question: "is this literal what you get
// when you write that value to this many significant digits?" (No example is spelled out
// here: this file states no magnitude of its own, and its test asserts that.)
function sigDigits(lit) {
  let s = bare(lit).replace(/^[+-]/, '').split(/[eE]/)[0]
  if (s.includes('.')) {
    // trailing zeros AFTER a decimal point are significant; leading ones never are
    s = s.replace('.', '').replace(/^0+/, '')
  } else {
    // a bare integer's trailing zeros are NOT significant: `1000` claims one digit, not
    // four, and treating it as four made `renders('1000', 1000.4)` true
    s = s.replace(/^0+/, '').replace(/0+$/, '')
  }
  return Math.min(Math.max(s.length, 1), 21)
}
function renders(lit, value) {
  if (!Number.isFinite(value)) return false
  const n = Number(bare(lit))
  if (!Number.isFinite(n)) return false
  return Number(Number(value).toPrecision(sigDigits(lit))) === n
}
/** The shortest round-tripping decimal for a double — how many digits the value ACTUALLY
 *  has, as opposed to how many a quote of it might carry. */
function exactSigDigits(value) {
  return sigDigits(String(Math.abs(value)))
}
/**
 * How precisely a claim must be written to count as stating this value. `MIN_CLAIM_SIG_DIGITS`
 * normally, but never more than the value itself has: `to_space[0]` is exactly 5 and a spot
 * diameter is exactly 65, and demanding four digits of a one- or two-digit number would make
 * the rule unsatisfiable for the quantities #222 did NOT move.
 */
function requiredPrecision(value) {
  return Math.min(MIN_CLAIM_SIG_DIGITS, exactSigDigits(value))
}

// ── P1-shape workspace resolution: read the ROOT declaration npm itself resolves ──
function resolveSubjectDir() {
  const rootPkgPath = path.join(REPO, 'package.json')
  if (!existsSync(rootPkgPath)) die(`no root package.json at ${rootPkgPath}`)
  let rootPkg
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
  } catch (e) {
    die(`root package.json is not parseable JSON: ${e.message}`)
  }
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages
  if (!Array.isArray(patterns) || patterns.length === 0) {
    die('the root package.json declares no `workspaces`; this gate would be vacuous.')
  }
  const dirs = []
  for (const pattern of patterns) {
    if (!pattern.includes('*')) { dirs.push(path.join(REPO, pattern)); continue }
    if (!/^[^*]+\/\*$/.test(pattern)) {
      die(
        `workspace pattern \`${pattern}\` is not one this gate understands (a literal path, ` +
          `or a single trailing \`/*\`). Teach this resolver rather than let the subject ` +
          `workspace drop out of the gate unnoticed.`,
      )
    }
    const parent = path.join(REPO, pattern.slice(0, -2))
    if (!existsSync(parent)) continue
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') dirs.push(path.join(parent, e.name))
    }
  }
  for (const d of dirs) {
    const pj = path.join(d, 'package.json')
    if (!existsSync(pj)) continue
    try {
      if (JSON.parse(readFileSync(pj, 'utf8')).name === SUBJECT_WORKSPACE) return d
    } catch { /* a workspace with an unreadable package.json is not the subject */ }
  }
  die(
    `no workspace named \`${SUBJECT_WORKSPACE}\` under the root \`workspaces\` globs ` +
      `(${patterns.join(', ')}). It was renamed, moved, or dropped — this gate covers ` +
      `nothing until that is resolved.`,
  )
}

// ── D1: EXECUTE the producer ─────────────────────────────────────────────────
// The driver is EMBEDDED rather than shipped as `scripts/lib/*.py` on purpose:
// `check-guard-integrity.sh`'s GUARD_GLOBS pins `scripts/check-*.mjs` and `scripts/lib/*.sh`
// but not `*.py`, so a separate driver could be rewritten to return anything with every gate
// green. Embedded, it is covered by this file's own pin.
const DRIVER = String.raw`
import ast, importlib.util, json, sys, tempfile
from pathlib import Path

pkgs = Path(sys.argv[1])
producer_pkg, producer_mod = sys.argv[2], sys.argv[3]

def bail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(3)

src = pkgs / producer_pkg / "compute" / (producer_mod + ".py")
if not src.is_file():
    bail("no producer module at %s" % src)

# The same sys.path the package tree's own conftest builds, plus every package's compute
# dir. The PRODUCER's own compute dir is inserted LAST so it lands FIRST: several packages
# ship a byte-identical ome_writer.py, and with plain insertion order the alphabetically
# later package won and the affine came from a package this gate does not claim to bind.
for p in (pkgs / "_lib", pkgs / "_helpers"):
    if p.is_dir():
        sys.path.insert(0, str(p))
for d in sorted(pkgs.glob("*/compute")):
    sys.path.insert(0, str(d))
sys.path.insert(0, str(src.parent))

source_text = src.read_text()

# WHICH CONSTANT DOES THE PRODUCER ACTUALLY USE?
#
# Read it off the producer's own call site instead of naming it here. #222 was precisely a
# change of the symbol passed to micron_scale(rendered_spot_diameter_um=...), so a guard
# that hardcodes the post-#222 answer is green against a re-run of the defect it exists to
# catch. Zero call sites or more than one is FATAL: an ambiguous derivation is not one.
#
# TWO SHAPES, because #257 changed the producer's. Before it, the call site passed a bare
# NAME and reading that name WAS the derivation. After it, the numerator is selected per
# bundle from the producer's own slide-design table, so the call site passes an EXPRESSION and
# there is no single symbol to read. Both are handled, and neither is named here:
#
#   NAME       -> that symbol is the numerator (the pre-#257 shape, and still the shape a
#                 re-run of #222 at the call site would produce, which is why this path stays)
#   EXPRESSION -> the numerator is whatever the producer SELECTS for the committed fixture,
#                 obtained below by calling the producer's own selector on that fixture's own
#                 scalefactors and mapping the result back to a VISIUM_*_UM constant.
#
# The second path is strictly stronger than the first: it reads the value the producer
# ACTUALLY APPLIES rather than the name it happens to spell. What it must not become is a
# guess, so a value matching no named constant — or more than one — is fatal, exactly as an
# ambiguous call site is.
tree = ast.parse(source_text, str(src))

# WHICH LOCAL NAMES ARE BOUND FROM slide_design(...)? Collected first, because the ONLY
# expression shape accepted below is a subscript of such a name. Anything else at that call
# site stays fatal, exactly as it was before #257 widened this.
selector_bound = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
        f = node.value.func
        if (f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)) == "slide_design":
            for t in node.targets:
                if isinstance(t, ast.Name):
                    selector_bound.add(t.id)

numerator_names = []
numerator_is_selected = False
unrecognised = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Call):
        continue
    fn = node.func
    name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
    if name != "micron_scale":
        continue
    for kw in node.keywords:
        if kw.arg != "rendered_spot_diameter_um":
            continue
        if isinstance(kw.value, ast.Name):
            numerator_names.append(kw.value.id)
            continue
        # THE ONE ACCEPTED EXPRESSION, MATCHED EXACTLY: <x>["rendered_spot_diameter_um"]
        # where <x> was bound from a slide_design(...) call in this module.
        #
        # This narrowness is the whole repair. An earlier cut accepted ANY non-Name
        # expression and then derived the numerator by calling slide_design() — which
        # inverted this gate's own invariant, because the derivation was never checked
        # against what the call site DOES. A blind audit proved it: a call site reading
        # design[...] if design["id"].endswith("65um-rendered-spot") else
        # VISIUM_CAPTURE_SPOT_DIAMETER_UM applies #222's exact defect to every CytAssist
        # bundle, and the gate exited 0 printing numerator: VISIUM_RENDERED_SPOT_DIAMETER_UM.
        # The committed bundle is a 65 um design, so no run this gate performs can see the
        # divergence — only the SHAPE can. So the shape is what is checked, and every other
        # shape is fatal, which is what it was before.
        v = kw.value
        if (isinstance(v, ast.Subscript) and isinstance(v.value, ast.Name)
                and v.value.id in selector_bound
                and isinstance(getattr(v, "slice", None), ast.Constant)
                and v.slice.value == "rendered_spot_diameter_um"):
            numerator_is_selected = True
        else:
            unrecognised.append(ast.dump(v)[:160])
if unrecognised:
    bail("the producer's micron_scale(rendered_spot_diameter_um=...) call site passes an "
         "expression this gate does not recognise (%s). It accepts a bare NAME, or a "
         "subscript of a name bound from slide_design(...) — and nothing else, because "
         "anything else can choose a different numerator per bundle in a way no run this "
         "gate performs would reveal." % "; ".join(unrecognised))
numerator_names = sorted(set(numerator_names))
if len(numerator_names) > 1 or (numerator_names and numerator_is_selected):
    bail("expected exactly one symbol passed as micron_scale(rendered_spot_diameter_um=...) "
         "in %s, found %d (%s)%s. The numerator must be READ from the producer, never named "
         "here." % (src.name, len(numerator_names), ", ".join(numerator_names) or "none",
                    " plus a per-bundle selection" if numerator_is_selected else ""))
if not numerator_names and not numerator_is_selected:
    bail("expected exactly one symbol passed as micron_scale(rendered_spot_diameter_um=...) "
         "in %s, found 0 (none). The numerator must be READ from the producer, never named "
         "here." % src.name)
numerator_name = numerator_names[0] if numerator_names else None

# COMPILE FROM SOURCE, never from __pycache__. Measured, not hypothesised: a stale .pyc
# beside this module made the derivation report the PREVIOUS value of the numerator while
# the source on disk already carried the new one -- exactly the silent staleness this gate
# exists to detect, reproduced inside the detector. The caller additionally runs python -B
# with a fresh PYTHONPYCACHEPREFIX so the producer's DEPENDENCIES cannot be served stale
# bytecode either.
spec = importlib.util.spec_from_file_location(producer_mod, src)
mod = importlib.util.module_from_spec(spec)
sys.modules[producer_mod] = mod
try:
    exec(compile(source_text, str(src), "exec"), mod.__dict__)
except Exception as e:
    bail("producer module did not import: %s: %s" % (type(e).__name__, e))

import ome_writer
if Path(ome_writer.__file__).resolve().parent != src.parent.resolve():
    bail("ome_writer resolved to %s, which is not the producer package's own copy (%s)."
         % (ome_writer.__file__, src.parent))

sys.path.insert(0, str(pkgs / producer_pkg / "tests"))
try:
    import visium_fixtures as VF
except Exception as e:
    bail("the producer package's own run harness (tests/visium_fixtures.py) did not import: "
         "%s: %s. This gate derives from a REAL run of the importer; without the harness it "
         "would have to restate the producer's arithmetic, which is the defect it exists to "
         "stop." % (type(e).__name__, e))

basename = getattr(mod, "SCALEFACTORS_BASENAME", None)
if not basename:
    bail("producer declares no SCALEFACTORS_BASENAME")
# WHICH committed bundle? THE ONE THE HARNESS RUNS, asked of the harness (VF.FIXTURE)
# rather than taken as the first hit of an rglob over tests/fixtures.
#
# That rglob was unambiguous while the package committed ONE bundle and became a silent
# lottery the moment #257 committed two more: it sorted cytassist-v4-outs ahead of
# visium-outs and this gate started deriving "the producer's numbers" from a bundle it
# never runs. Naming visium-outs here would be the enumeration derived-guards.md §2
# forbids; asking the harness is the derivation. More than one hit under that root is fatal
# for the original reason: an ambiguous derivation is not one.
fixture_root = getattr(VF, "FIXTURE", None)
if fixture_root is None:
    bail("the producer's run harness declares no FIXTURE root, so this gate cannot tell "
         "WHICH committed bundle it is about to run over.")
found = sorted(Path(fixture_root).rglob(basename))
if not found:
    # SAME WORDING AS BEFORE for the empty case. This bail used to range over the whole
    # tests/fixtures tree and read "no <basename> under <package>/tests/fixtures"; narrowing
    # the search to the harness's own bundle must not also rename the abort, because a
    # documented fail-closed path is driven BY ITS OWN MESSAGE and renaming it silently
    # decouples the driver from the thing it drives.
    bail("no %s under the harness's own bundle root %s" % (basename, fixture_root))
if len(found) > 1:
    bail("expected exactly one %s under the harness's own bundle root %s, found %d (%s)."
         % (basename, fixture_root, len(found), ", ".join(str(f) for f in found)))
committed = json.loads(found[0].read_text())

constants = {n: float(getattr(mod, n)) for n in dir(mod)
             if n.startswith("VISIUM_") and n.endswith("_UM")
             and isinstance(getattr(mod, n), (int, float))}
if numerator_is_selected:
    # THE PER-BUNDLE SHAPE (#257). Ask the producer which numerator IT would apply to the
    # very fixture this gate then runs it over, using the producer's own selector — nothing
    # about how that selection works is restated here, which is the same rule the AST path
    # follows one level up.
    selector = getattr(mod, "slide_design", None)
    if selector is None:
        bail("the producer's micron_scale call site selects its numerator per bundle, but the "
             "module declares no slide_design() to ask. This gate derives the numerator from "
             "the producer; without a selector it would have to name one.")
    try:
        selected = float(selector(committed)["rendered_spot_diameter_um"])
    except Exception as e:
        bail("the producer's slide_design() did not resolve a numerator for the committed "
             "fixture: %s: %s" % (type(e).__name__, e))
    matches = sorted(n for n, v in constants.items() if v == selected)
    if len(matches) != 1:
        bail("the producer selects a %.6g um numerator for its own committed fixture, which "
             "maps to %d VISIUM_*_UM constants (%s). An ambiguous derivation is not one."
             % (selected, len(matches), ", ".join(matches) or "none"))
    numerator_name = matches[0]
elif numerator_name not in constants:
    bail("the producer's micron_scale call site passes %s, which is not a VISIUM_*_UM "
         "constant of that module" % numerator_name)

# ── RUN THE PRODUCER, END TO END, AND READ WHAT IT EMITS ─────────────────────────────
#
# This is the whole point and an earlier cut got it wrong: it re-CALLED micron_scale() with
# arguments of its own and then restated emit_images' pitch rule as mpp/scalef. Everything
# the producer does downstream of that one helper was therefore unverified -- a blind angle
# doubled microns_per_pixel inside run_import, and doubled the emitted pitch inside
# emit_images, and the gate stayed green both times while every viz claim became false.
#
# So: drive the shipped run_import over the producer's OWN complete test bundle, through the
# producer package's OWN harness (the same visium_fixtures.make_imaged/run_over that the
# package's suite uses, and that produced viz's committed fixtures), and read the magnitudes
# off the manifest entries the importer actually writes. Nothing about the scale rule, the
# pitch rule or the affine is restated here any more.
# The importer writes a real bundle and a real output tree. Both are OURS to remove: nothing
# did, on success or on any bail, and each gate invocation left ~4 directories behind. The
# suite invokes the gate dozens of times, so this filled /tmp. A bail raises SystemExit, which
# an atexit handler still runs, so the cleanup is registered before anything can exit.
import atexit, shutil
bundle_root = Path(tempfile.mkdtemp(prefix="viz-producer-magnitudes-bundle-"))
out_root = Path(tempfile.mkdtemp(prefix="viz-producer-magnitudes-out-"))
atexit.register(shutil.rmtree, str(bundle_root), True)
atexit.register(shutil.rmtree, str(out_root), True)
try:
    bundle = VF.make_imaged(bundle_root)
    _module, entries = VF.run_over(bundle, out_root)
except Exception as e:
    bail("the shipped importer failed over its own test bundle: %s: %s"
         % (type(e).__name__, e))

# The harness copies the committed vendor bundle; assert that, so a change to ITS defaults
# cannot silently move what this gate calls "the producer's numbers".
run_scalefactors = json.loads((Path(bundle) / "spatial" / basename).read_text())
for key, value in committed.items():
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if run_scalefactors.get(key) != value:
            bail("the run bundle's %s is %r but the committed vendor bundle declares %r; the "
                 "harness is no longer running over the committed inputs, so its output is "
                 "not what this gate claims it is." % (key, run_scalefactors.get(key), value))

inputs = {k: float(v) for k, v in run_scalefactors.items()
          if isinstance(v, (int, float)) and not isinstance(v, bool)}

quantities = {}
space_scale = None
scale_source = None

# TWO PASSES, deliberately. The space scale is the premise of everything below, so it is
# established (or refused) BEFORE any image blob is read. With it discovered inside the image
# loop, a bundle that yields no scale at all aborted on a downstream symptom -- "the emitted
# image declares no PhysicalSize" -- which is true but is not the reason, and left the abort
# that names the reason unreachable.
for e in entries:
    meta = e.get("meta") or {}
    if meta.get("microns_per_pixel_source"):
        scale_source = meta["microns_per_pixel_source"]
    if isinstance(meta.get("microns_per_pixel"), (int, float)):
        if space_scale is not None and space_scale != meta["microns_per_pixel"]:
            bail("the importer emitted two different microns_per_pixel values for one space "
                 "(%r and %r)" % (space_scale, meta["microns_per_pixel"]))
        space_scale = float(meta["microns_per_pixel"])
if space_scale is None:
    bail("the importer emitted no microns_per_pixel over its own bundle (scale source: %r). "
         "Every magnitude this gate compares is denominated in that scale, so there is nothing "
         "to derive." % scale_source)

# MOVED HERE, BELOW the checks about the MAIN run. This loop is a cross-check on the
# producer's internal consistency across designs; every abort above it is about the one run
# every magnitude in this gate is derived from. Sitting above them, its own bail pre-empted
# them — measured twice: first the magnitude comparison (five tests), then
# "the importer emitted no microns_per_pixel over its own bundle", whose driver in TEST-30
# started receiving this loop's message instead of the one it names. Ordering IS the contract
# here: a gate's aborts are driven by their own messages, so an abort that can fire earlier
# than a documented one silently retires it.

# ── THE NUMERATOR CHECK THAT ACTUALLY BINDS: RUN EVERY COMMITTED DESIGN ─────────────
#
# Everything above about the call site is SYNTAX, and syntax cannot decide this. Two blind
# audits proved it in succession. The first defeated a wide AST branch by making the call site
# an IfExp. The second defeated the narrowed branch — accept only
# <x>["rendered_spot_diameter_um"] where <x> is bound from slide_design(...) — by moving
# the divergence ONE STATEMENT EARLIER:
#
#     design = slide_design(scalefactors)
#     if not str(design.get("id", "")).endswith("65um-rendered-spot"):
#         design = dict(design, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM)
#
# The call-site expression is byte-identical, the gate exited 0 reporting
# numerator: VISIUM_RENDERED_SPOT_DIAMETER_UM, and the producer applied 55 um — #222's exact
# defect — to every CytAssist and every 11 mm bundle. A name-based check has no
# reaching-definition analysis, so the binding that LICENSES the call site need not be the
# binding it READS; and dead code elsewhere in the module licenses it just as well.
#
# The reason neither audit's counter-example was visible is the same both times: this gate ran
# the producer over ONE bundle, and that bundle is the 65 um design, where every wrong branch
# happens to agree with the right one.
#
# So the gate runs EVERY design the producer declares — the package now commits one bundle per
# row of SLIDE_DESIGNS — and checks, for each, that the numerator the producer ACTUALLY
# APPLIED (recovered from the emitted artifact as microns_per_pixel * spot_diameter_fullres,
# which is by construction what it divided by) is the one its own selector says that bundle
# should get. That is D1's own rule — "obtained by EXECUTING it" — applied to the question the
# syntax check was standing in for. Every counter-example above reds against it: the re-bind,
# the dead-code licence, the aliased name, two call sites with different numerators, and a
# plain revert of #222 at the call site.
#
# The shape check above is kept as a cheap first filter and is NOT claimed to be sufficient.
committed_bundles = getattr(VF, "COMMITTED_BUNDLES", None)
if not committed_bundles:
    bail("the producer's run harness declares no COMMITTED_BUNDLES, so this gate cannot run "
         "the producer over every slide design it ships — and one bundle cannot distinguish "
         "a correct numerator from one that is only correct for that bundle.")
declared_designs = {d["id"] for d in getattr(mod, "SLIDE_DESIGNS", []) or []}
covered = set()
# COLLECTED, NOT BAILED ON. Bailing here aborts the DERIVATION, which pre-empts the magnitude
# comparison the whole gate exists for — measured: a plain producer-constant change started
# failing with "the table and the committed evidence disagree" instead of naming the viz site
# that now quotes a stale number, and five tests that drive those aborts BY THEIR OWN MESSAGE
# went red. Both properties are real and both must hold, so these are reported as DATA and
# checked on the JS side AFTER the magnitudes, where they cannot mask the primary failure.
design_numerator_problems = []
for bundle_root, design_id, expected_um in committed_bundles:
    per_out = Path(tempfile.mkdtemp(prefix="viz-producer-magnitudes-design-"))
    atexit.register(shutil.rmtree, str(per_out), True)
    try:
        entries_d = mod.run_import(Path(bundle_root), per_out)
        mod.write_manifest(per_out, entries_d)
        report_d = json.loads((per_out / "visium-import-report.json").read_text())
    except Exception as e:
        bail("the shipped importer failed over its own committed bundle %s: %s: %s"
             % (Path(bundle_root).name, type(e).__name__, e))
    # THE DIVISOR COMES FROM THE BUNDLE ON DISK, NOT FROM THE REPORT. report["scalefactors"]
    # is the producer's own copy of its own input, written by the producer — so recovering the
    # numerator from it is not "by construction what it divided by", as an earlier comment
    # here claimed. A blind audit proved the difference: a producer that applies the capture
    # diameter on non-65um designs AND scales both diameters in the report it writes by
    # design_um/55 leaves the fiducial/spot ratio unchanged (so slide_design still resolves
    # the same design) and makes the recovered numerator come out exactly right — gate exit 0,
    # real CytAssist V4 at 0.21474 instead of 0.27331. The package's own test reads the
    # diameter off disk; the gate was strictly weaker than the test it backstops.
    on_disk = json.loads((Path(bundle_root) / "spatial" / basename).read_text())
    mpp_d = report_d.get("microns_per_pixel")
    spot_d = on_disk.get("spot_diameter_fullres")
    if not (isinstance(mpp_d, (int, float)) and isinstance(spot_d, (int, float)) and spot_d):
        bail("%s emitted no usable microns_per_pixel, or its committed scalefactors carry no "
             "spot_diameter_fullres, so the numerator it applied cannot be recovered."
             % Path(bundle_root).name)
    applied_um = float(mpp_d) * float(spot_d)
    selected = mod.slide_design(on_disk)
    selected_um = float(selected["rendered_spot_diameter_um"])
    if abs(applied_um - selected_um) / selected_um > 1e-9:
        design_numerator_problems.append(
            "on %s the producer APPLIED a %.6g um numerator but its own slide_design() "
            "selects %.6g um (%s). The call site is not using the number the selector "
            "chooses — which is what this gate exists to detect and what no single-bundle "
            "run can see." % (Path(bundle_root).name, applied_um, selected_um,
                              selected.get("id")))
    # …AND AGAINST THE HARNESS'S OWN COMMITTED EVIDENCE. Without it the comparison above is
    # slide_design() against itself: a blind audit changed the 70um row of SLIDE_DESIGNS to
    # the capture diameter and the gate stayed green while every real CytAssist bundle got
    # 55 um. The value was already being unpacked from the tuple and thrown away.
    #
    # HONEST ABOUT WHAT THIS IS WORTH: COMMITTED_BUNDLES lives in the producer package's own
    # tests/visium_fixtures.py, so it is a SECOND declaration, not an independent one — a
    # change that moves SLIDE_DESIGNS and COMMITTED_BUNDLES together defeats it, and
    # scripts/guard-hashes.txt covers only scripts/. What it buys is that the two must be
    # moved together, and PROVENANCE.json's measured figures (pinned at 1e-9 against the
    # shipped estimator) are the third place that would then disagree. An earlier version of
    # this comment called it "the one number the producer does not control", which overstated
    # it; a blind audit said so.
    if abs(applied_um - float(expected_um)) / float(expected_um) > 1e-9:
        design_numerator_problems.append(
            "on %s the producer APPLIED a %.6g um numerator, but the harness commits that "
            "bundle as evidence for %.6g um. The producer's table and the committed evidence "
            "disagree, and the table is the half that can be edited."
            % (Path(bundle_root).name, applied_um, float(expected_um)))
    if selected.get("id") != design_id:
        design_numerator_problems.append(
            "%s is committed as evidence for %s but the producer's selector resolves it to "
            "%s." % (Path(bundle_root).name, design_id, selected.get("id")))
    covered.add(design_id)
if declared_designs and declared_designs - covered:
    design_numerator_problems.append(
        "the producer declares slide design(s) with no committed bundle to run them over: "
        "%s. A design this gate cannot execute is a numerator it cannot check."
        % ", ".join(sorted(declared_designs - covered)))

# ── WHICH ENTRIES CARRY AN OME PITCH? DERIVED, NEVER NAMED (#303) ────────────────────
#
# This selector used to compare e.get("datatype") against a spatial kind id written out as a
# LITERAL here, and that single literal was a real defect, not a lint technicality: it made a
# domain kind id part of an app-core surface, so adding or renaming a spatial kind would have
# cost an edit to this script. (The id is deliberately not spelled even in this comment — the
# invariant is about who may MENTION a kind, and a guard's own prose is not exempt.) That
# is precisely the coupling spatial-types' own acceptance test forbids
# (test_a_new_kind_costs_zero_core_code, INV-1 "a new kind is DATA"), and it is the failure
# class derived-guards.md §1 tabulates for check-kinds-zero-core.sh — a guard that names
# the instances it knows about instead of deriving them. §5 forbids the enumerating repair by
# name, so the id is NOT allowlisted anywhere; it is gone.
#
# The declaration is the one derived-guards.md §2 names for datatypes and the one
# check-derived-vocabulary.sh already reads: every contributes.datatypes[] in every
# src-app/packages/*/manifest.yaml. The predicate is the SHAPE THIS LOOP ACTUALLY REQUIRES,
# read off that declaration rather than assumed:
#
#   layout.kind == opaque_as_is  the entry is a byte blob with no member structure, so its
#                                content is read from the file rather than from a store
#   format      == ome-tiff      those bytes carry the OME-XML block whose PhysicalSize{X,Y}
#                                is the pitch this loop parses out below
#   file_layout == single        ONE blob at e["path"], which is the only thing the read
#                                below can open — a manifest file_layout has no single path
#
# That is the guard naming the BYTE FORMAT it knows how to parse, which it legitimately owns
# (it parses OME-XML twenty lines from here), instead of naming WHICH DOMAIN KIND is stored
# that way, which it must not. A kind renamed, or a second raster kind contributed tomorrow,
# is covered with ZERO edits to this file.
#
# SAID PRECISELY, because "covered" undersells it: membership in this set is not passive.
# Every selected entry is HARD-CHECKED below for a path, a readable blob, an <OME> block, a
# single PhysicalSizeX/Y and an isotropic pitch -- all of which the FROZEN half treats as
# optional. On today's tree the DECLARED set has two members and the EMITTED set has the
# same two entries the enumerating selector had, so nothing changes; but the day a producer
# emits a second declared raster kind WITHOUT an OME pitch, this gate reds on it. That is
# the correct default for a gate whose whole subject is emitted pitches, and it is stated
# here so it is a decision rather than a surprise. Note which way that cuts: if a
# declaration claims this shape for something the producer does NOT emit as one, this gate
# reds -- and the repair belongs in the declaration or the producer, not in this script's
# subject set. (Not "never touch this script" in the absolute: the format-spelling limit
# below is a case where the right repair is upstream of both.)
#
# STATED LIMITS, and they are limits rather than gaps (derived-guards.md section 7's
# convention is to record what is still enumerated, not to leave the list tidy):
#   * The zero-edit guarantee is conditional on the format SPELLING. storage.format is a
#     free String with no core enum and no validation, so a future raster kind declaring
#     ome-tiff-pyramidal or image/tiff would be silently absent from this set -- and
#     silently, because raster_ids stays non-empty while a sibling still spells it this
#     way, so neither abort below nor the D6 floors fire. Repairing that needs a declared
#     format vocabulary in the core, which is a separate decision with its own scope.
#   * PRODUCER_PACKAGE is still an enumerated instance -- a package NAME, typed into an
#     app-core script. It predates this and it is defensible (this gate is scoped to ONE
#     producer by construction, #277), but it is not derived, so it is recorded rather than
#     left tidy. PER_ID_FLOORS is NOT in this list: its own docblock above already settles
#     that a floor over a derived set is what section 2 blesses, and that reading stands.
#   * Recorded HERE, where the next reader of this guard will find it -- not folded into
#     derived-guards.md section 7's registry, which is a shared document this branch does
#     not touch. The two are not the same record; that fold is follow-up work.
#
# And if the declaration moves out from under the derivation, every step below is
# fail-closed (§3: "A skip is a skip, never a pass"), with D6's MIN_LIVE_QUANTITIES floor as
# the companion §2 prescribes for a derived set.
try:
    import yaml
except Exception as e:
    bail("PyYAML is not importable (%s: %s), so the datatype declarations this gate derives "
         "its subject set from cannot be read. That is a HARD FAILURE, never a skip: without "
         "them this gate would have to name a domain kind, which is the defect #303 removed."
         % (type(e).__name__, e))

OPAQUE_LAYOUT_KIND, OME_TIFF_FORMAT, SINGLE_FILE_LAYOUT = "opaque_as_is", "ome-tiff", "single"
manifest_files = sorted(pkgs.glob("*/manifest.yaml"))
if not manifest_files:
    bail("no %s/*/manifest.yaml to derive the raster datatype set from; the declaration "
         "this gate reads is not there to read." % pkgs)
raster_ids, contributed_ids = set(), set()
for mf in manifest_files:
    # The WHOLE traversal is inside the try, not just the parse. A manifest whose top level
    # is not a mapping, or whose datatypes are not mappings, raises AttributeError rather
    # than a YAMLError -- and outside the try that collapsed into the caller's generic
    # "produced no parseable JSON" die, throwing away the purpose-written diagnosis below.
    try:
        declared = yaml.safe_load(mf.read_text(encoding="utf-8")) or {}
        for idx, dt in enumerate((declared.get("contributes") or {}).get("datatypes") or []):
            # An id that is not a string is not an id, and this ABORTS rather than skipping.
            # Both halves matter. Without the check at all, a declaration missing its id put
            # None into the derived set, which made the empty-set abort below unreachable
            # ({None} is truthy), made the membership test match every entry carrying no
            # datatype, and finally died on sorted() with a bare traceback. But skipping it
            # is not the repair either: a malformed declaration would then narrow this gate's
            # subject set silently and green, and only a TOTAL collapse would be caught --
            # which is the exact thing section 3 forbids nine lines above. A declaration this
            # gate cannot read is a HARD FAILURE, in both directions.
            if not isinstance(dt.get("id"), str):
                bail("%s declares a datatype with no string id (entry %d: %r). The subject set "
                     "of this gate is DERIVED from these declarations, so a declaration it "
                     "cannot read would narrow that set silently -- which is a hard failure, "
                     "never a skip." % (mf, idx, dt))
            contributed_ids.add(dt["id"])
            storage = dt.get("storage") or {}
            if ((storage.get("layout") or {}).get("kind") == OPAQUE_LAYOUT_KIND
                    and storage.get("format") == OME_TIFF_FORMAT
                    and storage.get("file_layout") == SINGLE_FILE_LAYOUT):
                raster_ids.add(dt["id"])
    except Exception as e:
        bail("%s does not read as a datatype declaration (%s: %s); the declaration this gate "
             "derives its subject set from is unreadable, which is a HARD FAILURE."
             % (mf, type(e).__name__, e))
if not raster_ids:
    bail("no contributed datatype declares a single opaque %s blob (%s / %s / %s) across %d "
         "manifest(s) under %s. Every magnitude below is read out of such a blob, so the "
         "derivation has collapsed and this gate would check nothing."
         % (OME_TIFF_FORMAT, OPAQUE_LAYOUT_KIND, OME_TIFF_FORMAT, SINGLE_FILE_LAYOUT,
            len(manifest_files), pkgs))

# NO abort when the emitted set is empty, deliberately. D6's MIN_LIVE_QUANTITIES floor is
# already the companion derived-guards.md section 2 prescribes for a derived set, and it
# catches that collapse in ASSERT mode with a per-quantity diagnosis. An abort here would
# additionally destroy the --json REPORT, which reports and asserts nothing -- and the
# battery's own control for "the producer package's own writer drives the derivation"
# (TEST-19) reads that report on a tree where the plant legitimately removes every raster
# entry. Fail-closed is above, on the DECLARATION, which is the thing this block derives.
raster_entries = [e for e in entries if e.get("datatype") in raster_ids]

for e in raster_entries:
    meta = e.get("meta") or {}
    oid = e["id"]
    to_space = meta.get("to_space")
    if isinstance(to_space, list) and isinstance(to_space[0], (int, float)):
        quantities["%s.to_space[0]" % oid] = float(to_space[0])
    dd = meta.get("display_derivative") or {}
    if isinstance(dd.get("original_resolution_um"), (int, float)):
        quantities["%s.original_resolution_um" % oid] = float(dd["original_resolution_um"])
    # The pitch the producer actually WROTE INTO the emitted OME-XML, read from its bytes.
    #
    # Every step here is a HARD FAILURE, and that is the point: this read used to be
    # decorative. Nothing named the value, nothing floored it, and nothing compared it to the
    # manifest -- so doubling the emitted PhysicalSize, or making it anisotropic, or moving the
    # blob so it could not be read at all, each left the gate green while the viz prose's
    # "PhysicalSizeX is microns_per_pixel over the scalefactor, by construction" became false
    # about today's producer.
    dtype = e.get("datatype")
    path = e.get("path")
    if not isinstance(path, str):
        bail("the importer emitted %s with no path field, so its image bytes cannot be read. "
             "It is in this gate's subject set because its DATATYPE %r declares a single "
             "opaque %s blob; if that declaration is what moved, the repair is in the manifest "
             "that declares %r, not in this script."
             % (oid, dtype, OME_TIFF_FORMAT, dtype))
    blob = out_root / path
    if not blob.is_file():
        bail("the importer's manifest points %s at %s, which it did not write. It is in this "
             "gate's subject set because its DATATYPE %r declares a single opaque %s blob; if "
             "that declaration is what moved, the repair is in the manifest that declares %r, "
             "not in this script." % (oid, path, dtype, OME_TIFF_FORMAT, dtype))
    raw = blob.read_bytes().decode("latin-1")
    # The OME-XML PAYLOAD, not the whole file: a decoy in pixel data would otherwise shadow the
    # real trailing declaration, and more than one match must not be silently resolved.
    _s, _e = raw.find("<OME"), raw.rfind("</OME>")
    if _s < 0 or _e < _s:
        bail("the image the importer just emitted for %s carries no <OME> block. It is checked "
             "here because its DATATYPE %r declares format %s; a declaration that says that "
             "about bytes which are not that is repaired in the manifest that declares %r, "
             "not in this script." % (oid, dtype, OME_TIFF_FORMAT, dtype))
    xml = raw[_s:_e + len("</OME>")]
    import re as _re
    _xs = _re.findall(r'PhysicalSizeX="([0-9.eE+-]+)"', xml)
    _ys = _re.findall(r'PhysicalSizeY="([0-9.eE+-]+)"', xml)
    if len(_xs) > 1 or len(_ys) > 1:
        bail("the image the importer just emitted for %s declares PhysicalSize more than once "
             "(X=%r, Y=%r)" % (oid, _xs, _ys))
    mx = _xs[0] if _xs else None
    my = _ys[0] if _ys else None
    if not mx or not my:
        bail("the image the importer just emitted for %s declares no PhysicalSizeX/Y; the OME "
             "pitch this gate reads is not there to read" % oid)
    px, py = float(mx), float(my)
    if px != py:
        bail("the importer emitted %s with an anisotropic pitch (PhysicalSizeX=%r, "
             "PhysicalSizeY=%r); the writer emits square pixels" % (oid, px, py))
    applied = (dd or {}).get("applied_resolution_um")
    if isinstance(applied, (int, float)) and abs(px - applied) > abs(applied) * 1e-9:
        bail("the importer's own two outputs disagree for %s: the emitted OME-XML says "
             "PhysicalSizeX=%r while the manifest it wrote in the same run says "
             "applied_resolution_um=%r" % (oid, px, applied))
    quantities["%s.PhysicalSizeX" % oid] = px
    quantities["%s.PhysicalSizeY" % oid] = py

quantities["microns_per_pixel"] = space_scale

# The numerator the AST read is only load-bearing while the scale is DERIVED from the spot
# diameter. micron_scale' leg 1 takes a vendor-STATED microns_per_pixel verbatim, and a
# single extra key in the bundle would switch the producer onto that leg and quietly retire
# the derivation this gate's headline control exercises. Freeze the leg (derived-guards.md
# section 4: keep a frozen CASE across the direction a derivation cannot see).
if scale_source != "derived-from-spot-diameter":
    bail("the importer's micron scale now comes from %r, not from the spot diameter. The "
         "numerator this gate reads out of the micron_scale call site is then dead code, and "
         "changing it would no longer move any number -- so that control must not be reported "
         "as passing. If the bundle legitimately gained a vendor-stated scale, this gate needs "
         "re-deriving, not relaxing." % scale_source)

# THE SHIFT #222 IS ABOUT, derived rather than quoted. The prose in this tree states the
# percentage the micron scale moved when the numerator changed, and that percentage is a
# quantity of the two constants -- so it is published and checked like any other, instead of
# sitting in tagged scopes as an unexplained four-digit literal that every threshold then had
# to tolerate. Only meaningful while there are exactly two such constants to move between.
# Published for EVERY other constant, not only when there happens to be exactly one. The
# arity-one form silently DROPPED the quantity when a third constant was added -- a change
# that moves no emitted magnitude -- and the prose quoting the shift then reddened with a
# diagnosis blaming the prose. A conditional over a derived set's cardinality is the
# anti-pattern of derived-guards.md section 4 with its failure direction inverted.
_others = [n for n in constants if n != numerator_name and constants[n]]
for _other in _others:
    _pct = (constants[numerator_name] / constants[_other] - 1.0) * 100.0
    quantities["micron_scale_shift_percent.%s" % _other] = _pct
    # The unsuffixed alias exists only while it is UNAMBIGUOUS. Publishing it inside the loop
    # made the last iteration win, so a third constant silently redefined what "the shift"
    # means and reddened the prose quoting the real one.
    if len(_others) == 1:
        quantities["micron_scale_shift_percent"] = _pct
    # The same move stated from the other end -- "every prior result was N% low" -- which is
    # how half this prose phrases it. Same two constants, one subtraction, and without it the
    # sentence reads as an unexplained literal that the adrift rule has to be widened around.
    _inv = (1.0 - constants[_other] / constants[numerator_name]) * 100.0
    quantities["micron_scale_shortfall_percent.%s" % _other] = _inv
    if len(_others) == 1:
        quantities["micron_scale_shortfall_percent"] = _inv

print(json.dumps({
    # What this run DERIVED its subject set to be, and the whole contributed vocabulary it
    # derived that set out of. Published rather than kept internal for two reasons: a derived
    # guard that will not say what it ranged over is indistinguishable from one that ranged
    # over nothing, and this is the handle the battery binds to instead of writing a domain
    # kind id into a file the zero-core surface scan reads (#303).
    "raster_datatypes": sorted(raster_ids),
    "contributed_datatypes": sorted(contributed_ids),
    "quantities": quantities,
    "constants": constants,
    "inputs": inputs,
    "numerator_name": numerator_name,
    "micron_scale_source": scale_source,
    # See the note beside design_numerator_problems: reported, not bailed on, so that the
    # magnitude comparison stays the first thing this gate speaks about.
    "design_numerator_problems": design_numerator_problems,
}, sort_keys=True))
`

function deriveLive(pkgsDir) {
  // `-B` + a FRESH pycache prefix: nothing is written, and nothing pre-existing under a
  // `__pycache__` directory is read for the producer's dependencies either.
  const pycache = mkdtempSync(path.join(tmpdir(), 'viz-producer-magnitudes-'))
  const py = spawnSync('python3', ['-B', '-', pkgsDir, PRODUCER_PACKAGE, PRODUCER_MODULE], {
    input: DRIVER,
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: pycache },
  })
  try { rmSync(pycache, { recursive: true, force: true }) } catch { /* best effort */ }
  if (py.error && py.error.code === 'ENOENT') {
    die(
      'python3 is not on PATH, so the producer cannot be EXECUTED and the current ' +
        'magnitudes cannot be derived. This is a hard failure, not a skip: a guard that ' +
        'quietly no-ops is indistinguishable from one that passes (derived-guards.md §3). ' +
        'The same interpreter `just check-py` needs is the one needed here.',
    )
  }
  if (py.error) die(`could not run python3: ${py.error.message}`)
  let out
  try {
    out = JSON.parse((py.stdout || '').trim())
  } catch {
    die(
      `the producer-derivation driver produced no parseable JSON (exit ${py.status}).\n` +
        `--- stdout ---\n${py.stdout}\n--- stderr ---\n${py.stderr}`,
    )
  }
  if (py.status !== 0 || out.error) {
    die(
      `the producer derivation FAILED (exit ${py.status}): ${out.error ?? '(no reason given)'}\n` +
        `This gate cannot report on magnitudes it could not derive.\n${py.stderr || ''}`,
    )
  }
  return out
}

// ── D2: read the FROZEN fixture's own bytes ──────────────────────────────────
function deriveFrozen(spatialDir) {
  const fixturesDir = path.join(spatialDir, 'fixtures')
  if (!existsSync(fixturesDir)) {
    die(`no fixtures directory at ${rel(fixturesDir)} — the frozen half cannot be read.`)
  }
  // The emitted-manifest fixture is identified by CONTENT, not by a loose name match: an
  // unanchored /manifest.*\.json$/ meant that adding `manifest-schema.json` beside it hard-
  // aborted this gate. A file qualifies when it parses as a non-empty array of entries that
  // carry an `id` and a `meta` — which is what an emitted manifest IS.
  const manifests = readdirSync(fixturesDir).filter(f => {
    if (!f.endsWith('.json')) return false
    try {
      const j = JSON.parse(readFileSync(path.join(fixturesDir, f), 'utf8'))
      return (
        Array.isArray(j) &&
        j.length > 0 &&
        j.every(e => e && typeof e.id === 'string' && typeof e.datatype === 'string' && typeof e.path === 'string' && e.meta)
      )
    } catch { return false }
  })
  if (manifests.length !== 1) {
    die(
      `expected exactly one emitted-manifest fixture under ${rel(fixturesDir)}, found ` +
        `${manifests.length} (${manifests.join(', ') || 'none'}). The frozen side is read ` +
        `from the producer's own emitted manifest; without exactly one there is nothing ` +
        `unambiguous to read.`,
    )
  }
  const manifestPath = path.join(fixturesDir, manifests[0])
  // No parse/empty aborts here: the filter above already parsed the file and required a
  // non-empty array of entries, so an unparseable or empty one is simply NOT a manifest and the
  // count abort has already fired. Keeping unreachable aborts would be two more "hard failure"
  // claims with nothing behind them.
  const entries = JSON.parse(readText(manifestPath, 'the emitted-manifest fixture'))

  const quantities = {}
  const perEntry = {}
  let spaceScale = null
  for (const e of entries) {
    const id = e?.id
    const meta = e?.meta
    if (!id || !meta) continue
    perEntry[id] = {}
    if (typeof meta.microns_per_pixel === 'number') {
      // The space scale is ONE number per import, shared by every entry. Publishing it once
      // per image produced value-equal ids a tag could satisfy interchangeably; publishing
      // it once, and CHECKING the entries agree, says the same thing without the ambiguity.
      if (spaceScale !== null && spaceScale !== meta.microns_per_pixel) {
        die(
          `${rel(manifestPath)} declares two different \`microns_per_pixel\` values ` +
            `(${spaceScale} and ${meta.microns_per_pixel}) for one coordinate space. The ` +
            `frozen side has no single scale to compare against.`,
        )
      }
      spaceScale = meta.microns_per_pixel
      perEntry[id].microns_per_pixel = meta.microns_per_pixel
    }
    if (Array.isArray(meta.to_space) && typeof meta.to_space[0] === 'number') {
      quantities[`${id}.to_space[0]`] = meta.to_space[0]
      // The affine's two scale terms, for the same reason the pitch's two axes are checked:
      // the writer emits an isotropic inverse-scalefactor affine, so a disagreement means the
      // file was hand-edited. Only [0] is published as a claimable id — [4] is its twin, not a
      // second quantity — but a silent divergence between them would make the published one a
      // half-truth.
      if (typeof meta.to_space[4] === 'number' && meta.to_space[4] !== meta.to_space[0]) {
        die(
          `${id}'s declared affine is anisotropic: to_space[0]=${meta.to_space[0]} but ` +
            `to_space[4]=${meta.to_space[4]}. The producer emits the inverse of one ` +
            `scalefactor on both axes, so this artifact is not its output and the frozen side ` +
            `cannot be trusted as a reference until that is explained.`,
        )
      }
    }
    const dd = meta.display_derivative
    if (dd && typeof dd.original_resolution_um === 'number') {
      quantities[`${id}.original_resolution_um`] = dd.original_resolution_um
      perEntry[id].original_resolution_um = dd.original_resolution_um
    }
    // The image the entry POINTS AT, read as bytes. This is the half `fixtures/README.md`
    // declared unpinned in #277: the loader never parses PhysicalSizeX, so a regenerated
    // TIFF used to move nothing that any assertion could see.
    if (typeof e.path === 'string') {
      const tif = path.join(fixturesDir, e.path)
      if (existsSync(tif)) {
        const raw = readText(tif, `the emitted image \`${e.path}\``, 'latin1')
        const xml = omeXmlPayload(raw, rel(tif))
        const x = solePhysicalSize(xml, 'X', rel(tif))
        const y = solePhysicalSize(xml, 'Y', rel(tif))
        if (x !== null) quantities[`${id}.PhysicalSizeX`] = x
        if (y !== null) quantities[`${id}.PhysicalSizeY`] = y
        if (x !== null && y !== null && x !== y) {
          die(
            `${e.path}'s OME-XML declares PhysicalSizeX=${x} but PhysicalSizeY=${y}. ` +
              `The shipped writer emits square pixels, so an anisotropic pitch means the ` +
              `file was hand-edited or is not this system's output — the frozen side cannot ` +
              `be trusted as a reference until that is explained.`,
          )
        }
      }
    }
  }
  if (spaceScale !== null) quantities.microns_per_pixel = spaceScale

  // THE TRAP'S OWN MAGNITUDE, derived rather than quoted. Composing an image's pixel pitch
  // over its placement affine is the defect every module in this directory documents, and the
  // prose states the number it would produce. That number is `to_space[0] * PhysicalSizeX` on
  // the artifact — a quantity of the fixture, not a new assumption — so it is published as an
  // id and checked like any other. Before this it was an unexplained five-digit literal, which
  // is precisely the shape a rotted magnitude has, so it had to be tolerated by threshold and
  // that tolerance is what let a real eleven-percent error through beside it.
  for (const [id, e] of Object.entries(perEntry)) {
    const affine = quantities[`${id}.to_space[0]`]
    const pitch = quantities[`${id}.PhysicalSizeX`]
    if (typeof affine === 'number' && typeof pitch === 'number') {
      quantities[`${id}.composed_pitch_over_affine`] = affine * pitch
      // …and the same mistake made the other way round, which the tests name by value too.
      // Both are quantities OF THE FIXTURE, not new assumptions, so they are derived rather
      // than tolerated as unexplained literals.
      quantities[`${id}.affine_over_pitch`] = affine / pitch
    }
  }
  return { quantities, perEntry, spaceScale, manifestPath }
}

/**
 * The OME-XML payload of a TIFF, as text.
 *
 * Reading `PhysicalSize` out of the WHOLE file took the first match anywhere in the bytes, so a
 * decoy written into pixel data shadowed the real trailing declaration — in a check whose whole
 * point is that a hand-edited artifact must be detectable. The payload is delimited; use it.
 */
function omeXmlPayload(raw, what) {
  const start = raw.indexOf('<OME')
  const end = raw.lastIndexOf('</OME>')
  if (start < 0 || end < 0 || end < start) {
    die(`${what} carries no <OME>…</OME> block, so its declared pixel pitch cannot be read.`)
  }
  return raw.slice(start, end + '</OME>'.length)
}
/** Exactly one declaration of an axis inside that payload, or a hard failure. */
function solePhysicalSize(xml, axis, what) {
  const all = [...xml.matchAll(new RegExp(`PhysicalSize${axis}="([0-9.eE+-]+)"`, 'g'))]
  if (all.length === 0) return null
  if (all.length > 1) {
    die(
      `${what}'s OME-XML declares PhysicalSize${axis} ${all.length} times ` +
        `(${all.map(m => m[1]).join(', ')}). This gate will not pick one of several.`,
    )
  }
  return Number(all[0][1])
}

// ── the scan ─────────────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_WALK.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (SCANNED_EXT.has(path.extname(e.name))) acc.push(p)
  }
  return acc
}

/**
 * A line that carries no content of its own: blank, or empty once its leading comment
 * marker is removed. A JSDoc TERMINATOR line counts too (it is in the alternation below,
 * spelled as an escaped regex rather than written out here — writing it out would end this
 * very comment). Without it a JSDoc block's last paragraph bleeds through the terminator
 * into the code beneath, which both let a tag govern lines it was never written for and
 * made a correct tagged declaration flip between green and red on a blank line a formatter
 * might insert.
 */
const BARE_MARKER = /^\s*(?:\/\/+|\*+|\/\*+|\*\/|#+|<!--|-->)?\s*$/

/** Truly blank — the only thing that ends a COMMENT BLOCK. */
const BLANK = /^\s*$/
/**
 * The literals of the whole comment block a paragraph belongs to.
 *
 * A tag's SCOPE stops at a bare `//` line, and that is right — a tag vouches for the sentence
 * it heads. But the ADRIFT rule must not stop there, because deleting a tag line and leaving a
 * bare `//` in its place splits the paragraph, and the falsified sentence then sits in no
 * scope at all: the floors could be repaid with a true claim elsewhere and nothing looked at
 * the numbers that had just been made up. A comment block that contains a magnitude claim is
 * about magnitudes throughout.
 */
let BLOCKS = []
function blockLitsFor(para) {
  const b = BLOCKS.find(x => para.start >= x.from && para.start <= x.to)
  return b ? b.lits : para.lines.flatMap(l => [...l.text.matchAll(NUMBER_RE)].map(m => ({ lit: m[0], line: l.n })))
}
function commentBlocks(text) {
  const lines = text.split('\n')
  const out = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    if (BLANK.test(lines[i])) { cur = null; continue }
    if (!cur) { cur = { from: i + 1, to: i + 1, lits: [] }; out.push(cur) }
    cur.to = i + 1
    for (const m of lines[i].matchAll(NUMBER_RE)) cur.lits.push({ lit: m[0], line: i + 1 })
  }
  return out
}

/** Paragraphs = maximal runs of content-carrying lines. They BOUND a tag's reach. */
function paragraphs(text) {
  const lines = text.split('\n')
  const out = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    if (BARE_MARKER.test(lines[i])) { cur = null; continue }
    if (!cur) { cur = { start: i + 1, lines: [] }; out.push(cur) }
    cur.lines.push({ n: i + 1, text: lines[i] })
  }
  return out
}

/**
 * A tag's SCOPE: from its own line up to the line before the NEXT tag-bearing line in the
 * same paragraph, or the end of the paragraph.
 *
 * This is the difference between "this block mentions both eras' numbers" and "this
 * sentence claims this value". With whole-paragraph scoping the two eras inside one
 * explanatory block are interchangeable — swapping which sentence says "today" and which
 * says "before #222" left the gate green, and that swap IS the #222/#258 defect. Scoping
 * per tag means a value must sit under the tag that claims it, so the swap moves each value
 * out of the scope that vouches for it.
 *
 * The practical consequence for authors: put the tag immediately ABOVE the sentence it
 * describes, not in a block at the top.
 */
function tagScopes(para) {
  const tagLineIdxs = []
  for (let i = 0; i < para.lines.length; i++) {
    if (tagRe().test(para.lines[i].text)) tagLineIdxs.push(i)
  }
  // A RUN of consecutive tag lines is ONE tag line. Splitting a long tag line onto two — a
  // `max-len` rule, a prettier pass, a hand wrap of a 206-character comment — used to give the
  // first tag a scope of exactly itself, containing no literal, and the diagnostic then blamed
  // a blank line that was not there and prescribed a repair that could not work. Tags stack
  // vertically now, which is also how a reader would write them.
  const runs = []
  for (const i of tagLineIdxs) {
    const last = runs[runs.length - 1]
    if (last && i === last[last.length - 1] + 1) last.push(i)
    else runs.push([i])
  }
  const scopes = []
  for (let k = 0; k < runs.length; k++) {
    const from = runs[k][0]
    const runEnd = runs[k][runs[k].length - 1]
    const to = k + 1 < runs.length ? runs[k + 1][0] - 1 : para.lines.length - 1
    const lines = para.lines.slice(from, to + 1)
    // DE-DUPLICATED. Writing the same tag twice on one line used to count as two claim sites
    // — for the aggregate floors and for the per-quantity ones — so every floor was payable by
    // repeating a token the scope already satisfies. Minting cost nothing, and the summary line
    // was byte-identical to a clean run.
    // DE-DUPLICATED across the whole run. Repeating a tag token minted claim sites — for the
    // aggregate floors and for the per-quantity ones — so a floor was payable by writing the
    // same tag again, on the same line OR on the next one, and the summary stayed byte-identical.
    const tags = []
    const seenTags = new Set()
    for (let i = from; i <= runEnd; i++) {
      for (const m of para.lines[i].text.matchAll(tagRe())) {
        const key = `${m[1]}:${m[2]}`
        if (seenTags.has(key)) continue
        seenTags.add(key)
        tags.push({ side: m[1], id: m[2] })
      }
    }
    const lits = []
    for (const l of lines) for (const m of l.text.matchAll(NUMBER_RE)) lits.push({ lit: m[0], line: l.n })
    scopes.push({ tags, lines, lits, start: para.lines[from].n, end: para.lines[to].n })
  }
  return scopes
}

/**
 * A tag LINE that carries both sides for the same quantity collapses the scope rule straight
 * back into the whole-paragraph rule this file calls the defect: both tags then range over
 * the same lines, so the two eras become interchangeable inside them and the era swap is
 * invisible again. It is refused rather than warned about — a tag that cannot distinguish the
 * claim it makes is a tag being used to pass, not to check.
 */
function refuseAmbiguousTagLines(file, scopes) {
  for (const scope of scopes) {
    const bySide = { producer: new Set(), frozen: new Set() }
    for (const t of scope.tags) bySide[t.side].add(t.id)
    for (const id of bySide.producer) {
      if (!bySide.frozen.has(id)) continue
      fail(
        'D3',
        `${rel(file)}:${scope.start} — this line carries BOTH ` +
          `\`[producer-magnitude: ${id}]\` and \`[frozen-magnitude: ${id}]\`, so both range ` +
          `over the same lines and neither can say which sentence claims which era. Split them: ` +
          `put each tag immediately above the sentence it vouches for.`,
      )
    }
  }
  return scopes
}

// ── main ─────────────────────────────────────────────────────────────────────
const pkgsDir = path.join(REPO, 'src-app', 'packages')
if (!existsSync(path.join(pkgsDir, PRODUCER_PACKAGE))) {
  die(
    `no producer package at ${rel(path.join(pkgsDir, PRODUCER_PACKAGE))}. This gate binds ` +
      `${SUBJECT_WORKSPACE}'s prose to that package's constants; without it there is nothing ` +
      `to derive from and a green run would mean nothing.`,
  )
}
const subjectDir = resolveSubjectDir()
const spatialDir = path.join(subjectDir, SUBJECT_SUBDIR)
if (!existsSync(spatialDir) || !statSync(spatialDir).isDirectory()) {
  die(
    `no ${SUBJECT_SUBDIR} under ${rel(subjectDir)} — the scanned tree is gone, so this gate ` +
      `would examine zero sites and report success.`,
  )
}

const live = deriveLive(pkgsDir)
const frozen = deriveFrozen(spatialDir)

// NOTE — there is deliberately NO live-vs-frozen cross-check here, and there used to be.
// It compared two numbers BOTH read from the frozen fixture, which is pinned pre-#222 and
// cannot move with the producer: a tautology in exactly the direction `derived-guards.md` §4
// tells you to ask about, dressed up as a safety property. It is not replaced by a better
// version because it is no longer needed — the LIVE side is now what the importer actually
// EMITS over its own bundle, so there is no arithmetic of this file's own left to check.
// The DERIVED half wins. `inputs` are raw keys of a vendor JSON file, so spreading them last
// let a bundle key shadow a quantity the importer computed — the untrustworthy half
// overriding the trustworthy one, which is backwards even where the result still reds.
const liveValues = { ...live.inputs, ...live.constants, ...live.quantities }
const frozenValues = frozen.quantities

if (Object.keys(live.quantities).length < MIN_LIVE_QUANTITIES) {
  fail(
    'D6',
    `the producer yielded ${Object.keys(live.quantities).length} derived quantities, floor is ` +
      `${MIN_LIVE_QUANTITIES}. The derivation is broken or the vendor-image table collapsed; ` +
      `a gate with nothing to compare against must not pass.`,
  )
}
if (Object.keys(frozenValues).length < MIN_FROZEN_QUANTITIES) {
  fail(
    'D6',
    `the committed fixture yielded ${Object.keys(frozenValues).length} frozen quantities, floor ` +
      `is ${MIN_FROZEN_QUANTITIES}. The fixture moved, shrank, or stopped parsing.`,
  )
}

const files = walk(spatialDir).sort()

const sites = []
let checkedClaims = 0
const knownEverywhere = v =>
  Object.values(liveValues).some(k => renders(v, k)) || Object.values(frozenValues).some(k => renders(v, k))

for (const file of files) {
  const text = readText(file, 'a scanned source file')
  BLOCKS = commentBlocks(text)
  for (const para of paragraphs(text)) {
    const scopes = tagScopes(para)
    refuseAmbiguousTagLines(file, scopes)
    const paraLits = []
    for (const l of para.lines) for (const m of l.text.matchAll(NUMBER_RE)) paraLits.push({ lit: m[0], line: l.n })

    for (const scope of scopes) {
      for (const tag of scope.tags) {
        const table = tag.side === 'producer' ? liveValues : frozenValues
        const otherTable = tag.side === 'producer' ? frozenValues : liveValues
        // Counted toward the floors ONLY if the CLAIM distinguishes something — i.e. the scope
        // states the value to two or more significant digits. A tag whose scope carries only a
        // bare `5` is satisfied by any stray digit and is free to mint, and a floor over a
        // mintable population is not a floor: delete one real tag, falsify what it checked, add
        // vacuous ones elsewhere, and the counts came back green.
        //
        // This is a property of the CLAIM, never of the VALUE. Testing the value instead made a
        // per-id floor UNSATISFIABLE the moment a producer constant became a round number: a
        // correct, well-formed `[...: VISIUM_RENDERED_SPOT_DIAMETER_UM]` claim stating `70.0`
        // could not count, so the floor stayed red with no repair available except lowering it
        // — which is exactly the non-repair §5 names. `70.0` states two digits; a stray `7`
        // does not.
        const table_ = tag.side === 'producer' ? liveValues : frozenValues
        const distinguishing =
          tag.id in table_ &&
          scope.lits.some(x => sigDigits(x.lit) >= 2 && renders(x.lit, table_[tag.id]))
        sites.push({ ...tag, file: rel(file), line: scope.start, distinguishing })
        if (!(tag.id in table)) {
          fail(
            'D3',
            `${rel(file)}:${scope.start} — \`[${tag.side}-magnitude: ${tag.id}]\` names a quantity ` +
              `the ${tag.side === 'producer' ? 'producer no longer derives' : 'fixture does not contain'}. ` +
              `Available ${tag.side} ids: ${Object.keys(table).sort().join(', ') || '(none)'}.` +
              (tag.id in otherTable
                ? `  NOTE: \`${tag.id}\` IS a ${tag.side === 'producer' ? 'frozen' : 'producer'} ` +
                  `quantity — this looks like the wrong tag for this claim.`
                : ''),
          )
          continue
        }
        const want = table[tag.id]
        const need = requiredPrecision(want)
        checkedClaims++
        if (scope.lits.some(x => sigDigits(x.lit) >= need && renders(x.lit, want))) continue

        const stale = scope.lits.find(
          x => sigDigits(x.lit) >= need && tag.id in otherTable && renders(x.lit, otherTable[tag.id]),
        )
        const adrift = scope.lits.filter(x => sigDigits(x.lit) >= MIN_SWEEP_SIG_DIGITS && !knownEverywhere(x.lit))
        const advice =
          tag.side === 'producer'
            ? 'Update the quoted magnitude to what the producer derives today, or retag the ' +
              'scope `[frozen-magnitude: ...]` if it really is describing the committed fixture.'
            : 'The fixture bytes say otherwise — either the fixture was regenerated (a decision, ' +
              'not a refresh) or this scope is describing the current producer and should be ' +
              'tagged `[producer-magnitude: ...]`.'
        const msg = [
          `${rel(file)}:${scope.start}-${scope.end} — this scope is tagged ` +
            `\`[${tag.side}-magnitude: ${tag.id}]\` but carries no rendering of that quantity's ` +
            `current value at ${need}+ significant digits.`,
          `      Today ${tag.side === 'producer' ? 'the producer derives that quantity as' : 'the committed fixture contains'} ${want}.`,
        ]
        if (stale) {
          msg.push(
            `      It does carry \`${stale.lit}\` — the ` +
              `${tag.side === 'producer' ? 'FROZEN fixture' : 'CURRENT producer'} value for the ` +
              `same quantity (${otherTable[tag.id]}). That is the drift.`,
          )
        }
        if (adrift.length) {
          msg.push(
            `      Literal(s) here that match NEITHER side: ` +
              `${adrift.map(x => `\`${x.lit}\` (line ${x.line})`).join(', ')}.`,
          )
        }
        if (!stale && !adrift.length) {
          msg.push(
            scope.lits.length === 0
              ? `      This scope is EMPTY: it runs ${scope.start}-${scope.end} and contains no ` +
                `number at all. A blank line — or a bare \`//\`, \` *\` or \`#\` line — between the ` +
                `tag and the sentence it heads closes the paragraph and cuts the scope short. ` +
                `Move the tag onto the line immediately above the sentence it vouches for.`
              : `      Literals in scope: ${scope.lits.map(x => x.lit).join(', ')}. ` +
                `A tag with nothing to check is a claim nobody verified.`,
          )
        }
        msg.push(`      ${advice}`)
        fail('D3', msg.join('\n'))
      }

      // ── D8: a NEAR-MISS of the claimed value, inside the scope that claims it ──────
      // D3 is satisfied by ANY literal in scope rendering the value, and these scopes
      // routinely carry both a short prose rendering and the full-precision one. So
      // corrupting the SHORT one left the scope green: D3 was already satisfied by the long
      // one, D4 skips a literal that matches nothing, and D7 needs ten digits. The prose then
      // states two different values for one quantity and the gate says OK — which is #277.
      //
      // The discriminator is PROXIMITY, and it is not a guess about what the prose means: a
      // number sitting within NEAR_MISS_TOLERANCE of a magnitude, inside the scope that
      // claims that magnitude, and NOT a valid rounding of it, is a corrupted copy of it.
      // Nothing else plausibly lands there. Legitimate neighbours in these paragraphs are far
      // outside it and are measured, not assumed: the composed-error ratio and the wrong
      // composed placement sit 4% and 300% away, and a coarse rounding like a three-digit
      // "Nx error" IS a valid rendering and so is never a near miss.
      for (const tag of scope.tags) {
        const table = tag.side === 'producer' ? liveValues : frozenValues
        if (!(tag.id in table)) continue
        const want = table[tag.id]
        if (!Number.isFinite(want) || want === 0) continue
        for (const { lit, line } of scope.lits) {
          if (!lit.includes('.')) continue
          const n = Number(lit)
          if (!Number.isFinite(n)) continue
          if (Math.abs(n - want) > Math.abs(want) * NEAR_MISS_TOLERANCE) continue
          if (renders(lit, want)) continue
          fail(
            'D8',
            `${rel(file)}:${line} — \`${lit}\` sits inside a scope tagged ` +
              `\`[${tag.side}-magnitude: ${tag.id}]\` and is within ` +
              `${(NEAR_MISS_TOLERANCE * 100).toFixed(1)}% of that quantity (${want}) without ` +
              `being a rounding of it.\n` +
              `      A number that close to a claimed magnitude, in the scope that claims it, is ` +
              `a corrupted copy of it — the scope now states two different values for one ` +
              `quantity, and the other one is keeping the tag satisfied.\n` +
              `      Re-derive it: \`node scripts/check-viz-producer-magnitudes.mjs --list\` ` +
              `prints both tables.`,
          )
        }
      }

      // ── D9: a scope may not state the OTHER era's value for the quantity it claims ──
      //
      // D3 passes as soon as SOME literal in scope renders the value, and these scopes carry
      // both a short prose form and the full-precision one. So writing the other era's number
      // into the short slot was green: D3 was satisfied by the long copy, the sweep skips four
      // significant digits, the adrift rule skips it because the other era's value IS "known"
      // somewhere, and the near-miss window is far narrower than the gap between the eras.
      // That is the #222/#258 defect itself — a claim about today quoting the frozen number —
      // so it gets its own rule rather than a diagnostic that runs only after D3 has failed.
      for (const tag of scope.tags) {
        const tbl = tag.side === 'producer' ? liveValues : frozenValues
        const oth = tag.side === 'producer' ? frozenValues : liveValues
        if (!(tag.id in tbl) || !(tag.id in oth)) continue
        const want = tbl[tag.id]
        const other = oth[tag.id]
        if (want === other) continue
        const need = requiredPrecision(other)
        for (const { lit, line } of scope.lits) {
          if (sigDigits(lit) < need) continue
          if (!renders(lit, other)) continue
          if (renders(lit, want)) continue
          fail(
            'D9',
            `${rel(file)}:${line} — this scope is tagged \`[${tag.side}-magnitude: ${tag.id}]\` ` +
              `but states \`${lit}\`, which is the ` +
              `${tag.side === 'producer' ? 'FROZEN fixture' : 'CURRENT producer'} value for that ` +
              `quantity (${other}), not the ${tag.side} one (${want}).\n` +
              `      A claim about one era quoting the other era's number is the defect this ` +
              `gate exists for; another rendering elsewhere in the scope is what has been ` +
              `keeping the tag satisfied.`,
          )
        }
      }
    }

    // ── D7: in a TAGGED PARAGRAPH, a precise literal must be a value some side holds ──
    //
    // Paragraph-wide, not scope-wide, and that distinction was load-bearing: with D7 confined
    // to the lines from a tag onward, MOVING a tag one sentence down un-covered the real claim
    // and left every floor, every id and every file count untouched. D4 cannot backstop it —
    // D4 only fires on a literal that still MATCHES a derived value, so it is structurally
    // blind to a falsified one, which is the whole defect class. A paragraph carrying a
    // magnitude tag is BY CONSTRUCTION about magnitudes, so a precise fractional literal in it
    // that matches neither side is adrift wherever in the paragraph it sits.
    const block = BLOCKS.find(x => para.start >= x.from && para.start <= x.to)
    if (scopes.length && block && !block.swept) {
      block.swept = true
      for (const { lit, line } of block.lits) {
        if (!lit.includes('.')) continue
        if (sigDigits(lit) < MIN_ADRIFT_SIG_DIGITS) continue
        if (knownEverywhere(lit)) continue
        fail(
          'D7',
          `${rel(file)}:${line} — \`${lit}\` sits in a paragraph that makes magnitude claims, ` +
            `is quoted to ${sigDigits(lit)} significant digits, and matches NEITHER what the ` +
            `producer derives now NOR anything in the committed fixture.\n` +
            `      A number written that precisely, in a paragraph about magnitudes, is a ` +
            `derived quantity; this one is adrift from both sides.\n` +
            `      Re-derive it — \`node scripts/check-viz-producer-magnitudes.mjs --list\` ` +
            `prints both tables.`,
        )
      }
    }

    // ── D4: no untagged magnitude anywhere ───────────────────────────────────
    for (const { lit, line } of paraLits) {
      if (sigDigits(lit) < MIN_SWEEP_SIG_DIGITS) continue
      const matched = []
      for (const [id, v] of Object.entries(liveValues)) if (renders(lit, v)) matched.push({ side: 'producer', id, v })
      for (const [id, v] of Object.entries(frozenValues)) if (renders(lit, v)) matched.push({ side: 'frozen', id, v })
      if (matched.length === 0) continue
      const covered = matched.some(m =>
        scopes.some(s => s.tags.some(t => t.side === m.side && t.id === m.id) && line >= s.start && line <= s.end),
      )
      if (covered) continue
      fail(
        'D4',
        `${rel(file)}:${line} — \`${lit}\` renders a producer magnitude but no tag SCOPE ` +
          `covering this line claims it. Tag the line above it ` +
          `${matched.map(m => `\`[${m.side}-magnitude: ${m.id}]\` (${m.v})`).join(' or ')} ` +
          `so this quote is checked against the side it claims. An untagged magnitude is how ` +
          `#222 silently falsified eight sites in this tree; declining to tag is not a way out.`,
      )
    }

    // ── D10: a micron QUANTITY beside its unit binds to the constant it renders ──
    //
    // The two spot diameters are written all over this tree as bare integers next to a micron
    // unit — "the 55 um capture footprint", "the 65 um rendered spot" — which is the exact
    // prose #222 changed. Nothing could see them: the sweep needs five significant digits, the
    // adrift rule skips integers, and the name-binding rule needs the SYMBOL on the line. So
    // the narrative sentence that explains the whole defect was the one thing unguarded, and
    // swapping which diameter is which read as correct.
    //
    // A number written immediately before a micron unit, whose value is one the producer
    // declares, is a claim about that constant. That is narrow (it needs the unit), derived
    // (the values come from the producer), and it has no vocabulary to reword around.
    for (const l of para.lines) {
      const text = l.text.replace(tagRe(), '')
      for (const m of text.matchAll(MICRON_QUANTITY_RE)) {
        const lit = m[1]
        const hits = Object.keys(live.constants).filter(
          c => sigDigits(lit) >= requiredPrecision(live.constants[c]) && renders(lit, live.constants[c]),
        )
        // Is this line inside a scope that CLAIMS one of the producer's spot diameters? If so
        // the paragraph is about them, and a micron quantity in it that renders NONE of them is
        // adrift — the missing half of this rule, and the one that matters: firing only on a
        // CORRECT value meant a WRONG one ("the RENDERED spot diameter (68 um)") was invisible
        // to every rule in the file, at every prose site that writes the two diameters.
        const claiming = Object.keys(live.constants).filter(c =>
          scopes.some(sc => sc.tags.some(t => t.side === 'producer' && t.id === c) && l.n >= sc.start && l.n <= sc.end),
        )
        if (!hits.length) {
          if (!claiming.length) continue // an unrelated micron measurement, nowhere near a claim
          fail(
            'D10',
            `${rel(file)}:${l.n} — \`${lit}\` is stated as a micron quantity inside a scope that ` +
              `claims ${claiming.map(c => `\`${c}\` (${live.constants[c]})`).join(' / ')}, but it ` +
              `is not the value of any of them.\n` +
              `      These constants are written as bare integers throughout this prose, where the ` +
              `sweep cannot see them and the adrift rules skip them; a wrong one here reads as ` +
              `correct. If the number is genuinely unrelated, move it out of the claim.`,
          )
          continue
        }
        const covered = hits.some(c =>
          scopes.some(sc => sc.tags.some(t => t.side === 'producer' && t.id === c) && l.n >= sc.start && l.n <= sc.end),
        )
        if (covered) continue
        fail(
          'D10',
          `${rel(file)}:${l.n} — \`${lit}\` is stated as a micron quantity and is the value of ` +
            `${hits.map(c => `\`${c}\` (${live.constants[c]})`).join(' / ')}, but no ` +
            `\`[producer-magnitude: …]\` scope covering this line claims it. These constants are ` +
            `written as bare integers throughout this prose, where nothing else can see them — ` +
            `and swapping which diameter is which is what #222 was.`,
        )
      }
    }

    // ── D5: a named producer constant binds its scope ────────────────────────
    // The names bound here are DERIVED, not listed: the producer's own `VISIUM_*_UM`
    // constants plus every key of the vendor bundle it read. Both have values too short for
    // D4's sweep to see, so naming one beside its value is the only thing that can bind it —
    // and the bundle's scalefactors are the inputs every checked magnitude is derived FROM,
    // so leaving them unbound left the foundations unchecked while the results were guarded.
    for (const symbol of [...Object.keys(live.constants), ...Object.keys(live.inputs)]) {
      const want = liveValues[symbol]
      if (!Number.isFinite(want)) continue
      // A name whose value has only ONE significant digit cannot be bound this way: any digit
      // on the line then counts as "stating it", so `to_space[0] is 1/tissue_hires_scalef` — a
      // RELATION, stating no value at all — reddens. Measured, not assumed: binding the two
      // one-digit scalefactors produced sixteen such false reds on correct prose, against four
      // real bindings. Those two values are consequently NOT name-bound, and that is stated in
      // "What is NOT checked" rather than left as a silent hole.
      if (exactSigDigits(want) < 2) continue
      // `symbol` ranges over the KEYS OF A VENDOR JSON FILE, so it is untrusted input to this
      // pattern: a key containing a regex metacharacter threw an uncaught SyntaxError and a
      // stack trace instead of a diagnostic.
      const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const word = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`)
      // EVERY naming line, not the first — and never the TAG MARKUP, which contains the
      // symbol itself. Binding only the first match meant the tag line always won (it names
      // the symbol), so any LATER statement of that constant's value in the same paragraph
      // was checked by nothing at all.
      for (const named of para.lines) {
        const bare = named.text.replace(tagRe(), '')
        // EVERY occurrence of the name on the line, and the value search continues onto the
        // next line of the same paragraph. Binding only the FIRST occurrence let
        // `NAME names the rendered spot; NAME = 55.0 today` state a false value unchecked, and
        // stopping at the line end lost a value that had simply wrapped.
        const nextText = (para.lines[para.lines.indexOf(named) + 1]?.text ?? '').replace(tagRe(), '')
        for (const occ of bare.matchAll(new RegExp(esc, 'g'))) {
        const at = occ.index ?? -1
        if (at < 0) continue
        // A sentence that merely MENTIONS a name states nothing that can be wrong; only one
        // that ASSIGNS it a value is making a claim. Two weaker cuts were tried and measured:
        // "the line carries a digit" reddened `to_space[0]`, a `§4` cross-reference and a `1.`
        // list marker; "the line carries a number of sufficient precision" still reddened four
        // sentences that name a bundle key while stating some OTHER quantity's value ("derived
        // from `spot_diameter_fullres` by `65/55 = +18.18%`"). Requiring the value to follow
        // the NAME — `name = 65.0`, `name is 65.0` — is what "the value stated next to that
        // name" actually means, and it is how these files state one.
        // The value this line states for that name is the NEAREST literal after it that is
        // precise enough to BE that value. An earlier cut tried to recognise an assignment —
        // `=`, `is`, `of` — and that is a prose lint by another name: `NAME: 55.0`,
        // `NAME -> 55.0`, `NAME (55.0)`, `NAME equals 55.0` and `NAME is now 55.0` all slipped
        // through, and swapping the two constants' stated values on a real tagged site was
        // green. Nearest-literal needs no vocabulary and has nothing to reword around.
        const need = requiredPrecision(want)
        const after = bare.slice(at + symbol.length) + ' ' + nextText
        // ADJACENT, not merely later on the line. Every way these files state a value puts it
        // within a few characters of the name (`= 55.0`, `: 65.0`, `(55.0)`, `is now 55.0`,
        // `-> 55.0`), while a sentence that names a quantity and then states some OTHER one
        // ("derived from `spot_diameter_fullres` by `65/55 = +18.18%`") puts it far further
        // off — measured on this tree, that is the whole false-positive population.
        const stated = [...after.matchAll(NUMBER_RE)].find(
          m => sigDigits(m[0]) >= need && (m.index ?? 0) <= NAME_VALUE_WINDOW,
        )
        if (!stated) continue
        const covered = scopes.some(
          s => s.tags.some(t => t.side === 'producer' && t.id === symbol) && named.n >= s.start && named.n <= s.end,
        )
        if (covered && renders(stated[0], want)) continue
        fail(
          'D5',
          `${rel(file)}:${named.n} — this line names \`${symbol}\` beside a stated value, and the ` +
            `producer's is ${want} today, but ` +
            (covered
              ? `the value it states is not that one.`
              : `no \`[producer-magnitude: ${symbol}]\` scope covers it, so the value stated next ` +
                `to that name is checked by nothing.`) +
            ` The constants carry too few significant digits for the D4 sweep to see them, so ` +
            `naming one is what binds the line.`,
        )
        }
      }
    }
  }
}

const producerSites = sites.filter(s => s.side === 'producer' && s.distinguishing).length
const frozenSites = sites.filter(s => s.side === 'frozen' && s.distinguishing).length
/** Files that carry at least one tag — the DERIVED subject of the file floor. */
const taggedFiles = new Set(sites.map(s => s.file)).size
if (producerSites < MIN_PRODUCER_SITES) {
  fail(
    'D6',
    `${producerSites} \`[producer-magnitude: ...]\` sites, floor is ${MIN_PRODUCER_SITES}. ` +
      `Removing a tag is not a way to make this gate pass — it is the way to make it cover ` +
      `less, which is what the floor refuses. Only tags whose quantity has more than one ` +
      `significant digit are counted; a tag that any stray digit would satisfy cannot pay for ` +
      `the deletion of one that discriminates.`,
  )
}
if (frozenSites < MIN_FROZEN_SITES) {
  fail(
    'D6',
    `${frozenSites} distinguishing \`[frozen-magnitude: ...]\` sites, floor is ${MIN_FROZEN_SITES}. Same reason.`,
  )
}
for (const [key, floor] of Object.entries(PER_ID_FLOORS)) {
  const [side, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  const have = sites.filter(s => s.side === side && s.id === id && s.distinguishing).length
  if (have < floor) {
    fail(
      'D6',
      `\`[${side}-magnitude: ${id}]\` is claimed by ${have} site(s), floor is ${floor}. ` +
        `Coverage of one quantity may not fall because another's rose: the aggregate floors ` +
        `are payable with a tag over any true statement, which is how a real claim can be ` +
        `deleted and its number rewritten while the totals stay put.`,
    )
  }
}
if (taggedFiles < MIN_TAGGED_FILES) {
  fail(
    'D6',
    `${taggedFiles} file(s) under ${rel(spatialDir)} carry a magnitude tag, floor is ` +
      `${MIN_TAGGED_FILES}. This floors the files that make CLAIMS, not the raw file count: a ` +
      `source directory legitimately loses a file to a refactor, and a floor that reddens on ` +
      `that is a floor people lower as paperwork (derived-guards.md §5).`,
  )
}
if (files.length === 0) {
  fail('D6', `scanned zero files under ${rel(spatialDir)} — an empty scan covers nothing.`)
}

// ── report ───────────────────────────────────────────────────────────────────
if (mode === 'json') {
  out(
    JSON.stringify(
      {
        repo: REPO,
        subject: rel(spatialDir),
        producer: `src-app/packages/${PRODUCER_PACKAGE}`,
        numerator: live.numerator_name,
        micron_scale_source: live.micron_scale_source,
        raster_datatypes: live.raster_datatypes,
        contributed_datatypes: live.contributed_datatypes,
        live: liveValues,
        frozen: frozenValues,
        sites,
        scanned_files: files.length,
        checked_claims: checkedClaims,
        failures,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const line = (k, v) => `  ${String(k).padEnd(46)} ${v}`
out(`check-viz-producer-magnitudes  repo=${REPO}`)
out(`  subject   ${rel(spatialDir)}  (${files.length} files scanned)`)
out(
  `  producer  src-app/packages/${PRODUCER_PACKAGE}  ` +
    `(numerator: ${live.numerator_name}; micron scale: ${live.micron_scale_source})`,
)
// A derived guard that will not say what it ranged over is indistinguishable from one that
// ranged over nothing (#303). The subject set is DERIVED from the contributed datatype
// declarations, so it is reported, not assumed.
out(
  `  subjects  ${live.raster_datatypes.length} raster datatype(s) derived from ` +
    `${live.contributed_datatypes.length} contributed declaration(s): ` +
    `${live.raster_datatypes.join(', ')}`,
)
out('  ── LIVE (derived by executing the producer) ──')
for (const [k, v] of Object.entries(liveValues).sort()) out(line(k, v))
out('  ── FROZEN (read from the committed fixture bytes) ──')
for (const [k, v] of Object.entries(frozenValues).sort()) out(line(k, v))
out(`  ── CLAIM SITES (${producerSites} producer, ${frozenSites} frozen; ${checkedClaims} claims checked) ──`)
for (const s of sites) out(line(`${s.file}:${s.line}`, `[${s.side}-magnitude: ${s.id}]`))

if (mode === 'list') {
  out('\ncheck-viz-producer-magnitudes: --list — reported only, asserted nothing.')
  process.exit(0)
}

// ── The per-design numerator cross-check, reported by the driver and asserted HERE ──
// LAST, deliberately. These comparisons are about the PRODUCER's internal consistency across
// slide designs; the magnitudes above are about whether viz's prose still matches the
// producer, which is what this gate is FOR. Bailing on these inside the driver aborted the
// derivation and pre-empted the magnitude comparison — measured, a plain producer-constant
// change then failed with "the table and the committed evidence disagree" instead of naming
// the viz site quoting a stale number, and five tests that drive those aborts by their own
// message went red. Appending them keeps both properties and keeps the primary one first.
for (const problem of live.design_numerator_problems || []) {
  fail('D1', problem)
}

if (failures.length) {
  err(`\ncheck-viz-producer-magnitudes FAIL — ${failures.length} problem(s):\n`)
  for (const f of failures) err(`  ${f}\n`)
  err(
    'These are DERIVED comparisons, not restated numbers: the LIVE column above came from\n' +
      'executing the importer just now, and the FROZEN column from the committed fixture bytes.\n' +
      'See docs/design/derived-guards.md §4 — the repair is to assert the relation, not to\n' +
      'raise the number by hand for the third time (#222, #258, #277).',
  )
  process.exit(1)
}

out(
  `\ncheck-viz-producer-magnitudes: OK — ${checkedClaims} quoted magnitude(s) across ` +
    `${producerSites + frozenSites} tagged site(s) agree with the producer and the fixture.`,
)
