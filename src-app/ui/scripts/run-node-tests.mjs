#!/usr/bin/env node
/**
 * The `node:test` half of `npm run test:unit` (`test:unit:node`).
 *
 * The file list is DERIVED from `node-test-files.mjs` — the same helper
 * `vitest.config.ts` uses to EXCLUDE those files — rather than hand-maintained in
 * `package.json`. Before this, the two lists were independent: vitest's include was a
 * `src/**` glob and the node runner's was ~16 literal path patterns, so a `node:test`
 * suite that nobody remembered to add to the literal list would be silently claimed by
 * vitest, reported as a passing file with zero tests, and never actually run.
 *
 * Usage:  node scripts/run-node-tests.mjs [extra node --test args…]
 */

import { spawnSync } from 'node:child_process'
import { listNodeTestFiles, MIN_NODE_TEST_FILES, UI_ROOT } from './node-test-files.mjs'

const files = listNodeTestFiles()

// FAIL CLOSED (ITEM-37). `node --test` with an empty file list exits 0 having run
// nothing; a rename that moved the suites would look exactly like a green run.
if (files.length < MIN_NODE_TEST_FILES) {
  console.error(
    `[run-node-tests] SCAN SET COLLAPSED — found ${files.length} node:test file(s) under ` +
      `${UI_ROOT}, below the committed floor of ${MIN_NODE_TEST_FILES}. A suite was moved or ` +
      'renamed out of the scan, so this runner was about to exit 0 having run almost nothing.',
  )
  process.exit(1)
}

console.log(`[run-node-tests] running ${files.length} node:test file(s)`)

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-strip-types',
    '--import',
    './scripts/ts-resolve.mjs',
    ...process.argv.slice(2),
    ...files,
  ],
  { cwd: UI_ROOT, stdio: 'inherit' },
)

process.exit(result.status ?? 1)
