/**
 * THE HAND-LIST GUARD — "which tests does a runner actually run?"
 *
 * ## Why this exists
 *
 * Three `provenance::` integration tests were RED on main for weeks and nobody saw
 * it, because the filter set being propagated to every test run omitted
 * `provenance::`. The tier reported green while three tests were red.
 *
 * The prose those tests asserted on had drifted; that was the visible bug. The
 * mechanism that HID it is this one: a run scoped by a hand-written list of module
 * names. A hand-list is a snapshot of what existed the day someone typed it, and it
 * degrades silently — a test added tomorrow is simply never run, and no gate says so.
 * A module/directory ENUMERATION does not have that failure mode.
 *
 * So the rule this guard enforces is not "run everything". It is:
 *
 *   A runner may scope itself to a UNIT THAT GROWS BY ITSELF — a module, or a
 *   submodule FILE. It may never scope itself to a list of individual test
 *   FUNCTIONS, because that list stops being true the moment a test is added
 *   next to one of them.
 *
 * ## The three checks
 *
 *   1. DECLARED — every `src-app/server/tests/<dir>/` that contains a test is
 *      declared as a `mod` in `integration_tests.rs`. An undeclared directory is
 *      not compiled and not run; nothing else would notice.
 *   2. NO PER-TEST FILTERS — no `cargo test --test integration_tests` invocation in
 *      the justfile names an individual test function. (This is the literal
 *      `check-domain` defect: it named 3 functions, and `domain_surface` has 28.)
 *   3. TAG NARROWING DISCLOSED — REMOVED in ITEM-4 with its subject. The
 *      `@acceptance` tag's only spec files were the removed processor platform's
 *      (provenance / datasets / 14-declarative-qc …); the tag matches nothing now, so
 *      the check's own fail-closed floor (`MIN_NARROWED_TESTS`) would fire on a scan
 *      that was correctly empty. The check's no-vacuous-pass rule ("if a narrowing was
 *      genuinely removed, delete this check") applies. The playwright config, the
 *      `tag-narrowing.mjs` derivation + banner and the `verify-acceptance` recipe left
 *      with it; a future host-gated tier reintroduces all three together.
 *
 * ## The checks REMOVED with the strip node (ITEM-2)
 *
 * Checks 3 (SKIP-GATED COVERAGE, over `just test-sandbox`'s default filter) and
 * 4 (REAL-COMPUTE COVERAGE, over `just e2e-processors`' default dir list) policed
 * the single-cell analysis-rootfs tiers: every skip-gated module (analysis,
 * dataset, provenance, workstore, sandbox's OCI tests) and every REAL_COMPUTE e2e
 * directory belonged to the removed processor platform, and the two recipes are
 * deleted with it (ITEM-2). A hand-list guard over a deleted tier would redden on
 * nothing and mean nothing; the tiers' subjects leave the tree in ITEM-3/4.
 *
 * ## Fail-closed
 *
 * Every check has a floor (`MIN_*`). A refactor that moves the tests and leaves the
 * scan matching nothing must FAIL, not pass having verified nothing — the same house
 * rule as `ui/scripts/node-test-files.mjs` (ITEM-37), and the same rule this guard
 * exists to defend in the first place.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The ONE derivation of "which tests does tag X narrow out", shared with the banner
// `playwright.config.ts` prints. Importing it rather than re-scanning here is the point:
// a guard with its own private copy of the fact can pass while the disclosure is wrong.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SERVER_TESTS = path.join(ROOT, 'src-app/server/tests')
const E2E_DIR = path.join(ROOT, 'src-app/ui/tests/e2e')
const JUSTFILE = path.join(ROOT, 'justfile')

/** Floors. Coverage may grow; it may not silently collapse. */
const MIN_TEST_MODULES = 15
const MIN_CARGO_INVOCATIONS = 2

const failures = []
const fail = (check, msg) => failures.push(`[${check}] ${msg}`)

/** Every `#[test]` / `#[tokio::test]` attribute, and every `fn` that follows one. */
const TEST_ATTR = /#\[(?:tokio::)?test\]/
const TEST_FN = /#\[(?:tokio::)?test\][^\n]*\n\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g

function rustFilesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.rs')) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ─────────────────────────── ground truth, derived ───────────────────────────

