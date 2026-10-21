// ITEM-37 — EVERY committed guard FAILS CLOSED when its hard-coded scan set collapses.
//
// ## Why this file exists
//
// This round produced FOUR live fail-open incidents: a guard printed PASS having
// scanned ZERO files, in the very commit that moved its subject out from under it.
// (`check-kinds-zero-core.sh`, `check-no-legacy-wire.sh` twice, plus the
// `git ls-files --cached` → `--cached --others` staging fixes.) Three were fixed
// opportunistically. This finishes the job systematically.
//
// The property under test is NOT "the guard is correct" — each guard has its own
// tests for that. It is the WEAKER, UNIVERSAL property that a guard whose scan set
// resolves to (almost) nothing must EXIT NON-ZERO instead of congratulating itself.
// Every guard below carries a COMMITTED floor constant, so shrinking its coverage
// requires an explicit, reviewable edit rather than a silent rename.
//
// Run directly:  node --test scripts/guard-floors.test.mjs
//
// ## The guard inventory (repo-root `scripts/` + `src-app/ui/scripts/`)
//
// | guard                                | floor constant                          | how it collapses |
// |--------------------------------------|-----------------------------------------|------------------|
// | check-kinds-zero-core.sh             | `CORE_FILES` named-path assertion       | CORE_FILES renamed |
// | check-no-legacy-wire.sh              | `assert_all_present` over 3 named sets  | scan-set paths renamed |
// | check-no-study-domain-literals.sh    | `MIN_FILES=1500`                        | `src-app/**` renamed |
// | check-processor-seed-versions.sh     | `MIN_PACKAGES=5`                        | `<pkg>/manifest.yaml` layout renamed |
// | coercion-parity.mjs                  | `MIN_CORPUS_CASES=120`                  | corpus emptied/truncated |
// | check-package-suites.mjs             | `MIN_GATED_PACKAGES=2`                  | workspace globs / package dirs renamed |
// | coercion-parity-ws-check.mjs         | exact-copy-count assert (`checkSix`)    | a mirror deleted/renamed |
// | lint-no-domain-in-builtin.mjs        | `SCAN_FLOORS{rust,workbenchFe,extraFe}` | scan roots renamed |
// | collect-actions.mjs                  | `MIN_SOURCE_FILES` + `MIN_VIEWSPEC_FILES` | SRC_ROOT / VIEWSPEC_ROOT renamed |
// | action-refs-lint.mjs                 | `MIN_SOURCE_FILES=400`                  | SRC_ROOT renamed |
// | action-coverage.mjs                  | `MIN_SOURCE_FILES=400`                  | SRC_ROOT renamed |
//
// NOT guards (deliberately absent): `ts-resolve*.mjs` (module loaders),
// `viz-bench/viz-perf` (benchmarks), `preland-frontend-health.mjs`
// and `verify-backend-merge.sh` (diff-driven merge gates with no fixed scan set),
// `dev-sandbox-bootstrap.sh` (a host bootstrap), `coercion-parity-ts.mjs` (a READER
// invoked by the runner, not a standalone gate), and `*.test.mjs` (tests).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_SCRIPTS = __dirname
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim()
const ROOT_SCRIPTS = path.join(REPO_ROOT, 'scripts')

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-floor-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** An empty-but-real git repo — the realistic "the paths moved" shape for a `.sh`
 *  guard, every one of which starts with `cd $(git rev-parse --show-toplevel)`. */
function emptyRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'guard@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'guard'], { cwd: dir })
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  writeFileSync(path.join(dir, 'placeholder.txt'), 'x\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir })
  return dir
}

function runShellGuardInEmptyRepo(name, extra = {}) {
  return withTmp(dir => {
    emptyRepo(dir)
    copyFileSync(path.join(ROOT_SCRIPTS, name), path.join(dir, 'scripts', name))
    for (const rel of extra.mkdirs ?? []) mkdirSync(path.join(dir, rel), { recursive: true })
    const r = spawnSync('bash', [path.join('scripts', name)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...(extra.env ?? {}) },
    })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  })
}

