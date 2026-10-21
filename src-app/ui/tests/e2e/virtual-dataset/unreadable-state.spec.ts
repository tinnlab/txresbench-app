import { expect, test } from '@playwright/test'
import { BACKEND, createProjectApi, ownerToken } from '../datasets/_helpers'
import { loginAsOwner } from '../project/_helpers'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import { openArtifactsPane, openWorkspace } from '../workstore/_artifacts'

// TEST-54 [ITEM-41 / INV-9] — an artifact that cannot be read SAYS SO, and NAMES what is
// missing.
//
// INV-9 is not "show an error". It is: invalidate loudly, *naming the missing or changed
// source*, and "never render short or empty". The likely accident is the empty one — a
// pane that renders nothing at all — which is why the assertions below are on the PRESENCE
// of the name and of the state, never on the absence of rows.
//
// The two server states are deliberately different claims and need opposite remedies:
//   `failed`        the BYTES are wrong          → delete it, or re-run its producer
//   `unresolvable`  the artifact is INTACT,      → restore the source; deleting destroys
//                   its SOURCE is gone              work that is perfectly good
// A surface that renders both as one red "failed" chip offers to delete good work, so the
// distinguishing assertions here are as load-bearing as the naming one.
//
// Drives the real backend: rows are seeded through `POST /api/projects/{id}/_debug/seed`,
// which now carries `status` (stage 2, ITEM-30) — before that every seeded artifact landed
// `ready` and this state had no end-to-end path at all. No `page.route()` mocking.

const MISSING_SOURCE = 'source-dataset-alpha'

async function seedProjectWithArtifacts(request: Parameters<typeof ownerToken>[0]) {
  const admin = await ownerToken(request)
  const project = await createProjectApi(request, admin, `Unreadable ${Date.now()}`)
  const seeded = await postSeedPlan(request, project.id, {
    artifacts: [
      // The subject.
      {
        output_id: 'gathered_unified_column',
        datatype: 'data/opaque',
        status: 'unresolvable',
        meta: { origin: 'seed', unresolved_source: MISSING_SOURCE },
        content: { encoding: 'json', value: {} },
      },
      // CONTROL 1 — a `failed` row, so "the surface distinguishes them" is a real
      // comparison on one screen rather than a claim about one row in isolation.
      {
        output_id: 'condemned_bytes',
        datatype: 'data/opaque',
        status: 'failed',
        meta: { origin: 'seed' },
        content: { encoding: 'json', value: {} },
      },
      // CONTROL 2 — a healthy row. This is the POSITIVE control for every absence
      // assertion below: without it, a pane that failed to render at all would satisfy
      // "no missing-source line on the ready row" and "no delete advice" vacuously.
      {
        output_id: 'healthy_column',
        datatype: 'data/opaque',
        meta: { origin: 'seed' },
        content: { encoding: 'json', value: {} },
      },
    ],
  })
  const id = (outputId: string) => {
    const hit = seeded.artifacts.find(a => a.output_id === outputId)
    expect(hit, `seeded artifact "${outputId}"`).toBeTruthy()
    return hit!.id
  }
  return {
    projectId: project.id,
    unresolvable: id('gathered_unified_column'),
    failed: id('condemned_bytes'),
    ready: id('healthy_column'),
  }
}

