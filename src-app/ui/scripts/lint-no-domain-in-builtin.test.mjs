// Tests for `lint-no-domain-in-builtin.mjs` — processor-separability
// TEST-15 [acceptance] [invariant: INV-1, INV-2] + TEST-21 [acceptance]
// [invariant: INV-3]. Run directly:
//   node --test scripts/lint-no-domain-in-builtin.test.mjs
//
// The guard is un-gameable ONLY if it (a) FAILS on a domain literal injected
// into real production code and (b) does NOT false-positive on the legitimate
// comment / #[cfg(test)] / declarative-engine-example / host-channel-key uses.
// Every case builds a self-contained temp fixture and points the guard at it
// via the `LINT_NO_DOMAIN_SCAN_OVERRIDE` env the script exposes for this. The
// FINAL test runs the REAL guard over the REAL app-builtin surface (no
// override) and asserts today's tree carries ZERO domain literals — the
// headline proof that the strip is complete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(__dirname, 'lint-no-domain-in-builtin.mjs')

/**
 * WS-R5 §1 — the guard IGNORES + REJECTS every `LINT_NO_DOMAIN_*` override unless
 * `LINT_NO_DOMAIN_SELFTEST=1` is set. This suite IS the self-test, so it is the one
 * caller that sets the opt-in; `npm run check`, the justfile and CI do not, and CI
 * additionally passes `--require-full-scan`, which rejects the opt-in outright. Every
 * spawn in this file goes through here so a new test cannot forget it (and so the
 * admission gate has exactly ONE place to be granted).
 */
function guardEnv(extra = {}) {
  return { ...process.env, LINT_NO_DOMAIN_SELFTEST: '1', ...extra }
}

function runGuard(scanSet) {
  const env = guardEnv()
  if (scanSet) env.LINT_NO_DOMAIN_SCAN_OVERRIDE = JSON.stringify(scanSet)
  const r = spawnSync(process.execPath, [GUARD], { env, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SRC_APP = path.resolve(__dirname, '..', '..')

/**
 * ── R20 §1: THIS SUITE NEVER WRITES TO A FILE THE REPOSITORY TRACKS ─────────
 *
 * Until r20 the "un-gameable" tests below planted their leak by `writeFileSync`-ing
 * a REAL production file and restoring it in a `finally`. Eleven files were mutated
 * that way, among them `server/src/database.rs`, `ui/openapi/openapi.json` and an
 * APPLIED sqlx migration. Three things were measured, not argued:
 *
 *   1. `run-node-tests.mjs` spawns ONE `node --test` over every discovered file and
 *      node runs FILES in parallel, so the plants are live while sibling suites read
 *      the tree. With the `openapi.json` plant live, `src/api-client/regen.test.ts`
 *      (same batch, `JSON.parse`s that exact path) went 1 pass / 5 fail. The
 *      committed gate contained an on-demand red.
 *   2. A `finally` does not survive the process not surviving. SIGKILL mid-plant left
 *      ` M src-app/server/src/database.rs` with the planted line still in it — and one
 *      of the eleven targets is an applied migration, whose bytes `sqlx::migrate!`
 *      checksums at every subsequent boot (see `server/src/database.rs`).
 *   3. Byte-identical-content-with-a-moved-mtime plus a transient domain hit is
 *      exactly the anomaly r19 spent a round chasing.
 *
 * The fix is not a stronger restore, a lock or a signal handler — each of those
 * leaves "mutate tracked source" expressible. The capability is REMOVED: a plant now
 * goes into a COPY under `os.tmpdir()`, and the guard is pointed at the copy through
 * the same `LINT_NO_DOMAIN_SCAN_OVERRIDE` seam the fixture tests above already use.
 * `plantInCopyOfReal` is the ONLY way this file plants anything.
 *
 * ── THE RESIDUE, CORRECTED ──────────────────────────────────────────────────
 *
 * The commit that did the above recorded its residue as "three additive fixtures still
 * land in the repo root … None mutates an existing file." **That last sentence was
 * wrong when it was written.** One of the three — `[WS-R6][repo] a repo-root tree that
 * is IGNORED but holds a TRACKED file` — ran `git add -f` against THIS repository's
 * index and undid it in a `finally`: the identical durability class, one layer down,
 * measured at `.git/…/index` sha256 e8e6a… -> 29c63… over a single
 * `--test-name-pattern=WS-R6` run. It is closed the same way the source case was, by
 * removing the capability rather than tightening the restore — see that test's own
 * comment for `GIT_INDEX_FILE` + `update-index --cacheinfo`, and the
 * `indexSha() === beforeSha` assertion that now fails if anyone reintroduces it.
 *
 * What is genuinely left, re-measured: the three `[repo]` fixtures create and remove a
 * repo-root DIRECTORY, which is additive and untracked — a killed run leaves an
 * untracked directory, never a modified or deleted tracked file. That is the residue,
 * and it is inherent to fixtures whose subject IS the repo-root census.
 *
 * WHAT THE COPY KEEPS. The old formulation proved reach IMPLICITLY (the real run went
 * red, therefore the walk must have read the file). The copy proves it EXPLICITLY and
 * earlier: the helper looks the target up in the REAL `defaultScanSet()` and fails if
 * it is absent, then reuses that entry verbatim (`lang`, and any `nouns` flag) with
 * only `path` re-pointed. So the walk, the language dispatch and the real file's real
 * content are all still under test.
 *
 * WHAT IT ADDS. The old assertion was `exit === 1`, which several targets satisfy
 * WITHOUT the plant (`seed_multimodal.py` alone carries 88 baselined findings, and the
 * baseline is inert under an override). Every plant is now checked as a DELTA against
 * a control run of the same unmodified copy, so the test can only pass if the PLANT
 * produced the finding.
 *
 * WHAT IT WOULD HAVE LOST, AND HOW THAT IS PAID BACK. `runGuard` sets `baselined =
 * false` whenever a scan override is present, so the copy formulation skips the
 * baseline/floor/census pipeline entirely. The OLD form ran the real, baselined guard,
 * which ALSO proved something the delta does not: that the committed ledger has no
 * BUDGET left in that exact (file, token) to absorb the new hit. Without that, a plant
 * of a token the target file already baselines with headroom would pass here while the
 * real guard swallowed it. `assertLedgerCannotAbsorbPlant` restores it directly and
 * automatically — see its own doc — so no plant has to remember to ask.
 */
const GUARD_MODULE = await import('./lint-no-domain-in-builtin.mjs')
const { set: REAL_SCAN_SET } = GUARD_MODULE.defaultScanSet()
/** The COMMITTED `domain-baseline.json` (no override is set in this process). */
const COMMITTED_BASELINE = GUARD_MODULE.loadBaseline()

/** The `<path>:<line>:<col>  [<kind>]  <token>` lines the guard prints per finding. */
function findingLines(stderr) {
  return (stderr ?? '')
    .split('\n')
    .filter(l => /^\s+\S+:\d+:\d+\s{2}\[/.test(l))
    .map(l => l.trim())
}

/** `  a/b.rs:12:3  [domain-noun]  Cells` → `{kind:'domain-noun', token:'cells'}`. */
function parseFinding(line) {
  const m = /^.+:\d+:\d+\s{2}\[([^\]]+)]\s{2}(.+)$/.exec(line)
  return m ? { kind: m[1], token: m[2].toLowerCase() } : null
}

/**
 * How many hits of `(kind, token)` the COMMITTED ledger grants `key`, across both the
 * production and the test-tier sections (a file belongs to exactly one tier, so at most
 * one of the pair is non-zero; taking the max cannot understate the budget).
 */
function committedBudget(key, kind, token) {
  const b = COMMITTED_BASELINE
  const count = spec => (typeof spec === 'number' ? spec : (spec?.count ?? 0))
  if (kind === 'domain-noun') {
    return Math.max(count(b.code?.[key]?.[token]), count(b.testCode?.[key]?.[token]))
  }
  if (kind === 'domain-prose') {
    return Math.max(b.prose?.[key]?.tokens?.[token] ?? 0, b.testProse?.[key]?.tokens?.[token] ?? 0)
  }
  return Math.max(count(b.literals?.[key]?.[token]), count(b.testLiterals?.[key]?.[token]))
}

/**
 * The property the copy formulation cannot observe: **the committed ledger has no room
 * left to absorb this plant.**
 *
 * The guard's ratchet drops a finding only while `budget[(file, token)] > 0`, so a plant
 * is genuinely detected by the REAL (baselined) guard iff the file's committed budget for
 * that token is already fully consumed by the hits the file really carries. Under a scan
 * override no baseline is loaded at all, so the delta assertion alone would be satisfied
 * by a plant that the real guard silently swallows.
 *
 * `controlLines` are the findings of the UNPLANTED copy — byte-identical content to the
 * real file, therefore exactly the hits the real file contributes, unfiltered. So for
 * every `(kind, token)` the plant added, `committed <= observed` is the whole statement:
 * one more hit of that token cannot fit under the ledger and must be reported.
 *
 * Today this holds for every entry by construction — the guard errors STALE when a
 * committed count EXCEEDS what remains — but "it is enforced somewhere else" is what the
 * old formulation relied on too, and it is what stopped being true the moment the plants
 * moved off the baselined path. Asserted here, at the plant, it cannot silently stop
 * applying to these tests again.
 */
function assertLedgerCannotAbsorbPlant(abs, controlLines, added) {
  const key = GUARD_MODULE.baselineKey(abs)
  const control = controlLines.map(parseFinding).filter(Boolean)
  const seen = new Set()
  for (const line of added) {
    const f = parseFinding(line)
    if (!f) continue
    const id = `${f.kind}\u0000${f.token}`
    if (seen.has(id)) continue
    seen.add(id)
    const observed = control.filter(c => c.kind === f.kind && c.token === f.token).length
    const committed = committedBudget(key, f.kind, f.token)
    assert.ok(
      committed <= observed,
      `the committed ledger would ABSORB this plant: domain-baseline.json grants ` +
        `"${key}" ${committed} hit(s) of [${f.kind}] "${f.token}" and the real file only ` +
        `carries ${observed}, so the REAL guard has ${committed - observed} unit(s) of ` +
        `headroom and would drop the planted finding this test just saw. The plant proves ` +
        `the tokenizer, not the gate. Prune the entry (\`--prune-baseline\`) or plant a ` +
        `token the ledger does not fund.`,
    )
  }
}

/**
 * Append `extra` to a COPY of a REAL tree file and report the findings the plant ADDED.
 *
 * The real file is READ and never written. Appending cannot move an existing line, so
 * the control run's findings are a strict subset of the planted run's and the set
 * difference is exactly the plant's own output.
 *
 * @param {string} relFromSrcApp e.g. `server/src/modules/rootfs/mod.rs`
 * @param {string} extra the planted text
 * @returns {{control:object, planted:object, added:string[], entry:object}}
 */
function plantInCopyOfReal(relFromSrcApp, extra) {
  const abs = path.join(SRC_APP, ...relFromSrcApp.split('/'))
  assert.ok(existsSync(abs), `the fixture target must be a REAL production file: ${abs}`)
  const entry = REAL_SCAN_SET.find(e => e.path === abs)
  assert.ok(
    entry,
    `${relFromSrcApp} is NOT in the REAL default scan set — the walk cannot see it, so ` +
      `no plant in it could ever fail the guard. Re-point the fixture or fix the walk.`,
  )
  return withTmp(dir => {
    const copy = path.join(dir, ...relFromSrcApp.split('/'))
    mkdirSync(path.dirname(copy), { recursive: true })
    const original = readFileSync(abs, 'utf8')
    // CONTROL first: the same copy, unplanted. Whatever it reports is pre-existing.
    writeFileSync(copy, original)
    const control = runGuard([{ ...entry, path: copy }])
    writeFileSync(copy, original + extra)
    const planted = runGuard([{ ...entry, path: copy }])
    const controlLines = findingLines(control.stderr)
    const before = new Set(controlLines)
    const added = findingLines(planted.stderr).filter(l => !before.has(l))
    // The half a scan override cannot see — done HERE so every plant carries it.
    assertLedgerCannotAbsorbPlant(abs, controlLines, added)
    return { control, planted, added, entry }
  })
}

/**
 * Assert the plant produced a finding matching EVERY pattern in `patterns`, and that
 * the control run (same file, no plant) did NOT.
 */
function assertPlantDetected({ control, planted, added }, patterns, why) {
  assert.equal(planted.code, 1, `${why}\n${planted.stderr.slice(0, 2000)}`)
  const hit = added.find(l => patterns.every(p => p.test(l)))
  assert.ok(
    hit,
    `${why}\nno ADDED finding matched ${patterns.map(String).join(' + ')}.\n` +
      `added:\n${added.join('\n') || '(none)'}`,
  )
  // The negative control: the same bytes minus the plant do not produce that finding.
  assert.ok(
    !findingLines(control.stderr).some(l => patterns.every(p => p.test(l))),
    `the control run already reported it — the plant proves nothing:\n${hit}`,
  )
}

/**
 * The guard's OWN exports, resolved under a test-only ROOTS override, in a child
 * process (the override is read at module load, and this process is deliberately not
 * running with the self-test opt-in). Used by the two tests whose subject is the WALK
 * itself rather than the tokenizer — they used to prove it by creating a file inside
 * `ui/src` / `packages`, which is the same "write into the real tree" hazard.
 *
 * @param {Record<string,string>} roots e.g. `{ uiSrc: '<tmp>' }`
 * @param {string} expr an expression over the imported module `m`
 */
function guardExportUnderRoots(roots, expr) {
  const src = `const m = await import(${JSON.stringify(GUARD)}); console.log(JSON.stringify(${expr}))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: guardEnv({ LINT_NO_DOMAIN_ROOTS_OVERRIDE: JSON.stringify(roots) }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `the probe process failed:\n${r.stderr}`)
  return JSON.parse(r.stdout)
}

// ── FAIL cases (INV-1/INV-2/INV-3): a real-code domain literal is caught ─────

test('[acceptance][INV-1] FAILS on a quoted bare-id in production Rust', () => {
  withTmp(dir => {
    const f = path.join(dir, 'builtin.rs')
    writeFileSync(f, `fn seed() { let id = "embedding"; let _ = id; }\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, 'guard must fail on a quoted domain id')
    assert.match(stderr, /embedding/, 'reports the offending token')
  })
})

test('[acceptance][INV-1] FAILS on a slash-id substring in production Rust', () => {
  withTmp(dir => {
    const f = path.join(dir, 'mod.rs')
    writeFileSync(f, `fn f(id:&str)->bool{ id == "single-cell/anndata" }\n`)
    const { code } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1)
  })
})

test('[acceptance][INV-2] FAILS on a `=== id` domain branch in production TS', () => {
  withTmp(dir => {
    const f = path.join(dir, 'CanvasView.tsx')
    writeFileSync(f, `export const has = (id: string) => id === 'clustering'\n`)
    const { code } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1)
  })
})

test('[acceptance][INV-2] FAILS on a bracket-access dispatch `x["embedding"]`', () => {
  withTmp(dir => {
    const f = path.join(dir, 'host.ts')
    writeFileSync(f, `export const pick = (o: Record<string,unknown>) => o["embedding"]\n`)
    const { code } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1, 'a gamed unquoted-key rename is still caught once quoted')
  })
})

test('[acceptance][INV-3] FAILS on a domain literal in a residual site (tiledb_serve-like)', () => {
  withTmp(dir => {
    const f = path.join(dir, 'soma.rs')
    writeFileSync(f, `pub fn reader(id:&str){ if id == "single-cell/soma" { todo!() } }\n`)
    const { code } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1)
  })
})

test('[acceptance][INV-3] FAILS on a hardcoded title label in production TS', () => {
  withTmp(dir => {
    const f = path.join(dir, 'UploadPanel.tsx')
    writeFileSync(f, `export const label = { value: 'x', title: 'AnnData' }\n`)
    const { code } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1)
  })
})

test('[acceptance][INV-2] FAILS on an injected single-cell-widgets path', () => {
  withTmp(dir => {
    const f = path.join(dir, 'discover.ts')
    writeFileSync(f, `import.meta.glob('./single-cell-widgets/*.ts')\n`)
    const { code } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1, 'a hardcoded relocated-widget path is a domain reference')
  })
})

// ── PASS cases (DEC-9 exemptions): legitimate uses must NOT false-positive ───

test('[acceptance][INV-1] PASSES: datatype IDS only in comments + #[cfg(test)]', () => {
  withTmp(dir => {
    const f = path.join(dir, 'builtin.rs')
    // NOTE `nouns: false` — this case is about the datatype-ID vocabulary, which
    // has always been comment-exempt. WS-B's separate `domain-prose` tier (below)
    // is what now sees domain NOUNS in prose.
    writeFileSync(
      f,
      [
        `//! domain (single-cell/expression, clustering, de) moved to DATA`,
        `fn seed() { let cap = "plottable-xy"; let _ = cap; } // formerly 'clustering'`,
        `#[cfg(test)]`,
        `mod tests {`,
        `    const T: &str = "single-cell/matrix-mtx";`,
        `    fn t() { assert_eq!("de", "de"); assert!("clustering".len() > 0); }`,
        `}`,
      ].join('\n') + '\n',
    )
    const { code, stdout } = runGuard([{ path: f, lang: 'rust', nouns: false }])
    assert.equal(code, 0, stdout)
  })
})

