import { expect, test } from '@playwright/test'
import { BACKEND, ownerApiToken } from '../_owner'

// gene-set increment 1 — the LOAD-BEARING curate → freeze flow (TEST-16, INV-1/3/4), driven
// through the REAL backend + the REAL freeze producer via Playwright's request context (no mocks).
// The `geneset/collection` draftable kind HAS a declared freeze producer (the geneset package), so
// freezing a draft ACCEPTS (202) and runs the producer in the analysis sandbox; the draft flips to
// `frozen` and points at the immutable `geneset/collection` artifact. We assert:
//   • freeze mints an immutable artifact carrying the per-set metadata (name/kind/origin/
//     data_driven) in `structure.sets` (INV-3/INV-4/GS-INV-12);
//   • editing the draft + re-freezing FORKS a NEW artifact with a different content-hash, and the
//     first artifact's bytes are unchanged (INV-1).
//
// GATED on the single-cell rootfs (DEC-7): the freeze producer runs `python`+`numpy` in the
// sandbox, so this spec needs `CYTO_ENV_ROOTFS_SQUASHFS` staged (the box's
// `.cyto-cache/env-rootfs/single-cell-schema5-<arch>.squashfs`). Without a mounted rootfs the
// freeze job cannot complete; the poll below fails loudly rather than passing hollow.

const KIND = 'geneset/collection'
const FREEZE_TIMEOUT_MS = 180_000

type Draft = { id: string; status: string; frozen_artifact_id?: string }

async function pollFrozen(
  request: import('@playwright/test').APIRequestContext,
  auth: Record<string, string>,
  id: string,
): Promise<Draft> {
  const deadline = Date.now() + FREEZE_TIMEOUT_MS
  let last: Draft | undefined
  while (Date.now() < deadline) {
    const resp = await request.get(`${BACKEND}/api/drafts/${id}`, { headers: auth })
    expect(resp.status(), await resp.text()).toBe(200)
    last = (await resp.json()) as Draft
    if (last.status === 'frozen' && last.frozen_artifact_id) return last
    await new Promise(r => setTimeout(r, 2_000))
  }
  throw new Error(`draft ${id} did not freeze within ${FREEZE_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`)
}

test('curate → freeze mints an immutable geneset/collection; re-edit forks a new version (TEST-16, INV-1/3/4)', async ({
  request,
}) => {
  test.setTimeout(FREEZE_TIMEOUT_MS + 60_000)
  const token = await ownerApiToken(request)
  const auth = { Authorization: `Bearer ${token}` }

  // A project to scope the collection draft to.
  const projResp = await request.post(`${BACKEND}/api/projects`, {
    headers: auth,
    data: { name: `Geneset E2E ${Date.now()}`, description: '' },
  })
  expect(projResp.status(), await projResp.text()).toBe(201)
  const projectId = (await projResp.json()).id as string

  // CREATE — a draftable geneset/collection with the editor's own `data` shape.
  const data1 = {
    name: 'PBMC cell-type markers',
    default_kind: 'celltype-markers',
    sets: [
      { name: 'T cells', kind: 'celltype-markers', genes: ['CD3D', 'CD3E', 'IL7R'], origin: 'manual' },
      { name: 'NK cells', kind: 'celltype-markers', genes: ['NKG7', 'GNLY'], origin: 'de:contrast-1', data_driven: true },
    ],
  }
  const createResp = await request.post(`${BACKEND}/api/drafts`, {
    headers: auth,
    data: { kind: KIND, project_id: projectId, data: data1 },
  })
  expect(createResp.status(), await createResp.text()).toBe(201)
  const draftId = (await createResp.json()).id as string

  // FREEZE — the producer is declared, so the transition is ACCEPTED (202) and runs async.
  const freezeResp = await request.post(`${BACKEND}/api/drafts/${draftId}/freeze`, { headers: auth })
  expect(freezeResp.status(), await freezeResp.text()).toBe(202)

  const frozen1 = await pollFrozen(request, auth, draftId)
  const artifactId1 = frozen1.frozen_artifact_id as string

  // The immutable artifact carries the per-set metadata (INV-3/INV-4/GS-INV-12).
  const artResp1 = await request.get(`${BACKEND}/api/artifacts/${artifactId1}`, { headers: auth })
  expect(artResp1.status(), await artResp1.text()).toBe(200)
  const art1 = await artResp1.json()
  expect(art1.datatype).toBe(KIND)
  const hash1 = art1.content_hash as string
  const sets1 = (art1.structure?.sets ?? []) as Array<Record<string, unknown>>
  expect(sets1.length).toBe(2)
  const tset = sets1.find(s => s.name === 'T cells')!
  expect(tset.kind).toBe('celltype-markers')
  expect(tset.origin).toBe('manual')
  const nkset = sets1.find(s => s.name === 'NK cells')!
  expect(nkset.data_driven).toBe(true) // INV-3 — a DE-derived set is flagged
  // INV-9/GS-INV-14 — the machine inference is NOT composed into the human description.
  expect(String(nkset.description ?? '')).not.toContain('data-driven')

  // EDIT the draft (add a gene to T cells) + RE-FREEZE → a NEW immutable artifact (INV-1 fork).
  const data2 = {
    ...data1,
    sets: [
      { ...data1.sets[0], genes: [...data1.sets[0].genes, 'CD8A'] },
      data1.sets[1],
    ],
  }
  const putResp = await request.put(`${BACKEND}/api/drafts/${draftId}`, {
    headers: auth,
    data: { data: data2 },
  })
  expect(putResp.status(), await putResp.text()).toBe(200)

  const freeze2 = await request.post(`${BACKEND}/api/drafts/${draftId}/freeze`, { headers: auth })
  expect(freeze2.status(), await freeze2.text()).toBe(202)
  const frozen2 = await pollFrozen(request, auth, draftId)
  const artifactId2 = frozen2.frozen_artifact_id as string
  expect(artifactId2).not.toBe(artifactId1) // forked, never mutated in place

  const art2 = await (await request.get(`${BACKEND}/api/artifacts/${artifactId2}`, { headers: auth })).json()
  expect(art2.content_hash).not.toBe(hash1) // different membership → different content-hash (INV-1)

  // The FIRST artifact's bytes are unchanged (retro-mutation impossible).
  const art1Again = await (await request.get(`${BACKEND}/api/artifacts/${artifactId1}`, { headers: auth })).json()
  expect(art1Again.content_hash).toBe(hash1)
})
