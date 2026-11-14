import { expect, test, type Page } from '@playwright/test'
import { mintLocalSession, seedLocalSession } from './txr-results/helpers'

/**
 * TXRSHELL full-backend theme-switch spec — qa-fixes2 ITEM-1 (TEST-QF2-1).
 *
 * The unit tier (`txrshell/TxrThemeToggle.test.tsx`) pins the toggle LOGIC
 * and copy against a controlled ThemeContext; the gallery tier
 * (`tests/gallery-e2e/txr-theme-phone.spec.ts`) pins the 390 px frame byte
 * inside the shell story. THIS spec proves the same facts under the REAL
 * app — the built SPA + the real backend + the real session guard + the real
 * ThemeProvider + the real ConfigClient persistence (localStorage, the one
 * store — DEC-4: no second theme store anywhere):
 *
 *   · clicking flips `html.dark` (the ThemeProvider toggles the class the
 *     tokens read);
 *   · the first click from the initial system preference lands on the OPPOSITE
 *     of what is shown now, and the store then holds an explicit light/dark;
 *   · the button shows the current state, its accessible name + tooltip is
 *     the action ("Switch to dark mode" / "Switch to light mode"), and the
 *     tooltip opens on hover;
 *   · the choice survives a reload (persisted preference) and stays on every
 *     shell route (New analysis / Models / History / Help);
 *   · at 390 px the switch stays on-screen with its label collapsed and the
 *     icon alone.
 *
 * Never self-skips: the local session is minted by the app itself and the
 * landing + empty-history/model/help surfaces are deterministic on a fresh
 * backend (the same determinism the ITEM-8 shell spec relies on).
 */

test.describe('txr-shell — the theme switch under the real app (TEST-QF2-1, ITEM-1)', () => {
  async function boot(page: Page): Promise<void> {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    await page.goto('/')
    await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()
  }

  /** The resolved theme byte — the `dark` class on <html>. */
  async function htmlDark(page: Page): Promise<boolean> {
    return page.evaluate(() => document.documentElement.classList.contains('dark'))
  }

  test('click flips html.dark from the shown state, persists across reload and stays on every route', async ({
    page,
  }) => {
    await boot(page)

    const toggle = page.getByTestId('txr-theme-toggle')
    await expect(toggle).toBeVisible()

    // The initial state is whatever the fresh profile resolves (system →
    // prefers-color-scheme). The toggle answers to what is SHOWN, so the
    // assertions are relative to the measured state — never a hard-coded one.
    const before = await htmlDark(page)
    // qa-fixes4 ITEM-5: the name carries the CURRENT state ('(currently light)' /
    // '(currently dark)') — the plan's words; the name contains the visible label.
    const action = before ? 'Switch to light mode (currently dark)' : 'Switch to dark mode (currently light)'
    const stateLabel = before ? 'Dark' : 'Light'
    const other = before ? 'light' : 'dark'

    // Shows the current state; the accessible name is the action.
    await expect(toggle).toHaveAttribute('aria-label', action)
    await expect(toggle).toContainText(stateLabel)
    await expect(toggle.locator('svg')).toBeVisible()

    // The first click from system goes to the opposite of what is shown now
    // and writes an explicit preference into the ONE store.
    await toggle.click()
    await expect
      .poll(async () => await htmlDark(page), 'html.dark must flip')
      .toBe(!before)
    await expect(toggle).toHaveAttribute(
      'aria-label',
      before ? 'Switch to dark mode (currently light)' : 'Switch to light mode (currently dark)',
    )
    await expect(toggle).toContainText(before ? 'Light' : 'Dark')
    const persisted = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('config-client-storage') ?? '{}'),
    )
    expect(persisted.state.themePreference).toBe(other)

    // The tooltip (the same action string) opens on hover — the kit Tooltip
    // keyed to this control (`data-slot="tooltip-content"` is the kit's own
    // marker; Base UI's popup role differs across versions). After the flip
    // the action is the other one. The mouse must LEAVE and re-enter first:
    // the click left the pointer on the button and the press already
    // dismissed the tooltip, so a hover at the same point fires no new
    // pointerenter and the popup never reopens.
    const nextAction = before
      ? 'Switch to dark mode (currently light)'
      : 'Switch to light mode (currently dark)'
    await page.mouse.move(10, 500)
    await toggle.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"]').filter({ hasText: nextAction }),
    ).toBeVisible()

    // Persists across a reload (the store's own storage, read before paint).
    await page.reload()
    await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()
    expect(await htmlDark(page), 'after reload').toBe(!before)

    // And stays on every shell route (the switch is part of the layout).
    for (const [path, needle] of [
      ['/history', 'txr-history'],
      ['/models', 'txr-models-j'],
      ['/help', 'txr-help'],
    ] as const) {
      await page.goto(path)
      await expect(page.getByTestId(needle)).toBeVisible()
      expect(await htmlDark(page), `theme on ${path}`).toBe(!before)
      await expect(page.getByTestId('txr-theme-toggle')).toBeVisible()
      await expect(page.getByTestId('txr-theme-toggle')).toHaveAttribute(
        'aria-label',
        before ? 'Switch to dark mode (currently light)' : 'Switch to light mode (currently dark)',
      )
    }

    // The choice is the explicit opposite now; a second click goes back —
    // and never back to "system" (the toggle only writes explicit themes).
    await page.goto('/')
    await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()
    await page.getByTestId('txr-theme-toggle').click()
    expect(await htmlDark(page)).toBe(before)
    const again = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('config-client-storage') ?? '{}'),
    )
    expect(again.state.themePreference).toBe(before ? 'dark' : 'light')
  })

  test('at 390 px the switch stays on-screen with its label collapsed and the icon alone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page)

    const toggle = page.getByTestId('txr-theme-toggle')
    await expect(toggle).toBeVisible()
    const box = await toggle.boundingBox()
    expect(box, 'the switch must be on-screen').not.toBeNull()
    expect(box!.x, 'starts inside').toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, 'ends inside').toBeLessThanOrEqual(390 + 1)
    // The label collapses (the 640 px rule); the icon stays.
    await expect(
      page.locator('.txr-theme-toggle .txr-theme-toggle-label').evaluate(
        el => getComputedStyle(el).display,
      ),
    ).resolves.toBe('none')
    await expect(toggle.locator('svg')).toBeVisible()
    // The accessible name survives the collapse — the icon-only control is
    // still named by the action.
    await expect(toggle).toHaveAttribute('aria-label', /Switch to (dark|light) mode \(currently (dark|light)\)/)
    // The whole page stays within the viewport with the switch in the header.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'the landing page at 390 px').toBeLessThanOrEqual(1)
  })
})