// ── WS-R3 §1 — this test used to assert the OPPOSITE ────────────────────────
// It read "[acceptance][INV-1] PASSES: #[cfg(debug_assertions)] dev-seed block is
// exempt", and it was the test that CERTIFIED the hole: a passing assertion that
// the guard must not look at the one attribute `workstore/data_api.rs` is written
// entirely under. It is inverted here rather than deleted, so the intent is on the
// record in both directions.
test('[WS-R3][§1] RED: a `#[cfg(debug_assertions)]` block is SCANNED, not exempt', () => {
  withTmp(dir => {
    const f = path.join(dir, 'data_api.rs')
    writeFileSync(
      f,
      [
        `#[cfg(debug_assertions)]`,
        `fn dev_seed() { let _ = "single-cell/anndata"; let _ = "embedding"; }`,
        `pub fn real() -> &'static str { "plottable-xy" }`,
      ].join('\n') + '\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'rust', nouns: false }])
    assert.equal(code, 1, 'a domain literal under #[cfg(debug_assertions)] must FAIL')
    assert.match(stderr, /\[substring\]\s+single-cell/)
    assert.match(stderr, /\[quoted-id\]\s+embedding/)
  })
})

test('[WS-R3][§1] `#[cfg(test)]` is STILL blanked — the exemption is compiler-enforced', () => {
  withTmp(dir => {
    const f = path.join(dir, 'prod.rs')
    writeFileSync(
      f,
      [
        `pub fn real() -> &'static str { "plottable-xy" }`,
        `#[cfg(test)]`,
        `mod tests {`,
        `    const T: &str = "single-cell/matrix-mtx";`,
        `    fn t() { let n_cells = 1; let _ = n_cells; }`,
        `}`,
      ].join('\n') + '\n',
    )
    const { code, stdout } = runGuard([{ path: f, lang: 'rust', nouns: true }])
    assert.equal(code, 0, stdout)
  })
})

test('[WS-R3][§1] the two attributes are treated DIFFERENTLY by the same file', () => {
  withTmp(dir => {
    const f = path.join(dir, 'both.rs')
    writeFileSync(
      f,
      [
        `#[cfg(test)]`,
        `mod t { const A: &str = "single-cell/soma"; }`,
        `#[cfg(debug_assertions)]`,
        `mod d { const B: &str = "single-cell/soma"; }`,
      ].join('\n') + '\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'rust', nouns: false }])
    assert.equal(code, 1)
    // EXACTLY ONE of the two identical literals is reported — the debug one.
    const hits = stderr.split('\n').filter(l => /\[substring\]/.test(l))
    assert.equal(hits.length, 1, `expected only the debug_assertions hit, got:\n${stderr}`)
    assert.match(hits[0], /both\.rs:4:/)
  })
})

test('[acceptance][INV-2] PASSES: declarative-engine example strings + host keys', () => {
  withTmp(dir => {
    const f = path.join(dir, 'createHost.ts')
    writeFileSync(
      f,
      [
        `/** A produced \`embedding\` (extends matrix) declares plottable-xy. */`,
        `const CAP = 'plottable-xy' // → layouts (embedding scatter); was isA(_,'embedding')`,
        `export const host = {`,
        `  clustering: () => ({ codes: [] }),`, // object KEY, not a string id
        `  embedding: (id: string) => id,`,
        `}`,
        `export const isRef = (k: string) => k.startsWith('clustering:')`, // prefix, not id
        `export const err = (id: string) => new Error(\`embedding "\${id}" has no data\`)`,
        `export const NEEDS = 'needs an embedding'`, // UI copy sentence
      ].join('\n') + '\n',
    )
    const { code, stdout } = runGuard([{ path: f, lang: 'ts', nouns: false }])
    assert.equal(code, 0, stdout)
  })
})

// ── WS-R4 — THIS TEST USED TO ASSERT THE OPPOSITE ────────────────────────────
// It read `PASSES: exempt files (*.test.* / __fixtures__) are skipped` and asserted
// `code === 0`. That is a test CERTIFYING the hole: the basename exemption was
// claimable by naming a file, and a green test stood behind it. WS-R4 retires the
// exemption (basename is now a TIER CLASSIFIER, not a skip), so the assertion inverts.
test('[WS-R4] RED: a `*.test.ts` file is SCANNED — the basename exemption is GONE', () => {
  withTmp(dir => {
    const bad = `const id = 'embedding'; export default id\n`
    const t = path.join(dir, 'foo.test.ts')
    writeFileSync(t, bad)
    const { code, stderr } = runGuard([{ path: t, lang: 'ts' }])
    assert.equal(code, 1, 'a domain id can no longer be hidden by naming the file `*.test.ts`')
    assert.match(stderr, /\[quoted-id\]\s+embedding/)
  })
})

test('[WS-R4] RED: `*.spec.tsx` / `*.spec.mjs` are scanned too — the whole glob is retired', () => {
  withTmp(dir => {
    for (const name of ['a.spec.ts', 'b.spec.tsx', 'c.test.mjs', 'd.test.js']) {
      const f = path.join(dir, name)
      writeFileSync(f, `const id = 'clustering'\n`)
      const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
      assert.equal(code, 1, `${name} must be scanned, not exempted by basename`)
      assert.match(stderr, /\[quoted-id\]\s+clustering/)
    }
  })
})

// ── WS-R3 §4 — the BASENAME exemption is gone; these are its negative controls ─
test('[WS-R3][§4] RED: `gallery.tsx` and `cassette.ts` are SCANNED, not exempt', () => {
  withTmp(dir => {
    const bad = `const id = 'embedding'; export default id\n`
    const g = path.join(dir, 'gallery.tsx')
    const c = path.join(dir, 'cassette.ts')
    writeFileSync(g, bad)
    writeFileSync(c, bad)
    const { code, stderr } = runGuard([
      { path: g, lang: 'ts' },
      { path: c, lang: 'ts' },
    ])
    assert.equal(code, 1, 'the basename exemption was claimable by NAMING a file')
    assert.match(stderr, /gallery\.tsx:1:/)
    assert.match(stderr, /cassette\.ts:1:/)
  })
})

test('[WS-R3][§4] the basename-exemption branches are absent from the guard SOURCE', () => {
  const src = readFileSync(GUARD, 'utf8')
  const code = src.split('function isExemptFile')[1].split('\nfunction ')[0]
  const live = code
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.ok(
    !/base === 'gallery\.tsx'/.test(live),
    'the `gallery.tsx` basename branch is back — it is claimable by naming a file',
  )
  assert.ok(!/base === 'cassette\.ts'/.test(live), 'the `cassette.ts` basename branch is back')
})

test('[WS-R3][§4] the real scan set REACHES the 10 formerly basename-exempt files', async () => {
  const mod = await import(`${GUARD}?ws-r3-basename`)
  const keys = new Set(mod.defaultScanSet().set.map(e => mod.baselineKey(e.path)))
  for (const k of [
    'ui/src/modules/workbench/gallery.tsx',
    'ui/src/modules/datasets/gallery.tsx',
    'ui/src/dev/gallery/fixtures/cassette.ts',
  ]) {
    assert.ok(keys.has(k), `${k} must be in the scan set now`)
  }
})

// ── The headline: the REAL app-builtin surface carries ZERO domain literals ──

test('[acceptance][INV-1,INV-2,INV-3] the REAL app-builtin tree is domain-free', () => {
  const { code, stdout, stderr } = runGuard(undefined)
  assert.equal(code, 0, `guard failed on the real tree:\n${stderr}`)
  // WS-C: the headline is no longer "ZERO literals" — the widened scan set found
  // THREE real ones (W1/W2), which are recorded under a shrink-only ceiling rather
  // than fixed by this workstream. The PASS line states the live number, so a
  // reader cannot mistake "recorded" for "absent".
  assert.match(stdout, /domain datatype LITERALS \(INV-1\/INV-2\/INV-3\) = \d+, all recorded \+ shrink-only/)
  // ...and every one of the seven roots reports a real file count on the same line.
  assert.match(stdout, /roots: rust=\d+ rustRoot=\d+ buildHelper=\d+ desktop=\d+ workbenchFe=\d+ uiFe=\d+ packagesFe=\d+/)
})

// ── ITEM-19: the domain NOUN vocabulary ─────────────────────────────────────
// Until ITEM-19 the guard's vocabulary was datatype IDS + TITLES and contained no
// domain NOUN at all — which is why `core/**` passed while still declaring a
// `{ gene }` ref and `DataCtx.geneIndex()`. These are the negative controls for
// the closed hole. The scan override carries an explicit `nouns` flag because the
// temp fixtures live outside `ui/src/modules/workbench` (the real noun scope).

test('[negative-control][ITEM-19] FAILS on a planted `leiden` in a core/runtime file', () => {
  withTmp(dir => {
    const f = path.join(dir, 'gate.ts')
    writeFileSync(f, `export const PLANTED = pickControl('leiden')\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1, 'a domain noun in core is a violation')
    assert.match(stderr, /\[domain-noun\]\s+leiden/)
  })
})

test('[negative-control][ITEM-19] FAILS on a planted `CellSet` in an extension file', () => {
  withTmp(dir => {
    const f = path.join(dir, 'canvasBinding.ts')
    writeFileSync(f, `export type Planted = { keep: CellSet }\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1, 'an extension may not name an index set after the domain')
    assert.match(stderr, /\[domain-noun\]\s+CellSet/i)
  })
})

test('[ITEM-19] the letter boundary catches `n_genes` / `X_umap` but not `generic`', () => {
  withTmp(dir => {
    // `\b` treats `_` as a word char, so `\bgenes\b` would MISS `n_genes` — exactly
    // the fail-open shape this round keeps producing. The guard uses a LETTER
    // boundary instead.
    const bad = path.join(dir, 'contract.ts')
    writeFileSync(bad, `export interface C { n_genes: number; X_umap: string }\n`)
    assert.equal(runGuard([{ path: bad, lang: 'ts', nouns: true }]).code, 1)

    const ok = path.join(dir, 'generic.ts')
    writeFileSync(
      ok,
      `export type GenericResult = { generator: string; generated: boolean; general: number }\n`,
    )
    assert.equal(
      runGuard([{ path: ok, lang: 'ts', nouns: true }]).code,
      0,
      '`generic`/`generator`/`generated`/`general` must not false-positive',
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// WS-B — the four blind spots DOMAIN_AUDIT §0 found, each with the planted-leak
// demonstration that proves the closure. Every one of these FAILED to fail
// before the widening; a guard never seen failing is not evidence.
// ═════════════════════════════════════════════════════════════════════════════

// ── BLIND SPOT #1a: the word list omitted the DATA-MODEL vocabulary ──────────
// `cell`, `obs`, `sample`, `n_cells` and `embedding` were absent, so
// `ProjectCatalog { n_cells, n_genes }` (E1), `ResidentInput { inputCells,
// inputFeatures }` (E5) and `FAKE_HOST_N_CELLS` (C4) each sat in a SCANNED file
// and produced ZERO findings.

for (const [name, line, token] of [
  ['E1 — the two-axis catalog contract', `export interface ProjectCatalog { n_cells: number; n_genes: number }`, 'cells'],
  ['C4 — core inventing the noun', `export const FAKE_HOST_N_CELLS = 5000`, 'cells'],
  ['C6/C7/C8 — core privileging a slice named obs', `export const slice = data['obs']`, 'obs'],
  ['E4 — the single-cell param regex table', `const CELL_CAP = /^(n_cells|cell_cap|target_cells|max_cells)$/`, 'cell'],
  ['E2 — the hardcoded input format', 'const sub = `${slot}.h5ad`', 'h5ad'],
  ['E6/C5 — the only modelled precondition', `export type Spec = { embeddings?: string }`, 'embeddings'],
  ['S8 — a domain tool as server policy', `fn cellranger_freshness_tag(url: &str) {}`, 'cellranger'],
  ['S4 — the attested replay artifact', `let s = "mask = adata.obs[col]";`, 'adata'],
]) {
  test(`[WS-B][blind-spot-1] FAILS on ${name}`, () => {
    withTmp(dir => {
      const f = path.join(dir, 'planted.ts')
      writeFileSync(f, `${line}\n`)
      const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
      assert.equal(code, 1, `the widened vocabulary must catch this:\n${line}`)
      assert.match(stderr, new RegExp(`\\[domain-noun\\]\\s+${token}`, 'i'))
    })
  })
}

// ── BLIND SPOT #1b: comments were BLANKED, so domain INTENT was invisible ────
// DOMAIN_AUDIT §0's exemplar: `StandardResultTable` had 8 domain-word matches in
// 372 lines and was wholly a single-cell deliverable — legible only from its doc
// header. Prose is now its own LOWER severity with its own baseline, not silence.

test('[WS-B][blind-spot-1] FAILS on domain PURPOSE stated only in a doc header', () => {
  withTmp(dir => {
    const f = path.join(dir, 'StandardResultTable.tsx')
    writeFileSync(
      f,
      [
        `/**`,
        ` * The standard result table for a single-cell run: one row per cell,`,
        ` * columns for the gene counts and the leiden assignment.`,
        ` */`,
        `export const Table = () => null`,
      ].join('\n') + '\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1, 'domain intent in prose is EVIDENCE and must be reported')
    assert.match(stderr, /\[domain-prose\]/)
    assert.match(stderr, /\[domain-prose\]\s+cell/i)
  })
})

test('[WS-B][blind-spot-1] prose and code are SEPARATE severities, not one bucket', () => {
  withTmp(dir => {
    const f = path.join(dir, 'mixed.ts')
    writeFileSync(f, `// a note about cells\nexport const n = { n_cells: 0 }\n`)
    const { stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.match(stderr, /\[domain-noun\]\s+cells/i, 'the CODE hit is the higher severity')
    assert.match(stderr, /\[domain-prose\]\s+cells/i, 'the PROSE hit is reported separately')
    assert.match(stderr, /\d+ in code, \d+ in prose/, 'the summary splits the two tiers')
  })
})

// ── BLIND SPOT #1c: the blanket `/gallery/` DIRECTORY exemption ──────────────

test('[WS-B][blind-spot-1] RED: a domain noun under a `gallery/` DIRECTORY is now CAUGHT', () => {
  withTmp(dir => {
    const d = path.join(dir, 'core', 'gallery')
    mkdirSync(d, { recursive: true })
    const f = path.join(d, 'fixtureSpecs.ts')
    writeFileSync(f, `export const SPEC = { rows: 'n_cells' }\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1, 'the blanket directory exemption must be gone')
    assert.match(stderr, /\[domain-noun\]\s+cells/i)
  })
})

test('[WS-B][blind-spot-1] the `/gallery/` directory branch is absent from the guard SOURCE', () => {
  const src = readFileSync(GUARD, 'utf8')
  const code = src
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(code, /includes\('\/gallery\/'\)/, 'the directory exemption is still executable')
  // WS-R3 §4: the DEV-ENTRY BASENAME form went the same way. It had the identical
  // property the directory form was condemned for — claimable by naming a file —
  // and it is asserted absent by `[WS-R3][§4] the basename-exemption branches …`.
})

test('[WS-B][blind-spot-1] the real scan set now REACHES the former `/gallery/` files', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set } = mod.defaultScanSet()
  const reached = set.filter(e => e.path.replace(/\\/g, '/').includes('/modules/workbench/core/gallery/'))
  assert.ok(
    reached.length >= 2,
    `the widened scan must reach the production files under core/gallery/, got ${reached.length}`,
  )
})

// ── BLIND SPOT #2: the noun scan skipped the ENTIRE Rust module tree ─────────
// The guard's own source said so: *"It is NOT applied to the Rust module tree"*.
// That made all ELEVEN server findings (S1-S11) unreachable by construction.

test('[WS-B][blind-spot-2] FAILS on a domain noun in production RUST (was unscanned)', () => {
  withTmp(dir => {
    const f = path.join(dir, 'data_api.rs')
    writeFileSync(f, `pub struct ProjectCatalog { pub n_genes: i64, pub n_cells: i64 }\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, 'the noun scan must now cover the Rust module tree')
    assert.match(stderr, /\[domain-noun\]\s+genes/i)
    assert.match(stderr, /\[domain-noun\]\s+cells/i)
  })
})

test('[WS-B][blind-spot-2] RED: a planted Rust noun FAILS on the REAL scan entry', () => {
  // `rootfs/` is one of the modules `tests/domain_surface` never scanned and the
  // JS noun scan could not reach. Planted in a COPY of the real file (R20 §1).
  const r = plantInCopyOfReal(
    'server/src/modules/rootfs/mod.rs',
    `\npub const PLANTED_FOR_TEST: &str = "barcode_whitelist";\n`,
  )
  assertPlantDetected(
    r,
    [/rootfs\/mod\.rs/, /\[domain-noun\]\s+barcode/i],
    'a domain NOUN in rootfs/ must fail the guard on that file\'s real scan entry',
  )
})

test('[WS-B][blind-spot-2][§7-FP] `#[cfg(test)]` seed code + OnceCell do NOT fire', () => {
  withTmp(dir => {
    // Three of DOMAIN_AUDIT §7's confirmed false positives, in one Rust fixture:
    //   - `#[cfg(test)]` module bodies (WS-R3 §1 keeps THIS one blanked; the
    //     `#[cfg(debug_assertions)]` half of the old §7 claim is now RED — see
    //     `[WS-R3][§1] the two attributes are treated DIFFERENTLY by the same file`)
    //   - `std::marker::PhantomData` / `ROOTFS_SCHEMA_MARKER` (the word "marker")
    //   - `OnceCell` / `once_cell`, the Rust std+crate `cell` sense
    const f = path.join(dir, 'data_api.rs')
    writeFileSync(
      f,
      [
        `use once_cell::sync::OnceCell;`,
        `use std::marker::PhantomData;`,
        `pub const ROOTFS_SCHEMA_MARKER: &str = "schema";`,
        `static CACHE: OnceCell<u32> = OnceCell::new();`,
        `pub struct S<T> { _m: PhantomData<T> }`,
        `#[cfg(test)]`,
        `mod t { fn seed() { let _ = "single-cell/expression"; let n_cells = 1; let _ = n_cells; } }`,
        `pub fn real() -> &'static str { "plottable-xy" }`,
      ].join('\n') + '\n',
    )
    const { code, stdout, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 0, `§7 confirmed false positives must not fire:\n${stderr}\n${stdout}`)
  })
})

test('[WS-B][blind-spot-2][§7-FP] the guard does NOT flag its own forbidden-string list', async () => {
  // `workstore/no_legacy_wire.rs` is a `#[cfg(test)]`-declared grep-guard that must
  // spell the forbidden vocabulary out in order to search for it (§7). It is exempt
  // by DECLARATION, so it is not in the scan set at all.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set } = mod.defaultScanSet()
  const paths = set.map(e => e.path.replace(/\\/g, '/'))
  assert.ok(
    !paths.some(p => p.endsWith('/workstore/no_legacy_wire.rs')),
    'a #[cfg(test)]-declared grep-guard must stay outside the scan set',
  )
  // ...and this guard's own vocabulary lives in `ui/scripts/`, outside both roots.
  assert.ok(!paths.some(p => p.includes('/ui/scripts/')), 'the guard must not scan itself')
})

// ── BLIND SPOT #4: `\b` does not fire inside `n_cells` (and camelCase) ───────

test('[WS-B][blind-spot-4] the boundary catches `_`-joined AND camelCase compounds', () => {
  withTmp(dir => {
    // `\b` treats `_` as a word char (`\bcells\b` MISSES `n_cells`) and a letter
    // boundary alone misses the camel hump in `inputCells` (E5). Both must hit.
    for (const src of [
      `export interface C { n_cells: number; n_genes: number; X_umap: string }`,
      `export interface R { inputCells: number; inputFeatures: number }`,
      `export const MAX_CELLS = 1; export const nObs = 2; export const cellsById = {}`,
      `export const f = { 'cell-set': 1, cell_set: 2 }`,
    ]) {
      const f = path.join(dir, 'contract.ts')
      writeFileSync(f, `${src}\n`)
      assert.equal(runGuard([{ path: f, lang: 'ts', nouns: true }]).code, 1, src)
    }
  })
})

test('[WS-B][blind-spot-4] the boundary does NOT claim innocent English', () => {
  withTmp(dir => {
    const f = path.join(dir, 'generic.ts')
    writeFileSync(
      f,
      [
        `export type G = { generator: string; generated: boolean; general: number; generic: 1 }`,
        `export const degenerate = 1`,
        `export const jobs = []; export const Jobs = 1; export const JOBS = 2`,
        `export const observed = 1; export const obsolete = 2; export const observable = 3`,
        `export const excellent = 1; export const resampled = 2`,
        `export const Somatic = 1`,
      ].join('\n') + '\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 0, `innocent English must not be claimed:\n${stderr}`)
  })
})

// ── The BASELINE is a ratchet keyed to the DOMAIN_AUDIT worklist ─────────────

test('[WS-B][baseline] every `code` entry names a DOMAIN_AUDIT finding or an explicit tag', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { code } = mod.loadBaseline()
  // WS-C: + W1-W12 (DOMAIN_AUDIT §9, the findings the widened scan set surfaced)
  // and the two prose classes DOC-EXAMPLE / DOC-CHANGELOG. `RESIDUE` is GONE from
  // this list on purpose — it was the untriaged bucket, all nine entries were
  // triaged, and the guard now REJECTS the tag outright.
  // WS-R3: + the four R3-* tags, one per hole closed this round (R3-DEBUG =
  // `#[cfg(debug_assertions)]` un-blanked, R3-EXT = the four data formats,
  // R3-GALLERY = the removed basename exemption, R3-TOKEN = the five new tokens).
  // WS-R5 — CONSUMED FROM THE GUARD, not re-declared here. The set used to live only in this
  // test (and only for two of the six sections), so `finding` accepted ANY non-empty string at
  // runtime and this regex was a second, drifting copy of a rule nothing enforced. The guard
  // now owns the closed set and applies it to every section; the test asserts the same source.
  const OK = mod.VALID_FINDING_TAGS
  const entries = []
  for (const [file, toks] of Object.entries(code)) {
    for (const [tok, spec] of Object.entries(toks)) {
      entries.push([file, tok, spec])
      assert.ok(OK.test(spec.finding), `${file}[${tok}] has an unrecognised finding "${spec.finding}"`)
      assert.ok(typeof spec.note === 'string' && spec.note.length > 10, `${file}[${tok}] has no note`)
      assert.ok(spec.count > 0, `${file}[${tok}] is a zero-count entry — prune it`)
    }
  }
  // The PROSE tier accepts either a bare count (the 2026-07-28 bulk record) or the
  // same {count, finding, note} form; where the reason IS given it is held to the
  // same vocabulary — an explained entry may not invent its own tag.
  // WS-R3: the prose tier is per (file, TOKEN) — `{ finding?, note?, tokens }`.
  const { prose } = mod.loadBaseline()
  for (const [file, spec] of Object.entries(prose)) {
    assert.ok(
      spec && typeof spec === 'object' && spec.tokens,
      `prose[${file}] must use the per-token form {tokens:{…}} — a per-file total is fungible`,
    )
    for (const [tok, n] of Object.entries(spec.tokens)) {
      assert.ok(n > 0, `prose[${file}].tokens[${tok}] is a zero-count entry — prune it`)
    }
    if (!spec.finding) continue // grandfathered-unexplained, capped by BARE_PROSE_CEILING
    assert.ok(OK.test(spec.finding), `prose[${file}] has an unrecognised finding "${spec.finding}"`)
    assert.ok(typeof spec.note === 'string' && spec.note.length > 10, `prose[${file}] has no note`)
  }

  // POSITIVE COUNT: a baseline that quietly emptied would make the guard green
  // for the wrong reason. It is a WORKLIST of the 25 HIGH findings + residue.
  // Re-anchored 100 -> 75 on 2026-07-28 with the measurement (152 -> 92): the
  // five-workstream merge FIXED leaks and `--prune-baseline` removed 61 entries.
  // ROUND-2 re-anchored 75 -> 44 with the measurement (101 -> 67): the eleven-way
  // merge + `--prune-baseline` removed 34 more. Kept at ≈2/3 of the measurement so it
  // stays a collapse detector rather than a tripwire the next fix pass breaks.
  // WS-R3 re-anchored 44 -> 131 with the measurement (67 -> 197): the four holes this
  // round closed surfaced 130 more (file, token) pairs. Same ≈2/3 rule.
  assert.ok(entries.length >= 131, `expected >=131 baselined entries, got ${entries.length}`)
  const findings = new Set(entries.map(([, , s]) => s.finding))
  // C4 LEFT this list on 2026-07-28: `createHost.ts`'s `n = c.n_cells ?? 0` (and
  // `FAKE_HOST_N_CELLS`) is GONE — the open-axis migration replaced it with declared
  // axis cardinalities, so the only `n_cells` left in that file is the two comments
  // explaining the fix, which live in the prose tier. Asserted below rather than
  // assumed: a finding leaves this list only when its CODE residue is actually zero.
  //
  // E1 and DEC-M LEFT it at the ROUND-2 reconciliation, same rule, same evidence:
  //   * E1 — WS-C replaced the positional axis naming in `AnalysisRunPanel.tsx` +
  //     `workbenchDataSource.ts` with DECLARED axes (13 code hits -> 0);
  //   * DEC-M — WS-H retired `cell_count`/`gene_count` from `AdminProjectRow`
  //     (8 code hits -> 0; spec + generated TS client regenerated with it).
  // Both are asserted GONE below rather than merely dropped, so a revert fails here
  // too — the same shape as the Rust twin's DEC-M assertion.
  //
  // S2 LEFT the must-list on the artifact-model branch, same rule and same evidence.
  // Its ONLY code entry was `workstore/serve_core.rs` code[obs], and ITEM-12 DELETED that
  // file outright (the Selection->Arrow serve core; `/data` is the sole read path now).
  // The residue relocated once — to `ingest.rs`'s `COLUMN_ENVELOPE_KEYS = ["obs"]`, and it
  // was RE-BASELINED there rather than pruned — and then DRIFT-2.1 deleted that too, as an
  // active INV-1 violation (ingest was `serde_json::from_slice`-ing artifact payloads to
  // classify columns). `ingest.rs` now carries ONE `obs`, in the line-272 COMMENT recording
  // the deletion, which is why it survives in `prose` and is zero in `code`. Verified by
  // grep, not assumed. Moving it to the `gone` list below makes a revert FAIL here, which
  // is stricter than leaving it in `must` and is the same two-sided edit E1/DEC-M took.
  for (const must of ['S3', 'DEC-J']) {
    assert.ok(findings.has(must), `the baseline must carry the ${must} residue`)
  }
  for (const gone of ['E1', 'DEC-M', 'S2']) {
    assert.ok(
      !findings.has(gone),
      `${gone} has CODE residue again — it was fixed in round 2. Put it back in the ` +
        `must-list above in the same commit that reintroduces it.`,
    )
  }
  const hostNouns =
    mod.runGuard().observed['domain-noun']['ui/src/modules/workbench/core/host/createHost.ts'] ?? {}
  assert.deepEqual(hostNouns, {}, 'C4/B2 is fixed in CODE, not renamed — no noun hit survives there')
})

test('[WS-B][baseline] RATCHET: one MORE occurrence than the baseline FAILS', () => {
  // R20 §1 — the same arithmetic, driven from the LEDGER instead of from the tree.
  // This used to append a hit to a real production file so the observation sat one
  // above its budget. The ratchet compares `observed` with `budget`, so an observation
  // of budget+1 and a budget of observed-1 are the SAME inequality — and the second is
  // reachable through the `LINT_NO_DOMAIN_BASELINE_OVERRIDE` seam, with the working
  // tree untouched. The subject (an excess occurrence is REPORTED, by file and token)
  // is unchanged; only the side the −1 sits on moved.
  const real = JSON.parse(readFileSync(path.join(__dirname, 'domain-baseline.json'), 'utf8'))
  const file = Object.keys(real.code)[0]
  const tok = Object.keys(real.code[file])[0]
  assert.ok(real.code[file][tok].count >= 1, `${file}/${tok} must carry a real budget`)
  const doctored = JSON.parse(JSON.stringify(real))
  doctored.code[file][tok].count -= 1
  const { code, stderr } = runWithBaseline(doctored)
  assert.equal(code, 1, 'a hit ABOVE the committed count is a NEW leak')
  assert.match(stderr, /\d+ domain finding\(s\) outside the committed baseline/)
  assert.match(
    stderr,
    new RegExp(`${path.basename(file).replace('.', '\\.')}:\\d+:\\d+\\s+\\[domain-\\w+\\]\\s+${tok}`),
    `the excess must be reported by file and token, got:\n${stderr.slice(0, 2000)}`,
  )
  // Positive control: at the COMMITTED budget the same tree is green, so the failure
  // above is the −1 and nothing else.
  assert.equal(runWithBaseline(real).code, 0, 'the committed ledger admits the real tree')
})

/** Run the guard against a TEMP baseline (real tree, substituted ratchet). */
function runWithBaseline(baselineObj, argv = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-bl-'))
  const p = path.join(dir, 'domain-baseline.json')
  writeFileSync(p, `${JSON.stringify(baselineObj, null, 2)}\n`)
  try {
    const r = spawnSync(process.execPath, [GUARD, ...argv], {
      env: guardEnv({ LINT_NO_DOMAIN_BASELINE_OVERRIDE: p }),
      encoding: 'utf8',
    })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, path: p }
  } finally {
    if (!argv.includes('--prune-baseline')) rmSync(dir, { recursive: true, force: true })
  }
}

test('[WS-B][baseline] RATCHET: FEWER occurrences than the baseline is STALE, not silent', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  // Inflate ONE entry: the tree can no longer satisfy it, so the baseline is stale.
  const [file] = Object.keys(real.code)
  const [tok] = Object.keys(real.code[file])
  const inflated = JSON.parse(JSON.stringify({ code: real.code, prose: real.prose }))
  inflated.code[file][tok].count += 5
  const { code, stderr } = runWithBaseline(inflated)
  assert.equal(code, 1, 'an unsatisfiable baseline entry must FAIL, not silently pass')
  assert.match(stderr, /STALE/)
  assert.match(stderr, /--prune-baseline/)
})

test('[WS-B][baseline] a MISSING `finding` id fails — the list may not become amnesia', () => {
  const { code, stderr } = runWithBaseline({
    code: { 'ui/src/modules/workbench/extensions/data/contract.ts': { cells: { count: 1 } } },
    prose: {},
  })
  assert.equal(code, 1)
  assert.match(stderr, /has no `finding`/)
  assert.match(stderr, /amnesia, not a worklist/)
})

test('[WS-R3][§4] the RETIRED per-file-total prose form is REJECTED, not tolerated', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const bl = JSON.parse(JSON.stringify({ code: real.code, prose: real.prose, literals: real.literals }))
  // Both retired spellings — a bare number and `{count, finding, note}` — are the
  // FUNGIBLE form. Leaving either readable would leave §4's hole open, so both fail.
  const [file, spec] = Object.entries(bl.prose)[0]
  const total = Object.values(spec.tokens).reduce((a, b) => a + b, 0)
  for (const retired of [total, { count: total, finding: 'GENERIC', note: 'retired form' }]) {
    bl.prose[file] = retired
    const { code, stderr } = runWithBaseline(bl)
    assert.equal(code, 1, `the retired form ${JSON.stringify(retired)} must FAIL`)
    assert.match(stderr, /RETIRED per-file-total form/)
    assert.match(stderr, /FUNGIBLE/)
  }
})

/**
 * ── WS-R7: THIS CONTROL WAS PASSING/FAILING FOR THE WRONG REASON ────────────
 *
 * It plants ONE unexplained prose entry and asserts the grandfather ceiling fires. Two
 * things had gone wrong with the PLANTING, and only one of them was visible:
 *
 *  1. The doctored ledger was built from `{code, prose, literals}` only — the three
 *     PRODUCTION tiers. WS-R4 then added test-tier FLOORS (`testBaselineEntries`, floor
 *     556), so a ledger with no `testCode` section trips "the guard stopped MATCHING
 *     (fail-closed)" and exits 1 for a reason that has nothing to do with the plant.
 *     `assert.equal(code, 1)` passed on that alone. A negative control whose exit code is
 *     satisfied by an unrelated collapse cannot distinguish "the ceiling fired" from "the
 *     scan collapsed" — which is the ONE discrimination it exists to make.
 *  2. `--prune-baseline` had dropped the prose measurement to 65 while BARE_PROSE_CEILING
 *     still read 66, so the plant landed AT the limit instead of above it and the expected
 *     message was never emitted at all. (Same defect as the 67 -> 66 fix recorded on that
 *     constant; see its comment.)
 *
 * The repair is to plant into a COMPLETE ledger — all six tiers, so every floor is
 * satisfied and the planted entry is the only violation — and then to assert the
 * discrimination directly: the collapse message must be ABSENT. Without that last
 * assertion this test would silently regress to (1) the next time a floor is added.
 */
test('[reconcile] a NEW UNEXPLAINED prose entry FAILS the grandfather ceiling', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  // COMPLETE, not production-only — see the note above.
  const bl = JSON.parse(JSON.stringify(real))
  // The unexplained form is the 2026-07-28 bulk record, not an escape hatch: stripping
  // the `finding` off an EXPLAINED entry pushes the unexplained count above the
  // committed ceiling. Without this the `finding` requirement is opt-in.
  const [file, spec] = Object.entries(bl.prose).find(([, v]) => v.finding)
  bl.prose[file] = { tokens: spec.tokens }
  // The UNDOCTORED complete ledger must be GREEN. This is what makes the run below a
  // one-variable experiment: without it, "exit 1" proves nothing about the plant.
  assert.equal(
    runWithBaseline(bl2Undoctored(real)).code,
    0,
    'the complete committed ledger must admit the real tree, or this control is not isolating the plant',
  )
  const { code, stderr } = runWithBaseline(bl)
  assert.equal(code, 1)
  assert.match(stderr, /UNEXPLAINED prose entries \(no `finding`\), above the committed ceiling/)
  assert.match(stderr, /grandfathered, not an escape hatch/)
  // THE DISCRIMINATION, asserted rather than assumed: the plant must be the only thing
  // that failed. If a fail-closed floor is firing too, this control has stopped being one.
  assert.doesNotMatch(
    stderr,
    /the guard stopped MATCHING/,
    `a fail-closed floor fired alongside the plant, so this control can no longer tell ` +
      `"the ceiling fired" from "the scan collapsed":\n${stderr.slice(0, 1200)}`,
  )
})

/** A complete, UNDOCTORED deep copy — the control's positive half. */
function bl2Undoctored(real) {
  return JSON.parse(JSON.stringify(real))
}

test('[WS-B][baseline] `--prune-baseline` only ever SHRINKS — it never adds a new leak', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  // Start from a baseline that is (a) stale in one entry and (b) missing every
  // other real violation. Pruning must fix (a) and NOT paper over (b).
  //
  // The (file, token) anchor is DERIVED from the live scan, not hard-coded: the
  // original fixture pinned `contract.ts` -> `cells`, which the open-axis migration
  // then deleted (`{n_cells, n_genes}` -> `axes[]`), so the fixture pruned to NOTHING
  // and the assertion read `undefined.cells`. A test of the ratchet must not itself
  // rot every time the ratchet does its job.
  const live = mod.runGuard().observed['domain-noun']
  const [file, tokens] = Object.entries(live).find(([, t]) => Object.keys(t).length > 0)
  const token = Object.keys(tokens)[0]
  const stale = {
    code: {
      [file]: {
        [token]: { count: 99, finding: 'E1', note: 'inflated on purpose for this test' },
        zzz_nonexistent: { count: 3, finding: 'E1', note: 'no longer present at all' },
      },
    },
    prose: {},
  }
  const { path: p } = runWithBaseline(stale, ['--prune-baseline'])
  const after = JSON.parse(readFileSync(p, 'utf8'))
  const entry = after.code[file]
  assert.ok(entry[token].count < 99, 'the stale count was lowered to what the tree carries')
  assert.equal(entry.zzz_nonexistent, undefined, 'the vanished entry was removed')
  assert.equal(Object.keys(after.code).length, 1, 'NOTHING was added — the other leaks stay unbaselined')
  rmSync(path.dirname(p), { recursive: true, force: true })
})

// ── The POSITIVE-COUNT floor: the guard must keep MATCHING, not just pass ────

test('[WS-B][floor] a collapsed MATCH set fails, even with an intact file set', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  // Zero observed hits with an intact baseline = the vocabulary / boundary /
  // tokenizer broke. Six guards this round were scoped just narrowly enough to
  // miss what they forbid; "no violations found" is never evidence on its own.
  assert.equal(mod.observationFloorViolations(0, 0, 0).length, 3, 'all three observation floors fire')
  assert.equal(mod.observationFloorViolations(1e6, 1e6, 1e6).length, 0)
  const one = mod.observationFloorViolations(0, 1e6, 1e6)
  assert.equal(one.length, 1)
  assert.match(one[0], /domainNoun/)
  assert.match(one[0], /below the committed floor/)
})

test('[WS-B][floor] the live run is ABOVE every observation floor by a real margin', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { totals, baseline } = mod.runGuard()
  const entries = Object.values(baseline.code).reduce((a, o) => a + Object.keys(o).length, 0)
  // The anchors are the MEASUREMENT, re-taken whenever real fixes land — a lower
  // bound that a legitimate fix pass will eventually cross, at which point it is
  // re-anchored DELIBERATELY (the same discipline as OBSERVATION_FLOORS itself).
  //
  //   2026-07-28 (guard rebuild):        807 noun / 1183 prose / 152 entries
  //   2026-07-28 (post 5-way merge +     549 noun / 1085 prose /  92 entries
  //   baseline reconciliation)           ← the open-axis migration + the two domain
  //                                        strips fixed real leaks; `--prune-baseline`
  //                                        removed 61 entries.
  //   2026-07-28 (post 11-way round-2    463 noun / 1268 prose /  67 entries
  //   merge + reconciliation)            ← 109 noun hits fixed across ten workstreams
  //                                        (attributed per workstream in the guard's
  //                                        OBSERVATION_FLOORS.domainNoun comment);
  //                                        `--prune-baseline` removed 51 entries and
  //                                        lowered 13. Prose ROSE 1085 -> 1268 because
  //                                        WS-C's widening landed between the two rows,
  //                                        then fell 1398 -> 1268 in this round.
  // Each anchor is ≈2/3 of its measurement, matching OBSERVATION_FLOORS: a tripwire set
  // just under the measurement is what left the Rust twin red from round-1's merge on.
  assert.ok(totals.domainNoun >= 300, `expected >=300 live domain-noun hits, got ${totals.domainNoun}`)
  assert.ok(totals.domainProse >= 840, `expected >=840 live domain-prose hits, got ${totals.domainProse}`)
  assert.ok(entries >= 44, `expected >=44 baselined entries, got ${entries}`)
})

// ── ITEM-37: the guard FAILS CLOSED when its hard-coded scan set collapses ──
// Four live fail-open incidents this round: a guard reported PASS having scanned
// zero files, in the very commit that moved its subject. The floors are committed
// constants, so shrinking coverage requires an explicit, reviewable edit.

test('[acceptance][ITEM-37] FAILS (non-zero) when the scan roots point at a non-existent path', () => {
  withTmp(dir => {
    const roots = JSON.stringify({
      serverModules: path.join(dir, 'no', 'such', 'server'),
      uiSrc: path.join(dir, 'no', 'such', 'ui-src'),
    })
    const env = guardEnv({ LINT_NO_DOMAIN_ROOTS_OVERRIDE: roots })
    const r = spawnSync(process.execPath, [GUARD], { env, encoding: 'utf8' })
    assert.equal(r.status, 1, 'a collapsed scan set is a BROKEN guard, never a pass')
    assert.match(r.stderr, /scan set COLLAPSED/)
    assert.match(r.stderr, /below the committed floor/)
    assert.doesNotMatch(r.stdout, /ZERO domain datatype literals/, 'must not print a PASS line')
  })
})

test('[acceptance][ITEM-37] every scan root has a NONZERO committed floor', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  // WS-C: SEVEN scan roots. WS-R3 §2 adds `serverData` / `feData` / `uiOpenapi` and
  // §4 RETIRES `extraFe` (a presence assertion wearing a floor's clothes — it is now
  // `MUST_SCAN_KEYS`, which names the file that went missing). Every root is floored:
  // a root added without a floor is a root that can silently collapse, which is the
  // exact incident this constant exists for (four live cases).
  // WS-R4 added the four TEST roots. The list is spelled out rather than derived from
  // SCAN_FLOORS on purpose: deriving it would make the test agree with the guard by
  // construction, and this test exists to notice a root that was added WITHOUT a floor.
  const ROOTS = [
    'rust', 'rustRoot', 'buildHelper', 'desktop', 'workbenchFe', 'uiFe', 'packagesFe',
    'serverData', 'feData', 'uiOpenapi',
    'serverTests', 'serverTestsData', 'uiTests', 'uiSpecs',
  ]
  const zeroed = Object.fromEntries(ROOTS.map(r => [r, 0]))
  const violations = mod.floorViolations(zeroed)
  assert.equal(violations.length, ROOTS.length, `all ${ROOTS.length} roots are floored`)
  const huge = Object.fromEntries(ROOTS.map(r => [r, 1e6]))
  assert.equal(mod.floorViolations(huge).length, 0)
  // and the LIVE run clears every one of them.
  const { counts } = mod.defaultScanSet()
  assert.deepEqual(Object.keys(counts).sort(), [...ROOTS].sort(), 'every root reports a count')
  assert.deepEqual(mod.floorViolations(counts), [], 'the live tree clears every floor')
})

// ── TEST-2 (ITEM-1): the `__testutil__` exemption is an EXEMPTION, not a HOLE ──
// Slice A had to land this exemption in the same commit as the move, or the guard
// would have gone red on `demoExtension.ts`'s 4 datatype-id literals. An exemption
// bought that cheaply is worth exactly nothing unless it is NARROW, so both
// directions are asserted: the exempt path passes AND the same literal in a sibling
// non-`__testutil__` file still fails.

// ── WS-R4 — INVERTED, for the same reason as the basename one above ──────────
// This test read "`__testutil__/**` is exempt" and asserted `code === 0`. A DIRECTORY
// exemption is claimable by naming a directory — the identical weakness the guard's own
// WS-B header condemns in the `/gallery/` exemption it removed. WS-R4 retires it; the
// files are SCANNED and their residue is baselined under R4-TESTS-SUPPORT.
test('[WS-R4] RED: `__testutil__/**` is SCANNED — the directory exemption is GONE', () => {
  withTmp(dir => {
    const d = path.join(dir, '__testutil__')
    mkdirSync(d, { recursive: true })
    const f = path.join(d, 'demoExtension.ts')
    // The four datatype-id literals the real `demoExtension.ts` carries.
    writeFileSync(
      f,
      `export const ACCEPTS = ['single-cell/expression', 'embedding', 'clustering', 'metadata-column']\n`,
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1, 'a domain literal can no longer be hidden by naming a directory')
    assert.match(stderr, /single-cell/)
    assert.match(stderr, /\[quoted-id\]\s+clustering/)
  })
})

// Retained as the CONTROL for the pair above: it always failed, and it must still fail,
// so the inversion above is not an artifact of the fixture.
test('[TEST-2][ITEM-1] RED: the SAME literal in a sibling NON-`__testutil__` file still FAILS', () => {
  withTmp(dir => {
    const d = path.join(dir, 'testutil') // one character off — deliberately not the exempt dir
    mkdirSync(d, { recursive: true })
    const f = path.join(d, 'demoExtension.ts')
    writeFileSync(
      f,
      `export const ACCEPTS = ['single-cell/expression', 'embedding', 'clustering', 'metadata-column']\n`,
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1, 'the exemption must be a directory exemption, not a filename exemption')
    assert.match(stderr, /single-cell/)
    assert.match(stderr, /\[quoted-id\]\s+clustering/)
  })
})

test('[WS-R4] the retired directory exemption is retired AT ANY DEPTH', () => {
  withTmp(dir => {
    const deep = path.join(dir, 'core', '__testutil__', 'nested')
    mkdirSync(deep, { recursive: true })
    const f = path.join(deep, 'fakes.ts')
    writeFileSync(f, `export const K = 'clustering'\n`)
    assert.equal(
      runGuard([{ path: f, lang: 'ts' }]).code,
      1,
      'a nested __testutil__ is no more exempt than a top-level one',
    )
  })
})

test('[WS-R4] the retired exemption BRANCHES are absent from the guard SOURCE', () => {
  // Same discipline as the WS-R3 gallery-branch test: an exemption that is "removed" by
  // being made unreachable comes back. Assert the code is GONE from `isExemptFile`, and
  // that the three patterns now live only in `isTestTierFile`, the CLASSIFIER.
  const src = readFileSync(GUARD, 'utf8')
  const exempt = src.split('function isExemptFile(')[1].split('\nfunction ')[0]
  for (const pat of ['test|spec', '__fixtures__', '__testutil__']) {
    assert.ok(
      !exempt.includes(`(${pat})`) && !exempt.includes(`'/${pat}/'`),
      `isExemptFile still branches on ${pat} — the exemption must be RETIRED, not relocated`,
    )
  }
  const classifier = src.split('function isTestTierFile(')[1].split('\nfunction ')[0]
  assert.match(classifier, /test\|spec/, 'the basename glob must survive as a CLASSIFIER')
  assert.match(classifier, /__fixtures__/)
  assert.match(classifier, /__testutil__/)
})

// ── TEST-33 (ITEM-20): the `processor-packages/**` exemption is GONE ──────────
// A relocated-not-eliminated exemption is exactly how domain code hides. ITEM-20
// deleted the branch together with the directory it exempted, so a domain literal
// at that path is now caught like any other.

test('[TEST-33][ITEM-20] RED: a domain literal under `processor-packages/` is now CAUGHT', () => {
  withTmp(dir => {
    const d = path.join(dir, 'processor-packages', 'single-cell')
    mkdirSync(d, { recursive: true })
    const f = path.join(d, 'fieldProviders.ts')
    writeFileSync(f, `export const PRODUCES = ['clustering', 'metadata-column']\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1, 'the ITEM-20 exemption must not have survived its subject')
    assert.match(stderr, /clustering/)
  })
})

test('[TEST-33][ITEM-20] the exemption branch is absent from the guard SOURCE', () => {
  const src = readFileSync(GUARD, 'utf8')
  // The literal must survive only as the explanatory comment recording the removal —
  // never inside an `isExemptFile` return. Assert on the executable code, comments stripped.
  const code = src
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(code, /processor-packages/, 'the exemption branch is still executable code')
  assert.match(src, /ITEM-20/, 'the removal should stay documented so it is not re-added by accident')
})

test('[TEST-33][ITEM-20] the exempted DIRECTORY itself no longer exists', () => {
  assert.equal(
    existsSync(path.join(__dirname, '..', 'src', 'processor-packages')),
    false,
    'ui/src/processor-packages/ was deleted by ITEM-15; the exemption outliving it is the bug',
  )
})

// ── TEST-43 (ITEM-30): the SERVER scan set covers every `modules/**` module ────
// Before ITEM-30 the guard reached 9 of 178 server `.rs` files across 4 of 17
// modules. The assertion is a POSITIVE COUNT of what it now reaches plus a planted
// literal in a module that was PREVIOUSLY UNSCANNED — a "zero violations" line
// against a narrow scan set is the failure mode this round found six times.

test('[TEST-43][ITEM-30] the server scan set reaches every `server/src/modules/**` module', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { counts, set } = mod.defaultScanSet()
  const serverRoot = path.resolve(__dirname, '..', '..', 'server', 'src', 'modules')
  // WS-C: `lang === 'rust'` now also covers `server/src/*.rs`, `build_helper/**`
  // and `desktop/**`, so scope this assertion to the `modules/` root it is about.
  const scanned = set
    .filter(e => e.lang === 'rust' && e.path.startsWith(serverRoot + path.sep))
    .map(e => e.path)
  assert.equal(scanned.length, counts.rust)
  // POSITIVE expected count, not "> 0".
  //
  // RE-ANCHORED 160 -> 152 (artifact-model ITEM-12/ITEM-13). This is a re-measurement
  // after a DELETION, not a floor lowered to accommodate a leak — and the arithmetic is
  // written down so the next reader can check it rather than trust it. The branch deleted
  // exactly EIGHT `server/src/modules/**` .rs files and added none (`git ls-tree -r main`
  // 165 -> 157 on disk):
  //     workstore/serve_core.rs                 (ITEM-12, the Selection→Arrow serve core)
  //     workstore/artifact/coo.rs               (ITEM-12)
  //     workstore/artifact/legacy_oracle.rs     (ITEM-12; test-only-declared, so it was
  //                                              never IN this count to begin with)
  //     tiledb_serve/{mod,store,ffi,array_source/mod,array_source/tiledb}.rs  (ITEM-13)
  // The scanned count moved with them to 154, so the floor keeps the SAME ~2-file
  // collapse-detector margin it had before instead of inheriting a permanent red.
  //
  // The load-bearing assertion in this test is the per-module coverage check below
  // (`uncovered` must be empty) — it NAMES what went missing, which a count never can.
  // The count is the coarse belt underneath it and is deliberately kept.
  assert.ok(counts.rust >= 152, `expected ≥152 scanned server .rs files, got ${counts.rust}`)

  // Every module DIRECTORY under `server/src/modules` contributes at least one
  // scanned file — the pre-ITEM-30 state was 4 of 17, which a "zero violations"
  // report could not distinguish from compliance.
  const modules = readdirSync(serverRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
  assert.ok(modules.length >= 14, `expected ≥14 server modules, found ${modules.length}`)
  // RE-ANCHORED 16 -> 15 (artifact-model ITEM-13 deleted `tiledb_serve`), then 15 -> 16
  // (increment-1 added the `drafts` module — the draftable-entity primitive that freezes a
  // curated draft into an immutable artifact), then 16 -> 17 on this merge (the accounts epic
  // A1 added the `account` module), then 17 -> 18 (the billing epic B2 added the `billing`
  // module — the self-serve Stripe payments layer, `#[cfg(feature = "saas")]`-gated). Bumped
  // in lockstep with the Rust twin's `EXPECT_MODULES`. Exact, not `>=`, in BOTH directions: a
  // NEW module must be consciously admitted, and a DELETED one consciously retired.
  //   18 -> 20 (#40): +2. The admin-authz-foundation merge (#31/#32) added the `admin` module
  //   but did NOT bump this assert (base main sits at 19 dirs against a stale 18), and the
  //   feature-flags epic (#40) adds the `features` module (the runtime feature-flags subsystem).
  //   Both are consciously admitted here: admin (the missed +1) and features (+1) = 20.
  assert.equal(modules.length, 20, 'the module count is a POSITIVE expectation: a new module must be consciously admitted, and a deleted one consciously retired')
  const covered = new Set(
    scanned
      .map(p => path.relative(serverRoot, p).split(path.sep)[0])
      .filter(n => modules.includes(n)),
  )
  const uncovered = modules.filter(m => !covered.has(m))
  assert.deepEqual(uncovered, [], `these server modules are outside the guard's reach: ${uncovered}`)
})

test('[TEST-43][ITEM-30] RED: a planted literal in a PREVIOUSLY-UNSCANNED module FAILS', () => {
  // `project/` was one of the 13 modules the pre-ITEM-30 scan set never reached.
  const r = plantInCopyOfReal(
    'server/src/modules/project/mod.rs',
    '\npub const PLANTED_FOR_TEST: &str = "single-cell/expression";\n',
  )
  assertPlantDetected(
    r,
    [/project\/mod\.rs/, /\[substring\]\s+single-cell/],
    'a domain literal in `project/` must fail the guard on that module\'s real scan entry',
  )
})

// ══ WS-C (2026-07-28): the scan set is now THE TREE ═════════════════════════
// A fifth blind spot §0 did not name: the SCAN SET itself. The guard covered 353
// files — under half the codebase. Everything below is the negative control for
// one newly-covered root, or for a way the widening could be undone.

test('[WS-C][roots] every NEW root is really scanned — a planted noun FAILS in each', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set } = mod.defaultScanSet()
  const inSet = rel => set.some(e => e.path.replace(/\\/g, '/').endsWith(rel))
  // The roots the pre-WS-C guard could not see, each pinned by a REAL file.
  for (const rel of [
    'server/src/main.rs', // rustRoot
    'server/src/lib.rs', // rustRoot
    'server/build_helper/sandbox_rootfs.rs', // buildHelper
    'desktop/tauri/src/lib.rs', // desktop
    'ui/src/api-client/types.ts', // uiFe
    // RE-POINTED (artifact-model ITEM-24). This named `core/workstore/arrowClient.ts`
    // until ITEM-24 removed `apache-arrow`/`zarrita` and the Arrow client with them; the
    // witness went missing and this check fired, which is what it is for. The successor
    // is the module BARREL, not the file that replaced arrowClient: the reader
    // implementation under `core/workstore/` is exactly the churning surface ITEM-23/29
    // is rewriting, and pinning a witness to it would make this test hostage to that
    // churn. `index.ts` is the stable identity of that root.
    'ui/src/core/workstore/index.ts', // uiFe
    'libs/dock/src/containers.ts', // packagesFe
  ]) {
    assert.ok(inSet(rel), `${rel} must be in the scan set — that root is the point of WS-C`)
  }
})

test('[WS-C][roots] a planted domain noun in a NEW root FAILS on its REAL scan entry', () => {
  // A live production file in `server/src/*.rs` — the root that carries `main.rs`
  // and `lib.rs` and was outside every guard in the tree. `database.rs` is also the
  // file that documents the sqlx migration-checksum contract, which is why r20 stopped
  // this suite from ever writing to it (R20 §1).
  const r = plantInCopyOfReal('server/src/database.rs', `\npub const PLANTED_N_CELLS: usize = 5000;\n`)
  assertPlantDetected(
    r,
    [/database\.rs/, /\[domain-noun\]\s+CELLS/],
    'a planted noun in `server/src/*.rs` must FAIL on that root\'s real scan entry',
  )
})

// ── The `libs/viz` CARVE-OUT: by construction, and it cannot spread ──────

test('[WS-C][carve-out] `libs/viz` is absent from the scan set BY CONSTRUCTION', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set } = mod.defaultScanSet()
  const viz = set.filter(e => e.path.replace(/\\/g, '/').includes('/libs/viz/'))
  assert.deepEqual(viz, [], 'libs/viz is an owner-decision carve-out this round')
  // …and it is a HAND-LISTED allowlist, not a walk-with-a-skip-filter: there is no
  // exclusion regex to widen. The source must name the packages it DOES scan.
  const src = readFileSync(GUARD, 'utf8')
  assert.match(src, /const SCANNED_PACKAGES = \['dock'\]/)
  // The cost must be WRITTEN DOWN next to the decision, with numbers.
  assert.match(src, /62 library-core \+ 144 showcase domain tokens invisible|62 true-domain tokens in the library CORE/)
})

test('[WS-C][carve-out] an UNDECLARED package FAILS — the carve-out cannot acquire company', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  // `viz` is DECLARED unscanned, so it does not violate; an invented one does.
  assert.deepEqual(mod.packageDeclarationViolations(), [], 'the live tree declares every package')
  // R20 §1 — the invented package is created in a TEMP `packages` root reached through
  // `ROOTS_OVERRIDE`, not by `mkdir src-app/libs/__wsc_planted_pkg__` in the working
  // tree. Both halves of the original assertion survive: the exported checker names it,
  // and the whole guard fails on it.
  withTmp(dir => {
    mkdirSync(path.join(dir, '__wsc_planted_pkg__', 'src'), { recursive: true })
    writeFileSync(path.join(dir, '__wsc_planted_pkg__', 'src', 'a.ts'), 'export const x = 1\n')
    const v = guardExportUnderRoots({ packages: dir }, 'm.packageDeclarationViolations()')
    assert.equal(v.length, 1, 'a package that is neither scanned nor documented must be reported')
    assert.match(v[0], /__wsc_planted_pkg__ is neither in SCANNED_PACKAGES nor in UNSCANNED_PACKAGES/)
    const r = spawnSync(process.execPath, [GUARD], {
      env: guardEnv({ LINT_NO_DOMAIN_ROOTS_OVERRIDE: JSON.stringify({ packages: dir }) }),
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /an UNDECLARED package/)
    assert.match(r.stderr, /packages\/__wsc_planted_pkg__ is neither in SCANNED_PACKAGES/)
  })
})

// ── The WS-C vocabulary: the acronym tier + the ALL-CAPS false-positive class ─

test('[WS-C][vocabulary] the ACRONYM tier catches `DE`/`QC`/`BAM` but not `DERIVED`/`DEC-5`', () => {
  withTmp(dir => {
    const f = path.join(dir, 'acronyms.ts')
    // LEFT column = must MATCH; RIGHT column = must NOT (the 1575-hit noise the
    // ordinary letter+camel boundary produced for `DE` alone).
    writeFileSync(
      f,
      [
        'const a = 1 // a two-axis DE table',
        'const b = 2 // a QC metric column',
        'const c = 3 // Zarr chunk-dir / BAM+bai',
        'const d = 4 // DERIVED DESIGN DEFAULT DELETE DEC-5 DEBUG',
        'const e = 5 // QCONTEXT BAMBOO DECLARATIVE',
      ].join('\n'),
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1)
    const hits = stderr.split('\n').filter(l => /\[domain-prose\]/.test(l))
    const toks = hits.map(l => l.trim().split(/\s+/).pop()).sort()
    assert.deepEqual(toks, ['BAM', 'DE', 'QC'], `expected exactly DE/QC/BAM, got ${toks}`)
    assert.doesNotMatch(stderr, /:4:/, 'line 4 is all-caps English, not vocabulary')
    assert.doesNotMatch(stderr, /:5:/, 'line 5 embeds the acronyms in longer words')
  })
})

test('[WS-C][vocabulary] the new nouns fire, incl. `tiledbsoma` and `vis2D` (E6\'s literal)', () => {
  withTmp(dir => {
    const f = path.join(dir, 'nouns.ts')
    writeFileSync(
      f,
      `export const P = [tiledbsoma, vis2D, pct_mito, scanpy, seurat, mtx, h5mu, transcriptome, GRCh38, enrichment]\n`,
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1)
    for (const t of ['tiledbsoma', 'vis2D', 'pct_mito', 'scanpy', 'seurat', 'mtx', 'h5mu', 'transcriptome', 'GRCh38', 'enrichment']) {
      assert.match(stderr, new RegExp(`\\[domain-noun\\]\\s+${t}`, 'i'), `${t} must be in the vocabulary`)
    }
    // `tiledbsoma` specifically: `soma` alone CANNOT see it (the left boundary
    // refuses a lowercase neighbour), which is why it needed its own entry.
    assert.equal((stderr.match(/tiledbsoma/g) ?? []).length, 1, 'counted ONCE, not as soma + tiledbsoma')
  })
})

test('[WS-C][vocabulary] ALL-CAPS `GENERIC`/`OBSERVED`/`SOMATIC` are suppressed STRUCTURALLY', () => {
  withTmp(dir => {
    const f = path.join(dir, 'caps.ts')
    writeFileSync(
      f,
      [
        '// GENERIC OBSERVED SOMATIC GENERATOR DEGENERATE OBSOLETE', // must NOT fire
        'const g = GENERIC_CELL_CAP', // MUST fire: the identifier is not one of them
      ].join('\n'),
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'ts', nouns: true }])
    assert.equal(code, 1, 'the second line is a real domain identifier')
    assert.doesNotMatch(stderr, /:1:/, 'ALL-CAPS English is a DIFFERENT WORD, not an ambiguous one')
    assert.match(stderr, /:2:\d+\s+\[domain-noun\]\s+CELL/, 'a domain noun inside a non-listed identifier still fires')
  })
})

// ── The `literals` tier: shrink-only, and it does not become an escape hatch ──

test('[WS-C][literals] the tier is recorded, capped, and every entry names a finding', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { literals } = mod.loadBaseline()
  const entries = Object.entries(literals).flatMap(([f, t]) => Object.entries(t).map(([k, s]) => [f, k, s]))
  // WS-C recorded THREE (the `main.rs` `--help` blurb ×1, the `env-rootfs/single-cell/`
  // build path ×2) and asserted `entries.length > 0` so that recording zero could not be
  // a lie. ROUND 2 actually FIXED all three — WS-E removed the `--help` clause, WS-I made
  // the rootfs paths build INPUTS — so the honest assertion inverts: the tier is EMPTY and
  // the ceiling is 0. A witness for an empty tier would be a permanently-failing test.
  let hits = 0
  for (const [f, tok, spec] of entries) {
    assert.ok(spec.finding, `literals[${f}][${tok}] must name a finding`)
    assert.ok(typeof spec.note === 'string' && spec.note.length > 10, `literals[${f}][${tok}] needs a note`)
    hits += spec.count
  }
  // WS-R3: the tier is NOT empty and never was — 0 was an artifact of the three
  // things the guard refused to read. 69 hits in 8 files, led by `data_api.rs` (23,
  // §1), `datasets/gallery.tsx` (13, §4) and the SHIPPED `ui/openapi/openapi.json`
  // (12, §2). Recorded here, fixed by sibling rounds; the tier stays shrink-only.
  assert.ok(hits > 0, 'the literal tier is live — recording zero must not be a lie')
  // ROUND 4 — the SHIPPED-contract witness INVERTS. r4spec fixed all 12 openapi.json
  // literals at their Rust source (25 doc-comments) and regenerated, and r4dataapi took
  // `data_api.rs` from 23 to 0, so the two headline sites are CLEAN. A witness that
  // asserts a fixed leak still exists is a test certifying a bug; the honest form of the
  // same check is the inverse, which is also a real regression guard: if a domain
  // datatype id ever re-enters the shipped API contract, THIS fires.
  // WS-R5 — RESTATED, because the claim it made was FALSE and passing.
  //
  // It asserted the shipped contract carries NO domain datatype literal, "r4spec took it to
  // zero". r4spec did take the twelve literals it could SEE to zero; three more were there
  // the whole time and no enforcer could see them, because `annotation-table` is contributed
  // by `anndata-import` — a package absent from the 16-id hand-list the vocabulary used to
  // be. This is the third case this effort has found of a passing test certifying a defect,
  // and it is the same shape as the other two: the assertion was true of the guard's model,
  // not of the tree.
  //
  // The honest form keeps the regression property that made the original worth having: the
  // shipped contract may carry EXACTLY the recorded R5-G2-SPEC residue and nothing else, so
  // a new domain datatype id entering the contract still fails HERE and names itself.
  const spec = literals['ui/openapi/openapi.json'] ?? {}
  assert.deepEqual(
    Object.keys(spec).sort(),
    ['annotation-table'],
    'the SHIPPED contract may carry ONLY the recorded R5-G2-SPEC residue — a NEW domain ' +
      'datatype id in the contract must fail here',
  )
  assert.equal(spec['annotation-table'].finding, 'R5-G2-SPEC')
  assert.equal(spec['annotation-table'].count, 3)
  assert.ok(
    !Object.keys(literals).some(f => f.endsWith('workstore/data_api.rs')),
    'the debug-seed surface must carry NO domain datatype literal (r4dataapi took it to zero)',
  )
  // …but the tier must still have live SITES, or `hits > 0` could be one stale entry.
  assert.ok(
    Object.keys(literals).length >= 4,
    'the literal tier still records several distinct sites — it has not collapsed to a stub',
  )
  // The ceiling must equal the CURRENT measurement — slack here is room for a new
  // hardcoded id. At zero, the NEXT literal cannot be baselined without raising it.
  assert.match(readFileSync(GUARD, 'utf8'), new RegExp(`const LITERAL_HITS_CEILING = ${hits}\\b`),
    'the ceiling must equal the CURRENT measurement — slack here is room for a new hardcoded id')
})

test('[WS-C][literals] a NEW literal FAILS even with the ceiling raised', () => {
  // Raising LITERAL_HITS_CEILING is an admission, not a bypass: the per-(file,token)
  // baseline is what actually filters, so an UNRECORDED literal still fails.
  withTmp(dir => {
    const f = path.join(dir, 'leak.rs')
    writeFileSync(f, `const P: &str = "single-cell/soma";\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1)
    assert.match(stderr, /\[substring\]\s+single-cell/)
  })
})

// ── RESIDUE is RETIRED ──────────────────────────────────────────────────────

test('[WS-C][triage] no entry is tagged RESIDUE, and re-introducing the tag FAILS', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const bl = mod.loadBaseline()
  const residue = [
    ...Object.entries(bl.code).flatMap(([f, t]) => Object.entries(t).filter(([, s]) => s.finding === 'RESIDUE').map(([k]) => `code[${f}][${k}]`)),
    ...Object.entries(bl.prose).filter(([, s]) => typeof s !== 'number' && s.finding === 'RESIDUE').map(([f]) => `prose[${f}]`),
  ]
  assert.deepEqual(residue, [], 'the untriaged bucket is empty — all nine entries were given a disposition')
  // And it cannot refill: the tag is rejected outright.
  const tainted = JSON.parse(JSON.stringify({ code: bl.code, prose: bl.prose, literals: bl.literals }))
  const [file, toks] = Object.entries(tainted.code)[0]
  const tok = Object.keys(toks)[0]
  tainted.code[file][tok].finding = 'RESIDUE'
  const { code, stderr } = runWithBaseline(tainted)
  assert.equal(code, 1)
  assert.match(stderr, /tagged RESIDUE — that tag is RETIRED/)
  assert.match(stderr, /Give this entry a real disposition/)
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R3 — UN-GAMEABILITY: a plant in REAL content (R20 §1: in a copy of it)
// ════════════════════════════════════════════════════════════════════════════
//
// Round 2 set the bar: a new capability is only real if a leak PLANTED in real
// production CONTENT goes red, and removing it goes green again. Fixture-level tests
// prove the tokenizer; these prove the WALK, the ROOTS and the RATCHET.
//
// R20 §1 — the content is real, the FILE WRITTEN TO is a copy under `os.tmpdir()`.
// See the `plantInCopyOfReal` header for what that keeps (the scan-set entry, the
// language dispatch, the real bytes) and what it adds (a control run, so a target
// that already carries findings cannot pass the test by itself).

/** Plant `extra` at the end of a COPY of a REAL tree file and assert it is caught. */
function plantInReal(relFromSrcApp, extra, patterns, why) {
  assertPlantDetected(plantInCopyOfReal(relFromSrcApp, extra), patterns, why)
}

test('[WS-R3][§1][un-gameable] a leak planted in a REAL `#[cfg(debug_assertions)]` block FAILS', () => {
  // `workstore/routes.rs` registers its six debug routes under the attribute. Before
  // WS-R3 this plant was invisible: the whole item block was blanked before matching.
  plantInReal(
    'server/src/modules/workstore/routes.rs',
    '\n#[cfg(debug_assertions)]\npub const R3_PLANTED: &str = "single-cell/atac";\n',
    [/workstore\/routes\.rs/, /\[substring\]\s+single-cell/],
    'a literal under #[cfg(debug_assertions)] must fail',
  )
})

test('[WS-R3][§2][un-gameable] a leak planted in a REAL `.sql` migration FAILS', () => {
  // ROUND 4 — re-pointed. r4squash collapsed the 49 module-local migrations into 8
  // per-module baselines, so `202607190001_jobs_jobs.sql` no longer exists. The subject
  // of this test is the FORMAT, not the file, so it moves to the surviving baseline.
  //
  // R20 §1 — this target is why "restore in a `finally`" was not good enough: an
  // APPLIED migration's bytes are checksummed by `sqlx::migrate!`, so a plant that
  // outlived the process would be rejected at every subsequent boot.
  plantInReal(
    'server/src/modules/jobs/migrations/202608030001_jobs_baseline.sql',
    "\nCREATE INDEX r3_planted ON jobs ((payload->>'single-cell/anndata'));\n",
    [/202608030001_jobs_baseline\.sql/, /\[substring\]\s+single-cell/],
    '.sql is embedded + run at boot; a domain id there ships',
  )
})

test('[WS-R3][§2][un-gameable] a leak planted in a REAL `include_str!`-ed `.py` driver FAILS', () => {
  plantInReal(
    'server/src/modules/workstore/seed_multimodal.py',
    '\nR3_PLANTED = "single-cell/protein"\n',
    [/seed_multimodal\.py/, /\[substring\]\s+single-cell/],
    'the seed drivers are include_str!-ed AND executed',
  )
})

test('[WS-R3][§2][un-gameable] a leak planted in a REAL `.json` manifest FAILS', () => {
  plantInReal(
    'server/src/modules/mcp/frontend-actions.json',
    '\n{"r3_planted": "single-cell/multimodal"}\n',
    [/frontend-actions\.json/, /\[substring\]\s+single-cell/],
    'an embedded action manifest is shipped data',
  )
})

test('[WS-R3][§2][un-gameable] a leak in a REAL `ui/openapi/openapi.json` FAILS (shipped contract)', () => {
  // R20 §1 — planting here USED to make the committed contract unparseable for ~1.9s
  // of every gate run, which is what took `src/api-client/regen.test.ts` (same
  // `node --test` batch, parallel by default) to 1 pass / 5 fail on demand.
  plantInReal(
    'ui/openapi/openapi.json',
    '\n"r3_planted": "single-cell/counts"\n',
    [/openapi\.json/, /\[substring\]\s+single-cell/],
    'the SHIPPED contract is generated — nobody types it, nobody reads it',
  )
})

test('[WS-R3][§2][un-gameable] a NEW `.yaml` dropped into a scanned root is scanned', () => {
  // There is no non-exempt `.yaml` in the tree today, so the walk has to be shown a
  // new one. R20 §1 — it is shown one in a TEMP TREE, via the `ROOTS_OVERRIDE` seam
  // the guard documents for exactly this ("point the REAL scan-set discovery at a
  // temp tree"), instead of creating `ui/src/r3-planted-probe.yaml` in the working
  // tree. Two halves, because they are two claims:
  //   (a) the WALK admits `.yaml` under the `ui/src` roots — asserted on the resolved
  //       scan set, with a `.txt` sibling as the negative control (an extension the
  //       policy does NOT admit must stay out, or "it walked it" means nothing).
  //   (b) a domain id inside such a file FAILS — asserted by scanning it.
  withTmp(dir => {
    const yaml = path.join(dir, 'r3-planted-probe.yaml')
    const txt = path.join(dir, 'r3-planted-probe.txt')
    const body = '# a comment\nkind: single-cell/soma\n'
    writeFileSync(yaml, body)
    writeFileSync(txt, body)
    const walked = guardExportUnderRoots({ uiSrc: dir }, 'm.defaultScanSet().set.map(e => e.path)')
    assert.ok(walked.includes(yaml), `a .yaml under ui/src must be walked, got:\n${walked.join('\n')}`)
    assert.ok(!walked.includes(txt), 'the control: `.txt` is in no extension policy and stays out')
    const { code, stderr } = runGuard([{ path: yaml, lang: 'yaml' }])
    assert.equal(code, 1, 'a .yaml under ui/src must be scanned like any other data file')
    assert.match(stderr, /r3-planted-probe\.yaml/)
    assert.match(stderr, /\[substring\]\s+single-cell/)
  })
})

test('[WS-R3][§3][un-gameable] each of the five NEW tokens fires in REAL production content', () => {
  // One planted line per token, appended to the real `ui/src` file's real bytes — in a
  // copy (R20 §1), scanned through that file's own entry in the real scan set.
  const plants = [
    ['pct_ribo', 'export const R3_A = { pct_ribo: 0 }\n'],
    ['ncount', 'export const R3_B = { nCount: 0 }\n'],
    ['ident', "export const R3_C = ['ident']\n"],
    ['10x', "export const R3_D = 'strip_10x_suffix'\n"],
    ['pbmc', 'export const R3_E = "PBMC_donor"\n'],
  ]
  for (const [tok, line] of plants) {
    plantInReal(
      'ui/src/core/datatypes/builtin.ts',
      `\n${line}`,
      [/builtin\.ts/, new RegExp(`\\[domain-noun\\]\\s+${tok}`, 'i')],
      `the token \`${tok}\` must fire`,
    )
  }
})

test('[WS-R3][§3] `ident` does NOT claim `identity` / `IDENTICAL` / a Rust macro fragment', () => {
  withTmp(dir => {
    const rs = path.join(dir, 'macros.rs')
    writeFileSync(
      rs,
      [
        '// A comment about IDENTICAL bytes and case IDENTITY.',
        'macro_rules! perm { ($ident:ident, $name:literal) => { pub struct $ident; }; }',
        'macro_rules! dt { ($static:ident, $ctor:ident, $validate:ident) => {}; }',
        'pub fn f(identifier: &str, identity: u8) -> bool { identifier.is_empty() && identity == 0 }',
      ].join('\n') + '\n',
    )
    const { code, stderr } = runGuard([{ path: rs, lang: 'rust', nouns: true }])
    assert.equal(code, 0, `\`ident\` must not claim language syntax or English:\n${stderr}`)
  })
  withTmp(dir => {
    // ...and the DOMAIN uses are still caught, in both dialects.
    const rs = path.join(dir, 'real.rs')
    writeFileSync(rs, 'let cols = vec!["ident", "nCount"];\n')
    const r = runGuard([{ path: rs, lang: 'rust', nouns: true }])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /\[domain-noun\]\s+ident/i)
    assert.match(r.stderr, /\[domain-noun\]\s+nCount/i)
  })
})

test('[WS-R3][§3] `10x` gets a DIGIT-initial left boundary — `110x` is not a hit', () => {
  withTmp(dir => {
    const f = path.join(dir, 'v.ts')
    writeFileSync(f, 'export const V = { a: 110, b: "v110x", c: 1110 }\n')
    assert.equal(runGuard([{ path: f, lang: 'ts', nouns: true }]).code, 0)
    writeFileSync(f, 'export const V = "10x_barcode"\n')
    assert.equal(runGuard([{ path: f, lang: 'ts', nouns: true }]).code, 1)
  })
})

// ── THE NEGATIVE CONTROL for §4: the prose token SWAP ────────────────────────

test('[WS-R3][§4][negative-control] a prose token SWAP at the SAME count now FAILS', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const bl = JSON.parse(JSON.stringify({ code: real.code, prose: real.prose, literals: real.literals }))

  // Pick a real, multi-token prose entry and MOVE budget from one recorded token to
  // another, keeping the FILE TOTAL byte-identical. Under the retired per-file-total
  // ratchet this passed — that is exactly how 1268 fungible hits could absorb a
  // brand-new leak. Under per (file, token) it must fail, and it must fail by naming
  // the token whose real count now exceeds its budget.
  const [file, spec] = Object.entries(bl.prose).find(
    ([, v]) => Object.keys(v.tokens).length >= 2 && Object.values(v.tokens).every(n => n >= 1),
  )
  const [tokA, tokB] = Object.keys(spec.tokens)
  const before = Object.values(spec.tokens).reduce((a, b) => a + b, 0)
  spec.tokens[tokA] += 1
  spec.tokens[tokB] -= 1
  if (spec.tokens[tokB] === 0) delete spec.tokens[tokB]
  const after = Object.values(spec.tokens).reduce((a, b) => a + b, 0)
  assert.equal(after, before, 'the swap must keep the FILE TOTAL identical — that is the point')

  const { code, stderr } = runWithBaseline(bl)
  assert.equal(code, 1, `a same-total token swap in ${file} must FAIL now`)
  // It fails as STALE on the inflated token (its budget can no longer be satisfied)
  // AND/OR as an unbaselined finding on the deflated one. Either way the TOKEN is named,
  // which is precisely what a per-file total could never do.
  assert.match(stderr, new RegExp(`${tokA}|${tokB}`))
  assert.match(stderr, /STALE|domain finding\(s\) outside the committed baseline/)
})

test('[WS-R3][§4][negative-control] the SAME swap was invisible to the retired per-file form', async () => {
  // The positive control for the test above: the retired shape is now REJECTED, so
  // the hole cannot be re-opened by writing the old spelling back into the ledger.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const bl = JSON.parse(JSON.stringify({ code: real.code, prose: real.prose, literals: real.literals }))
  const [file, spec] = Object.entries(bl.prose)[0]
  bl.prose[file] = Object.values(spec.tokens).reduce((a, b) => a + b, 0)
  const { code, stderr } = runWithBaseline(bl)
  assert.equal(code, 1)
  assert.match(stderr, /RETIRED per-file-total form/)
})

// ── §4: MUST_SCAN_KEYS — a per-root production-file witness ──────────────────

test('[WS-R3][§4] MUST_SCAN_KEYS names the missing file when a root stops being walked', async () => {
  const mod = await import(`${GUARD}?ws-r3-mustscan`)
  const { set } = mod.defaultScanSet()
  assert.deepEqual(mod.mustScanViolations(set), [], 'the live tree reaches every pinned witness')
  // Drop the pinned witnesses one at a time: each must be reported BY NAME.
  for (const key of [
    'server/src/main.rs',
    'server/build_helper/sandbox_rootfs.rs',
    'ui/openapi/openapi.json',
    // WS-R4 RE-ANCHORED: `seed_multimodal.py` was here and is no longer a witness — it is
    // `include_str!`-ed only by the six `#[cfg(debug_assertions)]` routes in
    // `workstore/data_api.rs`, which are under active review for deletion, and a liveness
    // witness an unrelated round can delete turns this gate red for a non-domain reason.
    'server/src/modules/mcp/frontend-actions.json',
    'ui/src/core/datatypes/builtin.ts',
    // …and one witness per WS-R4 TEST root, so the same drop-one-at-a-time proof covers
    // the roots this round added.
    'server/tests/integration_tests.rs',
    'server/tests/dataset/fixtures/make_mtx_trio.py',
    'ui/tests/e2e/datatype/registry.spec.ts',
    'ui/src/modules/workbench/core/__testutil__/fakes.ts',
  ]) {
    const pruned = set.filter(e => mod.baselineKey(e.path) !== key)
    const v = mod.mustScanViolations(pruned)
    assert.equal(v.length, 1, `dropping ${key} must produce exactly one violation`)
    assert.match(v[0], new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

// ── ROUND 4: the PER-FORMAT pin ─────────────────────────────────────────────
//
// `MUST_SCAN_KEYS` pins a FILE, which is why WS-R4 had to de-anchor the `.py` witness
// (its only two candidates were deletable) and why r4squash broke the `.sql` one by
// deleting the migration it named. `FORMAT_COVERAGE_PINS` pins the FORMAT instead, so
// it survives both. These two tests are the RED and the GREEN of that claim.

test('[R4][format] a root that stops covering a FORMAT fails and NAMES the format', async () => {
  const mod = await import(`${GUARD}?r4-formatpins`)
  const { set } = mod.defaultScanSet()
  assert.deepEqual(
    mod.formatCoveragePinViolations(set),
    [],
    'the live tree covers every pinned (root, format)',
  )
  // Simulate exactly the failure a per-FILE witness cannot see: the extension policy
  // (or an exemption) silently stops covering a format, while every pinned FILE of the
  // OTHER formats is still reached, so `mustScanViolations` stays green.
  for (const ext of ['.py', '.sql', '.json']) {
    const pruned = set.filter(e => !e.path.endsWith(ext))
    const v = mod.formatCoveragePinViolations(pruned)
    assert.equal(v.length, 1, `dropping every ${ext} must produce exactly one violation`)
    assert.match(v[0], new RegExp(`"\\${ext}" file`), `the violation must name ${ext}`)
    assert.match(v[0], /serverData/)
  }
})

test('[R4][format] the pin goes VACUOUS, not red, when the last file of a format is gone', async () => {
  // WS-R5 §5 — REWRITTEN. This used to assert a REGEX OVER THE GUARD'S OWN SOURCE TEXT
  // (`/if \(present\.length === 0\) continue \/\/ vacuous by design/`) — i.e. it checked
  // that a comment was still present, which any refactor of the branch breaks and any
  // BREAKAGE of the branch survives, as long as the comment stays. The property it names
  // ("a deletion makes the pin vacuous, not red") is directly executable: point the probe
  // dirs at a tree that has `.sql` + `.json` but NO `.py`, and watch which pins fire.
  //
  // Driven through the REAL root discovery, because `FORMAT_COVERAGE_PINS` closes over
  // `SERVER_SRC` / `BUILD_HELPER` at module scope — so the env has to be set BEFORE the
  // import, and the import needs a fresh cache key.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-vacuous-'))
  const prev = process.env.LINT_NO_DOMAIN_ROOTS_OVERRIDE
  const prevSelf = process.env.LINT_NO_DOMAIN_SELFTEST
  try {
    const sql = path.join(dir, 'a.sql')
    const json = path.join(dir, 'b.json')
    writeFileSync(sql, 'SELECT 1;\n')
    writeFileSync(json, '{"x":1}\n')
    // NB: no `.py` anywhere under `dir`.
    process.env.LINT_NO_DOMAIN_SELFTEST = '1'
    process.env.LINT_NO_DOMAIN_ROOTS_OVERRIDE = JSON.stringify({ serverSrc: dir, buildHelper: dir })
    const mod = await import(`${GUARD}?r5-formatpins-vacuous-${Date.now()}`)

    // 1. VACUITY: with both present formats REACHED, the `.py` pin — whose probe finds
    //    nothing on disk — contributes nothing. This is the property that makes deleting
    //    the last file of a format SAFE, and it is now asserted as behaviour.
    const reached = mod.formatCoveragePinViolations([{ path: sql }, { path: json }])
    assert.deepEqual(reached, [], `a probe with no .py on disk must say NOTHING, got: ${reached}`)

    // 2. …and vacuity is NOT indifference. With the walk reaching nothing, the two formats
    //    that DO exist on disk fire, and the absent one still does not. A check that went
    //    quiet for every format would pass assertion 1 too; this is what separates them.
    const none = mod.formatCoveragePinViolations([])
    assert.equal(none.length, 2, `exactly the two PRESENT formats must fire, got: ${none}`)
    assert.ok(none.some(m => m.includes('".sql" file')), 'the .sql pin must fire')
    assert.ok(none.some(m => m.includes('".json" file')), 'the .json pin must fire')
    assert.ok(!none.some(m => m.includes('".py" file')), 'the .py pin must stay VACUOUS')
  } finally {
    if (prev === undefined) delete process.env.LINT_NO_DOMAIN_ROOTS_OVERRIDE
    else process.env.LINT_NO_DOMAIN_ROOTS_OVERRIDE = prev
    if (prevSelf === undefined) delete process.env.LINT_NO_DOMAIN_SELFTEST
    else process.env.LINT_NO_DOMAIN_SELFTEST = prevSelf
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[WS-R3][§4] every scan FLOOR keeps a real collapse-detector margin', async () => {
  const mod = await import(`${GUARD}?ws-r3-floors`)
  const { counts } = mod.defaultScanSet()
  // The round-2 defect: seven of eight floors sat AT or ONE BELOW the measurement, so
  // deleting one legitimate file turned the gate red and the only response was to edit
  // the constant. A floor is a collapse detector, not a tripwire — so for every root
  // with a non-trivial count the floor must leave room for a real deletion.
  const src = readFileSync(GUARD, 'utf8')
  const block = src.split('const SCAN_FLOORS = {')[1].split('\n}')[0]
  for (const [root, got] of Object.entries(counts)) {
    const m = block.match(new RegExp(`\\b${root}:\\s*(\\d+)`))
    assert.ok(m, `${root} has no committed floor`)
    const floor = Number(m[1])
    assert.ok(floor <= got, `${root}: floor ${floor} exceeds the live count ${got}`)
    if (got >= 5) {
      assert.ok(
        floor <= Math.ceil(got * 0.72),
        `${root}: floor ${floor} against a measurement of ${got} is a TRIPWIRE, not a collapse ` +
          `detector — the next legitimate deletion breaks it. Keep the ≈2/3 margin.`,
      )
    }
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R4 — the TEST TREES
// ════════════════════════════════════════════════════════════════════════════
//
// `server/tests/**` and `ui/tests/**` were in NO scan root at all — not blanked,
// never walked. These tests hold the four new roots open, hold the tier split
// apart, and pin the exact-cardinality ledger.

test('[WS-R4][roots] the real scan set REACHES all four TEST roots', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set, counts } = mod.defaultScanSet()
  const keys = new Set(set.map(e => mod.baselineKey(e.path)))
  for (const root of ['serverTests', 'serverTestsData', 'uiTests', 'uiSpecs']) {
    assert.ok(counts[root] > 0, `root ${root} resolved to ZERO files — it is not being walked`)
  }
  // One real, load-bearing file per root, by name — a count alone cannot say WHICH.
  for (const k of [
    'server/tests/integration_tests.rs',
    'server/tests/datatype/mod.rs',
    'server/tests/fixtures/processor_manifest_lint/ok/goodpkg/manifest.yaml',
    'server/tests/dataset/fixtures/make_mtx_trio.py',
    'ui/tests/e2e/datatype/registry.spec.ts',
    'ui/tests/e2e/datatype/sniff.spec.ts',
    'ui/src/modules/workbench/core/__testutil__/fakes.ts',
    'ui/src/modules/workbench/core/runtime/qcSurface.test.ts',
  ]) {
    assert.ok(keys.has(k), `the scan set does not reach ${k}`)
  }
})

test('[WS-R4][roots] EVERY root — production and test — has a MUST_SCAN witness', async () => {
  // `floorViolations` proves a root found SOMETHING; only a named witness proves it
  // found the RIGHT something. A new root added without a witness could silently
  // degrade to a no-op walk over a renamed directory and still clear a low floor.
  const src = readFileSync(GUARD, 'utf8')
  const floors = Object.keys(
    Object.fromEntries(
      [...src.split('const SCAN_FLOORS = {')[1].split('\n}')[0].matchAll(/^\s*(\w+):\s*\d+,/gm)].map(
        m => [m[1], 1],
      ),
    ),
  )
  const witnessed = new Set(
    [...src.split('const MUST_SCAN_KEYS = [')[1].split('\n]')[0].matchAll(/\[\s*'(\w+)'/g)].map(
      m => m[1],
    ),
  )
  for (const root of floors) {
    assert.ok(witnessed.has(root), `scan root "${root}" has a floor but NO MUST_SCAN witness`)
  }
})

test('[WS-R4][roots] a per-root NO-OP walk FAILS — every test root fails closed', async () => {
  // The un-gameability property: pointing a root at an empty tree must not pass
  // vacuously. Driven through the REAL root-discovery via the roots override.
  //
  // WS-R5 §5 — this used to cover TWO of the four test roots and say so, on the grounds
  // that `serverTestsData` and `uiSpecs` have no dedicated override KEY. True, and
  // irrelevant: neither is a directory of its own, so collapsing the directory each one
  // actually reads collapses it. `serverTestsData` walks `SERVER_TESTS` in the data
  // formats, so emptying `serverTests` must take BOTH roots to zero and the failure must
  // name both. `uiSpecs` is a PREDICATE root over `UI_SRC` + `DESKTOP` + `PACKAGES`, so
  // emptying all three must take it to zero. Both are now driven for real, and the
  // assertion is on the message that fires — a name-the-root failure, not a bare exit
  // code. That is what "fails closed" was claiming.
  const cases = [
    { label: 'serverTests', roots: k => ({ serverTests: k }), expect: ['serverTests'] },
    // The SHARED-DIRECTORY case. `serverTestsData` has no key of its own; it reads the
    // same tree in the data formats, so one empty directory must fail BOTH, named.
    {
      label: 'serverTests+serverTestsData',
      roots: k => ({ serverTests: k }),
      expect: ['serverTests', 'serverTestsData'],
    },
    { label: 'uiTests', roots: k => ({ uiTests: k }), expect: ['uiTests'] },
    // The PREDICATE-ROOT case. `uiSpecs` collects `*.{test,spec}.{ts,tsx}` +
    // `__fixtures__`/`__testutil__` from the three FE trees, so all three go empty.
    {
      label: 'uiSpecs',
      roots: k => ({ uiSrc: k, desktop: k, packages: k }),
      expect: ['uiSpecs'],
    },
  ]
  for (const c of cases) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-empty-'))
    try {
      const r = spawnSync(process.execPath, [GUARD], {
        env: guardEnv({ LINT_NO_DOMAIN_ROOTS_OVERRIDE: JSON.stringify(c.roots(dir)) }),
        encoding: 'utf8',
      })
      assert.equal(r.status, 1, `collapsing ${c.label} must FAIL, not pass vacuously`)
      for (const root of c.expect) {
        assert.match(
          r.stderr,
          new RegExp(`root "${root}" resolved to 0 file`),
          `the failure must NAME the collapsed root ${root}, got:\n${r.stderr.slice(0, 3000)}`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('[WS-R4][roots] a collapsed test root ALSO trips the test-tier observation floor', async () => {
  // Belt and braces: the file-count floor catches an EMPTY root; the observation floor
  // catches a root that is walked but has stopped MATCHING (a broken vocabulary,
  // boundary or tokenizer). They fail for different reasons and both must be live.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-empty2-'))
  try {
    const r = spawnSync(process.execPath, [GUARD], {
      env: guardEnv({
        LINT_NO_DOMAIN_ROOTS_OVERRIDE: JSON.stringify({ serverTests: dir, uiTests: dir }),
      }),
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(
      r.stderr,
      /testDomainNoun: \d+ test-tier domain-noun hit\(s\), below the committed floor/,
      `the test-tier observation floor must fire, got:\n${r.stderr.slice(0, 3000)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[WS-R4][floors] every TEST root floor keeps the ≈2/3 collapse-detector margin', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { counts } = mod.defaultScanSet()
  const src = readFileSync(GUARD, 'utf8')
  const block = src.split('const SCAN_FLOORS = {')[1].split('\n}')[0]
  for (const root of ['serverTests', 'serverTestsData', 'uiTests', 'uiSpecs']) {
    const m = block.match(new RegExp(`\\b${root}:\\s*(\\d+)`))
    assert.ok(m, `${root} has no committed floor`)
    const floor = Number(m[1])
    const got = counts[root]
    assert.ok(floor > 0, `${root}: a floor of 0 is not a floor`)
    assert.ok(floor <= got, `${root}: floor ${floor} exceeds the live count ${got}`)
    assert.ok(
      floor <= Math.ceil(got * 0.72),
      `${root}: floor ${floor} against a measurement of ${got} is a TRIPWIRE, not a collapse ` +
        `detector — the next legitimate deletion breaks it.`,
    )
  }
})

test('[WS-R4][tier] the TIER SPLIT is real — production counts did not absorb the test trees', async () => {
  // The whole point of the split. A merged tier would let a production regression hide
  // inside a four-figure test total. Assert the production observation is UNCHANGED in
  // scale (three figures) while the test observation is separately four-figure, and that
  // no production baseline key is a test-tier path (or vice versa).
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { totals, testTotals, baseline } = mod.runGuard()
  assert.ok(totals.domainNoun > 0 && testTotals.domainNoun > 0, 'both tiers must be observing')
  assert.ok(
    testTotals.domainNoun > totals.domainNoun,
    'the test tier is known to be larger; if it is not, the roots collapsed',
  )
  const isTest = k =>
    k.startsWith('server/tests/') ||
    k.startsWith('ui/tests/') ||
    /\.(test|spec)\.(ts|tsx|mjs|js)$/.test(k) ||
    k.includes('/__fixtures__/') ||
    k.includes('/__testutil__/')
  for (const [name, sect, want] of [
    ['code', baseline.code, false],
    ['prose', baseline.prose, false],
    ['literals', baseline.literals, false],
    ['testCode', baseline.testCode, true],
    ['testProse', baseline.testProse, true],
    ['testLiterals', baseline.testLiterals, true],
  ]) {
    for (const k of Object.keys(sect)) {
      assert.equal(
        isTest(k),
        want,
        `${name}["${k}"] is in the WRONG tier — a leak filed in the other tier's ledger is ` +
          `ratcheted against the other tier's budget and is effectively unguarded`,
      )
    }
  }
})

test('[WS-R4][tier] a PRODUCTION leak is NOT absorbed by a test-tier budget', async () => {
  // WS-R5 §5 — REWRITTEN. This used to PLANT NOTHING. It asserted that the `code` and
  // `testCode` ledgers have disjoint KEYS, which is a property of the committed JSON, not
  // of the guard: it would pass unchanged if the tier dispatch were deleted outright.
  // The name claims an adversarial property, so the test now runs the adversary.
  //
  // THE ATTACK. Tier dispatch is by FILE PATH (`isTestTierFile`), not by which ledger
  // section holds an entry. So the attack on it is: plant a hit in a PRODUCTION file and
  // supply the budget for it in `testCode`. If dispatch ever consulted the ledger, or the
  // two budgets were merged, the leak would be absorbed and the guard would go green.
  //
  // Both doctored ledgers MOVE AN EXISTING (file, token) count rather than adding an
  // entry, deliberately: adding one trips the WS-R5 §4 aggregate ENTRY ceiling and the run
  // fails for a reason that has nothing to do with tiers. (That ceiling firing here is
  // itself worth knowing — it is exercised on purpose by the §4 test below.)
  //
  // R20 §1 — THE EXTRA PRODUCTION HIT IS NO LONGER PLANTED IN `gallery.tsx`. It used to
  // be appended to the real file for the duration of two full guard runs. The attack is
  // an INEQUALITY — `observed(PROD) > budget(PROD)` while the spare budget sits in
  // `testCode` — and it is reached by moving the ledger, not the tree: budget(PROD) −1
  // against the untouched observation is the same inequality as observation +1 against
  // the committed budget. The +1 on the TEST side is unchanged, so the attack it models
  // ("file the budget under the other tier") is intact, as is every assertion below.
  const PROD = 'ui/src/modules/workbench/gallery.tsx'
  const TEST = 'ui/src/modules/workbench/core/contributions/analysis.test.ts'
  const real = JSON.parse(readFileSync(path.join(__dirname, 'domain-baseline.json'), 'utf8'))
  assert.ok(real.code[PROD]?.leiden?.count >= 1, `${PROD} must already carry a baselined leiden budget`)
  assert.ok(real.testCode[TEST]?.leiden, `${TEST} must already carry a baselined leiden entry`)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nodomain-tier-'))
  try {
    // (a) THE ATTACK — one production `leiden` is over budget, and the spare +1 of
    // budget is filed against a TEST-tier file.
    const attackPath = path.join(tmp, 'test-budget.json')
    const a = JSON.parse(JSON.stringify(real))
    a.code[PROD].leiden.count -= 1
    a.testCode[TEST].leiden.count += 1
    writeFileSync(attackPath, JSON.stringify(a))
    const attacked = spawnSync(process.execPath, [GUARD], {
      env: guardEnv({ LINT_NO_DOMAIN_BASELINE_OVERRIDE: attackPath }),
      encoding: 'utf8',
    })
    assert.equal(attacked.status, 1, 'a production leak must not be absorbed by a test budget')
    assert.match(
      attacked.stderr,
      /workbench\/gallery\.tsx:\d+:\d+\s+\[domain-noun\]\s+leiden/,
      `the production finding must be REPORTED, got:\n${attacked.stderr.slice(0, 3000)}`,
    )
    // …and the same fact from the other side: the raised TEST entry finds nothing to
    // consume, because the production hit is not in the test observation at all.
    assert.match(
      attacked.stderr,
      /testCode\[".*analysis\.test\.ts"\]\["leiden"\] = \d+ but only \d+ remain/,
      'the raised test-tier budget must be reported STALE — the tiers never share',
    )

    // (b) NEGATIVE CONTROL — the budget mechanism works, and the ONLY difference between
    // (a) and (b) is which TIER holds that one unit of budget. Put it back on the
    // production side (i.e. the committed ledger) and the same tree is GREEN.
    const controlPath = path.join(tmp, 'code-budget.json')
    writeFileSync(controlPath, JSON.stringify(real))
    const controlled = spawnSync(process.execPath, [GUARD], {
      env: guardEnv({ LINT_NO_DOMAIN_BASELINE_OVERRIDE: controlPath }),
      encoding: 'utf8',
    })
    assert.equal(
      controlled.status,
      0,
      `the same hit budgeted in the PRODUCTION ledger must be absorbed, got:\n${controlled.stderr.slice(0, 3000)}`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // The structural property the ORIGINAL test asserted is KEPT — it is a real invariant,
  // it just was not the one the name promised.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { baseline } = mod.runGuard()
  const prodKeys = new Set(Object.keys(baseline.code))
  for (const k of Object.keys(baseline.testCode)) {
    assert.ok(!prodKeys.has(k), `${k} appears in BOTH ledgers — its budget would double`)
  }
})

test('[WS-R4][baseline] every testCode/testLiterals entry names an R4-TESTS-* finding', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const b = mod.loadBaseline()
  const OK = new Set([
    'R4-TESTS-CARD',
    'R4-TESTS-RS',
    'R4-TESTS-FIXTURE',
    'R4-TESTS-E2E',
    'R4-TESTS-UNIT',
    'R4-TESTS-SUPPORT',
    // WS-R5. Two more dispositions, each naming a distinct CAUSE rather than being folded
    // into an existing tag: `R5-G2-TESTS` = "the hand-listed vocabulary never contained this
    // id, so no tier could see it" (the G2 derivation surfaced it); `R5-GUARD-SELF` = "the
    // Rust twin has to SPELL the vocabulary it searches for, and this is what its own new
    // drift-pinning test costs". They are different problems with different fixes and the
    // ledger should not blur them.
    'R5-G2-TESTS',
    'R5-GUARD-SELF',
    // ROUND-4 RECONCILIATION. A SEVENTH disposition, deliberately NOT folded into
    // `R4-TESTS-E2E`: those five mean "this was in the test tree all along and no guard
    // could see it". `R4-RELOCATED` means something different and strictly more
    // interesting — "this residue was in the PRODUCTION tier last round and r4dataapi
    // moved it here". Reusing an existing tag would have made the single largest
    // production→test transfer of the whole effort unreadable in the ledger.
    'R4-RELOCATED',
    // WS-R7. Two more, and again NOT folded into an existing tag, because they answer two
    // different questions and only one of them is provenance:
    //   `R7-PKG`    = "no tier could see this until the guard grew a SECOND vocabulary axis"
    //                 (a shipped package's own package / analysis / view / action ids,
    //                 derived from the processor manifests). Same shape of admission as
    //                 `R3-EXT` and the `R4-TESTS-*` family — nothing moved in the tree.
    //   `R7-ACCEPT` = "this test's SUBJECT is a shipped package: it reads packages/ at
    //                 test time and drives the real chain". That is a DISPOSITION, not
    //                 provenance, and none of the tags above carried it. Folding it into
    //                 `R4-TESTS-UNIT` would say these were always here and merely unseen,
    //                 which is false — they were written this round, deliberately, against
    //                 the shipped packages.
    'R7-PKG',
    'R7-ACCEPT',
    // WS-R7. `FALSE-POSITIVE` is admitted here for the first time, and only here is it
    // worth arguing: this list exists so a test-tier entry cannot be admitted without
    // NAMING a reason, and every tag above answers "which round made this visible".
    // `FALSE-POSITIVE` answers a STRONGER question — "this is not domain vocabulary at
    // all" — and it is already in the guard's own closed VALID_FINDING_TAGS. The canonical
    // case is the one the guard's header names by hand: the dock's GRID `cells`, a pane
    // map. Requiring such an entry to wear a provenance tag instead would mean labelling a
    // file added THIS round as "hidden by the retired basename exemption", which is simply
    // false. The no-amnesty property is unaffected: the note assertion below still demands
    // a real argument, and the tag still comes from a closed set.
    'FALSE-POSITIVE',
    // processor-manifest-ui-separation. `DOC-EXAMPLE` is admitted on EXACTLY the grounds
    // `FALSE-POSITIVE` was, one round earlier, and the omission had a measurable cost: this
    // control has been RED since the commit that introduced the three entries below, i.e. the
    // guard's own suite was failing while the guard itself was green, which is the state this
    // whole file exists to make impossible. (`run-node-tests.mjs` is on the `npm run check`
    // path, so the redness was real, not cosmetic.)
    //
    // The argument, stated rather than inherited: every provenance tag above answers "which
    // round made this visible". `DOC-EXAMPLE` answers a DIFFERENT question — "this is a domain
    // ILLUSTRATION written into a comment on a domain-agnostic mechanism" — and it is already
    // in the guard's own closed VALID_FINDING_TAGS. The three entries wearing it are a
    // repeated-slot illustration in two doc comments on a staging path; a drop-in fixture whose
    // comment reaches for the single-cell case as the CONTRAST it is disproving; and a comment
    // naming the shipped multi-slots as the reason a multi-binding slot exists. Forcing any of
    // them into `R4-TESTS-UNIT` would assert they were hidden by the retired basename
    // exemption, which is false. Deleting the sentence instead is the failure the prose tier
    // exists to prevent. The no-amnesty property is untouched: the note assertion below still
    // demands a real argument, and the set is still closed.
    'DOC-EXAMPLE',
  ])
  let n = 0
  for (const [name, sect] of [
    ['testCode', b.testCode],
    ['testLiterals', b.testLiterals],
  ]) {
    for (const [k, toks] of Object.entries(sect)) {
      for (const [tok, spec] of Object.entries(toks)) {
        n++
        assert.equal(typeof spec, 'object', `${name}["${k}"]["${tok}"] must be {count, finding, note}`)
        assert.ok(
          OK.has(spec.finding),
          `${name}["${k}"]["${tok}"] has finding "${spec.finding}" — not a recognised test-tier disposition`,
        )
        assert.ok(spec.note && spec.note.length > 20, `${name}["${k}"]["${tok}"] has no real note`)
      }
    }
  }
  for (const [k, spec] of Object.entries(b.testProse)) {
    assert.ok(spec.tokens, `testProse["${k}"] must use the per-(file,token) form`)
    assert.ok(OK.has(spec.finding), `testProse["${k}"] has no R4-TESTS-* finding`)
  }
  assert.ok(n > 500, `only ${n} test-tier entries — the ledger collapsed`)
})

test('[WS-R4][baseline] the TEST ratchet fires in BOTH directions', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const clone = () =>
    JSON.parse(
      JSON.stringify({
        code: real.code,
        prose: real.prose,
        literals: real.literals,
        testCode: real.testCode,
        testProse: real.testProse,
        testLiterals: real.testLiterals,
      }),
    )
  const key = Object.keys(real.testCode)[0]
  const tok = Object.keys(real.testCode[key])[0]

  // STALE: inflate an entry — the tree can no longer satisfy it.
  const up = clone()
  up.testCode[key][tok].count += 5
  const a = runWithBaseline(up)
  assert.equal(a.code, 1, 'an inflated testCode entry must be reported STALE')
  assert.match(a.stderr, new RegExp(`testCode\\["${key.replace(/[/.]/g, '\\$&')}"\\]`))
  assert.match(a.stderr, /STALE/)

  // GROWTH: deflate an entry — the excess is a NEW leak and must be reported.
  const down = clone()
  down.testCode[key][tok].count -= 1
  const c = runWithBaseline(down)
  assert.equal(c.code, 1, 'one MORE occurrence than the test baseline must FAIL')
  assert.match(c.stderr, /domain finding\(s\) outside the committed baseline/)
})

test('[WS-R4][baseline] a testCode entry with NO finding fails — no bulk amnesty', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const b = JSON.parse(
    JSON.stringify({
      code: real.code,
      prose: real.prose,
      literals: real.literals,
      testCode: real.testCode,
      testProse: real.testProse,
      testLiterals: real.testLiterals,
    }),
  )
  const key = Object.keys(b.testCode)[0]
  const tok = Object.keys(b.testCode[key])[0]
  delete b.testCode[key][tok].finding
  const r = runWithBaseline(b)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /testCode\[.*\] has no `finding`/)
  assert.match(r.stderr, /R4-TESTS-\*/)
})

test('[WS-R4][baseline] the TEST bare-prose ceiling is ZERO — nothing is grandfathered', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const real = mod.loadBaseline()
  const b = JSON.parse(
    JSON.stringify({
      code: real.code,
      prose: real.prose,
      literals: real.literals,
      testCode: real.testCode,
      testProse: real.testProse,
      testLiterals: real.testLiterals,
    }),
  )
  delete b.testProse[Object.keys(b.testProse)[0]].finding
  const r = runWithBaseline(b)
  assert.equal(r.code, 1, 'ONE unexplained testProse entry must already breach the ceiling of 0')
  assert.match(r.stderr, /UNEXPLAINED testProse entries/)
})

// COUNT LOWERED 14 -> 13 (2026-08-03), in the same commit that retired R4-CARD-02. Its
// subject — `server/src/modules/mcp/view_spec_actions.rs` and its two `testdata/*.json`
// oracles — was DELETED when view-scoped capability registration moved out of the server,
// so there is no longer anything in the app crate coupled to the contributed bundle's SIZE
// through it. This edit IS the two-sided change the ledger's own instruction demands
// ("remove this entry AND lower CARDINALITY_CERTIFICATION_CEILING in the same commit"): the
// number lives in three places on purpose — the ledger, the ceiling, and this test — and a
// retirement that updates fewer than all three is caught here.
//
// COUNT LOWERED 13 -> 12 (processor-manifest-ui-separation), retiring R4-CARD-12. Its subject
// was an EXACT-SET equality over the contributed per-modality preset families in the shipped
// view spec. The package stopped declaring those families and the view stopped picking a
// modality at all — the picked value had been the emitted column prefix, so anything outside
// the three had no correct answer — so there is no bundle cardinality left to pin. The
// three-name literal DOES still occur in that file, as the exact INVERSE assertion (a set the
// spec proves nothing carries); re-anchoring on it would pin a permanent green, because a
// negative control over a retired vocabulary cannot fail when the bundle GROWS. This is the
// three-sided edit again: ledger entry removed, ceiling lowered, this count follows.
// COUNT LOWERED 12 -> 10 (main, semantic merge repair). TWO retirements landed between
// these runs — R4-CARD-13 (`d8d121e6`) and R4-CARD-01 (`fix/zero-core-derived`) — each
// correct on its own branch, each cut from a tree reading 12, so each lowered the ceiling
// 12 -> 11 and both wrote the literal `11`. A textual merge of two identical lines raises no
// conflict, so two removals yielded one decrement. THIS test is what caught the drift, which
// is the argument for keeping the count asserted here and not only at the ceiling.
test('[WS-R4][card] all ten exact-cardinality certifications are still anchored', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  assert.deepEqual(
    mod.cardinalityCertificationViolations(),
    [],
    'a pinned certification moved or was rewritten — re-anchor it, or remove it AND lower ' +
      'CARDINALITY_CERTIFICATION_CEILING in the same commit',
  )
  const src = readFileSync(GUARD, 'utf8')
  const block = src.split('const CARDINALITY_CERTIFICATIONS = [')[1].split('\n]\n')[0]
  const ids = [...block.matchAll(/id:\s*'(R4-CARD-\d+)'/g)].map(m => m[1])
  assert.equal(ids.length, 10, 'the ledger must hold all ten surviving certifications')
  assert.equal(new Set(ids).size, 10, 'certification ids must be unique')
  const ceiling = Number(src.match(/const CARDINALITY_CERTIFICATION_CEILING = (\d+)/)[1])
  assert.equal(ceiling, ids.length, 'the ceiling must sit AT the ledger size — it is shrink-only')
})

test('[WS-R4][card] a MOVED certification FAILS and names the file', async () => {
  // The un-gameability property of the ledger: it must not be possible to rewrite a
  // certification out from under it silently. Simulated by pointing the checker at an
  // anchor that is deliberately absent.
  const src = readFileSync(GUARD, 'utf8')
  const block = src.split('const CARDINALITY_CERTIFICATIONS = [')[1].split('\n]\n')[0]
  const first = block.match(/anchor:\s*'([^']+)'/)
  assert.ok(first, 'the ledger must anchor on a literal string')
  // The probe MUST live beside the real guard: `SRC_APP` is derived from `__dirname`,
  // so a copy in /tmp would collapse every root and fail for the wrong reason. `.mjs`
  // under `scripts/` is in no scan root, so the probe cannot perturb a measurement.
  const probe = path.join(__dirname, 'lint-no-domain-in-builtin.__cardprobe.mjs')
  try {
    writeFileSync(
      probe,
      readFileSync(GUARD, 'utf8').replace(first[1], 'THIS-ANCHOR-DOES-NOT-EXIST-ANYWHERE'),
    )
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
    assert.equal(r.status, 1, 'a lost anchor must FAIL')
    assert.match(r.stderr, /R4-CARD-\d+: the anchor/)
    assert.match(r.stderr, /Silently losing the anchor|no longer exists/)
    // …and it must be the ONLY thing that failed — otherwise the probe proved nothing.
    assert.doesNotMatch(r.stderr, /scan set COLLAPSED/)
  } finally {
    rmSync(probe, { force: true })
  }
})

// ── WS-R4 — the `ident` / `IDENTITY` boundary fix (segment suppression) ───────
test('[WS-R4][boundary] a vocabulary token inside a DIFFERENT compound word is suppressed', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang)
    return out
  }
  // The reported false positive: `sandbox/env_image.rs`'s operator-facing env var.
  for (const s of [
    'const CYTO_ENV_IMAGE_IDENTITY_REGEXP: u8 = 1;',
    'const DEFAULT_IDENTITY_RE: &str = "x";',
    'let identity_re = 1;',
  ]) {
    assert.deepEqual(hits(s, 'rust'), [], `${s} carries no domain content`)
  }
})

test('[WS-R4][boundary] the segment rule does NOT over-suppress — the header promises hold', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang)
    return out
  }
  // The guard's own header promises these stay caught.
  assert.deepEqual(hits('const GENERIC_CELL_CAP: u8 = 1;', 'rust'), ['CELL'])
  assert.deepEqual(hits('const SAMPLE_IDENT: u8 = 1;', 'rust'), ['SAMPLE', 'IDENT'])
  assert.deepEqual(hits('let n_cells = 1;', 'rust'), ['cells'])
  assert.deepEqual(hits('let inputCells = 1;', 'ts'), ['Cells'])
  // …and the whole-identifier rule that segments alone would have broken.
  assert.deepEqual(hits('let x: once_cell::Lazy = 1;', 'rust'), [])
  assert.deepEqual(hits('const IDENTICAL: u8 = 1;', 'rust'), [])
})

// ── WS-R8 — the RUST CARGO / cfg `feature` context exclusion ─────────────────
//
// `feature` is a single-cell noun AND the Cargo build-flag keyword. The compute +
// accounts epics gate whole modules behind `#[cfg(feature = "saas")]`, which recurs on
// every saas-gated module. The exclusion is CONTEXT-based (the cargo/cfg GRAMMAR), so it
// needs no baseline and cannot re-red on the next gated file — while a genuine genomic
// `feature` is still caught (the negative control below is the load-bearing half).
test('[WS-R8][cargo-cfg-feature] the `#[cfg(feature="saas")]` GRAMMAR is NOT flagged (Rust)', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang)
    return out
  }
  for (const s of [
    '#[cfg(feature = "saas")]',
    '#[cfg(feature="saas")]',
    '#[cfg(not(feature = "saas"))]',
    '#![cfg(feature = "saas")]',
    'let n = cfg!(feature = "saas") as i64;',
    '//! compiled ONLY behind the `saas` cargo feature',
    '// requires a build with the `saas` cargo feature; ships local-fs otherwise',
    '// this module + the client crates are ABSENT from a no-default-features build',
    '//   cargo test -p cytoanalyst --features saas --test integration_tests',
  ]) {
    assert.deepEqual(hits(s, 'rust'), [], `cargo/cfg build token, not a genomic feature: ${s}`)
  }
})

test('[WS-R8][cargo-cfg-feature][negative-control] a GENUINE genomic `feature` is STILL caught', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang)
    return out
  }
  // Genomic `feature`/`features` in prose + identifiers must NOT be blinded by the rule.
  assert.deepEqual(hits('let n_features = var_frame.len();', 'rust'), ['features'])
  assert.deepEqual(hits('let feature_id = row.feature_index;', 'rust'), ['feature', 'feature'])
  assert.deepEqual(hits('// one column per feature in the gene-by-cell matrix', 'rust'), [
    'feature',
    'gene',
    'cell',
  ])
  // A bare software-sounding `feature` with NO cargo/cfg neighbour still fires — the rule
  // is deliberately narrow, so ambiguity resolves to CAUGHT, not silently dropped.
  assert.deepEqual(hits('// the feature is dropped', 'rust'), ['feature'])
  // Rust-ONLY: the same `feature = "…"` shape in TS is NOT a cargo cfg and stays caught.
  assert.deepEqual(hits('const feature = "saas";', 'ts'), ['feature'])
})

