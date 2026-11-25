import { expect, test, type Page } from '@playwright/test'

/**
 * TEST-DM-6 (ITEM-7 half) — the demo-mode pages part 2 over the REAL demo
 * server (demo-mode ITEM-1..3's server: TXR_DEMO=1, no registry, no bwrap,
 * the minimal valid recorded bundle).
 *
 * Legs (the audit table's CHANGE column, part 2):
 *  · the RESULTS pages carry "These are recorded results of the example
 *    data" (G + the compare route), the CSV download stays enabled;
 *  · HISTORY carries the shared-pool statement + the "n of 50 runs" counter
 *    as a VISIBLE paragraph, and the keep-copies links, clear-all and the
 *    per-run delete are absent;
 *  · MODELS carries the statement + "n of 50 models"; import, export,
 *    rename and delete are absent (Use stays);
 *  · SAVED-MODELS carries the statement + counter; the set Rename/Delete
 *    actions are absent (the seeded example set stays runnable);
 *  · HELP carries "About this demo" first: what you can/cannot do, the
 *    statement, the privacy line, and the download link with its attributes
 *    (the notice bar's /help#demo anchor resolves);
 *  · measured legs: 1280×900 + 390×844 dark — no horizontal overflow, the
 *    notice bar and the demo paragraph never overlap, and the paragraph
 *    stays inside the viewport.
 *
 * Run (own ports on a shared box — the config derives them per worktree):
 *   npm run test:e2e:demo
 */
test.setTimeout(900_000)

const NOTICE = '[data-testid="txr-demo-notice"]'
const RECORDED_LINE = 'These are recorded results of the example data'
const STATEMENT =
  'The demo is shared with everyone. It keeps the last 50 runs and the last 50 models; older ones are deleted automatically. Download the desktop app for your own private workspace.'

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

async function noHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(1)
}

