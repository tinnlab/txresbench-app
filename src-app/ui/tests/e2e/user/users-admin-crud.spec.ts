import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'

// TEST-11 [covers ITEM-1, ITEM-5, ITEM-15] (#49) — behavior-preservation for the Users
// identity-CRUD refactor. The create + delete controls now dispatch permissioned
// `defineAction`s (`user.create` / `user.delete`) instead of calling the store inline, but
// the HUMAN path must behave exactly as before. This drives the real Users page end-to-end:
// open the Create-User drawer → submit → the new row appears (proves the `user.create` action
// path, AND that `user/module.tsx` actually side-effect-imports `usersAdminActions` — if it
// did not, `runAction('user.create')` would throw and no row would appear). Then delete the
// row via its Confirm (proves the `user.delete` action path).
//
// The e2e harness drives the DEFAULT (saas-off) build; the Users page + users::* permissions
// are present there (the owner holds them), so this exercises the real backend.

test('owner creates a user then deletes it — through the defineAction seam', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/users')
  await expect(page.getByTestId('user-list-card')).toBeVisible({ timeout: 30_000 })

  const ts = Date.now()
  const username = `e2ecrud${ts}`
  const email = `${username}@x.test`

  // ── CREATE via the drawer → dispatches runAction('user.create', …) on submit ──
  await page.getByTestId('user-create-open-button').click()
  await expect(page.getByTestId('user-create-form')).toBeVisible()
  await page.getByTestId('user-create-username-input').fill(username)
  await page.getByTestId('user-create-email-input').fill(email)
  await page.getByTestId('user-create-password-input').fill('aPassphraseThatFits')
  await page.getByTestId('user-create-submit-button').click()

  // The new row appears (the list refetches after the create action resolves).
  const row = page.getByTestId(`user-row-${username}`)
  await expect(row).toBeVisible({ timeout: 30_000 })

  // ── DELETE via the row's Confirm → dispatches runAction('user.delete', …) on confirm ──
  const deleteBtn = row.getByTestId(new RegExp(`^user-delete-button-`))
  await deleteBtn.click()
  // The kit Confirm's OK button is the Confirm testid + '-confirm'.
  await page.locator('[data-testid^="user-delete-confirm-"][data-testid$="-confirm"]').click()

  await expect(page.getByTestId(`user-row-${username}`)).toHaveCount(0, { timeout: 30_000 })
})