// ── WS-R9 — the saas/cargo `feature` PROSE + `stripe-samples` exclusions ─────
//
// The billing epic gates whole modules behind `#[cfg(feature = "saas")]`, and their
// PROSE refers to "the feature" / "the `saas` feature" / crate "features" in ordinary
// sentences carrying NONE of the cfg GRAMMAR that WS-R8 keys on. WS-R9 clears that class
// by CONTEXT (P2 = the file is a cfg-feature-gated Rust module; P3 = a cargo/cfg word on
// the token's own line) so it needs no per-line baseline and cannot re-red on the next
// saas-gated file — while a genuine genomic `feature` in a NON-gated file STILL fires.
// It also excludes `stripe-samples` (Stripe's OSS example repo, cited in the billing
// client prose) — a REPO NAME, not the genomic `samples`.
test('[WS-R9][saas-feature] cfg-feature-gated FILE (P2): bare `feature` prose is NOT flagged', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  // In a Rust file carrying a `#[cfg(feature = "saas")]` attribute, "the feature" is the
  // cargo feature. The 4th arg is `fileHasCfgFeatureAttr`, computed per-file in scanFile.
  const hits = (txt, cfgAttr) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), 'rust', cfgAttr)
    return out
  }
  // These lines carry NO P3 cargo word, so P2 (the cfg-attr FILE context) is the ONLY
  // signal — which is exactly what isolates the file-context rule from the line rule.
  for (const s of [
    '// the ALTER lives in a normal migration (scanned regardless of the feature)',
    '// only linked when a feature turns it on',
    '//!    compiles only under the feature and asserts the entry registers',
  ]) {
    assert.deepEqual(hits(s, true), [], `cfg-gated module prose, cargo feature: ${s}`)
    // …and the SAME prose in a NON-gated file (no cfg attr, no cargo word) STILL fires.
    assert.deepEqual(hits(s, false), ['feature'], `non-gated file must still catch: ${s}`)
  }
})

