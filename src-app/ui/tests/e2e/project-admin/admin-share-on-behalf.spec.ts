import { expect, test } from '@playwright/test'
import {
  gotoProjectAdmin,
  loginAsOwner,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  openRowMenu,
  ownerToken,
  seedMember,
  seedProjectOwnedBy,
} from './_helpers'

// TEST-15: the admin shares a project on the owner's behalf — this creates a
// pending invite (like a normal share) which the recipient accepts via their
// notification; the project then joins the recipient's /projects list.
test('admin shares a project on behalf → recipient accepts → project appears in their list', async ({
  page,
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const s = await seedProjectOwnedBy(request, admin, `sobalice${ts}`, `Share-on-behalf ${ts}`)
  const dave = await seedMember(request, admin, `sobdave${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  // Row menu → Share on behalf → pick the recipient → send.
  await openRowMenu(page, s.projectName)
  await page.getByTestId(`project-admin-menu-${s.projectId}-item-share`).click()
  await expect(page.getByTestId('admin-share-form')).toBeVisible()
  await page.getByTestId('admin-share-picker-search').fill(dave.username)
  await page.getByTestId(`admin-share-picker-option-${dave.ownerId}`).click()
  await expect(page.getByTestId('admin-share-picker-selected')).toContainText(dave.username)
  await page.getByTestId('admin-share-submit').click()
  await expect(page.getByTestId('admin-share-form')).toHaveCount(0)

  // Dave (2nd context) sees the share invite in his inbox, accepts it, and the
  // project lands in his projects list.
  const ctx = await browser.newContext()
  const dp = await ctx.newPage()
  await loginMemberToProjects(dp, dave.username, MEMBER_PASSWORD)
  await dp.getByTestId('notification-bell').click()
  await expect(dp.locator('[data-kind="project_share_invite"]')).toBeVisible()
  await dp.locator('[data-testid^="notification-accept-"]').first().click()

  await dp.goto('/projects')
  await expect(dp.getByTestId('projects-page')).toBeVisible()
  await expect(dp.getByTestId('project-card-title').filter({ hasText: s.projectName })).toBeVisible()
  await ctx.close()
})
