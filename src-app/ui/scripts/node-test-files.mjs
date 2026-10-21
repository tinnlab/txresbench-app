/**
 * The single source of truth for "which test files belong to the `node:test`
 * runner" — shared by `vitest.config.ts` (which must EXCLUDE them) and
 * `run-node-tests.mjs` (which must RUN them).
 *
 * ## Why this exists
 *
 * vitest does not understand `node:test`. It COLLECTS such a file, sees no
 * `describe`/`it`, and reports it as a PASSING file with zero tests — even when the
 * file's assertions throw. (Probe: a `src/**` file whose body is
 * `assert.equal(1, 2)` printed its own `✖` and vitest still reported
 * `Test Files 1 passed (1)`, `Tests no tests`, exit 0.) So when this round relocated
 * 24 `node:test` suites under `src/`, vitest's `src/**\/*.test.ts` include began
 * counting them as passes.
 *
 * They were still genuinely executed — by `test:unit:node` — but ONLY because a
 * hand-maintained list of paths in `package.json` happened to name them. Two lists
 * derived from different things is exactly the drift this module removes: both
 * consumers now derive from the SAME criterion, so a new `node:test` suite is
 * automatically excluded from vitest and automatically run by the node runner, and a
 * file can never be silently claimed by both or neither.
 *
 * ## The criterion
 *
 * A test file that imports the `node:test` module. That is not a heuristic — it is
 * the literal definition of "a file the node test runner executes and vitest cannot".
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The real `src-app/ui` directory (this script's parent). */
export const UI_ROOT = path.resolve(__dirname, '..')

/** `import … from 'node:test'` / `require('node:test')`, quote-agnostic. */
const NODE_TEST_IMPORT = /(?:from|require\s*\()\s*['"]node:test['"]/

/**
 * FAIL CLOSED on a collapsed scan (ITEM-37 house rule). A rename that moves the
 * suites out from under `src/` would otherwise leave the node runner with nothing to
 * run — and it would exit 0 having run nothing.
 *
 * RATCHET. This is a floor, and a floor left below the live count is a floor that
 * permits silent loss: it stood at 29 while `listNodeTestFiles()` enumerated 53, so
 * 24 suites could have vanished with the guard still green — the exact failure the
 * guard exists to prevent. (Its old comment also mis-stated the split as "24 under
 * `src/` + 9 under `scripts/`", which sums to 33, not to the 29 it guarded; both
 * halves were stale.)
 *
 * Live split at the time of this ratchet, computed from `listNodeTestFiles()` itself
 * rather than counted by hand: **32 under `src/` + 21 under `scripts/` = 53**.
 * Raise it whenever suites are added; lowering it takes an explicit, reviewable edit.
 */
export const MIN_NODE_TEST_FILES = 53

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (!/\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/**
 * Every test file under `<ui>/src` and `<ui>/scripts` that imports `node:test`,
 * as POSIX paths RELATIVE to `<ui>` (the form both vitest's `exclude` globs and
 * `node --test`'s arguments want), sorted for determinism.
 */
export function listNodeTestFiles(uiRoot = UI_ROOT) {
  const files = [...walk(path.join(uiRoot, 'src')), ...walk(path.join(uiRoot, 'scripts'))]
  return files
    .filter(f => NODE_TEST_IMPORT.test(readFileSync(f, 'utf8')))
    .map(f => path.relative(uiRoot, f).split(path.sep).join('/'))
    .sort()
}
