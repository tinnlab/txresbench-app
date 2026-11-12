import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, logout } from './helpers'

// TEST-13 [negative-perm][positive-control][acceptance INV-2]: a user WITHOUT
// workstore::settings::read must not see the Workstore settings nav entry AND cannot
// render /settings/workstore (route permission-gated → the 403 "Not authorized"
// panel). Frontend-hidden (A10) on top of the backend deny (integration TEST-8).
// The POSITIVE CONTROL — the same restricted user CAN load /settings/general — is
// what makes "absent" mean "gated", not "never rendered".

const RESTRICTED = {
  username: 'e2e-ws-restricted',
  email: 'ws-restricted@txresbench.test',
  password: 'restrictedP0!x',
}

test('a user without workstore permission sees no Workstore settings and is denied the route', async ({
  page,
}) => {
  // Admin creates a restricted (no-permission) user.
  const token = await loginAsOwner(page)
  await createRestrictedUser(page, token, RESTRICTED)

  // Become the restricted user.
  await logout(page)
  await loginAs(page, RESTRICTED.username, RESTRICTED.password)

  // POSITIVE CONTROL: the restricted user CAN load the settings area — so a hidden
  // Workstore surface below means "gated", not "the page never rendered".
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // The settings nav must NOT offer a "Workstore" entry (slot is perm-gated).
  await expect(page.getByRole('link', { name: 'Workstore' })).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the workstore page
  // never renders; the 403 panel does.
  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-settings-page')).toHaveCount(0)
  await expect(page.getByText('Not authorized')).toBeVisible()
})

// uncapped-uploads TEST-13 [negative-perm][positive-control]: a user who HOLDS
// `workstore::settings::read` but LACKS `workstore::settings::manage` gets the
// opposite treatment from the fully-restricted user above — the page LOADS (the
// positive control: "present but read-only" is meaningfully different from "absent")
// — and every limits-card field, including the two new upload-limit ones, is present
// but disabled, with no save affordance (the read-only alert stands in for it; the
// card's `SettingsFormActions` never offers a native-enabled Save in this state).
//
// This user is created directly (not via `createRestrictedUser`, which hardcodes
// `permissions: []`) so it can hold exactly one permission — mirrors the inline
// `POST /api/users` pattern already used elsewhere in the e2e suite (e.g.
// `tests/e2e/provenance/_helpers.ts`) for a non-empty custom permission set.
const READ_ONLY = {
  username: 'e2e-ws-readonly',
  email: 'ws-readonly@txresbench.test',
  password: 'readonlyP0!x',
}

test('a user with workstore read but not manage sees the settings page with every field present but disabled', async ({
  page,
}) => {
  // Admin creates a read-only (settings::read, no settings::manage) user.
  const token = await loginAsOwner(page)
  const res = await page.request.post('/api/users', {
    headers: { Authorization: `Bearer ${token}` },
    data: { ...READ_ONLY, permissions: ['workstore::settings::read'] },
  })
  expect(
    res.status() === 201 || res.status() === 200 || res.status() === 409,
    `create read-only user -> ${res.status()} ${await res.text()}`,
  ).toBeTruthy()

  // Become the read-only user.
  await logout(page)
  await loginAs(page, READ_ONLY.username, READ_ONLY.password)

  // POSITIVE CONTROL: unlike the fully-restricted user above, the page LOADS —
  // "disabled" and "absent" must read as different outcomes.
  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-settings-page')).toBeVisible()
  await expect(page.getByTestId('workstore-limits-card')).toBeVisible()
  await expect(page.getByTestId('workstore-limits-readonly-alert')).toBeVisible()

  // The two NEW upload-limit inputs are present, seeded from the server, and disabled —
  // exactly the same treatment as the pre-existing byte-cap fields.
  const uploadBody = page.getByTestId('workstore-max-upload-body')
  const uploadParts = page.getByTestId('workstore-max-upload-parts')
  await expect(uploadBody).toBeVisible()
  await expect(uploadParts).toBeVisible()
  // 64 GiB expressed in MiB -- this field is MiB-granular because the server's
  // floor for it is 1 MiB; see WorkstoreLimitsCard's uploadBodyMibForDisplay.
  await expect(uploadBody).toHaveValue('65536')
  await expect(uploadParts).toHaveValue('1024')
  await expect(uploadBody).toBeDisabled()
  await expect(uploadParts).toBeDisabled()

  // The pre-existing byte-cap fields get the same disabled treatment (the whole form
  // is disabled as one unit — `Form disabled={!canManage}` — not field-by-field).
  await expect(page.getByTestId('workstore-max-file')).toBeDisabled()
  await expect(page.getByTestId('workstore-max-total')).toBeDisabled()

  // No save affordance: the Save button is `aria-disabled` (unavailable), not a live
  // control — mirrors `SettingsFormActions`' `unavailableReason` mechanism.
  await expect(page.getByTestId('workstore-limits-save')).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})
