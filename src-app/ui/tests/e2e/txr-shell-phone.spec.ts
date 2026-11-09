import { expect, test } from '@playwright/test'
import { mintLocalSession, seedLocalSession } from './txr-results/helpers'

/**
 * TXRSHELL full-backend phone spec — ITEM-8 (TEST-QF-7's full-app leg).
 *
 * The gallery tier (`tests/gallery-e2e/txr-theme-phone.spec.ts`) pins the
 * shell header at 390 px inside its story frame; THIS spec proves the same
 * facts under the REAL app — the built SPA (the same `dist` the Tauri
 * desktop shell embeds) + the real backend + the session guard + the real
 * layout — because the story frame cannot show the app router's layout
 * (DRIFT-1 ITEM-7 unresolved #5, ITEM-8's budget).
 *
 * Spec ↔ TESTS.md:
 *   · TEST-QF-7 (final leg) — X2 under the real app: at 390×844 the shell
 *     header keeps all four destinations on-screen (New analysis / Models /
 *     History / Help) and no page scrolls horizontally (the report's
 *     measured 526 px page scrollWidth was the header's six-line tagline);
 *     the tagline yields (the board's desktop byte is not a phone byte).
 *   · TEST-QF-7 (X1, the built app) — the design webfonts actually load:
 *     `document.fonts.check` for the three design families after
 *     `document.fonts.ready`. The build-time url check proves the CSS paths;
 *     this proves the faces render (a font that 404s or fails OTS parsing
 *     answers `check === false`).
 *
 * Never self-skips: the local session is minted by the app itself (no login
 * surface) and the landing + empty-history surfaces are deterministic on a
 * fresh backend.
 */

test.describe('txr-shell — the real app at phone width (TEST-QF-7 full-app leg, ITEM-8)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('X1/X2: no page overflow, the header destinations on-screen, the design fonts load', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)

    // ── the landing page (the real session guard + layout + StartPage) ──
    await page.goto('/')
    await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()

    const overflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
    expect(await overflow(), 'the landing page at 390 px').toBeLessThanOrEqual(1)

    // The tagline yields under 900 px (X2's composition).
    await expect
      .poll(() =>
        page.locator('.txr-shell-tagline').evaluate(el => getComputedStyle(el).display),
      )
      .toBe('none')

    // Every destination stays inside the viewport (X2's History/Help
    // fall-off-screen bug) — the same needle as the shell gallery story,
    // now under the real app.
    for (const label of ['New analysis', 'Models', 'History', 'Help']) {
      const link = page.locator('.txr-shell a', { hasText: label }).first()
      await expect(link).toBeVisible()
      const box = await link.boundingBox()
      expect(box, `${label} must be on-screen`).not.toBeNull()
      expect(box!.x, `${label} starts inside`).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, `${label} ends inside`).toBeLessThanOrEqual(390 + 1)
    }

    // ── X1: the design fonts load in the BUILT app (the dist the desktop
    //    shell embeds). `fonts.load` REQUESTs each face through its own
    //    @font-face src — a font the page never uses would answer
    //    `check() === false` without telling us why, while a 404 or an OTS
    //    parse failure rejects the load or resolves zero faces. The three
    //    families of the design boards, the weights the css declares.
    const loaded = await page.evaluate(async () => {
      const specs = {
        sans: '400 15px "Source Sans 3"',
        serif: '600 22px "Source Serif 4"',
        code: '400 13px "Source Code Pro"',
      }
      const out: Record<string, number> = {}
      for (const [key, spec] of Object.entries(specs)) {
        try {
          out[key] = (await document.fonts.load(spec)).length
        } catch {
          out[key] = -1
        }
      }
      return out
    })
    expect(loaded.sans, 'Source Sans 3 must load').toBeGreaterThan(0)
    expect(loaded.serif, 'Source Serif 4 must load (the brand)').toBeGreaterThan(0)
    expect(loaded.code, 'Source Code Pro must load (the ids)').toBeGreaterThan(0)

    // ── a second real route, the same sweep: /history (empty state) ──
    await page.goto('/history')
    await expect(page.getByTestId('txr-history')).toBeVisible()
    expect(await overflow(), 'the history page at 390 px').toBeLessThanOrEqual(1)
    for (const label of ['New analysis', 'Models', 'History', 'Help']) {
      const link = page.locator('.txr-shell a', { hasText: label }).first()
      await expect(link).toBeVisible()
      const box = await link.boundingBox()
      expect(box!.x + box!.width, `${label} ends inside on /history`).toBeLessThanOrEqual(390 + 1)
    }
  })
})
