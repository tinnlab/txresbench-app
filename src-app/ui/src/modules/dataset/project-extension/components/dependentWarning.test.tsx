// @vitest-environment jsdom
// ITEM-39 — the dependent-analysis warning on the detach confirmation (INV-10, first half).
//
// The hazard this suite exists for, from the stage plan: **an always-zero count renders
// IDENTICALLY to a correct one in the empty case.** So a test that only checks "nothing is
// shown when nothing depends on it" passes against a hardcoded `0` and certifies the defect.
// Every assertion below therefore names WHICH state produced the silence, and the populated
// case is asserted before any of them.

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DependentCount } from '@/api-client/types'
import { dependentWarning } from './DatasetsPanel'

const shown = (state: DependentCount | 'loading' | 'unavailable' | undefined): string | null => {
  const { container, unmount } = render(<div>{dependentWarning(state).node}</div>)
  const text = container.textContent?.trim() ?? ''
  const out = text === '' ? null : text
  unmount()
  return out
}

describe('a REAL count is warned about', () => {
  it('names the number, and says the analyses are kept', () => {
    render(<div>{dependentWarning({ kind: 'counted', count: 3 }).node}</div>)
    const el = screen.getByTestId('detach-dependent-warning')
    expect(el.textContent).toBe('3 analyses in this project used this dataset.')
    // INV-10's first half is not just the count — it is that the work SURVIVES. A warning that
    // says "3 analyses used this" without saying they are kept reads as "3 things are about to
    // be destroyed", which is the opposite of what detach does.
    expect(el.parentElement?.textContent).toMatch(/kept, not deleted/i)
    expect(el.parentElement?.textContent).toMatch(/re-attach/i)
  })

  it('is singular for one', () => {
    expect(shown({ kind: 'counted', count: 1 })).toMatch(/^1 analysis in this project/)
  })
})

describe('the three SILENT states, each named — an always-zero build must fail here', () => {
  // The populated case above is what makes these meaningful: without it, every assertion in
  // this block is satisfied by a function that returns null unconditionally.
  it('a real ZERO warns about nothing', () => {
    // True, and not a warning. Dressing "no analyses used this" as a warning trains users to
    // click past the sentence that matters.
    expect(shown({ kind: 'counted', count: 0 })).toBeNull()
  })

  it('CANNOT_COMPUTE renders NO NUMBER — never 0', () => {
    const state: DependentCount = { kind: 'cannot_compute', reason: 'no recorded runs' }
    const out = shown(state)
    expect(out).toBeNull()
    // The assertion that actually matters, stated positively: whatever this renders, it must
    // not contain a digit. A future edit that "helpfully" shows `0` or the reason with a count
    // in it goes red here even if it stops returning null.
    expect(out ?? '').not.toMatch(/\d/)
  })

  it('a FAILED request renders no number either, and is a DISTINCT state from cannot_compute', () => {
    expect(shown('unavailable')).toBeNull()
    // Distinctness asserted where it EXISTS, not on the rendered output — both render nothing
    // by design, so an output comparison can only ever agree.
    expect(dependentWarning('unavailable').silence).toBe('unavailable')
    expect(dependentWarning({ kind: 'cannot_compute', reason: 'x' }).silence).toBe('cannot_compute')
  })

  it('says nothing before the answer arrives', () => {
    expect(shown(undefined)).toBeNull()
    expect(shown('loading')).toBeNull()
  })
})

