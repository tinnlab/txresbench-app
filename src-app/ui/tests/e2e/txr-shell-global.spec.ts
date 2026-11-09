import { expect, test } from '@playwright/test'
import {
  createRun,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
} from './txr-results/helpers'

/**
 * TXRSHELL full-backend global spec — qa-fixes2 ITEM-4 (TEST-QF2-3).
 *
 * Covers the help-r2.md R2-G* defects under the REAL app (built SPA + real
 * backend + real session guard — the same tier the round-2 report measured
 * in):
 *
 *  R2-G1  every route's `document.title` is distinct and meaningful (the
 *         page's own h1 byte + " — TxResBench"); the run routes' titles are
 *         the page's derived words (a run record carries no name field,
 *         so "Results — <run name>" is the report's example, not a byte
 *         the app can produce);
 *  R2-G2  unknown URLs (`/nope`, `/help/extra`, `/models/foo`) render the
 *         shell's not-found screen at the same URL — never the silent
 *         redirect to `/` — with a way out;
 *  R2-G3  the header links' keyboard focus ring is the ONE ring (the kit
 *         control ring: no default outline, the 3 px --ring shadow), not
 *         the 1 px browser outline next to the kit Button's ring;
 *  R2-G5  navigating between pages no longer logs the "stream ended;
 *         reconnecting" WARNINGS on every load — they are debug now, so a
 *         console-warning listener across the whole walk records zero of
 *         them (the pagehide-unload case the report measured).
 */

test.describe('txr-shell — titles, not-found, focus ring, stream noise (TEST-QF2-3, ITEM-4)', () => {
  /** The route walk's static pages: path → expected `document.title`. */
  const STATIC_TITLES: Array<[string, string]> = [
    ['/', 'What do you want to do? \u2014 TxResBench'],
    ['/study', 'Tell us about your study \u2014 TxResBench'],
    ['/files', 'Add your files \u2014 TxResBench'],
    ['/predict-files', 'Add the patients to predict \u2014 TxResBench'],
    ['/choose-methods', 'Choose the methods and settings \u2014 TxResBench'],
    ['/history', 'History \u2014 TxResBench'],
    ['/models', 'Your models \u2014 TxResBench'],
    ['/saved-models', 'Choose the saved models to run \u2014 TxResBench'],
    ['/pretrained-models', 'Choose the models to run \u2014 TxResBench'],
    ['/help', 'Help \u2014 TxResBench'],
  ]

  const streamNoise = (warnings: string[]): string[] =>
    warnings.filter(
      w =>
        w.includes('[sync] stream ended; reconnecting') ||
        w.includes('[actions] agent stream ended; reconnecting'),
    )

  test('every route carries its own title; unknown URLs show the 404 screen; the header ring is one ring; no stream warning on navigation', async ({
    page,
  }) => {
    const warnings: string[] = []
    page.on('console', m => {
      if (m.type() === 'warning') warnings.push(m.text())
    })

    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)

    for (const [path, title] of STATIC_TITLES) {
      await page.goto(path)
      await expect(page, `title on ${path}`).toHaveTitle(title)
    }

    // The run routes: one created run (all-cannot-run → finishes immediately,
    // one method row), the SAME deterministic surface the helpers' specs rely on.
    const runId = await createRun(page, token, ['jm-mem-lq'])
    await waitForTerminalRun(page, token, runId)

    await page.goto(`/analysis/${runId}/running`)
    await expect(page).toHaveTitle('Finished 1 method \u2014 TxResBench')

    await page.goto(`/analysis/${runId}/results`)
    await expect(page).toHaveTitle(/^Predictions( for \d+ patients)? \u2014 TxResBench$/)

    await page.goto(`/analysis/${runId}/results/compare`)
    await expect(page).toHaveTitle('Compare methods \u2014 TxResBench')

    // R2-G3: the header links' focus ring is the kit control ring, not the
    // browser default — computed byte, both a nav link and the brand. Done
    // BEFORE the 404 click below: the pointer click sets the last-input
    // heuristic and Chromium then does not match `:focus-visible` on the
    // next Tab, so the keyboard byte must be taken from a clean load.
    await page.keyboard.press('Tab') // logo
    const brandRing = await page.locator('.txr-shell-brand').evaluate(el => {
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, shadow: s.boxShadow }
    })
    expect(brandRing.outline, 'no default outline').toBe('none')
    expect(brandRing.shadow, 'the one 3 px ring').toMatch(/0px 0px 0px 3px/)
    await page.keyboard.press('Tab') // New analysis
    const navRing = await page.locator('.txr-nav-link').first().evaluate(el => {
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, shadow: s.boxShadow }
    })
    expect(navRing.outline, 'no default outline').toBe('none')
    expect(navRing.shadow, 'the one 3 px ring').toMatch(/0px 0px 0px 3px/)

    // R2-G2: unknown URLs at any depth keep their URL and render the shell's
    // not-found screen — the silent redirect to `/` is gone.
    for (const bad of ['/nope', '/help/extra', '/models/foo']) {
      await page.goto(bad)
      await expect(page).toHaveURL(new RegExp(`${bad.replace(/[/\\]/g, '\\$&')}$`))
      await expect(page.getByTestId('txr-not-found')).toBeVisible()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
      await expect(page.getByText(bad)).toBeVisible()
      await expect(page).toHaveTitle('Page not found \u2014 TxResBench')
    }
    // The one way out leads to the start screen.
    await page.getByTestId('txr-not-found-home').click()
    await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()
    await expect(page).toHaveURL(/\/$/)

    // R2-G5: the whole route walk (every navigation above) logged ZERO
    // "stream ended; reconnecting" warnings — the streams' teardown on
    // navigation is debug now. Any one of these is the exact regression
    // the round-2 report measured on 52 of 56 loads.
    expect(streamNoise(warnings), `stream warning noise:\n${warnings.join('\n')}`).toEqual([])
  })

  test('at 390 px the not-found screen stays inside the viewport and the header ring still applies', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)

    await page.goto('/nope')
    await expect(page.getByTestId('txr-not-found')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'the 404 screen at 390 px').toBeLessThanOrEqual(1)
    await expect(page).toHaveTitle('Page not found \u2014 TxResBench')

    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab') // New analysis (the logo is the first stop)
    const navRing = await page.locator('.txr-nav-link').first().evaluate(el => {
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, shadow: s.boxShadow }
    })
    expect(navRing.outline).toBe('none')
    expect(navRing.shadow).toMatch(/0px 0px 0px 3px/)
  })
})
