import { expect, test } from '@playwright/test'
import { createProjectAs, gotoProjectAdmin, loginAsOwner, ownerToken, seedMember } from './_helpers'

// TEST-17: the offboarding accelerator — the admin clicks an owner to filter to
// their projects, hits "Reassign all their projects", picks a target owner via the
// UserPicker, and every one of the original owner's projects moves to the target.
test('admin reassigns ALL of one owner\'s projects to another owner', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const eve = await seedMember(request, admin, `raeve${ts}`)
  const frank = await seedMember(request, admin, `rafrank${ts}`)
  const id1 = await createProjectAs(request, eve.token, `Reassign A ${ts}`)
  const id2 = await createProjectAs(request, eve.token, `Reassign B ${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  // Click an owner cell → filter to that owner; the offboarding bar appears.
  await page.getByTestId(`project-admin-owner-${id1}`).click()
  await expect(page.getByTestId('project-admin-owner-filter')).toBeVisible()

  // Reassign-all → pick the target owner → submit.
  await page.getByTestId('project-admin-reassign-all').click()
  await expect(page.getByTestId('reassign-form')).toBeVisible()
  await page.getByTestId('reassign-picker-search').fill(frank.username)
  await page.getByTestId(`reassign-picker-option-${frank.ownerId}`).click()
  await expect(page.getByTestId('reassign-picker-selected')).toContainText(frank.username)
  await page.getByTestId('reassign-submit').click()
  await expect(page.getByTestId('reassign-form')).toHaveCount(0)

  // The list is still filtered to the (now empty) original owner.
  await expect(page.getByTestId('project-admin-empty')).toBeVisible()

  // Clear the filter + look the projects up by name → they now belong to frank.
  await page.getByTestId('project-admin-owner-filter-clear').click()
  await page.getByTestId('project-admin-search').fill(`Reassign A ${ts}`)
  await expect(page.getByTestId(`project-admin-owner-${id1}`)).toContainText(frank.username)

  await page.getByTestId('project-admin-search').fill(`Reassign B ${ts}`)
  await expect(page.getByTestId(`project-admin-owner-${id2}`)).toContainText(frank.username)
})
