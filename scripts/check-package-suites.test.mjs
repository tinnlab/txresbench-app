/**
 * check-package-suites.test.mjs — the gate's own guard (#276).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 * `scripts/check-package-suites.mjs` grew rule **P6 TYPED** because `src-app/libs/viz`
 * shipped a `typecheck` script that NOTHING invoked: on `origin/main` it exited 2 with
 * five errors, four of them inside `*.test.ts(x)` files, and it had been red for an
 * unknown length of time with no signal anywhere. vitest transpiles without typechecking,
 * so the suites were green while `omeTiffFallback.test.tsx` imported two names its target
 * module does not export.
 *
 * Fixing those five errors without giving the check a caller would only have reset the
 * clock. So the wiring is the deliverable — and a wiring that does not FAIL on a real
 * error is the same defect one layer up. These tests are what make that claim checkable:
 * every negative control below plants a defect in a synthetic tree and asserts the gate
 * goes red and NAMES the package, each behind a positive control proving the same tree is
 * green without the plant.
 *
 * ── WHY IT IS HERE AND NOT IN `src-app/ui/scripts/gate-wiring.test.mjs` ─────────────
 * That file holds the pre-existing tests for this same script and its `synthRepo()`
 * harness is the direct ancestor of `synthRepo()` below — it is a real precedent and the
 * shape is deliberately recognizable. But it lives inside `src-app/ui`, whose own
 * `npm run check` is red with five pre-existing failures unrelated to this change
 * (#226 x1, #246 x4, reproduced on this branch's base). A proof that cannot be run
 * without inheriting somebody else's red is not much of a proof, so this one lives beside
 * the script it guards and is invoked by the same `just check-packages` recipe, AHEAD of
 * the gate itself — the ordering `check-guards` already states in its own header: "if a
 * guard has been edited without being re-pinned, its own PASS is worthless".
 *
 * Run:  node --test scripts/check-package-suites.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim()
const GATE = path.join(REPO, 'scripts/check-package-suites.mjs')

/**
 * The COMMITTED typecheck floor, over the REAL tree (today: `@ziee/viz`, `@ziee/dock`).
 *
 * It lives here rather than inside the gate for one reason, stated so it is not mistaken
 * for an oversight: the gate is deliberately runnable against a SYNTHETIC tree — that is
 * how every negative control below works — and a constant floor inside it would be a
 * statement about this repository asserted over trees where it is simply false. A floor is
 * a claim about a tree, so it belongs in the test that runs against that tree. The gate's
 * own fail-closed rule (P6: a TS project with no `typecheck` script is a hard failure) is
 * the part that must hold everywhere, and it does.
 *
 * Lowering this number is an explicit, reviewable edit. `docs/design/derived-guards.md` §5:
 * "A floor that is edited whenever it fires trains everyone to treat a red guard as
 * paperwork."
 */
const MIN_TYPECHECKED_PACKAGES = 2

/**
 * The floor, as a PURE PREDICATE rather than an inline `assert` — so the floor itself has a
 * negative control (below). A floor asserted in exactly one place, always over a tree that
 * satisfies it, is indistinguishable from a floor expression that can never fire; P4's floor
 * has such a control in `guard-floors.test.mjs` and this one had none.
 *
 * @returns null when the floor is met, else the failure message.
 */
/**
 * The rows the floor is a claim ABOUT: first-party packages the gate would typecheck.
 *
 * A pure function so it can be tested on its own. Counting every `typechecked` row let an
 * in-play `sdk/*` submodule satisfy THIS repo's floor with ANOTHER repo's packages while the
 * first-party set collapsed to zero — a floor met by something it makes no claim about. On
 * today's tree `sdk` is not in play, so the filter is a no-op and reverting it survives every
 * real-tree assertion; that is exactly why it needs its own unit test (TEST-19) rather than
 * only the real-tree one.
 */
function firstPartyTypechecked(plan, firstParty) {
  const set = new Set(firstParty)
  return plan.packages.filter(p => p.typecheck === 'typechecked' && set.has(p.rel))
}

function floorGap(count) {
  if (count >= MIN_TYPECHECKED_PACKAGES) return null
  return (
    `the gate would typecheck only ${count} package(s), below the committed floor of ` +
    `${MIN_TYPECHECKED_PACKAGES}. Either the workspace globs no longer match (a rename/move), or a ` +
    `package lost its \`typecheck\` script. A gate that typechecks (almost) nothing must not pass.`
  )
}

/**
 * The first-party workspace directories, DERIVED from the root `package.json` `workspaces`
 * patterns — independently of the gate.
 *
 * TEST-5 used to hardcode `readdirSync('src-app/libs')`, which meant a first-party glob added
 * anywhere else (`src-app/tools/*`, say) would join the gate but not its proof — INV-1's own
 * failure mode, one level up, in the guard OF the guard. This re-derives from the same
 * declaration the gate reads, but by its own code: an independent re-derivation is the point.
 * If it agreed with the gate by construction it would prove nothing.
 */
