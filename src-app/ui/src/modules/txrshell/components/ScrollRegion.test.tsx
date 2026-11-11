// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { regionEdges, scrollByPage, scrollToEdge, ScrollRegion } from './ScrollRegion'
import { clearScrollCache, getScrollPosition, saveScrollPosition } from '../lib/scrollCache'

/**
 * TEST-AS-1 (region half) — the ScrollRegion's structure + pure mechanics.
 * jsdom does no layout and has no ResizeObserver, so the scroll behaviour
 * (PageDown/Space/Home/End, the shadow cues, restore on back) is driven by
 * the pure functions here; the REAL scrolling proof is the browser tier
 * (`txr-shell-primitives.spec.ts`).
 */
afterEach(() => {
  cleanup()
  clearScrollCache()
})

describe('regionEdges (TEST-AS-1)', () => {
  it('reports overflow and at-start/at-end truth for the shadow cues', () => {
    expect(regionEdges({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 })).toEqual({
      overflow: false,
      atStart: true,
      atEnd: true,
    })
    expect(regionEdges({ scrollTop: 0, clientHeight: 400, scrollHeight: 2000 })).toEqual({
      overflow: true,
      atStart: true,
      atEnd: false,
    })
    // A scroll of exactly one pixel counts as at-start (the cue threshold).
    expect(regionEdges({ scrollTop: 1, clientHeight: 400, scrollHeight: 2000 }).atStart).toBe(
      true,
    )
    expect(regionEdges({ scrollTop: 1600, clientHeight: 400, scrollHeight: 2000 })).toEqual({
      overflow: true,
      atStart: false,
      atEnd: true,
    })
    expect(regionEdges({ scrollTop: 800, clientHeight: 400, scrollHeight: 2000 })).toEqual({
      overflow: true,
      atStart: false,
      atEnd: false,
    })
  })
})

describe('scrollByPage / scrollToEdge (TEST-AS-1)', () => {
  it('moves one page down and up, clamped to the content edges', () => {
    const m = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000 }
    scrollByPage(m, 1)
    expect(m.scrollTop).toBe(Math.round(400 * 0.9))
    scrollByPage(m, -1)
    expect(m.scrollTop).toBe(0)
    // Clamped at the bottom.
    m.scrollTop = 1950
    scrollByPage(m, 1)
    expect(m.scrollTop <= m.scrollHeight - m.clientHeight).toBe(true)
    expect(m.scrollTop).toBe(1600)
  })

  it('jumps to either edge', () => {
    const m = { scrollTop: 800, clientHeight: 400, scrollHeight: 2000 }
    scrollToEdge(m, 'start')
    expect(m.scrollTop).toBe(0)
    scrollToEdge(m, 'end')
    expect(m.scrollTop).toBe(1600)
  })
})

describe('ScrollRegion render (TEST-AS-1)', () => {
  function renderRegion() {
    return render(
      <MemoryRouter initialEntries={['/files']}>
        <ScrollRegion label="The two file cards">
          <div>content</div>
        </ScrollRegion>
      </MemoryRouter>,
    )
  }

  it('is a focusable, labelled region with stable-gutter overflow', () => {
    renderRegion()
    const region = screen.getByTestId('txr-scroll-region')
    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('aria-label')).toBe('The two file cards')
    expect(region.tabIndex).toBe(0)
    expect(region.style.overflowY).toBe('auto')
    expect(region.style.scrollbarGutter).toBe('stable')
    // The two shadow cues are painted (opacity carries the state).
    expect(screen.getByTestId('txr-scroll-region-shadow-top').getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(screen.getByTestId('txr-scroll-region-shadow-bottom')).not.toBeNull()
  })

  it('a scroll updates the cache under the route+label key', () => {
    renderRegion()
    const region = screen.getByTestId('txr-scroll-region')
    act(() => {
      // jsdom lets a scrollTop be assigned; the listener is attached and
      // fires on the event dispatch only — so the cache write is driven
      // through the same event the browser fires.
      region.dispatchEvent(new Event('scroll'))
    })
    // No layout in jsdom: scrollTop stayed 0, which is a remembered value.
    expect(getScrollPosition('/files#The two file cards')).toBe(0)
  })

  it('restores the remembered position on mount (the Back rule)', () => {
    saveScrollPosition('/files#The two file cards', 320)
    render(
      <MemoryRouter initialEntries={['/files']}>
        <ScrollRegion label="The two file cards">
          <div>content</div>
        </ScrollRegion>
      </MemoryRouter>,
    )
    // jsdom lets scrollTop be assigned; the mount-time restore wrote it.
    expect(screen.getByTestId('txr-scroll-region').scrollTop).toBe(320)
  })
})
