import { type APIRequestContext, expect, type Frame, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken, uploadDatasetApi } from './_helpers'

// The dataset-detail processing badge must reach its TERMINAL state on a page that is
// never reloaded — i.e. the terminal transition has to arrive over the realtime channel.
//
// ── Why this spec exists ─────────────────────────────────────────────────────────
// `processing_status` is DERIVED server-side from the dataset's processing job row, so
// `running → completed|failed` changes what `GET /api/datasets/{id}` returns with no
// write to the dataset itself. The on-ingest run used to publish exactly ONE
// `sync:dataset` frame — from the metadata-write finalize seam, which runs while the job
// is still `running` — and NOTHING when the job then flipped terminal. A client that
// loaded before that flip was stale for the life of the page: measured, the badge read
// "Processing" for 40 s of continuous polling while the API already said `completed`,
// and one manual reload showed "Ready".
//
// Every other spec that waits on this badge goes through
// `_helpers.ts::waitForTerminalProcessingStatus`, which RELOADS between polls — so none
// of them could ever have caught this. This one holds the page open and asserts the
// live path directly.
//
// ── What makes it non-vacuous ────────────────────────────────────────────────────
//  1. the FIRST badge text on this page instance must be non-terminal (Queued /
//     Processing). If the run had already finished before the page opened there would be
//     no stale window to close, and a green would prove nothing — so that is a hard
//     failure, not a skip.
//  2. the server is polled INDEPENDENTLY until it reports terminal. Only then is the
//     badge asserted, so the assertion is "the UI caught up with a state the API is
//     already reporting" — exactly the measured defect.
//  3. main-frame navigations are counted from the moment the page is up and must be
//     ZERO, so the pass cannot come from an incidental reload.
//
// Real streaming upload + the real on-ingest converter + real DB — no API mocking.

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/**
 * The file extension of the registry's directly-uploadable SINGLE-file type — the one
 * whose upload enqueues an on-ingest converter run.
 *
 * DERIVED from `GET /api/datatypes`, never written down. The catalog is DATA
 * (`packages/**` manifests), so a spec that hardcodes a type's id, title or extension
 * both breaks on a rename and plants a domain literal in a tree whose guard
 * (`scripts/lint-no-domain-in-builtin.mjs`) exists to keep it out. Same derivation as
 * `_helpers.ts::singleFileTypeTitle`, from the other direction.
 */
async function singleFileUploadExtension(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  const res = await request.get(`${BACKEND}/api/datatypes`, { headers: auth(token) })
  expect(res.ok(), `GET /datatypes -> ${res.status()}`).toBeTruthy()
  const rows = (await res.json()) as {
    id: string
    ingest?: { extensions?: string[] } | null
    input_requirements?: { requires?: string } | null
  }[]
  const hit = rows.find(
    t => t.input_requirements?.requires === 'single' && (t.ingest?.extensions ?? []).length > 0,
  )
  expect(
    hit,
    'no directly-uploadable single-file datatype declares an ingest extension — there is ' +
      'no one-file upload that enqueues an on-ingest run, so this spec has no subject',
  ).toBeTruthy()
  return hit!.ingest!.extensions![0].replace(/^\./, '')
}

/** The dataset's server-side DERIVED processing status (the badge's source of truth). */
async function processingStatus(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<string | null> {
  const res = await request.get(`${BACKEND}/api/datasets/${id}`, { headers: auth(token) })
  expect(res.ok(), `GET /datasets/${id} -> ${res.status()}`).toBeTruthy()
  return ((await res.json()) as { processing_status?: string | null }).processing_status ?? null
}

test('the processing badge reaches its terminal state LIVE, with no reload', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)
  const token = await ownerToken(request)
  const ext = await singleFileUploadExtension(request, token)
  const ts = Date.now()

  await loginAsOwner(page)

  // Upload through the real streaming endpoint. It returns as soon as the bytes are
  // ingested and the on-ingest run is ENQUEUED, so the detail page below opens while
  // that run is still ahead of us — which is the window this spec is about.
  const ds = await uploadDatasetApi(request, token, `live-badge-${ts}.${ext}`, `live-badge-${ts}`)

  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible({ timeout: 30_000 })

  // ── From here the page is NEVER navigated again. Counted, not promised. ──
  let navigations = 0
  const countNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) navigations += 1
  }
  page.on('framenavigated', countNavigation)

  const badge = page.getByTestId('dataset-processing-status')
  await expect(badge).toBeVisible({ timeout: 30_000 })

  // (1) Non-vacuity: this page instance must have opened DURING the run.
  const firstSeen = (await badge.textContent())?.trim() ?? ''
  expect(
    firstSeen,
    'the detail page opened after the run had already finished, so there was no stale ' +
      'window to close and this spec would pass without proving anything',
  ).toMatch(/^(Queued|Processing)$/)

  // (2) Poll the SERVER independently until it reports a terminal state. This is the
  //     moment the badge went stale pre-fix.
  const deadline = Date.now() + 240_000
  let serverStatus: string | null = null
  for (;;) {
    serverStatus = await processingStatus(request, token, ds.id)
    if (serverStatus === 'completed' || serverStatus === 'failed') break
    if (Date.now() >= deadline) {
      throw new Error(
        `the on-ingest run never reached a terminal state server-side within 240 s ` +
          `(last processing_status: ${serverStatus ?? 'null'}) — this spec cannot say ` +
          'anything about live delivery until the server has something to deliver',
      )
    }
    await page.waitForTimeout(2_000)
  }

  // (3) THE ASSERTION. The API already reports terminal; the un-reloaded page must catch
  //     up on its own. Pre-fix this is where it fails: the badge is pinned at "Processing"
  //     because nothing is published when the job flips terminal.
  await expect(
    badge,
    `the API reports processing_status="${serverStatus}" but the badge — on a page that ` +
      'was never reloaded — never left its non-terminal state. The terminal job ' +
      'transition is not being published as a sync:dataset update.',
  ).toHaveText(/^(Ready|Failed)$/, { timeout: 45_000 })

  // The observed badge must AGREE with the server, not merely be terminal.
  await expect(badge).toHaveText(serverStatus === 'completed' ? 'Ready' : 'Failed')

  page.off('framenavigated', countNavigation)
  expect(
    navigations,
    'the page was navigated/reloaded during the wait, so a terminal badge would not ' +
      'prove live delivery',
  ).toBe(0)
})