function firstPartyWorkspaceDirs() {
  const root = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages
  assert.ok(Array.isArray(patterns) && patterns.length, 'the root package.json declares no `workspaces`')
  const gitmodules = path.join(REPO, '.gitmodules')
  const submodules = existsSync(gitmodules)
    ? [...readFileSync(gitmodules, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)].map(m => m[1].trim())
    : []
  const out = []
  for (const pattern of patterns) {
    // Mirror the gate's P1 refusal. Treating an un-expandable glob as a literal path would
    // silently drop every package under it — the exact failure P1 exists to make loud, in the
    // guard OF the guard.
    assert.ok(
      !pattern.includes('*') || /^[^*]+\/\*$/.test(pattern),
      `workspace pattern \`${pattern}\` is one this test cannot expand; teach it rather than ` +
        `let every package under it drop out of the proof`,
    )
    const rels = pattern.endsWith('/*')
      ? (existsSync(path.join(REPO, pattern.slice(0, -2)))
          ? readdirSync(path.join(REPO, pattern.slice(0, -2)), { withFileTypes: true })
              .filter(e => e.isDirectory() && e.name !== 'node_modules')
              .map(e => `${pattern.slice(0, -2)}/${e.name}`)
          : [])
      : [pattern]
    for (const r of rels) {
      if (submodules.some(sm => r === sm || r.startsWith(sm + '/'))) continue // another repo's
      if (r === 'src-app/ui') continue // ALREADY_GATED: ui's own `npm run check` starts with tsc
      if (!existsSync(path.join(REPO, r, 'package.json'))) continue
      out.push(r)
    }
  }
  return out.sort()
}

const justfile = () => readFileSync(path.join(REPO, 'justfile'), 'utf8')
/** Executable justfile lines only — a recipe's explanatory comment block is not wiring. */
const justCode = () =>
  justfile()
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .join('\n')

/** The body lines of a just recipe, by name. */
function recipeBody(name) {
  const lines = justfile().split('\n')
  const start = lines.findIndex(l => new RegExp(`^${name}(\\s|:)`).test(l) && l.includes(':'))
  if (start < 0) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) break
    body.push(l.trim())
  }
  return body
}

/**
 * Parse a `--json` run, asserting its exit status FIRST.
 *
 * `--json` emits pure JSON even on a FAILING run (the failures go to stderr after the
 * payload), so parsing without checking the status is a test that passes over a red gate.
 *
 * SCOPE OF THE `failures` EQUIVALENCE, stated because it is not universal: it holds on the
 * `--json`/`--list` path, where the gate exits non-zero iff `failures` is non-empty. A
 * FLAGLESS run can also exit 1 from SPAWN results with `failures` empty (a package's suite or
 * typecheck failed, which is not a wiring failure), so `planOf(r, 1)` is only meaningful for a
 * `--json` run. No caller does otherwise; this note is so none starts.
 */
function planOf(r, expected = 0) {
  assert.equal(r.status, expected, `expected exit ${expected}, got ${r.status}\n${r.stdout}\n${r.stderr}`)
  // The gate's two pre-JSON aborts print NOTHING, and `JSON.parse('')` throws an opaque
  // SyntaxError that hides which abort fired. Say so instead.
  assert.ok(r.stdout.trim(), `the gate produced no JSON at all (pre-payload abort):\n${r.stderr}`)
  const plan = JSON.parse(r.stdout)
  // The payload's `failures` array must AGREE with the exit status. Nothing asserted it, so a
  // mutant emitting `failures: []` while still exiting 1 survived — the machine-readable view
  // and the human one could disagree about whether the tree is broken, which is precisely the
  // state a consumer of `--json` cannot detect.
  assert.ok(Array.isArray(plan.failures), '`--json` lost its `failures` array')
  assert.equal(
    plan.failures.length === 0,
    expected === 0,
    `\`failures\` (${JSON.stringify(plan.failures)}) disagrees with exit ${r.status}`,
  )
  return plan
}

