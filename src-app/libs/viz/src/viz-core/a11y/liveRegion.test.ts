// liveRegion.test.ts — L0 unit tests for the ARIA-live announcement builders + the
// debounced LiveRegion controller (node env, injected element — no browser).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  announceSelection,
  announceViewChange,
  announceCellFocus,
  announceEmpty,
  LiveRegion,
  type LiveRegionElement,
} from './liveRegion'

describe('announcement message builders', () => {
  it('announceSelection formats with grouped numbers', () => {
    expect(announceSelection(5021, 200000)).toBe('Selected 5,021 of 200,000 points')
  })

  it('announceSelection pluralizes the noun on the total', () => {
    expect(announceSelection(1, 1)).toBe('Selected 1 of 1 point')
    expect(announceSelection(0, 2)).toBe('Selected 0 of 2 points')
  })

  it('announceSelection truncates fractional inputs', () => {
    expect(announceSelection(3.9, 10.2)).toBe('Selected 3 of 10 points')
  })

  it('announceViewChange picks in/out/reset by delta sign', () => {
    expect(announceViewChange(1)).toBe('Zoomed in')
    expect(announceViewChange(0.5)).toBe('Zoomed in')
    expect(announceViewChange(-1)).toBe('Zoomed out')
    expect(announceViewChange(0)).toBe('View reset')
  })

  it('announceCellFocus is 1-based and grouped', () => {
    expect(announceCellFocus(0, 200000)).toBe('Point 1 of 200,000')
    expect(announceCellFocus(5, 200000)).toBe('Point 6 of 200,000')
  })

  it('announceEmpty is a fixed cleared message', () => {
    expect(announceEmpty()).toBe('Selection cleared')
  })

  it('wording is domain-agnostic (says "point", never "cell")', () => {
    const all = [
      announceSelection(1, 2),
      announceViewChange(1),
      announceCellFocus(0, 2),
      announceEmpty(),
    ].join(' ')
    expect(all.toLowerCase()).not.toContain('cell')
  })
})

describe('LiveRegion controller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fakeEl(): LiveRegionElement {
    return { textContent: '' }
  }

  it('defaults to polite politeness', () => {
    expect(new LiveRegion().politeness).toBe('polite')
    expect(new LiveRegion({ politeness: 'assertive' }).politeness).toBe('assertive')
  })

  it('writes the message to the attached element after the debounce', () => {
    const el = fakeEl()
    const lr = new LiveRegion({ debounceMs: 150 })
    lr.attach(el)
    lr.announce('Selected 5 of 10 points')
    expect(el.textContent).toBe('') // not yet — still within debounce window
    vi.advanceTimersByTime(150)
    expect(el.textContent).toBe('Selected 5 of 10 points')
  })

  it('debounces a burst to only the last message (single write)', () => {
    // an element whose setter counts writes, so we prove the burst collapses to ONE write
    let writes = 0
    let value: string | null = ''
    const el: LiveRegionElement = {
      get textContent() {
        return value
      },
      set textContent(v: string | null) {
        writes++
        value = v
      },
    }
    const lr = new LiveRegion({ debounceMs: 100 })
    lr.attach(el)
    lr.announce('a')
    lr.announce('b')
    lr.announce('c')
    expect(writes).toBe(0) // nothing written mid-burst
    vi.advanceTimersByTime(100)
    expect(el.textContent).toBe('c')
    expect(writes).toBe(1)
  })

  it('flush writes immediately and cancels the pending timer', () => {
    const el = fakeEl()
    const lr = new LiveRegion({ debounceMs: 1000 })
    lr.attach(el)
    lr.announce('now')
    lr.flush()
    expect(el.textContent).toBe('now')
    // advancing past the original window does not double-write
    vi.advanceTimersByTime(1000)
    expect(el.textContent).toBe('now')
  })

  it('is a no-op when no element is attached', () => {
    const lr = new LiveRegion({ debounceMs: 10 })
    lr.announce('nobody home')
    expect(() => vi.advanceTimersByTime(10)).not.toThrow()
  })

  it('dispose cancels a pending announcement', () => {
    const el = fakeEl()
    const lr = new LiveRegion({ debounceMs: 100 })
    lr.attach(el)
    lr.announce('never')
    lr.dispose()
    vi.advanceTimersByTime(100)
    expect(el.textContent).toBe('')
  })
})
