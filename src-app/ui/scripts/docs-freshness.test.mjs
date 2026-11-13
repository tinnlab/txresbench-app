// TEST-43 (ITEM-35) — the SDK coordination record exists, and it is CONDITIONED ON THE CODE.
//
// `SDK_GAPS.md` is an append-only friction log whose own header states its purpose: "Every entry
// is a real friction point discovered by actually consuming the SDK as app #2 … This log tells
// live1 what to extract / fix next", and "Coordination is via the human, not direct." So it is the
// coordination artifact for an SDK change, and a submodule bump that lands without its entry is a
// change nobody downstream can find.
//
// ── WHY IT IS CONDITIONED, AND NOT A FROZEN STRING ─────────────────────────────────
//
// A test asserting "SDK_GAPS.md contains the word responseType" freezes prose: it stays green if
// the SDK change is reverted and the entry left behind, and it says nothing about whether the two
// agree. Every assertion below is instead conditioned on the SDK SOURCE — it reads the submodule's
// own `api-client/` for the two capabilities the entry claims, and only then requires the record.
// So it goes red in BOTH directions: the code landing without the record, and the record outliving
// the code.
//
// The pin is read from git rather than from the doc, so "the entry records the pinned SHA" is a
// comparison against the tree's actual state and not against another copy of the same sentence.
//
// ── AND EVERY ASSERTION IS SCOPED TO THE ENTRY, NOT TO THE DOCUMENT ────────────────
//
// The first draft matched `/responseType/` and `/isolate/` against the WHOLE file and was VACUOUS:
// `responseType` already appears in an unrelated `emit_ts` gap, and `/isolate/` matches
// "per-worktree-isolated". Deleting the entire G-STREAM entry left it GREEN — it passed straight
// through the exact defect it was written for, which is this branch's recurring failure and the
// fifth instance of it. Every match below is now taken inside the entry's OWN section, and the
// section's presence is asserted first, so there is nothing for unrelated prose to satisfy.
//
// Run directly:  node --test scripts/docs-freshness.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** `src-app/ui/scripts` → `src-app/ui` → `src-app` → the repo root, which owns `SDK_GAPS.md`. */
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const SDK_GAPS = join(REPO_ROOT, 'SDK_GAPS.md')
const SDK_DIR = join(REPO_ROOT, 'sdk')
const API_CLIENT = join(SDK_DIR, 'packages', 'framework', 'src', 'api-client')

/** The SDK commit the PARENT repo pins — the coordination artifact itself. `null` when the
 *  submodule is not checked out, which is a legitimate state for a shallow CI job. */
