// @vitest-environment jsdom
/**
 * TEST-HELP-3 — the Help page render (ITEM-4, TEST-QA-4): every section and
 * every problem-code entry renders, the TOC links every anchor it names, the
 * deep link scrolls to its entry, and the page carries the code entries the
 * intake problems list links to.
 *
 * The page is router-bound (`Link` + `useLocation`), so the tests render it
 * under a MemoryRouter; `scrollIntoView` does not exist in jsdom and is
 * stubbed (the scroll behavior itself is asserted only in the browser spec
 * — the gallery test drives the real element scroll).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HELP_SECTIONS, PROBLEM_HELP } from '../content'
import { helpPath } from '../routes'
import { HelpPage } from './HelpPage'

function renderHelp(initialEntries: string[] = ['/help']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <HelpPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('HelpPage render (TEST-HELP-3)', () => {
  it('renders the page shell: eyebrow, title and every section heading', () => {
    renderHelp()
    expect(screen.getByTestId('txr-help')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Help'])
    for (const section of HELP_SECTIONS) {
      const el = screen.getByTestId(`txr-help-section-${section.id}`)
      expect(within(el).getByRole('heading', { level: 2 }).textContent).toBe(section.title)
    }
  })

  it('renders one entry per closed problem code, with its meaning and action', () => {
    renderHelp()
    for (const entry of PROBLEM_HELP) {
      const el = screen.getByTestId(`txr-help-problem-${entry.anchor}`)
      expect(within(el).getByRole('heading', { level: 3 }).textContent).toContain(entry.code)
      expect(within(el).getByText(entry.meaning)).toBeTruthy()
      // The action line mixes a styled lead + the action text, so the
      // matcher walks the paragraph's full text content (getByText's text
      // node matcher would see the <strong> lead as a child element).
      expect(
        within(el).getByText(
          (_content, element) =>
            element?.tagName === 'P' && element.textContent === `What to do: ${entry.action}`,
        ),
      ).toBeTruthy()
    }
  })

  it('the table of contents links every section anchor, and every anchor resolves', () => {
    renderHelp()
    const toc = screen.getByRole('navigation', { name: 'On this page' })
    for (const section of HELP_SECTIONS) {
      const link = within(toc).getByTestId(`txr-help-toc-${section.id}`)
      expect(link.getAttribute('href')).toContain(`#${section.id}`)
      expect(document.getElementById(section.id)).not.toBeNull()
    }
    for (const entry of PROBLEM_HELP) {
      expect(document.getElementById(entry.anchor)).not.toBeNull()
    }
  })

  it('a deep link scrolls its entry into view (the intake problems link target)', () => {
    renderHelp(['/help#problem-r03'])
    const target = document.getElementById('problem-r03')
    expect(target).not.toBeNull()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    // The scrolled element is the entry itself, not a stale node.
    expect(target!.getAttribute('data-testid')).toBe('txr-help-problem-problem-r03')
  })

  it('the intake link target equals the entry anchor for every closed code', () => {
    renderHelp()
    for (const entry of PROBLEM_HELP) {
      expect(helpPath(`problem-${entry.code.toLowerCase()}`)).toBe(`/help#${entry.anchor}`)
    }
  })
})
