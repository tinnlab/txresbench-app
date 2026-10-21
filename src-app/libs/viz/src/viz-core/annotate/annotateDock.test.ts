// annotateDock.test.ts — the pure DOCK-seam decision for the OPEN cells' AnnotateControls panels.
// Asserts the `annotateControlsContainer` seam is honored exactly like the edit-form seam: portal
// when the host resolver returns an element FOR THAT PANE, else fall back to the internal right
// panel. (The full GridWorkspace render is deck.gl-backed and can't run under the node-only vitest
// harness, so the portal-vs-internal branch is factored into this pure function and tested directly.)
//
// REWRITTEN for annotate-tooling-ux ITEM-9 (TEST-8): the resolver returns a LIST, one dock per open
// pane. The shipped single-dock form is the defect — it copied `editFormContainer`'s signature while
// inverting its per-pane semantics, so N datasets side by side could only ever show ONE panel.

import { describe, it, expect } from 'vitest'
import { resolveAnnotateDocks } from './annotateDock'

// Stand-ins for real DOM elements — the decision only checks truthiness of the host.
const HOST_A = {} as HTMLElement
const HOST_B = {} as HTMLElement

describe('resolveAnnotateDocks — annotateControlsContainer seam (per pane)', () => {
  it('TEST-8: returns ONE dock PER OPEN PANE (INV-12 multiplicity)', () => {
    const docks = resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['cell-1', 'cell-2'],
      container: id => (id === 'cell-1' ? HOST_A : HOST_B),
    })
    expect(docks).toEqual([
      { kind: 'portal', cellId: 'cell-1', host: HOST_A },
      { kind: 'portal', cellId: 'cell-2', host: HOST_B },
    ])
  })

  it('TEST-8: MIXES portal and internal per pane — the host may host one and not the other', () => {
    const docks = resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['cell-1', 'cell-2'],
      // host provides a container for cell-2 ONLY
      container: id => (id === 'cell-2' ? HOST_B : null),
    })
    expect(docks).toEqual([
      { kind: 'internal', cellId: 'cell-1' },
      { kind: 'portal', cellId: 'cell-2', host: HOST_B },
    ])
  })

  it('TEST-8: the container resolver is invoked ONCE PER OPEN PANE, with that pane id', () => {
    const seen: string[] = []
    resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['a', 'b', 'c'],
      container: id => {
        seen.push(id)
        return null
      },
    })
    // NOT once for a "focused" pane — once for each, which is the whole contract.
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('falls back to the INTERNAL right panel when no resolver is provided (byte-identical to pre-seam)', () => {
    const docks = resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['cell-1'],
    })
    expect(docks).toEqual([{ kind: 'internal', cellId: 'cell-1' }])
  })

  it('falls back to INTERNAL when the resolver returns null/undefined', () => {
    for (const ret of [null, undefined] as const) {
      const docks = resolveAnnotateDocks({
        isPrimaryContainer: true,
        annotateMode: true,
        openCellIds: ['cell-1'],
        container: () => ret,
      })
      expect(docks).toEqual([{ kind: 'internal', cellId: 'cell-1' }])
    }
  })

  it('is EMPTY off the primary container, out of annotate mode, or with no pane open', () => {
    const base = { openCellIds: ['cell-1'], container: () => HOST_A } as const
    expect(resolveAnnotateDocks({ ...base, isPrimaryContainer: false, annotateMode: true })).toEqual([])
    expect(resolveAnnotateDocks({ ...base, isPrimaryContainer: true, annotateMode: false })).toEqual([])
    expect(
      resolveAnnotateDocks({ isPrimaryContainer: true, annotateMode: true, openCellIds: [], container: () => HOST_A }),
    ).toEqual([])
  })

  it('preserves the caller-supplied ORDER (grid order, not Set insertion order)', () => {
    const docks = resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['z', 'a', 'm'],
    })
    expect(docks.map(d => d.cellId)).toEqual(['z', 'a', 'm'])
  })

  it('TEST-24: the two-pane story configuration resolves to TWO INDEPENDENT docks', () => {
    // Guards the showcase story against silently regressing to a single panel.
    const docks = resolveAnnotateDocks({
      isPrimaryContainer: true,
      annotateMode: true,
      openCellIds: ['pane-a', 'pane-b'],
      container: () => null,
    })
    expect(docks).toHaveLength(2)
    expect(new Set(docks.map(d => d.cellId)).size).toBe(2)
  })
})
