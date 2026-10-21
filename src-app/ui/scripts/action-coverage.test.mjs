// Tests for `action-coverage.mjs` (ai-actions ITEM-12 / TEST-5). Run directly:
//   node scripts/action-coverage.test.mjs
//
// Every test builds a fully self-contained temp fixture (its own src tree +
// its own allowlist file) so nothing here ever touches the real project
// source or the committed `action-coverage-allowlist.txt` — the check is
// pointed at the fixture via the `ACTION_COVERAGE_SRC_ROOT` /
// `ACTION_COVERAGE_ALLOWLIST_PATH` env-var overrides the script exposes for
// exactly this purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COVERAGE_SCRIPT = path.join(__dirname, 'action-coverage.mjs')
const REAL_ALLOWLIST_PATH = path.join(__dirname, 'action-coverage-allowlist.txt')

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'action-coverage-test-'))
  const srcRoot = path.join(root, 'src')
  mkdirSync(path.join(srcRoot, 'components'), { recursive: true })
  return { root, srcRoot }
}

function writeAllowlist(root, contents) {
  const allowlistPath = path.join(root, 'allowlist.txt')
  writeFileSync(allowlistPath, contents)
  return allowlistPath
}

function writeComponent(srcRoot, contents) {
  writeFileSync(path.join(srcRoot, 'components', 'Foo.tsx'), contents)
}

function runCoverage({ srcRoot, allowlistPath }) {
  const env = { ...process.env }
  if (srcRoot) {
    env.ACTION_COVERAGE_SRC_ROOT = srcRoot
    // A fixture root holds 2-4 files, far below the committed ITEM-37 scan floor.
    // Lower it EXPLICITLY (the documented test-only override) so these tests reach
    // the coverage RULES; `guard-floors.test.mjs` proves the floor still fires when
    // it is left unset.
    env.ACTION_COVERAGE_MIN_SOURCE_FILES = '1'
  }
  if (allowlistPath) env.ACTION_COVERAGE_ALLOWLIST_PATH = allowlistPath
  return spawnSync(process.execPath, [COVERAGE_SCRIPT], { env, encoding: 'utf8' })
}

test('passes trivially when the allowlist is empty (default-off)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, '# nothing allowlisted yet\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <Button onClick={() => Stores.Foo.doThing()}>Click</Button>
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}`)
    // ITEM-37 reworded this from a quiet "allowlist is empty" to a LOUD note: an empty
    // allowlist is still a legitimate exit-0 (the mechanism is opt-in), but a guard with
    // zero SUBJECTS is guarding nothing and must say so on every run.
    assert.match(result.stdout, /0 files opted in .*NO SUBJECTS/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FLAGS a non-compliant allowlisted file (inline onClick calling a store action)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, 'components/**\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <Button onClick={() => Stores.Foo.doThing()}>Click</Button>
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /FAILED/)
    assert.match(result.stderr, /components\/Foo\.tsx/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PASSES a compliant allowlisted file (ActionButton + non-mutating onClick)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, 'components/**\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return (
          <>
            <ActionButton action="foo.doThing" />
            <Button onClick={() => setOpen(true)}>Open</Button>
          </>
        )
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}`)
    assert.match(result.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a non-allowlisted file with a violation is NOT checked (opt-in only)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    // Allowlist a directory that does not match `components/**`.
    const allowlistPath = writeAllowlist(root, 'modules/command-palette/**\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <Button onClick={() => Stores.Foo.doThing()}>Click</Button>
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 0, `expected exit 0 (file not allowlisted). stderr:\n${result.stderr}`)
    assert.match(result.stdout, /0 allowlisted file\(s\) checked/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runs against the REAL project (no overrides, read-only) and passes', () => {
  const result = spawnSync(process.execPath, [COVERAGE_SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  // Documents the committed allowlist's current (seeded-empty) state; if a
  // future round populates it, this line still just needs a clean exit.
  void REAL_ALLOWLIST_PATH
})
