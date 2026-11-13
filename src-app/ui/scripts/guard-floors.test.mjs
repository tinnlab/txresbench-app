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
// | check-no-study-domain-literals.sh    | `MIN_FILES=1500`                        | `src-app/**` renamed |
// | lint-no-domain-in-builtin.mjs        | `SCAN_FLOORS{rust,workbenchFe,extraFe}` | scan roots renamed |
// | collect-actions.mjs                  | `MIN_SOURCE_FILES` + `MIN_VIEWSPEC_FILES` | SRC_ROOT / VIEWSPEC_ROOT renamed |
// | action-refs-lint.mjs                 | `MIN_SOURCE_FILES=400`                  | SRC_ROOT renamed |
// | action-coverage.mjs                  | `MIN_SOURCE_FILES=400`                  | SRC_ROOT renamed |
//
// STRIP (single-cell): the guards whose ONLY subject left the tree left with it
// (ITEM-2/ITEM-4) and are therefore absent from this inventory BY DESIGN, not by
// oversight: `check-kinds-zero-core.sh`, `check-package-suites.mjs`,
// `check-processor-seed-versions.sh`, `coercion-parity.mjs` + `-ws-check.mjs`
// (processor packages), `check-no-legacy-wire.sh` (workstore), and the UI
// `lint-layer-boundary.mjs` / `lint-positional-declaration.mjs` (workbench
// layers, declared collections). This file asserts SURVIVORS fail closed; the
// retirement itself is asserted by `gate-wiring.test.mjs`.
//
// NOT guards (deliberately absent): `ts-resolve*.mjs` (module loaders),
// `preland-frontend-health.mjs`
// and `verify-backend-merge.sh` (diff-driven merge gates with no fixed scan set),
// and `*.test.mjs` (tests).

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

test('[ITEM-37] check-no-study-domain-literals.sh FAILS when `src-app/**` resolves to nothing', () => {
  const { code, stdout } = runShellGuardInEmptyRepo('check-no-study-domain-literals.sh')
  assert.notEqual(code, 0, 'a collapsed product-source scan set must not PASS')
  assert.match(stdout, /scan set resolved to 0 file\(s\), below the/)
  assert.doesNotMatch(stdout, /^PASS: 0 surviving study\/Study/m)
})

// ── repo-root node guards ───────────────────────────────────────────────────

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
    // The survivor list — every floored guard still in the tree. The deleted guards'
    // rows left with the guards (see the STRIP note above; `gate-wiring.test.mjs`
    // asserts the retirements).
    [path.join(ROOT_SCRIPTS, 'check-no-study-domain-literals.sh'), /MIN_FILES=\d+/],
    [path.join(UI_SCRIPTS, 'lint-no-domain-in-builtin.mjs'), /const SCAN_FLOORS = \{/],
    [path.join(UI_SCRIPTS, 'collect-actions.mjs'), /const MIN_SOURCE_FILES = \d+/],
    [path.join(UI_SCRIPTS, 'action-refs-lint.mjs'), /const MIN_SOURCE_FILES = \d+/],
    [path.join(UI_SCRIPTS, 'action-coverage.mjs'), /const MIN_SOURCE_FILES = \d+/],
  ]
  for (const [file, re] of expectations) {
    assert.match(readFileSync(file, 'utf8'), re, `${path.basename(file)} must commit its floor`)
  }
})