describe('the CONTROL the plan names — a hardcoded 0 must not pass', () => {
  // "hardcode `0` → the seeded-project test goes red. This is the control that matters: an
  // always-zero count renders identically to a correct one in the empty case."
  //
  // Written as the property rather than as a mutation: the function must DISTINGUISH a
  // populated count from every silent state. A build that always returned null, or always
  // rendered 0, fails this in one direction or the other.
  it('distinguishes a populated count from every silent state', () => {
    const populated = shown({ kind: 'counted', count: 2 })
    expect(populated).toBeTruthy()
    // ── THE MUTATION THAT SURVIVED THE FIRST VERSION OF THIS SUITE ────────────────────
    //
    // Treating `cannot_compute` as `{count: 0}` changed NOTHING observable: both render
    // nothing, so every output-level assertion passed. The plan warned about exactly this
    // ("an always-zero count renders identically to a correct one in the empty case") and
    // the mutation proved it against my own tests.
    //
    // So the four silent states are asserted to remain FOUR. This is the assertion that
    // goes red when cannot-compute is quietly turned into a zero.
    expect(dependentWarning({ kind: 'cannot_compute', reason: 'r' }).silence).toBe('cannot_compute')
    expect(dependentWarning({ kind: 'counted', count: 0 }).silence).toBe('zero')
    expect(dependentWarning('unavailable').silence).toBe('unavailable')
    expect(dependentWarning('loading').silence).toBe('pending')
    expect(dependentWarning({ kind: 'counted', count: 2 }).silence).toBeNull()
    expect(
      new Set(
        [
          dependentWarning({ kind: 'cannot_compute', reason: 'r' }).silence,
          dependentWarning({ kind: 'counted', count: 0 }).silence,
          dependentWarning('unavailable').silence,
          dependentWarning('loading').silence,
        ],
      ).size,
      'two silent states collapsed into one — the distinction the union exists for is gone',
    ).toBe(4)
    for (const silent of [
      { kind: 'counted', count: 0 } as DependentCount,
      { kind: 'cannot_compute', reason: 'no recorded runs' } as DependentCount,
      'unavailable' as const,
      'loading' as const,
      undefined,
    ]) {
      expect(shown(silent), `state ${JSON.stringify(silent)} must not read like a count`).not.toBe(
        populated,
      )
    }
  })
})

// ── M3 — THE WIRING, WHICH NO TEST REACHED ───────────────────────────────────────────────
//
// Every test above exercises the pure renderer. Removing the `onOpenChange` that FETCHES the
// count left the whole suite green (3347/3347): in the app the count would never be requested,
// the state would sit at `pending`, and the user would detach with NO WARNING AT ALL.
//
// The control that removes the warning NODE is caught; the control that removes the REQUEST is
// not — a warning that is never asked for is indistinguishable, from the renderer's side, from
// one that is correctly silent. So this asserts the source declares the fetch on the same
// control that opens the prompt, which is the seam the renderer cannot see.
describe('the count is actually REQUESTED when the prompt opens', () => {
  // Path from the vitest root (`src-app/ui`). `import.meta.url` is not a file URL under the
  // jsdom environment this file declares, so resolving it there throws before any test runs.
  const panel = readFileSync(
    'src/modules/dataset/project-extension/components/DatasetsPanel.tsx',
    'utf8',
  )
  // Comments stripped: this file's own prose names the identifiers, and a raw-text guard would
  // pass on its own documentation (the mistake this branch made twice).
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')

  it('the detach Confirm declares an open-handler that loads the dependents', () => {
    expect(code, 'the loader is gone').toMatch(/loadDependents\s*=/)
    // The REQUEST must be wired to the prompt opening, not merely defined.
    expect(code, 'nothing calls loadDependents — the count is never requested').toMatch(
      /onOpenChange=\{[^}]*loadDependents\(/s,
    )
    // …and it must be the DETACH prompt that carries it: the same Confirm whose description
    // renders the warning. Asserting only that some handler exists would pass if it were wired
    // to an unrelated control.
    const confirmBlock = code.slice(code.indexOf('project-dataset-detach-confirm') - 2000, code.indexOf('project-dataset-detach-confirm'))
    expect(confirmBlock, 'the fetch is not on the detach confirmation').toMatch(/loadDependents\(/)
    expect(confirmBlock, 'the warning is not rendered by the detach confirmation').toMatch(/dependentWarning\(/)
  })

  it('the guard reads CODE, not comments (positive control for the stripper)', () => {
    expect(panel).toMatch(/loadDependents/)
    expect(code).toMatch(/loadDependents/)
    // The stripper must remove prose but keep code — a stripper that ate everything would make
    // every assertion above vacuous.
    expect(code).toMatch(/onOpenChange=/)
  })
})
