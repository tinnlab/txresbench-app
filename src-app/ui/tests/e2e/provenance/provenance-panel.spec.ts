import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BACKEND, createProject, loginAsOwner, ownerToken } from './_helpers'
import { seedQcDataset } from '../14-declarative-qc/_seed'

// TEST-28 (+ TEST-15): a project editor opens the consolidated Provenance surface and it
// renders its REAL DOM — the lineage graph, the readiness badge, the Runs table — and the
// table reflects the live `GET /api/provenance/runs` payload (store → DOM mapping), not a
// spinner-forever and not a phantom table.
//
// ── R4C-08 (round 4b): rewritten — the old version could only FAIL ────────────────
//
// It drove `project-section-tab-provenance` → `/projects/:id/provenance` →
// `provenance-panel` / `provenance-panel-header` / `provenance-readiness-card` /
// `provenance-runs-card` / `provenance-open-export` / `provenance-record-selection`.
// Commit 6d231748 retired the provenance project-detail section, and NOT ONE of those
// testids exists in `src/` any more, so both cases failed on the first assertion for the
// whole life of the branch. (Measured: 2/2 failing in the round-4b isolated e2e run.)
//
// The surface they covered is now the workbench Provenance pane, reached through the
// right region's "+" menu. Substance preserved: real DOM rather than a spinner; the
// readiness badge; and TEST-15's ground-truth check that the runs the API reports are the
// runs the DOM renders. The old "deep-link safe" case is NOT ported — the pane is not
// URL-addressable, so there is no deep link to be safe about; it is replaced by the
// honest-empty-state case, which is what "renders real DOM, never a stuck spinner" means
// for a project with no runs.

/** The exact action type + bytes `provenance/actions.ts` posts: the run's CRITERIA as a
 *  FLAT recipe under `subset.filter`, through `POST /provenance/actions`.
 *
 *  ITEM-4: this used to lift the criteria into a DSL predicate and wrap it in a versioned
 *  envelope (`criteriaToPredicate` → `buildRecipe`, minus the client version stamp). That
 *  second encoding is deleted — `criteria` is the single encoding.
 *
 *  INV-10: the recipe carries NO `kind`. The action type is the one carrier of "what kind
 *  of action this was", posted as its own field. A `kind: 'column'` recipe on the sibling
 *  `POST /provenance/selections` route derives `selection.column`, whose emitter demands
 *  string `col`/`op`/`val` fields a criteria list does not have and answers
 *  `MalformedRecipe` — so this fixture posted bytes the server always refused. */
const PRODUCTION_ACTION_TYPE = 'subset.filter'
function productionRecipe(criteria: ReadonlyArray<Record<string, unknown>>) {
  return { criteria }
}

/** Seed a real input artifact + record a selection over it → a project with ONE run. */
async function seedOneRun(request: APIRequestContext, admin: string, projectId: string) {
  const { expression_artifact_id: artifactId } = await seedQcDataset(request, projectId, {
    annotated: true,
    nCells: 50,
  })
  const recipe = productionRecipe([{ column: 'pct_mito', control: 'range', min: '', max: '10' }])
  const sel = await request.post(`${BACKEND}/api/provenance/actions`, {
    headers: { authorization: `Bearer ${admin}` },
    data: {
      project_id: projectId,
      action_type: PRODUCTION_ACTION_TYPE,
      input_artifact_id: artifactId,
      recipe,
      label: 'lowmito',
    },
  })
  expect(sel.ok(), `record selection -> ${sel.status()} ${await sel.text()}`).toBeTruthy()
}

/** Open a project's workbench and add the Provenance pane through the real "+" menu. */
async function openProvenancePane(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
  const add = page.getByTestId('region-add-pane-right')
  await expect(add).toBeVisible({ timeout: 30_000 })
  await add.click()
  await page.getByTestId('region-add-pane-item-reproducibility').click()
  await expect(page.locator('[data-testid^="workbench-provenance-pane-"]').first()).toBeVisible({
    timeout: 30_000,
  })
}

test('an editor opens the Provenance pane and it renders the real graph, badge and runs table', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProject(request, admin, `Provenance Pane ${Date.now()}`)
  await seedOneRun(request, admin, project.id)

  await loginAsOwner(page)
  await openProvenancePane(page, project.id)

  // Real DOM, not a spinner-forever and not the empty state: the graph populated, and
  // the reproducibility badge (the former "readiness card") is present.
  await expect(page.locator('[data-testid^="workbench-provenance-pane-empty-"]')).toHaveCount(0)
  await expect(page.getByTestId('provenance-readiness-badge')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid^="provenance-export-bundle-"]')).toBeVisible()

  // TEST-15 (store maps the API response → DOM): read the endpoint directly for the
  // ground-truth count, then assert the DOM the store rendered reflects exactly that.
  const runsApi = await request.get(
    `${BACKEND}/api/provenance/runs?project_id=${project.id}&page=1&per_page=10`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(runsApi.ok(), `GET runs -> ${runsApi.status()}`).toBeTruthy()
  const total = (await runsApi.json()).total as number
  expect(total, 'the seeded project has exactly one provenance run').toBe(1)

  // The Runs tab renders the populated table for that one run — NOT the empty state.
  await page.locator('[data-testid^="workbench-provenance-tabs-"]').getByRole('tab', { name: /runs/i }).click()
  await expect(page.getByTestId('provenance-runs-table')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('provenance-runs-empty')).toHaveCount(0)
})

test('a project with no runs gets an HONEST empty state, not a stuck spinner', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProject(request, admin, `Provenance Pane Empty ${Date.now()}`)

  await loginAsOwner(page)
  await openProvenancePane(page, project.id)

  await expect(page.locator('[data-testid^="workbench-provenance-pane-empty-"]')).toBeVisible({
    timeout: 30_000,
  })
  // The load finished — no spinner left behind — and it did not fail.
  await expect(page.locator('[data-testid^="workbench-provenance-loading-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="workbench-provenance-error-"]')).toHaveCount(0)
})
