import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  findDatasetRow,
  loginOwnerToDatasets,
  ownerToken,
  singleFileTypeTitle,
  waitForTerminalProcessingStatus,
} from './_helpers'

// TEST-41 [ITEM-10/14/16/20/21] — the whole slice on the real canvas: upload → the
// library row → open detail → Contents inspects the uploaded file → the on-ingest
// converter RUNS → the Lineage tab shows the forward graph (dataset → runs → outputs).
//
// PORTED, and the compute leg now actually EXECUTES.
//
// Two of this spec's surfaces no longer exist:
//   • the multi-select dropzone (`dataset-upload-input`) — the panel is the TYPE-FIRST
//     wizard (`UploadPanel.tsx`); the type is chosen first and reveals its own input.
//     Ported (the upload still happens, through the wizard).
//   • the detail page's "Pipeline" tab and its `pipeline-processor-*` →
//     `pipeline-form-run` launch — removed ON PURPOSE by `e4ac4af7` ("processing lives
//     in the workbench/analysis flow"); the tab union is now exactly
//     `'contents' | 'supporting' | 'lineage'` and `detail.spec.ts:44` asserts the tab's
//     absence as a non-vacuous negative control. Those assertions are DELETED, not
//     re-expressed: the user-initiated launch surface is the workbench launcher, and
//     `tests/e2e/14-workbench/analysis-launcher.spec.ts` owns it (a row becomes
//     AVAILABLE once its input datatype exists; launching opens a run pane).
//
// The RUN is not lost with the tab. The import processors became
// `trigger: 'on-ingest'` converters (`launcherAvailability.ts::isLauncherVisible`), so
// the upload itself is what enqueues the run — which is why this spec can now seed a
// REAL committed fixture and assert a COMPLETED run with a populated lineage graph.
// The old spec seeded synthetic bytes, so its compute leg sat behind an
// `if (finalStatus === 'completed')` that never once evaluated true.
const EXT = 'h5ad'
const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  `../14-declarative-qc/fixtures/tiny_counts.${EXT}`,
)

test('vertical slice: wizard upload → library row → detail → on-ingest run completes → lineage graph — TEST-41', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const admin = await ownerToken(request)
  // The wizard option label is DERIVED from the registry for this extension.
  const typeTitle = await singleFileTypeTitle(request, admin, EXT)
  await loginOwnerToDatasets(page)
  const ts = Date.now()
  const name = `slice-${ts}.${EXT}`

  // --- Upload through the real type-first wizard → a new typed dataset row appears. ---
  await page.getByTestId('datasets-upload-button').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeVisible()
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: typeTitle, exact: true }).click()
  await page
    .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
    .setInputFiles([{ name, mimeType: 'application/octet-stream', buffer: readFileSync(FIXTURE) }])
  await page.getByTestId('dataset-upload-submit').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeHidden({ timeout: 60_000 })

  // --- Open its detail from the library table row (`findDatasetRow` filters the
  // library to this name first — see its doc for the concurrent-seed hazard). ---
  const row = await findDatasetRow(page, name)
  await row.getByRole('link', { name }).click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()
  await expect(page.getByTestId('dataset-detail-name')).toHaveText(name)

  // --- Contents inspects what was actually stored. ---
  await expect(page.getByTestId('dataset-tab-contents')).toBeVisible()
  await expect(page.getByTestId('dataset-contents-info')).toBeVisible()
  await expect(page.getByTestId('dataset-files-table')).toContainText(name)

  // --- The on-ingest run reaches a terminal state, reported by the UI's own badge.
  // (`waitForTerminalProcessingStatus` no longer reloads between polls — the terminal
  // transition is published now, so this waits on the LIVE badge. See its doc.) ---
  const label = await waitForTerminalProcessingStatus(page)
  expect(
    label,
    'the committed fixture must convert — a failure here is a real regression, not an env skip',
  ).toBe('Ready')

  // --- The Lineage tab renders the POPULATED forward graph: dataset → run → outputs. ---
  await page.getByRole('tab', { name: 'Lineage' }).click()
  await expect(page.getByTestId('dataset-tab-lineage')).toBeVisible()
  await expect(page.getByTestId('dataset-lineage')).toBeVisible()
  await expect(page.locator('[data-testid^="dataset-lineage-run-"]').first()).toBeVisible()
  await expect(page.locator('[data-testid^="dataset-lineage-run-status-"]').first()).toHaveText(
    'completed',
  )
  await expect(page.getByTestId('dataset-lineage-outputs')).toBeVisible()
  await expect(page.locator('[data-testid^="dataset-lineage-output-type-"]').first()).toBeVisible()
})
