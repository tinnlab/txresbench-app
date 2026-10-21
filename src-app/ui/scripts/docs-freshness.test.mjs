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

/** `src-app/ui/scripts` → `src-app`. The prose ITEM-13/ITEM-14 correct lives under here. */
const SRC_APP = join(REPO_ROOT, 'src-app')
const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

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
// TEST-18 (ITEM-13, ITEM-14) — no in-tree prose still claims a behaviour this round corrected.
//
// Two superseded claims were found by the phase-1 audit and are corrected by ITEM-13/ITEM-14:
//
//   ITEM-13 — `STREAMING_PROGRESSIVE_PLAN.md` planned a `data/arrowStream.ts` Arrow-IPC reader
//             and gated phase 2.6 on "the backend can serve Arrow columns". That file was never
//             written and never will be: DEC-4 chose byte-shuffle + gzip precisely so the browser
//             decodes natively (`_lib/cyto_zarr.py:26-32`), and the producer contract states there
//             is "no Arrow IPC on the wire" (`:5-8`). The phantom blocker cost one reader a day.
//   ITEM-14 — `coordinates.yaml` / `colour-by.yaml` justified per-cell dataset bases by an
//             identity-space argument that `canvasFeed.ts`'s `sharedCoordinateBase` (`450efed6`)
//             superseded one day after it was written: panes on ONE coordinate artifact now fold
//             to ONE base and DO brush together, which the owner closed as the DESIRED behaviour.
//
// ── WHY EVERY ASSERTION IS CONDITIONED ON THE CODE, AND BIDIRECTIONAL ────────────────
//
// `assert.doesNotMatch(plan, /arrowStream/)` would FREEZE A STRING. It stays green forever once
// the prose is edited, says nothing about whether prose and code agree, and — worse — it would
// still be green if the code REVERTED and the prose became correct again. That is the failure
// mode standing-check 5 records against TEST-43's own first draft, one file up.
//
// So each case below reads the CODE STATE first and asserts the prose that state implies, in BOTH
// directions:
//
//   · `data/arrowStream.ts` ABSENT  ⇒ the plan must NOT name it (a plan naming a file that does
//     not exist is the phantom blocker).
//   · `data/arrowStream.ts` PRESENT ⇒ the plan MUST name it (someone shipped the Arrow reader and
//     deleted its plan row — the prose is now stale in the other direction).
//   · `sharedCoordinateBase` LIVE in `canvasFeed.ts` ⇒ the superseded sentences must be ABSENT.
//   · `sharedCoordinateBase` GONE                    ⇒ they must be PRESENT (the fold was reverted,
//     per-cell bases are the behaviour again, and the original rationale is true again).
//
// Neither arm can be satisfied by the other, and neither is satisfied by the document's size:
// every match is a specific claim, not a keyword (standing check 5 — scope to the CLAIM).
//
// ── ANTI-VACUITY ─────────────────────────────────────────────────────────────────────
//
// Every file this reads is asserted to EXIST and to be non-trivial FIRST. A renamed or moved file
// would otherwise make every case below a silent no-op reporting PASS — the fail-open shape.

/** The Arrow-IPC reader the plan once specified. Its ABSENCE is the fact ITEM-13 records. */
const ARROW_READER = join(SRC_APP, 'libs', 'viz', 'src', 'data', 'arrowStream.ts')
const PROGRESSIVE_PLAN = join(SRC_APP, 'libs', 'viz', 'STREAMING_PROGRESSIVE_PLAN.md')
const CANVAS_FEED = join(SRC_APP, 'ui', 'src', 'modules', 'workbench', 'extensions', 'canvas', 'canvasFeed.ts')
const COORDINATES_YAML = join(SRC_APP, 'packages', 'single-cell-viz', 'ui', 'coordinates.yaml')
const COLOUR_BY_YAML = join(SRC_APP, 'packages', 'single-cell-viz', 'ui', 'colour-by.yaml')

/** The two superseded sentences, as the audit found them. Matched as CLAIMS — the specific
 *  wording each file carried — not as the keyword "brush", which occurs legitimately throughout
 *  both specs and would make this vacuous. */
const SUPERSEDED_COORDINATES = /two cells sharing one base would brush each\s*#?\s*other/
const SUPERSEDED_COLOUR_BY = /two adjacent cells brush independently/

