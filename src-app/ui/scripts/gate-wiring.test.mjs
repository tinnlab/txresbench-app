/**
 * TEST-46 (ITEM-40) — a gate cannot be silently switched off by deleting its subject.
 *
 * ITEM-40 re-wired the repo's gate recipes for the packages and scripts this round
 * deletes. That is a class of change with a very quiet failure mode: `just check` invokes
 * a recipe that runs a script that no longer exists, the shell reports "command not
 * found", and — depending on how the recipe is written — the gate either dies with a
 * confusing error or, worse, keeps going. Either way the check it was running stops
 * running, and nothing says so.
 *
 * So: every script named by `just check`'s recipe chain and by `ui/package.json`'s
 * `check` chain must EXIST ON DISK, the retired recipe must be gone, and the surviving
 * ones must still be wired in. Every assertion carries a positive count, because a
 * parser that extracted nothing would otherwise report a perfectly clean wiring.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '..')
const REPO = path.resolve(UI, '../..')

const justfile = () => readFileSync(path.join(REPO, 'justfile'), 'utf8')
const uiPkg = () => JSON.parse(readFileSync(path.join(UI, 'package.json'), 'utf8'))

/** Strip `#` comments so the RETIRED recipe's explanatory block (which still names the
 *  retired recipe, deliberately, so it is not silently re-added) is not read as wiring. */
function justCode() {
  return justfile()
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .join('\n')
}

/** The body lines of a just recipe, by name. */
function recipeBody(name) {
  const lines = justfile().split('\n')
  const start = lines.findIndex(l => new RegExp(`^${name}(\\s|:)`).test(l) && l.includes(':'))
  if (start < 0) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) break // a new top-level recipe / assignment
    body.push(l.trim())
  }
  return body
}

test('TEST-46: `just check` exists and invokes a real chain', () => {
  const body = recipeBody('check')
  assert.ok(body, 'the `check` recipe is missing from the justfile')
  // POSITIVE COUNT: an emptied recipe would pass every "references no deleted script"
  // assertion below.
  assert.ok(body.length >= 5, `\`just check\` runs only ${body.length} step(s): ${body.join(' | ')}`)
  assert.ok(
    body.some(l => l.includes('cargo check')),
    '`just check` must still run the backend check',
  )
  assert.ok(
    body.some(l => l.includes('npm run check')),
    '`just check` must still run the frontend check',
  )
})

test('TEST-46: the RETIRED `check-ts-packages` recipe is gone from executable justfile code', () => {
  // ITEM-40 retired it: it ran `npm --prefix src-app/libs/workbench-api test`, and
  // that package no longer exists. The explanatory comment recording the retirement
  // stays (so it is not re-added by accident) — hence the comment-stripped read.
  const code = justCode()
  assert.ok(!/^check-ts-packages\s*:/m.test(code), 'the retired recipe is still defined')
  assert.ok(!/\bjust\s+check-ts-packages\b/.test(code), 'something still invokes the retired recipe')
  assert.ok(
    !/packages\/workbench-api/.test(code),
    'executable justfile code still points at the deleted workbench-api package',
  )
  // The retirement is documented — deleting the comment as well would let a future
  // change re-add it with no signal.
  assert.match(justfile(), /RETIRED.*ITEM-40/s)
})

test('TEST-46: `check-coercion` is KEPT and its script exists', () => {
  // TESTS.md declared this recipe "retired". It was not: DRIFT-2.2 kept the
  // criteria-coercion parity gate, reduced from four readers to three, because only ONE
  // of its four readers was the deleted DSL. Deleting a whole guard because one of its
  // subjects died is the fail-open pathology ITEM-37 exists to prevent — so the assertion
  // is that it SURVIVES, and TESTS.md is corrected rather than the code bent to match it.
  const body = recipeBody('check')
  assert.ok(
    body.some(l => l.includes('check-coercion')),
    '`just check` no longer runs the coercion-parity gate',
  )
  const rec = recipeBody('check-coercion')
  assert.ok(rec && rec.length >= 1, 'the `check-coercion` recipe is missing')
  assert.ok(
    existsSync(path.join(REPO, 'scripts/coercion-parity.mjs')),
    'check-coercion names a script that does not exist',
  )
})

