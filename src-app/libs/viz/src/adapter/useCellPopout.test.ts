// useCellPopout.test.ts — node-testable logic of the per-cell pop-out registry. The pop-out itself is
// the portal-move engine (windowPortal); this registry only holds the shared "which cells are popped
// out" state (for cross-cell drag guards + placeholders), marked/cleared by the portal on open/close.

import { describe, it, expect } from 'vitest'
import { CellPopoutRegistry } from './useCellPopout'

describe('CellPopoutRegistry', () => {
  it('marks / clears a cell popped-out', () => {
    const r = new CellPopoutRegistry()
    expect(r.isPoppedOut('cell-1')).toBe(false)

    r.markPoppedOut('cell-1')
    expect(r.isPoppedOut('cell-1')).toBe(true)

    r.clearPoppedOut('cell-1')
    expect(r.isPoppedOut('cell-1')).toBe(false)
  })

  it('markPoppedOut is idempotent (no double-publish)', () => {
    const r = new CellPopoutRegistry()
    let notified = 0
    r.subscribe(() => {
      notified += 1
    })
    r.markPoppedOut('cell-1')
    r.markPoppedOut('cell-1')
    expect(notified).toBe(1)
    expect(r.isPoppedOut('cell-1')).toBe(true)
  })

  it('clearPoppedOut is a no-op for an untracked cell', () => {
    const r = new CellPopoutRegistry()
    let notified = 0
    r.subscribe(() => {
      notified += 1
    })
    r.clearPoppedOut('never')
    expect(notified).toBe(0)
    expect(r.isPoppedOut('never')).toBe(false)
  })

  it('tracks multiple cells independently', () => {
    const r = new CellPopoutRegistry()
    r.markPoppedOut('a')
    r.markPoppedOut('b')
    expect(r.isPoppedOut('a')).toBe(true)
    expect(r.isPoppedOut('b')).toBe(true)
    r.clearPoppedOut('a')
    expect(r.isPoppedOut('a')).toBe(false)
    expect(r.isPoppedOut('b')).toBe(true)
  })

  it('notifies subscribers and publishes a FRESH snapshot on each change', () => {
    const r = new CellPopoutRegistry()
    let notified = 0
    const off = r.subscribe(() => {
      notified += 1
    })
    const before = r.getSnapshot()

    r.markPoppedOut('cell-1')
    const after = r.getSnapshot()
    expect(notified).toBe(1)
    expect(after).not.toBe(before) // new Set reference → useSyncExternalStore re-renders
    expect(after.has('cell-1')).toBe(true)

    r.clearPoppedOut('cell-1')
    expect(notified).toBe(2)
    expect(r.getSnapshot().has('cell-1')).toBe(false)

    off()
    r.markPoppedOut('cell-2')
    expect(notified).toBe(2) // unsubscribed → not notified
  })
})
