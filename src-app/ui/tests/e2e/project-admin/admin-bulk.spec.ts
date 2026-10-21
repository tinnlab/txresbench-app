import { expect, test } from '@playwright/test'
import { createProjectAs, gotoProjectAdmin, loginAsOwner, ownerToken, seedMember } from './_helpers'

// TEST-23 / ITEM-20: the admin multi-selects rows, the bulk action bar appears,
// and a bulk delete (with its own cascade confirm) removes every selected project.
test('admin bulk-selects two projects and bulk-deletes them', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const owner = await seedMember(request, admin, `bulkowner${ts}`)
  const id1 = await createProjectAs(request, owner.token, `Bulk project A ${ts}`)
  const id2 = await createProjectAs(request, owner.token, `Bulk project B ${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  // Select the two seeded rows (exact ids — never span other specs' rows).
  await page.getByTestId(`project-admin-select-${id1}`).click()
  await page.getByTestId(`project-admin-select-${id2}`).click()

  // The bulk bar appears with the selected count.
  const bar = page.getByTestId('project-admin-bulk-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('2 selected')

  // Bulk delete → its cascade confirm → gone.
  await page.getByTestId('project-admin-bulk-delete').click()
  await expect(page.getByTestId('project-admin-bulk-delete-confirm')).toBeVisible()
  await page.getByTestId('project-admin-bulk-delete-confirm-confirm').click()

  await expect(page.getByTestId(`project-admin-row-${id1}`)).toHaveCount(0)
  await expect(page.getByTestId(`project-admin-row-${id2}`)).toHaveCount(0)
})
