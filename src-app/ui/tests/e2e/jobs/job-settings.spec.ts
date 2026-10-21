import { test, expect } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-24: an admin edits the concurrency cap on /settings/jobs and it persists.
// (Updated for #54: the save testid moved into the Concurrency section card.)
test('admin edits the jobs concurrency cap and it persists', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/jobs')

  const field = page.getByTestId('job-settings-max-concurrent')
  await expect(field).toBeVisible({ timeout: 15_000 })

  // Change the cap and save. The save's response is awaited BEFORE reloading: the
  // reload otherwise races the in-flight `PUT /api/job-settings` and CANCELS it.
  const saved = page.waitForResponse(
    r => r.url().includes('/api/job-settings') && r.request().method() === 'PUT',
  )
  await field.fill('4')
  await page.getByTestId('job-concurrency-save').click()
  const savedResponse = await saved
  expect(savedResponse.ok(), `PUT /api/job-settings -> ${savedResponse.status()}`).toBeTruthy()

  // Persists across a reload.
  await page.reload()
  await expect(page.getByTestId('job-settings-max-concurrent')).toHaveValue('4', {
    timeout: 15_000,
  })
})

// TEST-15 [covers: ITEM-7, ITEM-9] (#54): the SSE + Admission knobs render populated on the
// Jobs settings page (from the regenerated GET /job-settings), and editing one from each of the
// SSE and Admission sections saves + persists across a reload (drives the regenerated client
// type/route end-to-end).
test('admin edits the SSE + admission knobs and they persist', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/jobs')

  // Every section is populated from the singleton GET.
  const keepAlive = page.getByTestId('job-settings-sse-keep-alive')
  const maxClients = page.getByTestId('job-settings-sse-max-clients')
  const admissionWait = page.getByTestId('job-settings-admission-wait')
  const admissionPoll = page.getByTestId('job-settings-admission-poll')
  const reserved = page.getByTestId('job-settings-reserved')
  const perTenant = page.getByTestId('job-settings-per-tenant')
  for (const f of [keepAlive, maxClients, admissionWait, admissionPoll, reserved, perTenant]) {
    await expect(f).toBeVisible({ timeout: 15_000 })
    await expect(f).not.toHaveValue('')
  }

  // Edit an SSE knob → save the Streaming section.
  const sseSaved = page.waitForResponse(
    r => r.url().includes('/api/job-settings') && r.request().method() === 'PUT',
  )
  await keepAlive.fill('42')
  await page.getByTestId('job-streaming-save').click()
  expect((await sseSaved).ok(), 'SSE PUT ok').toBeTruthy()

  // Edit an Admission knob → save the Admission section.
  const admSaved = page.waitForResponse(
    r => r.url().includes('/api/job-settings') && r.request().method() === 'PUT',
  )
  await admissionWait.fill('30')
  await page.getByTestId('job-admission-save').click()
  expect((await admSaved).ok(), 'admission PUT ok').toBeTruthy()

  // Both persist across a reload.
  await page.reload()
  await expect(page.getByTestId('job-settings-sse-keep-alive')).toHaveValue('42', {
    timeout: 15_000,
  })
  await expect(page.getByTestId('job-settings-admission-wait')).toHaveValue('30', {
    timeout: 15_000,
  })
})

// TEST-12 [covers: ITEM-6, ITEM-7, ITEM-8] (#56): the Scheduler & reaper card renders populated
// on the Jobs settings page (from the regenerated GET /job-settings), and editing a knob saves
// via the jobs.updateSettings action and persists across a reload.
test('admin edits the scheduler/reaper knobs and they persist', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/jobs')

  // The new Scheduler card is present and every field is populated from the singleton GET.
  await expect(page.getByTestId('job-scheduler-card')).toBeVisible({ timeout: 15_000 })
  const heartbeat = page.getByTestId('job-settings-heartbeat')
  const reaperTick = page.getByTestId('job-settings-reaper-tick')
  const staleThreshold = page.getByTestId('job-settings-stale-threshold')
  const maxReclaims = page.getByTestId('job-settings-max-reclaims')
  const reclaimBatch = page.getByTestId('job-settings-reclaim-batch')
  const dispatchTick = page.getByTestId('job-settings-dispatch-tick')
  const metricTick = page.getByTestId('job-settings-metric-tick')
  for (const f of [
    heartbeat,
    reaperTick,
    staleThreshold,
    maxReclaims,
    reclaimBatch,
    dispatchTick,
    metricTick,
  ]) {
    await expect(f).toBeVisible({ timeout: 15_000 })
    await expect(f).not.toHaveValue('')
  }

  // Edit the reaper tick → save the Scheduler section.
  const saved = page.waitForResponse(
    r => r.url().includes('/api/job-settings') && r.request().method() === 'PUT',
  )
  await reaperTick.fill('30')
  await page.getByTestId('job-scheduler-save').click()
  expect((await saved).ok(), 'scheduler PUT ok').toBeTruthy()

  // Persists across a reload.
  await page.reload()
  await expect(page.getByTestId('job-settings-reaper-tick')).toHaveValue('30', {
    timeout: 15_000,
  })
})
