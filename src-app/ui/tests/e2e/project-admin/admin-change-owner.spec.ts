import { expect, test } from '@playwright/test'
import {
  gotoProjectAdmin,
  loginAsOwner,
  openRowMenu,
  ownerToken,
  seedMember,
  seedProjectOwnedBy,
} from './_helpers'

// TEST-14: the admin forces a change of owner from the row menu — picks the new
// owner via the UserPicker (search → option), toggles keep-old-as-editor, submits
// — and the row's owner column updates to the new owner.
test('admin changes a project owner via the row menu + UserPicker', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const s = await seedProjectOwnedBy(request, admin, `coalice${ts}`, `Change-owner project ${ts}`)
  const carol = await seedMember(request, admin, `cocarol${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  // Row menu → Change owner.
  await openRowMenu(page, s.projectName)
  await page.getByTestId(`project-admin-menu-${s.projectId}-item-change-owner`).click()
  await expect(page.getByTestId('change-owner-form')).toBeVisible()

  // Pick the new owner through the search-select UserPicker.
  await page.getByTestId('change-owner-picker-search').fill(carol.username)
  await page.getByTestId(`change-owner-picker-option-${carol.ownerId}`).click()
  await expect(page.getByTestId('change-owner-picker-selected')).toContainText(carol.username)

  // Keep the previous owner as an editor, then submit.
  await page.getByTestId('change-owner-keep-editor').click()
  await page.getByTestId('change-owner-submit').click()

  // The row's owner column now reflects the new owner.
  await expect(page.getByTestId('change-owner-form')).toHaveCount(0)
  await expect(page.getByTestId(`project-admin-owner-${s.projectId}`)).toContainText(carol.username)
})
