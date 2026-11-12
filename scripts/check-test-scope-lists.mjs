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
 *   3. TAG NARROWING DISCLOSED — a playwright config that narrows a run by TAG
 *      (`grepInvert: /@acceptance/`) must announce the narrowing, derive the excluded
 *      set rather than hardcode spec paths, and have a recipe that positively selects
 *      the tag. Checks 1-2 ask "is this unit run at all"; this asks the question a
 *      narrowed run makes it possible to get wrong — "does this run's OUTPUT admit it
 *      covered less than the suite". The shipped defect: `@acceptance` was excluded by
 *      default and the banner named 1 of the 5 spec files carrying it, with no count.
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
import { narrowedOut } from '../src-app/ui/scripts/tag-narrowing.mjs'

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

// ───────── 5. every TAG NARROWING is disclosed, and disclosed by DERIVATION ──────
//
// The same rule as check 2, one level up. Check 2 stops a runner scoping to a hand-list
// of test FUNCTIONS. This stops a runner narrowing by TAG and then describing what it
// narrowed with a hand-list of spec PATHS — which is what happened:
// `playwright.config.ts` excluded `@acceptance` and printed a banner naming
// `REAL_COMPUTE_SPECS`, one hardcoded path. Five spec files carried the tag. So a
// default run disclosed a fifth of its own exclusion, with no count, and read as green
// — the third time in a week a narrowed run in this repo was mistaken for a full one
// (an e2e dir that collected zero tests; a module filter that ran 3 of 28; this).
//
// The rule: a config MAY narrow by tag. It may NOT hold a literal list of the spec
// files that tag lives in — that list is a snapshot and it degrades in silence. It must
// derive the set (`ui/scripts/tag-narrowing.mjs`), and the tag must be positively
// selected by some justfile recipe, or the narrowed-out tests are run by nothing at all.

const UI_DIR = path.join(ROOT, 'src-app/ui')
const MIN_NARROWED_TESTS = 1

/** The justfile's executable lines — comments stripped, so prose about a recipe can
 *  never stand in for the recipe. */
const justCommands = just.split('\n').filter((l) => !/^\s*#/.test(l))

/** JS/TS source with `//` and block comments removed. Every check below asks whether the
 *  config DOES something; a comment saying it does must not answer for it. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

if (existsSync(UI_DIR)) {
  const configs = readdirSync(UI_DIR).filter((f) => /^playwright(\..+)?\.config\.ts$/.test(f))
  let sawNarrowing = false

  for (const cfgName of configs) {
    const cfg = readFileSync(path.join(UI_DIR, cfgName), 'utf8')
    // `grepInvert: … /@tag/ …` / `grep: … /@tag/ …` — the narrowing as DECLARED, read
    // from code with comments stripped. These configs discuss their own narrowing at
    // length; reading the prose would keep this check firing against a config that had
    // genuinely stopped narrowing and only kept the explanation.
    const tags = new Set()
    for (const m of stripComments(cfg).matchAll(/\bgrep(?:Invert)?\s*:[^\n]*?\/(@[A-Za-z0-9_-]+)\//g)) {
      tags.add(m[1])
    }
    if (!tags.size) continue
    sawNarrowing = true

    for (const tag of [...tags].sort()) {
      // (a) the tagged tests actually exist. A tag matching nothing means the exclusion
      //     silently excludes nothing (or the tag was renamed on one side) — either way
      //     the disclosure below is describing a set nobody can see.
      //
      //     Counted through the SAME derivation the banner prints, deliberately: the
      //     first draft of this check re-scanned for files merely MENTIONING the tag and
      //     answered 8 where the banner answered 5 (comments name it too). Two
      //     derivations of one fact is how the guard and the thing it guards come to
      //     disagree — the same reason `cell-filter.yaml` reads its taken-set once.
      const tagged = narrowedOut({ testDir: 'tests/e2e', tag }).files

      if (tagged.length < MIN_NARROWED_TESTS) {
        fail(
          'tag-narrowing',
          `${cfgName} narrows by \`${tag}\` but NO spec file carries it — the exclusion ` +
            `describes an empty set. Either the tag was renamed on one side, or this scan ` +
            `collapsed; do not lower the floor.`,
        )
        continue
      }

      // (b) the disclosure is DERIVED, not remembered. A config that narrows must not
      //     also carry a literal spec path: that is the hand-list, and the one that was
      //     there named 1 of 5.
      // Comments stripped here too, but for the opposite reason to (c)/(d): a comment
      // QUOTING a spec path is documentation, not a hand-list, and failing the build on
      // it would push authors to stop explaining the narrowing at all.
      const literalPaths = [
        ...stripComments(cfg).matchAll(/['"`](tests\/e2e\/[^'"`]*\.spec\.ts)['"`]/g),
      ].map((m) => m[1])
      if (literalPaths.length) {
        fail(
          'tag-narrowing',
          `${cfgName} narrows by \`${tag}\` AND hardcodes spec path(s) ` +
            `[${literalPaths.join(', ')}]. ${tagged.length} spec file(s) carry the tag, so that ` +
            `list is already ${tagged.length - literalPaths.length} short. Derive the excluded ` +
            `set with \`scripts/tag-narrowing.mjs\` instead of naming files here.`,
        )
      }

      // (c) it is disclosed at all — the config announces its own narrowing.
      //
      //     Matched on a CALL (`narrowingBanner(`) in non-comment source, not on the
      //     identifier appearing anywhere. Same negative-control lesson as (d): the
      //     block above this one describes `narrowedOut()` in prose, so a bare
      //     `/narrowedOut/` test stayed green with the call deleted and only the
      //     COMMENT left behind.
      if (!/\bnarrowingBanner\s*\(/.test(stripComments(cfg))) {
        fail(
          'tag-narrowing',
          `${cfgName} narrows by \`${tag}\` but never announces it. A run that covers less ` +
            `must say so in its own output, or its totals read as full coverage.`,
        )
      }

      // (d) something POSITIVELY selects the tag, or the excluded tests run nowhere.
      //
      //     Searched over the justfile's COMMAND lines only. The first draft searched the
      //     whole file and passed on a `# \`--grep @acceptance\` — POSITIVE selection`
      //     COMMENT: prose describing a recipe satisfied the check that the recipe exists.
      //     Caught by running the negative control (delete the real selector) and watching
      //     the guard stay green — which is the only reason it is not still in here.
      //     Tightened again after the SECOND control: the recipe's own fail-closed
      //     diagnostic string ("did --grep @acceptance match nothing?") lives on a
      //     command line, so stripping comments was not enough. The check now demands an
      //     actual INVOCATION — `playwright test … --grep <tag>` on one line.
      if (
        !justCommands.some(
          (l) => /playwright\s+test/.test(l) && new RegExp(`--grep\\s+'?${tag}'?`).test(l),
        )
      ) {
        fail(
          'tag-narrowing',
          `${cfgName} excludes \`${tag}\` and no justfile recipe positively selects it ` +
            `(\`--grep '${tag}'\`) — ${tagged.length} spec file(s) would be run by nothing.`,
        )
      }
    }
  }

  if (!sawNarrowing) {
    fail(
      'floor',
      `no playwright config declares a \`grep\`/\`grepInvert\` tag narrowing — this check ` +
        `scanned ${configs.length} config(s) and verified nothing. If a narrowing was genuinely ` +
        `removed, delete this check; do not let it pass vacuously.`,
    )
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