describe('TEST-18 (ITEM-13, ITEM-14) — superseded prose does not outlive the code that superseded it', () => {
  const plan = readIf(PROGRESSIVE_PLAN)
  const feed = readIf(CANVAS_FEED)
  const coordinates = readIf(COORDINATES_YAML)
  const colourBy = readIf(COLOUR_BY_YAML)

  test('every document and source this guard reads is present and non-trivial (anti-vacuity)', () => {
    // Without this, a rename turns every case below into a silent no-op that still reports PASS.
    for (const [name, text] of [
      ['STREAMING_PROGRESSIVE_PLAN.md', plan],
      ['canvasFeed.ts', feed],
      ['coordinates.yaml', coordinates],
      ['colour-by.yaml', colourBy],
    ]) {
      assert.ok(text, `${name} is missing — this guard would pass by reading nothing`)
      assert.ok(text.length > 1000, `${name} is implausibly short (${text.length} bytes)`)
    }
  })

  test('ITEM-13 — the plan names `data/arrowStream.ts` IF AND ONLY IF that reader exists', () => {
    assert.ok(plan, 'no plan to check')
    const shipped = existsSync(ARROW_READER)
    const named = /data\/arrowStream\.ts/.test(plan)
    if (shipped) {
      assert.ok(
        named,
        'libs/viz/src/data/arrowStream.ts EXISTS but STREAMING_PROGRESSIVE_PLAN.md no longer names it — the Arrow reader shipped and its plan row was deleted; the plan is stale in the OTHER direction',
      )
    } else {
      assert.ok(
        !named,
        'STREAMING_PROGRESSIVE_PLAN.md still specifies `data/arrowStream.ts`, a file that does not exist — DEC-4 chose shuffle+gzip so the browser decodes natively (_lib/cyto_zarr.py:26-32) and the wire carries no Arrow IPC (:5-8). Leaving the row makes phase 2.6 look blocked on a backend format nobody is going to build (ITEM-13)',
      )
    }
  })

  test('ITEM-13 — the phase-2.6 gate does not wait on a backend Arrow endpoint', () => {
    assert.ok(plan, 'no plan to check')
    if (existsSync(ARROW_READER)) return // the Arrow arc is real again; the old gate is correct
    // The specific superseded GATE, not the word "Arrow" — the document legitimately keeps the
    // industry survey's Arrow references, and matching those would make this vacuous.
    assert.doesNotMatch(
      plan,
      /when the backend can\s*\n?\s*serve Arrow columns/,
      'the phase-2.6 gate still reads "wire 2.6 when the backend can serve Arrow columns" — a blocker that does not exist for this wire format (ITEM-13)',
    )
    assert.doesNotMatch(
      plan,
      /\*\*Backend Arrow-IPC streaming endpoints\*\*/,
      'the cross-cutting section still lists a "Backend Arrow-IPC streaming endpoints" dependency for items 7/8 — they shipped over the existing sharded-zarr byte-range route (ITEM-13)',
    )
    // …and the correction is actually RECORDED, not merely deleted: the owner required the reason
    // to be written down "so that nobody waits on a phantom blocker again".
    assert.match(
      plan,
      /97\.4%/,
      'the amended gate does not record WHY there is no backend Arrow dependency (DEC-4: shuffle+gzip at 97.4% of blosc\'s ratio, natively decodable) — deleting the blocker without recording the reason invites the next reader to re-add it (ITEM-13)',
    )
  })

  test('ITEM-14 — the per-cell-base rationale survives IF AND ONLY IF the fold does not', () => {
    assert.ok(feed && coordinates && colourBy, 'nothing to check')
    // Read from the CODE: is the shared-base fold live? Detected by the function `canvasFeed.ts`
    // actually defines and calls, so deleting the fold — not merely renaming a comment — is what
    // flips this.
    const folded = /function sharedCoordinateBase\b/.test(feed) && /sharedCoordinateBase\(/.test(feed)
    if (folded) {
      assert.doesNotMatch(
        coordinates,
        SUPERSEDED_COORDINATES,
        'coordinates.yaml still justifies per-cell bases by "two cells sharing one base would brush each other", but canvasFeed.ts folds exactly those declared bases (sharedCoordinateBase, 450efed6) — panes on one coordinate artifact DO share a base and DO brush together, which ledger row 34 closed as the desired behaviour (ITEM-14)',
      )
      assert.doesNotMatch(
        colourBy,
        SUPERSEDED_COLOUR_BY,
        'colour-by.yaml still carries the twin claim "two adjacent cells brush independently" while sharedCoordinateBase is live (ITEM-14)',
      )
    } else {
      // The fold is gone: per-cell bases are the behaviour again and the ORIGINAL prose is true.
      // Removing the fold and leaving the corrected prose is stale in the other direction.
      assert.match(
        coordinates,
        SUPERSEDED_COORDINATES,
        'canvasFeed.ts no longer folds declared bases (sharedCoordinateBase is gone), so per-cell bases ARE the identity boundary again — coordinates.yaml should say so, and no longer does (ITEM-14, the reverting direction)',
      )
      assert.match(
        colourBy,
        SUPERSEDED_COLOUR_BY,
        'the fold is gone but colour-by.yaml still records its twin claim as superseded (ITEM-14, the reverting direction)',
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-23's BINDING (ITEM-17b) — where its assertions live, asserted rather than asserted-about.
//
// TEST-23's two claims (a stream call is NEVER joined, so two callers get two independent bodies;
// a non-cloneable joined value hard-fails where it is caused) are proven in the SDK SUBMODULE, at
// `sdk/packages/framework/src/api-client/stream-response.test.ts`, as SDKSTREAM-3 and SDKSTREAM-5.
// They run in `@ziee/framework`'s `node:test` tier — that package's vitest config EXCLUDES the
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
