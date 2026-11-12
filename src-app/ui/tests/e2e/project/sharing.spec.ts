import { expect, test } from '@playwright/test'
import {
  createMember,
  loginAsOwner,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  openProjectCardMenu,
  ownerToken,
  projectCard,
  runProjectCardAction,
} from './_helpers'

// TEST-26: owner shares a project with an editor by email → the recipient accepts
// via their notification → the project joins their list with an Editor badge → an
// editor sees NO Share/Transfer/Delete affordance (owner-only).
//
// Two surfaces moved with a7c75ef1 (full-bleed workbench ⇒ no detail-page header):
//  - Share is initiated from the projects-list card ⋮ menu, not a header button.
//  - The "Shared with" list (`project-share-panel`) now renders INSIDE the share drawer.
//    It previously rendered only on the sectioned detail page, which became unreachable,
//    so an owner had NO way to see or revoke shares. Restoring it in the drawer is the
//    source fix this spec update accompanies.
test('share to editor → accept → editor gating', async ({ page, browser, request }) => {
  const admin = await ownerToken(request)
  const bob = `bob${Date.now()}`
  await createMember(request, admin, bob)

  // Owner creates + shares a project with bob as editor.
  await loginAsOwner(page)
  const name = `Shared ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await runProjectCardAction(page, name, /^share$/i)
  // Positive control for the "Shared with" assertion below: the list renders its EMPTY
  // state before the invite. Without this, `toContainText(bob)` could not distinguish
  // "the invite landed" from "the panel appeared for the first time"; and if the panel
  // ever stops rendering, this fails loudly rather than the suite going quiet.
  await expect(page.getByTestId('project-share-empty')).toBeVisible()
  await page.getByTestId('project-share-email').fill(`${bob}@txresbench.test`)
  // Pick the "editor" option in the level select.
  await page.getByTestId('project-share-level').click()
  await page.getByRole('option', { name: /editor/i }).click()
  await page.getByTestId('project-share-submit').click()
  // The "Shared with" panel (inside the drawer) now lists bob, and the empty state is gone.
  await expect(page.getByTestId('project-share-panel')).toContainText(bob)
  await expect(page.getByTestId('project-share-empty')).toHaveCount(0)

  // Bob (2nd context) logs in, accepts via the notification, sees it as editor.
  const ctx = await browser.newContext()
  const bp = await ctx.newPage()
  await loginMemberToProjects(bp, bob, MEMBER_PASSWORD)
  // Open the notification bell + accept the share invite.
  await bp.getByTestId('notification-bell').click()
  await bp.locator('[data-testid^="notification-accept-"]').first().click()
  // The project now appears in bob's list with an Editor badge.
  await bp.goto('/projects')
  await expect(bp.getByTestId('projects-page')).toBeVisible()
  await expect(projectCard(bp, name).getByTestId('project-permission-badge')).toHaveText(/editor/i)

  // An editor's card menu offers NO Share / Transfer / Delete. `openProjectCardMenu`
  // asserts the menu actually opened (the unconditional "Open" item) BEFORE the
  // absence checks, so these cannot pass on a menu that never rendered.
  await openProjectCardMenu(bp, name)
  await expect(bp.getByRole('menuitem', { name: /^share$/i })).toHaveCount(0)
  await expect(bp.getByRole('menuitem', { name: /transfer/i })).toHaveCount(0)
  await expect(bp.getByRole('menuitem', { name: /^delete$/i })).toHaveCount(0)
  // …but Edit IS available (editor can edit metadata) — a second control proving the
  // menu is populated with permission-dependent items, not just the static "Open".
  await expect(bp.getByRole('menuitem', { name: /^edit$/i })).toBeVisible()
  await ctx.close()
})
