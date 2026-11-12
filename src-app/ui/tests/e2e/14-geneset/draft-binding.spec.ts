import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerApiToken } from '../_owner'

// gene-set increment 1 — the REAL-UI draftable-binding proof (TEST-22, ITEM-8). Unlike the
// API-only curate-freeze spec, this drives the ACTUAL editor through the browser so the load-
// bearing FE binding (draftActions launch → resolveDraftBinding seed → debounced persist →
// reload restore) is exercised end-to-end:
//   • the "Gene sets" section's New-collection button LAUNCHES the geneset.curate editor bound to
//     a freshly-created draft (the reworked deterministic launch, not the old most-recent guess);
//   • typing a collection name debounce-PERSISTs to the draft (`data.name` shows up on /api/drafts);
//   • a full page RELOAD re-opens the editor with the EDITED name (seed-from-draft.data), not the
//     field default — the resolveDraftBinding reload-resume path.
//
// The "Gene sets" section + the editor availability key on a `geneset/collection` artifact
// existing in the project (its `applies_to`), so the spec first FREEZES one via the real producer
// (needs `TXR_ENV_ROOTFS_SQUASHFS` staged — the box's single-cell schema5 squashfs). Without the
// rootfs the seed freeze cannot complete and the spec fails LOUD at the seed step (never hollow).

const KIND = 'geneset/collection'
const FREEZE_TIMEOUT_MS = 180_000
const NAME_INPUT = 'widget-collectionName-input'

type Draft = { id: string; status: string; data?: { name?: string }; frozen_artifact_id?: string }

async function pollFrozen(request: APIRequestContext, auth: Record<string, string>, id: string): Promise<Draft> {
  const deadline = Date.now() + FREEZE_TIMEOUT_MS
  let last: Draft | undefined
  while (Date.now() < deadline) {
    const resp = await request.get(`${BACKEND}/api/drafts/${id}`, { headers: auth })
    expect(resp.status(), await resp.text()).toBe(200)
    last = (await resp.json()) as Draft
    if (last.status === 'frozen' && last.frozen_artifact_id) return last
    await new Promise(r => setTimeout(r, 2_000))
  }
  throw new Error(`seed draft ${id} did not freeze within ${FREEZE_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`)
}