/** `<module> → Set<test fn name>`, for every server integration test directory. */
const modules = new Map()
for (const e of readdirSync(SERVER_TESTS, { withFileTypes: true })) {
  if (!e.isDirectory()) continue
  const fns = new Set()
  for (const f of rustFilesUnder(path.join(SERVER_TESTS, e.name))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(TEST_FN)) fns.add(m[1])
  }
  modules.set(e.name, fns)
}

/** Modules that actually hold tests. A pure support/data dir (`common`,
 *  `fixtures`) holds none — which is DERIVED here, never asserted by name. */
const testModules = [...modules].filter(([, fns]) => fns.size > 0).map(([n]) => n)

if (testModules.length < MIN_TEST_MODULES) {
  fail(
    'floor',
    `found only ${testModules.length} server test modules (floor ${MIN_TEST_MODULES}) — ` +
      `the scan collapsed; fix this script rather than lowering the floor`,
  )
}

// ───────────────────────── 1. every module is DECLARED ───────────────────────

const entry = readFileSync(path.join(SERVER_TESTS, 'integration_tests.rs'), 'utf8')
const declared = new Set([...entry.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;/gm)].map((m) => m[1]))

for (const m of testModules) {
  if (!declared.has(m)) {
    fail(
      'declared',
      `src-app/server/tests/${m}/ holds ${modules.get(m).size} test(s) but is not declared ` +
        `as \`mod ${m};\` in integration_tests.rs — it is never compiled and never run`,
    )
  }
}

// ──────────────────── 2. no runner filters to test FUNCTIONS ─────────────────

const just = readFileSync(JUSTFILE, 'utf8')

/** Every test fn name in the whole server integration suite → its module. */
const fnOwner = new Map()
for (const [m, fns] of modules) for (const fn of fns) fnOwner.set(fn, m)

/** Every submodule FILE name per module (a legitimate, self-growing scope). */
const fileUnits = new Set()
for (const m of modules.keys()) {
  for (const f of rustFilesUnder(path.join(SERVER_TESTS, m))) {
    fileUnits.add(`${m}::${path.basename(f, '.rs')}`)
  }
}

// A `cargo test --test integration_tests ... -- ... <filters>` invocation, with
// justfile line continuations folded away so a wrapped filter list is still seen.
const invocations = [
  ...just.replace(/\\\s*\n\s*/g, ' ').matchAll(/cargo test[^\n]*--test integration_tests([^\n]*)/g),
]

if (invocations.length < MIN_CARGO_INVOCATIONS) {
  fail(
    'floor',
    `found only ${invocations.length} \`--test integration_tests\` invocations in the justfile ` +
      `(floor ${MIN_CARGO_INVOCATIONS}) — the justfile scan collapsed`,
  )
}

for (const inv of invocations) {
  const tail = inv[1]
  for (const tok of tail.split(/\s+/)) {
    // Filters are bare positional tokens; skip flags, `--`, and just-substitutions.
    if (!tok || tok.startsWith('-') || tok.includes('{{') || tok.includes('=')) continue
    if (!tok.includes('::')) continue
    const segs = tok.split('::').filter(Boolean)
    const leaf = segs[segs.length - 1]
    // A module (`provenance::`) or a submodule file (`sandbox::env_image_oci_test::`)
    // is a unit that grows by itself — allowed. A test fn name is a hand-list.
    if (segs.length === 1 || fileUnits.has(segs.slice(0, 2).join('::'))) continue
    if (fnOwner.has(leaf)) {
      const owner = fnOwner.get(leaf)
      fail(
        'no-per-test-filters',
        `the justfile filters \`${tok}\` — an individual test function. \`${owner}\` has ` +
          `${modules.get(owner).size} tests; a test added beside this one is silently never run. ` +
          `Filter the MODULE (\`${owner}\`) instead.`,
      )
    }
  }
}

// ────────────────────────────────── verdict ─────────────────────────────────

const scanned =
  `${testModules.length} server test modules, ${fnOwner.size} test fns, ` +
  `${invocations.length} cargo invocations`

if (failures.length) {
  console.error(`\ncheck-test-scope-lists: FAIL (${failures.length}) — scanned ${scanned}\n`)
  for (const f of failures) console.error(`  ✖ ${f}`)
  console.error(
    '\nA runner may scope itself to a module or a submodule file — never to a list of\n' +
      'individual test functions. A hand-list is a snapshot; it goes stale in silence.\n',
  )
  process.exit(1)
}

console.log(`check-test-scope-lists: PASS — scanned ${scanned}`)
