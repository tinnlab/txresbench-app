// @vitest-environment jsdom
/**
 * TEST-HELP-3 — the Help page render (qa-fixes2 ITEM-3, TEST-QF2-2): one h1,
 * every section and every problem-code entry renders, the TOC links every
 * anchor it names, the deep link scrolls to its entry AND expands it, the
 * quick-start row + status vocabulary + file cards render, the search
 * filters and restores, the no-results state clears, and the document title
 * is "Help — TxResBench".
 *
 * The page is router-bound (`Link` + `useLocation`), so the tests render it
 * under a MemoryRouter; `scrollIntoView` does not exist in jsdom and is
 * stubbed (the scroll behaviour itself is asserted in the browser spec — the
 * gallery test drives the real element scroll and the measured layout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HELP_SECTIONS, PROBLEM_HELP, QUICK_START } from '../content'
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
  document.title = 'TxResBench'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('HelpPage render (TEST-HELP-3)', () => {
  it('renders the page shell: one h1, the purpose, the quick-start row and every section heading', () => {
    renderHelp()
    expect(screen.getByTestId('txr-help')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Help'])
    expect(screen.getByTestId('txr-help-purpose').textContent).toContain('TxResBench')
    for (const card of QUICK_START) {
      expect(screen.getByTestId(`txr-help-quickstart-${card.id}`).textContent).toContain(card.title)
      expect(screen.getByTestId(`txr-help-quickstart-cta-${card.id}`).textContent).toContain(card.cta)
    }
    for (const section of HELP_SECTIONS) {
      const el = screen.getByTestId(`txr-help-section-${section.id}`)
      expect(within(el).getByRole('heading', { level: 2 }).textContent).toBe(section.title)
    }
  })

  it('sets the document title to "Help — TxResBench"', () => {
    renderHelp()
    expect(document.title).toBe('Help — TxResBench')
  })

  it('renders one entry per closed problem code, with its meaning and action', () => {
    renderHelp()
    for (const entry of PROBLEM_HELP) {
      const el = screen.getByTestId(`txr-help-problem-${entry.anchor}`)
      expect(within(el).getByTestId(`txr-help-code-chip-${entry.code}`).textContent).toBe(entry.code)
      expect(within(el).getByTestId(`txr-help-accordion-trigger-${entry.code}`).textContent).toContain(
        entry.title,
      )
      // The meaning/action lines are inside the collapsed panel, still in
      // the DOM (the accordion hides, never unmounts).
      expect(el.textContent).toContain(entry.meaning)
      expect(el.textContent).toContain(`What to do: ${entry.action}`)
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

  it('the rail wires the section-heading observer, and the first section is current at rest (ITEM-6)', () => {
    // jsdom has no IntersectionObserver and no layout (the real spy — the
    // per-section scroll answer — is the browser tier's measure); this
    // guards the wiring: the page observes every section heading and starts
    // on the first section.
    const instances: Array<{ callback: IntersectionObserverCallback; observed: Element[] }> = []
    class FakeIntersectionObserver {
      callback: IntersectionObserverCallback
      observed: Element[] = []
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        instances.push(this)
      }
      observe(target: Element) {
        this.observed.push(target)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    // jsdom lays out nothing: without a model, every section's
    // getBoundingClientRect returns 0 and the spy would claim the LAST
    // section. Give the sections far-below tops so the at-rest answer is
    // the honest first-section fallback.
    const realRect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.id !== '' && HELP_SECTIONS.some(s => s.id === this.id)) {
        return { top: 1000, bottom: 1000, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      return realRect.call(this)
    })
    renderHelp()
    const spy = instances[0]
    expect(spy).toBeTruthy()
    expect(spy.observed.length).toBe(HELP_SECTIONS.length)
    const toc = screen.getByRole('navigation', { name: 'On this page' })
    expect(
      within(toc)
        .getAllByRole('link')
        .find(link => link.getAttribute('aria-current') === 'true')!
        .getAttribute('data-testid'),
    ).toBe('txr-help-toc-overview')
  })

  it('a deep link scrolls its entry into view and expands it (the intake problems link target)', () => {
    renderHelp(['/help#problem-r03'])
    const target = document.getElementById('problem-r03')
    expect(target).not.toBeNull()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    // The scrolled element is the entry itself, not a stale node.
    expect(target!.getAttribute('data-testid')).toBe('txr-help-problem-problem-r03')
    // The entry is OPEN (the trigger's aria-expanded reads true).
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="txr-help-accordion-trigger-R03"]',
    )!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('the intake link target equals the entry anchor for every closed code', () => {
    renderHelp()
    for (const entry of PROBLEM_HELP) {
      expect(helpPath(`problem-${entry.code.toLowerCase()}`)).toBe(`/help#${entry.anchor}`)
    }
  })

  it('renders the status vocabulary: the three eligibility verdicts and the eight run states', () => {
    renderHelp()
    const statuses = screen.getByTestId('txr-help-statuses')
    for (const key of ['can', 'some', 'cannot']) {
      expect(within(statuses).getByTestId(`txr-help-status-eligibility-${key}`)).toBeTruthy()
    }
    for (const state of ['waiting', 'downloading', 'running', 'finished', 'failed', 'stopped', 'skipped', 'cannot_run']) {
      expect(within(statuses).getByTestId(`txr-help-status-state-${state}`)).toBeTruthy()
    }
  })

  it('renders the two file cards with their column tables and required/optional pills', () => {
    renderHelp()
    const patients = screen.getByTestId('txr-help-filecard-patients')
    expect(within(patients).getByTestId('txr-help-column-patient-id-required')).toBeTruthy()
    expect(within(patients).getByTestId('txr-help-column-responder-optional')).toBeTruthy()
    expect(within(patients).getByTestId('txr-help-copy-example-patients')).toBeTruthy()
    const measurements = screen.getByTestId('txr-help-filecard-measurements')
    expect(within(measurements).getByTestId('txr-help-column-unit-optional')).toBeTruthy()
    expect(within(measurements).getByTestId('txr-help-download-template-measurements')).toBeTruthy()
  })

  it('the search filters sections and troubleshooting entries, and the clear button restores', () => {
    renderHelp()
    const input = screen.getByTestId('txr-help-search-input') as HTMLInputElement
    // A word in one section only: the search narrows to it.
    const fireChange = (value: string): void => {
      // fireEvent.change runs the native value-setter trick (a controlled
      // React input ignores a direct `input.value =` write).
      fireEvent.change(input, { target: { value } })
    }
    fireChange('duplicate')
    // R07's entry survives, a clear section is hidden.
    expect(screen.getByTestId('txr-help-section-troubleshooting')).toBeTruthy()
    expect(screen.getByTestId('txr-help-problem-problem-r07')).toBeTruthy()
    expect(screen.queryByTestId('txr-help-section-models')).toBeNull()
    // No match at all → the no-results state, and the button restores.
    fireChange('zzzzzz')
    expect(screen.getByTestId('txr-help-no-results')).toBeTruthy()
    const clear = screen.getByTestId('txr-help-clear-search')
    expect(clear).toBeTruthy()
    fireChange('')
    expect(screen.queryByTestId('txr-help-no-results')).toBeNull()
  })

  it('carries the accessibility landmarks and the skip link', () => {
    renderHelp()
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeTruthy()
    expect(screen.getByRole('search')).toBeTruthy()
    const skip = document.querySelector<HTMLAnchorElement>('.txr-help-skip-link')!
    expect(skip.getAttribute('href')).toBe('#txr-help-content')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})
