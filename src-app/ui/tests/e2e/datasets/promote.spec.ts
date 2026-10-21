import { expect, test } from '@playwright/test'
import {
  BACKEND,
  loginAsOwner,
  ownerToken,
  uploadDatasetApi,
  waitForTerminalProcessingStatus,
} from './_helpers'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// TEST-32 [ITEM-7] — promote a run's `role='artifact'` output to a new owned dataset
// (byte-preserving; it appears in the library with the "promoted" marker).
//
// PORTED. Both tests used to reach a run by clicking `pipeline-processor-import.h5ad`
// → `pipeline-form-run` on the detail page's "Pipeline" tab. That tab was removed ON
// PURPOSE by `e4ac4af7` ("processing lives in the workbench/analysis flow");
// `DatasetDetailPage` types its tabs as exactly `'contents' | 'supporting' | 'lineage'`
// and `detail.spec.ts:44` asserts the removed tab's absence as a non-vacuous negative
// control. The manual-launch assertions are therefore DELETED — that capability is gone
// from this page, not relocated within it; the user-initiated launch surface is the
// workbench launcher (`tests/e2e/14-workbench/analysis-launcher.spec.ts`, which asserts
// a row becomes AVAILABLE once its input datatype exists and that launching opens a run
// pane).
//
// The run itself is NOT lost: the import processors became `trigger: 'on-ingest'`
// converters, so UPLOADING is what enqueues the run whose outputs Lineage lists.
// Test 2 drives that real run to completion — which the old spec never managed (it
// seeded synthetic bytes, so the run always failed and every promote assertion sat
// behind a permanently-false `if`). It now asserts the promote AFFORDANCE against the
// server's own `promotable` flag, output by output.

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../14-declarative-qc/fixtures/tiny_counts.h5ad',
)

interface ForwardOutput {
  id: string
  output_id: string
  datatype: string
  promotable: boolean
}

test('promote surface: a dataset with no derived run has an empty lineage and offers nothing to promote — TEST-32 (surface)', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // A metadata-only dataset: no files ⇒ no on-ingest converter ⇒ no run, ever.
  const created = await request.post(`${BACKEND}/api/datasets`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name: `promote-empty-${Date.now()}` },
  })
  expect(created.ok(), `create dataset -> ${created.status()}`).toBeTruthy()
  const ds = await created.json()

  await loginAsOwner(page)
  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()

  // With no derived run there is nothing to promote — the deterministic,
  // compute-free half of ITEM-7.
  await page.getByRole('tab', { name: 'Lineage' }).click()
  await expect(page.getByTestId('dataset-lineage-empty')).toBeVisible()
  // Non-vacuous: "empty" must mean no promotable output was offered, asserted against
  // the tab panel that was just proved to render — not against a page that failed to load.
  await expect(page.getByTestId('dataset-tab-lineage')).toBeVisible()
  await expect(page.locator('[data-testid^="dataset-lineage-promote-"]')).toHaveCount(0)
})

test('promote: a completed run lists its outputs, and Promote is offered exactly for the promotable ones — TEST-32', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const admin = await ownerToken(request)
  // A REAL AnnData fixture (the same committed input `import-zarr.spec.ts` drives), so
  // the on-ingest converter genuinely COMPLETES and Lineage is genuinely populated.
  const ds = await uploadDatasetApi(
    request,
    admin,
    `promote-${Date.now()}.h5ad`,
    readFileSync(FIXTURE),
  )

  await loginAsOwner(page)
  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()

  // The on-ingest run reaches a terminal state, reported by the UI's own badge.
  // (`waitForTerminalProcessingStatus` no longer reloads between polls — the terminal
  // transition is published now, so this waits on the LIVE badge. See its doc.)
  const label = await waitForTerminalProcessingStatus(page)
  expect(label, 'the committed fixture must convert — a failure here is a real one').toBe('Ready')

  // Lineage is populated: the run node with its completed status, and its outputs.
  await page.getByRole('tab', { name: 'Lineage' }).click()
  await expect(page.getByTestId('dataset-lineage')).toBeVisible()
  await expect(page.getByTestId('dataset-lineage-runs')).toBeVisible()
  await expect(page.locator('[data-testid^="dataset-lineage-run-status-"]').first()).toHaveText(
    'completed',
  )
  const outputRows = page.locator('[data-testid^="dataset-lineage-output-"]:not([data-testid*="-type-"])')
  await expect(outputRows.first()).toBeVisible()

  // The promote AFFORDANCE is checked against the SERVER's own `promotable` verdict,
  // output by output — two independent sources, so neither "every output has Promote"
  // nor "no output has Promote" can pass by accident.
  const forward = await request.get(
    `${BACKEND}/api/provenance/forward?dataset_id=${ds.id}`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(forward.ok(), `forward provenance -> ${forward.status()}`).toBeTruthy()
  const outputs = (await forward.json()).outputs as ForwardOutput[]
  expect(outputs.length, 'a completed import must have emitted outputs').toBeGreaterThan(0)
  await expect(outputRows).toHaveCount(outputs.length)
  for (const out of outputs) {
    await expect(
      page.getByTestId(`dataset-lineage-promote-${out.id}`),
      `${out.output_id} (${out.datatype}) promotable=${out.promotable}`,
    ).toHaveCount(out.promotable ? 1 : 0)
  }

  // …and when one IS promotable, promoting it yields a new owned dataset carrying the
  // `promote` source + the library marker. An on-ingest import emits only COMPONENT
  // datatypes (pieces INSIDE a dataset), which `LineageView` deliberately does not
  // offer Promote for, so this leg is conditional on the deployment shipping a
  // processor that emits a dataset-INPUT artifact. The assertion above is what makes
  // that conditional honest: it PROVES the zero-promote case is the server's verdict
  // and not a broken surface.
  const promotable = outputs.filter(o => o.promotable)
  if (promotable.length > 0) {
    await page.getByTestId(`dataset-lineage-promote-${promotable[0].id}`).click()
    await expect(page).toHaveURL(new RegExp(`/datasets/(?!${ds.id})[0-9a-f-]{36}$`), {
      timeout: 30_000,
    })
    await expect(page.getByTestId('dataset-contents-info')).toContainText('promote')
    await page.goto('/datasets')
    await expect(page.getByLabel('Promoted from an artifact').first()).toBeVisible()
  } else {
    const reason =
      'no output of the on-ingest converter is `promotable` (server verdict, asserted above): ' +
      'this deployment ships only converters that emit COMPONENT datatypes, which are pieces ' +
      'inside a dataset rather than a standalone dataset input. The byte-preserving promote ' +
      'itself is covered by the backend `dataset::promote_test` (real pbmc3k fixture).'
    test.info().annotations.push({ type: 'self-skip (promote-click leg)', description: reason })
    // eslint-disable-next-line no-console
    console.log(`[TEST-32] promote-click leg SELF-SKIPPED — ${reason}`)
  }
})
