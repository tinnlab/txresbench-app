// designConformance.test.ts — the design-token contract, judged by the REPO'S OWN LINT.
//
// FIX_ROUND-3. The phase-6 blind audit ran nine reviewer angles and none of them was
// `design-conformance`; when it was finally run over the 11 changed `.tsx` files it found exactly
// one NEW violation — this package's `showcase/stories/render-perf.story.tsx`, the only
// from-scratch UI surface the branch authored. Its pane-count pills carried
//   `border: '1px solid #ccc'`, `background: … '#3355dd' : '#f2f2f2'`, `color: … '#fff' : '#222'`
// in an inline `style`, which is three separate forbidden patterns at once (an arbitrary color
// value, an inline style color prop, and a hardcoded brand blue standing in for the runtime accent
// `--primary`). The strip was theme-blind: `#f2f2f2` on `#222` inverts to unreadable under dark.
//
// ── WHY THE ORACLE IS THE REAL LINT, NOT A REGEX HERE ────────────────────────────────────────────
// This package's standing lesson (C15, C17, C24, DEC-50) is that a hand-written source-scan for a
// SEMANTIC property has an unbounded evasion space. `sdk/packages/config/src/lint/hardcoded-colors.mjs`
// is a TypeScript-compiler-API AST check that the repo already owns and that generated the finding.
// Driving THAT binary makes this test agree with the repo's definition by construction instead of
// re-deriving it — and, per the design-conformance angle's own report, this test is the FIRST
// in-repo consumer of that lint for `src-app/libs/viz` (it is declared in
// `sdk/packages/config` but wired into no package's `check` script; see FIX_ROUND-3 DEC-60).
//
// ── SCOPE, and the number that bounds it ────────────────────────────────────────────────────────
// `showcase/stories/` carries 46 PRE-EXISTING violations across 24 files, none of which this branch
// may touch: DEC-18 rule 4 forbids restyling inside a pure-move commit, and these are not even
// moved — they are untouched siblings. So the scope is two clauses:
//   1. `render-perf.story.tsx` — the file this branch ADDED — must contribute ZERO.
//   2. the directory total must EQUAL 46.
//
// FIX_ROUND-4 / R4-1: clause 2 was `<= 47` and both numbers were wrong in the same direction. 47 is
// the PRE-fix count (46 + the one violation this round removed), transcribed as if it were the
// post-fix measurement — so the ceiling shipped with exactly one unit of slack and permitted the
// first new hardcoded color it was written to stop. It is now an EQUALITY, which fixes the slack and
// a second hole in the same clause: `<=` has no lower bound, so a renamed `stories/` (the lint's
// `findFiles` returns [] for a missing dir, exit 0) would have satisfied `0 <= 47` on an empty
// subject. `toBe(46)` fails in both directions, which is the only form that cannot pass vacuously.
// The cost is that fixing a pre-existing violation now reds this line until the number is lowered —
// that is the intended direction of travel and it is one character.
//
// ── AND A POSITIVE CONTROL ──────────────────────────────────────────────────────────────────────
// A lint invoked with a bad path, or one whose `typescript` require fails, exits 0 and prints
// "✓ no hardcoded colors". That is indistinguishable from a clean tree — the comfortable zero this
// package refuses everywhere else (`assertApplied`, `wheelAckQuantiles`, TEST-P6's per-leg premise).
// So every run first proves the lint CAN see a violation, against a fixture minted here.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** src-app/libs/viz/src/showcase → up 5 → the repo root that owns `sdk/`. */
const REPO = path.resolve(HERE, '../../../../..')
const LINT = path.join(REPO, 'sdk/packages/config/src/lint/hardcoded-colors.mjs')
const STORIES = path.resolve(HERE, 'stories')

/** The branch's own story — the design-conformance angle's single NEW finding. */
const SUBJECT = 'render-perf.story.tsx'
/** Measured 2026-07-30 over `showcase/stories/` WITH the fix in place, at HEAD: 46 violations across
 *  24 files, none of them the subject. Re-derive with
 *  `node sdk/packages/config/src/lint/hardcoded-colors.mjs --root=src-app/libs/viz/src/showcase/stories`. */
const PRE_EXISTING = 46

/** Run the lint over `root`; return one `file:line:col  msg` string per violation. */
function violations(root: string): string[] {
  let out = ''
  try {
    out = execFileSync(process.execPath, [LINT, `--root=${root}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return [] // exit 0 ⇒ clean
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string }
    if (err.status !== 1)
      throw new Error(
        `the design lint did not run (exit ${err.status}); a lint that cannot start reports a ` +
          `comfortable zero. stderr:\n${err.stderr ?? ''}\nstdout:\n${err.stdout ?? out}`,
      )
    return (err.stderr ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^\S+\.(tsx|jsx):\d+:\d+\s/.test(l))
  }
}

describe('design-conformance — hardcoded colors, judged by sdk/packages/config’s own lint', () => {
  it('POSITIVE CONTROL: the lint can see a violation (never trust its zero)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-control-'))
    try {
      mkdirSync(path.join(root, 'nested'))
      writeFileSync(
        path.join(root, 'nested', 'bait.tsx'),
        'export const Bait = () => <div style={{ background: "#3355dd", color: "#fff" }} className="bg-blue-500" />\n',
      )
      const v = violations(root)
      expect(
        v.length,
        'the lint reported CLEAN on a file with an inline style color AND a raw Tailwind hue — ' +
          'it is not actually inspecting anything, so every other clause here is vacuous',
      ).toBeGreaterThan(0)
      expect(v.join('\n')).toMatch(/bait\.tsx/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it(`${SUBJECT} — the file this branch ADDED — contributes zero violations`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dc-subject-'))
    try {
      copyFileSync(path.join(STORIES, SUBJECT), path.join(root, SUBJECT))
      expect(violations(root), `${SUBJECT} must use semantic tokens, not raw hues / arbitrary values / inline style colors`).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it(`showcase/stories carries EXACTLY the recorded ${PRE_EXISTING} pre-existing violations`, () => {
    const v = violations(STORIES)
    expect(v.some(l => l.includes(SUBJECT)), `${SUBJECT} appears in the directory sweep too`).toBe(false)
    expect(
      v.length,
      `hardcoded-color violations in showcase/stories MOVED off the recorded baseline. Above ${PRE_EXISTING} ` +
        `means a new violation was added; below it means one was fixed (lower the constant) or the sweep ` +
        `found nothing to look at (a renamed directory reads as 0). Reported:\n${v.join('\n')}`,
    ).toBe(PRE_EXISTING)
  })
})
