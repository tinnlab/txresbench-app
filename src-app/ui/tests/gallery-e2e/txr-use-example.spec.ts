import { expect, test, type Page } from '@playwright/test'

/**
 * TXRUSE-EXAMPLE — qa-fixes3 ITEM-5 / TEST-QF3-3's browser leg: the
 * gallery story's real-browser guard of the ONE-CLICK example flows
 * (backend-free: the `txrintake/gallery.tsx` cassette answers the example
 * family bytes, the mock validate/inspect derive from the browser's own
 * parse, and the story extends the ITEM-3 example-set ready answer).
 *
 * Per path, on a FRESH start: click the card's "Use example" → the flow
 * lands on the path's file step (`/files` for train, `/predict-files` for
 * the two predict paths) → the landing step has EVERYTHING filled (the
 * example file cards with the "Example" badge, the "This is example
 * data" banner) and Continue ENABLED once the screen's own inspect/validate
 * round settles (the mock validator's error-free state — the family's
 * normal per-marker A04 unit notes are warnings, never a block) → clicking
 * Continue reaches the next step
 * (`/choose-methods` for train, `/pretrained-models` for pretrained,
 * `/saved-models` for reuse — recorded in the story's navigation seam).
 *
 * The ITEM-4 amendment pins the landing step reading: the file step IS the
 * step with the Continue affordance (the D/I screens have none — their one
 * action is the list's run bar that path 1 does not preselect).
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-use-example.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server pays the whole graph's transform — the
// intake spec's convention (a wider clock than the config's fast loop).
test.setTimeout(600_000)

const STORY = 'txr-intake-use-example'
const STEP_SEAM = 'txr-use-example-step'
const EXAMPLES_BADGE = 'txr-file-card-example-measurements'

async function openStart(page: Page): Promise<void> {
  await page.goto(`${GALLERY}${STORY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('txr-intake-start-card-train')).toBeVisible()
  // The story's mount reset runs after first paint; the landing frame is
  // the fresh state. The hint card of the landing page is visible only when
  // nothing runs yet.
  await expect(page.getByTestId('txr-intake-start-example-hint')).toBeVisible()
}

test.describe('txr-use-example — one click per path (test QF3-3)', () => {
  test('learn from my data: one click fills /files (badge + banner), Continue enabled → /choose-methods', async ({ page }) => {
    await openStart(page)
    await page.getByTestId('txr-use-example-train').click()

    // The flow lands on the file step.
    await expect(page.getByTestId('txr-intake-files')).toBeVisible()
    // Everything filled: both cards are example-flagged; the banner is up.
    await expect(page.getByTestId('txr-file-card-example-patients')).toBeVisible()
    await expect(page.getByTestId(EXAMPLES_BADGE)).toBeVisible()
    await expect(page.getByTestId('txr-intake-example-loaded')).toBeVisible()
    await expect(page.getByTestId('txr-intake-example-loaded')).toContainText('This is example data')
    // The file steps' own inspect/validate round settles → Continue enabled.
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
    // Continue reaches the next step (screen E).
    await page.getByTestId('txr-intake-continue').click()
    await expect(page.getByTestId(STEP_SEAM)).toHaveText('next step: /choose-methods')
  })

  test('predict with a pretrained model: one click fills /predict-files, Continue enabled → /pretrained-models', async ({ page }) => {
    await openStart(page)
    await page.getByTestId('txr-use-example-pretrained').click()

    await expect(page.getByTestId('txr-intake-predict-files')).toBeVisible()
    await expect(page.getByTestId(EXAMPLES_BADGE)).toBeVisible()
    await expect(page.getByTestId('txr-intake-example-loaded')).toBeVisible()
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
    await page.getByTestId('txr-intake-continue').click()
    await expect(page.getByTestId(STEP_SEAM)).toHaveText('next step: /pretrained-models')
  })

  test('use a model I saved: one click fills /predict-files (the example set answers ready), Continue enabled → /saved-models', async ({ page }) => {
    await openStart(page)
    await page.getByTestId('txr-use-example-reuse').click()

    await expect(page.getByTestId('txr-intake-predict-files')).toBeVisible()
    await expect(page.getByTestId(EXAMPLES_BADGE)).toBeVisible()
    await expect(page.getByTestId('txr-intake-example-loaded')).toBeVisible()
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
    // The one-click promise of the reuse path: the example set (ITEM-3) was
    // ensured during the click — the progress line must NOT be visible once
    // the flow landed (the ready answer settles in one round).
    await expect(page.getByTestId('txr-use-example-progress-reuse')).not.toBeVisible()
    await page.getByTestId('txr-intake-continue').click()
    await expect(page.getByTestId(STEP_SEAM)).toHaveText('next step: /saved-models')
  })
})
