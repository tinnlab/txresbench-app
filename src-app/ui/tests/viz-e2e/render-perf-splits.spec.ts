// render-perf-splits.spec.ts — TEST-P9, the INV-11 checkpoint-ledger gate.
//
// THIS SPEC DID NOT EXIST UNTIL THE 2026-07-29 INTEGRITY SWEEP. TESTS.md named it as TEST-P9's
// home and as INV-11's only [acceptance] test for the whole feature, so for twenty splits INV-11
// had no mechanical gate at all: `scripts/render-perf-splits.json` was written by the harness and
// nothing ever read it back. DEC-39 records the sweep; this file closes the hole.
//
// IT ASSERTS THE **AMENDED** INV-11 (DEC-40), not the original. The original required a checkpoint
// per split with "all four fields GREEN". That criterion was proved UNSATISFIABLE by measurement:
// Splits 0a and 0b are red BY DESIGN — the decomposition exists to fix precisely the counters they
// fail (measured `CellView` 168 elements/wheel, TEST-P6 slope 29.1 elements/pane against a budget
// of 8) — and no honest ledger can show them green. The amended invariant is therefore:
//
//     Every declared checkpoint records its MEASURED state, green or red, PER FIELD, and the
//     trajectory is MONOTONE: no split may regress a counter or a structural threshold versus
//     its predecessor.
//
// That is what "every split is independently verifiable" actually means, and it is strictly harder
// to satisfy by accident than the original: a green-only rule is silent about the SHAPE of the
// trajectory, while monotonicity fails the moment any split makes any measured figure worse.
//
// WHY A `.spec.ts` UNDER THE PLAYWRIGHT CONFIG AND NOT A VITEST FILE. The final clause re-measures
// the tip's checkpoint LIVE, which needs a browser, the showcase origin on :1421 and the element
// counter. The ledger-shape clauses could live in vitest, but splitting the gate across two runners
// is how the ledger came to have no reader in the first place — one file, one runner.

import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  COUNTER_GAP_MS,
  COUNTER_STEPS,
  driveWheels,
  installElementCounter,
  openPerfStory,
  paneCentre,
  splitsLedgerPath,
} from './_renderPerf'

const GRID_DIR = new URL('../../../libs/viz/src/viz-core/grid/', import.meta.url).pathname
const SHELL = `${GRID_DIR}GridWorkspace.tsx`

/** The REPOSITORY ROOT — every `git` invocation below runs from here (FIX_ROUND-1 / C2).
 *
 *  A git PATHSPEC resolves relative to the CURRENT DIRECTORY, not to the repo root. TEST-P9e's
 *  staleness clause ran `git diff … -- src-app/libs/viz/src` with `cwd: GRID_DIR`, so the
 *  pathspec expanded to `…/viz-core/grid/src-app/libs/viz/src` — which matches nothing. `git
 *  diff` does not error on an unmatched pathspec, so `changed` was ALWAYS `[]` and
 *  `expect(changed).toEqual([])` could never fail. Measured on this tree, same command, same
 *  revisions: 0 files from `GRID_DIR`, 7 from the root. Every production file under
 *  `libs/viz/src` could change after a checkpoint was recorded and the "the checkpoint is
 *  STALE" gate stayed green. (TESTS.md's "RED-PROOF: 4/4" names P9a-P9d only; P9e was never
 *  red-proofed, which is exactly consistent with a clause that cannot go red.) */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: GRID_DIR,
  encoding: 'utf8',
}).trim()

/** The production source a checkpoint's figures describe, as a ROOT-RELATIVE pathspec. */
const VIZ_SRC_PATHSPEC = 'src-app/libs/viz/src'

/** The chrome components INV-1 forbids the camera from re-creating. Must match `render-perf.spec.ts`
 *  — the live re-run below reproduces TEST-P1's recorded figure, so a divergent list would compare
 *  two different measurements and call the difference a regression. */
const CHROME = ['PaneToolbar', 'CellView'] as const