test('[WS-R9][saas-feature] LINE-context (P3): a cargo/cfg word on the line clears `feature`', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang) // no cfg attr — P3 is the only signal
    return out
  }
  // The two saas-gated files that carry NO cfg attribute of their own, plus the SQL
  // migration comments (not Rust — P2 cannot apply, `saas`/`cargo`/`cfg` on the line does).
  assert.deepEqual(hits('/// sqlx here has BOTH the `chrono` and `time` features', 'rust'), [])
  assert.deepEqual(hits('/// `saas`-only (the rollup loop is gated on the feature)', 'rust'), [])
  assert.deepEqual(hits('-- regardless of the `saas` cargo feature, so a desktop', 'sql'), [])
  assert.deepEqual(hits('-- the billing MODULE code is `#[cfg(feature = "saas")]`.', 'sql'), [])
})

test('[WS-R9][saas-feature][negative-control] a GENOMIC `feature` with NO cargo word STILL fires', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang, cfgAttr) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang, cfgAttr)
    return out
  }
  // The load-bearing half: genomic `feature`/`n_features`/`feature matrix`/`feature_id`
  // in a NON-cfg-gated file must NOT be blinded.
  assert.deepEqual(hits('// one column per feature in the feature matrix', 'rust', false), [
    'feature',
    'feature',
  ])
  assert.deepEqual(hits('let n_features = var_frame.len();', 'rust', false), ['features'])
  assert.deepEqual(hits('let feature_id = row.feature_index;', 'rust', false), ['feature', 'feature'])
  // P1 grammar is Rust-ONLY: the 10x `features.tsv` fixture `features = "".join(…)` is an
  // ORDINARY Python assignment, not a cfg predicate key, and must still fire.
  assert.deepEqual(hits('features = "".join(rows)', 'py', false), ['features'])
  // P3 does NOT reach TS/JS: `const feature = "saas"` is an assignment, still caught.
  assert.deepEqual(hits('const feature = "saas";', 'ts', false), ['feature'])
  // A cargo word does NOT drag a genomic `feature` out when it is in a NON-P3 dialect.
  assert.deepEqual(hits('// saas: the per-feature threshold', 'ts', false), ['feature'])
})