/** Poll the project's OPEN drafts for one whose `data.name` matches — proves the debounced PUT. */
async function pollOpenDraftNamed(
  request: APIRequestContext,
  auth: Record<string, string>,
  projectId: string,
  name: string,
): Promise<boolean> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const resp = await request.get(`${BACKEND}/api/drafts?project_id=${projectId}`, { headers: auth })
    if (resp.status() === 200) {
      const drafts = ((await resp.json()).drafts ?? []) as Draft[]
      if (drafts.some(d => d.status === 'open' && d.data?.name === name)) return true
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

test('New collection → edit → reload restores the edited draft (TEST-22, ITEM-8)', async ({ page, request }) => {
  test.setTimeout(FREEZE_TIMEOUT_MS + 120_000)
  const token = await ownerApiToken(request)
  const auth = { Authorization: `Bearer ${token}` }

  // A project + a SEED frozen geneset/collection so the "Gene sets" surface is available.
  const projectId = (
    await (
      await request.post(`${BACKEND}/api/projects`, { headers: auth, data: { name: `Geneset bind ${Date.now()}`, description: '' } })
    ).json()
  ).id as string
  const seedDraftId = (
    await (
      await request.post(`${BACKEND}/api/drafts`, {
        headers: auth,
        data: { kind: KIND, project_id: projectId, data: { name: 'Seed', default_kind: 'celltype-markers', sets: [{ name: 'S', kind: 'celltype-markers', genes: ['A', 'B'], origin: 'manual' }] } },
      })
    ).json()
  ).id as string
  expect((await request.post(`${BACKEND}/api/drafts/${seedDraftId}/freeze`, { headers: auth })).status()).toBe(202)
  await pollFrozen(request, auth, seedDraftId)

  // Open the workspace; the Gene sets section auto-mounts on the geneset/collection availability.
  await loginAsOwner(page)
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

  // The New-collection affordance renders (fixes the dead-UI entry point).
  const newBtn = page.getByRole('button', { name: /new collection/i }).first()
  await newBtn.waitFor({ state: 'visible', timeout: 20_000 })
  await newBtn.click()

  // The editor pane opens bound to the freshly-created draft — its name field is EMPTY (defaults).
  const nameInput = page.getByTestId(NAME_INPUT).first()
  await nameInput.waitFor({ state: 'visible', timeout: 15_000 })
  await expect(nameInput).toHaveValue('')

  // Edit the collection name → the debounced persist PUTs the draft.
  const uniqueName = `Reload Test ${Date.now()}`
  await nameInput.fill(uniqueName)
  await nameInput.blur()
  expect(
    await pollOpenDraftNamed(request, auth, projectId, uniqueName),
    'the edited name debounce-persisted to an open draft',
  ).toBe(true)

  // RELOAD — the editor re-opens and resolveDraftBinding resumes the user's open draft, seeding
  // $state from draft.data. The name field shows the EDITED value, not the default.
  await page.reload()
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  const restored = page.getByTestId(NAME_INPUT).first()
  await restored.waitFor({ state: 'visible', timeout: 20_000 })
  await expect(restored).toHaveValue(uniqueName)
})

// round-2 HIGH regression — a SECOND New-collection must open a FRESH editor, never rebind the
// previously-open draft. The prior bug checked the never-cleared bound instance BEFORE the launch
// intent, so a second launch resumed the stale draft (showing the OLD collection) and orphaned the
// new one. This spec: open the editor, name + FREEZE the first draft, then press New collection
// AGAIN and assert the editor is empty (bound to a brand-new draft, not the frozen first one).
test('a SECOND New collection opens a FRESH editor after freezing the first (round-2 HIGH)', async ({ page, request }) => {
  test.setTimeout(FREEZE_TIMEOUT_MS + 120_000)
  const token = await ownerApiToken(request)
  const auth = { Authorization: `Bearer ${token}` }

  // Project + a seed frozen collection so the surface + editor availability exist.
  const projectId = (
    await (
      await request.post(`${BACKEND}/api/projects`, { headers: auth, data: { name: `Geneset second-use ${Date.now()}`, description: '' } })
    ).json()
  ).id as string
  const seedDraftId = (
    await (
      await request.post(`${BACKEND}/api/drafts`, {
        headers: auth,
        data: { kind: KIND, project_id: projectId, data: { name: 'Seed', default_kind: 'celltype-markers', sets: [{ name: 'S', kind: 'celltype-markers', values: ['A', 'B'], origin: 'manual' }] } },
      })
    ).json()
  ).id as string
  expect((await request.post(`${BACKEND}/api/drafts/${seedDraftId}/freeze`, { headers: auth })).status()).toBe(202)
  await pollFrozen(request, auth, seedDraftId)

  await loginAsOwner(page)
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

  const newBtn = page.getByRole('button', { name: /new collection/i }).first()
  await newBtn.waitFor({ state: 'visible', timeout: 20_000 })
  await newBtn.click()

  // First editor: name it, then FREEZE it (so the first draft is no longer an open draft).
  const nameInput = page.getByTestId(NAME_INPUT).first()
  await nameInput.waitFor({ state: 'visible', timeout: 15_000 })
  const firstName = `First ${Date.now()}`
  await nameInput.fill(firstName)
  await nameInput.blur()
  const firstId = await pollDraftIdNamed(request, auth, projectId, firstName)
  expect(firstId, 'the first collection persisted as an open draft').not.toBeNull()
  await page.getByRole('button', { name: /freeze/i }).first().click()
  await pollFrozen(request, auth, firstId as string)

  // Press New collection AGAIN — the editor must re-open bound to a NEW draft: its name field is
  // EMPTY, never the frozen first collection's name (the round-2 bug would show `firstName`).
  await newBtn.click()
  const secondInput = page.getByTestId(NAME_INPUT).first()
  await secondInput.waitFor({ state: 'visible', timeout: 15_000 })
  await expect(secondInput).toHaveValue('')
  await expect(secondInput).not.toHaveValue(firstName)
})

/** Poll the project's OPEN drafts for one whose `data.name` matches → its id (or null). */
async function pollDraftIdNamed(
  request: APIRequestContext,
  auth: Record<string, string>,
  projectId: string,
  name: string,
): Promise<string | null> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const resp = await request.get(`${BACKEND}/api/drafts?project_id=${projectId}`, { headers: auth })
    if (resp.status() === 200) {
      const drafts = ((await resp.json()).drafts ?? []) as Draft[]
      const hit = drafts.find(d => d.status === 'open' && d.data?.name === name)
      if (hit) return hit.id
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}
