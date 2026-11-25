import { expect, test, type Page } from '@playwright/test'

/**
 * TEST-DM-6 (ITEM-6 half) — the demo-mode pages part 1 over the REAL demo
 * server (demo-mode ITEM-1..3's server: TXR_DEMO=1, no registry, no bwrap,
 * the minimal valid recorded bundle).
 *
 * Legs (the plan's browser-test list):
 *  · the TRAIN path from the landing page: the demo "Use the example data"
 *    action → the example files (cards, no upload) → choose-methods (the
 *    list is the bundle's methods only, the settings locked, the run button
 *    'Run N methods (demo)') → the running page (the "Demo run" label) →
 *    the results page;
 *  · the REUSE path: the example predict card → the saved-models page →
 *    the seeded example set → a reuse run replays to the results page;
 *  · the PRETRAINED path: the example predict card (the running-page
 *    completion of this path is ITEM-7's — this tree's pretrained catalogue
 *    is empty, so the path's own pages end here; recorded in DRIFT-1);
 *  · no enabled file input anywhere on the ITEM-6 pages, and the study
 *    panel's demo note appears when the answers leave the example setup.
 *
 * Run (own ports on a shared box — the config derives them per worktree):
 *   npm run test:e2e:demo
 */
test.setTimeout(900_000)

const NOTICE = '[data-testid="txr-demo-notice"]'

/** One demo context per test: the notice bar + the anonymous session. */
async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
}

/** The running-URL of a just-created replay run (id from the URL). */
async function runIdAt(page: Page): Promise<string> {
  const url = page.url()
  const match = /\/analysis\/([^/]+)\/running/.exec(url)
  expect(match, `expected a running URL, got ${url}`).not.toBeNull()
  return match![1]
}

