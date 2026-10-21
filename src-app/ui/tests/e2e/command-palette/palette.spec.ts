import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import { gotoProjects, loginAs, loginAsOwner } from '../mcp/helpers'

// TEST-9 (`.lifecycle/ai-actions/TESTS.md`) — the command palette's
// human-facing surface (PLAN.md ITEM-1): ⌘/Ctrl-K opens/toggles the overlay,
// the query fuzzy-filters the permitted action list (`CommandPalette.tsx`'s
// `usePermittedActionGroups` feeding cmdk's built-in `shouldFilter`), and
// the list itself is PERMISSION-filtered (`hasPermissionNow` per
// `ActionMeta.permission`) — a plain non-admin user never sees the
// admin-only nav actions (`nav.users` / `nav.userGroups` / `nav.projectAdmin`,
// gated on `users::read` / `groups::read` / `project::admin::read` — none of
// which the default "Users" group holds; only Administrators via the `*`
// wildcard).

/** Scope every palette locator to the actual dialog popup. Distinguishes it
 *  from the separate `dangerous`-action `Confirm` (an alert-dialog, which
 *  uses `data-slot="alert-dialog-content"` — see
 *  `sdk/packages/kit/src/shadcn/{dialog,alert-dialog}.tsx`). */
function palette(page: Page) {
  return page.locator('[data-slot="dialog-content"]')
}

/**
 * Self-service register a fresh user. `POST /api/auth/register` lands the
 * new account ONLY in the default "Users" group
 * (`create_local_user_with_default_group`), so it holds exactly the base
 * Users-group permission set (`profile::{read,edit}` + the appended
 * `projects::use`/`jobs::use`/`mcp::use`/`provenance::{read,export}`/
 * `notifications::read` — see each module's `*_grants.sql` migration) and
 * NONE of the admin-only permissions (`users::read`, `groups::read`,
 * `project::admin::read`, `jobs::settings::read`, …), which exist only via the
 * Administrators group's `*` wildcard. Mirrors the register half of
 * `../mcp/helpers.ts::createRestrictedUser` (that helper additionally
 * removes the account from "Users" to strip `mcp::use` too — not needed
 * here, a plain register is already restricted enough for the
 * admin-nav-actions assertion below).
 */
async function registerPlainUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const res = await request.post('/api/auth/register', {
    data: { username, email: `${username}@cyto.test`, password, display_name: username },
  })
  expect(res.ok(), `register ${username} -> ${res.status()} ${await res.text()}`).toBeTruthy()
}

test.describe('command palette', () => {
  test('Ctrl/Cmd-K opens the palette, the query filters the action list, and Ctrl/Cmd-K again closes it', async ({
    page,
  }) => {
    await loginAsOwner(page)
    await gotoProjects(page)

    await expect(palette(page)).toHaveCount(0)

    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeVisible()

    // Unfiltered: the owner (Administrators -> `*`) sees actions spanning
    // more than one permission/category, including an admin-only nav action.
    await expect(page.getByTestId('command-palette-item-project.create')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-job.create')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-nav.users')).toBeVisible()

    // Typing a query fuzzy-filters (cmdk matches against `${title} ${id}`):
    // "project" matches every `project.*` action (via its id) but no `job.*`
    // action (no "project" substring in either its title or id).
    await page.getByTestId('command-palette-input').fill('project')
    await expect(page.getByTestId('command-palette-item-project.create')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-project.list')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-job.create')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-item-nav.users')).toHaveCount(0)

    // Ctrl/Cmd-K TOGGLES: pressed again while the palette owns focus (inside
    // its own `CommandInput`), it closes — the handler checks
    // `isCommandPaletteOpen()` before the editable-target guard
    // (`modules/command-palette/module.tsx`), so this isn't swallowed as
    // "typing into a field".
    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeHidden()
    await expect(palette(page)).toHaveCount(0)
  })

  test('a non-admin user does not see admin-only actions in the palette', async ({
    page,
    request,
  }) => {
    // First-run setup already happened in the previous test (this file's
    // webServer/DB is fresh-per-run, `workers: 1` / sequential) — a plain
    // self-service register is enough to get a non-admin account here.
    const username = `paletteuser${Date.now()}`
    const password = 'palettePassw0rd!'
    await registerPlainUser(request, username, password)
    await loginAs(page, username, password)

    await gotoProjects(page)
    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeVisible()

    // Admin-only nav actions are absent from the registry-derived,
    // permission-filtered list for this non-admin user.
    await expect(page.getByTestId('command-palette-item-nav.users')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-item-nav.userGroups')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-item-nav.projectAdmin')).toHaveCount(0)
    // Also absent: admin-only settings nav (jobs/sandbox/provenance/session
    // settings) — none of those `*SettingsRead` perms are granted to "Users".
    await expect(page.getByTestId('command-palette-item-nav.jobsSettings')).toHaveCount(0)

    // Positive control: an action this user's group DOES grant
    // (`projects::use`) still appears, proving the empty results above are a
    // permission filter, not an empty/broken registry.
    await expect(page.getByTestId('command-palette-item-project.list')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-job.create')).toBeVisible()
    await expect(palette(page).getByText('Projects', { exact: true })).toBeVisible()
  })
})
