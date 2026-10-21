import { expect, test } from '@playwright/test'
import { findDatasetRow, loginOwnerToDatasets, waitForTerminalProcessingStatus } from './_helpers'

// TEST-24 [ITEM-24] — the ingest/convert progress surface shows a NAMED, discrete
// step, not a bare boolean spinner.
//
// PORTED. This spec used to reach that surface by opening the dataset detail's
// "Pipeline" tab and LAUNCHING the import processor from it (`pipeline-timeline` →
// `pipeline-processor-anndata.import` → `pipeline-form-run` → `pipeline-job`). That
// tab was removed ON PURPOSE by `e4ac4af7` ("processing lives in the workbench/
// analysis flow"); `DatasetDetailPage` types its tab union as exactly
// `'contents' | 'supporting' | 'lineage'`, `PipelineTimeline.tsx` survives only as a
// gallery story, and `detail.spec.ts:44` asserts the tab's absence as a non-vacuous
// negative control. The manual launch is therefore GONE from this page (its
// user-initiated successor is the workbench launcher — `tests/e2e/14-workbench/
// analysis-launcher.spec.ts`), and `import.h5ad`/`anndata.import` became
// `trigger: 'on-ingest'` converters (`launcherAvailability.ts::isLauncherVisible`).
//
// So the subject is unchanged but reached the way the product now reaches it: the
// UPLOAD is what enqueues the converter, and the detail page reports its progress on
// `dataset-processing-status` (Queued / Processing / Ready / Failed — a discrete named
// state, `ProcessingStatusBadge`) plus, on failure, a `dataset-processing-failed`
// Alert carrying the converter's own REASON. A name + a reason is exactly the "not a
// bare spinner" guarantee this test exists to enforce, and it is now asserted on a
// surface that exists.
//
// Real streaming upload + the real on-ingest converter + real DB — no API mocking.
test('ingest progress is a named-step surface (named status + reason, not a bare spinner) — TEST-24', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await loginOwnerToDatasets(page)
  const ts = Date.now()
  const name = `milestone-${ts}.h5ad`

  // --- Wizard-upload a typed `.h5ad` (the on-ingest converter trigger). ---
  await page.getByTestId('datasets-upload-button').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeVisible()
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: 'AnnData' }).click()
  await page
    .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
    .setInputFiles([
      { name, mimeType: 'application/octet-stream', buffer: Buffer.from(`anndata-${ts}`) },
    ])
  await page.getByTestId('dataset-upload-submit').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeHidden({ timeout: 30_000 })

  // --- Open its detail. The upload already enqueued the converter. (`findDatasetRow`
  // filters the library to this name first — see its doc for the concurrent-seed
  // hazard that makes a bare page-1 lookup unreliable.) ---
  const row = await findDatasetRow(page, name)
  await row.getByRole('link', { name }).click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()

  // --- The progress surface is a NAMED step, not a boolean spinner. ---
  const status = page.getByTestId('dataset-processing-status')
  await expect(status).toBeVisible({ timeout: 30_000 })
  await expect(status).not.toBeEmpty()
  await expect(status).toHaveText(/Queued|Processing|Ready|Failed/)
  // The name is machine-readable too (a screen reader gets the state, not a spinner).
  await expect(status).toHaveAttribute('aria-label', /Processing status: /)

  // --- …and it REACHES a terminal named state, carrying a reason when it failed. ---
  // The seeded `.h5ad` is SYNTHETIC (not a real AnnData container), so the real
  // converter runs and errors — which is the point: a failure must be REPORTED by
  // name, with the converter's own reason, never left as an opaque spinner.
  // (`waitForTerminalProcessingStatus` no longer reloads between polls — the terminal
  // transition is published now, so this waits on the LIVE badge. See its doc.)
  const label = await waitForTerminalProcessingStatus(page)
  expect(label, 'the ingest run must report a terminal NAMED state').toMatch(/^(Ready|Failed)$/)
  if (label === 'Failed') {
    const failure = page.getByTestId('dataset-processing-failed')
    await expect(failure).toBeVisible()
    // The REAL converter reason, not the component's generic fallback — that
    // distinction is what makes this "named step + why", rather than "it broke".
    await expect(failure).not.toContainText('Check the Lineage tab for details')
  }

  // --- Richer milestone-CHECKLIST leg (the per-step `read/done {cells, genes}` /
  // embeddings / metadata findings the converter emits as `milestone` SSE frames —
  // `compute/h5ad_import.py` → MilestoneFrame). No FE stepper renders them on this
  // branch, so this leg self-skips WITH ITS REASON rather than being dropped; it
  // upgrades automatically the day the stepper lands. The named-step guarantee above
  // is asserted unconditionally, so this is an extra, never the test's only content. ---
  const milestones = page.locator(
    '[data-testid^="milestone-"], [data-testid^="pipeline-milestone"], [data-testid="pipeline-milestones"]',
  )
  if ((await milestones.count()) > 0) {
    await expect(milestones.first()).toBeVisible()
    await expect(milestones.first()).not.toBeEmpty()
  } else {
    const reason =
      'no milestone-checklist surface rendered — the backend converter emits `milestone` SSE ' +
      'frames (`compute/h5ad_import.py` → MilestoneFrame), but no FE stepper renders them on ' +
      'this branch. Asserted the achievable named-step progress surface instead ' +
      '(dataset-processing-status + its terminal state + the failure reason).'
    test.info().annotations.push({ type: 'self-skip (milestone-checklist leg)', description: reason })
    // eslint-disable-next-line no-console
    console.log(`[TEST-24] milestone-checklist leg SELF-SKIPPED — ${reason}`)
  }
})
