#!/usr/bin/env node
// The criteria-coercion PARITY runner — the cross-language gate for
// `src-app/testdata/criteria-coercion-corpus.json`.
//
// ## Why this exists
//
// A criteria filter is read by THREE independent coercions, in three languages:
//
//   1. `provenance/predicate_script.rs::CRITERIA_PRELUDE` — the emitted python replay
//      script whose sha256 is the run's attested reproducibility claim.
//   2. `packages/cell-filter/compute/cell-filter.py::criteria_keep_mask` — the
//      kernel that decides the COMMITTED mask (in TWO obs dtype flavours).
//   3. `ui/.../core/runtime/primitives.ts::keep_mask` — the live preview the user tunes.
//
// The feature's whole promise is that (1) == (2) == (3) cell-for-cell. Round 3 ran an
// ad-hoc 80-case corpus by hand and found 12 disagreements; nothing re-ran it, and
// nothing was committed. This runner is that corpus made permanent: it EXECUTES all
// three readers (never re-implements one) and fails on any disagreement the corpus has
// not explicitly documented.
//
// ## ITEM-4 — there was a FOURTH reader, and it is retired
//
// Reader 4 was the TS DSL BUILDER (`core/dsl/criteriaPredicate.ts`): the same criteria
// lifted into a `CellSetPredicate` and evaluated through `dsl/eval.ts` — the RECORDED
// predicate a saved filter run stored. That was a SECOND ENCODING of the filter, and
// keeping the two in agreement is most of why this gate was built. The lift is deleted
// (`criteria` is the single encoding, and one encoding cannot disagree with itself), so
// reader 4 has no subject.
//
// This costs the gate NO cell-coercion coverage: reader 4 was never independent of
// reader 3 for cells (its ctx was built with reader 3's own `parseValue`, see B6 below),
// and the corpus' `dslLifts` / `dslEvalError` per-case fields are now unread. What the
// gate still protects — three independent implementations of the ONE surviving criteria
// coercion agreeing cell-for-cell — is untouched.
//
// ## What each reader covers — the runner says so, it does not assume it (R4A-03)
//
// Readers 1-3 are all MASK readers: each produces a keep-mask for EVERY case, so "they
// agree cell-for-cell" is a claim the run earns on all of them, with no per-case coverage
// caveat to track.
//
// The cell rule specifically is cross-checked by the two PYTHON readers (1 + 2, which are
// genuinely independent implementations of it) plus `coercion-parity-ws-check.mjs`. A
// further TS cell coercion is deliberately NOT written — it would be another
// implementation racing to match CPython, the trap `pyStr`'s doc records.
//
// ## Usage
//
//   node scripts/coercion-parity.mjs           # run all three, print the table, gate
//   node scripts/coercion-parity.mjs --report  # never exit non-zero (triage mode)
//   node scripts/coercion-parity.mjs --skip-rust   # readers 2-3 only (no cargo)
//
// Reader 1 runs through `cargo test`, which also asserts on its own, and dumps its
// per-case answers to `target/coercion-parity-rust.json` for this diff.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = resolve(ROOT, 'src-app/testdata/criteria-coercion-corpus.json')
const RUST_DUMP = resolve(ROOT, 'target/coercion-parity-rust.json')

const argv = process.argv.slice(2)
const REPORT_ONLY = argv.includes('--report')
const SKIP_RUST = argv.includes('--skip-rust')

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'))

// ITEM-37 — FAIL CLOSED on a collapsed corpus. `CORPUS` is a hard-coded path;
// `readFileSync` already throws if it MOVES, but a corpus that is present and
// EMPTY (or truncated by a bad edit/merge) would sail through as
// "0 cases — the 3 MASK readers agree cell-for-cell on all 0" at exit 0 — a
// green gate that measured nothing. Four fail-open incidents of this shape
// happened in this round, so the case count carries a COMMITTED floor: shrinking
// the corpus requires an explicit, reviewable edit here.
const MIN_CORPUS_CASES = 120
if (!Array.isArray(corpus.cases) || corpus.cases.length < MIN_CORPUS_CASES) {
  process.stderr.write(
    `coercion-parity: CORPUS COLLAPSED — ${Array.isArray(corpus.cases) ? corpus.cases.length : 'no'} ` +
      `case(s) in ${CORPUS}, below the committed floor of ${MIN_CORPUS_CASES}. A parity run over an ` +
      `empty corpus proves nothing. Restore the corpus, or lower MIN_CORPUS_CASES deliberately.\n`,
  )
  process.exit(1)
}
const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b)

// The cell-whitespace strip set is hand-mirrored into three languages, so check the
// three literals are the SAME set of codepoints before running anything. A one-character
// drift is exactly the divergence class the enumeration exists to close, and a corpus
// case only catches it if someone happened to add a case for that codepoint.
process.stdout.write(run('ws-check', process.execPath, ['scripts/coercion-parity-ws-check.mjs']))

function run(label, file, args, opts = {}) {
  try {
    return execFileSync(file, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    })
  } catch (e) {
    process.stderr.write(`\n[${label}] FAILED to run: ${file} ${args.join(' ')}\n`)
    if (e.stdout) process.stderr.write(`--- stdout ---\n${e.stdout}\n`)
    if (e.stderr) process.stderr.write(`--- stderr ---\n${e.stderr}\n`)
    // A reader that cannot be executed is a FAILURE TO VERIFY, never a skip: the whole
    // point of the corpus is that all three coercions are checked against each other.
    process.exit(2)
  }
}

