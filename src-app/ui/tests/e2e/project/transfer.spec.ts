import { expect, test } from '@playwright/test'
import {
  createMember,
  loginAsOwner,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  ownerToken,
  runProjectCardAction,
} from './_helpers'

// TEST-30: owner initiates a transfer to another user by email; that user accepts
// via the transfer notification; they then own the project (Owner badge) and the
// original owner no longer sees it.
//
// The transfer is now started from the projects-list card ⋮ menu ("Transfer ownership")
// rather than a `project-detail-transfer` header button: a7c75ef1 made the full-bleed
// workbench the only project section, so the detail shell's header renders nowhere. Same
// drawer, same store action — only the entry point moved.
test('transfer ownership → recipient accepts → ownership moves', async ({ page, browser, request }) => {
  const admin = await ownerToken(request)
  const dave = `dave${Date.now()}`
  await createMember(request, admin, dave)

  await loginAsOwner(page)
  const name = `Transfer ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await runProjectCardAction(page, name, /transfer/i)
  await page.getByTestId('project-transfer-email').fill(`${dave}@txresbench.test`)
  await page.getByTestId('project-transfer-submit').click()

  // Dave accepts the transfer via his notification.
  const ctx = await browser.newContext()
  const dp = await ctx.newPage()
  await loginMemberToProjects(dp, dave, MEMBER_PASSWORD)
  await dp.getByTestId('notification-bell').click()
  // Wait for the transfer notification to land in the inbox (it arrives via a
  // sync-driven refetch) before clicking — under load the row isn't in the DOM
  // the instant the bell opens. Mirrors the notifications/sharing specs.
  const acceptBtn = dp.locator('[data-testid^="notification-accept-"]').first()
  await expect(acceptBtn).toBeVisible()
  await acceptBtn.click()

  // Dave now owns it.
  await dp.goto('/projects')
  await expect(dp.getByTestId('projects-page')).toBeVisible()
  const daveCard = dp
    .locator('[data-testid^="project-card-"]')
    .filter({ has: dp.getByTestId('project-card-title').filter({ hasText: name }) })
    .first()
  await expect(daveCard.getByTestId('project-permission-badge')).toHaveText(/owner/i)

  // The original owner no longer sees it.
  await page.goto('/projects')
  await expect(page.getByTestId('project-card-title').filter({ hasText: name })).toHaveCount(0)
  await ctx.close()
})