test('an unreadable artifact names its missing source, and is not confused with condemned bytes — TEST-54', async ({
  page,
  request,
}) => {
  const seed = await seedProjectWithArtifacts(request)

  await loginAsOwner(page)
  await openWorkspace(page, seed.projectId)
  await openArtifactsPane(page)

  // POSITIVE CONTROL FIRST. Every "the surface shows X" assertion below is worthless if
  // the pane never rendered, and every "does not show Y" one passes vacuously.
  await expect(page.getByTestId(`project-artifact-row-${seed.ready}`)).toBeVisible()
  await expect(page.getByTestId(`project-artifact-row-${seed.unresolvable}`)).toBeVisible()
  await expect(page.getByTestId(`project-artifact-row-${seed.failed}`)).toBeVisible()

  // 1 — INV-9's core: the missing source is NAMED, as visible text on the row. Not in a
  // `title` a pointer has to find and a touch device never will.
  const namedLine = page.getByTestId(`project-artifact-missing-source-${seed.unresolvable}`)
  await expect(namedLine).toBeVisible()
  await expect(namedLine).toContainText(MISSING_SOURCE)

  // 2 — it renders a STATE, not an empty row. The likely accident is silence.
  const unresolvableTag = page.getByTestId(`project-artifact-status-${seed.unresolvable}`)
  await expect(unresolvableTag).toBeVisible()
  await expect(unresolvableTag).toHaveAttribute('data-status', 'unresolvable')

  // 3 — the two unreadable states are TOLD APART on the same screen.
  const failedTag = page.getByTestId(`project-artifact-status-${seed.failed}`)
  await expect(failedTag).toHaveAttribute('data-status', 'failed')
  expect(
    (await unresolvableTag.textContent())?.trim(),
    'unresolvable must not read as "failed"',
  ).not.toBe((await failedTag.textContent())?.trim())

  // 4 — the remedy shown for an INTACT artifact must not be "delete it". This is the leg
  // that protects real work: `unresolvable` means nothing is wrong with this artifact.
  const remedy = (await unresolvableTag.getAttribute('title')) ?? ''
  expect(remedy, 'unresolvable needs a remedy at all').not.toBe('')
  expect(remedy).toMatch(/restore|re-attach/i)
  expect(remedy).not.toMatch(/\bdelete (it|this)\b/i)

  // 5 — the healthy row carries no missing-source line. Meaningful ONLY because of the
  // positive control at the top: the pane demonstrably rendered all three rows.
  await expect(
    page.getByTestId(`project-artifact-missing-source-${seed.ready}`),
  ).toHaveCount(0)
})

// The wire half. The listing above proves the CATALOG carries the state; this proves the
// BYTE route refuses with the machine-readable code the client branches on — the thing that
// makes "read the code, don't parse prose" possible at all. Asserted on the code, and on
// the ABSENCE of the other code, because a single shared 409 would satisfy a status-only
// assertion while telling the user the wrong remedy.
test('the byte route refuses an unreadable artifact with its own error code — TEST-54', async ({
  request,
}) => {
  const seed = await seedProjectWithArtifacts(request)
  const admin = await ownerToken(request)
  const auth = { authorization: `Bearer ${admin}` }

  // POSITIVE CONTROL: the healthy artifact serves. Without it a server that 409s on
  // everything — or refuses the whole project — would pass the two refusal legs.
  const ok = await request.get(artifactDataUrl(seed.ready), { headers: auth })
  expect(ok.status(), 'a ready artifact still serves its bytes').toBe(200)

  const gone = await request.get(artifactDataUrl(seed.unresolvable), { headers: auth })
  expect(gone.status()).toBe(409)
  const goneBody = await gone.text()
  expect(goneBody).toContain('ARTIFACT_UNRESOLVABLE')
  expect(goneBody).not.toContain('ARTIFACT_NOT_CONFORMING')
  // The server names the source in its message too — the same fact as the listing's, from
  // the same `meta.unresolved_source`, so the two surfaces cannot drift apart silently.
  expect(goneBody).toContain(MISSING_SOURCE)

  const condemned = await request.get(artifactDataUrl(seed.failed), { headers: auth })
  expect(condemned.status()).toBe(409)
  const condemnedBody = await condemned.text()
  expect(condemnedBody).toContain('ARTIFACT_NOT_CONFORMING')
  expect(condemnedBody).not.toContain('ARTIFACT_UNRESOLVABLE')
})

/** The byte route for one artifact. `BACKEND` is the per-run DERIVED origin (the config
 *  resolves and bind-verifies its own port); a literal here would be the fixed-port
 *  antipattern `playwright.config.ts` removed for colliding by construction. */
function artifactDataUrl(artifactId: string): string {
  return `${BACKEND}/api/artifacts/${artifactId}/data`
}