// ── reader 2: the committed kernel (python) ─────────────────────────────────
const kernel = JSON.parse(run('kernel', 'python3', ['scripts/coercion-parity-kernel.py']))

// ── reader 3: the live preview (node) ───────────────────────────────────────
const ts = JSON.parse(
  run('ts', process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    '--import',
    './src-app/ui/scripts/ts-resolve.mjs',
    'scripts/coercion-parity-ts.mjs',
  ]),
)

// ── reader 1: the emitted replay script (rust → python) ─────────────────────
//
// The FULL module path, including the crate-internal `modules::` prefix — libtest's
// `--exact` matches the whole name, so a shortened filter silently selects NOTHING.
// That happened here during development: `provenance::criteria_script::tests::…`
// matched 0 tests, cargo exited 0, and the runner then diffed against a STALE dump left
// by an earlier run — reporting divergences that no longer existed and, in the opposite
// direction, capable of reporting agreement that no longer existed either. The two
// guards below make that unrepresentable rather than relying on the filter being right.
const RUST_TEST =
  'modules::provenance::criteria_script::tests::the_emitted_replay_matches_the_shared_coercion_corpus'
let rust = null
if (!SKIP_RUST) {
  const startedAt = Date.now()
  const out = run(
    'emitter',
    'cargo',
    ['test', '--lib', '--manifest-path', 'src-app/server/Cargo.toml', RUST_TEST, '--', '--exact'],
    { env: { ...process.env, CONFIG_FILE: process.env.CONFIG_FILE ?? 'config/dev.yaml' } },
  )
  // GUARD 1: the test actually ran. `cargo test` exits 0 for "0 tests selected".
  if (!/^test result: ok\. 1 passed/m.test(out)) {
    process.stderr.write(
      `[emitter] the corpus test did not run (filter ${RUST_TEST} selected nothing, or the ` +
        `result line changed). cargo said:\n${out}\n`,
    )
    process.exit(2)
  }
  // GUARD 2: the dump is THIS run's, not a leftover.
  if (!existsSync(RUST_DUMP)) {
    process.stderr.write(`[emitter] the cargo reader produced no ${RUST_DUMP}\n`)
    process.exit(2)
  }
  if (statSync(RUST_DUMP).mtimeMs < startedAt) {
    process.stderr.write(
      `[emitter] ${RUST_DUMP} is STALE (written before this run started) — refusing to ` +
        `diff against a leftover from an earlier build\n`,
    )
    process.exit(2)
  }
  rust = JSON.parse(readFileSync(RUST_DUMP, 'utf8'))
}

// ── diff ────────────────────────────────────────────────────────────────────
const rows = []
for (const c of corpus.cases) {
  const expect = c.expect
  const allTrue = expect.every(Boolean)
  const problems = []

  const k = kernel[c.id]
  if (!k) problems.push('kernel: no answer')
  else {
    if (!eq(k.list, expect)) problems.push(`kernel(list)=${JSON.stringify(k.list)}`)
    if (!eq(k.object, expect)) problems.push(`kernel(object)=${JSON.stringify(k.object)}`)
  }

  const t = ts[c.id]
  if (!t) problems.push('ts: no answer')
  else if (!eq(t.preview, expect)) problems.push(`preview=${JSON.stringify(t.preview)}`)

  if (rust) {
    const r = rust[c.id]
    if (!r) problems.push('emitter: no answer')
    else if ('refused' in r) {
      // The emitter refuses to record an all-true "selection" — correct exactly when
      // the case constrains nothing.
      if (!allTrue) problems.push(`emitter REFUSED (${r.refused})`)
    } else if (!eq(r.mask, expect)) problems.push(`emitter=${JSON.stringify(r.mask)}`)
  }

  if (problems.length) rows.push({ id: c.id, why: c.why, expect, problems })
}

const total = corpus.cases.length
if (rows.length === 0) {
  // The HONEST coverage statement — it must describe exactly what this run MEASURED, and
  // nothing more (ROUND-6 / B8: an over-claiming headline on a correct mechanism is the
  // single most-repeated defect of this lifecycle).
  //
  // Every reader in this run produces a mask for EVERY case, so "all agree cell-for-cell"
  // is earned on all of them with no per-case coverage caveat. `--skip-rust` drops reader
  // 1, and the line says so rather than implying the full gate ran.
  const maskReaders = rust ? 3 : 2
  const agree = rust ? '1-3' : '2-3'
  process.stdout.write(
    `coercion-parity: ${total} cases — the ${maskReaders} MASK readers (${agree}) agree ` +
      `cell-for-cell on all ${total}\n`,
  )
  process.exit(0)
}

process.stdout.write(`coercion-parity: ${rows.length}/${total} cases DIVERGE\n\n`)
for (const r of rows) {
  process.stdout.write(`  ${r.id}\n`)
  process.stdout.write(`    expect ${JSON.stringify(r.expect)} — ${r.why}\n`)
  for (const p of r.problems) process.stdout.write(`    ✗ ${p}\n`)
}
process.stdout.write(`\ncoercion-parity: ${rows.length}/${total} DIVERGE\n`)
process.exit(REPORT_ONLY ? 0 : 1)
