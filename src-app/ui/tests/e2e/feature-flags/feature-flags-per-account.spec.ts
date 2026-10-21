import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsOwner, ownerToken } from './helpers'

const FLAG = 'demo.runtime_flag'

/** Create an organization account (returns its id + the name to pick in the UI). */
async function createOrg(request: APIRequestContext, token: string, name: string) {
  const r = await request.post('/api/accounts', {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  })
  expect(r.ok(), `create org ${name}`).toBeTruthy()
  return { id: (await r.json()).id as string, name }
}

// TEST-9 [acceptance] [invariant: INV-1] (#53): an admin overrides a flag for one
// account, then CLEARS the override and the account reverts to inheriting the default —
// the whole point of #53. Driven end-to-end through the per-account UI, which dispatches
// the real `features.setAccountFlag` / `features.clearAccountOverride` actions against the
// regenerated `Features.set` / `Features.clear` endpoints. Deliberately overrides against
// the COMPILED DEFAULT (demo.runtime_flag ships OFF) and never touches the GLOBAL row, so
// this spec pollutes no shared state for the sibling global-toggle specs.
test('override a flag for an account, then Clear override reverts it to inherit', async ({
  page,
  request,
}) => {
  await loginAsOwner(page)
  const admin = await ownerToken(page)
  const org = await createOrg(request, admin, `PerAcct Org ${Date.now()}`)

  await page.goto('/settings/feature-flags')
  await expect(page.getByTestId('feature-flags-account-card')).toBeVisible({ timeout: 15_000 })

  // Pick the org in the per-account picker.
  await page.getByTestId('feature-flags-account-picker').click()
  await page.getByRole('option', { name: org.name }).click()

  const row = page.getByTestId(`feature-flag-account-row-${FLAG}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  const badge = page.getByTestId(`feature-flag-account-badge-${FLAG}`)
  const effective = page.getByTestId(`feature-flag-account-effective-${FLAG}`)
  const clearBtn = page.getByTestId(`feature-flag-clear-${FLAG}`)

  // Initially INHERITED: badge "Inherited", effective Off (the compiled default), and the
  // Clear-override control is disabled (nothing to clear).
  await expect(badge).toHaveText('Inherited')
  await expect(effective).toHaveText('Off')
  await expect(clearBtn).toBeDisabled()

  // OVERRIDE this account ON (opposite the compiled default) through the per-account Switch.
  await page.getByTestId(`feature-flag-account-switch-${FLAG}`).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^Enable$/i }).click()
  await expect(badge).toHaveText('Overridden')
  await expect(effective).toHaveText('On')
  await expect(clearBtn).toBeEnabled()

  // CLEAR the override → the account reverts to inheriting the default (Off) — INV-1.
  await clearBtn.click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^Clear override$/i }).click()
  await expect(badge).toHaveText('Inherited')
  await expect(effective).toHaveText('Off')
  await expect(clearBtn).toBeDisabled()
})