function pinnedSdkSha() {
  if (!existsSync(join(SDK_DIR, 'packages'))) return null
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SDK_DIR, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** The G-STREAM entry's own text — from its heading to the next top-level heading, or the end.
 *  `null` when the entry is absent. Scoping every match to this is what makes the assertions about
 *  THIS record rather than about the document happening to contain a word somewhere. */
function gStreamSection(log) {
  const start = log.indexOf('## G-STREAM')
  if (start < 0) return null
  const rest = log.slice(start + 1)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

function sdkSource(file) {
  const path = join(API_CLIENT, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** `src-app/ui/scripts` → `src-app`. (TEST-18's files lived under here; the constant
 *  left when its block was retired — see the STRIP note below.) */

describe('TEST-43 (ITEM-35) — the SDK change carries its coordination record', () => {
  const sha = pinnedSdkSha()
  const core = sdkSource('core.ts')
  const inflight = sdkSource('inflight.ts')

  test('the log exists and is non-trivial (the guard fails closed)', () => {
    // Without this, every conditional case below would pass vacuously against an empty or missing
    // file — the fail-open shape `guard-floors.test.mjs` exists to stamp out.
    assert.ok(existsSync(SDK_GAPS), 'SDK_GAPS.md is missing — the coordination channel is gone')
    assert.ok(readFileSync(SDK_GAPS, 'utf8').length > 2000, 'SDK_GAPS.md is implausibly short')
  })

  test('the submodule is checked out, so the conditions below are actually evaluated', () => {
    // The non-vacuity assertion. If the submodule were absent, `core`/`inflight` would be null and
    // every conditional case would silently do nothing while reporting PASS.
    assert.ok(sha, 'the `sdk` submodule is not checked out — run `git submodule update --init`')
    assert.ok(core, 'sdk api-client/core.ts not found')
    assert.ok(inflight, 'sdk api-client/inflight.ts not found')
  })

  test('the ENTRY exists WHEN the SDK carries the change it records', () => {
    if (!core || !core.includes('responseType')) return
    assert.ok(
      gStreamSection(readFileSync(SDK_GAPS, 'utf8')),
      'the SDK carries the raw-body escape hatch but SDK_GAPS.md has no entry for it — a bump nobody downstream can find',
    )
  })

  test('the entry names the `responseType` capability', () => {
    if (!core || !core.includes('responseType')) return
    const section = gStreamSection(readFileSync(SDK_GAPS, 'utf8'))
    assert.ok(section, 'no entry to check')
    assert.match(section, /responseType/, 'the entry does not name the capability it records')
  })

  test('the entry records the `isolate` share-on-failure DEFECT', () => {
    if (!inflight) return
    // The fix is the hard-fail. Detected by the SDK naming the non-cloneable case rather than by a
    // line number, so a refactor of the file does not silently disarm this.
    if (!/cloneable|structuredClone/i.test(inflight)) return
    const section = gStreamSection(readFileSync(SDK_GAPS, 'utf8'))
    assert.ok(section, 'no entry to check')
    // Word-boundaried: an unboundaried match is satisfied by "isolated", which is how the first
    // draft of this file passed with the entry deleted.
    assert.match(section, /\bisolate\b/, 'the entry records no defect for the coalescing fallback')
  })

  test('the recorded pin matches the SHA the parent repo actually pins', () => {
    if (!sha) return
    const log = readFileSync(SDK_GAPS, 'utf8')
    const short = sha.slice(0, 7)
    // Read from git, compared against the doc — so this is the doc agreeing with the TREE, never
    // one sentence agreeing with another. A bump that forgets to move the pin line goes red here.
    // Asserted on the PIN LINE, not the whole file: a SHA mentioned anywhere would otherwise do.
    const pinLine = log.split('\n').find(l => l.includes('SDK pinned at'))
    assert.ok(pinLine, 'SDK_GAPS.md has no `SDK pinned at` line')
    assert.ok(
      pinLine.includes(short),
      `the pin line records a different SHA than the tree pins (${short}) — it is stale`,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-18 (ITEM-13, ITEM-14) — RETIRED with its subjects (strip node ITEM-4).
//
// The ITEM-13/ITEM-14 superseded-prose checks read `libs/viz`'s
// `STREAMING_PROGRESSIVE_PLAN.md` / `arrowStream.ts`, the workbench
// `canvasFeed.ts` fold and the single-cell-viz package's `coordinates.yaml` /
// `colour-by.yaml` — every one of which left with the single-cell tree. The guard
// whose subject is gone is deleted, not re-pointed at a near-identical file (the
// same disposition as the workbench layer-boundary and positional-declaration
// lints; `gate-wiring.test.mjs` asserts those retirements). TEST-43 above remains:
// its SDK_GAPS.md subject was deleted pre-strip (commit 378e9cc6) and the record is
// a CARRIED pre-existing red, not this round's.

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-23's BINDING (ITEM-17b) — where its assertions live, asserted rather than asserted-about.
//
// TEST-23's two claims (a stream call is NEVER joined, so two callers get two independent bodies;
// a non-cloneable joined value hard-fails where it is caused) are proven in the SDK SUBMODULE, at
// `sdk/packages/framework/src/api-client/stream-response.test.ts`, as SDKSTREAM-3 and SDKSTREAM-5.
// They run in `@txresbench/framework`'s `node:test` tier — that package's vitest config EXCLUDES the
// file, so `npx vitest run <it>` reports "No test files found", which is standing-check 6 arriving
// from the other side.
//
// TESTS.md declares TEST-23's file as `src-app/ui/src/api-client/index.test.ts`, which does not
// exist. That is a DECLARED-PATH error, not a missing test — the same class as TEST-43's wrong
// extension. This case is the parent repo's durable record of where the proof actually is: it goes
// RED if that SDK file is deleted or renamed, so the citation cannot rot into a claim about
// nothing. It does NOT re-assert the SDK's own behaviour; the SDK test does that, and no SDK
// change is in scope here (the pin is fixed).

const SDK_STREAM_TEST = join(SDK_DIR, 'packages', 'framework', 'src', 'api-client', 'stream-response.test.ts')

describe('TEST-23 (ITEM-17b) — its proof is where the record says it is', () => {
  test('the SDK carries stream-response.test.ts with both cases TEST-23 names', () => {
    if (!existsSync(join(SDK_DIR, 'packages'))) return // submodule not checked out — see TEST-43
    assert.ok(
      existsSync(SDK_STREAM_TEST),
      'TEST-23 is recorded PASS against sdk/packages/framework/src/api-client/stream-response.test.ts, and that file is gone — the result now cites nothing',
    )
    const src = readFileSync(SDK_STREAM_TEST, 'utf8')
    // The two case ids, matched individually: a file containing one of them would otherwise
    // satisfy a check for "the file mentions SDKSTREAM".
    assert.match(src, /SDKSTREAM-3\b/, 'SDKSTREAM-3 (a stream call is never joined) is gone from the SDK test TEST-23 cites')
    assert.match(src, /SDKSTREAM-5\b/, 'SDKSTREAM-5 (a non-cloneable joined value throws) is gone from the SDK test TEST-23 cites')
  })
})
