// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotFoundPage } from './NotFoundPage'

/**
 * TEST-QF2-3 (R2-G2) — the not-found screen's byte: the one h1, the sentence,
 * the attempted address, the one way out, and the document title it sets
 * ("Page not found — TxResBench"). The ROUTER facts (an unknown URL renders
 * this instead of redirecting to `/`) are the full-backend spec's job — the
 * module system + route ranking only exist under the real app.
 */

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <NotFoundPage />
    </MemoryRouter>,
  )
}

describe('txrshell NotFoundPage (R2-G2)', () => {
  it('renders the heading, the sentence, the address and the one way out', () => {
    renderAt('/nope')

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByTestId('txr-not-found-text').textContent).toContain(
      'There is no page at this address',
    )
    expect(screen.getByText('/nope')).toBeTruthy()
    expect(screen.getByTestId('txr-not-found-home').textContent).toBe('Back to the start')
    cleanup()
  })

  it('names whatever address the router matched (never an app constant)', () => {
    renderAt('/models/foo')
    expect(screen.getByText('/models/foo')).toBeTruthy()
    cleanup()
  })

  it('owns the one main landmark (the shell layout provides no second main)', () => {
    const { container } = renderAt('/nope')
    expect(container.querySelector('main')).not.toBeNull()
    expect(container.querySelectorAll('main')).toHaveLength(1)
    cleanup()
  })

  it('is the frame byte — the ONE body region, no fixed top/bottom (app-shell ITEM-3)', () => {
    const { container } = renderAt('/nope')
    const region = container.querySelector('[role="region"]')
    expect(region, 'the block sits in the page\'s one ScrollRegion').not.toBeNull()
    expect(region!.getAttribute('aria-label')).toBe('Not found')
    expect(container.querySelectorAll('[role="region"]')).toHaveLength(1)
    expect(container.querySelectorAll('[class*="txr-page-frame-top"]')).toHaveLength(0)
    expect(container.querySelectorAll('[class*="txr-page-frame-bottom"]')).toHaveLength(0)
    // The block is inside the region (the region scrolls, never the page).
    const block = container.querySelector('[data-testid="txr-not-found-text"]')
    expect(region!.contains(block)).toBe(true)
    cleanup()
  })

  it('sets the document title to "Page not found — TxResBench" and restores it on unmount', () => {
    document.title = 'TxResBench'
    const { unmount } = renderAt('/nope')
    expect(document.title).toBe('Page not found \u2014 TxResBench')
    unmount()
    expect(document.title).toBe('TxResBench')
  })
})
