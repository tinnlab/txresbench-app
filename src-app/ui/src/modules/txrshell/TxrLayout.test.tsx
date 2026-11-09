// @vitest-environment jsdom
/**
 * TEST-QF-7 (X2 half) — the shell header's responsive structure.
 *
 * The QA measurement (X2/G-2/RES-26): at 390 px the tagline wrapped into five
 * clipped lines and the nav pushed History/Help off-screen (page scrollWidth
 * 526). The fix: theme tokens for the palette (the header must follow dark
 * mode with the pages) + the `.txr-shell-*` hooks the responsive block in
 * index.css keys on (tagline hidden under 900 px, header stacked into two
 * rows under 640 px — the board itself is desktop-only, DEC-2's board byte at
 * desktop is unchanged, and the narrow rules live in CSS because a media
 * query cannot touch an inline style).
 *
 * jsdom does not evaluate media queries or layout, so this pins the
 * STRUCTURE the rules key on + the token colours; the real 390 px
 * no-overflow assertion is the browser tier (`tests/gallery-e2e/` —
 * TEST-QF-7's phone arm, and the header's own e2e sweep in ITEM-8).
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TxrShell } from './TxrLayout'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('TxrShell header (TEST-QF-7, X2)', () => {
  function headerOf() {
    const view = render(
      <MemoryRouter initialEntries={['/']}>
        <TxrShell>
          <div data-testid="txr-shell-content" />
        </TxrShell>
      </MemoryRouter>,
    )
    return {
      view,
      header: view.container.querySelector<HTMLElement>('.txr-shell-header')!,
      brandGroup: view.container.querySelector<HTMLElement>('.txr-shell-brand-group')!,
      tagline: view.container.querySelector<HTMLElement>('.txr-shell-tagline')!,
      actions: view.container.querySelector<HTMLElement>('.txr-shell-actions')!,
      nav: view.container.querySelector<HTMLElement>('.txr-shell-nav')!,
    }
  }

  it('keeps the board header byte at desktop: brand + tagline left, nav + Help right, the four destinations', () => {
    const { header, brandGroup, tagline, actions, nav, view } = headerOf()
    expect(header).not.toBeNull()
    expect(brandGroup.contains(tagline)).toBe(true)
    expect(actions.contains(nav)).toBe(true)
    expect(nav.querySelectorAll('a.txr-nav-link')).toHaveLength(3)
    expect(nav.textContent).toContain('New analysis')
    expect(nav.textContent).toContain('Models')
    expect(nav.textContent).toContain('History')
    expect(actions.textContent).toContain('Help')
    // The palette goes through the app tokens — never a light hex that would
    // stay light in dark mode (RM-1).
    expect(header.style.background).toBe('var(--txr-surface-dim)')
    expect(header.style.borderBottom).toContain('var(--txr-border)')
    expect(view.container.querySelector<HTMLElement>('.txr-shell')!.style.background).toBe(
      'var(--txr-surface)',
    )
  })

  it('carries the responsive hooks the index.css block keys on (tagline + wrap + stack)', () => {
    const { header, brandGroup, tagline, actions, nav } = headerOf()
    // The class hooks the media rules select (index.css @media blocks).
    expect(header.className).toContain('txr-shell-header')
    expect(brandGroup.className).toContain('txr-shell-brand-group')
    expect(tagline.className).toContain('txr-shell-tagline')
    expect(actions.className).toContain('txr-shell-actions')
    expect(nav.className).toContain('txr-shell-nav')
  })

  it('the narrow rules exist in index.css: the tagline yields first, the header stacks below 640', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    expect(index).toContain('@media (max-width: 900px)')
    expect(/@media \(max-width: 900px\)\s*\{\s*\.txr-shell-tagline\s*\{[^}]*display: none/.test(index)).toBe(true)
    expect(/@media \(max-width: 640px\)\s*\{[^}]*\.txr-shell-header\s*\{[^}]*height: auto/.test(index)).toBe(true)
    expect(/\.txr-shell-actions\s*\{[^}]*flex: 1 1 100%/.test(index)).toBe(true)
  })
})
