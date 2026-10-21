import { expect, test } from '@playwright/test'
import {
  createMember,
  loginAsOwner,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  ownerToken,
  runProjectCardAction,
} from './_helpers'

// TEST-11: when the owner shares a project, the recipient's notification bell shows
// an unread badge and the inbox renders the `project_share_invite` kind with
// Accept/Decline; Accept imports the project into the recipient's list.
//
// The share is now initiated from the projects-list card ⋮ menu ("Share") rather than a
// `project-detail-share` header button — a7c75ef1 made every project URL the full-bleed
// workbench, whose shell renders no header. Same drawer, same store action.
test('share → recipient bell badge + inbox renderer + accept', async ({ page, browser, request }) => {
  const admin = await ownerToken(request)
  const carol = `carol${Date.now()}`
  await createMember(request, admin, carol)

  await loginAsOwner(page)
  const name = `Notify ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await runProjectCardAction(page, name, /^share$/i)
  await page.getByTestId('project-share-email').fill(`${carol}@cyto.test`)
  await page.getByTestId('project-share-submit').click()

  // Carol sees an unread notification badge + the kind-dispatched renderer.
  const ctx = await browser.newContext()
  const cp = await ctx.newPage()
  await loginMemberToProjects(cp, carol, MEMBER_PASSWORD)
  await expect(cp.getByTestId('notification-unread-badge')).toBeVisible()
  await cp.getByTestId('notification-bell').click()
  await expect(cp.locator('[data-testid^="notification-row-"]').first()).toBeVisible()
  await expect(cp.locator('[data-kind="project_share_invite"]')).toBeVisible()
  await expect(cp.locator('[data-testid^="notification-accept-"]').first()).toBeVisible()
  await expect(cp.locator('[data-testid^="notification-decline-"]').first()).toBeVisible()

  // Accept → the project lands in carol's list.
  await cp.locator('[data-testid^="notification-accept-"]').first().click()
  await cp.goto('/projects')
  await expect(
    cp.getByTestId('project-card-title').filter({ hasText: name }),
  ).toBeVisible()
  await ctx.close()
})
