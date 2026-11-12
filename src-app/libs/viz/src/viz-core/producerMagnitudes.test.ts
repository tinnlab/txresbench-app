/**
 * The guard that binds `viz-core/spatial`'s quoted producer magnitudes to the producer
 * (#277), RUN — plus the negative controls that prove it can fail.
 *
 * ── Where the guard is invoked, and why in two places ──────────────────────────
 * `scripts/check-viz-producer-magnitudes.mjs` is the gate. A gate nobody invokes is not a
 * gate (this repo has filed that a dozen times), so it needs a caller that already runs.
 * There are two, deliberately:
 *   1. `@txresbench/viz`'s own `test` SCRIPT chains it ahead of vitest. That is the load-bearing
 *      one: `check-package-suites.mjs` rule P5 runs every in-scope workspace package's
 *      `test` script to completion, so the guard rides `just check-packages` with no
 *      justfile edit (the justfile is #287's). Being in the package MANIFEST also means
 *      removing the invocation is a reviewable one-line diff rather than a deleted file.
 *   2. this spec, which additionally proves the guard BITES.
 * The guard's bytes are pinned by `check-guard-integrity.sh`; a caller in a test file alone
 * would not be, which is why (1) exists.
 *
 * Where that sits in the ordering, stated rather than implied: `just check` runs
 * `check-packages` as its FIFTH recipe, after `cd src-app/ui && npm run check`, which is red
 * on clean main (#226 x1, #246 x4). `just` aborts on the first non-zero recipe, so the guard
 * is NOT reachable through `just check` today — that is #287, not a property of this guard.
 *
 * ── Why this file sits BESIDE `spatial/` and not inside it ───────────────────
 * The guard's subject is the prose under `viz-core/spatial/**`. This file is not that prose:
 * it is the guard's negative controls, so it necessarily contains BOTH eras' magnitudes AND
 * deliberately-wrong mutants AND the literal text of the tags themselves (as assertion
 * strings). Inside the scanned subtree those assertion strings would be parsed as real tags
 * over paragraphs full of intentionally-false numbers, and the guard would be structurally
 * impossible to test. Moving it one directory out is not an exemption carved into the guard —
 * there is no allowlist, no skip and no special case in the script; the scanned tree is the
 * module being guarded, and this is the guard's test. vitest collects it identically
 * (`include: src/**` in this package's `vitest.config.ts`).
 *
 * ── What a negative control has to show ──────────────────────────────────────
 * That the guard goes RED on a planted defect AND says so, each behind a positive control
 * proving the same synthetic tree is GREEN before the plant. Two rules are enforced here
 * that were NOT in the first cut and that a blind audit had to find:
 *
 *   - Assertions about the failure message read `stderr`, never the combined output. The
 *     gate prints its LIVE/FROZEN tables and its full claim-site list to STDOUT on EVERY
 *     run, green ones included, so `toContain('[producer-magnitude: ...]')` against the
 *     combined output passed against a PASSING gate and proved nothing. Diagnostics go to
 *     stderr; that is what a control may look at.
 *   - Every rule has a control that fails when THAT rule alone is removed. A plant caught by
 *     three rules tests none of them individually: an audit deleted D3's central branch — the
 *     guard's whole thesis — and the suite stayed green, and deleting D5 reddened nothing at
 *     all. `onlyRules()` below is what keeps a plant honest about which rule caught it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Walk up to the repository root by looking for the guard itself — no `../../../..` count
 *  to get wrong if this file ever moves. */
const REPO = (() => {
  let d = HERE
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(d, 'scripts', 'check-viz-producer-magnitudes.mjs'))) return d
    d = path.dirname(d)
  }
  throw new Error('could not locate the repository root from ' + HERE)
})()
const GUARD = path.join(REPO, 'scripts', 'check-viz-producer-magnitudes.mjs')
const SPATIAL_REL = 'src-app/libs/viz/src/viz-core/spatial'
const PRODUCER_REL = 'src-app/packages/spatial-import-visium/compute/import_visium.py'
/**
 * The producer's `micron_scale(...)` numerator argument, VERBATIM, as one place.
 *
 * It was five copies of `rendered_spot_diameter_um=VISIUM_RENDERED_SPOT_DIAMETER_UM` spread
 * across five tests until #257 changed the call site's shape — the numerator is now SELECTED
 * per bundle from the producer's slide-design table — and all five plants stopped finding
 * their anchor at once. `planted()` fails loudly on a missing anchor rather than silently
 * planting nothing, which is why that was a red suite and not a green one; naming it once is
 * so the next producer-side change is a one-line edit here instead of five.
 */
const CALL_SITE_NUMERATOR = 'rendered_spot_diameter_um=design["rendered_spot_diameter_um"]'
const OME_WRITER_REL = 'src-app/packages/spatial-import-visium/compute/ome_writer.py'
const SCALEFACTORS_REL =
  'src-app/packages/spatial-import-visium/tests/fixtures/visium-outs/spatial/scalefactors_json.json'
const MANIFEST_REL = `${SPATIAL_REL}/fixtures/emitted-manifest-entries.json`
const HIRES_TIF_REL = `${SPATIAL_REL}/fixtures/spatial-image-hires.ome.tif`

type Run = { status: number; stdout: string; stderr: string }

function runGuard(repo: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [GUARD, '--repo', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: repo,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
/** Which rule ids actually fired. Diagnostics are on stderr; the report is on stdout. */
function rulesFired(r: Run): string[] {
  return [...new Set([...r.stderr.matchAll(/^\s*(D\d+):/gm)].map(m => m[1]))].sort()
}
/** Assert a plant was caught by EXACTLY these rules — so a control cannot silently be
 *  carried by a rule it was not written for. */
function onlyRules(r: Run, ...ids: string[]) {
  expect(rulesFired(r), `stderr was:\n${r.stderr}`).toEqual([...ids].sort())
}

/**
 * ONE run-scoped root, and every temp tree this file makes lives inside it.
 *
 * ── Why a root and not a list of siblings ──────────────────────────────────────
 * This battery builds ~118 real ~20 MB trees per full run. They used to be scattered as
 * SIBLINGS directly in `os.tmpdir()`, all sharing the `viz-magnitudes-` prefix, and cleaned
 * by draining an array every creation site had to remember to push to. Two things went
 * wrong with that, and only the first is the one people notice:
 *
 *   1. The cleanup hook was `process.on('exit')`, which never fires under vitest's pooled
 *      worker, so NOTHING was ever removed: 15,038 directories / ~220 GB had accumulated and
 *      the build box hit 100% full. That is fixed by using vitest's own `afterAll`.
 *   2. The footprint was UNATTRIBUTABLE, and that is the deeper defect. With every run's
 *      trees interleaved as siblings under one prefix in a SHARED `/tmp`, a before/after
 *      count of `os.tmpdir()` cannot tell this run's trees from a concurrently-running
 *      agent's. Measured while investigating: with NO run of this file in flight, `/tmp`
 *      gained 45 `viz-magnitudes-*` directories in 60 seconds from other processes. Any
 *      leak number taken that way — by anyone — is noise.
 *
 * So: one `mkdtempSync` for the whole run, everything nested under it, and cleanup is a
 * SINGLE recursive remove of that one path. A run's footprint is then exactly one directory,
 * attributable by name, and it cannot be confused with anyone else's. `afterAll` additionally
 * ASSERTS the root is gone (below), so the suite observes its own side effect instead of
 * leaving that to a human counting `/tmp`.
 */
const RUN_ROOT = mkdtempSync(path.join(os.tmpdir(), 'viz-magnitudes-run-'))
const tmpRoots: string[] = []
/**
 * A synthetic repository the battery may vandalise. Everything the guard reads is a real
 * COPY (never a symlink): the producer package must be mutable, and the derivation's
 * `rglob` for the vendor bundle does not descend symlinked directories.
 */
function synthRepo(): string {
  const dir = mkdtempSync(path.join(RUN_ROOT, 'synth-'))
  tmpRoots.push(dir)
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'synth-root', private: true, workspaces: ['src-app/libs/*'] }, null, 2),
  )
  const vizDir = path.join(dir, 'src-app', 'libs', 'viz')
  mkdirSync(path.join(vizDir, 'src', 'viz-core'), { recursive: true })
  writeFileSync(
    path.join(vizDir, 'package.json'),
    JSON.stringify({ name: '@txresbench/viz', version: '0.0.0', private: true }, null, 2),
  )
  cpSync(path.join(REPO, SPATIAL_REL), path.join(dir, SPATIAL_REL), { recursive: true })
  cpSync(path.join(REPO, 'src-app', 'packages'), path.join(dir, 'src-app', 'packages'), {
    recursive: true,
    filter: src => !src.includes('__pycache__'),
  })
  return dir
}

const read = (repo: string, rel: string) => readFileSync(path.join(repo, rel), 'utf8')
const write = (repo: string, rel: string, text: string) => writeFileSync(path.join(repo, rel), text)
/**
 * Replace the FIRST occurrence, and fail loudly if there is none — a silent no-op plant is a
 * vacuous control.
 *
 * It used to demand EXACTLY one, which made ~15 controls hostage to prose they do not own:
 * adding a second tag to a file (which the floor ratchet actively rewards) or reformatting a
 * README table reddened tests that have nothing to do with either. A plant needs to be
 * non-empty and to land somewhere definite; it does not need its anchor to be unique.
 */
function planted(repo: string, rel: string, from: string, to: string) {
  const before = read(repo, rel)
  const count = before.split(from).length - 1
  expect(count, `plant anchor \`${from}\` does not occur in ${rel}`).toBeGreaterThan(0)
  write(repo, rel, before.replace(from, to))
}
/** A tree that is GREEN, asserted — every plant below starts from one of these. */
function greenSynth(): string {
  const repo = synthRepo()
  const r = runGuard(repo)
  expect(r.status, `a pristine synthetic tree must be green:\n${r.stderr}`).toBe(0)
  return repo
}

