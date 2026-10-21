import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  createRestrictedUser,
  loginAsOwner,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'
import { BACKEND } from '../_owner'

// gene-set increment 1 — the RESTRICTED-USER e2e (TEST-19/A10, [negative-perm][positive-control]).
// The gene-sets surface (the `geneset.curate` draftable editor + the "Gene sets" section) is gated
// on `drafts::use` (DEC-8 — gene-set reuses the draftable primitive's gate). This spec fixes the
// phase-6 finding that the negative check ran on `/projects` (where New-collection renders for NO
// one, so it proved nothing) with NO positive control that the affordance exists when permitted:
//   • POSITIVE CONTROL (the missing half): a PERMITTED user (the owner, holding `drafts::use`)
//     opens the WORKBENCH of a project that HAS a geneset/collection and SEES the "Gene sets"
//     section + its New-collection affordance — so the negative below is a real gate, not a
//     surface that never renders.
//   • NEGATIVE: a user LACKING the permission is refused by every `/api/drafts` route (the
//     authoritative backend gate, A9), while a NON-drafts endpoint (`/auth/me`) answers 200 (the
//     account is valid — the denial is the permission, not a broken login).
//
// The section + editor availability key on a `geneset/collection` artifact, so the positive
// control first FREEZES one via the real producer (needs `CYTO_ENV_ROOTFS_SQUASHFS` staged).

const KIND = 'geneset/collection'
const FREEZE_TIMEOUT_MS = 180_000

async function seedFrozenCollection(request: APIRequestContext, auth: Record<string, string>, projectId: string): Promise<void> {
  const draftId = (
    await (
      await request.post(`${BACKEND}/api/drafts`, {
        headers: auth,
        data: { kind: KIND, project_id: projectId, data: { name: 'Seed', default_kind: 'celltype-markers', sets: [{ name: 'S', kind: 'celltype-markers', genes: ['A', 'B'], origin: 'manual' }] } },
      })
    ).json()
  ).id as string
  expect((await request.post(`${BACKEND}/api/drafts/${draftId}/freeze`, { headers: auth })).status()).toBe(202)
  const deadline = Date.now() + FREEZE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const d = await (await request.get(`${BACKEND}/api/drafts/${draftId}`, { headers: auth })).json()
    if (d.status === 'frozen' && d.frozen_artifact_id) return
    await new Promise(r => setTimeout(r, 2_000))
  }
  throw new Error('seed collection did not freeze — is CYTO_ENV_ROOTFS_SQUASHFS staged?')
}

test('drafts::use gates the gene-sets affordance: PRESENT for a permitted user on the workbench, DENIED for one without it (TEST-19/A10)', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(FREEZE_TIMEOUT_MS + 120_000)
  const admin = await ownerToken(request)
  const auth = { authorization: `Bearer ${admin}` }

  // A project with a frozen collection so the "Gene sets" surface is available.
  const project = await (
    await request.post(`${BACKEND}/api/projects`, { headers: auth, data: { name: `Geneset A10 ${Date.now()}`, description: '' } })
  ).json()
  await seedFrozenCollection(request, auth, project.id)

  // ── POSITIVE CONTROL — the owner HOLDS drafts::use: the workbench loads and the New-collection
  //    affordance renders (the affordance the negative asserts is absent DOES exist when permitted).
  await loginAsOwner(page)
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  await expect(page.getByRole('button', { name: /new collection/i }).first()).toBeVisible({ timeout: 20_000 })

  // ── NEGATIVE — a user LACKING the permission (Users group stripped).
  const uname = `genesetrestrict${Date.now()}`
  await createRestrictedUser(request, admin, uname)
  const login = await request.post(`${BACKEND}/api/auth/login`, { data: { username: uname, password: MEMBER_PASSWORD } })
  const body = await login.json()
  const token: string = body.access_token ?? body.token
  const uauth = { authorization: `Bearer ${token}` }

  // POSITIVE CONTROL — the account is valid + the API reachable for THIS user.
  expect((await request.get(`${BACKEND}/api/auth/me`, { headers: uauth })).status()).toBe(200)

  // The authoritative gate: every `/api/drafts` route the geneset editor drives 403s.
  expect((await request.get(`${BACKEND}/api/drafts?project_id=${project.id}`, { headers: uauth })).status()).toBe(403)
  expect(
    (
      await request.post(`${BACKEND}/api/drafts`, {
        headers: uauth,
        data: { kind: KIND, project_id: project.id, data: { name: 'x', sets: [] } },
      })
    ).status(),
  ).toBe(403)

  // UI negative: the restricted user cannot reach the owner's workbench, and no New-collection
  // affordance renders for them anywhere (the section is `permission: drafts::use`-gated).
  const ctx = await browser.newContext()
  const rpage = await ctx.newPage()
  await loginViaUi(rpage, uname, MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(rpage)
  await rpage.goto(`/projects/${project.id}/workspace`)
  await rpage.waitForLoadState('networkidle')
  await expect(rpage.getByRole('button', { name: /new collection/i })).toHaveCount(0)
  await ctx.close()
})
