import { expect, test } from '@playwright/test'
import { createMember, loginMemberToProjects, MEMBER_PASSWORD, ownerToken } from './_helpers'

// A10 [negative-permission, CRITICAL]: a plain Users-group member holds
// `projects::use` but NOT `project::admin::*`, so the cross-user admin page is
// invisible + unreachable. This is the negative-permission proof for the whole
// /settings/projects surface — it MUST pass.
test('a member without project::admin::read cannot reach /settings/projects', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const member = `stadmemb${Date.now()}`
  await createMember(request, admin, member)

  // The member logs in and lands on /projects (they DO hold projects::use).
  await loginMemberToProjects(page, member, MEMBER_PASSWORD)

  // Deep-link the admin page. The settings layout renders, but the "projects"
  // section is a forbidden slot for this user → inline 403, never the table.
  await page.goto('/settings/projects')

  // (1) The 403 result renders in the content area…
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible()
  // …and the admin table is absent.
  await expect(page.getByTestId('project-admin-page')).toHaveCount(0)
  await expect(page.getByTestId('project-admin-list-card')).toHaveCount(0)

  // (2) The Settings admin nav offers NO "Projects" entry (slot is filtered out).
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()
  await expect(
    page.getByTestId('settings-nav-menu').getByText('Projects', { exact: true }),
  ).toHaveCount(0)
})