describe('#277 — the viz-quoted producer magnitudes are bound to the producer', () => {
  it('TEST-7 the guard is WIRED: it runs against this repository, passes, and is chained from the package manifest', () => {
    const r = runGuard(REPO)
    expect(r.status, `guard stderr:\n${r.stderr}`).toBe(0)
    const m = /OK — (\d+) quoted magnitude\(s\) across (\d+) tagged site\(s\)/.exec(r.stdout)
    expect(m, `guard stdout:\n${r.stdout}`).toBeTruthy()
    expect(Number((m as RegExpExecArray)[1])).toBeGreaterThan(0)
    // the load-bearing invocation is the package manifest, not this file
    const pkg = JSON.parse(read(REPO, 'src-app/libs/viz/package.json'))
    expect(pkg.scripts.test).toContain('check-viz-producer-magnitudes.mjs')
  }, 120_000)

  it('TEST-9 every synthetic tree is GREEN before a defect is planted (the harness control)', () => {
    greenSynth()
  }, 120_000)

  it('TEST-2 [acceptance] [invariant: INV-2 — derived-guards.md §4 "assert the relation"] restates no magnitude of its own, and a producer-constant change reds it', () => {
    // (a) the guard is not a third copy of the numbers. The forbidden list is DERIVED from
    //     the guard's own output rather than hand-copied — a hand-copied blacklist quietly
    //     becomes an assertion that the guard lacks numbers nobody uses.
    const plan = JSON.parse(runGuard(REPO, ['--json']).stdout)
    const guardSource = readFileSync(GUARD, 'utf8')
    const magnitudes = [...Object.values(plan.live), ...Object.values(plan.frozen)] as number[]
    for (const v of magnitudes) {
      for (const digits of [5, 6, 12]) {
        const rendering = Number(v).toPrecision(Math.min(digits, 21))
        if (rendering.replace(/[.\-]/g, '').replace(/^0+/, '').length < 5) continue
        expect(guardSource, `the guard restates \`${rendering}\` instead of deriving it`).not.toContain(rendering)
      }
    }

    // (b) move the producer's constant and nothing else.
    const repo = greenSynth()
    planted(repo, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0')
    const r = runGuard(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/coordinateBinding\.ts:\d+/)
    expect(r.stderr).toContain('[producer-magnitude: microns_per_pixel]')
    expect(r.stderr).toContain('0.9509018149047883') // 70 / spot_diameter_fullres, derived not typed
  }, 180_000)

  it('TEST-15 [acceptance] [invariant: INV-1 — derived-guards.md §6 INV-1] derives WHICH constant the producer uses, so reverting #222 at the call site reds', () => {
    // #222 WAS a change of the symbol passed to micron_scale(rendered_spot_diameter_um=...).
    // A guard that names the post-#222 answer is vacuously green against a re-run of the very
    // defect it exists to catch, and the first cut of this guard was exactly that.
    //
    // #257 CHANGED THE CALL SITE'S SHAPE, and this test tracks it rather than being relaxed.
    // The numerator is now SELECTED per bundle from the producer's slide-design table, so the
    // call site passes an expression and there is no single symbol to read. The guard handles
    // both shapes and derives the expression shape by asking the producer's own selector; the
    // property asserted here is unchanged in both directions — reverting #222 at the call site
    // must still red, and an ambiguous derivation must still be fatal.
    const repo = greenSynth()
    expect(JSON.parse(runGuard(repo, ['--json']).stdout).numerator).toBe('VISIUM_RENDERED_SPOT_DIAMETER_UM')
    planted(
      repo,
      PRODUCER_REL,
      CALL_SITE_NUMERATOR,
      'rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM',
    )
    const r = runGuard(repo)
    expect(r.status, 'reverting #222 at the producer call site left the guard green').toBe(1)
    expect(JSON.parse(runGuard(repo, ['--json']).stdout).numerator).toBe('VISIUM_CAPTURE_SPOT_DIAMETER_UM')
    expect(r.stderr).toContain('[producer-magnitude: microns_per_pixel]')

    // …and the #257 shape's own equivalent: move the constant the SELECTED design carries, and
    // the guard must red because the RUN's magnitudes move.
    const sel = greenSynth()
    planted(sel, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0')
    const rs = runGuard(sel)
    expect(rs.status, 'moving the constant the SELECTED slide design carries left the guard green').toBe(1)
    expect(rs.stderr).toContain('[producer-magnitude: microns_per_pixel]')

    // …AND THE ONE THAT ACTUALLY BINDS THE EXPRESSION PATH. The leg above reds only because
    // the RUN's emitted magnitudes moved; it says nothing about the call site's CHOICE. This
    // one does, and it is the counter-example a blind audit used to prove the first cut of
    // the expression path had inverted this gate's invariant: a call site that picks the
    // slide design's diameter for the 65 um design and #222's CAPTURE diameter for every
    // other one applies the #222 defect to every CytAssist bundle — and the committed bundle
    // this gate runs is a 65 um design, so NO run it performs can see the divergence. It
    // exited 0, printing `numerator: VISIUM_RENDERED_SPOT_DIAMETER_UM`.
    //
    // Only the SHAPE can catch it, so the shape is what the gate checks: a bare NAME, or a
    // subscript of a name bound from `slide_design(...)`, and nothing else.
    const cond = greenSynth()
    planted(
      cond,
      PRODUCER_REL,
      CALL_SITE_NUMERATOR,
      'rendered_spot_diameter_um=(design["rendered_spot_diameter_um"]\n' +
        '            if design.get("id", "").endswith("65um-rendered-spot")\n' +
        '            else VISIUM_CAPTURE_SPOT_DIAMETER_UM)',
    )
    const rcond = runGuard(cond)
    expect(
      rcond.status,
      'a call site that applies the #222 capture diameter to every non-65um design left the guard GREEN',
    ).not.toBe(0)
    expect(rcond.stderr).toMatch(/passes an expression this gate does not recognise/)

    // …AND THE ONE THE SHAPE CHECK CANNOT SEE, which is why the gate no longer relies on it.
    // Re-binding `design` AFTER the licensing assignment leaves the call-site expression
    // byte-identical, so no syntactic rule can reject it — a blind audit defeated the shape
    // check with exactly this and the gate exited 0 while the producer applied #222's 55 um
    // capture diameter to every non-65um design. What catches it is behavioural: the gate now
    // RUNS every committed design and compares the numerator the producer APPLIED against the
    // one its own selector chooses for that bundle. This plant is that check's proof.
    const rebind = greenSynth()
    planted(
      rebind,
      PRODUCER_REL,
      '    design = slide_design(scalefactors)\n',
      '    design = slide_design(scalefactors)\n' +
        '    if not str(design.get("id", "")).endswith("65um-rendered-spot"):\n' +
        '        design = dict(design, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM)\n',
    )
    const rrb = runGuard(rebind)
    expect(
      rrb.status,
      're-binding `design` after the licensing assignment left the guard GREEN while the producer applied the capture diameter to every CytAssist design',
    ).not.toBe(0)
    expect(rrb.stderr).toMatch(/APPLIED a .* um numerator but its own slide_design\(\) selects/)

    // …and the same divergence hidden behind a helper, with the licensing call in DEAD CODE.
    const dead = greenSynth()
    planted(dead, PRODUCER_REL, '    design = slide_design(scalefactors)\n', '    design = _pick_numerator_record(scalefactors)\n')
    planted(
      dead,
      PRODUCER_REL,
      'def slide_design(scalefactors):',
      'def _pick_numerator_record(sf):\n' +
        '    d = slide_design(sf)\n' +
        '    if not str(d.get("id", "")).endswith("65um-rendered-spot"):\n' +
        '        d = dict(d, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM)\n' +
        '    return d\n\n\n' +
        'def _never_called_but_licenses_the_gate(sf):\n    design = slide_design(sf)\n    return design\n\n\n' +
        'def slide_design(scalefactors):',
    )
    const rdead = runGuard(dead)
    expect(rdead.status, 'a dead-code slide_design() call licensed the gate while a wrapper diverged').not.toBe(0)
    expect(rdead.stderr).toMatch(/APPLIED a .* um numerator but its own slide_design\(\) selects/)

    // …and the ACCEPTED shape is still narrow at the syntax level: renaming the local so it is
    // no longer bound from slide_design() is fatal, because then the subscript proves nothing.
    const unbound = greenSynth()
    planted(unbound, PRODUCER_REL, '    design = slide_design(scalefactors)', '    design_x = slide_design(scalefactors)\n    design = dict(design_x)')
    const runb = runGuard(unbound)
    expect(runb.status).not.toBe(0)
    expect(runb.stderr).toMatch(/passes an expression this gate does not recognise/)

    // and an AMBIGUOUS derivation is fatal rather than a guess — in BOTH shapes.
    const two = greenSynth()
    planted(
      two,
      PRODUCER_REL,
      '        scalefactors, ' + CALL_SITE_NUMERATOR + '\n',
      '        scalefactors, rendered_spot_diameter_um=VISIUM_RENDERED_SPOT_DIAMETER_UM\n' +
        '    ) if False else micron_scale(\n' +
        '        scalefactors, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM\n',
    )
    const rt = runGuard(two)
    expect(rt.status).not.toBe(0)
    expect(rt.stderr).toMatch(/expected exactly one symbol passed as micron_scale/)

    // …and a NAME alongside a per-bundle selection is the same ambiguity, the other way round.
    const mixed = greenSynth()
    planted(
      mixed,
      PRODUCER_REL,
      '        scalefactors, ' + CALL_SITE_NUMERATOR + '\n',
      '        scalefactors, ' + CALL_SITE_NUMERATOR + '\n' +
        '    ) if False else micron_scale(\n' +
        '        scalefactors, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM\n',
    )
    const rm = runGuard(mixed)
    expect(rm.status).not.toBe(0)
    expect(rm.stderr).toMatch(/expected exactly one symbol passed as micron_scale/)
  }, 480_000)

  it('TEST-14 [acceptance] [invariant: INV-2 — derived-guards.md §4] binds each claim to its own SCOPE, so SWAPPING the two eras reds', () => {
    // A whole-paragraph rule degenerates to "this block mentions both eras' numbers
    // somewhere", which is invariant under swapping which sentence claims which — and a
    // stale-era claim presented as current IS the #222/#258 defect.
    const a = greenSynth()
    planted(a, `${SPATIAL_REL}/coordinateBinding.ts`, 'DERIVES 5.0, 4.4149 and 0.88298', 'DERIVES 5.0, 3.7357 and 0.7471')
    planted(a, `${SPATIAL_REL}/coordinateBinding.ts`, '#158 measured 3.7357 and 0.7471', '#158 measured 4.4149 and 0.88298')
    const ra = runGuard(a)
    expect(ra.status, 'swapping the two eras in prose left the guard green').toBe(1)
    expect(ra.stderr).toMatch(/coordinateBinding\.ts:\d+/)

    // the same swap inside the README's era tables
    const b = greenSynth()
    planted(
      b,
      `${SPATIAL_REL}/fixtures/README.md`,
      '`3.7356857014116684` (= that scale over `tissue_hires_scalef`)',
      '`4.4149012834865164` (= that scale over `tissue_hires_scalef`)',
    )
    const rb = runGuard(b)
    expect(rb.status, 'swapping a value between the README era tables left the guard green').toBe(1)
    expect(rb.stderr).toContain('[frozen-magnitude: spatial-image-hires.original_resolution_um]')
  }, 240_000)

  it('TEST-12 D3 alone catches a claim whose value is wrong but unremarkable — the guard\'s central rule has its own control', () => {
    // Deliberately below D4's sweep threshold and D7's precision threshold, so ONLY D3 can
    // see it. Without this, D3's central branch could be deleted and the suite stay green.
    const repo = greenSynth()
    planted(
      repo,
      `${SPATIAL_REL}/fixtures/README.md`,
      '| hires `to_space[0]` | `5.0` — **unchanged**, it is `1/tissue_hires_scalef` |',
      '| hires `to_space[0]` | `9.0` — **unchanged**, it is `1/tissue_hires_scalef` |',
    )
    const r = runGuard(repo)
    expect(r.status).toBe(1)
    // D3 is the rule under test. The per-quantity floor speaks too, and correctly: a claim
    // whose scope no longer states the value at two significant digits stops DISTINGUISHING
    // anything, so that quantity's coverage really has fallen. Asserting D3 specifically is
    // what pins D3; asserting D3 ALONE would be asserting that the floors stay quiet, which is
    // not a property worth having.
    expect(rulesFired(r)).toContain('D3')
    expect(r.stderr).toContain('[producer-magnitude: spatial-image-hires.to_space[0]]')
  }, 120_000)

  it('TEST-13 D5 alone catches a producer constant stated beside a value with nothing checking it', () => {
    const repo = greenSynth()
    const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
    write(repo, rel, read(repo, rel) + '\n// VISIUM_RENDERED_SPOT_DIAMETER_UM is 65.0 in the producer today.\n')
    const r = runGuard(repo)
    expect(r.status, 'an unbound constant claim left the guard green').toBe(1)
    onlyRules(r, 'D5')
    expect(r.stderr).toContain('VISIUM_RENDERED_SPOT_DIAMETER_UM')
  }, 120_000)

  it('TEST-4 [acceptance] [invariant: INV-4 — derived-guards.md §6 INV-4] the marker cannot be used to relax the guard', () => {
    // (a) DELETING a tag does not make the site pass: the sweep fails the literal it left
    //     behind, and the floor fails the missing tag.
    const a = greenSynth()
    planted(
      a,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]\n',
      '',
    )
    const ra = runGuard(a)
    expect(ra.status, 'deleting a tag made the guard green — the marker is an opt-out').toBe(1)
    expect(rulesFired(ra)).toContain('D4')
    expect(rulesFired(ra)).toContain('D6')

    // (b) DELETING the tag AND rewriting the numbers — the shape a sweep alone cannot see,
    //     because a rotted magnitude matches nothing. The FLOOR is what closes it.
    const b = greenSynth()
    planted(
      b,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]\n',
      '',
    )
    planted(b, `${SPATIAL_REL}/omeTiffUnderlay.ts`, 'derives 4.4149 / 0.88298 / 5.0 today', 'derives 9.9999 / 1.234 / 5.0 today')
    const rb = runGuard(b)
    expect(rb.status, 'untagging AND falsifying a claim made the guard green').toBe(1)
    // The floors catch the untagging; D7 now also catches the falsified numbers, because it
    // ranges over the whole tagged PARAGRAPH rather than only from a tag line onward — without
    // that, MOVING a tag below the falsified sentence dodged everything.
    expect(rulesFired(rb)).toContain('D6')
    expect(rb.stderr).toMatch(/floor is \d+/)

    // (c) MIS-TAGGING a current claim as frozen is checked against the fixture and reds.
    const c = greenSynth()
    planted(
      c,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '[producer-magnitude: spatial-image-hires.original_resolution_um]',
      '[frozen-magnitude: spatial-image-lowres.original_resolution_um]',
    )
    const rc = runGuard(c)
    expect(rc.status, 'a current claim mis-tagged as frozen was accepted unchecked').toBe(1)
    expect(rc.stderr).toContain('[frozen-magnitude: spatial-image-lowres.original_resolution_um]')
  }, 300_000)

  it('TEST-5 [acceptance] [invariant: INV-5 — derived-guards.md §4 "a derivation whose two sides read the same source is a tautology"] producer, prose and fixture are each independently load-bearing', () => {
    const a = greenSynth()
    planted(a, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0')
    expect(runGuard(a).status, 'mutating ONLY the producer left the guard green').toBe(1)

    const b = greenSynth()
    planted(b, `${SPATIAL_REL}/coordinateBinding.ts`, '0.8829802566973034', '0.8829802566973999')
    const rb = runGuard(b)
    expect(rb.status, 'mutating ONLY the viz prose left the guard green').toBe(1)
    // D7 and D8 both catch this one, and both exist BECAUSE this leg caught the gate green on
    // earlier cuts: the scope still carried a shorter correct rendering, so D3 was satisfied,
    // and the corrupted literal matched no rule at all.
    onlyRules(rb, 'D7', 'D8')

    const c = greenSynth()
    planted(c, MANIFEST_REL, '"original_resolution_um": 12.452285671372229', '"original_resolution_um": 12.452285671379999')
    const rc = runGuard(c)
    expect(rc.status, 'mutating ONLY the committed fixture left the guard green').toBe(1)
    expect(rc.stderr).toContain('[frozen-magnitude: spatial-image-lowres.original_resolution_um]')
  }, 300_000)

  it('TEST-6 the .ome.tif OME-XML half is real: rewriting PhysicalSizeX in the TIFF BYTES reds it', () => {
    const repo = greenSynth()
    // The manifest is left ALONE — this plant moves only bytes inside the image, which is
    // the half `fixtures/README.md` used to declare unpinned ("see #277").
    const tif = path.join(repo, HIRES_TIF_REL)
    const bytes = readFileSync(tif)
    // BOTH axes, consistently — an X-only plant aborts on anisotropy (TEST-20's subject) and
    // never reaches the magnitude comparison this test is named for.
    for (const axis of ['X', 'Y']) {
      const from = Buffer.from(`PhysicalSize${axis}="3.7356857014116684"`, 'latin1')
      const to = Buffer.from(`PhysicalSize${axis}="3.7356857014119999"`, 'latin1')
      expect(to.length, 'the plant must not resize the TIFF').toBe(from.length)
      const at = bytes.indexOf(from)
      expect(at, `PhysicalSize${axis} not found in the committed hires TIFF`).toBeGreaterThan(-1)
      to.copy(bytes, at)
    }
    writeFileSync(tif, bytes)
    const r = runGuard(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/square pixels/)
    expect(r.stderr).toContain('[frozen-magnitude: spatial-image-hires.PhysicalSizeX]')
    expect(r.stderr).toMatch(/3\.7356857014119/)
  }, 120_000)

  it('TEST-20 an anisotropic PhysicalSize in the fixture bytes is fatal, not silently half-read', () => {
    const repo = greenSynth()
    const tif = path.join(repo, HIRES_TIF_REL)
    const bytes = readFileSync(tif)
    const from = Buffer.from('PhysicalSizeY="3.7356857014116684"', 'latin1')
    const to = Buffer.from('PhysicalSizeY="9.7356857014116684"', 'latin1')
    const at = bytes.indexOf(from)
    expect(at).toBeGreaterThan(-1)
    to.copy(bytes, at)
    writeFileSync(tif, bytes)
    const r = runGuard(repo)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/square pixels/)
  }, 120_000)

  it('TEST-17 the guard restates NO producer arithmetic — the live pitches come from the emitted manifest', () => {
    // This id used to cover a "cross-check" that compared two numbers BOTH read from the frozen
    // fixture — a tautology in the direction that matters, since the fixture is pinned pre-#222
    // and cannot move with the producer. It was retired rather than patched: the live side is
    // now what the importer actually EMITS, so there is no arithmetic of the guard's own left
    // to check. What replaces it is this, which the old shape could not have caught (TEST-23
    // drives the producer-side half):
    // (a) the guard's source performs no pitch arithmetic of its own
    const src = readFileSync(GUARD, 'utf8')
    expect(src, 'the guard divides a scale by a scalefactor — that is the producer\'s rule restated')
      .not.toMatch(/microns_per_pixel\s*\/\s*(float\()?scalef/)
    // (b) the emitted pitch really is read off the manifest the importer writes
    const plan = JSON.parse(runGuard(REPO, ['--json']).stdout)
    for (const id of Object.keys(plan.live)) {
      if (!id.endsWith('.original_resolution_um')) continue
      const image = id.replace('.original_resolution_um', '')
      expect(plan.live[`${image}.PhysicalSizeX`], `${image} has a pitch but no emitted OME pitch`)
        .toBeCloseTo(plan.live[id], 12)
    }
    // (c) and a frozen-side perturbation is still caught
    const repo = greenSynth()
    planted(repo, MANIFEST_REL, '"original_resolution_um": 12.452285671372229', '"original_resolution_um": 12.452285671379999')
    expect(runGuard(repo).status).toBe(1)
  }, 180_000)

  it('TEST-19 the affine comes from the PRODUCER package\'s own writer, not a same-named module in a sibling package', () => {
    // Every */compute goes on sys.path; with plain insertion order an alphabetically later
    // package's byte-identical ome_writer.py won, so the affine came from a package this
    // gate does not claim to bind.
    const baseline = JSON.parse(runGuard(REPO, ['--json']).stdout)
    const affineIds = Object.keys(baseline.live).filter(k => k.endsWith('.to_space[0]'))
    expect(affineIds.length).toBeGreaterThan(0)

    // (a) mutating a SIBLING package's byte-identical copy must change NOTHING
    const sibling = greenSynth()
    const sibRel = 'src-app/packages/spatial-types/compute/ome_writer.py'
    write(sibling, sibRel, read(sibling, sibRel).replace(
      'def emitted_affine(scalef, factor):',
      'def emitted_affine(scalef, factor):\n    return [42.0, 0.0, 0.0, 0.0, 42.0, 0.0]',
    ))
    const sibPlan = JSON.parse(runGuard(sibling, ['--json']).stdout)
    for (const id of affineIds) {
      expect(sibPlan.live[id], `a sibling package's ome_writer moved ${id}`).toBe(baseline.live[id])
    }
    expect(runGuard(sibling).status, "a sibling package's ome_writer reddened the gate").toBe(0)

    // (b) mutating the PRODUCER's own copy must move it — otherwise (a) proves only that
    //     neither copy is used
    const own = greenSynth()
    write(own, OME_WRITER_REL, read(own, OME_WRITER_REL).replace(
      'def emitted_affine(scalef, factor):',
      'def emitted_affine(scalef, factor):\n    return [42.0, 0.0, 0.0, 0.0, 42.0, 0.0]',
    ))
    const ownPlan = JSON.parse(runGuard(own, ['--json']).stdout)
    const moved = affineIds.some(id => ownPlan.live[id] !== baseline.live[id]) ||
      affineIds.some(id => !(id in ownPlan.live))
    expect(moved, "the producer package's own ome_writer did not drive the derivation").toBe(true)
  }, 120_000)

  it('TEST-1 [acceptance] [invariant: INV-1 — derived-guards.md §6 INV-1] DERIVES its set: a third vendor image joins with no edit, and an unknown id is fatal', () => {
    const a = greenSynth()
    const before = JSON.parse(runGuard(a, ['--json']).stdout)
    // captured, never hardcoded: a test asserting "a third vendor image joins with no edit"
    // must not itself be the edit a third vendor image requires
    const beforePitches = Object.keys(before.live).filter(k => k.endsWith('.original_resolution_um'))
    expect(beforePitches.length).toBeGreaterThan(0)

    // The id space follows the producer's own VENDOR_IMAGES table with no edit here. Renaming
    // an output_id is the end-to-end form of that: a row ADDED for an image the bundle does
    // not contain is correctly dropped BY THE IMPORTER, so adding one would test the fixture,
    // not the derivation.
    planted(a, PRODUCER_REL, '"output_id": "spatial-image-lowres"', '"output_id": "spatial-image-overview"')
    const after = JSON.parse(runGuard(a, ['--json']).stdout)
    const pitches = Object.keys(after.live).filter(k => k.endsWith('.original_resolution_um'))
    expect(pitches).toHaveLength(beforePitches.length)
    expect(pitches).toContain('spatial-image-overview.original_resolution_um')
    expect(pitches).not.toContain('spatial-image-lowres.original_resolution_um')
    // and the tags that named the old id now fail, rather than silently covering nothing
    const ra = runGuard(a)
    expect(ra.status).toBe(1)
    expect(ra.stderr).toMatch(/names a quantity the producer no longer derives/)
    // the bundle's inputs are derived too — every numeric key, not a hand-picked one
    expect(after.live['fiducial_diameter_fullres'], 'bundle inputs are hand-picked, not derived').toBeDefined()

    // (b) the tag vocabulary IS that derived set.
    const b = greenSynth()
    planted(
      b,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '[producer-magnitude: microns_per_pixel]',
      '[producer-magnitude: microns_per_furlong]',
    )
    const rb = runGuard(b)
    expect(rb.status).toBe(1)
    expect(rb.stderr).toMatch(/names a quantity the producer no longer derives/)
    expect(rb.stderr).toContain('microns_per_furlong')
  }, 300_000)

  it('TEST-3 [acceptance] [invariant: INV-3 — derived-guards.md §2 "a floor is the correct companion to a derived set"] is fail-closed everywhere', () => {
    // (i) python3 absent — the derivation is impossible, so the gate must fail, not skip.
    const bare = mkdtempSync(path.join(RUN_ROOT, 'nopath-'))
    tmpRoots.push(bare)
    const noPy = runGuard(REPO, [], { PATH: bare })
    expect(noPy.status, 'no python3 must be a hard failure, not a skip').not.toBe(0)
    expect(noPy.stderr).toMatch(/python3 is not on PATH/)
    expect(noPy.stdout).not.toMatch(/\bOK\b/)

    // (ii) the producer module refuses to import.
    const b = greenSynth()
    planted(b, PRODUCER_REL, 'import numpy as np', 'import numpy as np\nraise RuntimeError("planted")')
    const rb = runGuard(b)
    expect(rb.status).not.toBe(0)
    // the exact abort, not an alternation a sibling branch can absorb
    expect(rb.stderr).toMatch(/producer module did not import/)

    // (iii) the numerator is a symbol that is not one of the producer's own constants.
    //
    // The plant used to be "rename the constant away" — which reached this abort while the
    // call site named the constant directly, because python does not evaluate a call site at
    // import time. #257 made the producer's slide-design TABLE reference that constant at
    // MODULE level, so renaming it now fails at import and lands on a DIFFERENT abort. Both
    // are fail-closed, but a test that names one abort and drives another has stopped
    // covering the one it names. So the plant now does what the case is called: it points the
    // call site at a module-level symbol that exists and is not a `VISIUM_*_UM` constant.
    const c = greenSynth()
    planted(c, PRODUCER_REL, CALL_SITE_NUMERATOR, 'rendered_spot_diameter_um=QC_META_REASON_CHARS')
    const rc = runGuard(c)
    expect(rc.status).not.toBe(0)
    expect(rc.stderr, 'a bare non-zero exit is satisfied by any crash').toMatch(
      /is not a VISIUM_\*_UM constant/,
    )

    // (iii-b) …and the abort the OLD plant now reaches is itself driven, by its own message —
    // renaming the constant the table references is an import-time NameError, which is the
    // "producer module did not import" abort reached by a route (iii) no longer takes.
    const cb = greenSynth()
    planted(cb, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM_GONE = 65.0')
    const rcb = runGuard(cb)
    expect(rcb.status).not.toBe(0)
    expect(rcb.stderr).toMatch(/producer module did not import/)

    // (iii-c) the #257 abort: the producer SELECTS a numerator that maps to no named constant.
    // Reached by moving the selected design's diameter off every VISIUM_*_UM value while
    // leaving the module importable — the ambiguity guard on the expression path, which has
    // no counterpart on the name path and would otherwise be undriven.
    const cc = greenSynth()
    planted(cc, PRODUCER_REL, '"rendered_spot_diameter_um": VISIUM_RENDERED_SPOT_DIAMETER_UM,',
      '"rendered_spot_diameter_um": 61.5,')
    const rcc = runGuard(cc)
    expect(rcc.status).not.toBe(0)
    expect(rcc.stderr).toMatch(/maps to \d+ VISIUM_\*_UM constants/)

    // (iv) every tag stripped — the floor refuses an empty run.
    const d = greenSynth()
    for (const f of ['coordinateBinding.ts', 'omeTiffPyramid.ts', 'omeTiffUnderlay.ts',
      'coordinateBinding.test.ts', 'omeTiffPyramid.test.ts', 'omeTiffUnderlay.test.ts',
      'spotOverlayRegistration.test.ts', 'fixtures/README.md']) {
      const rel = `${SPATIAL_REL}/${f}`
      write(d, rel, read(d, rel).replace(/\[(producer|frozen)-magnitude:[^\]]*\]/g, ''))
    }
    const rd = runGuard(d)
    expect(rd.status, 'stripping every tag must breach the floor, not empty the gate').toBe(1)
    expect(rd.stderr).toMatch(/D6: .*floor is/)

    // (v) the scanned subtree is gone.
    const e = greenSynth()
    rmSync(path.join(e, SPATIAL_REL), { recursive: true, force: true })
    const re = runGuard(e)
    expect(re.status).not.toBe(0)
    // the distinguishing clause: `viz-core/spatial` alone is also in the missing-fixtures
    // abort, so matching it pinned neither
    expect(re.stderr).toMatch(/the scanned tree is gone/)

    // (v-b) and the fixtures directory alone, which that abort used to mask
    const g = greenSynth()
    rmSync(path.join(g, `${SPATIAL_REL}/fixtures`), { recursive: true, force: true })
    const rg = runGuard(g)
    expect(rg.status).not.toBe(0)
    expect(rg.stderr).toMatch(/the frozen half cannot be read/)

    // (vi) the floors are set AT the population, so removing ONE tagged file is caught —
    //      a floor at a fraction of the population detects only a collapse nobody commits.
    const f = greenSynth()
    rmSync(path.join(f, `${SPATIAL_REL}/omeTiffUnderlay.ts`))
    const rf = runGuard(f)
    expect(rf.status, 'deleting one tagged file did not breach any floor').toBe(1)
    expect(rf.stderr).toMatch(/floor is \d+/)
  }, 300_000)

  it('TEST-16 does NOT fire on correct code — the false-positive controls', () => {
    // A guard that reds on correct code gets disabled, which is worse than no guard. Each of
    // these was a real red on an earlier cut.
    const cases: Array<[string, string, string]> = [
      ['a full-precision unrelated double', `${SPATIAL_REL}/coordinateBinding.ts`,
        '\nexport const TAU_OVER_TWO = 3.141592653589793\n'],
      ['an ordinary four-digit number', `${SPATIAL_REL}/omeTiffPyramid.ts`,
        '\n// The tile cache holds 12.45 MB on average for this fixture.\n'],
      ['a bare constant mention stating no value', `${SPATIAL_REL}/omeTiffPyramid.ts`,
        '\n// See VISIUM_CAPTURE_SPOT_DIAMETER_UM for the pre-#222 numerator; not used here.\n'],
      ['a longer identifier CONTAINING a constant name', `${SPATIAL_REL}/omeTiffPyramid.ts`,
        '\n// The doc key VISIUM_CAPTURE_SPOT_DIAMETER_UM_NOTE is unrelated (1.5 of them).\n'],
      ['a JSDoc block followed by code', `${SPATIAL_REL}/omeTiffPyramid.ts`,
        '\n/**\n * A documented constant.\n */\nexport const UNRELATED_TOLERANCE = 0.0001\n'],
      ['issue references and a percentage', `${SPATIAL_REL}/omeTiffPyramid.ts`,
        '\n// issue refs #222 #258 #277 #1234 and a ratio of 18.18 percent\n'],
    ]
    for (const [what, rel, appended] of cases) {
      const repo = greenSynth()
      write(repo, rel, read(repo, rel) + appended)
      const r = runGuard(repo)
      expect(r.status, `the gate reddened on correct code: ${what}\n${r.stderr}`).toBe(0)
    }
    // and the RIGHT number written in exponent notation is accepted, not flagged as adrift
    const expo = greenSynth()
    planted(
      expo,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    #158 measured 3.7357 / 0.7471 / 5.0 on the pre-#222 emit.',
      '//    #158 measured 3.7357 / 0.7471 / 5.0 on the pre-#222 emit (3.7356857014116684e0).',
    )
    expect(runGuard(expo).status, 'exponent notation of a correct magnitude reddened the gate').toBe(0)
  }, 600_000)

  it('TEST-10 the fixtures README drift table is itself covered, in BOTH of its era tables', () => {
    const a = greenSynth()
    planted(a, `${SPATIAL_REL}/fixtures/README.md`, '`12.452285671372229`', '`12.452285671379999`')
    const ra = runGuard(a)
    expect(ra.status).toBe(1)
    expect(ra.stderr).toMatch(/README\.md:\d+/)

    const b = greenSynth()
    planted(b, `${SPATIAL_REL}/fixtures/README.md`, '`14.716337611621723`', '`14.716337611629999`')
    const rb = runGuard(b)
    expect(rb.status).toBe(1)
    expect(rb.stderr).toMatch(/README\.md:\d+/)
  }, 180_000)

  it('TEST-11 the read-only modes cannot become a silent no-op gate, and their output is not truncated', () => {
    const repo = synthRepo()
    planted(repo, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0')
    expect(runGuard(repo, ['--list']).status).toBe(0)
    const j = runGuard(repo, ['--json'])
    expect(j.status).toBe(0)
    // parses COMPLETELY: `process.exit()` does not flush an async pipe, and this output was
    // once truncated mid-token for a machine consumer
    const parsed = JSON.parse(j.stdout)
    expect(parsed.failures.length).toBeGreaterThan(0)
    expect(parsed.sites.length).toBeGreaterThan(0)
    expect(parsed).toHaveProperty('numerator')
    // … while the bare gate invocation over that same tree is red.
    expect(runGuard(repo).status).toBe(1)
    // an unknown flag is fatal rather than ignored (the `--report` no-op class)
    const bogus = runGuard(REPO, ['--repotr'])
    expect(bogus.status).not.toBe(0)
    expect(bogus.stderr).toMatch(/unknown flag/)
    // and so is a flag with a MISSING value, which otherwise silently means "the cwd"
    const noVal = spawnSync(process.execPath, [GUARD, '--repo'], { encoding: 'utf8', cwd: REPO })
    expect(noVal.status).not.toBe(0)
    expect(noVal.stderr).toMatch(/`--repo` requires a directory argument/)
  }, 180_000)

  it('TEST-21 EVERY floor is pinned individually, by its own message — not by whichever fires first', () => {
    // Four of the five floors could be set to 0, or have their `fail()` deleted, with the
    // suite fully green: the earlier controls asserted only `/floor is \d+/`, which any floor
    // satisfies, so the five masked each other. This is the guard's own advertised anti-dodge
    // ratchet, so each floor now has to say its own name.

    // (a) TAGGED files — deleting one that carries claims breaches it …
    const a = greenSynth()
    rmSync(path.join(a, `${SPATIAL_REL}/omeTiffUnderlay.ts`))
    const ra = runGuard(a)
    expect(ra.status).toBe(1)
    expect(ra.stderr).toMatch(/carry a magnitude tag, floor is \d+/)

    // … while deleting an UNTAGGED, magnitude-free file does NOT. The floor used to be the raw
    // file count, which is not derived from any declaration and shrinks legitimately: a
    // refactor reddened the magnitude gate and the only repair was editing the floor, which is
    // the "lowered as paperwork" pressure §5 names.
    const a2 = greenSynth()
    rmSync(path.join(a2, `${SPATIAL_REL}/binIndex.test.ts`))
    expect(runGuard(a2).status, 'removing an untagged, magnitude-free file reddened the gate').toBe(0)

    // (b) frozen quantities — drop one emitted image's bytes, which no tag names
    const b = greenSynth()
    rmSync(path.join(b, `${SPATIAL_REL}/fixtures/spatial-image-lowres.ome.tif`))
    const rb = runGuard(b)
    expect(rb.status).toBe(1)
    expect(rb.stderr).toMatch(/frozen quantities, floor\s+is \d+/)

    // (c) frozen sites — remove one DISTINGUISHING frozen claim. (Retagging a quantity both
    //     sides agree on no longer moves this floor: `to_space[0]` has one significant digit,
    //     so a tag over it is satisfied by any stray digit and is deliberately not counted —
    //     see the guard's note on one-significant-digit quantities.)
    const c = greenSynth()
    planted(
      c,
      `${SPATIAL_REL}/fixtures/README.md`,
      ' [frozen-magnitude: spatial-image-lowres.original_resolution_um]',
      '',
    )
    const rc = runGuard(c)
    expect(rc.status).toBe(1)
    // BOTH floors speak: the per-quantity one (which a tag over some other true statement
    // cannot pay for) and the aggregate one.
    expect(rc.stderr).toMatch(/is claimed by \d+ site\(s\), floor is \d+/)
    expect(rc.stderr).toMatch(/frozen-magnitude: \.\.\..*sites, floor is \d+/)

    // (c2) and padding with tags over OTHER true statements does not buy the deletion —
    //      the aggregate floors alone were payable that way.
    const c2 = greenSynth()
    planted(
      c2,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]\n',
      '',
    )
    planted(c2, `${SPATIAL_REL}/omeTiffUnderlay.ts`, '#158 measured 3.7357 / 0.7471 / 5.0', '#158 measured 9.9999 / 1.2345 / 5.0')
    write(
      c2,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      read(c2, `${SPATIAL_REL}/omeTiffUnderlay.ts`) +
        '\n// [frozen-magnitude: spatial-image-lowres.PhysicalSizeX]\n// pitch 12.452285671372229\n' +
        '\n// [frozen-magnitude: spatial-image-lowres.PhysicalSizeY]\n// pitch 12.452285671372229\n',
    )
    const rc2 = runGuard(c2)
    expect(rc2.status, 'padding with true tags paid for deleting a real claim').toBe(1)
    expect(rc2.stderr).toMatch(/is claimed by \d+ site\(s\), floor is \d+/)

    // (d) live quantities — remove a vendor-image row from the producer's own table
    const d = greenSynth()
    planted(
      d,
      PRODUCER_REL,
      '    {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",\n' +
        '     "role": "overview", "output_id": "spatial-image-lowres"},\n',
      '',
    )
    const rd = runGuard(d)
    expect(rd.status).toBe(1)
    expect(rd.stderr).toMatch(/the producer yielded \d+ derived quantities, floor is \d+/)

    // (e) producer sites — already pinned by TEST-4(b); assert its own message here too
    const e = greenSynth()
    planted(
      e,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]\n',
      '',
    )
    planted(e, `${SPATIAL_REL}/omeTiffUnderlay.ts`, 'derives 4.4149 / 0.88298 / 5.0 today', 'derives 9.9123 / 1.2345 / 5.0 today')
    expect(runGuard(e).stderr).toMatch(/producer-magnitude: \.\.\..*sites, floor is \d+/)
  }, 600_000)

  it('TEST-22 a tag vouches only for ITS OWN side and id — not for any magnitude near it', () => {
    // D4's and D5's coverage predicates could both be replaced by "some tag exists on this
    // line" with the suite green, which retires the whole "the site says WHICH claim it
    // makes" thesis on the sweep side.
    const a = greenSynth()
    // a FROZEN magnitude quoted inside a scope tagged only for the PRODUCER
    planted(
      a,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    For the committed vendor bundle the importer derives 4.4149 / 0.88298 / 5.0 today, i.e. a',
      '//    For the committed vendor bundle the importer derives 4.4149 / 0.88298 / 5.0 today\n' +
        '//    (the frozen fixture says 3.7356857014116684), i.e. a',
    )
    const ra = runGuard(a)
    expect(ra.status, 'a frozen magnitude inside a producer-only scope was vouched for').toBe(1)
    expect(rulesFired(ra)).toContain('D4')

    // and D5's binding: a constant named inside a scope tagged for the OTHER constant
    // D5 binds a name to a value the line STATES, so the plant goes where one is stated: the
    // scope that writes `VISIUM_CAPTURE_SPOT_DIAMETER_UM = 55.0` is retagged for the OTHER
    // constant, which must not vouch for it.
    const b = greenSynth()
    // anchored on the constants BLOCK, not on the tag text — that pair now appears at several
    // sites, and planting at the first would land somewhere this test says nothing about
    planted(
      b,
      `${SPATIAL_REL}/coordinateBinding.test.ts`,
      '  // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]\n' +
        '  // `src-app/packages/spatial-import-visium/compute/import_visium.py`:',
      '  // [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]\n' +
        '  // `src-app/packages/spatial-import-visium/compute/import_visium.py`:',
    )
    const rb = runGuard(b)
    expect(rb.status, 'a constant was covered by a tag naming a DIFFERENT constant').toBe(1)
    expect(rulesFired(rb)).toContain('D5')
  }, 300_000)

  it('TEST-23 the LIVE side is the producer\'s real OUTPUT — a change ANYWHERE on its emit path moves it', () => {
    // An earlier cut re-called ONE helper (`micron_scale`) with arguments of its own and then
    // restated the pitch rule, so everything the producer does downstream of that helper was
    // unverified. Both of these mutations left the gate green then.
    const a = greenSynth()
    planted(
      a,
      PRODUCER_REL,
      // Anchored on the SPACE CONSTRUCTOR rather than on the `micron_scale(...)` call, so the
      // injection point survives lines landing between the two — #257 put one there. What the
      // mutation says is unchanged: double the scale AFTER the helper and BEFORE the space is
      // built, i.e. somewhere the guard would miss if it re-called the helper instead of
      // reading the producer's real output.
      // The LEADING NEWLINE is load-bearing: the producer also builds a space at a deeper
      // indent inside `emit_images`, and a bare 4-space anchor matches INSIDE that one too —
      // `String.replace` takes the first hit, which would have planted the mutation in the
      // wrong function and left this test asserting a red it did not cause.
      '\n    space = SD.coordinate_space(',
      '\n    microns_per_pixel = microns_per_pixel * 2.0 if microns_per_pixel else microns_per_pixel\n' +
        '    space = SD.coordinate_space(',
    )
    expect(runGuard(a).status, 'doubling the scale DOWNSTREAM of micron_scale left the gate green').toBe(1)

    const b = greenSynth()
    planted(
      b,
      PRODUCER_REL,
      'microns_per_pixel / float(scalef) if microns_per_pixel is not None else None',
      'microns_per_pixel / float(scalef) * 2.0 if microns_per_pixel is not None else None',
    )
    expect(runGuard(b).status, 'changing the EMIT pitch rule left the gate green').toBe(1)

    // and the downsample factor, which the guard used to hardcode as 1
    const c = greenSynth()
    planted(
      c,
      'src-app/packages/spatial-import-visium/compute/spatial_declarations.py',
      'DEFAULT_RESOLUTION_CAP_UM = 0.5',
      'DEFAULT_RESOLUTION_CAP_UM = 100.0',
    )
    expect(runGuard(c).status, 'a downsample that changes to_space[0] left the gate green').toBe(1)
  }, 300_000)

  it('TEST-24 the numerator control cannot be switched off by a vendor-stated scale', () => {
    // `micron_scale` leg 1 returns a vendor-STATED microns_per_pixel verbatim, which makes the
    // AST-derived numerator dead code. One extra key in the bundle turned TEST-15's control
    // off entirely: the #222 revert then passed green.
    const repo = greenSynth()
    const sf = JSON.parse(read(repo, SCALEFACTORS_REL))
    sf.microns_per_pixel = 0.8829802566973034
    write(repo, SCALEFACTORS_REL, JSON.stringify(sf))
    const r = runGuard(repo)
    expect(r.status, 'a vendor-stated scale silently retired the derivation this gate controls').not.toBe(0)
    expect(r.stderr).toMatch(/not from the spot diameter/)
  }, 120_000)

  it('TEST-25 a NEAR MISS of a claimed magnitude is caught even when a longer correct copy sits beside it', () => {
    // D3 is satisfied by ANY rendering in scope, and these scopes carry both a short prose
    // form and the full-precision one — so corrupting the SHORT one was green: D3 was already
    // satisfied, D4 skips a literal matching nothing, D7 needs ten digits.
    const a = greenSynth()
    planted(a, `${SPATIAL_REL}/coordinateBinding.ts`, 'DERIVES 5.0, 4.4149 and 0.88298', 'DERIVES 5.0, 4.4249 and 0.88798')
    const ra = runGuard(a)
    expect(ra.status, 'corrupting the short rendering beside a correct long one was green').toBe(1)
    // D8 names it as a near miss; D7 also sees it now that the adrift threshold is 5, which is
    // deliberate — D8 alone left an 11% error green while catching a 0.02% one (sensitivity
    // inverted), so the two overlap on purpose in the band where prose is actually written.
    expect(rulesFired(ra)).toContain('D8')
    expect(ra.stderr).toMatch(/within .*% of that quantity/)

    // and a coarse rounding that IS valid is never a near miss (the "Nx error" aside)
    const b = greenSynth()
    expect(runGuard(b).status).toBe(0)
  }, 180_000)

  it('TEST-26 the claim-precision floor is real: a coarse aside cannot vouch for a precise quote', () => {
    // With MIN_CLAIM_SIG_DIGITS at 1 this passed: the three-digit "4.41x error if composed"
    // sitting one line below satisfied the tag on the five-digit pitch above it.
    const repo = greenSynth()
    planted(repo, `${SPATIAL_REL}/omeTiffUnderlay.ts`, 'derives 4.4149 / 0.88298 / 5.0 today', 'derives 4.4139 / 0.88298 / 5.0 today')
    const r = runGuard(repo)
    expect(r.status, 'a coarse aside vouched for a corrupted precise quote').toBe(1)
    expect(rulesFired(r)).toContain('D3')
  }, 120_000)

  it('TEST-27 a tag does not reach past the NEXT tag in its paragraph', () => {
    // The full-paragraph collapse is TEST-14's subject. This is the weaker mutant: a scope
    // that starts at its own tag but runs to the END of the paragraph, ignoring its sibling —
    // which makes a later scope's values available to an earlier tag.
    const repo = greenSynth()
    // remove the producer scope's own renderings; the FROZEN scope below still holds numbers,
    // and an unbounded scope would let them satisfy the producer tag
    planted(
      repo,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    For the committed vendor bundle the importer derives 4.4149 / 0.88298 / 5.0 today, i.e. a\n' +
        '//    4.41x error if composed.',
      '//    For the committed vendor bundle the importer derives a composed error, as below.',
    )
    const r = runGuard(repo)
    expect(r.status, "an emptied producer scope was satisfied by its sibling's numbers").toBe(1)
    expect(rulesFired(r)).toContain('D3')
  }, 120_000)

  it('TEST-28 the tokenizer keeps the SIGN, so a negated magnitude is not read as the correct one', () => {
    const repo = greenSynth()
    planted(
      repo,
      `${SPATIAL_REL}/coordinateBinding.ts`,
      '`65.0 / 73.61433 = 0.8829802566973034`',
      '`65.0 / 73.61433 = -0.8829802566973034`',
    )
    const r = runGuard(repo)
    expect(r.status, 'negating a quoted magnitude read as the correct value').toBe(1)
  }, 120_000)

  it('TEST-29 a tag LINE may not carry both sides for one quantity — that collapses the scope rule', () => {
    // Merging the two tags onto one line makes both range over the same lines, so the era swap
    // becomes invisible again: TEST-14's plant passed green through exactly this door.
    const repo = greenSynth()
    const rel = `${SPATIAL_REL}/coordinateBinding.ts`
    const lines = read(repo, rel).split('\n')
    const pi = lines.findIndex(l => l.startsWith('// [producer-magnitude: microns_per_pixel]'))
    const fi = lines.findIndex(l => l.startsWith('// [frozen-magnitude: microns_per_pixel]'))
    expect(pi, 'producer tag line not found').toBeGreaterThan(-1)
    expect(fi, 'frozen tag line not found').toBeGreaterThan(-1)
    lines[pi] = lines[pi] + ' ' + lines[fi].slice(3)
    lines.splice(fi, 1)
    write(repo, rel, lines.join('\n'))
    const r = runGuard(repo)
    expect(r.status, 'a tag line carrying both sides for one id was accepted').toBe(1)
    expect(r.stderr).toMatch(/carries BOTH/)
  }, 120_000)

  it('TEST-30 every documented "hard failure, never a skip" abort is actually driven, by its own message', () => {
    // Ten die() paths and five driver bail() paths were asserted by NOTHING — each a
    // documented fail-closed claim with no evidence behind it. A fail-closed path nobody
    // drives is exactly the "guard nobody invokes" family, one level down.
    const cases: Array<[string, (repo: string) => void, RegExp]> = [
      [
        'the root package.json is gone',
        r => rmSync(path.join(r, 'package.json')),
        /no root package.json/,
      ],
      [
        'the root package.json is not parseable',
        r => write(r, 'package.json', '{ not json'),
        /not parseable JSON/,
      ],
      [
        'the root declares no workspaces',
        r => write(r, 'package.json', JSON.stringify({ name: 'x', private: true })),
        /declares no `workspaces`; this gate would be vacuous/,
      ],
      [
        'a workspace glob this resolver does not understand',
        r => write(r, 'package.json', JSON.stringify({ name: 'x', private: true, workspaces: ['src-app/**/deep'] })),
        /is not one this gate understands/,
      ],
      [
        'the subject workspace is renamed away',
        r => {
          const pj = 'src-app/libs/viz/package.json'
          const j = JSON.parse(read(r, pj))
          j.name = '@txresbench/not-viz'
          write(r, pj, JSON.stringify(j))
        },
        /no workspace named `@txresbench\/viz`/,
      ],
      [
        'the producer package is gone',
        r => rmSync(path.join(r, 'src-app/packages/spatial-import-visium'), { recursive: true, force: true }),
        /no producer package at/,
      ],
      [
        'a scanned file is unreadable',
        r => {
          const f = path.join(r, `${SPATIAL_REL}/unreadable.ts`)
          writeFileSync(f, '// nothing\n')
          chmodSync(f, 0o000)
        },
        /could not read a scanned source file/,
      ],
      [
        'there is no single emitted-manifest fixture',
        r => cpSync(path.join(r, MANIFEST_REL), path.join(r, `${SPATIAL_REL}/fixtures/second-manifest-entries.json`)),
        /expected exactly one emitted-manifest fixture/,
      ],
      [
        // identified by CONTENT, so an unparseable or empty one simply is not a manifest and
        // the count abort fires — the same fail-closed outcome, one reachable abort instead of
        // three, two of which could never run
        'the emitted-manifest fixture is not parseable',
        r => write(r, MANIFEST_REL, '{ not json'),
        /expected exactly one emitted-manifest fixture/,
      ],
      [
        'the emitted-manifest fixture is empty',
        r => write(r, MANIFEST_REL, '[]'),
        /expected exactly one emitted-manifest fixture/,
      ],
      [
        'the producer module is gone',
        r => rmSync(path.join(r, PRODUCER_REL)),
        /no producer module at/,
      ],
      [
        'the producer module raises on import',
        r => planted(r, PRODUCER_REL, 'import numpy as np', 'import numpy as np\nraise RuntimeError("planted")'),
        /producer module did not import/,
      ],
      [
        'the vendor bundle is gone',
        r => rmSync(path.join(r, 'src-app/packages/spatial-import-visium/tests/fixtures'), { recursive: true, force: true }),
        /no scalefactors_json\.json under|did not import/,
      ],
      [
        "the producer package's own run harness is gone",
        r => rmSync(path.join(r, 'src-app/packages/spatial-import-visium/tests/visium_fixtures.py')),
        /own run harness .* did not import|no scalefactors/,
      ],
      [
        'the shipped importer raises over its own bundle',
        r => planted(r, PRODUCER_REL, 'def run_import(', 'def run_import(*_a, **_k):\n    raise RuntimeError("planted")\n\n\ndef _unused_run_import('),
        /the shipped importer failed over its own test bundle/,
      ],
      [
        'the run bundle stops matching the committed vendor bundle',
        r => planted(
          r,
          'src-app/packages/spatial-import-visium/tests/visium_fixtures.py',
          'def make_imaged(tmp_path, *, with_lowres=True, scalefactors_text=None,',
          'def make_imaged(tmp_path, *, with_lowres=True, scalefactors_text=(\n'
            + '        \'{"tissue_hires_scalef": 0.2, "tissue_lowres_scalef": 0.06, '
            + '"fiducial_diameter_fullres": 118.91545, "spot_diameter_fullres": 99.61433}\'),',
        ),
        /no longer running over the committed inputs|the run bundle/,
      ],
      [
        "the manifest's declared affine is anisotropic",
        r => {
          const entries = JSON.parse(read(r, MANIFEST_REL))
          entries[0].meta.to_space[4] = 8.5
          write(r, MANIFEST_REL, JSON.stringify(entries))
        },
        /declared affine is anisotropic/,
      ],
      [
        'the fixture declares two different micron scales for one space',
        r => {
          const entries = JSON.parse(read(r, MANIFEST_REL))
          entries[1].meta.microns_per_pixel = 0.5
          write(r, MANIFEST_REL, JSON.stringify(entries))
        },
        /two different `microns_per_pixel` values/,
      ],
      [
        'the producer declares no SCALEFACTORS_BASENAME',
        r => planted(r, PRODUCER_REL, 'SCALEFACTORS_BASENAME = "scalefactors_json.json"', 'SCALEFACTORS_BASENAME_GONE = "scalefactors_json.json"'),
        /declares no SCALEFACTORS_BASENAME|producer derivation FAILED/,
      ],
      [
        // the guard's message says "emitted no microns_per_pixel over its own bundle"; an
        // earlier alternation listed a phrase that appears nowhere in the guard and passed
        // through a sibling branch instead, leaving this abort undriven
        'the producer emits no micron scale at all',
        r => {
          const sf = JSON.parse(read(r, SCALEFACTORS_REL))
          delete sf.spot_diameter_fullres
          write(r, SCALEFACTORS_REL, JSON.stringify(sf))
        },
        /emitted no microns_per_pixel over its own bundle|not from the spot diameter/,
      ],
      [
        'the driver prints something that is not its JSON',
        r => planted(r, PRODUCER_REL, 'import numpy as np', 'import numpy as np\nprint("stray chatter")'),
        /produced no parseable JSON/,
      ],
    ]
    for (const [what, breakIt, expected] of cases) {
      const repo = greenSynth()
      breakIt(repo)
      const r = runGuard(repo)
      expect(r.status, `NOT fail-closed: ${what}\n${r.stdout}\n${r.stderr}`).not.toBe(0)
      expect(r.stderr, `wrong abort for: ${what}\n${r.stderr}`).toMatch(expected)
      expect(r.stdout, `reported OK while aborting: ${what}`).not.toMatch(/OK — \d+ quoted/)
    }

    // and `--repo` pointing at something that is not a directory. Spawned from a cwd that
    // DOES exist — otherwise the failure is the shell's, not the guard's, and the assertion
    // would pass for the wrong reason.
    const missing = spawnSync(
      process.execPath,
      [GUARD, '--repo', path.join(os.tmpdir(), 'viz-magnitudes-does-not-exist')],
      { encoding: 'utf8', cwd: REPO },
    )
    expect(missing.status).not.toBe(0)
    expect(missing.stderr ?? '').toMatch(/does not exist/)
  }, 900_000)

  it('TEST-31 a tag cannot be MOVED, REWORDED, or starved to make a branch pass', () => {
    // (a) MOVING a tag one sentence down un-covered the real claim while every floor, id and
    //     file count held. The sweep rule only fires on a literal that still MATCHES a derived
    //     value, so it is structurally blind to a falsified one — which is the whole defect
    //     class. The adrift rule therefore ranges over the whole tagged PARAGRAPH.
    const a = greenSynth()
    planted(
      a,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]\n' +
        '//    For the committed vendor bundle the importer derives 4.4149 / 0.88298 / 5.0 today, i.e. a\n' +
        '//    4.41x error if composed.',
      '//    For the committed vendor bundle the importer derives 4.4249 / 0.88798 / 5.0 today, i.e. a\n' +
        '//    4.42x error if composed.\n' +
        '//    [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]\n' +
        '//    (Reference values: space scale 0.8829802566973034, hires pitch 4.4149012834865164.)',
    )
    const ra = runGuard(a)
    expect(ra.status, 'moving a tag below the falsified sentence made the guard green').toBe(1)
    expect(rulesFired(ra)).toContain('D7')

    // (b) a value can be STATED many ways. An allowlist of connectives (`=`, `is`, `of`) let
    //     `NAME: 55.0`, `NAME -> 55.0`, `NAME (55.0)`, `NAME equals 55.0` and `NAME is now
    //     55.0` all through — a prose lint by another name, which is what this gate is not.
    for (const connective of [': 55.0', ' is now 55.0', ' (55.0)', ' -> 55.0', ' equals 55.0', ' stands at 55.0']) {
      const repo = greenSynth()
      const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
      write(repo, rel, read(repo, rel) + `\n// VISIUM_RENDERED_SPOT_DIAMETER_UM${connective} in the producer today.\n`)
      const r = runGuard(repo)
      expect(r.status, `a value stated as "NAME${connective}" was not bound`).toBe(1)
      expect(rulesFired(r)).toContain('D5')
    }
    //     …and the same evasion on a REAL site: swapping which constant has which value.
    const b = greenSynth()
    planted(b, `${SPATIAL_REL}/coordinateBinding.test.ts`, '`VISIUM_CAPTURE_SPOT_DIAMETER_UM = 55.0`', '`VISIUM_CAPTURE_SPOT_DIAMETER_UM`: 65.0')
    planted(b, `${SPATIAL_REL}/coordinateBinding.test.ts`, '`VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0`', '`VISIUM_RENDERED_SPOT_DIAMETER_UM`: 55.0')
    const rb = runGuard(b)
    expect(rb.status, 'swapping the two constants stated values was accepted').toBe(1)
    expect(rulesFired(rb)).toContain('D5')

    // (c) a floor must be SATISFIABLE by correcting the prose, not only by lowering itself.
    //     Counting a claim by the VALUE's precision rather than the CLAIM's deadlocked the
    //     moment a producer constant became a round number: a correct `70.0` could not count,
    //     so the floor stayed red with only §5's non-repair available.
    const c = greenSynth()
    planted(c, PRODUCER_REL, 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0', 'VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0')
    const starved = /VISIUM_RENDERED_SPOT_DIAMETER_UM.*claimed by 0 site/
    expect(runGuard(c).stderr, 'the round-number constant did not starve its floor').toMatch(starved)
    planted(c, `${SPATIAL_REL}/coordinateBinding.test.ts`, '`VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0`', '`VISIUM_RENDERED_SPOT_DIAMETER_UM = 70.0`')
    expect(
      runGuard(c).stderr,
      'correcting the prose could not satisfy the floor — only lowering it could',
    ).not.toMatch(starved)

    // (d) a THIRD producer constant moves no emitted magnitude, so it must not silently retire
    //     a derived quantity NOR redden the correct prose that quotes one. (The value is chosen
    //     not to collide with a micron quantity the prose already states — a constant that
    //     happens to equal one WOULD be asked for a tag, which is the stated cost of binding
    //     these by their unit.)
    const d = greenSynth()
    planted(
      d,
      PRODUCER_REL,
      'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0',
      'VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0\nVISIUM_FIDUCIAL_RING_DIAMETER_UM = 3000.0',
    )
    const rd = runGuard(d)
    expect(rd.status, `a third producer constant reddened correct prose:\n${rd.stderr}`).toBe(0)
  }, 900_000)

  it('TEST-32 a tag cannot be MINTED by repetition, and a scope may not state the other era\'s value', () => {
    // (a) writing the same tag token twice on one line counted as two claim sites — for the
    //     aggregate floors AND the per-quantity ones — so every floor was payable by repeating
    //     a token the scope already satisfies, and the summary line stayed byte-identical.
    const a = greenSynth()
    const before = JSON.parse(runGuard(a, ['--json']).stdout).sites.length
    planted(
      a,
      `${SPATIAL_REL}/coordinateBinding.ts`,
      '// [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]',
      '// [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]' +
        ' [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]',
    )
    const after = JSON.parse(runGuard(a, ['--json']).stdout).sites.length
    expect(after, 'repeating a tag token minted claim sites').toBe(before)

    //     …and the whole dodge it enabled: delete a real claim, falsify it, repay by repetition.
    planted(
      a,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]\n' +
        '//    #158 measured 3.7357 / 0.7471 / 5.0 on the pre-#222 emit. The two',
      '//\n//    #158 measured 9.1234 / 2.7182 / 5.0 on the pre-#222 emit. The two',
    )
    const ra = runGuard(a)
    expect(ra.status, 'a deleted claim was repaid by repeating a tag').toBe(1)
    expect(rulesFired(ra)).toContain('D6')

    // (b) a scope claiming one era may not STATE the other era's value for that quantity. The
    //     short prose form is where this hides: D3 is satisfied by the full-precision copy in
    //     the same scope, the sweep skips four digits, and the adrift rule counts the other
    //     era's number as "known" because it IS known — somewhere.
    const b = greenSynth()
    planted(b, `${SPATIAL_REL}/coordinateBinding.ts`, 'DERIVES 5.0, 4.4149 and 0.88298', 'DERIVES 5.0, 4.4149 and 0.7471')
    const rb = runGuard(b)
    expect(rb.status, "a producer scope quoting the FROZEN value was green").toBe(1)
    expect(rulesFired(rb)).toContain('D9')
    expect(rb.stderr).toMatch(/is the FROZEN fixture value for that quantity/)
  }, 300_000)

  it('TEST-33 the two spot diameters are bound where the prose actually writes them — beside a micron unit', () => {
    // They are written as bare INTEGERS next to a unit ("the 55 um capture footprint"), which
    // the sweep cannot see (too few digits), the adrift rule skips (integers), and the
    // name-binding rule cannot reach (no symbol on the line). So the one sentence that explains
    // #222 was the one thing unguarded, and swapping which diameter is which read as correct.
    const a = greenSynth()
    planted(a, `${SPATIAL_REL}/fixtures/README.md`, '= the 55 µm capture spot', '= the 65 µm capture spot')
    const ra = runGuard(a)
    expect(ra.status, 'swapping which spot diameter is which was green').toBe(1)
    expect(rulesFired(ra).join()).toMatch(/D3|D10/)

    // an UNTAGGED micron quantity that is one of the constants must be claimed, not ignored
    const b = greenSynth()
    const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
    write(b, rel, read(b, rel) + '\n// The capture footprint is 55 µm across on this slide.\n')
    const rb = runGuard(b)
    expect(rb.status, `stderr:\n${rb.stderr}`).toBe(1)
    expect(rulesFired(rb), `stderr:\n${rb.stderr}`).toContain('D10')

    // …but an unrelated micron quantity is NOT a constant claim and must stay green
    const c = greenSynth()
    write(c, rel, read(c, rel) + '\n// The tile margin is 12 µm on every level.\n')
    expect(runGuard(c).status, 'an unrelated micron quantity reddened the gate').toBe(0)
  }, 300_000)

  it('TEST-34 the LIVE OME-XML read is load-bearing, not decorative', () => {
    // Nothing named the emitted pitch, nothing floored it, and nothing compared it to the
    // manifest — so the producer could double it, make it anisotropic, or fail to write the
    // blob at all, and the gate stayed green while the viz prose's "PhysicalSizeX is
    // microns_per_pixel over the scalefactor, by construction" became false about it.
    const OME = 'src-app/packages/spatial-import-visium/compute/ome_writer.py'
    const a = greenSynth()
    write(a, OME, read(a, OME).replace('"PhysicalSizeX": scale', '"PhysicalSizeX": scale * 2.0')
      .replace('"PhysicalSizeY": scale', '"PhysicalSizeY": scale * 2.0'))
    const ra = runGuard(a)
    expect(ra.status, 'doubling the EMITTED OME pitch left the gate green').not.toBe(0)
    expect(ra.stderr).toMatch(/disagree for|PhysicalSize/)

    const b = greenSynth()
    write(b, OME, read(b, OME).replace('"PhysicalSizeY": scale', '"PhysicalSizeY": scale * 3.0'))
    const rb = runGuard(b)
    expect(rb.status, 'an anisotropic EMIT left the gate green').not.toBe(0)
    expect(rb.stderr).toMatch(/anisotropic pitch|square pixels/)
  }, 300_000)

  it('TEST-35 round-5: the tokenizer, the unit, the name and the OME payload cannot be spelled around', () => {
    // Each of these made a viz claim FALSE with the gate at exit 0.
    const cases: Array<[string, (r: string) => void, string]> = [
      [
        // `.7471` produced NO token at all, so the frozen value could be stated inside a
        // producer-tagged scope — literally the defect the era rule exists for
        'a leading-dot decimal',
        r => planted(r, `${SPATIAL_REL}/coordinateBinding.ts`, 'DERIVES 5.0, 4.4149 and 0.88298', 'DERIVES 5.0, 4.4149 and .7471'),
        'D9',
      ],
      [
        // the unit rule fired only on a CORRECT value, so a WRONG micron integer beside the
        // unit — the exact sentence #222 changed — was invisible to every rule
        'a wrong micron integer inside a constant claim',
        r => planted(r, `${SPATIAL_REL}/coordinateBinding.ts`, 'the RENDERED spot diameter (65 µm)', 'the RENDERED spot diameter (68 µm)'),
        'D10',
      ],
      [
        // U+03BC, visually identical to U+00B5 and what most copy-paste produces
        'the Greek mu spelling',
        r => {
          const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
          write(r, rel, read(r, rel) + '\n// The capture footprint is 55 \u03bcm across on this slide.\n')
        },
        'D10',
      ],
      [
        // the name rule bound only the FIRST occurrence on the line
        'a second occurrence of the name on one line',
        r => {
          const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
          write(r, rel, read(r, rel) +
            '\n// VISIUM_RENDERED_SPOT_DIAMETER_UM names the rendered spot; VISIUM_RENDERED_SPOT_DIAMETER_UM = 55.0 today.\n')
        },
        'D5',
      ],
    ]
    for (const [what, plant, rule] of cases) {
      const repo = greenSynth()
      plant(repo)
      const r = runGuard(repo)
      expect(r.status, `NOT caught: ${what}\n${r.stderr}`).toBe(1)
      expect(rulesFired(r), `wrong rule for: ${what}\n${r.stderr}`).toContain(rule)
    }

    // the deletion dodge: remove a tag, leave a bare `//` so the falsified sentence sits in no
    // scope, and repay both per-quantity floors with true one-line claims elsewhere
    const del = greenSynth()
    planted(
      del,
      `${SPATIAL_REL}/omeTiffUnderlay.ts`,
      '//    [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]\n' +
        '//    #158 measured 3.7357 / 0.7471 / 5.0 on the pre-#222 emit. The two',
      '//\n//    #158 measured 9.1234 / 2.7182 / 5.0 on the pre-#222 emit. The two',
    )
    const relU = `${SPATIAL_REL}/omeTiffUnderlay.ts`
    write(del, relU, read(del, relU) +
      '\n// [frozen-magnitude: microns_per_pixel] 0.7471371402823337\n' +
      '// [frozen-magnitude: spatial-image-hires.original_resolution_um] 3.7356857014116684\n')
    const rd = runGuard(del)
    expect(rd.status, 'deleting a claim and repaying the floors with true statements was green').toBe(1)
    expect(rulesFired(rd)).toContain('D7')

    // repeating a tag on CONSECUTIVE LINES minted sites (de-duplication was per-line only)
    const mint = greenSynth()
    const before = JSON.parse(runGuard(mint, ['--json']).stdout).sites.length
    const relC = `${SPATIAL_REL}/coordinateBinding.ts`
    write(mint, relC, read(mint, relC) +
      '\n// [frozen-magnitude: microns_per_pixel] 0.7471371402823337\n'.repeat(1) +
      '// [frozen-magnitude: microns_per_pixel] 0.7471371402823337\n'.repeat(5))
    expect(JSON.parse(runGuard(mint, ['--json']).stdout).sites.length,
      'repeating a tag on consecutive lines minted claim sites').toBe(before + 1)
  }, 600_000)

  it('TEST-36 round-5: correct code the gate must NOT red', () => {
    const cases: Array<[string, (r: string) => void]> = [
      // splitting a long multi-tag line is a formatter's job, not a defect. It used to give the
      // first tag a scope of exactly itself and blame a blank line that was not there.
      ['a multi-tag line wrapped onto two lines', r => {
        const rel = `${SPATIAL_REL}/coordinateBinding.ts`
        const src = read(r, rel)
        const line = src.split('\n').find(l => l.startsWith('// [producer-magnitude: microns_per_pixel]')) as string
        expect(line, 'the multi-tag line moved').toBeTruthy()
        const tags = [...line.matchAll(/\[[a-z]+-magnitude: [^\]]+\]/g)].map(m => m[0])
        expect(tags.length).toBeGreaterThan(1)
        write(r, rel, src.replace(line, `// ${tags.slice(0, 2).join(' ')}\n// ${tags.slice(2).join(' ')}`))
      }],
      // a design-section citation is not a measurement, and this codebase writes them constantly
      ['a section citation', r => {
        const rel = `${SPATIAL_REL}/omeTiffUnderlay.ts`
        write(r, rel, read(r, rel).replace(
          '//    For the committed vendor bundle the importer derives',
          '//    See §12.2 and §4.19 for the ruling. For the committed vendor bundle the importer derives',
        ))
      }],
      // an unrelated micron measurement, nowhere near a constant claim
      ['an unrelated micron quantity', r => {
        const rel = `${SPATIAL_REL}/omeTiffPyramid.ts`
        write(r, rel, read(r, rel) + '\n// The tile margin is 12 µm on every level.\n')
      }],
    ]
    for (const [what, plant] of cases) {
      const repo = greenSynth()
      plant(repo)
      const r = runGuard(repo)
      expect(r.status, `the gate reddened on correct code: ${what}\n${r.stderr}`).toBe(0)
    }
  }, 600_000)

  it('TEST-40 [acceptance] [invariant: INV-6 — derived-guards.md §2, "a floor … fail-closed when the derived set collapses … is the correct companion to a derived set"] a DECLARATION this gate cannot read is a hard failure, never a silent narrowing of its subject set', () => {
    // The guard hardening and the tests moved in opposite directions once: the id type-check
    // and the widened declaration-parse were added with no control, and neutering either
    // (`if False:`) survived the whole battery. Both are now driven, each by its own message.
    //
    // The id check matters BOTH ways round, which is the point. Without it a declaration
    // missing its id put `None` into the derived set — making the empty-set abort unreachable
    // and the membership test match every entry carrying no datatype. With it as a `continue`
    // it did the opposite: narrowed this gate's subject set silently and green, so only a
    // TOTAL collapse was ever caught. Neither is acceptable; it aborts.

    // (i) a datatype declaring the exact raster shape, with no id
    const a = greenSynth()
    const kindA = emittedRasterKind(a, derivedSets(a).raster)
    const relA = declaringManifest(a, kindA)
    // Indentation DERIVED from the declaration it sits beside — the one un-derived premise
    // this test had. A hard-coded depth silently produces a differently-nested document, and
    // the test then reds on the malformed-parse path instead of the id path it is written for.
    const declLine = read(a, relA).split('\n').find(l => l.trim() === `- id: ${kindA}`) as string
    const pad = declLine.slice(0, declLine.indexOf('-'))
    planted(a, relA, declLine,
      `${pad}- title: a declaration with no id\n` +
      `${pad}  storage:\n` +
      `${pad}    layout: { kind: opaque_as_is }\n` +
      `${pad}    format: ome-tiff\n` +
      `${pad}    file_layout: single\n` +
      declLine)
    const ra = runGuard(a)
    expect(ra.status, `an unreadable declaration must ABORT, not be skipped:\n${ra.stdout}`).toBe(1)
    expect(ra.stderr).toContain('declares a datatype with no string id')

    // (i-b) an id that is PRESENT but not a string. This is the case that pins
    //       `isinstance(..., str)` rather than mere truthiness: weaken the check to
    //       `is None` or `not dt.get("id")` and a numeric id sails past it into `sorted()`,
    //       which dies with the bare `TypeError: '<' not supported between instances of
    //       'int' and 'str'` — precisely the unstructured failure the check was added to
    //       replace. Without this case that weakening is invisible.
    const ab = greenSynth()
    const kindAb = emittedRasterKind(ab, derivedSets(ab).raster)
    const relAb = declaringManifest(ab, kindAb)
    const declAb = read(ab, relAb).split('\n').find(l => l.trim() === `- id: ${kindAb}`) as string
    const padAb = declAb.slice(0, declAb.indexOf('-'))
    planted(ab, relAb, declAb,
      `${padAb}- id: 12345\n` +
      `${padAb}  storage:\n` +
      `${padAb}    layout: { kind: opaque_as_is }\n` +
      `${padAb}    format: ome-tiff\n` +
      `${padAb}    file_layout: single\n` +
      declAb)
    const rab = runGuard(ab)
    expect(rab.status, `a non-string id must ABORT:\n${rab.stdout}`).toBe(1)
    expect(rab.stderr, 'a non-string id fell through to an unstructured failure')
      .toContain('declares a datatype with no string id')
    expect(rab.stderr, 'the abort must not be a bare interpreter traceback')
      .not.toMatch(/TypeError: '<' not supported/)

    // (ii) a `datatypes:` entry that is not a mapping at all — the shape assumption that used
    //      to sit OUTSIDE the try and collapsed into the caller's generic no-parseable-JSON die
    const b = greenSynth()
    const kindB = emittedRasterKind(b, derivedSets(b).raster)
    const relB = declaringManifest(b, kindB)
    const declB = read(b, relB).split('\n').find(l => l.trim() === `- id: ${kindB}`) as string
    const padB = declB.slice(0, declB.indexOf('-'))
    planted(b, relB, declB, `${padB}- not-a-mapping\n${declB}`)
    const rb = runGuard(b)
    expect(rb.status).toBe(1)
    expect(rb.stderr).toContain('does not read as a datatype declaration')
    expect(rb.stderr, 'the abort must name the exception it caught, not just fail')
      .toMatch(/AttributeError/)
    // and NOT the generic driver-died message the widened try exists to replace
    expect(rb.stderr).not.toContain('produced no parseable JSON')
  }, 300_000)

  it('TEST-41 [acceptance] [invariant: INV-6 — derived-guards.md §2, "a floor … fail-closed when the derived set collapses … is the correct companion to a derived set"] a kind DECLARED a single opaque ome-tiff blob but not emitted as one reds — ALL THREE per-entry paths — and each message names the DECLARATION to repair', () => {
    // The branch's stated behavioural decision made executable rather than asserted in prose:
    // membership in the derived set is not passive, so an entry that is in it and does not
    // carry readable OME bytes is a HARD failure. Replacing these bails with `continue`
    // previously survived the entire battery — all three of them, which is why all three are
    // driven here and not just the one that was easiest to plant.
    //
    // Each case also pins the DIAGNOSIS, which is the half that was wrong. The messages used
    // to name only the producer's OUTPUT entry id while telling the reader to check the
    // declaration — and no manifest mentions that id, so they sent the repairer to the right
    // file with a key that is not in it. `spatial/…`-style datatype ids are not substrings of
    // the output entry id, so `toContain(kind)` genuinely requires the datatype in the text.
    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      // no `path` field at all — the entry cannot even be located
      ['no path', PRODUCER_REL, 'DT_SPATIAL_IMAGE, rel, "artifact"',
        'DT_SPATIAL_IMAGE, None, "artifact"'],
      // a path the writer did not write
      ['blob absent', PRODUCER_REL, 'DT_SPATIAL_IMAGE, rel, "artifact"',
        'DT_SPATIAL_IMAGE, rel + ".never-written", "artifact"'],
      // the blob exists and carries no OME payload: the real writer runs, then the bytes are
      // replaced, so the manifest and the file agree on everything except the payload
      ['no <OME> block', OME_WRITER_REL, 'def write_ome_tiff(dest, arr, *, placement, codec=CODEC,',
        'def write_ome_tiff(dest, arr, **kw):\n' +
        '    r = _real_write_ome_tiff(dest, arr, **kw)\n' +
        "    open(dest, 'wb').write(b'no OME payload')\n" +
        '    return r\n\n\n' +
        'def _real_write_ome_tiff(dest, arr, *, placement, codec=CODEC,'],
    ] as const
    const expected = ['no path field', 'which it did not write', 'carries no <OME> block']

    cases.forEach(([what, rel, from, to], n) => {
      const repo = greenSynth()
      const kind = emittedRasterKind(repo, derivedSets(repo).raster)
      // the anchor must be UNIQUE, or `planted()` silently rewrites whichever site comes
      // first and the case stops testing what it names
      expect(read(repo, rel).split(from).length - 1, `${what}: plant anchor is not unique`).toBe(1)
      planted(repo, rel, from, to)
      const r = runGuard(repo)
      expect(r.status, `${what}: a declared raster blob the producer did not emit as one must red:\n${r.stdout}`).toBe(1)
      expect(r.stderr, `${what}: wrong abort`).toContain(expected[n])
      expect(r.stderr, `${what}: the diagnosis names no datatype, so it cannot point at a declaration`)
        .toContain(kind)
      // …and naming the token is not enough: a message that merely RECITED the derived set
      // would contain it. The diagnosis has to send the reader to the declaration, which is
      // where the repair lives — that is the whole content of the fix, so it is what is pinned.
      expect(r.stderr, `${what}: the diagnosis names the datatype but not where to repair it`)
        .toContain(`the manifest that declares '${kind}'`)
    })
  }, 600_000)

  it('TEST-42 this battery cannot leak: every temp tree it makes is nested under the ONE run root, and nothing creates one outside it', () => {
    // The complement to the `afterAll` assertion. That one catches "the root survived"; this
    // one catches the way a leak actually gets REINTRODUCED — a new `mkdtempSync` site added
    // later that goes straight to `os.tmpdir()` and is therefore outside the single path
    // cleanup removes. Derived from this file's own source, so a site added tomorrow is
    // covered tomorrow without editing this test.
    //
    // Why this is asserted at all: the leak that motivated it (15,038 directories, ~220 GB,
    // build box at 100%) lived under a battery of 40 passing tests for months. Not one of
    // them observed what the suite left on disk. A green suite that cannot see its own side
    // effects is how that happens, and a human counting `/tmp` cannot fix it — a shared
    // `/tmp` gained 45 `viz-magnitudes-*` directories in 60 seconds from OTHER agents' runs
    // while this was being investigated, so an external count cannot even attribute a tree
    // to a run. The suite has to watch itself.
    const self = readFileSync(path.join(HERE, 'producerMagnitudes.test.ts'), 'utf8')
    // The ARGUMENT of each call, taken as the rest of its line — nested parens make a
    // `[^)]*` capture stop at `os.tmpdir(` and silently match nothing, which is how the
    // first cut of this test passed while proving less than it claimed.
    const sites = self
      .split('\n')
      .filter(l => /(^|[^'"\w])mkdtempSync\(/.test(l))          // a real CALL, not the name in a string
      .filter(l => !l.trimStart().startsWith('//'))              // not a comment
      .filter(l => !l.includes("from 'node:fs'"))                // not the import
      .filter(l => !/['"]mkdtempSync\(/.test(l))                 // not this scanner quoting itself
      .map(l => l.slice(l.indexOf('mkdtempSync(') + 12).trim())
    expect(sites.length, 'no mkdtempSync site found — this scan derived nothing').toBeGreaterThanOrEqual(3)

    // Exactly ONE site may name os.tmpdir(): the run root itself.
    const atTmpdir = sites.filter(a => a.includes('os.tmpdir()'))
    expect(atTmpdir.length,
      'a temp tree is created directly in os.tmpdir() instead of under RUN_ROOT — cleanup ' +
        'removes ONE path, so anything outside it leaks, and it cannot be attributed to ' +
        `this run. Sites: ${JSON.stringify(atTmpdir)}`,
    ).toBe(1)
    expect(atTmpdir[0], 'the one os.tmpdir() site is not the run root').toContain('viz-magnitudes-run-')
    // …and every other site must nest under the run root.
    for (const site of sites.filter(a => !a.includes('os.tmpdir()'))) {
      expect(site, `temp tree site is not nested under RUN_ROOT: ${site}`).toContain('RUN_ROOT')
    }

    // And the root really is where the trees land, checked by BUILDING one rather than by
    // reading the code that builds them.
    const made = synthRepo()
    expect(made.startsWith(RUN_ROOT + path.sep), `${made} is not under ${RUN_ROOT}`).toBe(true)
    expect(existsSync(made)).toBe(true)
  }, 120_000)

  it('TEST-8 the guard itself is PINNED, so it cannot be weakened silently', () => {
    const manifest = read(REPO, 'scripts/guard-hashes.txt')
    const entry = manifest.split('\n').find(l => l.includes('scripts/check-viz-producer-magnitudes.mjs'))
    expect(entry, 'the guard is absent from scripts/guard-hashes.txt').toBeTruthy()
    const recorded = (entry as string).trim().split(/\s+/)[0]
    const sha = spawnSync('sha256sum', [GUARD], { encoding: 'utf8' })
    expect((sha.stdout ?? '').trim().split(/\s+/)[0], 'the pinned hash does not match the guard on disk').toBe(recorded)

    // NOTE the whole-repo `check-guard-integrity.sh` sweep is deliberately NOT run here. It
    // verifies every pinned guard in the repository, so an unrelated in-flight edit to any
    // other `scripts/check-*` file would red this viz spec for a reason that has nothing to do
    // with viz. Its caller is `just check-invariants`; what belongs here is this guard's own
    // pin, asserted above.
  }, 60_000)

  // ── #303 — the guard's SUBJECT SET is derived, so it carries no domain vocabulary ──────
  //
  // #277 shipped this guard with `e.get("datatype") != "<a spatial kind id>"` written into its
  // driver. That one literal made a domain kind id part of an app-core surface, which is what
  // `spatial-types`' own acceptance test forbids (`test_a_new_kind_costs_zero_core_code`) and
  // what `derived-guards.md` §1 tabulates as the `check-kinds-zero-core.sh` failure class. The
  // repair is a derivation, never an allowlist entry (§5 names the enumerating repair by name).
  //
  // These three controls are the executable half of that. They never SPELL a kind id: this file
  // has no `tests/` path segment, so it sits inside the very surface that scan reads, and a
  // literal here would re-open the leak one directory over. Every id below is derived the same
  // way the guard derives it — out of the contributed declarations, read back from `--json`.

  /**
   * What the guard DERIVED on `repo`, read from its own report.
   *
   * It asserts a REPORT came back, and nothing about greenness — deliberately, in both
   * directions. A status check would establish nothing (`--json` serialises `failures` into
   * the report and then reaches `process.exit(0)` UNCONDITIONALLY — one line in the guard, so
   * it is 0 on a tree where every rule is failing). And a `failures` check would be worse than
   * redundant: `greenSynth()` has already asserted exit 0 on the synthetic trees, while on the
   * REAL repo it would couple this helper — and therefore TEST-39 — to every unrelated
   * magnitude claim under `viz-core/spatial`. The derived VOCABULARY does not depend on
   * whether those claims currently agree with the producer.
   *
   * And the load-bearing reason, which the first version of this note left out: TEST-38's
   * per-leg cases call this AFTER a plant, on trees that necessarily carry D6 failures. A
   * greenness assertion here would not merely be redundant there — it would make those cases
   * impossible to write.
   */
  function derivedSets(repo: string): { raster: string[]; contributed: string[] } {
    const r = runGuard(repo, ['--json'])
    expect(r.stdout, `--json produced no report:\n${r.stderr}`).not.toBe('')
    const j = JSON.parse(r.stdout)
    expect(Array.isArray(j.raster_datatypes) && j.raster_datatypes.length > 0,
      'the guard reported no derived subject set at all').toBe(true)
    expect(j.contributed_datatypes.length,
      'the contributed vocabulary collapsed, so every assertion below would be vacuous',
    ).toBeGreaterThanOrEqual(20)
    return { raster: j.raster_datatypes, contributed: j.contributed_datatypes }
  }

  /** The one declared raster kind the producer actually CONSTRUCTS. Derived, not chosen. */
  function emittedRasterKind(repo: string, raster: string[]): string {
    const src = read(repo, PRODUCER_REL)
    const hit = raster.filter(id => src.includes(`"${id}"`))
    expect(hit, `exactly one declared raster kind must be constructed by ${PRODUCER_REL}`).toHaveLength(1)
    return hit[0]
  }

  /** The manifest that DECLARES `id`, located by its declaration rather than by package name. */
  function declaringManifest(repo: string, id: string): string {
    const pkgs = path.join(repo, 'src-app', 'packages')
    for (const e of readdirSync(pkgs, { withFileTypes: true })) {
      const rel = `src-app/packages/${e.name}/manifest.yaml`
      if (!e.isDirectory() || !existsSync(path.join(repo, rel))) continue
      if (read(repo, rel).includes(`- id: ${id}`)) return rel
    }
    throw new Error(`no manifest under src-app/packages declares ${id}`)
  }

  /** `check-derived-vocabulary.sh`'s compound-id token boundary, which is also the one
   *  `test_a_new_kind_costs_zero_core_code` uses — so TEST-39 asserts the same property the
   *  owning test does, over this one file. */
  function boundedHits(text: string, term: string): number {
    let hits = 0
    for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + 1)) {
      const l = i > 0 ? text[i - 1] : ''
      const r = i + term.length < text.length ? text[i + term.length] : ''
      if (!/[A-Za-z0-9_-]/.test(l) && !/[A-Za-z0-9_-]/.test(r)) hits++
    }
    return hits
  }


  /**
   * Rewrite the first line matching `needle` inside `kind`'s OWN declaration block.
   *
   * The block END is bounded by the next `- id:` line, not by EOF. Without that bound the
   * scan runs on into the SIBLING declaration and mutates it while every failure message
   * still names `kind` — latent here only because these needles happen to sit ahead of the
   * next block, which is exactly the kind of accident that stops being true after an edit.
   */
  function plantInDecl(repo: string, rel: string, kind: string, needle: string, to: string) {
    const lines = read(repo, rel).split('\n')
    const i = lines.findIndex(l => l.trim() === `- id: ${kind}`)
    expect(i, `no declaration of ${kind} in ${rel}`).toBeGreaterThanOrEqual(0)
    const nextDecl = lines.findIndex((l, n) => n > i && /^\s*- id:\s/.test(l))
    const end = nextDecl < 0 ? lines.length : nextDecl
    const j = lines.findIndex((l, n) => n > i && n < end && l.trim() === needle)
    expect(j, `${kind}'s own declaration block has no \`${needle}\` line to plant on`)
      .toBeGreaterThan(i)
    lines[j] = lines[j].replace(needle, to)
    write(repo, rel, lines.join('\n'))
  }

  it('TEST-37 [acceptance] [invariant: INV-1 — derived-guards.md §6 INV-1] a raster kind RENAMED in its declaration stays covered with ZERO edits to the guard, where the enumerating selector it replaced goes red', () => {
    const repo = greenSynth()
    const { raster } = derivedSets(repo)
    const kind = emittedRasterKind(repo, raster)
    const manifestRel = declaringManifest(repo, kind)
    const renamed = `${kind}-renamed-by-TEST-37`
    const before = JSON.parse(runGuard(repo, ['--json']).stdout)

    // The pre-#303 selector, reconstructed from the guard's own bytes: the derived membership
    // test swapped back for the literal comparison it replaced. It is written OUTSIDE the
    // repository on purpose — the whole point of #303 is that no repo file names a kind.
    const mutantDir = mkdtempSync(path.join(RUN_ROOT, 'enumerating-'))
    tmpRoots.push(mutantDir)
    const mutantGuard = path.join(mutantDir, 'enumerating-guard.mjs')
    const guardSrc = readFileSync(GUARD, 'utf8')
    const derivedSelector = 'raster_entries = [e for e in entries if e.get("datatype") in raster_ids]'
    expect(guardSrc.split(derivedSelector).length - 1,
      'the derived selector this control mutates is not in the guard any more').toBe(1)
    writeFileSync(mutantGuard, guardSrc.replace(
      derivedSelector,
      `raster_entries = [e for e in entries if e.get("datatype") == ${JSON.stringify(kind)}]`,
    ))
    const runMutant = (r: string): Run => {
      const x = spawnSync(process.execPath, [mutantGuard, '--repo', r], { encoding: 'utf8', cwd: r })
      return { status: x.status ?? -1, stdout: x.stdout ?? '', stderr: x.stderr ?? '' }
    }
    // positive control: the reconstruction is a WORKING guard before the rename, so its red
    // below is the rename and not a broken mutant.
    expect(runMutant(repo).status, 'the enumerating reconstruction is not green on a pristine tree').toBe(0)

    // THE RENAME: the declaration moves, and the producer's construction site moves with it.
    // Nothing under `scripts/` is touched — that is the claim.
    planted(repo, manifestRel, `- id: ${kind}`, `- id: ${renamed}`)
    planted(repo, PRODUCER_REL, `"${kind}"`, `"${renamed}"`)

    const after = JSON.parse(runGuard(repo, ['--json']).stdout)
    expect(after.raster_datatypes, 'the derived subject set did not follow the declaration').toContain(renamed)
    expect(after.raster_datatypes).not.toContain(kind)
    // and it is the SAME derivation, not a smaller one: every live magnitude survives.
    expect(Object.keys(after.live).sort()).toEqual(Object.keys(before.live).sort())

    const real = runGuard(repo)
    expect(real.status, `a renamed kind must cost this guard NOTHING:\n${real.stderr}`).toBe(0)

    // the negative control: an enumerating selector stops covering the kind the moment it is
    // renamed — which is exactly the defect #303 removed, and it is what makes the green above
    // a property of the derivation rather than of the plant being inert.
    const mutant = runMutant(repo)
    expect(mutant.status, 'the enumerating selector survived a rename, so this control is vacuous').toBe(1)
  }, 300_000)

  it('TEST-38 [acceptance] [invariant: INV-6 — derived-guards.md §2, "a floor … fail-closed when the derived set collapses … is the correct companion to a derived set"] the selector really READS the declaration: both ways of collapsing it are fail-closed, each by its own message', () => {
    // (i) the EMITTING kind alone stops declaring the byte format this guard parses. The
    //     derived set survives (its sibling still declares it) but nothing emitted is in it.
    const a = greenSynth()
    const kindA = emittedRasterKind(a, derivedSets(a).raster)
    const relA = declaringManifest(a, kindA)
    {
      const lines = read(a, relA).split('\n')
      const i = lines.findIndex(l => l.trim() === `- id: ${kindA}`)
      expect(i, `no declaration of the emitted raster kind in ${relA}`).toBeGreaterThanOrEqual(0)
      const j = lines.findIndex((l, n) => n > i && l.trim() === 'format: ome-tiff')
      expect(j, 'the emitted raster kind declares no ome-tiff format to move').toBeGreaterThan(i)
      lines[j] = lines[j].replace('ome-tiff', 'ome-tiff-vnext')
      write(a, relA, lines.join('\n'))
    }
    // The premise this case rests on, asserted rather than assumed: the derived set must
    // still have a member after the plant, or this is case (ii) wearing case (i)'s name and
    // the two collapse modes stop being separated.
    const survivors = runGuard(a, ['--json'])
    // No `|| '{}'` fallback: `die()` writes to stderr and leaves stdout EMPTY, so a fallback
    // would report "the plant emptied the derived set" for a guard that never got that far.
    expect(survivors.stdout, `--json produced no report after the plant:\n${survivors.stderr}`)
      .not.toBe('')
    expect(JSON.parse(survivors.stdout).raster_datatypes,
      `the plant emptied the derived set, so case (i) degenerated into case (ii):\n${survivors.stderr}`,
    ).not.toHaveLength(0)
    // Caught by D6's MIN_LIVE_QUANTITIES floor, which is the companion §2 prescribes for a
    // derived set — not by an abort of its own. That is deliberate: an abort here would also
    // kill the `--json` REPORT, which TEST-19 reads on a tree where the plant legitimately
    // removes every raster entry, and the floor already names the collapse per quantity.
    const ra = runGuard(a)
    expect(ra.status).toBe(1)
    expect(ra.stderr).toMatch(/the producer yielded \d+ derived quantities, floor is/)
    expect(ra.stderr, 'the per-quantity floors did not name what stopped being covered')
      .toMatch(/is claimed by 0 site\(s\), floor is/)
    // and NOT by the empty-declaration abort — one collapse may not stand in for the other
    expect(ra.stderr).not.toContain('no contributed datatype declares a single opaque')

    // (ii) EVERY declaration moves off it, so the derived set itself is empty. A different
    //      abort with a different message — one may not stand in for the other.
    const b = greenSynth()
    const pkgs = path.join(b, 'src-app', 'packages')
    let moved = 0
    for (const e of readdirSync(pkgs, { withFileTypes: true })) {
      const rel = `src-app/packages/${e.name}/manifest.yaml`
      if (!e.isDirectory() || !existsSync(path.join(b, rel))) continue
      const text = read(b, rel)
      if (!text.includes('format: ome-tiff')) continue
      moved += text.split('format: ome-tiff').length - 1
      write(b, rel, text.split('format: ome-tiff').join('format: ome-tiff-vnext'))
    }
    expect(moved, 'no declaration to collapse — this control planted nothing').toBeGreaterThan(0)
    const rb = runGuard(b)
    expect(rb.status).toBe(1)
    expect(rb.stderr).toContain('no contributed datatype declares a single opaque ome-tiff blob')

    // (iii)+(iv) EVERY LEG OF THE PREDICATE, not just the one that happens to discriminate on
    // today's manifest set. `format` is the only leg a plant against the SHIPPED declarations
    // can separate — the other two are satisfied by every candidate — so mutants that deleted
    // the `layout.kind` and `file_layout` legs survived this whole battery. A predicate leg no
    // test can distinguish from `True` is not a checked leg. Each is now moved on its own,
    // one line, and the assertion is on the REPORTED derived set rather than on a downstream
    // symptom: the kind must DROP OUT, and the pristine tree (where it is in) is the control.
    for (const [needle, to, third, leg] of [
      ['file_layout: single', 'file_layout: manifest', 'file_layout: directory', 'file_layout'],
      ['layout: { kind: opaque_as_is }', 'layout: { kind: columnar_table }',
        'layout: { kind: chunked_dense }', 'layout.kind'],
    ] as const) {
      const c = greenSynth()
      const before = derivedSets(c).raster
      const kindC = emittedRasterKind(c, before)
      // No "the control tree contains the kind" line here: `kindC` is drawn OUT of `before`
      // one line up, on the same unmutated tree, from a deterministic guard — it could not
      // fail, and it cost a second full producer run per leg. `greenSynth()` is the control.
      plantInDecl(c, declaringManifest(c, kindC), kindC, needle, to)
      const after = derivedSets(c).raster
      // The premise that is NOT free, asserted the way case (i) asserts its own: the derived
      // set must SURVIVE this plant. If it collapsed, the guard would abort before writing a
      // report and the diagnosis would name neither the leg nor the collapse.
      expect(after, `${leg}: the plant emptied the derived set, so this leg was never tested`)
        .not.toHaveLength(0)
      expect(after,
        `the ${leg} leg of the derived predicate is inert — moving it changed nothing, so ` +
          'nothing distinguishes that leg from `True`',
      ).not.toContain(kindC)

      // …and the leg must be an EQUALITY, not merely a rejection of the one value this plant
      // happened to choose. Rewritten as `!= <that value>` the leg still drops the kind here
      // and would pass — while silently admitting every OTHER spelling. So move the same leg
      // to a THIRD value and require the kind to stay OUT: only `== <required>` satisfies
      // both directions.
      const d = greenSynth()
      const kindD = emittedRasterKind(d, derivedSets(d).raster)
      plantInDecl(d, declaringManifest(d, kindD), kindD, needle, third)
      expect(derivedSets(d).raster,
        `the ${leg} leg is a rejection of one value, not an equality — a third spelling was ` +
          'admitted, so any value but the planted one would pass',
      ).not.toContain(kindD)
    }
  }, 600_000)

  it('TEST-39 [acceptance] [invariant: INV-7 — spatial-types/manifest.yaml: "a datatype is a DECLARATION, and the byte plane serves it because it routes on LAYOUT, never on a domain kind"] the guard names NO contributed datatype id, and that scan bites', () => {
    const { raster, contributed } = derivedSets(REPO)
    const src = readFileSync(GUARD, 'utf8')

    // TWO scans, because the two halves of the vocabulary have different collision risk and
    // one rule cannot serve both. This took three attempts to get right, and both of the
    // earlier ones were measured wrong, so the reasoning is recorded rather than the verdict:
    //
    //   * scanning only the COMPOUND ids (attempt 1) dropped real coverage — a planted
    //     `const LEAKED = 'embedding'` survived, and nothing else in the tree scans a
    //     `scripts/*.mjs` for it (`check-derived-vocabulary.sh`'s build surface is `justfile`
    //     + `scripts/*.sh`; `lint-no-domain-in-builtin.mjs`'s roots are server/ui/desktop/libs;
    //     `test_a_new_kind_costs_zero_core_code`'s terms come from ONE manifest, so it covers
    //     the 7 `spatial/*` ids and not the other 21).
    //   * scanning ALL ids BARE (attempt 2) false-reds on innocent prose — demonstrated, not
    //     feared: the comment line "this selector performs no clustering of any kind" reds
    //     with an accusation of a leak that is not there. In a guard that is ~40% comment,
    //     that is `derived-guards.md` §1's "falsely red" direction inside the test written to
    //     prevent §1's other direction.
    //
    // So: a COMPOUND id (`family/kind`) is scanned BARE — no English word carries a slash, so
    // a bare hit is always a real mention. Every id, compound or not, is additionally scanned
    // QUOTED, because a domain id used the way #303 removed is a STRING LITERAL in a dispatch
    // (`e.get("datatype") != "<id>"`), and prose does not quote its nouns as literals. The
    // union catches the defect class in both spellings without accusing correct prose.
    const compound = contributed.filter(id => id.includes('/'))
    expect(compound.length, 'no compound contributed id — the vocabulary collapsed')
      .toBeGreaterThanOrEqual(5)
    expect(contributed.length, 'the contributed vocabulary collapsed, so this scan is vacuous')
      .toBeGreaterThanOrEqual(20)
    const quoted = (id: string) =>
      src.includes(`"${id}"`) || src.includes(`'${id}'`) || src.includes(`\`${id}\``)
    const leaks = [
      ...compound.filter(id => boundedHits(src, id) > 0),
      ...contributed.filter(id => quoted(id)),
    ].filter((id, i, a) => a.indexOf(id) === i)
    expect(leaks,
      'a contributed datatype id is written into the guard — a new kind must be DATA, so it ' +
        'costs no edit to an app-core surface (#303)',
    ).toEqual([])

    // The scan is not vacuous, twice over: the vocabulary it ranges over is real, and it FIRES
    // on the exact literal #303 removed. The re-introduction is done in memory — writing it to
    // disk would be the leak this asserts the absence of.
    expect(contributed.length).toBeGreaterThanOrEqual(20)
    expect(raster.length).toBeGreaterThan(0)
    const reintroduced = src.replace(
      'e.get("datatype") in raster_ids',
      `e.get("datatype") == ${JSON.stringify(raster[0])}`,
    )
    expect(reintroduced, 'the re-introduction planted nothing').not.toBe(src)
    expect(contributed.filter(id => boundedHits(reintroduced, id) > 0),
      'the bare scan does not catch the exact literal #303 removed',
    ).toEqual([raster[0]])
    // and the QUOTED half catches it independently — that is the half that covers the ids a
    // bare scan cannot safely look for
    expect(contributed.filter(id => reintroduced.includes(`"${id}"`)),
      'the quoted scan does not catch a dispatch literal',
    ).toEqual([raster[0]])
    // …while a WORD-LIKE id merely mentioned in prose is NOT a leak, which is the false-red
    // the bare-everything scan produced. Demonstrated here so the split cannot be undone by
    // someone who only reads the comment above.
    const wordLike = contributed.filter(id => !id.includes('/'))
    expect(wordLike.length, 'no word-like contributed id to demonstrate the split with')
      .toBeGreaterThan(0)
    const innocentProse = `${src}\n# NOTE: this selector performs no ${wordLike[0]} of any kind.\n`
    expect(
      [...compound.filter(id => boundedHits(innocentProse, id) > 0),
       ...contributed.filter(id => innocentProse.includes(`"${id}"`) || innocentProse.includes(`'${id}'`))]
        .filter((id, i, a) => a.indexOf(id) === i),
      'a word-like id mentioned in prose is reported as a leak — that is the falsely-red direction',
    ).toEqual([])

    // Honest limits, stated the way the owning test states its own.
    // (a) `boundedHits` matches a CONTIGUOUS literal, so an id split across adjacent Python
    //     string concatenation, or joined at runtime, would pass this scan while the guard
    //     still, in effect, names the kind.
    // (b) It proves THIS ONE FILE names no contributed datatype id — one file, all 28 ids.
    //     The WHOLE-SURFACE statement (every tracked file under `src-app/`, `scripts/` and
    //     `justfile`) is owned by
    //     `spatial-types/tests/test_spatial_types_manifest.py::test_a_new_kind_costs_zero_core_code`,
    //     which is the test #303 was filed for and which this branch also runs — but over a
    //     NARROWER vocabulary: its forbidden terms come from ONE manifest, so it ranges over
    //     the 7 `spatial/*` ids and not the other 21. Neither test subsumes the other, and the
    //     gap between the tree's several domain-vocabulary scanners is tracked as #304.
  }, 120_000)
})

// Drop the tmp trees. Each is a full COPY of `src-app/packages` plus the spatial subtree —
// ~20 MB — and this file makes one per plant, so leaking them is not a tidiness issue.
//
// This used to be `process.on('exit', ...)` and it NEVER RAN: vitest executes a spec inside a
// pooled worker that is not torn down by a process exit this handler can observe, so every
// synthetic tree this battery has ever built stayed in `os.tmpdir()`. Measured when a blind
// audit went looking: 15,038 `viz-magnitudes-synth-*` directories on the build box, ~220 GB,
// with the root filesystem at 100%. A full run of this file leaks ~72 of them.
//
// `afterAll` is vitest's own hook and runs inside that worker, so it actually fires. It is
// registered at FILE scope (outside the describe) so it covers every tree, including any made
// by a helper before the suite starts, and it runs even when a test throws.
afterAll(() => {
  // ONE remove, of the one root everything is nested under — so this cannot half-finish
  // across 118 separate calls, and a site that forgot to register is still inside it.
  rmSync(RUN_ROOT, { recursive: true, force: true })
  // THE OBSERVATION. The battery had 40 passing tests and not one of them looked at what it
  // left on disk, which is exactly why a 220 GB leak survived a green suite for months. This
  // hook is where the side effect becomes visible: if the root survives, the run goes RED.
  // (`rmSync` is synchronous, so even a hook-timeout completes the work and then fails the
  // run loudly — verified: a 50 ms `--hookTimeout` still removed everything and exited 1.)
  expect(existsSync(RUN_ROOT), `the run root survived cleanup, so this run leaked: ${RUN_ROOT}`)
    .toBe(false)
}, 120_000)
