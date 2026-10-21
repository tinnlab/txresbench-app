import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { createProjectApi } from '../datasets/_helpers'

// TEST-9 (richer-actions ITEM-2) — the global ⌘K palette finds an action by an
// ALIAS term, not only its literal title. "Add dataset" has no "import" in its
// title, but does in its aliases/keywords, so typing "import" must surface it.
test('⌘K finds "Add dataset" by an alias term, not only its title — TEST-9', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProjectApi(request, admin, `Alias K ${Date.now()}`)
  await loginAsOwner(page)
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1000) // the workbench instance + context register

  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('command-palette-input')).toBeVisible()

  // "import" is in the ALIASES ("import data"), NOT the title "Add dataset".
  await page.getByTestId('command-palette-input').fill('import')
  await expect(page.getByTestId('command-palette-item-dataset.add')).toBeVisible()

  // A non-matching term hides it.
  await page.getByTestId('command-palette-input').fill('zzznope')
  await expect(page.getByTestId('command-palette-item-dataset.add')).toHaveCount(0)
})
