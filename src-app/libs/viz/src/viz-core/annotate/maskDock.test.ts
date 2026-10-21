// maskDock.test.ts — the pure dock decision for the OPEN segment cells' `MaskReviewControls`.
// The twin of `annotateDock.test.ts`: portal when the host resolver returns an element for that
// pane, internal when it returns null/undefined, empty off-primary / out of segment mode / none open.
//
// REWRITTEN for annotate-tooling-ux ITEM-9 (TEST-9): the resolver returns a LIST, one dock per open
// pane, so two segment panes can be reviewed side by side — the shipped single-`activeMaskCellId`
// form made that impossible.

import { describe, it, expect } from 'vitest'
import { resolveMaskDocks } from './maskDock'

const hostA = { nodeType: 1 } as unknown as HTMLElement
const hostB = { nodeType: 1 } as unknown as HTMLElement

describe('resolveMaskDocks (TEST-9)', () => {
  it('TEST-9: returns ONE dock PER OPEN PANE (INV-12 multiplicity)', () => {
    const docks = resolveMaskDocks({
      isPrimaryContainer: true,
      segmentMode: true,
      openCellIds: ['cell1', 'cell2'],
      container: id => (id === 'cell1' ? hostA : hostB),
    })
    expect(docks).toEqual([
      { kind: 'portal', cellId: 'cell1', host: hostA },
      { kind: 'portal', cellId: 'cell2', host: hostB },
    ])
  })

  it('TEST-9: one pane OPEN while another is not — only the open one docks', () => {
    const docks = resolveMaskDocks({
      isPrimaryContainer: true,
      segmentMode: true,
      openCellIds: ['cell2'], // cell1 exists in the grid but its controls are closed
      container: () => null,
    })
    expect(docks).toEqual([{ kind: 'internal', cellId: 'cell2' }])
  })

  it('TEST-9: MIXES portal and internal per pane', () => {
    const docks = resolveMaskDocks({
      isPrimaryContainer: true,
      segmentMode: true,
      openCellIds: ['cell1', 'cell2'],
      container: id => (id === 'cell1' ? hostA : null),
    })
    expect(docks).toEqual([
      { kind: 'portal', cellId: 'cell1', host: hostA },
      { kind: 'internal', cellId: 'cell2' },
    ])
  })

  it('the container resolver is invoked ONCE PER OPEN PANE with that pane id', () => {
    const seen: string[] = []
    resolveMaskDocks({
      isPrimaryContainer: true,
      segmentMode: true,
      openCellIds: ['a', 'b'],
      container: id => {
        seen.push(id)
        return null
      },
    })
    expect(seen).toEqual(['a', 'b'])
  })

  it('falls back to the internal panel when the resolver returns null/undefined or is absent', () => {
    expect(resolveMaskDocks({ isPrimaryContainer: true, segmentMode: true, openCellIds: ['c'], container: () => null }))
      .toEqual([{ kind: 'internal', cellId: 'c' }])
    expect(resolveMaskDocks({ isPrimaryContainer: true, segmentMode: true, openCellIds: ['c'], container: () => undefined }))
      .toEqual([{ kind: 'internal', cellId: 'c' }])
    expect(resolveMaskDocks({ isPrimaryContainer: true, segmentMode: true, openCellIds: ['c'] }))
      .toEqual([{ kind: 'internal', cellId: 'c' }])
  })

  it('is EMPTY off the primary container, out of segment mode, or with none open', () => {
    const base = { openCellIds: ['c'], container: () => hostA } as const
    expect(resolveMaskDocks({ ...base, isPrimaryContainer: false, segmentMode: true })).toEqual([])
    expect(resolveMaskDocks({ ...base, isPrimaryContainer: true, segmentMode: false })).toEqual([])
    expect(resolveMaskDocks({ isPrimaryContainer: true, segmentMode: true, openCellIds: [], container: () => hostA }))
      .toEqual([])
  })
})
