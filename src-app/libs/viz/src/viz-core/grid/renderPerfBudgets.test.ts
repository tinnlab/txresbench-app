// renderPerfBudgets.test.ts — TEST-2 (covers ITEM-10).
//
// The budgets file is the ONE place the perf gate and the recorded baseline meet, so the failure
// mode worth guarding is not "a budget is wrong" but "a budget is a NO-OP".
//
// ── A CORRECTION OF RECORD (FIX_ROUND-2 / C12) ───────────────────────────────────────────────────
// This header used to state that a MISSING budget key "surfaces in Playwright as
// `expect(x).toBeLessThanOrEqual(undefined)`, a comparison that quietly passes for any x". That is
// FALSE, and it was verified false rather than argued: expect's numeric matchers run `ensureNumbers`
// and THROW on a non-number expected value. Driven under this repo's own Playwright:
//     expect(5).toBeLessThanOrEqual(budgets.missingKey)
//     → THREW: expect(received).toBeLessThanOrEqual(expected)
// So a key a spec reads but the file lacks fails LOUDLY on the first run. The hazard this file
// actually defends against is the OPPOSITE direction, and the old list had it: a budget key that NO
// spec reads is an inert number that looks like a gate — `overflowElementsWhenNothingFolds` was
// exactly that (present, listed here as "read by a spec", read by none until TEST-P4 was wired to
// it). Both directions are now DERIVED from the spec sources, so neither list can be wrong.
//
// Everything is checked mechanically over the whole `budgets` block — never a hand-list, so a
// budget added later cannot skip the check by not being enumerated.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUDGETS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/render-perf-budgets.json',
)

interface BudgetsFile {
  baseline: Record<string, number | string>
  budgets: Record<string, number>
  recordedMs: Record<string, number | string>
  structural: Record<string, unknown>
  machine: Record<string, unknown>
}

const load = (): BudgetsFile => JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as BudgetsFile

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../ui/tests/viz-e2e')

/** Every key a spec ACTUALLY reads off `budgets`, DERIVED by scanning the spec sources for
 *  `BUDGETS.budgets.<key>` (FIX_ROUND-2 / C12). A hand-list here could be — and was — wrong in the
 *  direction that matters: it named a key no spec read, so "every key a spec reads" described
 *  something other than what the list contained. */
const keysReadBySpecs = (): string[] => {
  const files = readdirSync(SPEC_DIR).filter(f => /\.(spec\.)?ts$/.test(f))
  // Non-vacuity: if this path ever moves, the scan must FAIL rather than report an empty set (an
  // empty set makes every clause below trivially true — this file's own subject matter).
  expect(files.length, `no spec sources found at ${SPEC_DIR} — the derivation is broken, not empty`).toBeGreaterThan(5)
  const keys = new Set<string>()
  for (const f of files) {
    for (const m of readFileSync(join(SPEC_DIR, f), 'utf8').matchAll(/BUDGETS\.budgets\.(\w+)/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

describe('render-perf budgets file (TEST-2)', () => {
  it('parses and carries the four blocks the gate reads', () => {
    const f = load()
    expect(f.baseline).toBeTypeOf('object')
    expect(f.budgets).toBeTypeOf('object')
    expect(f.structural).toBeTypeOf('object')
    expect(f.machine).toBeTypeOf('object')
    expect(f.baseline.gitSha, 'a baseline with no ref is not a measurement').toBeTruthy()
    expect(f.baseline.capturedAt).toBeTruthy()
  })

  it('every key the specs read exists and is a finite number', () => {
    const { budgets } = load()
    const read = keysReadBySpecs()
    expect(read.length, 'the specs must read SOME budget key').toBeGreaterThan(3)
    for (const k of read) {
      expect(budgets[k], `budgets.${k} is read by a spec and must exist`).toBeTypeOf('number')
      expect(Number.isFinite(budgets[k])).toBe(true)
    }
  })

  // The direction the hand-list got wrong. A budget nothing reads is not a gate: editing it changes
  // no verdict, while the file presents it as one.
  it('every budget is READ by at least one spec (no inert gates)', () => {
    const { budgets } = load()
    const read = new Set(keysReadBySpecs())
    const inert = Object.keys(budgets).filter(k => !read.has(k))
    expect(
      inert,
      `these budgets are read by NO spec, so editing them changes no verdict: ${inert.join(', ')}`,
    ).toEqual([])
  })

  it('every budget is STRICTER than its own baseline (no no-op gates)', () => {
    const { budgets, baseline } = load()
    const keys = Object.keys(budgets)
    // Non-vacuity: the loop below is only meaningful if there is something to loop over, and if
    // every budget genuinely has a baseline twin.
    expect(keys.length).toBeGreaterThanOrEqual(keysReadBySpecs().length)
    for (const k of keys) {
      const b = baseline[k]
      expect(b, `budgets.${k} has no baseline.${k} — its strictness is unverifiable`).toBeTypeOf('number')
      expect(
        budgets[k],
        `budgets.${k} (${budgets[k]}) must be STRICTLY BELOW baseline.${k} (${b}) — a budget at or above its own baseline passes on the defect`,
      ).toBeLessThan(b as number)
    }
  })

  it('the structural ratchet targets are below the measured pre-split sizes', () => {
    const s = load().structural as Record<string, number | string[]>
    expect(s.gridWorkspaceBodyLines as number).toBeLessThan(s.gridWorkspaceBodyLinesBaseline as number)
    expect(s.gridWorkspaceFileLines as number).toBeLessThan(s.gridWorkspaceFileLinesBaseline as number)
    expect(s.layerFiles as string[]).toHaveLength(5)
  })

  it('records milliseconds but never gates on them (DEC-3)', () => {
    const f = load()
    // The ms figures live in their own block precisely so no spec can accidentally read one as a
    // budget. If a millisecond key ever appears under `budgets`, the load-swinging shared box this
    // runs on becomes able to fail the gate for reasons unrelated to the code.
    for (const k of Object.keys(f.budgets)) {
      expect(/ms$|Ms$|milli/i.test(k), `budgets.${k} looks like a millisecond gate — DEC-3 forbids it`).toBe(false)
    }
    expect(f.recordedMs.scriptMs).toBeTypeOf('number')
    expect(f.recordedMs.controlScriptMs).toBeTypeOf('number')
  })
})
