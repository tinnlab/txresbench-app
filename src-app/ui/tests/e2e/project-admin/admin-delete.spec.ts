import { expect, test } from '@playwright/test'
import {
  gotoProjectAdmin,
  loginAsOwner,
  openRowMenu,
  ownerToken,
  seedProjectOwnedBy,
} from './_helpers'

// TEST-16: the admin deletes a project from the row menu; the confirm dialog
// states the cascade (shares + dataset links removed, datasets themselves kept),
// and on confirm the row disappears from the list.
test('admin deletes a project via the row menu + cascade confirm', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const s = await seedProjectOwnedBy(request, admin, `deleve${ts}`, `Delete project ${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  await expect(page.getByTestId(`project-admin-row-${s.projectId}`)).toBeVisible()

  await openRowMenu(page, s.projectName)
  await page.getByTestId(`project-admin-menu-${s.projectId}-item-delete`).click()

  // The confirm names the cascade.
  const confirm = page.getByTestId('project-admin-delete-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('shares')
  await expect(confirm).toContainText('dataset links')
  await expect(confirm).toContainText('NOT deleted')

  // Confirm → the row disappears.
  await page.getByTestId('project-admin-delete-confirm-confirm').click()
  await expect(page.getByTestId(`project-admin-row-${s.projectId}`)).toHaveCount(0)
})
