import { type Page, expect, test } from '@playwright/test'
import { loginAsOwner } from './_helpers'

/** The left-sidebar recent-projects row for a project name (the widget renders one
 *  `Link` per project; the row's visible text is the project name). */
function sidebarRow(page: Page, name: string) {
  return page
    .getByTestId('recent-projects-widget')
    .locator('[data-testid^="recent-project-row-"]')
    .filter({ hasText: name })
}

/** Create a project through the /projects UI (the flow the owner reported). */
async function createViaUi(page: Page, name: string): Promise<void> {
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
}

// TEST-5: with two browser contexts for the SAME user, a project created in context
// A appears in context B's /projects list WITHOUT a reload (live sync-driven refetch
// over the /api/sync/subscribe SSE stream).
test('a project created in one tab appears live in another (sync)', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  await loginAsOwner(a) // creates/logs-in the owner + lands on /projects
  await loginAsOwner(b) // second tab, same user, on /projects (sync subscribed)
  await expect(b.getByTestId('projects-page')).toBeVisible()

  const name = `Sync ${Date.now()}`
  await createViaUi(a, name)
  await expect(a.getByTestId('project-card-title').filter({ hasText: name })).toBeVisible()

  // B must show it WITHOUT any reload — the sync frame drives its store refetch.
  await expect(b.getByTestId('project-card-title').filter({ hasText: name })).toBeVisible({
    timeout: 20_000,
  })
  // …and B's SIDEBAR too. `RecentProjects` is a DIFFERENT store from the `/projects`
  // feed and its ONLY refresh trigger is `sync:project`, so this is the positive
  // control for the asymmetry the next test pins: the remote device sees the new
  // project in BOTH surfaces because it receives the frame.
  await expect(sidebarRow(b, name)).toBeVisible({ timeout: 20_000 })

  await ctxA.close()
  await ctxB.close()
})

// THE OWNER'S REPORT: "creating a project does not make it appear in the left sidebar."
//
// The server publishes `Project`/`Create` to the owner but passes `origin`, so the
// fan-out deliberately SKIPS the connection that made the mutation (self-echo
// suppression). `Projects.createProject` reloads its OWN store inline, so the
// /projects grid updates — and the sidebar, backed by the separate `RecentProjects`
// store whose only triggers are `sync:project` / `sync:reconnect`, hears nothing.
// The acting tab was the single client in the whole system that never learned about
// its own new project. Together with the cross-device test above (which asserts the
// SAME sidebar row on a second device) this pins the asymmetry, not just the symptom.
//
// No reload anywhere in this test: `page.reload()` would mask the bug entirely.
test('a project created in THIS tab appears in the sidebar without a reload', async ({ page }) => {
  await loginAsOwner(page)
  await expect(page.getByTestId('projects-page')).toBeVisible()
  await expect(page.getByTestId('recent-projects-widget')).toBeVisible()

  const name = `Sidebar ${Date.now()}`
  // Negative control: the row cannot already be there.
  await expect(sidebarRow(page, name)).toHaveCount(0)

  await createViaUi(page, name)

  // The grid updates today (the acting store reloads itself)…
  await expect(page.getByTestId('project-card-title').filter({ hasText: name })).toBeVisible()
  // …and the SIDEBAR must too, from the same mutation, with no reload.
  await expect(sidebarRow(page, name)).toBeVisible({ timeout: 20_000 })
})

// The same hole on DELETE: the grid drops the card (acting store reloads) while the
// sidebar keeps a row pointing at a project that no longer exists.
test('a project deleted in THIS tab leaves the sidebar without a reload', async ({ page }) => {
  await loginAsOwner(page)
  const name = `SidebarDel ${Date.now()}`
  await createViaUi(page, name)
  await expect(sidebarRow(page, name)).toBeVisible({ timeout: 20_000 })

  await page
    .locator('[data-testid^="project-card-"]')
    .filter({ has: page.getByTestId('project-card-title').filter({ hasText: name }) })
    .first()
    .getByRole('button', { name: /project actions/i })
    .click()
  await page.getByRole('menuitem', { name: /^delete$/i }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^delete$/i })
    .click()

  await expect(page.getByTestId('project-card-title').filter({ hasText: name })).toHaveCount(0)
  await expect(sidebarRow(page, name)).toHaveCount(0, { timeout: 20_000 })
})