/** Enumerate-only run of the REAL gate against the REAL tree. */
function realPlan() {
  const r = spawnSync(process.execPath, [GATE, '--json'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(r.status, 0, `check-package-suites.mjs --json exited ${r.status}\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout)
}

/**
 * A synthetic repo: the REAL gate script, a fake tree.
 *
 * Shape borrowed from `src-app/ui/scripts/gate-wiring.test.mjs`'s `synthRepo()` so the two
 * stay recognizably the same kind of test. The two baseline packages exist to satisfy P4's
 * committed floor of 2 gated suites, so every failure below is attributable to the planted
 * defect rather than to the fixture being too small.
 */
function synthRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pkg-typecheck-gate-'))
  try {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    writeFileSync(path.join(dir, 'scripts/check-package-suites.mjs'), readFileSync(GATE))
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
    /** @param opts `{ tsconfig: boolean }` — does the package DECLARE a TypeScript project? */
    const addPkg = (name, scripts, { tsconfig = false } = {}) => {
      const d = path.join(dir, 'src-app/libs', name)
      mkdirSync(path.join(d, 'src'), { recursive: true })
      writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@synth/${name}`, scripts }))
      if (tsconfig) writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
      return d
    }
    const run = (...args) => {
      clearMarkers(dir) // evidence describes THIS run only — see `marks()`
      return spawnSync(process.execPath, [path.join(dir, 'scripts/check-package-suites.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    }
    return fn({ dir, addPkg, run })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A script that PROVES IT RAN by writing a marker naming WHICH script it was, then exiting
 * with `code`. npm runs a workspace script with cwd = that package, so the marker lands in
 * the package directory (verified: npm's own error output names the package path).
 *
 * ── WHY THE MARKER NAMES THE SCRIPT, AND WHY RUNS CLEAR IT ──────────────────────────
 * Three rounds of blind audit found the same defect in three costumes, each weaker than it
 * looked:
 *
 *   1. assert on the gate's `--json` CLASSIFICATION  → proves nothing was spawned.
 *   2. assert on the `══════ … npm run typecheck … ══════` BANNER → the gate prints it
 *      immediately BEFORE the spawn, so it proves the gate reached the line above it.
 *   3. assert on a single per-PACKAGE `.ran` marker → two defects at once. It could not say
 *      WHICH script wrote it (a package declaring both `test` and `typecheck` writes the
 *      same file either way, so a gate that skipped the typecheck of any package that also
 *      has a suite stayed green), and nothing cleared it between runs, so an assertion about
 *      the SECOND run was satisfied by the FIRST run's marker.
 *
 * So the marker names the script (`.ran-typecheck` / `.ran-test`) and `run()` deletes every
 * marker in the tree before it spawns the gate. Evidence therefore describes exactly one
 * script, in exactly one run, and cannot be inherited. That also makes the NEGATIVE form
 * usable — `!ranScript(...)` is now a real assertion that something did NOT execute, which
 * is what a fail-closed claim needs.
 */
const marks = (kind, code = 0) =>
  `node -e "require('fs').writeFileSync('.ran-${kind}','1');process.exit(${code})"`

/** Did `<rel>`'s `<kind>` script actually EXECUTE in the most recent run? */
const ranScript = (dir, rel, kind) => existsSync(path.join(dir, rel, `.ran-${kind}`))
/** Shorthands for the common `src-app/libs/<name>` case. */
const ranTypecheck = (dir, name) => ranScript(dir, `src-app/libs/${name}`, 'typecheck')
const ranTest = (dir, name) => ranScript(dir, `src-app/libs/${name}`, 'test')

/** Delete every marker under `dir`, so markers only ever describe the NEXT run. */
function clearMarkers(dir) {
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const q = path.join(d, e.name)
      if (e.isDirectory()) walk(q)
      else if (/^\.ran-/.test(e.name)) rmSync(q, { force: true })
    }
  }
  walk(dir)
}

/** The two baseline packages every fixture starts from: runnable suites, no TS project. */
const baseline = addPkg => {
  addPkg('alpha', { test: 'exit 0' })
  addPkg('beta', { test: 'exit 0' })
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-5 — the real tree: every `src-app/libs/*` package with a `typecheck` script is
// classified `typechecked`, and the count clears the committed floor.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-5: every first-party workspace with a `typecheck` script is COVERED by the gate', () => {
  const firstParty = firstPartyWorkspaceDirs()
  // POSITIVE COUNT: an emptied tree would otherwise satisfy every assertion below.
  assert.ok(firstParty.length >= 2, `only ${firstParty.length} first-party workspace(s) derived: ${firstParty}`)

  const plan = realPlan()
  const seen = new Map(plan.packages.map(p => [p.rel, p]))
  let withScript = 0
  for (const rel_ of firstParty) {
    assert.ok(seen.has(rel_), `\`${rel_}\` is not seen by the gate — the workspace globs no longer reach it`)
    const row = seen.get(rel_)
    const pkg = JSON.parse(readFileSync(path.join(REPO, rel_, 'package.json'), 'utf8'))
    if (!pkg.scripts?.typecheck) continue
    withScript++
    assert.equal(
      row.typecheck,
      'typechecked',
      `\`${rel_}\` declares a \`typecheck\` script but the gate classified it \`${row.typecheck}\` ` +
        `(${row.typecheckReason}) — its typecheck would not run`,
    )
  }
  assert.ok(withScript >= 2, `only ${withScript} first-party workspace(s) declare a \`typecheck\` script`)

  const typechecked = firstPartyTypechecked(plan, firstParty)
  assert.equal(
    floorGap(typechecked.length),
    null,
    `${floorGap(typechecked.length)} (first-party typechecked: ${typechecked.map(t => t.name)})`,
  )
  // And every row carries a NAMED typecheck disposition — never a quiet sixth outcome.
  for (const p of plan.packages)
    assert.ok(
      ['typechecked', 'excluded', 'skipped', 'UNTYPECHECKED', 'UPSTREAM-GAP'].includes(p.typecheck) && p.typecheckReason,
      `\`${p.rel}\` has typecheck \`${p.typecheck}\` with reason \`${p.typecheckReason}\``,
    )
})

test('TEST-13 (floor control): the committed floor actually FIRES when the set collapses', () => {
  // Without this, an always-null `floorGap` would satisfy TEST-5 forever. The real tree is
  // never collapsed, so the only way to exercise the floor is to hand it the collapsed count.
  assert.equal(floorGap(MIN_TYPECHECKED_PACKAGES), null, 'the floor must PASS at exactly the floor')
  const gap = floorGap(MIN_TYPECHECKED_PACKAGES - 1)
  assert.ok(gap, 'the floor did not fire one below the floor — it can never fail')
  assert.match(gap, /below the committed floor of 2/)
  assert.ok(floorGap(0), 'the floor did not fire on an EMPTY typecheck set — the fail-closed case')
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST-6 — the wiring itself.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-19: the floor is a claim about FIRST-PARTY packages, not about whatever is in play', () => {
  // On today's tree `sdk` is not in play, so every submodule row classifies `excluded` and
  // the first-party filter is a no-op — reverting it survives every real-tree assertion.
  // A filter whose only test cannot distinguish it from its own absence is not tested, so
  // this exercises the scenario the real tree cannot reach: submodule packages typechecked
  // while first-party has collapsed.
  const firstParty = ['src-app/libs/viz', 'src-app/libs/dock']
  const inPlaySubmodulePlan = {
    packages: [
      { rel: 'sdk/packages/kit', typecheck: 'typechecked' },
      { rel: 'sdk/packages/gallery', typecheck: 'typechecked' },
      { rel: 'sdk/packages/shell', typecheck: 'typechecked' },
      { rel: 'src-app/libs/viz', typecheck: 'skipped' },
      { rel: 'src-app/libs/dock', typecheck: 'skipped' },
    ],
  }
  assert.equal(
    firstPartyTypechecked(inPlaySubmodulePlan, firstParty).length,
    0,
    "another repo's packages were counted toward this repo's floor",
  )
  assert.ok(
    floorGap(firstPartyTypechecked(inPlaySubmodulePlan, firstParty).length),
    'the floor did not fire while BOTH first-party packages had lost their typecheck',
  )
  // …and the honest positive: first-party rows DO count.
  const healthy = {
    packages: [
      { rel: 'sdk/packages/kit', typecheck: 'typechecked' },
      { rel: 'src-app/libs/viz', typecheck: 'typechecked' },
      { rel: 'src-app/libs/dock', typecheck: 'typechecked' },
    ],
  }
  assert.equal(firstPartyTypechecked(healthy, firstParty).length, 2)
  assert.equal(floorGap(firstPartyTypechecked(healthy, firstParty).length), null)
})

test('TEST-6: `just check` reaches the gate, and the recipe runs this guard before it', () => {
  assert.ok(existsSync(GATE), 'the gate script does not exist')
  const body = recipeBody('check-packages')
  assert.ok(body && body.length >= 2, 'the `check-packages` recipe body is missing or too short')
  assert.ok(
    body.some(l => l.includes('check-package-suites.mjs') && !l.includes('.test.mjs')),
    '`check-packages` no longer names the gate script',
  )
  assert.ok(
    body.some(l => l.includes('check-package-suites.test.mjs')),
    "`check-packages` no longer runs this file — the gate's own guard would be a test nobody invokes, " +
      'which is the exact failure this whole change exists to remove',
  )
  const guardIdx = body.findIndex(l => l.includes('check-package-suites.test.mjs'))
  const gateIdx = body.findIndex(l => l.includes('check-package-suites.mjs') && !l.includes('.test.mjs'))
  assert.ok(guardIdx < gateIdx, "the guard's own guard must run BEFORE the gate, per `check-guards`' stated ordering")
  assert.ok(
    recipeBody('check').some(l => /\bjust\s+check-packages\b/.test(l)),
    '`just check` no longer runs `just check-packages` — the package gates are ungated again',
  )
  // R5-A: a parameterised recipe would let a caller flag (`--list`, which runs NOTHING)
  // degrade the wired gate to a green no-op.
  assert.match(justCode(), /^check-packages:\s*$/m, '`check-packages` grew a parameter — the gate is degradable')
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance] [invariant: INV-1] — the typecheck set is DERIVED.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-1: a NEW package with a `typecheck` script joins the gate with NO edit to the gate', () => {
  synthRepo(({ addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    const before = planOf(run('--json'))
    assert.deepEqual(
      before.packages.filter(p => p.typecheck === 'typechecked').map(p => p.name).sort(),
      ['@synth/gamma'],
      'the pre-existing set must be known before the delta, or the delta proves nothing',
    )

    // The whole claim: a directory appears under a workspace glob and the gate covers it.
    // Nothing in `check-package-suites.mjs` is edited between these two runs.
    addPkg('delta', { test: 'exit 0', typecheck: 'tsc --noEmit' }, { tsconfig: true })
    const after = planOf(run('--json'))
    assert.deepEqual(
      after.packages.filter(p => p.typecheck === 'typechecked').map(p => p.name).sort(),
      ['@synth/delta', '@synth/gamma'],
      'a new workspace package declaring a `typecheck` script was NOT picked up — the set is enumerated, not derived',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST-2 [acceptance] [invariant: INV-3] — the gate is invoked, and it BITES.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-2: the typecheck EXECUTES, a failing one turns the gate red, and it masks NOTHING', () => {
  synthRepo(({ dir, addPkg, run }) => {
    // ORDER IS THE POINT. The gate walks packages in sorted order, so a no-masking claim is
    // only meaningful when the FAILING package sorts BEFORE the package whose execution is
    // the evidence. Sorted: alpha, beta, epsilon, gamma. Typechecked: epsilon, gamma.
    // The earlier version planted the failure in `gamma` — LAST — so "the ones after it"
    // was the empty set and a `break`-on-first-failure gate passed unnoticed.
    addPkg('alpha', { test: marks('test') })
    addPkg('beta', { test: marks('test') })
    // `epsilon` has a typecheck and NO test script: the control that makes "typechecked"
    // mean EXECUTED rather than CLASSIFIED, since a run set narrowed to packages with a
    // suite would silently skip it.
    addPkg('epsilon', { typecheck: marks('typecheck') }, { tsconfig: true })
    addPkg('gamma', { test: marks('test'), typecheck: marks('typecheck') }, { tsconfig: true })

    // POSITIVE CONTROL: everything green, and everything actually ran.
    const ok = run()
    assert.equal(ok.status, 0, `the clean synthetic tree must pass:\n${ok.stdout}\n${ok.stderr}`)
    for (const n of ['epsilon', 'gamma'])
      assert.ok(ranTypecheck(dir, n), `@synth/${n}'s typecheck never EXECUTED — it was only classified`)
    for (const n of ['alpha', 'beta', 'gamma'])
      assert.ok(ranTest(dir, n), `@synth/${n}'s suite never EXECUTED`)
    assert.match(ok.stdout, /2 package typecheck\(s\) and 3 package suite\(s\) passed/)
    // The human-readable banner is the gate's OUTPUT contract — it is what tells a reader
    // which package and which command is running. Markers prove execution and say nothing
    // about the log, so without this a rename goes unnoticed. Kept deliberately separate
    // from the execution evidence above: this asserts the LOG, that asserts the BEHAVIOUR.
    assert.match(
      ok.stdout,
      /══════ check-packages: @synth\/gamma \(src-app\/libs\/gamma\) — npm run typecheck --workspace @synth\/gamma ══════/,
      "the gate's per-package typecheck banner no longer names the package and the command it runs",
    )
    assert.match(
      ok.stdout,
      /══════ check-packages: @synth\/gamma \(src-app\/libs\/gamma\) — npm run test --workspace @synth\/gamma ══════/,
      "the gate's per-package SUITE banner no longer names the package and the command it runs",
    )

    // THE PLANT: epsilon's typecheck fails. epsilon sorts BEFORE gamma among the typechecked,
    // so gamma's typecheck marker is the real no-masking evidence.
    addPkg('epsilon', { typecheck: marks('typecheck', 2) }, { tsconfig: true })
    const bad = run()
    assert.notEqual(bad.status, 0, 'a package whose typecheck FAILS passed the gate — the wiring does not bite')
    assert.ok(ranTypecheck(dir, 'epsilon'), 'the failing typecheck never ran, so the red says nothing about it')
    // The GATE's own failure line, verbatim. A bare /@synth\/epsilon/ over stderr is VACUOUS:
    // npm's inherited stderr already prints `npm error workspace @synth/epsilon`.
    assert.match(
      bad.stderr,
      /✗ check-packages — 1 package typecheck\(s\) FAILED \(P6\): @synth\/epsilon/,
      "the gate's own failure line must name the failing package",
    )

    // NO MASKING, both loops, proved by EXECUTION of packages ordered AFTER the failure:
    assert.ok(ranTypecheck(dir, 'gamma'), 'a failing typecheck stopped the typecheck loop — gamma never ran')
    for (const n of ['alpha', 'beta', 'gamma'])
      assert.ok(ranTest(dir, n), `a failing typecheck masked @synth/${n}'s suite — it never ran`)
    assert.match(
      bad.stdout,
      /TEST SUITES \(P5\)\n(?:\s+@synth\/\w+\s+exit 0\n){3}/,
      'the TEST SUITES summary does not carry an exit line for all three suites',
    )
    assert.match(bad.stdout, /NOT typechecked \(no TypeScript on disk\): @synth\/alpha, @synth\/beta/)

    // AND THE OTHER DIRECTION, which the plant above cannot reach: `epsilon` has no suite,
    // so "its typecheck failed" and "its suite was skipped" are indistinguishable there. A
    // gate that skips the SUITE of any package whose own typecheck failed — a plausible and
    // wrong optimisation — survived everything until this leg. `gamma` has BOTH scripts.
    addPkg('gamma', { test: marks('test'), typecheck: marks('typecheck', 2) }, { tsconfig: true })
    const both = run()
    assert.notEqual(both.status, 0)
    assert.match(both.stderr, /2 package typecheck\(s\) FAILED \(P6\): @synth\/epsilon, @synth\/gamma/)
    assert.ok(
      ranTest(dir, 'gamma'),
      "gamma's own typecheck failed and the gate skipped its SUITE — a red typecheck must not " +
        'decide whether the tests run; they are separate signals and the gate reports both',
    )
  })
})

test('TEST-17: the gate is FATAL in its real, FLAGLESS invocation — for EVERY classification rule', () => {
  // TWO HOLES THIS CLOSES.
  //
  // (1) Every other negative control runs the gate as `--list`, but both real invocations —
  //     the `check-packages` justfile recipe and the preserved CI workflow — pass NO flags.
  //     Putting the classification `process.exit(1)` behind `if (listOnly)` made every
  //     P1-P6/S1/S2 failure non-fatal on the only path the repo uses, suite green.
  //
  // (2) Planting only a P6 defect is not enough: an exit made conditional on
  //     `failures.some(f => /^P6:/.test(f))` leaves P1/P2/P3/P4/S1/S2 non-fatal and still
  //     passes. So this plants a P3 violation as well — a DIFFERENT rule — and asserts the
  //     flagless run is fatal for it too.
  synthRepo(({ dir, addPkg, run }) => {
    addPkg('alpha', { test: marks('test') })
    addPkg('beta', { test: marks('test') })
    addPkg('gamma', { test: marks('test'), typecheck: marks('typecheck') }, { tsconfig: true })
    assert.equal(run().status, 0, 'positive control: the clean tree passes a flagless full run')
    assert.ok(ranTypecheck(dir, 'gamma'), 'positive control: the clean run really executed the typecheck')
    assert.ok(ranTest(dir, 'gamma'), 'positive control: the clean run really executed the suite')

    // P6: a TypeScript project with no typechecker.
    addPkg('delta', { test: 'exit 0' }, { tsconfig: true })
    const p6 = run()
    assert.equal(p6.status, 1, 'a P6 classification failure was NOT fatal in the flagless run — the real path')
    assert.match(p6.stderr, /P6:/)
    assert.match(p6.stderr, /delta/)
    // FAIL-CLOSED, proved by ABSENCE of execution rather than by absence of a log line.
    // Markers are cleared before every run, so `!ran…` is now a real assertion — the earlier
    // version had to grep for a missing banner, which a rename defeated, and which could not
    // distinguish "never spawned" from "spawned after the failure was known".
    assert.ok(!ranTypecheck(dir, 'gamma'), 'the gate ran a typecheck over a wiring it had already refused')
    assert.ok(!ranTest(dir, 'alpha'), 'the gate ran a suite over a wiring it had already refused')

    // P3, a DIFFERENT rule: test files on disk with no `test` script.
    rmSync(path.join(dir, 'src-app/libs/delta'), { recursive: true, force: true })
    // A JavaScript test file, deliberately: a `.ts` one would ALSO trip P6 (TypeScript source
    // with no typechecker), and then a mutant that made the flagless exit conditional on P6
    // alone would still exit 1 here and survive. The whole point of this leg is a failure
    // from a DIFFERENT rule, so it must be P3 and ONLY P3.
    const d = addPkg('zeta', { build: 'tsc' })
    writeFileSync(path.join(d, 'src/thing.test.js'), '// test\n')
    const p3 = run()
    assert.equal(p3.status, 1, 'a P3 classification failure was NOT fatal in the flagless run')
    assert.match(p3.stderr, /P3:/)
    assert.doesNotMatch(p3.stderr, /P6:/, 'this leg must isolate P3 — a P6 failure here would mask the mutant it hunts')
    assert.ok(!ranTest(dir, 'alpha'), 'the gate ran a suite over a P3-broken wiring')
  })
})

test('TEST-18: a FAILING package suite turns the gate red, names it, and masks NOTHING (P5)', () => {
  // The gate's ORIGINAL reason for existing — "a merge broke VizController.events.test.ts
  // and every gate passed it through" — was asserted by NO test in this repo, so `const bad
  // = []` survived as a mutant. And P5's headline claim, "a failing package does NOT mask
  // the ones after it", had no test either: the failure was planted in the package that
  // sorts FIRST, so a `break` on failure was indistinguishable from correct behaviour.
  synthRepo(({ dir, addPkg, run }) => {
    addPkg('alpha', { test: marks('test') })
    addPkg('beta', { test: marks('test') })
    addPkg('gamma', { test: marks('test') })
    assert.equal(run().status, 0, 'positive control: three passing suites are green')
    for (const n of ['alpha', 'beta', 'gamma'])
      assert.ok(ranTest(dir, n), `positive control: @synth/${n}'s suite did not actually run`)

    // ALPHA fails — it sorts FIRST, so beta and gamma are genuinely "the ones after it".
    addPkg('alpha', { test: marks('test', 1) })
    const bad = run()
    assert.equal(bad.status, 1, 'a FAILING package suite passed the gate')
    assert.match(
      bad.stderr,
      /✗ check-packages — 1 package suite\(s\) FAILED: @synth\/alpha/,
      "the gate's own failure line must name the failing suite",
    )
    assert.ok(ranTest(dir, 'alpha'), 'the failing suite never ran, so the red says nothing about it')
    for (const n of ['beta', 'gamma'])
      assert.ok(ranTest(dir, n), `a failing suite MASKED @synth/${n} — it never ran (P5's whole claim)`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance] [invariant: INV-2] — the guard cannot be silently relaxed.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-3: the ui typecheck exemption is re-derived, and no caller flag makes a red tree green', () => {
  // (a) `src-app/ui` is the ONE in-scope workspace P6 does not typecheck, because ui's own
  //     `check` chain contains `tsc --noEmit`. That is an exemption, so it is re-derived on
  //     every run rather than remembered.
  synthRepo(({ dir, addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    assert.equal(run('--list').status, 0, 'positive control: the untouched fixture is green')

    // The dropped `tsc --noEmit` is MOVED into a sibling script, not deleted from the file.
    // That is what makes this control bite: an implementation that searched the whole
    // package.json instead of `scripts.check` would find it here and pass, while ui's
    // `check` no longer typechecks anything. With the string simply absent, that mutant
    // survived.
    writeFileSync(
      path.join(dir, 'src-app/ui/package.json'),
      JSON.stringify({ name: 'synth-ui', scripts: { check: 'npm run test:unit', typecheck: 'tsc --noEmit' } }),
    )
    const r = run('--list')
    assert.equal(r.status, 1, "ui's check chain lost `tsc --noEmit` and its typecheck exemption still passed")
    assert.match(r.stderr, /P6:/, 'a P6 hole must be reported under P6, not under another rule id')
    assert.match(r.stderr, /typechecked by\s+NOTHING/)
  })

  // (b) `--list` runs nothing, so it is the obvious way to "pass" a red tree. It must report
  //     the violation and exit non-zero exactly like the full run does — the guard is not
  //     degradable through its own flags (which is also why the wired recipe takes no
  //     parameters; see TEST-6).
  synthRepo(({ addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    // POSITIVE CONTROL in THIS fixture — the header claims every negative control has one,
    // and this leg did not.
    assert.equal(run('--list').status, 0, 'positive control: the untouched fixture is green under --list')

    addPkg('delta', { test: 'exit 0' }, { tsconfig: true }) // TS project, no typechecker
    const r = run('--list')
    assert.equal(r.status, 1, '`--list` turned a P6 violation into a green enumerate-only run')
    assert.match(r.stderr, /P6:/)
    assert.match(r.stderr, /delta/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST-4 [acceptance] [invariant: INV-4] — a TS project with no typechecker is a HARD failure.
// ─────────────────────────────────────────────────────────────────────────────
test('TEST-4: a package with TypeScript and NO `typecheck` script FAILS the gate (P6)', () => {
  synthRepo(({ addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    const ok = run('--list')
    assert.equal(ok.status, 0, `positive control: the clean tree must pass:\n${ok.stdout}\n${ok.stderr}`)

    addPkg('delta', { test: 'exit 0' }, { tsconfig: true })
    const bad = run('--list')
    assert.equal(bad.status, 1, 'a TypeScript project that nothing can typecheck passed the gate')
    assert.match(bad.stderr, /P6:/)
    assert.match(bad.stderr, /delta/, 'the failure must NAME the package')
    assert.match(bad.stderr, /NO `typecheck` script/)

    // The MACHINE-READABLE view must agree with the human one. `planOf` cross-checks
    // `failures` against the exit status, but every other call in this file expects exit 0,
    // so the disagreeing case was never exercised and a mutant emitting `failures: []` while
    // still exiting 1 survived — `--json`'s consumer would read a clean tree off a red gate.
    // This is the only place that runs `--json` over a tree KNOWN to be broken.
    const plan = planOf(run('--json'), 1)
    assert.ok(plan.failures.length >= 1, '`--json` reported NO failures for a tree the gate just refused')
    assert.ok(
      plan.failures.some(f => /^P6:/.test(f) && /delta/.test(f)),
      `\`--json\` failures do not name the P6 violation: ${JSON.stringify(plan.failures)}`,
    )
  })
})

test('TEST-14: P6 does NOT inherit P3\'s scope — a test-LESS TypeScript package still fails', () => {
  // THE CASE WHERE P3 AND P6 DIVERGE, and the one a mutation slipped through. A package with
  // no test script and no test files is classified `skipped` by the TEST half — legitimately,
  // per the gate's own "no-test-script decision". A mutant that let that `skipped` carry over
  // to the typecheck half (`if (r.status === 'skipped') { r.typecheck = 'skipped'; continue }`)
  // exempted every test-less package from P6 and left the whole suite green. A types-only or
  // barrel package — exactly what that decision contemplates — is the realistic instance.
  synthRepo(({ addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    assert.equal(run('--list').status, 0, 'positive control: the clean tree passes')

    addPkg('zeta', { build: 'tsc -b' }, { tsconfig: true }) // no `test`, no tests, no typecheck
    const bad = run('--list')
    assert.equal(bad.status, 1, 'a test-LESS TypeScript package escaped P6 by being `skipped` for tests')
    assert.match(bad.stderr, /P6:/)
    assert.match(bad.stderr, /zeta/)
    // And it is P6 that catches it — P3 has nothing to say here, which is the whole point.
    assert.doesNotMatch(bad.stderr, /P3:/, 'P3 should be silent: there are no test files to be unrunnable')
  })
})

test('TEST-15: deleting the tsconfig does NOT buy an exemption — the SOURCE is evidence too', () => {
  // P3's subject is test FILES on disk, which cannot be deleted without removing the tests.
  // If P6's subject were only `tsconfig.json`, a package could drop the tsconfig AND the
  // typecheck script and go silently `skipped` with its TypeScript still shipping — a dodge
  // with no P3 analogue. So the source itself counts.
  synthRepo(({ dir, addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    assert.equal(run('--list').status, 0, 'positive control: the clean tree passes')

    const d = addPkg('theta', { test: 'exit 0' }) // NO tsconfig, NO typecheck …
    writeFileSync(path.join(d, 'src/thing.ts'), 'export const x = 1\n') // … but real TS source
    const bad = run('--list')
    assert.equal(bad.status, 1, 'TypeScript source with no typechecker and no tsconfig passed the gate')
    assert.match(bad.stderr, /P6:/)
    assert.match(bad.stderr, /theta/)
    assert.match(bad.stderr, /TypeScript source on disk/, 'the failure must say WHICH evidence it found')
  })
})

test('TEST-16: a package with NO TypeScript on disk is a NAMED skip, never silent', () => {
  // The ratchet that makes the loud skip safe: a genuinely TS-free package must not be
  // pushed toward `"typecheck": "exit 0"`, which would be an INVISIBLE skip — strictly
  // worse than a printed one. The moment it grows a tsconfig, TEST-4 above applies.
  synthRepo(({ addPkg, run }) => {
    baseline(addPkg)
    addPkg('gamma', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    const plan = planOf(run('--json'))
    const alpha = plan.packages.find(p => p.rel === 'src-app/libs/alpha')
    assert.equal(alpha.typecheck, 'skipped')
    assert.match(alpha.typecheckReason, /no TypeScript on disk, no `typecheck` script/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S3/P6 — the SUBMODULE asymmetry, which is a deliberate design decision and therefore
// needs a test rather than a comment.
//
// A first-party package that declares a TypeScript project with no `typecheck` script is a
// HARD FAILURE (TEST-4). The identical shape inside an IN-PLAY submodule is reported loudly
// on every run and is NOT fatal, because the remedy — adding a `typecheck` script — lives in
// the other repository, and failing here would only train people to bypass the gate. That is
// the same split the pre-existing S3 already makes for the `test` case.
//
// Measured on the real tree with `sdk` made dirty: `@ziee/{framework,gallery,kit,shell}` are
// typechecked, and `@ziee/{notification-ui,test-e2e}` come back as gaps. Without this test
// that whole branch of the classifier would be code no suite ever reaches.
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic PARENT repo with a real nested submodule. Shape from `gate-wiring.test.mjs`. */
function synthSubmoduleRepo(fn) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pkg-typecheck-sub-')))
  const git_ = (args, cwd = dir) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  try {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    writeFileSync(path.join(dir, 'scripts/check-package-suites.mjs'), readFileSync(GATE))
    mkdirSync(path.join(dir, 'src-app/ui'), { recursive: true })
    mkdirSync(path.join(dir, 'src-app/libs'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'synth',
        private: true,
        workspaces: ['sdk/packages/*', 'src-app/libs/*', 'src-app/ui'],
      }),
    )
    writeFileSync(path.join(dir, 'justfile'), 'check:\n    cd ui && npm run check\n')
    writeFileSync(
      path.join(dir, 'src-app/ui/package.json'),
      JSON.stringify({ name: 'synth-ui', scripts: { check: 'tsc --noEmit && npm run test:unit' } }),
    )
    const addPkg = (rel, name, scripts, { tsconfig = false } = {}) => {
      const d = path.join(dir, rel, name)
      mkdirSync(path.join(d, 'src'), { recursive: true })
      writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@synth/${name}`, scripts }))
      if (tsconfig) writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
      return d
    }
    addPkg('src-app/libs', 'alpha', { test: 'exit 0' })
    addPkg('src-app/libs', 'beta', { test: 'exit 0' })
    git_(['init', '-q', '-b', 'main'])
    git_(['add', '-A'])
    git_(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base'])

    writeFileSync(
      path.join(dir, '.gitmodules'),
      '[submodule "sdk"]\n\tpath = sdk\n\turl = https://example.invalid/sdk\n',
    )
    /** A REAL nested repository, so S1's `rev-parse --show-toplevel == dir` test passes. */
    const initSubmodulePkg = (name, scripts, opts) => {
      const sd = path.join(dir, 'sdk')
      addPkg('sdk/packages', name, scripts, opts)
      git_(['init', '-q', '-b', 'main'], sd)
      git_(['add', '-A'], sd)
      git_(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'sub'], sd)
    }
    const run = (...args) => {
      clearMarkers(dir)
      return spawnSync(process.execPath, [path.join(dir, 'scripts/check-package-suites.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    }
    return fn({ dir, addPkg, initSubmodulePkg, run })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('TEST-12 (S3/P6): an in-play submodule TS project with no `typecheck` script is a LOUD gap, not a hard failure', () => {
  synthSubmoduleRepo(({ addPkg, initSubmodulePkg, run }) => {
    // `zeta` has a runnable suite (so the S2 ratchet is satisfied: an in-play submodule must
    // contribute something) and a TypeScript project with NO typechecker. The base ref
    // `origin/main` does not resolve in this fixture, which the gate treats as IN PLAY —
    // the documented fail-toward-running behaviour.
    initSubmodulePkg('zeta', { test: 'exit 0' }, { tsconfig: true })
    // An upstream typecheck gap must NOT be fatal — `planOf` asserts exit 0 before parsing.
    const plan = planOf(run('--json'))
    const zeta = plan.packages.find(p => p.rel === 'sdk/packages/zeta')
    assert.equal(zeta.typecheck, 'UPSTREAM-GAP')
    assert.deepEqual(
      plan.typecheckUpstreamGaps.map(g => g.rel),
      ['sdk/packages/zeta'],
      'the gap must be NAMED in the machine-readable plan, not merely absent from the run set',
    )
    // It is kept OUT of the `test`-half gap list, whose every reader prints an "N test
    // file(s)" count a typecheck gap does not have.
    assert.deepEqual(plan.upstreamGaps.map(g => g.rel), [], 'a typecheck gap leaked into the test-file gap list')

    // THE ASYMMETRY, asserted rather than asserted-about: the SAME shape first-party is fatal.
    addPkg('src-app/libs', 'gamma', { test: 'exit 0' }, { tsconfig: true })
    const fatal = run('--list')
    assert.equal(fatal.status, 1, 'a first-party TS project with no typechecker must be a hard failure')
    assert.match(fatal.stderr, /P6:/)
    assert.match(fatal.stderr, /gamma/)
    assert.doesNotMatch(fatal.stderr, /zeta/, 'the submodule package must not have become fatal too')
  })
})

test('TEST-12 (S3/P6 positive control): an in-play submodule package WITH a `typecheck` script IS typechecked', () => {
  // Without this, the test above would pass just as well against a gate that ignored
  // submodules entirely — "not fatal" and "not looked at" are indistinguishable outcomes.
  synthSubmoduleRepo(({ initSubmodulePkg, run }) => {
    initSubmodulePkg('zeta', { test: 'exit 0', typecheck: 'exit 0' }, { tsconfig: true })
    const plan = planOf(run('--json'))
    const zeta = plan.packages.find(p => p.rel === 'sdk/packages/zeta')
    assert.equal(zeta.typecheck, 'typechecked')
    assert.match(zeta.typecheckReason, /submodule `sdk` IN PLAY/)
    assert.deepEqual(plan.typecheckUpstreamGaps, [])
  })
})
