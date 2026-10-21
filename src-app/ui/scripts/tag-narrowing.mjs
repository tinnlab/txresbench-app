/**
 * TAG NARROWING — what a run EXCLUDED, derived rather than remembered.
 *
 * ## Why this exists
 *
 * `playwright.config.ts` narrows a default run with
 * `grepInvert: REAL_COMPUTE ? undefined : /@acceptance/`, so every `@acceptance`-tagged
 * test is excluded unless `just verify-acceptance` positively selects it. The exclusion
 * is correct — those tests commit a real sandbox run and a normal host cannot execute
 * them. What was NOT correct is that the run reported success while covering less.
 *
 * There WAS a disclosure banner. It named a hand-written constant:
 *
 *     const REAL_COMPUTE_SPECS = ['tests/e2e/provenance/filter-save-records-recipe.spec.ts']
 *
 * By the time it was read, FIVE spec files carried `@acceptance`. The banner named one of
 * them and no count, so a reader was told a single provenance spec sat out while four
 * other tests — in `14-declarative-qc/` and `datasets/` — sat out unmentioned. That is the
 * exact degradation `scripts/check-test-scope-lists.mjs` was written to stop: a hand-list
 * is a snapshot of the day someone typed it, and nothing tells you when it stops being
 * true. A disclosure that has drifted is worse than none, because it reads as complete.
 *
 * So the narrowing describes ITSELF here, from the specs on disk. Adding an
 * `@acceptance` test anywhere changes the banner with no edit to this file, to the config,
 * or to the guard.
 *
 * ## What it does not do
 *
 * This scan is STATIC — it reads titles, it does not collect through Playwright. It is
 * therefore cheap enough to run at config load (a banner that costs a subprocess would be
 * turned off), and it is deliberately not the authority on what ran: the authority is the
 * JUnit report `just verify-acceptance` parses fail-closed. This answers only "what did
 * this run leave out, and how much of it".
 *
 * `scripts/e2e-inventory.mjs` is the collection-based companion (it boots `--list` and
 * compares per config); this is the load-time one.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '..')

/** The tag `playwright.config.ts` narrows a default run by. One place, one spelling. */
export const NARROWING_TAG = '@acceptance'

/** A test title carrying the tag — `test('… @acceptance', …)` / `test.only`, any quote. */
function taggedTitles(src, tag) {
  const out = []
  const re = /\btest(?:\.only|\.fixme|\.skip)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  for (const m of src.matchAll(re)) {
    if (m[2].includes(tag)) out.push(m[2])
  }
  return out
}

function specsUnder(dir, acc = []) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) specsUnder(p, acc)
    else if (e.name.endsWith('.spec.ts')) acc.push(p)
  }
  return acc
}

/**
 * Every test narrowed OUT of a default run by `NARROWING_TAG`, derived from disk.
 *
 * @param {{ testDir?: string, tag?: string }} [opts]
 * @returns {{ tag: string, tests: Array<{ file: string, title: string }>, files: string[] }}
 */
export function narrowedOut({ testDir = 'tests/e2e', tag = NARROWING_TAG } = {}) {
  const abs = path.resolve(UI, testDir)
  const tests = []
  for (const f of specsUnder(abs).sort()) {
    const rel = path.relative(UI, f)
    for (const title of taggedTitles(readFileSync(f, 'utf8'), tag)) {
      tests.push({ file: rel, title })
    }
  }
  return { tag, tests, files: [...new Set(tests.map(t => t.file))] }
}

/**
 * The banner a narrowed run prints about itself. Leads with the COUNT — the number is
 * what makes "224 collected" legible as less than the whole, and it is the part a hand
 * list could never keep true.
 *
 * @param {{ tag: string, tests: Array<{ file: string, title: string }>, files: string[] }} n
 * @param {string} recipe  the invocation that positively selects them
 */
export function narrowingBanner(n, recipe = 'just verify-acceptance') {
  if (n.tests.length === 0) {
    // A tag that matches nothing is not "nothing excluded" — it is a scan that has
    // stopped working, or a tag that was renamed on one side only. Say so rather than
    // print a reassuring silence. `check-test-scope-lists.mjs` fails the build on it.
    return (
      `\n[playwright] WARNING: the ${n.tag} exclusion is active but the scan matched ZERO ` +
      `tagged tests.\n[playwright] Either the tag was renamed or this scan is broken — an ` +
      `exclusion that\n[playwright] excludes nothing is not a clean run, it is an unverified one.\n`
    )
  }
  const list = n.files.map(f => `[playwright]     ${f}`).join('\n')
  return (
    `\n[playwright] EXCLUDED from this run: ${n.tests.length} ${n.tag} test(s) in ` +
    `${n.files.length} spec file(s):\n${list}\n` +
    `[playwright] They commit real sandbox runs. Run them on a sandbox-executable host with\n` +
    `[playwright] \`${recipe}\`. An EXCLUDED test is not a passed test — this run's totals\n` +
    `[playwright] are ${n.tests.length} short of the suite; do not report them as full coverage.\n`
  )
}
