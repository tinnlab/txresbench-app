import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { openArtifactsPane, openWorkspace } from './_artifacts'

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'

// TEST-21 — the Artifacts project-extension panel renders the project catalog
// (control-plane) end-to-end through the REAL backend + built SPA. A brand-new project
// has no artifacts yet (they're produced by an analysis run, P3), so the empty state is
// the expected first render — proving the panel mounts, the JSON control-plane call
// succeeds (authed), and the surface renders.
//
// ── REWRITTEN: this spec drove a URL that no longer reaches the surface ──────────────
// It went to `/projects/<id>/artifacts` and expected `project-artifacts-card`. Commit
// a7c75ef1 turned the project detail page into the full-bleed workbench; the workstore
// extension dropped its `project_nav` entry, so `artifacts` is no longer a section and
// `ProjectDetailPage` redirects that URL to `workspace`. Artifacts is now a workbench
// PANE, opened from the region "+" menu (`region-add-pane-item-artifacts`).
//
// The redirect is asserted here explicitly (rather than silently worked around) because
// it is the exact fact that made the sibling `restricted-user.spec.ts` pass vacuously:
// at that URL NOBODY sees `project-artifacts-card`, permitted or not.

test('the retired /artifacts section URL redirects to the workbench — TEST-21a', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `WS redirect ${Date.now()}`, description: '' },
    })
  ).json()

  await loginAsOwner(page)
  await page.goto(`/projects/${project.id}/artifacts`)

  // A fully-permitted OWNER lands on `workspace`, not on an artifacts section…
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/workspace$`), {
    timeout: 30_000,
  })
  // …and sees NO artifacts card at that URL. This assertion is a statement about ROUTING,
  // not about permissions — which is precisely why it must never be reused as a
  // permission assertion (see restricted-user.spec.ts).
  await expect(page.getByTestId('project-artifacts-card')).toHaveCount(0)
  // Positive control: the workbench itself DID render, so the count-0 above is not the
  // "page failed to load" reading.
  await expect(page.getByTestId('workbench-shell')).toBeVisible()
})

test('artifacts pane renders a project catalog (empty state) — TEST-21', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const name = `WS artifacts ${Date.now()}`
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name, description: '' },
    })
  ).json()

  await loginAsOwner(page)
  await openWorkspace(page, project.id)
  await openArtifactsPane(page)

  // The workstore panel mounts inside the pane…
  await expect(page.getByTestId('project-artifacts-card')).toBeVisible()
  // …and the JSON control-plane call SUCCEEDED. `project-artifacts-empty` alone does not
  // prove that: `ArtifactsPanel`'s catch sets `artifacts = []` AND an error, so a 403/500
  // renders the SAME empty state. The error-absence assertion is what makes the empty
  // state mean "the catalog is empty" rather than "the fetch failed".
  await expect(page.getByTestId('project-artifacts-error')).toHaveCount(0)
  await expect(page.getByTestId('project-artifacts-empty')).toBeVisible()
  // And the panel is NOT stuck in its loading branch (a third way the card can be visible
  // while nothing was fetched).
  await expect(page.getByTestId('project-artifacts-loading')).toHaveCount(0)
})

// NOTE (S5b): the former TEST-20 exercised the SHIPPED `window.__workstore`
// little-endian `decodeSparseColumn` wire decoder. That bespoke typed-binary CSC
// wire (`POST /slice` + `encode_sparse_column`) is RETIRED — every Tier-2 read is
// now Arrow-IPC decoded by the single `apache-arrow` decoder (`arrowClient.ts`),
// covered by `src/core/workstore/arrowClient.test.ts` (a real Arrow IPC round-trip).