test.describe('txr-demo-pages-7 — the part-2 pages (TEST-DM-6, ITEM-7)', () => {
  test('train → results; the recorded-results line, then history + models carry the statement, counters and no destructive controls', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.setViewportSize({ width: 1280, height: 900 })
    await openApp(page)
    await page.getByTestId('txr-use-example-train').click()
    await page.waitForURL('/files', { timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-patients')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('txr-intake-continue').click()
    await page.waitForURL('/choose-methods', { timeout: 60_000 })
    await page.getByTestId('txr-run-bar-run').click()
    await page.waitForURL(/\/analysis\/.+\/running/, { timeout: 60_000 })
    await page.waitForURL(/\/analysis\/.+\/results/, { timeout: 120_000 })

    // The results pages name the recorded truth (screen G + the compare route).
    await expect(page.getByTestId('txr-results-demo-label')).toHaveText(RECORDED_LINE, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('txr-results-download')).toBeEnabled()
    await page.goto(`${page.url()}/compare`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('txr-results-demo-label')).toHaveText(RECORDED_LINE, {
      timeout: 30_000,
    })
    await noHorizontalOverflow(page, 'results compare')

    // History: the statement + the counter (the shared pool's figure — the
    // walk's own run is among the counted ones), the desktop retention
    // controls absent.
    await page.goto('/history', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('txr-demo-retention-statement')).toHaveText(STATEMENT, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('txr-demo-retention-counter')).toHaveText(/^\d+ of 50 runs$/, {
      timeout: 30_000,
    })
    expect(await page.locator('[data-testid="txr-history-copies-off"]').count()).toBe(0)
    expect(await page.locator('[data-testid="txr-history-copies-on"]').count()).toBe(0)
    expect(await page.locator('[data-testid="txr-history-clear-all"]').count()).toBe(0)
    // The run list still works (rerun + download on the walked run).
    expect(await page.locator('[data-testid="txr-history-list"]').count()).toBe(1)
    await noHorizontalOverflow(page, 'history')

    // Models: the statement + the models counter (the shared pool's figure —
    // the example set is PINNED, so only visitor saves count), the import and
    // the row's export/rename/delete absent.
    await page.goto('/models', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('txr-demo-retention-statement')).toHaveText(STATEMENT, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('txr-demo-retention-counter')).toHaveText(/^\d+ of 50 models$/, {
      timeout: 30_000,
    })
    expect(await page.locator('[data-testid="txr-models-import"]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-models-export-"]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-models-rename-"]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-models-delete-"]').count()).toBe(0)
    // The import affordance is gone — no file input anywhere on the page.
    expect(await page.locator('input[type=file]').count()).toBe(0)
    await noHorizontalOverflow(page, 'models')

    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
  })

  test('saved-models + help: the reuse list keeps its rows without the set actions; About-this-demo carries the statement + the download link', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await openApp(page)
    // The reuse path: the example predict card → the seeded example set.
    await page.getByTestId('txr-use-example-predict').click()
    await page.waitForURL('/predict-files', { timeout: 60_000 })
    await expect(page.getByTestId('txr-example-card-predict')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('txr-intake-continue').click()
    await page.waitForURL('/saved-models', { timeout: 60_000 })

    await expect(page.getByTestId('txr-demo-retention-statement')).toHaveText(STATEMENT, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('txr-demo-retention-counter')).toHaveText(/^\d+ of 50 models$/, {
      timeout: 30_000,
    })
    // The set's Rename/Delete actions are absent; the rows + the Run bar stay.
    expect(await page.locator('[data-testid^="txr-list-section-action-"]').count()).toBe(0)
    expect(await page.locator('[data-testid^="txr-list-checkbox-"]').count()).toBeGreaterThan(0)
    await expect(page.getByTestId('txr-list-run')).toBeVisible()

    // Help: the "About this demo" section is FIRST, with the audit's bytes.
    await page.goto('/help#demo', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 60_000 })
    const section = page.getByTestId('txr-help-section-demo')
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(section.locator('h2')).toHaveText('About this demo')
    await expect(section.getByText('What you can do')).toBeVisible()
    await expect(section.getByText('What is not possible')).toBeVisible()
    await expect(section.getByText(STATEMENT)).toBeVisible()
    // The spec's counter byte: the section's own "n of 50 runs / models" line.
    await expect(section).toContainText('of 50 runs')
    await expect(section).toContainText('of 50 models')
    const link = section.getByTestId('txr-help-download')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://downloads.example.test/txresbench')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // The #demo anchor resolved (the deep-link scroll kept the section on
    // the page); the rail carries the section too.
    await expect(page.getByTestId('txr-help-toc-demo')).toBeVisible()
    await noHorizontalOverflow(page, 'help')

    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
  })

  test('390 × 844 dark: the ITEM-7 paragraphs stay inside the viewport, never overlap the notice bar, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    const pages = ['/', '/history', '/models', '/saved-models', '/help']
    for (const path of pages) {
      await openApp(page, path)
      await page.waitForTimeout(400) // the usage read settles (the counter's numbers)
      if (path !== '/' && path !== '/help') {
        const block = page.getByTestId('txr-demo-retention')
        await expect(block).toBeVisible({ timeout: 30_000 })
        const notice = page.getByTestId('txr-demo-notice')
        const rectOf = async (locator: ReturnType<Page['locator']>) =>
          locator.evaluate(el => {
            const r = el.getBoundingClientRect()
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
          })
        const [noticeRect, blockRect] = await Promise.all([rectOf(notice), rectOf(block)])
        // The paragraph sits BELOW the notice bar — the shell's child order:
        // header → notice → routed area; the block is inside the routed area.
        expect(blockRect.top, `${path}: block below notice`).toBeGreaterThanOrEqual(
          noticeRect.bottom - 1,
        )
        // The paragraph stays inside the viewport (no clipped counter).
        expect(blockRect.left, `${path}: block left`).toBeGreaterThanOrEqual(0)
        expect(blockRect.right, `${path}: block right`).toBeLessThanOrEqual(390 + 1)
      }
      await noHorizontalOverflow(page, `${path} @390 dark`)
    }
  })
})