test('TEST-46: every script NAMED by a justfile recipe exists on disk', () => {
  // The class of defect, not just the two known instances.
  const refs = [...justCode().matchAll(/\{\{justfile_directory\(\)\}\}\/([\w./-]+\.(?:mjs|sh|py))/g)].map(
    m => m[1],
  )
  assert.ok(refs.length >= 3, `only ${refs.length} script reference(s) parsed out of the justfile`)
  const missing = refs.filter(r => !existsSync(path.join(REPO, r)))
  assert.deepEqual(missing, [], 'these justfile recipes name scripts that do not exist')
})

test("TEST-46: `ui`'s `check` chain includes the layer-boundary lint", () => {
  const chain = uiPkg().scripts.check
  assert.ok(chain, 'ui/package.json has no `check` script')
  assert.match(chain, /lint-layer-boundary/, 'ITEM-21’s boundary lint is not wired into `npm run check`')
  assert.match(chain, /tsc --noEmit/)
  assert.match(chain, /lint-no-domain-in-builtin/)
  assert.match(chain, /test:unit/)
})

test('TEST-46: every script NAMED by ui/package.json exists on disk', () => {
  const scripts = uiPkg().scripts
  assert.ok(Object.keys(scripts).length >= 8, 'the script list is implausibly short')
  const refs = new Set()
  for (const cmd of Object.values(scripts))
    for (const m of String(cmd).matchAll(/(?:node|npx tsx)\s+([\w./-]+\.mjs)/g)) refs.add(m[1])
  assert.ok(refs.size >= 5, `only ${refs.size} script reference(s) parsed out of ui/package.json`)
  const missing = [...refs].filter(r => !existsSync(path.resolve(UI, r)))
  assert.deepEqual(missing, [], 'these npm scripts name files that do not exist')
})

test('the e2e-ROUTING gate is wired, and every e2e runner has a recipe', () => {
  // The routing gate is what stops 44% of the default e2e run from being structurally
  // un-runnable — and it is exactly the shape of gate this file exists to keep switched
  // on. `check-e2e-routing.mjs` enforces "every config has an npm script + a just
  // recipe"; nothing INSIDE it can enforce that it is still itself called.
  const scripts = uiPkg().scripts
  assert.match(
    scripts.check,
    /check:e2e-routing/,
    'the e2e-routing gate is no longer wired into `npm run check`',
  )
  assert.match(scripts['check:e2e-routing'] ?? '', /check-e2e-routing\.mjs/)
  assert.ok(existsSync(path.join(HERE, 'check-e2e-routing.mjs')))
  assert.ok(existsSync(path.join(HERE, 'e2e-inventory.mjs')))

  // One recipe per runner. Hand-listed ON PURPOSE: `check-e2e-routing.mjs` DERIVES the
  // config set, so on its own, deleting a config would delete its own requirement.
  // Naming the recipes here makes removing one a deliberate edit.
  const code = justCode()
  for (const r of ['e2e', 'e2e-viz', 'e2e-gallery', 'e2e-visual', 'e2e-all', 'e2e-inventory'])
    assert.match(code, new RegExp(`^${r}:`, 'm'), `the \`just ${r}\` recipe is missing`)
  // `libs/viz` runs 20 `*.e2e.mjs` under its OWN runner (`tests/e2e/run-all.mjs`,
  // not a playwright.config), so `check-e2e-routing.mjs` — which is scoped to `ui`'s
  // playwright configs — cannot see it. It was invoked by nothing at all, the same
  // un-runnable state as the viz playwright suite; keep its recipe named here.
  assert.match(code, /^e2e-viz-package\b/m, 'the `just e2e-viz-package` recipe is missing')
  assert.match(code, /e2e-viz-package/, '`just e2e-all` no longer runs the viz-package suite')
  for (const s of ['test:e2e', 'test:e2e:viz', 'test:e2e:gallery', 'test:e2e:visual'])
    assert.ok(scripts[s], `ui/package.json has no \`${s}\` script`)

  // No config may reacquire a `testIgnore`: an exclusion pattern is how the viz suite got
  // swept into a runner that could not drive it, and — as `playwright.config.ts`'s own
  // R3-114 note says — an exclusion removes a spec from COLLECTION, so its absence never
  // shows in the output. Route by DIRECTORY.
  for (const f of [
    'playwright.config.ts',
    'playwright.viz.config.ts',
    'playwright.gallery.config.ts',
  ])
    assert.ok(
      !/^\s*testIgnore\s*:/m.test(readFileSync(path.join(UI, f), 'utf8')),
      `${f} reintroduced a \`testIgnore\` — route by DIRECTORY, not by exclusion`,
    )
})

