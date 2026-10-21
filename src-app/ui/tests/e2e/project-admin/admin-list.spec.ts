import { expect, test } from '@playwright/test'
import { gotoProjectAdmin, loginAsOwner, ownerToken, seedProjectOwnedBy } from './_helpers'

// TEST-12 / ITEM-8,10,21: the admin opens /settings/projects and sees every
// project across every user — the aggregate stats header, per-row owner identity
// (name + email), the size + last-activity columns, name search, and the
// folded-in deployment ownership-transfer card.
test('admin sees the cross-user project list with owner identity, columns, search + settings card', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const a = await seedProjectOwnedBy(request, admin, `listalice${ts}`, `Alice atlas ${ts}`)
  const b = await seedProjectOwnedBy(request, admin, `listbob${ts}`, `Bob cohort ${ts}`)

  await loginAsOwner(page)
  await gotoProjectAdmin(page)

  // Aggregate stats header.
  await expect(page.getByTestId('project-admin-stats')).toBeVisible()

  // Both rows render with their (different) owners' name + email.
  await expect(page.getByTestId(`project-admin-row-${a.projectId}`)).toBeVisible()
  await expect(page.getByTestId(`project-admin-owner-${a.projectId}`)).toContainText(a.owner.username)
  await expect(page.getByTestId(`project-admin-owner-${a.projectId}`)).toContainText(
    `${a.owner.username}@cyto.test`,
  )
  await expect(page.getByTestId(`project-admin-row-${b.projectId}`)).toBeVisible()
  await expect(page.getByTestId(`project-admin-owner-${b.projectId}`)).toContainText(b.owner.username)

  // The dataset-count + last-activity columns (visible at the 1280px md viewport).
  // There is deliberately NO `project-admin-size-*` column any more: it rendered a pair
  // of size-proxy counts the server had pinned to 0, so it showed `0 / 0` for every
  // project while asserting a domain-specific data model. Those two fields have since
  // been retired from the wire entirely (DEC-M / W7). Asserting the column's ABSENCE
  // keeps it from being reinstated.
  await expect(page.getByTestId(`project-admin-datasets-${a.projectId}`)).toBeVisible()
  await expect(page.getByTestId(`project-admin-size-${a.projectId}`)).toHaveCount(0)
  await expect(page.getByTestId(`project-admin-activity-${a.projectId}`)).toBeVisible()

  // Search filters to a single project by name (server-side ILIKE, debounced).
  await page.getByTestId('project-admin-search').fill(a.projectName)
  await expect(page.getByTestId(`project-admin-row-${a.projectId}`)).toBeVisible()
  await expect(page.getByTestId(`project-admin-row-${b.projectId}`)).toHaveCount(0)

  // The folded-in deployment transfer-toggle card is present.
  await expect(page.getByTestId('project-settings-card')).toBeVisible()
})
