import { test, expect } from '@playwright/test'
import { loginAsOwner, openJobsDrawer, jobsSidebarButton } from './helpers'

// TEST-20: the "Jobs" sidebar button (above Settings) opens the drawer — a
// drawer, NOT a route change.
test('Jobs sidebar button opens the drawer without navigating', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/general')

  const urlBefore = page.url()
  await jobsSidebarButton(page).click()

  await expect(page.getByTestId('jobs-drawer')).toBeVisible()
  // No route change — it's a drawer, not a page.
  expect(page.url()).toBe(urlBefore)
})

// TEST-21: creating a job adds a status-badged row; queued/running rows have a
// Stop/Cancel action and NO start button; the job progresses to completed.
test('create a job → it queues, runs (no start button), and completes', async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto('/settings/general')
  await openJobsDrawer(page)

  const drawer = page.getByTestId('jobs-drawer')
  // Unique name + a name-scoped row locator. The drawer lists the OWNER's jobs across
  // every scope and the whole directory shares ONE owner (`tests/e2e/_owner.ts`), so
  // at `--workers=2` `li.first()` can be another worker's job — exactly the failure
  // `jobs-detail.spec.ts` was hitting (it read a concurrently-created dataset import).
  const name = `e2e job ${Date.now()}`
  await drawer.getByTestId('job-create-name').fill(name)
  await drawer.getByTestId('job-create-button').click()

  // A row appears with a status badge.
  const row = drawer.getByTestId('job-list').locator('li').filter({ hasText: name })
  await expect(row).toHaveCount(1, { timeout: 10_000 })
  await expect(row.getByText(name)).toBeVisible()

  // There is NEVER a "start" affordance for a queued job (drawer-wide on purpose —
  // absence is stronger asserted over the whole list).
  await expect(drawer.getByRole('button', { name: /start/i })).toHaveCount(0)
  // While active, a Stop/Cancel button exists on THIS row — scoped, so another
  // worker's active job can't satisfy it. Addressed by testid, not by role+name: the
  // row's own wrapper is itself `role="button"` (it is click-to-open) and its
  // accessible name includes the icon button's, so a role query inside the row is
  // ambiguous by construction.
  await expect(row.locator('[data-testid^="job-stop-"]')).toBeVisible({
    timeout: 10_000,
  })

  // THIS job reaches completed on its own (scheduler runs it — no user action).
  await expect(row.getByTestId('job-status-completed')).toBeVisible({
    timeout: 30_000,
  })
})
