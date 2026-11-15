// @vitest-environment jsdom
/**
 * TEST-DM-5 (notice half) — DemoNoticeBar (ITEM-5): the plan's headline
 * bytes in jsdom (the browser tier owns the measured layout):
 *  · present in demo mode, absent in desktop AND while the boot read is
 *    pending (no flash);
 *  · the exact plan text, the primary link to download_url (new tab,
 *    rel noopener), the secondary link to /help#demo, the close button with
 *    an accessible name;
 *  · closing hides it for the browser session (the store's sessionStorage)
 *    and a dismissed store renders none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DemoNoticeBar } from './DemoNoticeBar'
import {
  DEMO_BANNER_CLOSE,
  DEMO_BANNER_PRIMARY_ACTION,
  DEMO_BANNER_SECONDARY_ACTION,
  DEMO_BANNER_TEXT,
} from '../copy'
import { resetDemoMode, seedDemoMode } from '../test-utils/demoSeed'

beforeEach(() => {
  window.sessionStorage.clear()
  resetDemoMode()
})
afterEach(() => cleanup())

function renderBar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <DemoNoticeBar />
    </MemoryRouter>,
  )
}

describe('DemoNoticeBar (ITEM-5)', () => {
  it('renders the plan\'s text, the primary download link (new tab, noopener), the secondary help link and the close button', () => {
    seedDemoMode('demo', { downloadUrl: 'https://downloads.example.test/txresbench' })
    renderBar()
    expect(screen.getByTestId('txr-demo-notice').textContent).toContain(DEMO_BANNER_TEXT)
    const primary = screen.getByTestId('txr-demo-notice-download')
    expect(primary.textContent).toBe(DEMO_BANNER_PRIMARY_ACTION)
    expect(primary.getAttribute('href')).toBe('https://downloads.example.test/txresbench')
    expect(primary.getAttribute('target')).toBe('_blank')
    expect(primary.getAttribute('rel')).toBe('noopener noreferrer')
    const secondary = screen.getByTestId('txr-demo-notice-help')
    expect(secondary.textContent).toBe(DEMO_BANNER_SECONDARY_ACTION)
    expect(secondary.getAttribute('href')).toBe('/help#demo')
    const close = screen.getByTestId('txr-demo-notice-close')
    expect(close.getAttribute('aria-label')).toBe(DEMO_BANNER_CLOSE)
    // The bar is an accessible landmark with a name.
    expect(screen.getByRole('region', { name: 'Demo notice' })).toBeTruthy()
  })

  it('is absent in desktop mode', () => {
    seedDemoMode('desktop')
    renderBar()
    expect(screen.queryByTestId('txr-demo-notice')).toBeNull()
  })

  it('is absent while the boot read is pending (no flash)', () => {
    renderBar()
    expect(screen.queryByTestId('txr-demo-notice')).toBeNull()
  })

  it('closing hides it for the browser session (the store + sessionStorage)', () => {
    seedDemoMode('demo', { downloadUrl: 'https://downloads.example.test/txresbench' })
    renderBar()
    fireEvent.click(screen.getByTestId('txr-demo-notice-close'))
    expect(screen.queryByTestId('txr-demo-notice')).toBeNull()
    expect(window.sessionStorage.getItem('txr-demo-notice-dismissed')).toBe('1')
  })

  it('hides the primary button when the deployment left download_url empty (the text and secondary link stay)', () => {
    seedDemoMode('demo', { downloadUrl: '' })
    renderBar()
    expect(screen.queryByTestId('txr-demo-notice-download')).toBeNull()
    expect(screen.getByTestId('txr-demo-notice-help')).toBeTruthy()
  })

  it('a dismissed store renders nothing (the bar returns only in a new session)', () => {
    seedDemoMode('demo', { downloadUrl: 'https://downloads.example.test/x', noticeDismissed: true })
    renderBar()
    expect(screen.queryByTestId('txr-demo-notice')).toBeNull()
  })
})
