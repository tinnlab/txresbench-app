import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { createProjectApi } from '../datasets/_helpers'

// TEST-10 (richer-actions ITEM-3) — the workbench command palette matches an action
// by alias/keyword/description, not only the title.
test('workbench palette finds "Add dataset" by an alias term — TEST-10', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProjectApi(request, admin, `Alias WB ${Date.now()}`)
  await loginAsOwner(page)
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1000)

  await page.getByTestId('workbench-command-input').click()
  // Alias term, not the title.
  await page.getByTestId('workbench-command-input').fill('import')
  await expect(page.getByTestId('workbench-command-dataset.add')).toBeVisible()

  // A non-matching term shows nothing.
  await page.getByTestId('workbench-command-input').fill('zzznope')
  await expect(page.getByTestId('workbench-command-dataset.add')).toHaveCount(0)
})