function runNode(script, env = {}) {
  const r = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

// ── repo-root shell guards ──────────────────────────────────────────────────

// artifact-model ITEM-12/13 UPGRADED these two guards from a COUNT floor
// (`MIN_FILES=8` / `READER_MIN=4`) to a NAMED-PATH assertion, because a count is the
// weaker property: it passes for any N files including N of the WRONG ones, it cannot
// say WHICH hard-coded path stopped resolving, and it rots on every legitimate deletion
// (which is precisely how it rotted when the serve core and the native array reader were
// deleted). The property under test is unchanged — a collapsed scan set must EXIT
// NON-ZERO, never congratulate itself — so these two assert the new failure text and
// additionally assert that the failure NAMES the paths, which the old floor could not.
test('[ITEM-37] check-kinds-zero-core.sh FAILS when CORE_FILES resolve to nothing', () => {
  const { code, stdout } = runShellGuardInEmptyRepo('check-kinds-zero-core.sh')
  assert.notEqual(code, 0, 'a collapsed app-core scan set must not PASS')
  assert.match(stdout, /a guarded app-core path no longer exists/)
  // …and it names them, which is the whole reason the count floor was replaced.
  assert.match(stdout, /src-app\/server\/src\/modules\/workstore\/data_api\.rs/)
  assert.doesNotMatch(stdout, /^PASS/m)
})

test('[ITEM-37] check-no-legacy-wire.sh FAILS when the serve/wire/FE scan sets resolve to nothing', () => {
  const { code, stdout } = runShellGuardInEmptyRepo('check-no-legacy-wire.sh')
  assert.notEqual(code, 0, 'a collapsed serve/wire/FE scan set must not PASS')
  assert.match(stdout, /a guarded path no longer exists/)
  // All THREE scan sets must report, not just the first — a guard that stops at the
  // first missing path hides the other two collapsing behind it.
  assert.match(stdout, /\[INV-1 domain-free serve decision\]/)
  assert.match(stdout, /\[no-legacy-wire \(backend\)\]/)
  assert.match(stdout, /\[no-legacy-wire \(frontend\)\]/)
  assert.doesNotMatch(stdout, /^PASS/m)
})

test('[ITEM-37] check-no-study-domain-literals.sh FAILS when `src-app/**` resolves to nothing', () => {
  const { code, stdout } = runShellGuardInEmptyRepo('check-no-study-domain-literals.sh')
  assert.notEqual(code, 0, 'a collapsed product-source scan set must not PASS')
  assert.match(stdout, /scan set resolved to 0 file\(s\), below the/)
  assert.doesNotMatch(stdout, /^PASS: 0 surviving study\/Study/m)
})

test('[ITEM-37] check-processor-seed-versions.sh FAILS when no package manifest resolves', () => {
  const { code, stdout, stderr } = runShellGuardInEmptyRepo('check-processor-seed-versions.sh', {
    mkdirs: ['src-app/packages'],
    env: { BASE_REF: 'HEAD' },
  })
  assert.notEqual(code, 0, 'checking ZERO seed packages must not report clean')
  assert.match(stdout + stderr, /below the\n?\s*floor of|seed package manifest/)
  assert.doesNotMatch(stdout, /clean \(0 seed package/)
})

// ── repo-root node guards ───────────────────────────────────────────────────

test('[ITEM-37] coercion-parity.mjs FAILS on an empty/truncated corpus', () => {
  withTmp(dir => {
    // Copy the runner into a temp tree whose `src-app/testdata` corpus is EMPTY.
    // (`ROOT` is derived from the script's own location, so the copy re-roots it.)
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    mkdirSync(path.join(dir, 'src-app', 'testdata'), { recursive: true })
    for (const f of ['coercion-parity.mjs', 'coercion-parity-ws-check.mjs']) {
      copyFileSync(path.join(ROOT_SCRIPTS, f), path.join(dir, 'scripts', f))
    }
    writeFileSync(
      path.join(dir, 'src-app', 'testdata', 'criteria-coercion-corpus.json'),
      JSON.stringify({ cases: [] }),
    )
    const r = spawnSync(process.execPath, [path.join('scripts', 'coercion-parity.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, 'a parity run over an empty corpus proves nothing')
    assert.match(r.stderr, /CORPUS COLLAPSED/)
    assert.doesNotMatch(r.stdout, /agree cell-for-cell/)
  })
})

test('[ITEM-37] coercion-parity-ws-check.mjs FAILS when its mirrored sources are missing', () => {
  withTmp(dir => {
    // The ws-check reads FOUR hard-coded source paths. Re-rooted into an empty tree
    // they do not exist, and it must throw rather than report identical sets.
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    copyFileSync(
      path.join(ROOT_SCRIPTS, 'coercion-parity-ws-check.mjs'),
      path.join(dir, 'scripts', 'coercion-parity-ws-check.mjs'),
    )
    const r = spawnSync(process.execPath, [path.join('scripts', 'coercion-parity-ws-check.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, 'missing mirror sources must not read as "sets identical"')
    assert.doesNotMatch(r.stdout, /are identical/)
  })
})

// ── src-app/ui/scripts node guards ──────────────────────────────────────────
//
// Each already exposes a documented test-only ROOT override. Pointing it at an
// EMPTY-BUT-EXISTING directory is the realistic incident shape (a rename that moves
// the subtree, not one that deletes the root) — a bare non-existent path would only
// exercise `readdirSync`'s ENOENT, which is a weaker proof.

test('[ITEM-37] lint-no-domain-in-builtin.mjs FAILS when its scan roots collapse', () => {
  withTmp(dir => {
    const roots = JSON.stringify({
      serverModules: path.join(dir, 'server-modules'),
      uiSrc: path.join(dir, 'ui-src'),
    })
    mkdirSync(path.join(dir, 'server-modules'), { recursive: true })
    mkdirSync(path.join(dir, 'ui-src'), { recursive: true })
    // WS-R5 §1 — the `LINT_NO_DOMAIN_*` overrides are now honored ONLY under the
    // `LINT_NO_DOMAIN_SELFTEST=1` opt-in, because an ungated override was itself a
    // fail-open (`LINT_NO_DOMAIN_SCAN_OVERRIDE='[]'` printed ✓ over zero files). This
    // test drives the override deliberately, so it is one of the two callers entitled
    // to the opt-in; every OTHER caller — `npm run check`, the justfile, CI — must not
    // set it, and CI additionally passes `--require-full-scan`, which rejects it.
    const { code, stdout, stderr } = runNode(
      path.join(UI_SCRIPTS, 'lint-no-domain-in-builtin.mjs'),
      { LINT_NO_DOMAIN_ROOTS_OVERRIDE: roots, LINT_NO_DOMAIN_SELFTEST: '1' },
    )
    assert.equal(code, 1)
    assert.match(stderr, /scan set COLLAPSED/)
    assert.doesNotMatch(stdout, /ZERO domain datatype literals/)
    // …and WITHOUT the opt-in the same override is refused outright, which is the
    // stronger property: a collapsed-roots run can no longer even be REQUESTED by a
    // caller that is not the self-test.
    const gated = runNode(path.join(UI_SCRIPTS, 'lint-no-domain-in-builtin.mjs'), {
      LINT_NO_DOMAIN_ROOTS_OVERRIDE: roots,
      LINT_NO_DOMAIN_SELFTEST: '',
    })
    assert.equal(gated.code, 1)
    assert.match(gated.stderr, /INADMISSIBLE override/)
  })
})

test('[ITEM-37] collect-actions.mjs FAILS when SRC_ROOT collapses', () => {
  withTmp(dir => {
    mkdirSync(path.join(dir, 'core', 'actions'), { recursive: true })
    writeFileSync(path.join(dir, 'core', 'actions', 'defineAction.ts'), 'export {}\n')
    const { code, stderr, stdout } = runNode(path.join(UI_SCRIPTS, 'collect-actions.mjs'), {
      COLLECT_ACTIONS_SRC_ROOT: dir,
    })
    assert.notEqual(code, 0)
    assert.match(stderr, /SCAN SET COLLAPSED/)
    assert.doesNotMatch(stdout, /OK —/)
  })
})

test('[ITEM-37] action-refs-lint.mjs FAILS when SRC_ROOT collapses', () => {
  withTmp(dir => {
    const { code, stderr, stdout } = runNode(path.join(UI_SCRIPTS, 'action-refs-lint.mjs'), {
      ACTION_REFS_LINT_SRC_ROOT: dir,
    })
    assert.notEqual(code, 0)
    assert.match(stderr, /SCAN SET COLLAPSED/)
    assert.doesNotMatch(stdout, /OK —/)
  })
})

test('[ITEM-37] action-coverage.mjs FAILS when SRC_ROOT collapses — even with an EMPTY allowlist', () => {
  withTmp(dir => {
    // The regression that motivates ordering the floor BEFORE the opt-in early
    // return: with 0 allowlist entries the guard used to return "passes trivially"
    // without ever touching SRC_ROOT, so a collapsed root was invisible.
    const { code, stderr, stdout } = runNode(path.join(UI_SCRIPTS, 'action-coverage.mjs'), {
      ACTION_COVERAGE_SRC_ROOT: dir,
    })
    assert.notEqual(code, 0)
    assert.match(stderr, /SCAN SET COLLAPSED/)
    assert.doesNotMatch(stdout, /passes trivially/)
  })
})

// ── the floors are COMMITTED CONSTANTS, not derived at runtime ──────────────

test('[ITEM-37] every floored guard states its floor as a literal constant in-source', async () => {
  const { readFileSync } = await import('node:fs')
  const expectations = [
    // The two ITEM-12/13 guards commit a NAMED SCAN SET instead of a count. The regexes
    // are deliberately anchored to CODE shapes (`NAME=(` at column 0, a `[ -f … ] ||`
    // presence test) rather than to a bare identifier: the previous `/MIN_FILES=\d+/`
    // form would have gone on matching a PROSE mention of the old constant in the
    // header comment, i.e. the pin would have survived the mechanism it pinned being
    // deleted. That is the same rot this whole file exists to catch, one level up.
    [path.join(ROOT_SCRIPTS, 'check-kinds-zero-core.sh'), /^CORE_FILES=\(/m],
    [path.join(ROOT_SCRIPTS, 'check-kinds-zero-core.sh'), /\[ -f "\$f" \] \|\| MISSING\+=/],
    [path.join(ROOT_SCRIPTS, 'check-no-legacy-wire.sh'), /^assert_all_present\(\) \{/m],
    [path.join(ROOT_SCRIPTS, 'check-no-legacy-wire.sh'), /^SERVE_DECISION=\(/m],
    [path.join(ROOT_SCRIPTS, 'check-no-legacy-wire.sh'), /^BE_WIRE=\(/m],
    [path.join(ROOT_SCRIPTS, 'check-no-legacy-wire.sh'), /^FE_WITNESSES=\(/m],
    [path.join(ROOT_SCRIPTS, 'check-no-study-domain-literals.sh'), /MIN_FILES=\d+/],
    [path.join(ROOT_SCRIPTS, 'check-processor-seed-versions.sh'), /MIN_PACKAGES=\d+/],
    [path.join(ROOT_SCRIPTS, 'coercion-parity.mjs'), /const MIN_CORPUS_CASES = \d+/],
    [path.join(ROOT_SCRIPTS, 'check-package-suites.mjs'), /const MIN_GATED_PACKAGES = \d+/],
    [path.join(UI_SCRIPTS, 'lint-no-domain-in-builtin.mjs'), /const SCAN_FLOORS = \{/],
    [path.join(UI_SCRIPTS, 'lint-positional-declaration.mjs'), /MIN_DECLARED_FIELDS = \d+/],
    [path.join(UI_SCRIPTS, 'lint-positional-declaration.mjs'), /MIN_SCANNED_FILES = \d+/],
    [path.join(UI_SCRIPTS, 'collect-actions.mjs'), /const MIN_SOURCE_FILES = \d+/],
    [path.join(UI_SCRIPTS, 'action-refs-lint.mjs'), /const MIN_SOURCE_FILES = \d+/],
    [path.join(UI_SCRIPTS, 'action-coverage.mjs'), /const MIN_SOURCE_FILES = \d+/],
  ]
  for (const [file, re] of expectations) {
    assert.match(readFileSync(file, 'utf8'), re, `${path.basename(file)} must commit its floor`)
  }
})
