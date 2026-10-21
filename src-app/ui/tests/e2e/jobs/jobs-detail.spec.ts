import { test, expect } from '@playwright/test'
import { loginAsOwner, openJobsDrawer, ownerToken } from './helpers'

// TEST-22: clicking a job opens the detail view — streamed logs + a CPU chart +
// a memory chart (Observable Plot renders an <svg>) + Stop.
//
// The job is selected BY NAME, never by `job-list li.first()`. The Jobs drawer lists
// the OWNER's jobs across every scope, and `tests/e2e/_owner.ts` deliberately gives the
// whole directory ONE owner — so at `--workers=2` the newest row can belong to another
// worker. It did: this spec read a concurrently-created dataset-import run (its log was
// that converter's `OSError`) and asserted the stub's `step` output against it.
// A name-scoped locator is the fix that survives any parallelism, and the unique
// timestamp makes it collision-proof against the suite's own reruns.
test('job detail shows streamed logs and CPU + memory charts', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/general')
  await openJobsDrawer(page)

  const drawer = page.getByTestId('jobs-drawer')
  const name = `detail job ${Date.now()}`
  await drawer.getByTestId('job-create-name').fill(name)
  await drawer.getByTestId('job-create-button').click()

  // Open THIS job's detail (not whatever happens to be first).
  const row = drawer.getByTestId('job-list').locator('li').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(drawer.getByTestId('job-detail')).toBeVisible()

  // CPU + memory charts are present and render an SVG (Plot) as samples arrive.
  const cpu = drawer.getByTestId('job-cpu-chart')
  const mem = drawer.getByTestId('job-mem-chart')
  await expect(cpu).toBeVisible()
  await expect(mem).toBeVisible()
  await expect(cpu.locator('svg')).toBeVisible({ timeout: 20_000 })
  await expect(mem.locator('svg')).toBeVisible({ timeout: 20_000 })

  // The log pane streams the stub's output.
  await expect(drawer.getByTestId('job-logs')).toContainText('step', {
    timeout: 20_000,
  })
})

// TEST-9/10/11 (compute-usability-pass): a COMPLETED run's detail surfaces its timing
// (finished + duration) + a HUMANIZED status badge ("Completed", not the raw enum) with
// NO bare UUID, and the populated detail is responsive at 390px. A short stub job is
// created via the API and we wait for it to finish, so the terminal timing is present.
test('completed job detail shows humanized status + timing, and is responsive at 390px', async ({
  page,
  request,
}) => {
  await loginAsOwner(page)
  const token = await ownerToken(page)
  const created = await request.post('/api/jobs', {
    headers: { Authorization: `Bearer ${token}` },
    data: { job_type: 'stub', name: `done ${Date.now()}`, params: { steps: 2 } },
  })
  expect(created.ok(), `create job -> ${created.status()}`).toBeTruthy()
  const jobId = (await created.json()).id as string

  await page.goto('/settings/general')
  await openJobsDrawer(page)
  const drawer = page.getByTestId('jobs-drawer')

  await drawer.getByTestId(`job-row-${jobId}`).click()
  const detail = drawer.getByTestId('job-detail')
  await expect(detail).toBeVisible()

  // Waits for the run to reach the terminal state, scoped to THIS open detail.
  await expect(detail.getByTestId('job-status-completed')).toBeVisible({ timeout: 30_000 })

  // TEST-9 — humanized status label (the badge text is "Completed", not "completed").
  await expect(detail.getByTestId('job-status-completed')).toHaveText('Completed')
  // TEST-9 — timing meta: a finished run shows "Finished …" + a "Ran <duration>".
  await expect(detail.getByTestId('job-timing-meta')).toBeVisible()
  await expect(detail.getByTestId('job-timing-primary')).toContainText('Finished')
  await expect(detail.getByTestId('job-timing-duration')).toContainText('Ran')

  // TEST-11 — no bare 36-char UUID anywhere in the populated detail's visible text.
  const text = (await detail.textContent()) ?? ''
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)

  // TEST-10/11 — the populated detail is responsive at 390px: no page-body h-scroll,
  // and the same content still renders (representative-data render at the narrow viewport).
  await page.setViewportSize({ width: 390, height: 780 })
  await expect(detail.getByTestId('job-timing-meta')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'no page-body horizontal scroll at 390px').toBeLessThanOrEqual(1)
})

// TEST-23: stopping a running job from the drawer transitions it to stopped.
test('stop a running job from the detail view', async ({ page, request }) => {
  await loginAsOwner(page)
  const token = await ownerToken(page)
  // Create a LONG job via the API so it is reliably still running when we click
  // Stop (a UI-created default job finishes in ~6s and could complete first).
  // The response's id is kept so the row is addressed by `job-row-<id>` — same
  // parallelism hazard as the spec above, closed here by the strongest handle there is.
  const created = await request.post('/api/jobs', {
    headers: { Authorization: `Bearer ${token}` },
    data: { job_type: 'stub', name: `stop me ${Date.now()}`, params: { steps: 40 } },
  })
  expect(created.ok(), `create job -> ${created.status()}`).toBeTruthy()
  const jobId = (await created.json()).id as string

  await page.goto('/settings/general')
  await openJobsDrawer(page)
  const drawer = page.getByTestId('jobs-drawer')

  // Open THAT job's detail; the Stop control is present while active.
  await drawer.getByTestId(`job-row-${jobId}`).click()
  await expect(drawer.getByTestId('job-detail')).toBeVisible()
  await expect(drawer.getByTestId('job-detail-stop')).toBeVisible({ timeout: 15_000 })
  await drawer.getByTestId('job-detail-stop').click()

  // Scoped to the OPEN DETAIL, not `drawer…first()` — a stopped row belonging to
  // another worker's job would satisfy the drawer-wide locator.
  await expect(
    drawer.getByTestId('job-detail').getByTestId('job-status-stopped'),
  ).toBeVisible({ timeout: 20_000 })
})
