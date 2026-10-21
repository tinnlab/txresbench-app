import { test, expect } from '@playwright/test'
import { trackErrors } from './_helpers'

// Overlap tooltips (unified point + raster). The harness renders under SwiftShader, so this drives
// the CPU-raster story (which enables `overlapTooltip` on a dense categorical cloud): hovering the
// dense center yields the overlap badge, and — when points stack — a "+N more" affordance that opens
// a virtual-scrolled dialog listing all points at the cursor.
//
// It asserts BEHAVIOR, not pixels: the badge/dialog testids, the "N more" count, and that the dialog
// list renders rows. No console errors throughout.

test('raster hover shows the overlap badge; "N more" opens the virtual-scroll dialog', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  // A dense cloud so a single ~6px world-radius hover overlaps many points.
  await page.goto('/viz-showcase.html?points=200000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-cpu-raster"]')
  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 20_000 })
  // Wait for a committed raster (non-'0' hash) so the cloud is actually resident + drawn.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="viz-cpu-raster-view"]')
      const h = el?.getAttribute('data-raster-hash')
      return !!h && h !== '0'
    },
    undefined,
    { timeout: 60_000 },
  )

  const canvas = page.locator('[data-testid="viz-cpu-raster-view"] canvas').first()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  // Hover the dense center; nudge a couple of times so deck fires a pointermove with a coordinate.
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 3, cy - 3)
  await page.mouse.move(cx, cy)

  // The overlap badge appears (at least one stacked point).
  await expect(page.locator('[data-testid="viz-overlap-tooltip"]')).toBeVisible({ timeout: 20_000 })

  // In a dense region the "+N more" button should be present; click it → dialog opens.
  const moreBtn = page.locator('[data-testid="viz-overlap-tooltip-more"]')
  await expect(moreBtn).toBeVisible({ timeout: 20_000 })
  await moreBtn.click()

  const dialog = page.locator('[data-testid="viz-overlap-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  // The aggregate header (raster) + at least one virtual-scrolled row rendered.
  await expect(page.locator('[data-testid="viz-overlap-dialog-aggregate"]')).toBeVisible()
  await expect(page.locator('[data-testid="viz-overlap-dialog-row-0"]')).toBeVisible({
    timeout: 10_000,
  })

  // Focus trap: Tab must keep focus INSIDE the dialog (can't reach the page behind).
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const focusInside = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="viz-overlap-dialog"]')
    return !!d && !!document.activeElement && d.contains(document.activeElement)
  })
  expect(focusInside).toBe(true)

  // Esc closes the dialog.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })

  expect(bag.errors, `console errors: ${bag.errors.join('\n')}`).toEqual([])
})