test('TEST-46: the surface-baseline gate is wired and its baseline exists', () => {
  // The declared-surface-drift device. A gate whose baseline fixture is missing is a gate
  // that cannot run — the same failure this test exists to catch.
  const scripts = uiPkg().scripts
  assert.ok(scripts['check:surface-baseline'], 'no `check:surface-baseline` script')
  assert.match(scripts['check:surface-baseline'], /capture-surface-baseline\.mjs/)
  assert.ok(existsSync(path.join(HERE, 'capture-surface-baseline.mjs')))
  assert.ok(
    existsSync(path.join(UI, 'src/modules/workbench/core/__fixtures__/surface-baseline.main.json')),
    'the baseline fixture (captured from main) is missing',
  )
  // Re-capturing must stay a one-liner: the maintenance path this device depends on is
  // "land a surface change, re-capture, empty the manifest, same commit". A device whose
  // refresh is a remembered incantation gets refreshed by nobody.
  assert.ok(scripts['capture:surface-baseline'], 'no `capture:surface-baseline` script')
  assert.match(scripts['capture:surface-baseline'], /capture-surface-baseline\.mjs capture/)
  // …and it is RUN. Until 2026-08-07 this gate existed, worked, and was invoked by
  // nothing: it was absent from `npm run check`, so it drifted to 108 undeclared surface
  // differences and 51 stale allowances with every other gate green. That is the exact
  // failure mode this file exists to prevent — a gate nobody runs reports nothing — and
  // it is why the assertion below is about the WIRING, not about the script existing.
  assert.match(
    scripts.check,
    /check:surface-baseline/,
    'the surface-baseline gate is no longer wired into `npm run check` — the workbench ' +
      'surface can drift again with no signal',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// The WORKSPACE-PACKAGE suite gate (`just check-packages` →
// `scripts/check-package-suites.mjs`).
//
// Same class as everything above: `npm run check` roots vitest at `src-app/ui`, so
// `@ziee/viz` (207 files / 2555 tests) and `@ziee/dock` (4 / 84) were run by NOTHING —
// and a merge broke `VizController.events.test.ts` on `main` with every gate green.
// These tests assert the WIRING cannot rot back to that, and — because a gate that
// cannot fail is not a gate — that the script itself fails closed on the two ways its
// coverage can collapse.
// ─────────────────────────────────────────────────────────────────────────────

const PKG_GATE = path.join(REPO, 'scripts/check-package-suites.mjs')

/** Enumerate-only run of the real gate against the real tree. */
function gatePlan() {
  const r = spawnSync(process.execPath, [PKG_GATE, '--json'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(r.status, 0, `check-package-suites.mjs --json exited ${r.status}\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('the package-suite gate is wired into `just check` and its script exists', () => {
  const code = justCode()
  assert.match(code, /^check-packages:/m, 'the `just check-packages` recipe is missing')
  const body = recipeBody('check-packages')
  assert.ok(body && body.length >= 1, 'the `check-packages` recipe has an empty body')
  assert.ok(
    body.some(l => l.includes('check-package-suites.mjs')),
    '`check-packages` no longer names its script',
  )
  assert.ok(existsSync(PKG_GATE), 'check-packages names a script that does not exist')
  assert.ok(
    recipeBody('check').some(l => /\bjust\s+check-packages\b/.test(l)),
    '`just check` no longer runs `just check-packages` — the package suites are ungated again',
  )
  // R5-A's footgun, applied here: `--list` enumerates and runs NOTHING, so an `*ARGS`
  // passthrough would make `just check-packages --list` a green gate that executed zero
  // tests. The recipe must take no parameters.
  assert.match(
    code,
    /^check-packages:\s*$/m,
    '`check-packages` grew a parameter — a caller flag (`--list`) can degrade this gate to a no-op',
  )
})

test('the package-suite gate DEFINITION is preserved (CI workflows are disabled — no Actions credit)', () => {
  // All `.github/workflows/*.yml` are renamed to `*.yml.disabled` (Actions billing is off
  // org-wide, so a workflow only accrues failed/queued runs). The gate now runs LOCALLY via
  // `just check` + the pre-push hook. This test no longer asserts CI RUNS the suites — it
  // asserts the disabled workflow's WIRING is intact, so re-enabling (rename back) restores a
  // correct runner rather than a broken one.
  const wf = path.join(REPO, '.github/workflows/domain-guard.yml.disabled')
  assert.ok(existsSync(wf), 'domain-guard.yml.disabled is gone — the preserved CI wiring was lost')
  const yml = readFileSync(wf, 'utf8')
  assert.match(yml, /check-package-suites\.mjs/, 'the preserved workflow no longer wires the workspace-package suites')
  // `@ziee/viz` imports `@ziee/kit` from the `sdk` SUBMODULE: without a recursive
  // checkout, 6 of its 207 files fail with `Cannot find package '@ziee/kit'` and the step
  // is a meaningless RED. Verified locally — that was the first observed run.
  assert.match(yml, /submodules:\s*recursive/, 'the CI checkout stopped fetching submodules')
})

test('every package under src-app/libs/ with a `test` script is COVERED by the gate', () => {
  // The anti-rot assertion: derived from the tree, not from a list in this file. A new
  // package that ships tests and is not picked up fails HERE.
  const pkgRoot = path.join(REPO, 'src-app/libs')
  const onDisk = readdirSync(pkgRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules')
    .map(e => ({ rel: `src-app/libs/${e.name}`, manifest: path.join(pkgRoot, e.name, 'package.json') }))
    .filter(p => existsSync(p.manifest))
    .map(p => ({ ...p, pkg: JSON.parse(readFileSync(p.manifest, 'utf8')) }))
  // POSITIVE COUNT: an emptied packages/ dir would satisfy every assertion below.
  assert.ok(onDisk.length >= 2, `only ${onDisk.length} package(s) found under src-app/libs/`)

  const plan = gatePlan()
  const gated = new Set(plan.packages.filter(p => p.status === 'gated').map(p => p.rel))
  const known = new Map(plan.packages.map(p => [p.rel, p]))
  assert.ok(gated.size >= 2, `the gate would run only ${gated.size} suite(s)`)

  for (const p of onDisk) {
    assert.ok(known.has(p.rel), `\`${p.rel}\` is not seen by the gate at all — the workspace globs no longer reach it`)
    if (p.pkg.scripts?.test)
      assert.ok(
        gated.has(p.rel),
        `\`${p.rel}\` has a \`test\` script but the gate classified it \`${known.get(p.rel).status}\` ` +
          `(${known.get(p.rel).reason}) — its suite would not run`,
      )
  }
  // And the exclusions are the documented ones, each with a stated reason — never a silent
  // extra outcome.
  //
  // `UPSTREAM-GAP` was MISSING from this list and only reachable when a submodule is in play
  // (dirty, or its pointer moved vs the base) — which is never true on `main`. So the two halves
  // of this gate disagreed in a state no main-line run can enter, and every branch that touched
  // `sdk/` turned `npm run check` red on `sdk/packages/framework` (8 test files, no `test`
  // script). The runner emits that status DELIBERATELY and non-fatally, because the fix belongs
  // in the other repository and failing here would train people to skip the gate — so the list,
  // not the runner, was wrong. The list stays hand-written on purpose: it is the tripwire for a
  // status nobody has considered, and it just caught one.
  for (const p of plan.packages)
    assert.ok(
      ['gated', 'excluded', 'skipped', 'UNRUNNABLE', 'UPSTREAM-GAP'].includes(p.status) && p.reason,
      `\`${p.rel}\` has status \`${p.status}\` with reason \`${p.reason}\``,
    )
})

// ── negative controls: the gate must FAIL on each way its coverage collapses ──
//
// Built against a SYNTHETIC repo (the real script, a fake tree) so the controls do not
// depend on planting a failure in the real one. Mirrors `guard-floors.test.mjs`.
function synthRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pkg-gate-'))
  try {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    copyFileSync(PKG_GATE, path.join(dir, 'scripts/check-package-suites.mjs'))
    mkdirSync(path.join(dir, 'src-app/ui'), { recursive: true })
    mkdirSync(path.join(dir, 'src-app/libs'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'synth', private: true, workspaces: ['src-app/libs/*', 'src-app/ui'] }),
    )
    writeFileSync(path.join(dir, 'justfile'), 'check:\n    cd ui && npm run check\n')
    writeFileSync(
      path.join(dir, 'src-app/ui/package.json'),
      JSON.stringify({ name: 'synth-ui', scripts: { check: 'tsc --noEmit && npm run test:unit' } }),
    )
    const addPkg = (name, scripts, files = []) => {
      const d = path.join(dir, 'src-app/libs', name)
      mkdirSync(path.join(d, 'src'), { recursive: true })
      writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@synth/${name}`, scripts }))
      for (const f of files) writeFileSync(path.join(d, 'src', f), '// test\n')
      return d
    }
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(dir, 'scripts/check-package-suites.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    return fn({ dir, addPkg, run })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('NEGATIVE CONTROL — a package with test FILES but no `test` script FAILS the gate (P3)', () => {
  synthRepo(({ addPkg, run }) => {
    addPkg('alpha', { test: 'exit 0' })
    addPkg('beta', { test: 'exit 0' })
    // The positive control: with two runnable packages the synthetic tree is GREEN, so
    // the failure below is attributable to the planted defect and not to the fixture.
    const ok = run('--list')
    assert.equal(ok.status, 0, `the clean synthetic tree should pass:\n${ok.stdout}\n${ok.stderr}`)

    addPkg('gamma', { build: 'tsc' }, ['thing.test.ts'])
    const bad = run('--list')
    assert.equal(bad.status, 1, 'a package whose tests nothing can run passed the gate')
    assert.match(bad.stderr, /P3:/)
    assert.match(bad.stderr, /gamma/, 'the failure must NAME the package')
    assert.match(bad.stderr, /NO `test` script/)
  })
})

test('NEGATIVE CONTROL — a collapsed package set FAILS the gate rather than passing empty (P4)', () => {
  synthRepo(({ addPkg, run }) => {
    addPkg('alpha', { test: 'exit 0' })
    // One runnable package is below the committed floor of 2. This is what a rename or a
    // moved directory looks like, and it is the ITEM-37 fail-open shape: a guard that
    // scanned (almost) nothing must not congratulate itself.
    const r = run('--list')
    assert.equal(r.status, 1, 'the gate passed with its package set collapsed below the floor')
    assert.match(r.stderr, /P4:/)
    assert.match(r.stderr, /below the floor of 2/)
  })
})

test('NEGATIVE CONTROL — a NEW package with a `test` script is picked up with NO edit to the gate', () => {
  synthRepo(({ addPkg, run }) => {
    addPkg('alpha', { test: 'exit 0' })
    addPkg('beta', { test: 'exit 0' })
    const before = JSON.parse(run('--json').stdout)
    assert.equal(before.packages.filter(p => p.status === 'gated').length, 2)

    addPkg('delta', { test: 'vitest run' }, ['new.test.ts'])
    const after = JSON.parse(run('--json').stdout)
    const gated = after.packages.filter(p => p.status === 'gated').map(p => p.name)
    assert.deepEqual(gated.sort(), ['@synth/alpha', '@synth/beta', '@synth/delta'])
  })
})

test('the gate REFUSES a workspace pattern it cannot expand, instead of dropping packages (P1)', () => {
  // The by-construction property's own failure mode: a glob shape the expander does not
  // understand would silently contribute zero packages. It must fail loudly instead.
  synthRepo(({ dir, addPkg, run }) => {
    addPkg('alpha', { test: 'exit 0' })
    addPkg('beta', { test: 'exit 0' })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'synth', private: true, workspaces: ['src-app/**/packages/*', 'src-app/ui'] }),
    )
    const r = run('--list')
    assert.equal(r.status, 1, 'an un-expandable workspace glob passed silently')
    assert.match(r.stderr, /P1:/)
  })
})

test('the ALREADY_GATED exclusion of src-app/ui is verified, not assumed', () => {
  // `src-app/ui` is excluded because `just check` runs `npm run check` for it. If that
  // link disappears the exclusion becomes a hole, so the script re-derives it every run.
  synthRepo(({ dir, addPkg, run }) => {
    addPkg('alpha', { test: 'exit 0' })
    addPkg('beta', { test: 'exit 0' })
    writeFileSync(
      path.join(dir, 'src-app/ui/package.json'),
      JSON.stringify({ name: 'synth-ui', scripts: { check: 'tsc --noEmit' } }), // test:unit dropped
    )
    const r = run('--list')
    assert.equal(r.status, 1, "ui's check chain lost its unit suites and the exclusion still passed")
    assert.match(r.stderr, /P2:/)
    assert.match(r.stderr, /test:unit/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S1 — "is this submodule initialised?" must ask the DIRECTORY, not git's walk-up.
//
// The original S1 asked `git -C <submodule-dir> rev-parse HEAD` and treated exit 0 as
// "initialised". git does not answer that question: it walks UP from the directory
// until it finds a repository, so inside an EMPTY (uninitialised) submodule it returns
// the PARENT's HEAD with exit 0. Two consequences, both silent:
//
//   · S1 never fired for an absent submodule, so its workspace globs expanded to
//     nothing and the gate covered strictly less than it reported — green.
//   · the very next call, `git status --porcelain` in that same directory, then read
//     the PARENT's dirty files, so an uninitialised submodule was judged "working tree
//     dirty" and therefore IN PLAY whenever the parent tree had ANY uncommitted change.
//
// A gate that inspects the wrong repository and reports green is worse than no gate.
// These fixtures are built so the walk-up produces a DIFFERENT answer from the truth:
// a real parent repository, a submodule directory that exists but is not one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A synthetic PARENT git repository (so `git` has somewhere to walk up TO) with two
 * runnable first-party packages (so the P4 floor is satisfied and any failure is
 * attributable to the planted defect).
 */
function synthSubmoduleRepo(fn, { initGit = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pkg-gate-sub-')))
  const git_ = (args, cwd = dir) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  try {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    copyFileSync(PKG_GATE, path.join(dir, 'scripts/check-package-suites.mjs'))
    mkdirSync(path.join(dir, 'src-app/ui'), { recursive: true })
    mkdirSync(path.join(dir, 'src-app/libs'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'synth',
        private: true,
        // `sdk/packages/*` points INSIDE the submodule — that is what makes an
        // uninitialised `sdk` a coverage hole rather than a harmless absence.
        workspaces: ['sdk/packages/*', 'src-app/libs/*', 'src-app/ui'],
      }),
    )
    writeFileSync(path.join(dir, 'justfile'), 'check:\n    cd ui && npm run check\n')
    writeFileSync(
      path.join(dir, 'src-app/ui/package.json'),
      JSON.stringify({ name: 'synth-ui', scripts: { check: 'tsc --noEmit && npm run test:unit' } }),
    )
    const addPkg = (rel, name, scripts, files = []) => {
      const d = path.join(dir, rel, name)
      mkdirSync(path.join(d, 'src'), { recursive: true })
      writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@synth/${name}`, scripts }))
      for (const f of files) writeFileSync(path.join(d, 'src', f), '// test\n')
      return d
    }
    addPkg('src-app/libs', 'alpha', { test: 'exit 0' })
    addPkg('src-app/libs', 'beta', { test: 'exit 0' })

    if (initGit) {
      git_(['init', '-q', '-b', 'main'])
      git_(['add', '-A'])
      git_(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base'])
    }

    /** Declare submodule paths in `.gitmodules` and create the directories UNinitialised. */
    const declareSubmodules = (...subs) => {
      writeFileSync(
        path.join(dir, '.gitmodules'),
        subs.map(s => `[submodule "${s}"]\n\tpath = ${s}\n\turl = https://example.invalid/${s}\n`).join(''),
      )
      // An uninitialised submodule is exactly this: the directory exists (checkout
      // creates it) and is empty. Not absent — absent is caught even by the broken S1.
      for (const s of subs) mkdirSync(path.join(dir, s), { recursive: true })
    }

    /** Turn one declared submodule into a REAL nested repository with one package. */
    const initSubmodule = (sub, pkgName, scripts) => {
      const sd = path.join(dir, sub)
      addPkg(sub + '/packages', pkgName, scripts)
      git_(['init', '-q', '-b', 'main'], sd)
      git_(['add', '-A'], sd)
      git_(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'sub'], sd)
    }

    // `cwd` is a PARAMETER, not a constant: the gate derives its repo from the
    // script's own location, so the process CWD is arbitrary and a caller may well
    // run it from inside a subdirectory. One test below depends on that.
    const runIn = (cwd, ...args) =>
      spawnSync(process.execPath, [path.join(dir, 'scripts/check-package-suites.mjs'), ...args], {
        cwd,
        encoding: 'utf8',
      })
    const run = (...args) => runIn(dir, ...args)

    return fn({ dir, addPkg, declareSubmodules, initSubmodule, run, runIn })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('S1: an UNINITIALISED submodule whose globs point inside it FAILS, and is never judged from the PARENT', () => {
  synthSubmoduleRepo(({ declareSubmodules, run }) => {
    declareSubmodules('sdk')
    // Writing `.gitmodules` leaves the PARENT tree dirty — and that is the whole point.
    // Under the walk-up bug, `git status --porcelain` inside the empty `sdk/` reports
    // THESE files, so the gate concluded "sdk: working tree dirty → IN PLAY" about a
    // submodule that is not on disk at all.
    const r = run('--json')
    assert.equal(
      r.status,
      1,
      'an uninitialised submodule passed the gate: its `sdk/packages/*` glob expands to ' +
        `nothing, so the gate covered less than it reported.\n${r.stdout}\n${r.stderr}`,
    )
    assert.match(r.stderr, /S1:/)
    assert.match(r.stderr, /`sdk`/, 'the failure must NAME the submodule')
    assert.match(r.stderr, /uninitialised/)

    // The precise claim: the checker reported the SUBMODULE's own state, not the
    // parent's. `--json` keeps stdout pure JSON even on a failing run.
    const plan = JSON.parse(r.stdout)
    assert.equal(plan.submodules.sdk.present, false)
    assert.equal(
      plan.submodules.sdk.dirty,
      false,
      "the parent's dirty files were read as the submodule's working tree",
    )
    assert.equal(plan.submodules.sdk.inPlay, false)
    assert.doesNotMatch(
      plan.submodules.sdk.why,
      /working tree dirty/,
      'the gate described an absent submodule using the PARENT repository’s status',
    )
  })
})

test('S1 positive control: an INITIALISED submodule is recognised as its own repository', () => {
  // The other half. `isOwnRepo` must not over-reject: a real nested repository answers
  // with ITSELF, so its packages are seen and (here, with the base unresolvable) gated.
  synthSubmoduleRepo(({ declareSubmodules, initSubmodule, run }) => {
    declareSubmodules('sdk')
    initSubmodule('sdk', 'kit', { test: 'exit 0' })
    const r = run('--json')
    assert.equal(r.status, 0, `an initialised submodule was rejected:\n${r.stdout}\n${r.stderr}`)
    const plan = JSON.parse(r.stdout)
    assert.equal(plan.submodules.sdk.present, true)
    assert.equal(
      plan.submodules.sdk.dirty,
      false,
      "the PARENT's dirty tree leaked into a clean submodule's state",
    )
    // POSITIVE COUNT: the submodule's package must actually be seen, or "present" is
    // a claim about nothing.
    assert.ok(
      plan.packages.some(p => p.rel === 'sdk/packages/kit'),
      'the initialised submodule contributed no workspace at all',
    )
  })
})

test('S1: an uninitialised submodule the workspace globs do NOT reach is reported, not fatal', () => {
  // `agent-kit` ships docs and skills, no npm packages. Its being uninitialised costs
  // this gate exactly nothing, so failing on it would only force contributors to check
  // out trees the gate has no opinion about — and a gate people must work around is the
  // failure mode this whole file exists to prevent. Conditional fatality, stated.
  synthSubmoduleRepo(({ declareSubmodules, run }) => {
    declareSubmodules('agent-kit')
    const r = run('--json')
    assert.equal(
      r.status,
      0,
      `an uninitialised submodule that declares no workspaces was made fatal:\n${r.stderr}`,
    )
    const plan = JSON.parse(r.stdout)
    assert.equal(plan.submodules['agent-kit'].present, false)
    assert.match(
      plan.submodules['agent-kit'].why,
      /declares no npm workspaces/,
      'the reason for NOT failing must be printed, not inferred',
    )
  })
})

test('S1: "does a glob point inside this submodule" is a PATH-SEGMENT test, not a substring', () => {
  // `packages` is a substring of the `src-app/libs/*` glob and resolves nowhere
  // near it. A substring test would make an uninitialised submodule at that path a
  // HARD FAILURE for a glob it has nothing to do with — an over-broad predicate, and
  // the same shape of wrong answer (right-looking, about the wrong thing) as the
  // walk-up above. Segment-anchored, so the answer is about the actual directory.
  synthSubmoduleRepo(({ declareSubmodules, run }) => {
    declareSubmodules('packages')
    const r = run('--json')
    assert.equal(
      r.status,
      0,
      `a submodule whose path merely APPEARS inside a workspace glob was made fatal:\n${r.stderr}`,
    )
    assert.match(JSON.parse(r.stdout).submodules.packages.why, /declares no npm workspaces/)
  })
})

test('S1: a tree with NO git at all still refuses an uninitialised submodule, whatever the CWD', () => {
  // The second way to accidentally ask git about the wrong directory, and it is
  // reachable: `realpathSync('')` does NOT throw — it resolves to the process CWD.
  // So if the toplevel lookup fails (a tree with no `.git`: an exported archive, a
  // tracked-files-only staging worktree) and the empty answer is handed to
  // `realpathSync` anyway, the comparison becomes `CWD === dir` — which is TRUE the
  // moment someone runs the gate from inside the very submodule directory it is
  // asking about. An absent submodule then reads as present, its globs expand to
  // nothing, and the gate is green.
  //
  // The gate takes its repo from the SCRIPT's location, so the CWD really is a free
  // variable, which is what makes this a window rather than a hypothetical.
  synthSubmoduleRepo(
    ({ dir, declareSubmodules, runIn }) => {
      declareSubmodules('sdk')
      const r = runIn(path.join(dir, 'sdk'), '--json')
      assert.equal(
        r.status,
        1,
        `run from inside the empty submodule, the gate reported it as present:\n${r.stdout}\n${r.stderr}`,
      )
      assert.match(r.stderr, /S1:/)
      assert.equal(JSON.parse(r.stdout).submodules.sdk.present, false)
      // POSITIVE CONTROL: from the repo root the same tree fails the same way, so the
      // assertion above is about the empty-toplevel path and not about the CWD alone.
      const fromRoot = runIn(dir, '--json')
      assert.equal(fromRoot.status, 1)
      assert.equal(JSON.parse(fromRoot.stdout).submodules.sdk.present, false)
    },
    { initGit: false },
  )
})
