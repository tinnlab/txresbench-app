import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { openStory, trackErrors } from './_helpers'

// TEST-77 (covers ITEM-60): keyboard control + ARIA live announcements. A GPU canvas is
// opaque to assistive tech, so `a11y-keyboard` makes the plot keyboard-focusable and speaks
// every state change through an off-screen `role="status" aria-live` region. We focus the
// canvas container, drive zoom / select / clear via the keyboard, and assert
// `window.__VIZ_TEST__.lastAnnouncement` updates with no error.
//
// ── The axe scan was suppressed by a FALSE premise ───────────────────────────────────
// A comment here claimed `@axe-core/playwright` was "NOT installed in this workspace
// (checked node_modules + package.json)". It is installed — npm workspaces HOISTS it to
// the repo root, so it lives at `<repo>/node_modules/@axe-core/playwright` and resolves
// fine from `src-app/ui` (`require.resolve` confirms; `tests/visual/declarative-layout.
// spec.ts` already imports it). The original check only looked in
// `src-app/ui/node_modules`. The scan is enabled below rather than the comment deleted:
// a stale note had been silently standing in for a real WCAG pass.
test('TEST-77 keyboard pan/zoom/select drives ARIA live announcements with no error', async ({ page }) => {
  const bag = trackErrors(page)

  await openStory(page, 'a11y-keyboard')

  // The ARIA live region exists and is an actual status/live node.
  const live = page.locator('[data-testid="viz-a11y-live-region"]')
  await expect(live).toHaveAttribute('role', 'status')
  await expect(live).toHaveAttribute('aria-live', /polite|assertive/)

  // The plot container is keyboard-focusable (tabIndex).
  const stage = page.locator('[data-testid="viz-a11y"]')
  await expect(stage).toHaveAttribute('tabindex', '0')
  await stage.focus()

  // Arrow keys pan (no announcement by design); +/- zoom, Enter selects, Esc clears —
  // each of the latter speaks through the live region + mirrors to the test hook.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowUp')

  await page.keyboard.press('+')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement))
    .toBe('Zoomed in')

  await page.keyboard.press('-')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement))
    .toBe('Zoomed out')

  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement))
    .toMatch(/^Selected /)

  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement))
    .toBe('Selection cleared')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// A11Y-1: the `DragRail` handles that back EVERY axis/matrix/scatter dataZoom slider are now
// keyboard-operable + ARIA-exposed (role=slider + accessible name + valuemin/max/now), not
// pointer-only. Asserted against the REAL scatter x-slider high handle in the `datazoom-toggle`
// story (same testid the datazoom-toggle drag spec drives): the handle exposes role="slider" with
// a name, and a focused handle responds to a keypress by changing its `aria-valuenow` — proving the
// keyboard drives the SAME window-update path the pointer drag does (aria-valuenow is derived from
// the live window fraction). The high handle starts at the domain max, so ArrowLeft (decrement)
// moves it inward reliably rather than clamping.
const SCATTER_X_HANDLE_HI = 'viz-scatter-datazoom-x-slider-handle-hi'

test('A11Y-1 dataZoom rail handle exposes role=slider + name and is keyboard-operable', async ({ page }) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)

  await openStory(page, 'datazoom-toggle')

  const handle = page.getByTestId(SCATTER_X_HANDLE_HI)
  await expect(handle, 'scatter x-slider high handle mounts once the fixture loads').toBeVisible({
    timeout: 60_000,
  })

  // ARIA: it is a named slider, keyboard-focusable, with a value range.
  await expect(handle).toHaveAttribute('role', 'slider')
  await expect(handle).toHaveAttribute('aria-label', /.+/)
  await expect(handle).toHaveAttribute('tabindex', '0')
  await expect(handle).toHaveAttribute('aria-valuemin', /.+/)
  await expect(handle).toHaveAttribute('aria-valuemax', /.+/)

  // A focused handle responds to a keypress by moving its value (same window-update path as drag).
  const before = await handle.getAttribute('aria-valuenow')
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(() => page.getByTestId(SCATTER_X_HANDLE_HI).getAttribute('aria-valuenow'), {
      message: 'ArrowLeft on the focused rail handle changes its aria-valuenow',
      timeout: 15_000,
    })
    .not.toBe(before)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// TEST-77b — the axe scan the stale "not installed" comment above had been standing in for.
// Scoped to the a11y story's stage (the surface TEST-77 drives), tags wcag2a+wcag2aa, and
// gates on critical/serious — the same shape as `tests/visual/declarative-layout.spec.ts`.
// A GPU canvas is opaque to axe, so this covers the CHROME around it: the live region, the
// focusable stage, the tool rail's named controls.
test('TEST-77b axe: no critical/serious WCAG violations on the a11y story', async ({ page }) => {
  test.setTimeout(180_000)
  await openStory(page, 'a11y-keyboard')
  // axe's `include` throws "No elements found" if it runs before the story mounts.
  await expect(page.getByTestId('viz-a11y')).toBeVisible({ timeout: 60_000 })

  const results = await new AxeBuilder({ page })
    .include('[data-testid="viz-a11y"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  // Positive control: the scan actually RAN over a non-empty tree. Without this, a scoped
  // scan that matched nothing would report zero violations and read as a pass — the same
  // vacuum shape as an absence assertion against a testid nobody renders.
  expect(results.passes.length, 'axe evaluated real rules against the story stage').toBeGreaterThan(0)

  const blocking = results.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))
  expect(
    blocking,
    `axe violations on a11y-keyboard:\n${blocking
      .map(v => `  • ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join('\n')}`,
  ).toHaveLength(0)
})
