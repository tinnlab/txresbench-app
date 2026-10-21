import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { loginAsOwner, loginViaUi, waitUntilOffLoginScreen } from '../project/_helpers'

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'
// Re-exported: the specs in this directory import it from here.
export { BACKEND }

export {
  loginAsOwner,
  loginViaUi,
  createMember,
  createRestrictedUser,
  loginMemberToProjects,
  // The project Datasets panel is a workbench PANE behind a region tab since
  // `a7c75ef1` — `/projects/:id/datasets` redirects to `/workspace` and an inactive
  // tab's body is never mounted. Every `project-datasets-*` assertion has to come
  // through this helper; re-exported here so datasets specs use the ONE migration
  // path the project specs already use rather than re-deriving it.
  openDatasetsPane,
  ownerToken,
  waitUntilOffLoginScreen,
  MEMBER_PASSWORD,
  OWNER,
} from '../project/_helpers'

/** Navigate to /datasets and wait for the library page to render. */
export async function gotoDatasets(page: Page): Promise<void> {
  await page.goto('/datasets')
  await page.getByTestId('datasets-page').waitFor({ state: 'visible', timeout: 20_000 })
}

/** Ensure the owner admin exists (first-run setup) and land on /datasets. */
export async function loginOwnerToDatasets(page: Page): Promise<void> {
  await loginAsOwner(page)
  await gotoDatasets(page)
}

/** Log in a Users-group member and land on /datasets (they hold `projects::use`). */
export async function loginMemberToDatasets(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await loginViaUi(page, username, password)
  await waitUntilOffLoginScreen(page)
  await gotoDatasets(page)
}

/**
 * The library table row for `name`, found by first FILTERING the library to it.
 *
 * ── Why filtering, not just `getByRole('row').filter(...)` ───────────────────────
 * The table shows ONE page of 20, newest first, and the owner is shared by the whole
 * directory (`tests/e2e/_owner.ts`). `library.spec.ts` seeds **25 datasets in a
 * single `Promise.all` burst** to force its pagination assertion — so any spec that
 * uploads a dataset and then looks for its row on page 1 loses that row whenever the
 * other worker happens to be in that burst. Measured at `--workers=2`: the row for a
 * dataset the server had already created (and converted) was simply not on page 1,
 * and the spec failed with "element(s) not found".
 *
 * `datasets-search` filters SERVER-side (the store passes `search` to the list
 * endpoint), so scoping to the unique name makes the lookup independent of how many
 * rows any other spec created. Nothing is weakened: it is still the real table row,
 * with its real datatype badge and its real link.
 */
export async function findDatasetRow(page: Page, name: string) {
  await page.getByTestId('datasets-search').fill(name)
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name }) })
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  return row
}

/**
 * Wait on the dataset-detail page until its processing badge shows a TERMINAL named
 * state (`Ready` / `Failed`). Returns the badge text (or whatever it last showed, on
 * timeout — the caller asserts).
 *
 * ── This used to RELOAD between polls; it no longer does ─────────────────────────
 * The reload compensated for a real product defect: during an on-ingest converter run
 * exactly ONE `sync:dataset` Update was published — from the metadata-write finalize
 * seam (`server/src/modules/jobs/seams.rs`), which runs while the job row is still
 * `running` — and NOTHING was published when the job then flipped to
 * `completed`/`failed`, so a client that loaded before the flip was stale for the life
 * of the page. Measured then: the badge read "Processing" for 40 s of continuous
 * polling while `GET /api/datasets/{id}` already said `completed`; one reload showed
 * "Ready".
 *
 * That publish now exists (`jobs::repository::publish_dataset_after_terminal`, emitted
 * post-commit from `finish` / `fail` / `mark_stopped`), so the reload is no longer
 * compensating for anything — and keeping it would let the defect come back unnoticed
 * in every spec that uses this helper. Callers get the live path for free.
 *
 * `processing-live-update.spec.ts` is the DEDICATED proof (it also counts navigations
 * and cross-checks the API, which this helper does not); this is simply no longer
 * masking it.
 */
