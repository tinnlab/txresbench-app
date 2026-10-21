// The test that would have caught the hollow-pass hole (FIX-4).
//
// ## The defect
//
// `vitest.config.ts` includes `src/**/*.test.ts(x)`. This round relocated 24
// `node:test`-based suites under `src/`, so vitest began COLLECTING them — and vitest
// does not understand `node:test`. It reports such a file as a PASSING file with zero
// tests even when its assertions throw. Verified probe: a temp file under `src/` whose
// body was `assert.equal(1, 2)` printed its own `✖ THIS ASSERTION MUST FAIL`, and
// vitest still reported `Test Files 1 passed (1)`, `Tests no tests`, exit 0.
//
// Nothing was actually unrun, because a SEPARATE hand-maintained list of ~16 path
// patterns in `package.json`'s `test:unit:node` happened to name those files. That
// hand-maintained list was the only thing standing between the repo and 24 silent
// green ticks — and nothing checked that the two lists agreed.
//
// ## The property under test
//
// The two runners PARTITION the test files: every test file is claimed by exactly one
// of them. Both sides now derive from ONE criterion (`node-test-files.mjs`), so this
// asserts the partition holds in practice, over the real config and the real tree.
//
// Run directly:  node --test scripts/node-test-partition.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { listNodeTestFiles, MIN_NODE_TEST_FILES, UI_ROOT } from './node-test-files.mjs'

/** The files vitest would actually COLLECT, straight from the real config. */
function vitestCollectedFiles() {
  const r = spawnSync('npx', ['vitest', 'list', '--filesOnly'], {
    cwd: UI_ROOT,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `vitest list failed:\n${r.stderr}`)
  return r.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => /\.test\.(ts|tsx)$/.test(l))
    .map(l => l.replace(/^\.\//, ''))
}

/** Every `*.test.ts(x)` under `<ui>/src`, UI-relative POSIX. */
function allSrcTestFiles(dir = path.join(UI_ROOT, 'src'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      allSrcTestFiles(full, out)
      continue
    }
    if (!/\.test\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.browser\.test\.ts$/.test(entry.name)) continue // its own runner
    out.push(path.relative(UI_ROOT, full).split(path.sep).join('/'))
  }
  return out
}

test('vitest COLLECTS no node:test file (they cannot be counted as passes)', () => {
  const nodeFiles = new Set(listNodeTestFiles())
  const collected = vitestCollectedFiles()
  const overlap = collected.filter(f => nodeFiles.has(f))
  assert.deepEqual(
    overlap,
    [],
    'vitest reports a node:test file as a PASSING file with zero tests — these must be ' +
      'excluded, not collected',
  )
})

test('a NEW node:test file under src/ is excluded automatically (no hand-maintained list)', () => {
  // The literal regression, as a live probe: drop a `node:test` file with a FAILING
  // assertion into `src/` and prove vitest does not collect it. Derived exclusion means
  // this holds for a file nobody remembered to register anywhere.
  //
  // The name is a UUID, like the three sibling suites' temp files. A FIXED name is
  // additive only for as long as nothing is tracked at that path: the day someone commits
  // `src/node-test-partition-probe.test.ts`, this `writeFileSync` overwrites tracked
  // source and the `rmSync` DELETES it — and a `finally` does not survive SIGKILL, which
  // is the durability class R20 §1 removed from `lint-no-domain-in-builtin.test.mjs`. A
  // name nothing can ever be committed under cannot acquire that property later.
  const probe = path.join(UI_ROOT, 'src', `node-test-partition-probe-${randomUUID()}.test.ts`)
  writeFileSync(
    probe,
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "test('THIS ASSERTION MUST FAIL', () => { assert.equal(1, 2) })",
      '',
    ].join('\n'),
  )
  try {
    const rel = path.relative(UI_ROOT, probe).split(path.sep).join('/')
    assert.ok(
      listNodeTestFiles().includes(rel),
      'the derived list must claim the new node:test file',
    )
    assert.ok(
      !vitestCollectedFiles().includes(rel),
      'vitest must not collect it — collecting it is what turns its FAILURE into a pass',
    )
  } finally {
    rmSync(probe, { force: true })
    assert.ok(!existsSync(probe), 'probe cleaned up')
  }
})

test('every src test file is claimed by EXACTLY ONE runner (no unrun file)', () => {
  const nodeFiles = new Set(listNodeTestFiles())
  const collected = new Set(vitestCollectedFiles())
  const unclaimed = allSrcTestFiles().filter(f => !nodeFiles.has(f) && !collected.has(f))
  assert.deepEqual(unclaimed, [], 'a test file claimed by neither runner is never executed')
})

test('the derived node:test list is above its committed floor and self-consistent', () => {
  const files = listNodeTestFiles()
  assert.ok(
    files.length >= MIN_NODE_TEST_FILES,
    `only ${files.length} node:test file(s) found, below the committed floor of ` +
      `${MIN_NODE_TEST_FILES} — the scan set collapsed`,
  )
  for (const f of files) {
    assert.match(
      readFileSync(path.join(UI_ROOT, f), 'utf8'),
      /(?:from|require\s*\()\s*['"]node:test['"]/,
      `${f} was claimed by the node runner but does not import node:test`,
    )
  }
})
