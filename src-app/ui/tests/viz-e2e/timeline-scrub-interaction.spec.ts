import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Interaction coverage (audit test-adequacy #5): the timeline scrubber was render-smoke-only. This
// drives the real prev/next frame controls and asserts the frame advances/retreats via
// window.__VIZ_TEST__.timelineFrame (the GPU per-frame filterRange is uniform-only, so the point count
// changing is proven by the story rendering without error while the frame moves).

const frame = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { timelineFrame?: number } }).__VIZ_TEST__?.timelineFrame ?? 0)

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('timeline: next/prev step controls scrub the frame', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'timeline-scrub')
  await expect(page.getByTestId('viz-timeline')).toBeVisible({ timeout: 20_000 })

  const start = await frame(page)
  // Advance a few frames.
  for (let i = 0; i < 3; i++) await page.getByTestId('viz-timeline-control-next').click()
  await expect.poll(() => frame(page), { timeout: 10_000 }).toBeGreaterThan(start)
  const advanced = await frame(page)

  // Step back.
  await page.getByTestId('viz-timeline-control-prev').click()
  await expect.poll(() => frame(page), { timeout: 10_000 }).toBeLessThan(advanced)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
