import { expect, test } from '@playwright/test'
import { gotoProjectAdmin, loginAsOwner, ownerToken, seedProjectOwnedBy } from './_helpers'

// TEST-13: clicking a project name opens the admin drill-down drawer, which shows
// the owner, the shares section, the datasets section, and the governance
// actions (change-owner / share-on-behalf / delete).
test('admin opens a project detail drawer (owner + shares + datasets + actions)', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const s = await seedProjectOwnedBy(request, admin, `detailowner${ts}`, `Detail project ${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  await page.getByTestId(`project-admin-name-${s.projectId}`).click()

  const drawer = page.getByTestId('project-admin-detail')
  await expect(drawer).toBeVisible()

  // Owner identity.
  await expect(page.getByTestId('detail-owner-name')).toContainText(s.owner.username)
  await expect(page.getByTestId('detail-owner-email')).toContainText(`${s.owner.username}@cyto.test`)

  // Shares + datasets sections (this freshly-seeded project has neither yet).
  await expect(page.getByTestId('detail-shares-empty')).toBeVisible()
  await expect(page.getByTestId('detail-datasets-empty')).toBeVisible()

  // Governance actions (manage-gated — the admin holds project::admin::manage).
  await expect(page.getByTestId('detail-change-owner')).toBeVisible()
  await expect(page.getByTestId('detail-share')).toBeVisible()
  await expect(page.getByTestId('detail-delete')).toBeVisible()
})