test('[WS-R9][stripe-samples] a hyphen-tailed `stripe-samples` is NOT flagged; bare `samples` IS', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = (txt, lang) => {
    const out = []
    mod.matchNouns(txt, (_, t) => out.push(t), lang)
    return out
  }
  // Excluded: the plural, hyphen-tailed repo name (any `<alnum>-samples`).
  assert.deepEqual(hits('//! the `stripe-samples` reference server does', 'rust'), [])
  assert.deepEqual(hits('// mirrors the foo-samples layout', 'rust'), [])
  // NEGATIVE CONTROLS — genomic `samples` must STILL fire:
  //   bare (not hyphen-tailed):
  assert.deepEqual(hits('// the samples in this cohort', 'rust'), ['samples'])
  //   SINGULAR hyphenated forms are genomic (`per-sample`) — rule is plural-only:
  assert.deepEqual(hits('// per-sample thresholds', 'rust'), ['sample'])
  assert.deepEqual(hits('// the stripe-sample fixture', 'rust'), ['sample'])
})

// ── WS-R8 — the `DE-INV-<n>` deployment-invariant label exclusion ────────────
test('[WS-R8][DE-INV] `DE-INV-<n>` is NOT flagged, but a real `DE` reference still is', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const hits = txt => {
    const out = []
    mod.matchAcronyms(txt, (_, t) => out.push(t))
    return out
  }
  // Excluded: the deployment/metering invariant family.
  assert.deepEqual(hits('metering compiles out of desktop (DE-INV-10)'), [])
  assert.deepEqual(hits('single-box path unregressed (DE-INV-1); per-class pools (DE-INV-7)'), [])
  // Negative control: a genuine differential-expression `DE` is STILL caught, incl. the
  // `de_page` handler reference `DE-page` (which is NOT the `-INV` label shape).
  assert.deepEqual(hits('a (comparison,gene) DE table'), ['DE'])
  assert.deepEqual(hits('operational tunables (DE-page cap, slice byte cap)'), ['DE'])
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 §1 — the OVERRIDE class is fail-closed
// ════════════════════════════════════════════════════════════════════════════

/** The guard, spawned WITHOUT the self-test opt-in — i.e. how CI and `npm run check` run it. */
function runGate(env = {}, args = []) {
  const e = { ...process.env, ...env }
  delete e.LINT_NO_DOMAIN_SELFTEST
  const r = spawnSync(process.execPath, [GUARD, ...args], { env: e, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('[WS-R5][§1] THE REPORTED BYPASS: an empty scan set without the opt-in FAILS', () => {
  // The literal reproduction, verbatim: `LINT_NO_DOMAIN_SCAN_OVERRIDE='[]'` printed ✓ and
  // exited 0 having scanned ZERO files — past SCAN_FLOORS, MUST_SCAN_KEYS,
  // FORMAT_COVERAGE_PINS, the baseline ratchet and the certification ledger, all at once.
  const r = runGate({ LINT_NO_DOMAIN_SCAN_OVERRIDE: '[]' })
  assert.equal(r.code, 1, 'an override without the opt-in must FAIL')
  assert.match(r.stderr, /INADMISSIBLE override/)
  assert.match(r.stderr, /LINT_NO_DOMAIN_SCAN_OVERRIDE is set but LINT_NO_DOMAIN_SELFTEST=1 is not/)
  assert.doesNotMatch(r.stdout, /✓ no-domain-in-builtin/, 'it must not print a green line')
})

test('[WS-R5][§1] ALL THREE overrides are gated, not just the scan one', () => {
  // The class, not the instance. `ROOTS_OVERRIDE` re-points the real walk;
  // `BASELINE_OVERRIDE` substitutes the ledger the ratchet compares against (point it at a
  // hand-crafted file whose counts EQUAL the observation and every code/prose finding is
  // absorbed with nothing tripped and no constant edited). Each fails, and NAMES itself.
  for (const name of [
    'LINT_NO_DOMAIN_SCAN_OVERRIDE',
    'LINT_NO_DOMAIN_ROOTS_OVERRIDE',
    'LINT_NO_DOMAIN_BASELINE_OVERRIDE',
  ]) {
    const r = runGate({ [name]: '{}' })
    assert.equal(r.code, 1, `${name} must be inadmissible without the opt-in`)
    assert.match(r.stderr, new RegExp(`${name} is set but`), `the failure must NAME ${name}`)
  }
})

test('[WS-R5][§1] an un-admitted override is IGNORED, not merely REPORTED', () => {
  // Reporting alone would leave `--prune-baseline` happily WRITING to a substituted path.
  // The gate has to sit in front of every mode, and the override has to be un-honored even
  // if some future caller swallows the exit code. Proven by the strongest available
  // observation: the file the guard was pointed at is never touched.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-admit-'))
  try {
    const target = path.join(dir, 'hostile-baseline.json')
    writeFileSync(target, '{"SENTINEL":true}\n')
    const r = runGate({ LINT_NO_DOMAIN_BASELINE_OVERRIDE: target }, ['--prune-baseline'])
    assert.equal(r.code, 1, '--prune-baseline must refuse an inadmissible override')
    assert.equal(
      readFileSync(target, 'utf8'),
      '{"SENTINEL":true}\n',
      'the substituted baseline must NOT have been written to',
    )
    assert.doesNotMatch(r.stdout, /pruned/, 'the prune must not have run at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[WS-R5][§1] a ZERO-file scan is a hard error EVEN WITH the opt-in', () => {
  // Defence in depth, and the specific reason the opt-in alone is not the whole answer:
  // the opt-in is one `export` away from being set in a CI env block. A run that opened
  // nothing certifies nothing, in EVERY mode.
  const r = spawnSync(process.execPath, [GUARD], {
    env: guardEnv({ LINT_NO_DOMAIN_SCAN_OVERRIDE: '[]' }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 1, 'zero files must fail even under the self-test opt-in')
  assert.match(r.stderr, /scanned \(near-\)NOTHING/)
  assert.match(r.stderr, /the guard scanned ZERO files/)
  // …and it says so in the mode-independent way, so nobody reads it as a self-test quirk.
  assert.match(r.stderr, /hard error in EVERY mode/)
})

test('[WS-R5][§1] `--require-full-scan` rejects the opt-in AND every override', () => {
  // What CI invokes. It exists because the opt-in is a plain env var: a workflow that
  // acquired `LINT_NO_DOMAIN_SELFTEST=1` (deliberately or by inheriting an env block)
  // would otherwise be able to be told what to scan by the same mechanism.
  const clean = runGate({}, ['--require-full-scan'])
  assert.equal(clean.code, 0, `a real full scan must pass, got:\n${clean.stderr.slice(0, 2000)}`)
  assert.match(clean.stdout, /✓ no-domain-in-builtin: \d+ app-builtin file\(s\) scanned/)

  const withOptIn = spawnSync(process.execPath, [GUARD, '--require-full-scan'], {
    env: guardEnv(),
    encoding: 'utf8',
  })
  assert.equal(withOptIn.status, 1, 'the opt-in must be rejected outright in this mode')
  assert.match(withOptIn.stderr, /--require-full-scan was given but LINT_NO_DOMAIN_SELFTEST=1 is set/)

  for (const name of [
    'LINT_NO_DOMAIN_SCAN_OVERRIDE',
    'LINT_NO_DOMAIN_ROOTS_OVERRIDE',
    'LINT_NO_DOMAIN_BASELINE_OVERRIDE',
  ]) {
    const r = spawnSync(process.execPath, [GUARD, '--require-full-scan'], {
      env: guardEnv({ [name]: '{}' }),
      encoding: 'utf8',
    })
    assert.equal(r.status, 1, `${name} must be rejected under --require-full-scan`)
    assert.match(r.stderr, new RegExp(`--require-full-scan was given but ${name} is set`))
  }
})

test('[WS-R5][§1] a SELF-TEST green is LABELLED — it can never read as a repo green', () => {
  // A fixture-driven ✓ is a statement about a temp file. It must not be mistakable for the
  // one line a human or a log-scraper reads as "the tree is clean".
  withTmp(dir => {
    const f = path.join(dir, 'clean.ts')
    writeFileSync(f, 'export const x = 1\n')
    const r = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(r.code, 0)
    assert.match(r.stderr, /LINT_NO_DOMAIN_SELFTEST MODE/)
    assert.match(r.stderr, /certifies NOTHING about the repository/)
  })
  // …and the real run carries no such banner.
  const real = runGate()
  assert.equal(real.code, 0)
  assert.doesNotMatch(real.stderr, /SELFTEST MODE/)
})

test('[WS-R5][§1] the aggregate scan-volume floor keeps a real collapse margin', async () => {
  const mod = await import(`${GUARD}?r5-volume`)
  const { set } = mod.defaultScanSet()
  const src = readFileSync(GUARD, 'utf8')
  const floor = Number(src.match(/const SCANNED_TOTAL_FLOOR = (\d+)/)[1])
  // Same ≈2/3-of-measurement basis as every other floor in the file: a collapse detector,
  // not a tripwire the next deletion pass breaks.
  assert.ok(floor > 0, 'the aggregate floor must be a real number')
  assert.ok(
    set.length >= floor * 1.25,
    `the live scan (${set.length}) must clear the aggregate floor (${floor}) by a real margin`,
  )
  assert.deepEqual(mod.scanVolumeViolations(set.length, false), [])
  assert.equal(mod.scanVolumeViolations(floor - 1, false).length, 1, 'below the floor must fire')
  assert.equal(mod.scanVolumeViolations(0, true).length, 1, 'zero must fire even under override')
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 §4 — adding a baseline entry cannot be silent
// ════════════════════════════════════════════════════════════════════════════

test('[WS-R5][§4] a NEW baseline entry tagged GENERIC no longer slips through', () => {
  // THE HOLE. The ratchet was shrink-only PER ENTRY, but `code`/`prose`/`testCode`/
  // `testProse` had no aggregate bound — only the two LITERAL tiers did. So a brand-new
  // production leak could be made green by hand-adding ONE entry with a `GENERIC` tag: no
  // constant edited, no admission forced, nothing for a reviewer to catch but a hunk in a
  // 10 000-line JSON file. This adds exactly that entry.
  //
  // R20 §1 — and it no longer writes `ui/src/core/__r5silent_probe.ts` into the working
  // tree to go with it. The ENTRY CEILING — the mechanism this test is about — counts
  // `(file, token)` pairs in the LEDGER; it never reads the tree, so the companion file
  // only ever made the added entry non-stale. Without it the hand-added entry is caught
  // TWICE, and both are asserted: the ceiling (the mechanism) and the per-entry STALE
  // report (which is what a budget for a leak that is not there actually looks like).
  const key = 'ui/src/core/__r5silent_probe.ts'
  const real = JSON.parse(readFileSync(path.join(__dirname, 'domain-baseline.json'), 'utf8'))
  assert.ok(!real.code[key], `${key} must not already be in the ledger`)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nodomain-silent-'))
  try {
    const doctored = path.join(tmp, 'b.json')
    const b = JSON.parse(JSON.stringify(real))
    b.code[key] = {
      leiden: { count: 1, finding: 'GENERIC', note: 'a new leak, quietly admitted' },
    }
    writeFileSync(doctored, JSON.stringify(b))
    const r = spawnSync(process.execPath, [GUARD], {
      env: guardEnv({ LINT_NO_DOMAIN_BASELINE_OVERRIDE: doctored }),
      encoding: 'utf8',
    })
    assert.equal(r.status, 1, 'a silently-added baseline entry must FAIL')
    assert.match(
      r.stderr,
      /domain-baseline\.json code holds \d+ \(file, token\) entr\(ies\), above the committed ceiling/,
      `the ENTRY ceiling must fire, got:\n${r.stderr.slice(0, 3000)}`,
    )
    assert.match(
      r.stderr,
      /code\["ui\/src\/core\/__r5silent_probe\.ts"\]\["leiden"\] = 1 but only 0 remain — STALE/,
      'a budget for a leak that is not in the tree is ALSO reported, by name',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('[WS-R5][§4] a baseline entry may not invent its own disposition tag', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const b = mod.loadBaseline()
  assert.deepEqual(mod.baselineAdmissionViolations(b), [], 'the committed ledger is admissible')
  // `finding` used to accept ANY non-empty string at runtime; the vocabulary the error
  // message advertised was enforced only by a test, and only for two of the six sections.
  const doctored = JSON.parse(JSON.stringify(b))
  const first = Object.keys(doctored.code)[0]
  const tok = Object.keys(doctored.code[first])[0]
  doctored.code[first][tok] = { ...doctored.code[first][tok], finding: 'R9-WHATEVER' }
  const v = mod.baselineAdmissionViolations(doctored)
  assert.equal(v.length, 1)
  assert.match(v[0], /is tagged "R9-WHATEVER", which is not in the CLOSED set/)
  // …and every ceiling sits AT the measurement, so there is no free headroom to add into.
  const sizes = {
    code: Object.values(b.code).reduce((a, o) => a + Object.keys(o).length, 0),
    testCode: Object.values(b.testCode).reduce((a, o) => a + Object.keys(o).length, 0),
    prose: Object.values(b.prose).reduce((a, s) => a + Object.keys(s.tokens).length, 0),
    testProse: Object.values(b.testProse).reduce((a, s) => a + Object.keys(s.tokens).length, 0),
  }
  const src = readFileSync(GUARD, 'utf8')
  for (const [tier, n] of Object.entries(sizes)) {
    assert.match(
      src,
      new RegExp(`\\b${tier}: ${n},`),
      `BASELINE_ENTRY_CEILINGS.${tier} must equal the measurement (${n}) — slack is room for a silent add`,
    )
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 §H/A — a note's argument may not outlive the symbols it names
// ════════════════════════════════════════════════════════════════════════════

test('[WS-R5][rationale] the committed notes cite only symbols that still resolve', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  assert.deepEqual(mod.rationaleFreshnessViolations(mod.loadBaseline()), [])
})

test('[WS-R5][rationale] a DEAD cited symbol fires — and the tautology is closed', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const b = mod.loadBaseline()
  const key = Object.keys(b.code)[0]
  const tok = Object.keys(b.code[key])[0]

  // (a) a note whose argument names a symbol that no longer exists anywhere.
  const dead = JSON.parse(JSON.stringify(b))
  dead.code[key][tok] = {
    ...dead.code[key][tok],
    note: 'DELIBERATE RETENTION so that `R5_LONG_GONE_SYMBOL` stays identifiable across readers.',
  }
  const v = mod.rationaleFreshnessViolations(dead)
  assert.equal(v.length, 1)
  assert.match(v[0], /`R5_LONG_GONE_SYMBOL`/)

  // (b) THE ESCAPE HATCH, and the convention it encodes: a note that names a dead symbol
  //     BECAUSE it is dead spells it without backticks, and is clean.
  const deliberate = JSON.parse(JSON.stringify(b))
  deliberate.code[key][tok] = {
    ...deliberate.code[key][tok],
    note: 'R5_LONG_GONE_SYMBOL was renamed a round ago; the residue here is unrelated.',
  }
  assert.deepEqual(mod.rationaleFreshnessViolations(deliberate), [])

  // (c) THE TAUTOLOGY. The corpus excludes the guard's own three artefacts. Without that
  //     exclusion a cited symbol resolves against the sentence quoting it — measured: the
  //     `criteria.ts` retention argument, whose seven named symbols were ALL renamed in
  //     round 3, came back CLEAN because `CELL_WS_CLASS` and friends survive nowhere except
  //     this guard and its Rust twin. Asserted here as a live property of the corpus.
  const guardSrc = readFileSync(GUARD, 'utf8')
  assert.ok(guardSrc.includes('CELL_WS_CLASS'), 'the guard DOES quote the dead symbol…')
  const quoting = JSON.parse(JSON.stringify(b))
  quoting.code[key][tok] = {
    ...quoting.code[key][tok],
    note: 'retained so that `CELL_WS_CLASS` stays identifiable.',
  }
  const v2 = mod.rationaleFreshnessViolations(quoting)
  assert.equal(v2.length, 1, '…and it must STILL fire — the guard is not part of the corpus')
  assert.match(v2[0], /`CELL_WS_CLASS`/)
})

test('[WS-R5][rationale] a note may not contradict its OWN token counts', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const b = mod.loadBaseline()
  const key = Object.keys(b.prose)[0]
  const own = Object.values(b.prose[key].tokens).reduce((a, x) => a + x, 0)
  const doctored = JSON.parse(JSON.stringify(b))
  doctored.prose[key] = { ...doctored.prose[key], note: `GENERATED: all ${own + 77} prose hits are mirrors.` }
  const v = mod.rationaleFreshnessViolations(doctored)
  assert.equal(v.length, 1, 'a false self-count must fire')
  assert.match(v[0], new RegExp(`sum to ${own}`))
  // The TRUE form is clean — this is a check on disagreement, not on mentioning a number.
  const honest = JSON.parse(JSON.stringify(b))
  honest.prose[key] = { ...honest.prose[key], note: `GENERATED: all ${own} prose hits are mirrors.` }
  assert.deepEqual(mod.rationaleFreshnessViolations(honest), [])
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 G2 / G3 — the vocabulary is DATA; "not scanned" is a DECISION
// ════════════════════════════════════════════════════════════════════════════

test('[WS-R5][G2] the vocabulary is DERIVED from the manifests, not hand-listed', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const entries = mod.contributedDatatypes()
  assert.deepEqual(mod.contributedVocabularyViolations(entries), [])
  const ids = new Set(entries.map(e => e.id))
  const pkgs = new Set(entries.map(e => e.pkg))
  // The exact drift the hand-list had accumulated, pinned so a regression to it FAILS.
  assert.ok(pkgs.size >= 3, `datatypes come from ${pkgs.size} package(s): ${[...pkgs]}`)
  for (const missed of [
    'cell-set', // caught only incidentally, by the `cell` noun
    'annotation-table',
    'geneset/collection', // NOT caught by the `gene` noun: the lowercase `s` fails rightOk
    'graph/attributed',
    'de/result',
  ]) {
    assert.ok(ids.has(missed), `the derived vocabulary must contain ${missed}`)
  }
  assert.ok(!ids.has('de'), '`de` was PRUNED from the lattice — a hand-list kept it alive')
  // A SHORT parse must be loud, not quiet: deriving from DATA trades one silent-drift mode
  // for another unless the derivation itself is fail-closed.
  const short = mod.contributedVocabularyViolations(entries.slice(0, 2))
  assert.ok(short.length >= 1)
  assert.match(short[0], /below the committed floor/)
  const untitled = mod.contributedVocabularyViolations([{ pkg: 'p', id: 'x/y', title: null }])
  assert.ok(untitled.some(m => /has no `title:`/.test(m)))
})

test('[WS-R5][G2] a NEWLY-derived id really FIRES in a real production file', () => {
  // The derivation is only worth anything if the widened vocabulary reaches the scan. One
  // of the four ids that were invisible to EVERY tier, planted in a production-shaped file.
  withTmp(dir => {
    const f = path.join(dir, 'leak.rs')
    writeFileSync(f, 'const P: &str = "geneset/collection";\nconst Q: &str = "annotation-table";\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1)
    assert.match(stderr, /\[substring\]\s+geneset\/collection/)
    assert.match(stderr, /\[quoted-id\]\s+annotation-table/)
  })
})

test('[WS-R5][G3] an UNDECLARED tree FAILS — "not scanned" must be written down', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const { set } = mod.defaultScanSet()
  assert.deepEqual(
    mod.treeDeclarationViolations(set),
    [],
    'every tree in the census is either reached or declared',
  )
  // Three trees hid here — `src-app/testdata` (334 findings), repo-root `scripts/` (78, incl.
  // 3 quote-delimited datatype ids) and `ui/scripts` (3901) — in no root and in no exclusion
  // list, while the guard carefully documented `packages/**` and `libs/viz`. Drop every
  // scanned file under one census level and the tree it belongs to must be named.
  const pruned = set.filter(e => !e.path.includes(`${path.sep}desktop${path.sep}`))
  const v = mod.treeDeclarationViolations(pruned)
  // The census runs at several LEVELS, so an emptied tree is named at each level it appears
  // under — `src-app/desktop` (a child of `src-app`) and `src-app/desktop/tauri` (a child of
  // `src-app/desktop`). Both, and nothing else.
  assert.deepEqual(
    v.map(m => m.match(/^"([^"]+)"/)[1]).sort(),
    ['src-app/desktop', 'src-app/desktop/tauri'],
    `exactly the emptied tree must be named, got: ${v}`,
  )
  assert.match(v[0], /is in NO scan root and in NO declared exclusion/)
})

test('[WS-R5][G1] `#[cfg(not(test))]` is SHIPPING code and is SCANNED', () => {
  // `/\btest\b/` matches `not(test)`, so the blanking that exists for `#[cfg(test)]` was
  // also swallowing its exact opposite — code compiled ONLY OUTSIDE tests. Latent (nothing
  // in the tree spells it that way today) and one line in each enforcer, which is the only
  // reason it stayed cheap. Both halves asserted: the exemption still works, and its
  // negation no longer inherits it.
  withTmp(dir => {
    const f = path.join(dir, 'a.rs')
    writeFileSync(
      f,
      [
        '#[cfg(not(test))]',
        'mod ship {',
        '    pub const T: &str = "single-cell/anndata";',
        '    pub struct S { pub n_cells: i64 }',
        '}',
        '#[cfg(test)]',
        'mod tests {',
        '    pub const T: &str = "single-cell/soma";',
        '}',
      ].join('\n'),
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'rust', nouns: true }])
    assert.equal(code, 1, 'a leak under #[cfg(not(test))] must FAIL')
    assert.match(stderr, /:3:\d+\s+\[substring\]\s+single-cell/, 'the not(test) literal fires')
    assert.match(stderr, /\[domain-noun\]\s+n_cells|\[domain-noun\]\s+cells/, 'its noun fires too')
    assert.doesNotMatch(stderr, /:8:/, '#[cfg(test)] is STILL blanked — that exemption stands')
  })
})

// ── WS-R6 — the census skips RUNTIME ARTEFACTS, and only those ───────────────
//
// The WS-R5 G3 census made "not scanned" a decision for every tree ON DISK, which is
// not the set of trees the repo AUTHORS. `cytoanalyst-data/` (the app's runtime data
// directory — embedded Postgres, `dev/`, `e2e/`, artefacts; 922 MB on a used machine)
// is created the moment anyone runs the server, is gitignored, holds zero tracked
// files, and was in no declaration — so the guard was RED on every developer machine
// that had ever booted the app and GREEN only on a fresh clone and in CI. Declaring a
// fifth name would have been the same whack-a-mole that produced the four already in
// UNSCANNED_TREES, so the rule is derived from git instead:
//
//     SKIP iff  git says IGNORED  AND  git says ZERO TRACKED FILES.
//
// These tests hold BOTH halves. The scratch-repo cases exercise the rule against a
// real `git` without touching this repository's index; the two repo-root cases prove
// the whole guard, end to end, on the real census.

/** A throwaway git repo, so the two conditions can be driven for real. */
function withScratchRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-git-'))
  const git = (...args) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir } })
  try {
    git('init', '-q')
    git('config', 'user.email', 'g@example.invalid')
    git('config', 'user.name', 'guard')
    return fn(dir, git)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('[WS-R6] a GITIGNORED, ZERO-TRACKED tree is a runtime artefact and is SKIPPED', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  withScratchRepo((dir, git) => {
    writeFileSync(path.join(dir, '.gitignore'), '/runtime-data/\n')
    mkdirSync(path.join(dir, 'runtime-data', 'dev'), { recursive: true })
    writeFileSync(path.join(dir, 'runtime-data', 'dev', 'pg.dat'), 'x')
    git('add', '.gitignore')
    git('commit', '-qm', 'init')
    const skip = mod.gitRuntimeArtefactTrees(['runtime-data'], dir)
    assert.deepEqual([...skip], ['runtime-data'], 'the shape of `cytoanalyst-data`: ignored + 0 tracked')
  })
})

test('[WS-R6] a GITIGNORED tree that DOES hold a TRACKED file is NOT skipped', async () => {
  // The load-bearing half. "Ignored" alone would be a fail-OPEN: a file committed
  // before its ignore rule landed (or added with `git add -f`) is still source, and
  // source can still leak. BOTH conditions, or the rule is just an ignore check.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  withScratchRepo((dir, git) => {
    writeFileSync(path.join(dir, '.gitignore'), '/half-ignored/\n')
    mkdirSync(path.join(dir, 'half-ignored'), { recursive: true })
    writeFileSync(path.join(dir, 'half-ignored', 'kept.ts'), 'export const x = 1\n')
    writeFileSync(path.join(dir, 'half-ignored', 'junk.dat'), 'x')
    git('add', '.gitignore')
    git('add', '-f', 'half-ignored/kept.ts')
    git('commit', '-qm', 'init')
    assert.equal(
      spawnSync('git', ['ls-files', '--', 'half-ignored'], { cwd: dir, encoding: 'utf8' }).stdout.trim(),
      'half-ignored/kept.ts',
      'precondition: the tree really does hold a tracked file',
    )
    assert.deepEqual(
      [...mod.gitRuntimeArtefactTrees(['half-ignored'], dir)],
      [],
      'a tree with tracked content must still be DECLARED, ignored or not',
    )
    // …and the SECOND condition is what does it, not an accident of the first. Today's
    // `check-ignore` consults the index, so it already declines to call this tree ignored
    // — but that is one subcommand's default, and `--no-index` flips it straight back to
    // "ignored". Both readings are asserted, so the rule is provably TWO conditions and
    // not one with a convenient implementation behind it.
    assert.equal(git('check-ignore', 'half-ignored').status, 1, 'index-aware: NOT reported ignored')
    assert.equal(
      git('check-ignore', '--no-index', 'half-ignored').status,
      0,
      'ignore-rules-only: IS ignored — condition 1 alone would skip a tree that ships source',
    )
  })
})

test('[WS-R6] an UNTRACKED but NOT-ignored tree is NOT skipped', async () => {
  // The other half of "not redundant": zero-tracked alone is the ordinary shape of a
  // brand-new feature directory nobody has `git add`ed yet — exactly what the census
  // must catch on the way in.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  withScratchRepo((dir, git) => {
    writeFileSync(path.join(dir, '.gitignore'), '/runtime-data/\n')
    mkdirSync(path.join(dir, 'brand-new'), { recursive: true })
    writeFileSync(path.join(dir, 'brand-new', 'a.ts'), 'export const x = 1\n')
    git('add', '.gitignore')
    git('commit', '-qm', 'init')
    assert.deepEqual([...mod.gitRuntimeArtefactTrees(['brand-new'], dir)], [])
  })
})

test('[WS-R6] the rule FAILS CLOSED when git has no answer', async () => {
  // No `.git` at all: the census must behave exactly as it did before WS-R6 rather
  // than go quiet. A guard that stops guarding when its authority is unavailable is
  // the failure mode this whole file is written against.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodomain-nogit-'))
  try {
    mkdirSync(path.join(dir, 'whatever'), { recursive: true })
    assert.deepEqual([...mod.gitRuntimeArtefactTrees(['whatever'], dir)], [], 'nothing skipped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual([...mod.gitRuntimeArtefactTrees([])], [], 'and an empty census is not a git call')
})

test('[WS-R6][repo] a REAL gitignored zero-tracked tree at the repo root keeps the guard GREEN', async () => {
  // End to end on the real census, in the shape that made this guard red for every
  // developer. `*.log` is an existing root `.gitignore` rule, so the fixture needs no
  // edit to a tracked file to become ignored.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const planted = path.join(repoRoot, '__wsr6_runtime_artefact__.log')
  mkdirSync(path.join(planted, 'dev'), { recursive: true })
  writeFileSync(path.join(planted, 'dev', 'pg.dat'), 'x')
  try {
    assert.equal(
      spawnSync('git', ['check-ignore', '__wsr6_runtime_artefact__.log'], { cwd: repoRoot }).status,
      0,
      'precondition: git really ignores the fixture',
    )
    const { set } = mod.defaultScanSet()
    assert.deepEqual(
      mod.treeDeclarationViolations(set).filter(m => m.includes('__wsr6_runtime_artefact__')),
      [],
      'a runtime artefact must not be a census violation',
    )
    assert.equal(runGuard(undefined).code, 0, 'and the whole guard stays green')
  } finally {
    rmSync(planted, { recursive: true, force: true })
  }
})

test('[WS-R6][repo] a NOT-ignored undeclared tree at the repo root still FAILS, by name', async () => {
  // The census is not weakened: everything git does not call an artefact must still be
  // reached or declared. This is the property the whole WS-R5 G3 mechanism exists for.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const planted = path.join(repoRoot, '__wsr6_undeclared_tree__')
  mkdirSync(path.join(planted, 'src'), { recursive: true })
  writeFileSync(path.join(planted, 'src', 'a.ts'), 'export const x = 1\n')
  try {
    assert.notEqual(
      spawnSync('git', ['check-ignore', '__wsr6_undeclared_tree__'], { cwd: repoRoot }).status,
      0,
      'precondition: git does NOT ignore the fixture',
    )
    const { set } = mod.defaultScanSet()
    const v = mod.treeDeclarationViolations(set).filter(m => m.startsWith('"__wsr6_undeclared_tree__"'))
    assert.equal(v.length, 1, 'an undeclared tree must be named')
    assert.match(v[0], /is in NO scan root and in NO declared exclusion/)
    assert.match(v[0], /GITIGNORED \*\*and\*\* holds zero tracked files/)
    const { code, stderr } = runGuard(undefined)
    assert.equal(code, 1)
    assert.match(stderr, /an UNDECLARED tree \(WS-R5 G3 census\)/)
    assert.match(stderr, /"__wsr6_undeclared_tree__"/)
  } finally {
    rmSync(planted, { recursive: true, force: true })
  }
  assert.equal(runGuard(undefined).code, 0)
})

test('[WS-R6][repo] a repo-root tree that is IGNORED but holds a TRACKED file still FAILS', async () => {
  // The two-condition rule, proven on the REAL census rather than a scratch repo: the
  // fixture is ignored by the same `*.log` rule as the artefact case above, and the ONLY
  // difference is that git's index calls one file inside it tracked.
  //
  // ── THE REAL INDEX IS NEVER WRITTEN ──────────────────────────────────────────
  //
  // This used to run `git add -f <rel>/kept.ts` against the repository's own index and
  // undo it in a `finally` — the exact durability class R20 §1 removed one layer up, and
  // strictly worse than the source case it replaced: a `finally` does not survive SIGKILL,
  // and a killed run would leave BOTH the repo-root directory AND a force-added tracked
  // file inside it, which IS the "ignored and holds a tracked file" shape this very test
  // constructs — so `npm run check`'s `lint-no-domain` step would go RED afterwards on an
  // undeclared tree the developer never created. (Measured then: `.git/…/index` sha256
  // e8e6a…  ->  29c63…  across one `node --test --test-name-pattern=WS-R6`.)
  //
  // The capability is REMOVED rather than made more careful. `GIT_INDEX_FILE` points every
  // git process — this test's own, and the ones the guard module spawns in-process — at a
  // COPY of the index under `os.tmpdir()`. And the entry is added with `update-index
  // --cacheinfo` naming a blob that already exists in this repository, so not even a loose
  // object is written. A SIGKILL here leaves the real index byte-identical; the only
  // residue possible is the repo-root directory, which is additive and untracked, exactly
  // like the two sibling `[repo]` tests above.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const rel = '__wsr6_ignored_but_tracked__.log'
  const planted = path.join(repoRoot, rel)
  const git = (...args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  const indexPath = path.resolve(repoRoot, git('rev-parse', '--git-path', 'index').stdout.trim())
  const indexSha = () => createHash('sha256').update(readFileSync(indexPath)).digest('hex')
  const beforeSha = indexSha()
  // A blob that is already in the object store, so `update-index` writes nothing new.
  const blob = git('rev-parse', 'HEAD:package.json').stdout.trim()
  assert.match(blob, /^[0-9a-f]{40,64}$/, 'precondition: an existing blob to point the entry at')

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'nodomain-index-'))
  const scratchIndex = path.join(scratch, 'index')
  copyFileSync(indexPath, scratchIndex)
  assert.equal(
    createHash('sha256').update(readFileSync(scratchIndex)).digest('hex'),
    beforeSha,
    'precondition: the index COPY succeeded — a silent copy failure here would aim the ' +
      'writes below at the real index after all',
  )
  mkdirSync(planted, { recursive: true })
  writeFileSync(path.join(planted, 'kept.ts'), 'export const x = 1\n')
  const savedIndexEnv = process.env.GIT_INDEX_FILE
  process.env.GIT_INDEX_FILE = scratchIndex
  try {
    assert.equal(git('check-ignore', rel).status, 0, 'precondition: ignored')
    assert.equal(
      git('update-index', '--add', '--cacheinfo', `100644,${blob},${rel}/kept.ts`).status,
      0,
      'precondition: tracked (in the SCRATCH index)',
    )
    assert.equal(git('ls-files', '--', rel).stdout.trim(), `${rel}/kept.ts`)
    assert.deepEqual(
      [...mod.gitRuntimeArtefactTrees([rel])],
      [],
      'the ignore check alone would have skipped it; the tracked-file condition does not',
    )
    const { set } = mod.defaultScanSet()
    const v = mod.treeDeclarationViolations(set).filter(m => m.startsWith(`"${rel}"`))
    assert.equal(v.length, 1, 'ignored + tracked content must still be DECLARED')
  } finally {
    if (savedIndexEnv === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = savedIndexEnv
    rmSync(scratch, { recursive: true, force: true })
    rmSync(planted, { recursive: true, force: true })
  }
  assert.equal(indexSha(), beforeSha, 'the repository index is byte-identical')
  // Scoped to the fixture: the working tree may legitimately carry other edits.
  assert.equal(git('status', '--porcelain', '--', rel).stdout.trim(), '', 'the fixture left no trace')
  assert.equal(git('ls-files', '--', rel).stdout.trim(), '', 'and no index entry')
  assert.equal(runGuard(undefined).code, 0)
})

test('[WS-R6] the four GENERATED+GITIGNORED declarations are now REDUNDANT, and kept on purpose', async () => {
  // The decision recorded next to them in UNSCANNED_TREES, asserted rather than
  // claimed: materialise all four and the git rule alone would skip every one — so
  // they are belt-and-braces (the git rule needs `git`; a tarball export has none),
  // not mechanism. `server/config` is the control: it is TRACKED, so its declaration
  // is load-bearing and must NOT be skippable.
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const redundant = [
    'src-app/ui/test-results',
    'src-app/ui/playwright-report',
    'src-app/server/binaries',
    'src-app/server/migrations-merged',
  ]
  const created = redundant.filter(r => !existsSync(path.join(repoRoot, r)))
  for (const r of created) mkdirSync(path.join(repoRoot, r), { recursive: true })
  try {
    assert.deepEqual(
      [...mod.gitRuntimeArtefactTrees(redundant)].sort(),
      [...redundant].sort(),
      'every one is ignored AND holds zero tracked files',
    )
    assert.deepEqual(
      [...mod.gitRuntimeArtefactTrees(['src-app/server/config'])],
      [],
      'the control: `server/config` is tracked source, so its declaration is real',
    )
  } finally {
    for (const r of created) rmSync(path.join(repoRoot, r), { recursive: true, force: true })
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R7 — the PACKAGE-VOCABULARY tier (a shipped package's OWN ids)
// ════════════════════════════════════════════════════════════════════════════
//
// The tier exists because a human OUT-READ the guard on its own stated subject:
// `RETIRED_BY_VIEW_REWRITE = &["qc.compute::qc.setModality"]` sat in the app backend
// across five widening rounds and no tier objected, because every tier above polices the
// single-cell LATTICE and that string is PACKAGE vocabulary.
//
// So the first test below is not a synthetic probe — it is that exact const. A guard that
// has never been OBSERVED failing on the case that motivated it is not evidence of
// anything; that is the standing lesson from every source-scanning guard this repo has
// shipped. The second is the control that keeps it honest: the vocabulary is DERIVED from
// `packages/`, so a plausible id that is not in the tree must NOT fire. Without that
// control a guard matching on SHAPE (`\w+\.\w+::\w+\.\w+`) would pass the first test while
// being a different, and much worse, guard.

test('[WS-R7][acceptance] FAILS on the exact const that motivated the tier', () => {
  withTmp(dir => {
    const f = path.join(dir, 'view_spec_actions.rs')
    writeFileSync(
      f,
      'const RETIRED_BY_VIEW_REWRITE: &[&str] = &["qc.compute::qc.setModality"];\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, 'a package view/action id hardcoded in the app backend must FAIL')
    assert.match(stderr, /qc\.compute/, 'the guard must NAME the offending id')
    assert.match(stderr, /view_spec_actions\.rs/, 'and NAME the file it is in')
    assert.match(stderr, /package-id/, 'and classify it as the package tier, not the lattice one')
  })
})

test('[WS-R7][acceptance] FAILS on a bare package ACTION id in production TS', () => {
  withTmp(dir => {
    const f = path.join(dir, 'actions.ts')
    writeFileSync(f, `export const isRun = (id: string) => id === 'cf.addCriterion'\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1)
    assert.match(stderr, /cf\.addCriterion/)
  })
})

test('[WS-R7][negative-control] PASSES on a plausible id that is NOT in packages/', () => {
  withTmp(dir => {
    const f = path.join(dir, 'plausible.rs')
    // Same SHAPE as the real thing, in the same position, in the same dialect. It is
    // absent from `packages/`, so a data-driven guard says nothing and a
    // shape-matching one convicts. This is the test that tells the two apart.
    writeFileSync(
      f,
      'const RETIRED: &[&str] = &["spatial.deconvolve::sd.run", "velocity.scvelo"];\n',
    )
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 0, `an id absent from the package tree must NOT fire:\n${stderr}`)
  })
})

test('[WS-R7] a package id in a COMMENT lands in the PROSE tier, not the code tier', () => {
  withTmp(dir => {
    const f = path.join(dir, 'note.ts')
    writeFileSync(f, `// the qc.compute view declares its own source\nexport const x = 1\n`)
    const { code, stderr } = runGuard([{ path: f, lang: 'ts' }])
    assert.equal(code, 1)
    assert.match(stderr, /package-prose/, 'a comment is the lower severity, as for the nouns')
    assert.doesNotMatch(stderr, /\[package-id\]/, 'and NOT the executable-commitment tier')
  })
})

test('[WS-R7] the vocabulary is DERIVED from the package tree, not hand-listed', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const ids = mod.contributedPackageIds()
  const pkgs = new Set(ids.map(e => e.pkg))
  assert.ok(pkgs.size >= 5, `expected the walk to reach the real packages, saw ${pkgs.size}`)
  for (const source of ['package', 'analysis', 'view', 'action', 'namespaced']) {
    assert.ok(
      ids.some(e => e.source === source),
      `every shipped package declares at least one \`${source}\` id; none was parsed, which ` +
        `is the SILENT half of a stale derivation`,
    )
  }
  assert.deepEqual(
    mod.packageVocabularyViolations(),
    [],
    'the derivation guards itself: a collapsed parse must be a hard failure, not a short list',
  )
  // Pointed at an empty tree the walk yields nothing AND the floors fire — the same
  // fail-closed property `SCAN_FLOORS` gives the scan set.
  withTmp(dir => {
    const empty = mod.contributedPackageIds(dir)
    assert.deepEqual(empty, [], 'no packages, no vocabulary')
    assert.ok(
      mod.packageVocabularyViolations(empty, []).length >= 3,
      'and an empty vocabulary must be LOUD, never a silent pass',
    )
  })
})

test('[WS-R7] the precision filters drop only what the lattice already catches', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  const tokens = new Set(mod.PACKAGE_ID_TOKENS)
  // KEPT — invisible to every tier above (`qc` is not a noun, and `QC` is matched
  // case-SENSITIVELY on purpose).
  //
  // `qc.addHb` stood here until the per-preset add ACTIONS were replaced by one generic add
  // over a preset catalog carried as DATA. Its successor `qc.addPreset` is the same shape and
  // the same claim — a shipped action id no other tier can see — and naming a LIVE id is the
  // point: this assertion is about the derivation reaching the shipped specs, so an id the
  // specs no longer declare would pin a permanent green.
  for (const t of ['qc.compute', 'qc.addPreset', 'cf.addCriterion', 'cr.run']) {
    assert.ok(tokens.has(t), `${t} is new coverage and must be in the vocabulary`)
  }
  // DROPPED by filter 2 — the lattice already fires inside these, so keeping them would
  // double-count every site (the measured 60+ duplicate failure the SUBSTRING_PREFIXES
  // subsumption filter exists to prevent).
  for (const t of ['cell.filter', 'anndata.import', 'qc.setGeneNames', 'cellranger.count']) {
    assert.ok(!tokens.has(t), `${t} is already caught by the lattice tier; it must not double-count`)
  }
  // DROPPED by filter 1 — a bare, separator-less id is ambiguous English-adjacent noise.
  for (const t of ['qc', 'cellranger']) {
    assert.ok(!tokens.has(t), `${t} is too ambiguous to be believed; precision over reach`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  WS-R8 — the ID-STEM tier (a lattice id used as a SEGMENT, not as a literal)
// ════════════════════════════════════════════════════════════════════════════
//
// The blind spot: `QUOTED_ID_RE` requires the WHOLE quoted literal to BE the id, so an
// id used as a STEM was invisible. The motivating case is not hypothetical — it is
// verbatim what `provenance/action_registry.rs` and `provenance/interaction.rs` shipped
// while this guard printed ✓.

test('[WS-R8][acceptance] FAILS on the exact payload key that motivated the tier', () => {
  withTmp(dir => {
    const f = path.join(dir, 'action_registry.rs')
    // Verbatim the shipped line.
    writeFileSync(f, 'let cref = req_str(recipe, "clustering_ref", action_type)?;\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, stderr)
    assert.match(stderr, /\[id-stem\]\s+clustering/)
  })
})

test('[WS-R8][acceptance] FAILS on a lattice id used as a DOTTED segment', () => {
  withTmp(dir => {
    const f = path.join(dir, 'catalog.rs')
    writeFileSync(f, 'dispatch("selection.clustering", D::LabelSet),\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, stderr)
    assert.match(stderr, /\[id-stem\]\s+clustering/)
  })
})

test('[WS-R8][negative-control] PASSES on a plausible STEM that is NOT a contributed id', () => {
  withTmp(dir => {
    const f = path.join(dir, 'plausible.rs')
    // The same shape, the same position, the same dialect — differing only in whether
    // the stem is a real id in `packages/`. A shape-matcher convicts here; a
    // data-driven tier says nothing.
    writeFileSync(f, 'let r = req_str(recipe, "grouping_ref", action_type)?;\nlet s = "selection.spatial";\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 0, `a stem absent from the lattice must NOT fire:\n${stderr}`)
  })
})

test('[WS-R8][scope] a stem in a COMMENT does NOT fire — the tier is code-only', () => {
  withTmp(dir => {
    const f = path.join(dir, 'note.rs')
    // Deliberate: the doc comments that EXPLAIN this fix quote `clustering_ref`, and the
    // measured production yield of a prose stem tier was 7 dispositions and 0 defects.
    // A tier that funds its own rationale is the "baselined into silence" outcome.
    writeFileSync(f, '// the old key was `clustering_ref`, named after a contributed type\nlet ok = 1;\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 0, stderr)
    assert.doesNotMatch(stderr, /id-stem/)
  })
})

test('[WS-R8][no-double-count] a BARE quoted id stays the quoted-id tier, not the stem tier', () => {
  withTmp(dir => {
    const f = path.join(dir, 'bare.rs')
    writeFileSync(f, 'let dt = "clustering";\n')
    const { code, stderr } = runGuard([{ path: f, lang: 'rust' }])
    assert.equal(code, 1, stderr)
    assert.match(stderr, /\[quoted-id\]/)
    assert.doesNotMatch(stderr, /\[id-stem\]/, 'the two tiers must not both claim one byte')
  })
})

test('[WS-R8] the stem vocabulary is DERIVED, and its precision filters are the measured ones', async () => {
  const mod = await import('./lint-no-domain-in-builtin.mjs')
  assert.deepEqual(mod.idStemVocabularyViolations(), [], 'the derived set must clear its floor')
  // The filters, asserted as BEHAVIOUR rather than by reading the token list: a stem the
  // filters drop must not fire, and the one they keep must.
  assert.deepEqual(mod.idStemVocabularyViolations([]), [
    'the ID-STEM vocabulary COLLAPSED: 0 token(s) < ID_STEM_TOKEN_FLOOR (1). Derived from ' +
      'QUOTED_ID_TOKENS; a guard that forbids nothing still prints ✓.',
  ])
  const hits = []
  // `embedding` is dropped (already a DOMAIN NOUN — the noun tier owns `embedding_hash`),
  // `de` is dropped (2 chars), `metadata-column` is dropped (it carries a separator of
  // its own, and all 7 of its production hits are the `metadata-column-family` CAPABILITY).
  mod.matchIdStems('embedding_hash de_page metadata-column-family clustering_ref', (i, t) =>
    hits.push(t),
  )
  assert.deepEqual(hits, ['clustering'])
  // …and the SEPARATOR set is narrow on purpose: `:` and `/` are excluded because the
  // guard's own false-positive-free acceptance went RED on the ref prefix
  // `startsWith('clustering:')` while they were in. See ID_STEM_SEPARATORS.
  const noisy = []
  mod.matchIdStems("k.startsWith('clustering:') && p === 'a/clustering/b'", (i, t) => noisy.push(t))
  assert.deepEqual(noisy, [], 'a ref prefix and a path segment are NOT stem uses')
})