/** The checkpoints this gate REQUIRES, in branch order. Declared as a literal rather than derived
 *  from the ledger, because a required-set read out of the file it is checking cannot fail: the
 *  ledger would define its own completeness and a dropped entry would silently shrink the
 *  requirement. Ordering is load-bearing — the monotonicity clause walks CONSECUTIVE pairs.
 *
 *  WHY THESE EIGHT AND NOT ALL TWENTY. These are the structurally significant checkpoints: the two
 *  pre-decomposition baselines (0a, 0b), the four original layer extractions (A-D), the
 *  whole-decomposition split (E), and the FINAL tip (T). The twelve intermediate plane extractions
 *  (F-S) are gated instead by `gridDecomposition.test.ts`, which carries a per-split shell-line
 *  ratchet that only ever moves DOWN plus a full structural manifest for each — a STRICTER
 *  per-split check than a ledger row, and one that runs in 700ms rather than ~4 minutes. Recorded
 *  scope limit, owner-approved on that basis (DEC-40).
 *
 *  THE RESIDUAL GAP THIS SPEC DOES **NOT** CLOSE — stated here because the alternative is a reader
 *  inferring from a green TEST-P9 that the ledger is complete. The ratchet covers the STRUCTURAL
 *  dimension ONLY. There is **no archived, monotone-checked per-split COUNTER record for F-S**, and
 *  TEST-P9d cannot walk one. The counter evidence for those twelve splits is:
 *    • WAVE-level counter-leg runs — ONE measurement per WAVE with that wave's tree final, not one
 *      per split (Wave-6's record is titled "(Splits P-T), measured once with the tree final");
 *    • the five per-split verification records for A-E, which is why those five are backfillable;
 *    • the final full 15-test run at the tip, which certifies the END STATE of the chain.
 *  Consequence, named rather than glossed: a counter regression introduced by one intermediate split
 *  and cancelled by a later one is invisible both to that evidence and to this gate. Closing it means
 *  12 further ~4-minute measurements; it is left OPEN. */
const REQUIRED_CHECKPOINTS = ['0a', '0b', 'A', 'B', 'C', 'D', 'E', 'T', 'FIX1', 'FIX2'] as const

/** The final checkpoint — the one re-measured live.
 *
 *  FIX_ROUND-1 / C2. `T` is NOT re-recorded and NOT overwritten: it holds the only MEASURED prod-ms
 *  ratio in the ledger (DEC-45, `msRatio: 0.17`), and re-recording it from a session that did not
 *  run the ms leg would replace a measurement with a null — destroying evidence to silence a gate.
 *  The fix round's tree gets its OWN checkpoint instead, and the monotonicity clause (P9d) then
 *  compares the fix round against the tip it was taken from, which is the property that actually
 *  matters: a fix round must not regress a counter either.
 *
 *  This became visible only once TEST-P9e's staleness clause could FAIL at all (it ran its pathspec
 *  from the wrong cwd, so it reported "not stale" for any change whatsoever).
 *
 *  FIX_ROUND-2 adds `FIX2` for the same reason, and this is the repaired P9e doing its job: the
 *  round changed production viz source (the `CellDisplay.store` record merge, 32 dead imports, a
 *  dead hook), so P9e went red naming those files and the checkpoint was RE-RECORDED rather than
 *  reasoned about. `FIX1` keeps its figures; P9d then compares FIX2 against it. */
const FINAL_CHECKPOINT = 'FIX2'

interface Contribution {
  readonly metric: string
  readonly value: number
  readonly budget: number
  readonly pass: boolean
}
interface Structural {
  readonly shellFileLines: number
  readonly shellBodyLines: number
  readonly finalCapFileLines: number
  readonly finalCapBodyLines: number
  readonly layersPresent: number
  readonly layersDeclared: number
  readonly meetsFinalCap: boolean
  readonly green: boolean
}
interface Checkpoint {
  readonly gitSha: string
  readonly recordedAt: string
  readonly recordedBy: string
  readonly counters: Record<string, Contribution>
  readonly countersGreen: boolean
  readonly structural: Structural
  readonly msRatio: number | null
  readonly behavioural: string | null
  readonly complete: boolean
}

const ledger = (): { splits: Record<string, Checkpoint> } =>
  JSON.parse(readFileSync(splitsLedgerPath(), 'utf8')) as { splits: Record<string, Checkpoint> }

/** The three counter legs every checkpoint must carry a MEASURED figure for. */
/** The declared checkpoints that are actually PRESENT. P9a owns the "a checkpoint is missing" verdict;
 *  every other clause iterates this instead of the raw declared list so a missing entry produces ONE
 *  clean, attributable failure rather than a `TypeError: Cannot read properties of undefined` in three
 *  sibling tests. Measured: deleting `D` used to red P9a/b/c/d, three of them by crash. A crash is a
 *  worse diagnostic than an assertion — it names the reader, not the defect. */
const present = (splits: Record<string, Checkpoint>): string[] =>
  REQUIRED_CHECKPOINTS.filter(n => splits[n] != null)

const COUNTER_LEGS = ['TEST-P1', 'TEST-P5', 'TEST-P6'] as const