export async function waitForTerminalProcessingStatus(
  page: Page,
  timeoutMs = 150_000,
): Promise<string> {
  const status = page.getByTestId('dataset-processing-status')
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = (await status.textContent().catch(() => null))?.trim() ?? ''
    if (/^(Ready|Failed)$/.test(last)) return last
    if (Date.now() >= deadline) return last
    await page.waitForTimeout(2_000)
  }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/**
 * The registry TITLE of the single-file datatype whose declared ingest extensions
 * include `extension` — i.e. the option label the type-first upload wizard renders
 * for it.
 *
 * DERIVED from `GET /api/datatypes`, never written down. The catalog is DATA
 * (`packages/**` manifests), so a spec that hardcodes a type's display name both
 * breaks on a rename and plants a domain literal in a tree whose guard
 * (`scripts/lint-no-domain-in-builtin.mjs`) exists to keep it out. This is the same
 * derivation `import-zarr.spec.ts` uses; it lives here so more than one spec can
 * drive the wizard without repeating it.
 */
export async function singleFileTypeTitle(
  request: APIRequestContext,
  token: string,
  extension: string,
): Promise<string> {
  const res = await request.get(`${BACKEND}/api/datatypes`, { headers: auth(token) })
  expect(res.ok(), `GET /datatypes -> ${res.status()}`).toBeTruthy()
  const rows = (await res.json()) as {
    id: string
    title?: string
    ingest?: { extensions?: string[] } | null
    input_requirements?: { requires?: string } | null
  }[]
  const want = extension.replace(/^\./, '').toLowerCase()
  const hit = rows.find(
    t =>
      t.input_requirements?.requires === 'single' &&
      (t.ingest?.extensions ?? []).some(e => e.replace(/^\./, '').toLowerCase() === want),
  )
  expect(
    hit,
    `no single-file datatype in the registry declares an ingest extension "${want}" — ` +
      'there is no one-file upload journey to drive',
  ).toBeTruthy()
  return hit!.title ?? hit!.id
}

/** Create a metadata-only dataset (owner). Returns the created row. */
export async function createDatasetApi(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const r = await request.post(`${BACKEND}/api/datasets`, {
    headers: auth(token),
    data: { name },
  })
  expect(r.ok(), `create dataset ${name}`).toBeTruthy()
  return r.json()
}

/** Create a project (owner). Returns the created row. */
export async function createProjectApi(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: auth(token),
    data: { name, description: '' },
  })
  expect(r.ok(), `create project ${name}`).toBeTruthy()
  return r.json()
}

/**
 * Upload ONE file → a new typed dataset via the real streaming upload endpoint
 * (the authoritative multipart part-name is `file`). A `.h5ad` sniffs to
 * `single-cell/anndata`, so the created dataset carries a datatype (and its
 * pipeline offers processors). Returns the first created dataset (with files).
 */
export async function uploadDatasetApi(
  request: APIRequestContext,
  token: string,
  filename: string,
  // A `Buffer` is accepted so a caller can seed a REAL committed fixture (and get a
  // converter run that actually completes) instead of only synthetic bytes.
  content: string | Buffer = 'anndata-fixture-payload',
): Promise<{ id: string; name: string; datatype?: string }> {
  const r = await request.post(`${BACKEND}/api/datasets/upload`, {
    headers: auth(token),
    multipart: {
      file: { name: filename, mimeType: 'application/octet-stream', buffer: Buffer.from(content) },
    },
  })
  expect(r.ok(), `upload ${filename}`).toBeTruthy()
  const body = await r.json()
  const ds = body.datasets?.[0]?.dataset ?? body.datasets?.[0]
  expect(ds?.id, 'upload returned a dataset').toBeTruthy()
  return ds
}

/** Share a dataset with a user principal at a role (owner-only). */
export async function shareDatasetApi(
  request: APIRequestContext,
  token: string,
  datasetId: string,
  userId: string,
  role: 'view' | 'edit' = 'view',
): Promise<void> {
  const r = await request.post(`${BACKEND}/api/datasets/${datasetId}/shares`, {
    headers: auth(token),
    data: { principal_type: 'user', principal_id: userId, role },
  })
  expect(r.ok(), 'share dataset').toBeTruthy()
}
