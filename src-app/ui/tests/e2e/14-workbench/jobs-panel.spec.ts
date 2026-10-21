import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench } from './_dock'

// TEST-316 (ITEM-67) — the project Jobs pane: the operational monitor for ALL of a
// project's jobs (queued/running/completed/failed/stopped), scoped via
// `GET /api/jobs?project_id=X` (the `job_scope` JOIN), with live status, per-job
// logs/metrics, and Stop — reusing the `modules/jobs` presentational pieces. A LONG
// project-scoped stub job is created via the API so it is reliably still running when we
// Stop it (a short job could complete first), mirroring the global jobs-detail spec.

test.describe('project jobs pane — all jobs · status · logs · stop (ITEM-67)', () => {
  test('lists the project-scoped job, streams its logs/metrics, and Stop transitions it to stopped', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const token = await ownerToken(request)
    const id = await createProject(request, `Jobs ${Date.now()}`)

    // A LONG project-scoped stub job — appears in the list ONLY because the pane queries
    // `?project_id=` (the job_scope JOIN); a short job could finish before we Stop it.
    const created = await request.post(`${BACKEND}/api/jobs`, {
      headers: { authorization: `Bearer ${token}` },
      data: { job_type: 'stub', name: 'project run', project_id: id, params: { steps: 40 } },
    })
    expect(created.ok(), `create scoped job -> ${created.status()}`).toBeTruthy()
    const jobId = (await created.json()).id

    await openWorkbench(page, id)
    await page.waitForFunction(
      () => !!(window as { __workbenchPanes?: unknown }).__workbenchPanes,
      undefined,
      { timeout: 20_000 },
    )
    // `open()` ADDS the pane but does not activate it (RegionShell keeps the region's
    // current active tab), so activate its tab — otherwise only the active pane's body renders.
    const jobsPaneId = await page.evaluate(() =>
      (window as unknown as { __workbenchPanes: { open: (k: string) => string } }).__workbenchPanes.open('jobs'),
    )
    const jobsTab = page.getByTestId(`region-tab-${jobsPaneId}`)
    await jobsTab.waitFor({ state: 'visible', timeout: 20_000 })
    await jobsTab.click()

    const pane = page.locator('[data-testid^="workbench-jobs-pane-"]').first()
    await expect(pane).toBeVisible({ timeout: 20_000 })

    // The project-scoped job row appears with a live status badge.
    const row = page.getByTestId(`workbench-jobs-row-${jobId}`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row.locator('[data-testid^="job-status-"]')).toBeVisible()

    // Open the job's detail — streamed logs + CPU + memory charts (Observable Plot SVG).
    await row.click()
    await expect(page.getByTestId('workbench-jobs-detail')).toBeVisible()

    // TEST-8 (ITEM-5): the pane detail now surfaces the job's TIMING — a running job
    // shows its start + a live "Running <n>s" duration, not just a status badge + logs.
    await expect(page.getByTestId('job-timing-meta')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('job-timing-primary')).toContainText('Started')
    await expect(page.getByTestId('job-timing-duration')).toContainText('Running')

    // Back-then-title reading order: the "All jobs" escape hatch renders ABOVE the job
    // name, not below it. Asserted on real geometry in the real dock, so a re-layout that
    // moves the button back under the header fails here as well as in the jsdom suite.
    const backBox = await page.getByTestId('workbench-jobs-detail-back').boundingBox()
    const headerBox = await page.getByTestId('workbench-jobs-detail-header').boundingBox()
    expect(backBox, 'the detail view must offer a back affordance').not.toBeNull()
    expect(headerBox, 'the detail view must show the job name').not.toBeNull()
    expect(backBox!.y, '"All jobs" must sit above the job name').toBeLessThan(headerBox!.y)

    await expect(page.getByTestId('workbench-jobs-cpu-chart')).toBeVisible()
    await expect(page.getByTestId('workbench-jobs-mem-chart')).toBeVisible()
    await expect(page.getByTestId('workbench-jobs-logs')).toContainText('step', { timeout: 20_000 })

    // Stop the running job from the detail view → it transitions to stopped.
    await expect(page.getByTestId('workbench-jobs-detail-stop')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('workbench-jobs-detail-stop').click()
    await expect(page.getByTestId('job-status-stopped').first()).toBeVisible({ timeout: 20_000 })
  })
})