test.describe('txr-demo-pages — the three paths, no upload (TEST-DM-6, ITEM-6)', () => {
  test('train: Start → the example files cards → choose-methods (recorded methods only) → running ("Demo run") → results', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))

    // The choose-methods cards are COLLAPSED at the desktop-chrome 720 viewport
    // height (the app's short-shell rule ≤ 799 px); the Change files control
    // and the Settings surface live in the expanded cards, so this walk uses a
    // 900-tall window (the E page's measured expanded height).
    await page.setViewportSize({ width: 1280, height: 900 })
    await openApp(page)
    await page.getByTestId('txr-use-example-train').click()
    await page.waitForURL('/files', { timeout: 60_000 })

    // The example cards replaced the upload surface; no file input exists.
    await expect(page.getByTestId('txr-example-card-patients')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-measurements')).toBeVisible()
    await expect(page.getByTestId('txr-example-card-badge-patients')).toHaveText('Example')
    expect(await page.locator('input[type=file]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-intake-file-drop-"]').count()).toBe(0)
    // The example downloads stay.
    await expect(page.getByTestId('txr-example-card-download-template-patients')).toBeVisible()
    await expect(page.getByTestId('txr-example-card-download-patients')).toBeVisible()

    await page.getByTestId('txr-intake-continue').click()
    await page.waitForURL('/choose-methods', { timeout: 60_000 })

    // The choose-methods demo byte: the recorded methods only, the locked
    // setup, Change files disabled, the bar's (demo) label.
    await expect(page.getByTestId('txr-method-ready-heading')).toHaveText('Ready to run (1)', { timeout: 60_000 })
    await expect(page.getByTestId('txr-method-checkbox-kelim')).toBeVisible()
    expect(await page.locator('[data-testid="txr-method-cannot"]').count()).toBe(0)
    expect(await page.locator('[data-testid="txr-method-cannot-toggle"]').count()).toBe(0)
    await expect(page.getByTestId('txr-run-settings-demo-note')).toHaveText('the demo uses the example setup')
    const changeFiles = page.getByTestId('txr-run-change-files')
    await expect(changeFiles).toBeDisabled()
    await expect(page.getByTestId('txr-run-change-files-reason')).toHaveText('Not available in the demo')
    await expect(page.getByTestId('txr-run-bar-run')).toContainText('(demo)')
    expect(await page.locator('[data-testid="txr-run-settings-more"]').count()).toBe(0)

    await page.getByTestId('txr-run-bar-run').click()
    await page.waitForURL(/\/analysis\/.+\/running/, { timeout: 60_000 })
    await expect(page.getByTestId('txr-run-demo-label')).toHaveText('Demo run - results are the recorded ones', { timeout: 30_000 })
    // The run replay finishes (15 s) and the running page lands on results.
    await page.waitForURL(/\/analysis\/.+\/results/, { timeout: 120_000 })

    expect(pageErrors, `page errors on the train path: ${pageErrors.join('; ')}`).toEqual([])
  })

  test('predict (the example set): Start → the example predict card → the seeded example set → a replay reuse run → results', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))

    await openApp(page)
    await page.getByTestId('txr-use-example-predict').click()
    await page.waitForURL('/predict-files', { timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-predict')).toBeVisible({ timeout: 60_000 })
    expect(await page.locator('input[type=file]').count()).toBe(0)

    await page.getByTestId('txr-intake-continue').click()
    await page.waitForURL('/saved-models', { timeout: 60_000 })

    // The boot-seeded example set is the demo's saved models; its model is
    // runnable (the demo eligibility arm answers the recorded method) and
    // arrives TICKED — the example-set handoff (ITEM-3's `pendingExampleSet`)
    // ticks every row of the example set, which is exactly why the reuse
    // path needed no picking.
    const rowCheckbox = page.locator('[data-testid^="txr-list-checkbox-"]').first()
    await expect(rowCheckbox).toBeVisible({ timeout: 60_000 })
    await expect(rowCheckbox).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 })
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('1 model selected')
    await page.getByTestId('txr-list-run').click()
    await page.waitForURL(/\/analysis\/.+\/running/, { timeout: 60_000 })
    await expect(page.getByTestId('txr-run-demo-label')).toBeVisible({ timeout: 30_000 })
    await page.waitForURL(/\/analysis\/.+\/results/, { timeout: 120_000 })

    expect(pageErrors, `page errors on the reuse path: ${pageErrors.join('; ')}`).toEqual([])
  })

  test('predict (merged card): the example predict card and the Continue to the saved-models list (round-1 bridge)', async ({ page }) => {
    await openApp(page)
    await page.getByTestId('txr-use-example-predict').click()
    await page.waitForURL('/predict-files', { timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-predict')).toBeVisible({ timeout: 60_000 })
    expect(await page.locator('input[type=file]').count()).toBe(0)
    // The example path pinned the saved source (the example set is saved
    // models), so round 1's bridge Continue leads to the saved-models page.
    await page.getByTestId('txr-intake-continue').click()
    await page.waitForURL('/saved-models', { timeout: 60_000 })
  })

  test('no enabled file input anywhere on the ITEM-6 pages, and the study panel notes the example setup', async ({ page }) => {
    await openApp(page)
    // The pages of part 1, in one session (the flow's store fills as the
    // path advances): each surface renders ZERO file inputs and no drop zone.
    for (const path of ['/', '/study', '/files', '/predict-files']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
      expect(await page.locator('input[type=file]').count(), `file inputs on ${path}`).toBe(0)
      expect(await page.locator('[data-testid^="txr-intake-file-drop-"]').count(), `drop zones on ${path}`).toBe(0)
    }

    // /files in demo fills itself with the example (no upload possible):
    // the mount-time adoption is async, so wait for the card first.
    await page.goto('/files', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-patients')).toBeVisible({ timeout: 60_000 })
    expect(await page.locator('[data-testid^="txr-example-card-"]').count()).toBeGreaterThan(1)
    expect(await page.locator('input[type=file]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-intake-file-drop-"]').count()).toBe(0)

    // The study panel's demo note: an answer outside the example setup.
    await page.goto('/study', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    const groupCheckbox = page.locator('[data-testid^="txr-intake-study-group-"]').first()
    await expect(groupCheckbox).toBeVisible({ timeout: 30_000 })
    await groupCheckbox.click()
    await expect(page.getByTestId('txr-intake-panel-demo-note')).toHaveText(
      'The demo uses the example study, so these answers do not change the methods the demo offers.',
      { timeout: 30_000 },
    )

    // The choose-methods surface (a fresh visit without the intake setup
    // renders the empty state — still no upload control anywhere).
    await page.goto('/choose-methods', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    expect(await page.locator('input[type=file]').count()).toBe(0)
  })
})
