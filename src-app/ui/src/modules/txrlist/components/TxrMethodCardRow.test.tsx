// @vitest-environment jsdom
/**
 * step4 fixes ITEM-5 — the row's More/Less summary control (the measured
 * clamp, never the old 120-character rule): the button shows only while the
 * two-line-clamped `<p>` is actually cut (`scrollHeight > clientHeight + 1`),
 * toggles More ↔ Less with `aria-expanded`, is re-measured on a resize
 * (jsdom has no ResizeObserver, so the window `resize` fallback — the same
 * guard the ScrollRegion precedent uses), and never toggles the row's
 * checkbox (the row handler ignores nested interactive targets).
 *
 * jsdom has no layout, so the geometry is stubbed via `Object.defineProperty`
 * on `HTMLElement.prototype` (restored after each test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TxrMethodCard } from '../types'
import { TxrMethodCardRowView } from './TxrMethodCardRow'

/** One card whose support is minimal (the row renders exactly its facts). */
function card(over: Partial<TxrMethodCard> & { id: string }): TxrMethodCard {
  const { id, ...rest } = over
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group: 'response-probability',
    groupLabel: 'Response probability',
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '10.0000/txr.demo',
    estimate: { seconds: 120, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates: 'covariates optional', draws: '1+ draws' },
    run: {
      status: 'can',
      coverageLine: 'all 151 patients',
      reasonCode: null,
      reasonLine: 'all 151 patients',
      reasonLines: ['all 151 patients'],
      reasonFix: '',
      disabled: false,
    },
    ...rest,
  }
}

const CARD = card({ id: 'x1', title: 'Test method' })

/** The stub geometry every element reads while a test runs. */
let geometry = { scroll: 0, client: 0 }
let originals: { scrollHeight?: PropertyDescriptor; clientHeight?: PropertyDescriptor } = {}

beforeEach(() => {
  originals = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scroll,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => geometry.client,
  })
})

afterEach(() => {
  cleanup()
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor !== undefined) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
  originals = {}
})

describe('the summary More/Less control (measured clamp, not the 120-char rule)', () => {
  it('a really cut summary shows More; clicking it expands (More → Less) and folds back (Less → More)', () => {
    geometry = { scroll: 60, client: 20 }
    render(<TxrMethodCardRowView card={CARD} checked={false} onToggle={() => {}} />)
    const more = screen.getByTestId('txr-method-summary-more-x1')
    expect(more.textContent).toBe('More')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    // While collapsed, the `<p>` wears the two-line clamp.
    expect(screen.getByTestId('txr-method-summary-x1').style.display).toBe('-webkit-box')

    fireEvent.click(more)
    const less = screen.getByTestId('txr-method-summary-more-x1')
    expect(less.textContent).toBe('Less')
    expect(less.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('txr-method-summary-x1').style.display).toBe('')

    // The same button folds it back.
    fireEvent.click(less)
    const again = screen.getByTestId('txr-method-summary-more-x1')
    expect(again.textContent).toBe('More')
    expect(again.getAttribute('aria-expanded')).toBe('false')
  })

  it('a summary that fits shows no button — even a long one (the old 120-char rule must not decide)', () => {
    geometry = { scroll: 20, client: 20 }
    const long = card({ id: 'long', title: 'Long', summary: 'A '.repeat(400) })
    render(<TxrMethodCardRowView card={long} checked={false} onToggle={() => {}} />)
    expect(long.summary.length).toBeGreaterThan(120)
    expect(screen.queryByTestId('txr-method-summary-more-long')).toBeNull()
  })

  it('a window resize re-measures: a summary that becomes cut shows More, and one that fits again hides it', () => {
    geometry = { scroll: 60, client: 20 }
    render(<TxrMethodCardRowView card={CARD} checked={false} onToggle={() => {}} />)
    expect(screen.getByTestId('txr-method-summary-more-x1')).toBeTruthy()

    geometry = { scroll: 20, client: 20 }
    fireEvent(window, new Event('resize'))
    expect(screen.queryByTestId('txr-method-summary-more-x1')).toBeNull()

    geometry = { scroll: 80, client: 20 }
    fireEvent(window, new Event('resize'))
    expect(screen.getByTestId('txr-method-summary-more-x1')).toBeTruthy()
  })

  it('clicking (or keying) More/Less never toggles the row\'s checkbox; the row itself still toggles', () => {
    geometry = { scroll: 60, client: 20 }
    const onToggle = vi.fn()
    render(<TxrMethodCardRowView card={CARD} checked={false} onToggle={onToggle} />)
    const more = screen.getByTestId('txr-method-summary-more-x1')
    fireEvent.click(more)
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.keyDown(more, { key: 'Enter' })
    fireEvent.keyDown(more, { key: ' ' })
    expect(onToggle).not.toHaveBeenCalled()
    // The row's own click target still toggles (the row contract).
    fireEvent.click(screen.getByTestId('txr-method-card-x1'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(CARD)
  })
})
