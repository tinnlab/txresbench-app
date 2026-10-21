import { expect, type Page } from '@playwright/test'
import { loginViaUi, waitForToken } from '../_owner'

// The owner identity + first-run setup come from `tests/e2e/_owner.ts` — the ONE
// owner for the whole directory (see that file for why a per-suite owner was a bug).

export { OWNER, loginAsOwner, logout } from '../_owner'

export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await loginViaUi(page, username, password)
  await waitForToken(page)
}

/** Create a restricted (no-permission) user via the admin REST API. */
export async function createRestrictedUser(
  page: Page,
  token: string,
  user: { username: string; email: string; password: string },
): Promise<void> {
  const res = await page.request.post('/api/users', {
    headers: { Authorization: `Bearer ${token}` },
    data: { ...user, permissions: [] },
  })
  expect(
    res.status() === 201 || res.status() === 200 || res.status() === 409,
    `create user -> ${res.status()} ${await res.text()}`,
  ).toBeTruthy()
}
