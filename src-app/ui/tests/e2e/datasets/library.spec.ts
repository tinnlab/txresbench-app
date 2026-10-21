import { expect, test } from '@playwright/test'
import {
  createDatasetApi,
  gotoDatasets,
  loginOwnerToDatasets,
  ownerToken,
  uploadDatasetApi,
} from './_helpers'

// TEST-33 [ITEM-15] — the `/datasets` library page. Asserts the shared
// HeaderBarContainer top bar (title + search + Upload), the Mine/Shared scope
// tabs, the kit Table with datatype badges + Pagination (seed >20 rows to force
// it), the search-driven empty state, the sidebar nav entry, and a 390px
// narrow-viewport render. Real backend, real DB — no API mocking.
test('datasets library: header, scope tabs, table + badges + pagination, empty state, narrow viewport — TEST-33', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()

  // Seed >20 datasets so Pagination (page-size default 20) renders, plus ONE
  // typed (uploaded .h5ad → single-cell/anndata) so a datatype badge shows. The
  // typed one is created LAST → newest → page 1 (list is created_at DESC).
  await Promise.all(
    Array.from({ length: 24 }, (_, i) => createDatasetApi(request, admin, `lib-${ts}-${i}`)),
  )
  const typedName = `lib-typed-${ts}.h5ad`
  const typed = await uploadDatasetApi(request, admin, typedName)
  expect(typed.datatype, 'uploaded .h5ad was typed by the sniffer').toBeTruthy()

  await loginOwnerToDatasets(page)

  // --- Header bar (HeaderBarContainer): title + search + Upload. ---
  await expect(page.getByRole('heading', { name: 'Datasets' })).toBeVisible()
  await expect(page.getByTestId('datasets-search')).toBeVisible()
  await expect(page.getByTestId('datasets-upload-button')).toBeVisible()

  // --- Scope tabs (Mine / Shared). ---
  await expect(page.getByTestId('datasets-scope')).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Mine/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Shared with me/ })).toBeVisible()

  // --- Table + datatype badges. ---
  await expect(page.getByTestId('datasets-table')).toBeVisible()
  const typedRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: typedName }) })
  await expect(typedRow.getByTestId('dataset-datatype-badge')).toBeVisible()
  await expect(typedRow.getByTestId('dataset-datatype-badge')).not.toHaveText('Untyped')

  // --- Pagination (>20 owned rows). Navigate to page 2 and back. ---
  await expect(page.getByTestId('datasets-pagination')).toBeVisible()
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.getByTestId('datasets-table')).toBeVisible()

  // --- Search-driven empty state (deterministic regardless of seeded rows). ---
  await page.getByTestId('datasets-search').fill(`no-such-dataset-${ts}`)
  await expect(page.getByTestId('datasets-empty')).toBeVisible()
  await expect(page.getByTestId('datasets-empty')).toContainText(/no datasets match/i)
  await page.getByTestId('datasets-search').fill('')
  await expect(page.getByTestId('datasets-table')).toBeVisible()

  // --- Sidebar nav entry exists (permission-gated slot). Case-insensitive name
  // so it matches whether the rail shows the label or an icon-only aria-label. ---
  await expect(
    page.getByTestId('layout-sidebar-nav-menu').getByRole('button', { name: /datasets/i }),
  ).toBeVisible()

  // --- Narrow viewport (390px): the page still renders without body overflow. ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoDatasets(page)
  await expect(page.getByTestId('datasets-page')).toBeVisible()
  await expect(page.getByTestId('datasets-upload-button')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'no horizontal body overflow at 390px').toBeLessThanOrEqual(1)
})
