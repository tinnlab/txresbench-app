import { expect, test } from '@playwright/test'

import { BACKEND, ownerApiToken } from '../_owner'

// draftable-entity — RUNNABLE e2e surface. Drives the `/api/drafts` REST surface
// through the real backend via Playwright's request context (no UI fixture needed):
// create → get → list(kind filter) → update → freeze-without-producer(422) → delete,
// plus the unauthenticated 401 gate. This is the CRUD + auth + freeze-refusal surface
// the draftable primitive exposes.
//
// The `$state`↔draft VIEW binding (ITEM-10) + the client `Drafts` store (ITEM-11) are
// DESCOPED-to-activation (DECISIONS.md DEC-9): the draft-instance-resolution policy
// (which draft a view edits, one-per-(project,kind)) is a consumer/domain concern that
// ships with the first consumer increment, not core. The core binding SEAM
// (createViewStore's `draftable` param + the `$state` seed/persist) remains inert +
// unit-tested in `store.test.ts`; only its wiring to a real draftable view is deferred.

test('drafts REST surface: create → get → list → update → freeze-422 → delete', async ({
  request,
}) => {
  const token = await ownerApiToken(request)
  const auth = { Authorization: `Bearer ${token}` }

  // A project to scope the draft to.
  const projResp = await request.post(`${BACKEND}/api/projects`, {
    headers: auth,
    data: { name: `Drafts E2E ${Date.now()}`, description: '' },
  })
  expect(projResp.status(), await projResp.text()).toBe(201)
  const projectId = (await projResp.json()).id as string

  // CREATE — an opaque kind + arbitrary data.
  const createResp = await request.post(`${BACKEND}/api/drafts`, {
    headers: auth,
    data: { kind: 'test/widget', project_id: projectId, data: { n: 1, note: 'hi' } },
  })
  expect(createResp.status(), await createResp.text()).toBe(201)
  const draft = await createResp.json()
  const id = draft.id as string
  expect(draft.kind).toBe('test/widget')
  expect(draft.status).toBe('open')
  expect(draft.frozen_artifact_id).toBeFalsy()

  // GET — round-trips the opaque data.
  const getResp = await request.get(`${BACKEND}/api/drafts/${id}`, { headers: auth })
  expect(getResp.status()).toBe(200)
  expect((await getResp.json()).data).toEqual({ n: 1, note: 'hi' })

  // LIST filtered by opaque kind.
  const listResp = await request.get(
    `${BACKEND}/api/drafts?project_id=${projectId}&kind=test/widget`,
    { headers: auth },
  )
  expect(listResp.status()).toBe(200)
  const listed = (await listResp.json()).drafts as Array<{ id: string }>
  expect(listed.some(d => d.id === id)).toBeTruthy()

  // UPDATE — replaces the opaque blob.
  const putResp = await request.put(`${BACKEND}/api/drafts/${id}`, {
    headers: auth,
    data: { data: { n: 42 } },
  })
  expect(putResp.status()).toBe(200)
  expect((await putResp.json()).data).toEqual({ n: 42 })

  // FREEZE — with no fixture producer declared for this kind, the transition refuses
  // cleanly + SYNCHRONOUSLY with 422 (never a silent no-op). A fixture-producer
  // environment ACCEPTS the freeze with 202 (it runs in the background, DEC-2/finding-11)
  // and the draft flips to `frozen` asynchronously; here we assert the deterministic
  // no-producer refusal.
  const freezeResp = await request.post(`${BACKEND}/api/drafts/${id}/freeze`, {
    headers: auth,
  })
  if (freezeResp.status() === 202) {
    // Accepted: background freeze — the returned row is still the open draft.
    expect((await freezeResp.json()).id).toBe(id)
  } else {
    expect(freezeResp.status()).toBe(422)
    expect((await freezeResp.json()).error_code).toMatch(
      /DRAFT_NOT_FREEZABLE|DRAFT_FREEZE_PRODUCER_MISSING/,
    )
  }

  // DELETE → 204, then GET → 404.
  const delResp = await request.delete(`${BACKEND}/api/drafts/${id}`, { headers: auth })
  expect(delResp.status()).toBe(204)
  const goneResp = await request.get(`${BACKEND}/api/drafts/${id}`, { headers: auth })
  expect(goneResp.status()).toBe(404)
})

test('drafts endpoints require auth (401 unauthenticated)', async ({ request }) => {
  const unauth = await request.get(`${BACKEND}/api/drafts?project_id=${crypto.randomUUID()}`)
  expect(unauth.status()).toBe(401)
})
