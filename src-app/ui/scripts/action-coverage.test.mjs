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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

test('an EMPTY allowlist does not switch the check off: a violation anywhere is flagged', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, '# nothing allowlisted\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <Button onClick={() => Stores.Foo.doThing()}>Click</Button>
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 1, `expected exit 1. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /components\/Foo\.tsx/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FLAGS a non-compliant file (inline onClick calling a store action)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, '')
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

test('PASSES a compliant file (ActionButton + non-mutating onClick)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, '')
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

test('an allowlisted file with a violation is skipped, and the entry counts as used', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, '# reason: fixture\ncomponents/Foo.tsx\n')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <Button onClick={() => Stores.Foo.doThing()}>Click</Button>
      }
      `,
    )
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 0, `expected exit 0 (file allowlisted). stderr:\n${result.stderr}`)
    assert.match(result.stdout, /1 allowlisted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FAILS on an allowlist entry that names no file (a dead entry exempts nothing today and a future file tomorrow)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, 'modules/user/components/user/UsersSettings.tsx\n')
    writeComponent(srcRoot, 'export function Foo() { return null }\n')
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 1, `expected exit 1. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /match no source file/)
    assert.match(result.stderr, /modules\/user\/components\/user\/UsersSettings\.tsx/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a glob entry that matches no file also fails (not only literal paths)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    const allowlistPath = writeAllowlist(root, 'modules/command-palette/**\n')
    writeComponent(srcRoot, 'export function Foo() { return null }\n')
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 1, `expected exit 1. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /modules\/command-palette\/\*\*/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the scope is every source file: a violation in a nested directory with no entry is found', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    mkdirSync(path.join(srcRoot, 'modules', 'txrnew', 'components'), { recursive: true })
    writeFileSync(
      path.join(srcRoot, 'modules', 'txrnew', 'components', 'Page.tsx'),
      'export const P = () => <Button onClick={() => Stores.Run.start()}>Go</Button>\n',
    )
    writeComponent(srcRoot, 'export function Foo() { return null }\n')
    const allowlistPath = writeAllowlist(root, '')
    const result = runCoverage({ srcRoot, allowlistPath })
    assert.equal(result.status, 1, `expected exit 1. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /modules\/txrnew\/components\/Page\.tsx/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the committed allowlist has no entry that names no file', () => {
  // The script fails on a dead entry, so the REAL run below proves it; this reads the file
  // to name the intent: every non-comment line must be a path that exists under src.
  const lines = readFileSync(REAL_ALLOWLIST_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
  for (const entry of lines) {
    assert.ok(!/[*?]/.test(entry) ? existsSync(path.join(__dirname, '..', 'src', entry)) : true, `${entry} names no file`)
  }
})

test('runs against the REAL project (no overrides, read-only) and passes', () => {
  const result = spawnSync(process.execPath, [COVERAGE_SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /\d+ source file\(s\) checked/)
})