/** Lower is better for every counter this feature gates on (elements/wheel, elements/pane slope,
 *  commits/wheel are all costs), so "regressed" is unambiguously "went UP". Stated as a function so
 *  a future counter whose good direction is UP has one place to declare itself. */
const regressed = (prev: number, next: number) => next > prev

/** Re-derive the component BODY line span exactly as the writer measures it. Duplicated on purpose:
 *  if the live re-derivation imported the writer's own delimiter logic, a broken delimiter would
 *  move BOTH the recorded and the re-measured figure and the comparison would pass. */
const shellBodyLines = (src: string): number => {
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.startsWith('export function GridWorkspace('))
  const end = lines.findIndex(l => l.includes('return <GridWorkspaceSeamProvider value={seam}>'))
  expect(start, 'the shell body opening must be locatable').toBeGreaterThanOrEqual(0)
  expect(end, 'the shell body closing must be locatable').toBeGreaterThanOrEqual(0)
  return end - start + 2
}

test.describe('render-perf — INV-11 checkpoint ledger (TEST-P9)', () => {
  // ── 1. one harness-written checkpoint per declared split ──────────────────────────────────
  test('TEST-P9a every declared split has a checkpoint, and the harness wrote it', () => {
    const { splits } = ledger()
    const missing = REQUIRED_CHECKPOINTS.filter(n => splits[n] == null)
    expect(
      missing,
      `these declared splits have NO ledger checkpoint: ${missing.join(', ')}. INV-11 is the ` +
        'per-split verifiability invariant — a split with no checkpoint was not independently ' +
        'verified, which is exactly the big-bang move the owner ruled out.',
    ).toEqual([])
    for (const name of present(splits)) {
      const c = splits[name]
      // `recordedBy` is the harness's own signature. A hand-authored entry is the failure mode
      // INV-11's "written BY the harness" clause exists to prevent, and it is the one a
      // shape-only check cannot see.
      expect(c.recordedBy, `${name} must be harness-written, not hand-authored`).toContain(
        'render-perf.spec.ts',
      )
      expect(Date.parse(c.recordedAt), `${name}.recordedAt must be a real timestamp`).not.toBeNaN()
    }
  })

  // ── 2. every gitSha resolves to a real commit reachable from this branch ──────────────────
  // A sha that resolves to nothing, or to a commit on some other branch, makes a checkpoint
  // unauditable: nobody can check out the tree the figures were measured against.
  test('TEST-P9b every checkpoint gitSha resolves to a real commit on this branch', () => {
    const { splits } = ledger()
    for (const name of present(splits)) {
      const sha = splits[name].gitSha
      expect(sha, `${name}.gitSha must be a full 40-hex sha`).toMatch(/^[0-9a-f]{40}$/)
      let type = ''
      try {
        type = execFileSync('git', ['cat-file', '-t', sha], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
      } catch {
        type = '<unresolvable>'
      }
      expect(type, `${name}.gitSha ${sha} must resolve to a commit object`).toBe('commit')
      // Reachability, not mere existence: `cat-file` also succeeds for a commit that was only ever
      // created in a detached probe and belongs to no branch.
      //
      // ASSERTED ON THE EXIT CODE (FIX_ROUND-2 / C11). This was
      // `expect(<stdout of merge-base --is-ancestor>).toBe('')` — and that command signals ONLY via
      // its exit code and ALWAYS prints nothing, so the assertion could never fail. The property was
      // enforced, but by `execFileSync`'s uncaught throw, which reds the test with a raw
      // child-process error instead of the message written here. The diagnostic was the part that
      // did not work.
      let isAncestor = false
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'ignore', 'ignore'],
        })
        isAncestor = true
      } catch {
        isAncestor = false
      }
      expect(
        isAncestor,
        `${name}.gitSha ${sha} must be an ANCESTOR of HEAD — a checkpoint measured against a tree ` +
          'nobody can check out is unauditable',
      ).toBe(true)
    }
  })

  // ── 3. per-field measured state present — green OR red, never absent ──────────────────────
  // This is the amended invariant's core. The original demanded green; this demands MEASURED.
  test('TEST-P9c every checkpoint carries a measured figure for all three counter legs', () => {
    const { splits } = ledger()
    for (const name of present(splits)) {
      const c = splits[name]
      for (const leg of COUNTER_LEGS) {
        const f = c.counters[leg]
        expect(f, `${name}.counters.${leg} must be present — a missing field is not a measurement`).toBeDefined()
        expect(typeof f.metric, `${name}.${leg}.metric`).toBe('string')
        expect(Number.isFinite(f.value), `${name}.${leg}.value must be a real number`).toBe(true)
        expect(Number.isFinite(f.budget), `${name}.${leg}.budget must be a real number`).toBe(true)
        expect(typeof f.pass, `${name}.${leg}.pass`).toBe('boolean')
        // `pass` must not CONTRADICT the figures it sits beside — a hand-set `pass:true` next to a
        // value over budget is the cheapest possible fabrication, and the one a shape-only check
        // waves through.
        //
        // Asserted as an IMPLICATION (`pass` ⇒ within budget), not an equality. Equality was the
        // first form written here and it is wrong in one direction: TEST-P6's `pass` is a
        // CONJUNCTION (`slope <= budget && elementsAt4Panes <= budget2`), so a tree with an
        // acceptable slope but an over-budget 4-pane leg legitimately records `pass:false` with
        // `value <= budget`, and an equality check would fire a false red with a misleading message.
        // The implication keeps the whole anti-fabrication property and drops the false red.
        if (f.pass) {
          expect(
            f.value,
            `${name}.${leg} claims pass:true but its value ${f.value} exceeds its budget ${f.budget} — ` +
              'a verdict that contradicts its own figures is fabricated',
          ).toBeLessThanOrEqual(f.budget)
        }
      }
      expect(
        c.countersGreen,
        `${name}.countersGreen must equal the AND of its three legs`,
      ).toBe(COUNTER_LEGS.every(l => c.counters[l].pass))
      for (const k of ['shellFileLines', 'shellBodyLines', 'layersPresent', 'layersDeclared'] as const) {
        expect(Number.isFinite(c.structural[k]), `${name}.structural.${k} must be measured`).toBe(true)
      }

      // ── THE THREE FIELDS NOTHING READ (FIX_ROUND-2 / C8) ─────────────────────────────────────
      // `complete`, `msRatio` and `behavioural` were declared on the `Checkpoint` interface purely
      // for typing: no clause consumed them, so the writer's stated rule — "a missing field is
      // INV-11's own definition of not landed" — was documented and unenforced. On the committed
      // ledger `behavioural` is null in 8/8, `msRatio` in 7/8 and `complete` is FALSE in 8/8, and
      // TEST-P9 was green regardless.
      //
      // What is gated is the HONESTY of the fields, not their filled-ness: this round did not run
      // the ms leg or the behavioural sweep, and demanding they be non-null would be demanding a
      // measurement nobody made — the exact fabrication pressure the writer refuses. So:
      //   * a null is allowed and MEANS not-measured;
      //   * a non-null must be a REAL value of its type (never '' or NaN — C18's empty-string hole);
      //   * `complete` must equal the conjunction it claims to be, so it cannot be set independently
      //     of the fields it summarizes.
      expect(
        c.msRatio === null || Number.isFinite(c.msRatio),
        `${name}.msRatio must be null (not measured) or a finite number — got ${JSON.stringify(c.msRatio)}`,
      ).toBe(true)
      expect(
        c.behavioural === null || (typeof c.behavioural === 'string' && c.behavioural.trim().length > 0),
        `${name}.behavioural must be null (not measured) or a non-empty string — an empty string is a ` +
          `plausible value standing in for a hole. Got ${JSON.stringify(c.behavioural)}`,
      ).toBe(true)
      expect(
        c.complete,
        `${name}.complete must equal countersGreen && structural.green && msRatio!=null && ` +
          'behavioural!=null — a `complete` that does not summarize its own fields is a claim, not a record',
      ).toBe(c.countersGreen && c.structural.green && c.msRatio !== null && c.behavioural !== null)
    }
  })

  // ── 4. the trajectory is MONOTONE across consecutive checkpoints ──────────────────────────
  test('TEST-P9d no split regresses a counter or a structural threshold versus its predecessor', () => {
    const { splits } = ledger()
    const chain = present(splits)
    for (let i = 1; i < chain.length; i++) {
      const prevName = chain[i - 1]
      const name = chain[i]
      const prev = splits[prevName]
      const cur = splits[name]
      for (const leg of COUNTER_LEGS) {
        expect(
          regressed(prev.counters[leg].value, cur.counters[leg].value),
          `${name} REGRESSED ${leg} versus ${prevName}: ${prev.counters[leg].value} -> ` +
            `${cur.counters[leg].value} (${cur.counters[leg].metric}). INV-11 requires a monotone ` +
            'trajectory; a split that makes a measured cost worse is regrowth.',
        ).toBe(false)
      }
      for (const k of ['shellFileLines', 'shellBodyLines'] as const) {
        expect(
          cur.structural[k],
          `${name}.structural.${k} rose versus ${prevName} (${prev.structural[k]} -> ` +
            `${cur.structural[k]}) — the shell must never grow back`,
        ).toBeLessThanOrEqual(prev.structural[k])
      }
      // A layer may be added but never LOST: a checkpoint with fewer layers than its predecessor
      // means an extraction was reverted.
      expect(
        cur.structural.layersPresent,
        `${name} lost a layer versus ${prevName}`,
      ).toBeGreaterThanOrEqual(prev.structural.layersPresent)
    }
  })

  // ── 5. the FINAL checkpoint reproduces LIVE ───────────────────────────────────────────────
  // The clause that makes the ledger more than paperwork: a recorded figure nobody can reproduce
  // is a claim, not a measurement. Structural fields are re-derived from the working tree; the
  // TEST-P1 counter is re-driven in a real browser.
  test('TEST-P9e the final checkpoint re-derives from the working tree', () => {
    const cur = ledger().splits[FINAL_CHECKPOINT]
    const src = readFileSync(SHELL, 'utf8')
    expect(
      src.split('\n').length,
      `${FINAL_CHECKPOINT}.structural.shellFileLines does not match the tree — the ledger is stale`,
    ).toBe(cur.structural.shellFileLines)
    expect(shellBodyLines(src), `${FINAL_CHECKPOINT}.structural.shellBodyLines does not match`).toBe(
      cur.structural.shellBodyLines,
    )
    // …and the PRODUCTION viz source must not have moved since the checkpoint was recorded, else
    // the figures describe a tree nobody is running any more.
    //
    // Deliberately NOT `gitSha === HEAD`. That was the first form written here and it is wrong: it
    // goes red on the next commit of ANY kind — a doc edit, a lifecycle record, a change to this
    // very spec — which would train whoever hits it to re-record the checkpoint to silence it, i.e.
    // to treat re-measurement as a formality. The property that actually matters is that the
    // measured SOURCE is unchanged. `*.test.ts` is excluded because a unit-test edit cannot move a
    // render counter; a change to shipped source can.
    //
    // NON-VACUITY, FIRST: the pathspec must MATCH SOMETHING. An unmatched pathspec is not an error
    // in git — it is an empty result, and an empty result is this clause's PASS. That is precisely
    // how it came to be unfalsifiable, so the precondition is asserted rather than assumed, and
    // asserted against the same cwd the diff uses.
    const tracked = execFileSync('git', ['ls-files', '--', VIZ_SRC_PATHSPEC], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => f.length > 0)
    expect(
      tracked.length,
      `the pathspec '${VIZ_SRC_PATHSPEC}' matched NO tracked file from ${REPO_ROOT} — git does not ` +
        'error on an unmatched pathspec, it returns nothing, and "nothing changed" is this ' +
        "clause's pass. The staleness gate would be unfalsifiable.",
    ).toBeGreaterThan(50)
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', cur.gitSha, 'HEAD', '--', VIZ_SRC_PATHSPEC],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(f => f.length > 0 && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
    expect(
      changed,
      `production viz source changed since '${FINAL_CHECKPOINT}' was recorded at ${cur.gitSha.slice(0, 8)}: ` +
        `${changed.join(', ')}. The checkpoint is STALE — re-record it rather than reasoning about ` +
        'whether the change could have moved a counter.',
    ).toEqual([])
  })

  test('TEST-P9f the final checkpoint TEST-P1 counter reproduces live', async ({ page }) => {
    test.setTimeout(220_000)
    const recorded = ledger().splits[FINAL_CHECKPOINT].counters['TEST-P1']
    const counter = await installElementCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    // Without this the counter can read 0 because it was never spliced in — a perfect false green,
    // and the reason `assertApplied` exists at all.
    counter.assertApplied()

    await counter.begin()
    await driveWheels(page, { ...(await paneCentre(page, 0)), steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const r = await counter.end()
    const live = CHROME.reduce((n, name) => n + (r.byComponent[name] ?? 0), 0)

    // eslint-disable-next-line no-console
    console.log(`[TEST-P9f] recorded=${recorded.value} live=${live} (${recorded.metric})`)
    expect(
      live,
      `the ledger records ${recorded.value} ${recorded.metric} for '${FINAL_CHECKPOINT}' but a live ` +
        `re-drive measures ${live}. Either the ledger is stale or the tip regressed — both are ` +
        'INV-11 failures, and the ledger existing is not evidence that it is true.',
    ).toBe(recorded.value)
  })
})
