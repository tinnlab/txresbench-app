import { expect, test } from '@playwright/test'
import { createMember, loginAsOwner, loginMemberToProjects, MEMBER_PASSWORD, ownerToken } from '../project/_helpers'
import { createProject } from './_dock'

// TEST-416 + TEST-417 (ITEM-46) — the deep-linkable artifact-detail ROUTE.
// One renderer, three mounts: the route `/projects/:id/artifacts/:kind/:runId` renders
// the SAME `ArtifactReview` as the inline pane + pop-out window (host owns dispatch).
// The route is gated TWICE — the global `provenance::read` permission AND the
// per-project role (`Project.access`): a member lacking project access is DENIED the
// renderer (route guard over EXISTING perms, no new permission — A10).

const SYNTHETIC_RUN = '00000000-0000-4000-8000-0000000000aa'

test.describe('artifact-detail route — one renderer, three mounts + guard (ITEM-46)', () => {
  test('the owner reaches the deep-link route; browser back returns to the workspace', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Route ${Date.now()}`)

    // Land on the workspace first (so browser-back has somewhere to return to).
    await page.goto(`/projects/${id}/workspace`)
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

    // Navigate to the deep-link artifact route — the SAME renderer mounts here.
    await page.goto(`/projects/${id}/artifacts/run/${SYNTHETIC_RUN}`)
    await expect(page.getByTestId('artifact-detail-route')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('artifact-detail-back')).toBeVisible()

    // Browser back returns to the workspace.
    await page.goBack()
    await expect(page.getByTestId('workbench-shell')).toBeVisible({ timeout: 20_000 })
  })

  test('[negative-perm] a member without project access is denied the renderer', async ({
    page,
    request,
  }) => {
    // Owner creates a private project; a Users-group member (has provenance::read but
    // is NOT shared into the project) is created. All owner-side work is REST-driven
    // (`ownerToken` also ensures first-run setup) — the page is left UNAUTHENTICATED so
    // the member login form appears (a lingering owner session would swallow it).
    const admin = await ownerToken(request)
    const id = await createProject(request, `RouteGuard ${Date.now()}`)
    const member = `routeguard_${Date.now()}`
    await createMember(request, admin, member)

    // The member logs in and hits the deep-link route for a project they can't access.
    await loginMemberToProjects(page, member, MEMBER_PASSWORD)
    await page.goto(`/projects/${id}/artifacts/run/${SYNTHETIC_RUN}`)

    // Denied — the access-denied state renders, NOT the artifact renderer.
    await expect(page.getByTestId('artifact-detail-denied')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('artifact-detail-review')).toHaveCount(0)
    await expect(page.getByTestId('artifact-detail-route')).toHaveCount(0)
  })

  // ITEM-25 — the `result` → `artifact` rename MOVED this bookmarkable url. The legacy path is
  // still registered and redirects, so an existing bookmark / a link in someone's notes still
  // resolves instead of 404-ing.
  test('a pre-rename `/results/` bookmark redirects to the `/artifacts/` route', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `LegacyRoute ${Date.now()}`)

    await page.goto(`/projects/${id}/workspace`)
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

    // The LEGACY url — exactly what a saved bookmark holds.
    await page.goto(`/projects/${id}/results/run/${SYNTHETIC_RUN}`)

    // …lands on the CURRENT url, rendering the real page (not a 404 / blank).
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/artifacts/run/${SYNTHETIC_RUN}$`), {
      timeout: 20_000,
    })
    await expect(page.getByTestId('artifact-detail-route')).toBeVisible({ timeout: 20_000 })

    // The redirect used `replace`, so it left no history entry — Back goes to the workspace,
    // not into a redirect loop.
    await page.goBack()
    await expect(page.getByTestId('workbench-shell')).toBeVisible({ timeout: 20_000 })
  })
})
