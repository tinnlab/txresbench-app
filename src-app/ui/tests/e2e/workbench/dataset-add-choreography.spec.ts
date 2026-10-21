import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { createDatasetApi, createProjectApi } from '../datasets/_helpers'

// richer-actions ITEM-7/9/10/11/12/13 — the dataset-attach choreography vertical:
// the human "Add dataset" stages the picker + yields; the AI-only "Add dataset by id"
// VISIBLY drives pick + attach and links the dataset; an interrupt stops it mid-run;
// and "dataset.list" returns the candidates the AI resolves an id from. The visible
// step sequence is asserted via the read-only `window.__choreography` seam, AND the
// real overlay DOM (spotlight/caption) is asserted (ITEM-7's visible half).
//
// Pin reduced-motion OFF so the per-step dwell applies deterministically (the runner
// reads live matchMedia; a reduced-motion env would collapse dwells and race the
// abort test) — the reduced-motion path itself is unit-covered.
// Through `contextOptions`, which is where a browser-context option belongs. Written bare as
// `reducedMotion` it was not a `test.use` option at all: it did not typecheck (invisible, since
// the tests tree was outside `tsc`) and the pin this comment describes never took effect.
test.use({ contextOptions: { reducedMotion: 'no-preference' } })

/* eslint-disable @typescript-eslint/no-explicit-any */

async function openWorkspace(page: Page, projectId: string): Promise<void> {
  await loginAsOwner(page)
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1000) // the workbench instance + context register
  await page.evaluate(() => {
    const c = (window as any).__choreography
    if (c) c.log = []
  })
}

function stepLog(page: Page) {
  return page.evaluate(() =>
    ((window as any).__choreography?.log || []).map((e: any) =>
      e.type === 'spotlight' ? `spot:${e.name}` : e.type,
    ),
  )
}

// TEST-11 — human path: open the pane, reveal the picker, YIELD (no attach).
test('Add dataset (human) opens the datasets pane, reveals the picker, and yields — TEST-11', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProjectApi(request, admin, `Add human ${Date.now()}`)
  await openWorkspace(page, project.id)

  await page.getByTestId('workbench-command-input').click()
  await page.getByTestId('workbench-command-dataset.add').click()

  // The datasets pane opened and the attach picker is present (revealed).
  await expect(page.getByTestId('project-attach-select')).toBeVisible({ timeout: 5000 })
  // Deterministically wait for the choreography to finish (clear emitted), not a fixed delay.
  await page.waitForFunction(
    () => {
      const l = (window as any).__choreography?.log || []
      return l.length > 0 && l[l.length - 1].type === 'clear'
    },
    undefined,
    { timeout: 6000 },
  )

  // The choreography spotlit the picker and ended at a clear (yield) — no attach step.
  const log = await stepLog(page)
  expect(log).toContain('spot:datasets:picker')
  expect(log).not.toContain('spot:datasets:attach-button')
  expect(log[log.length - 1]).toBe('clear')
})

// TEST-12 — AI byId path: the OVERLAY is visibly shown; the dataset ends up linked; narrated.
test('dataset.add.byId visibly drives pick + attach and links the dataset (narrated) — TEST-12', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `Add byId ${ts}`)
  const ds = await createDatasetApi(request, admin, `byid-ds-${ts}`)
  await openWorkspace(page, project.id)

  // Fire the AI-only action as the engine would (do NOT await — assert the overlay mid-run).
  await page.evaluate(dsId => {
    const a = (window as any).__actions
    void a.run('dataset.add.byId', { view_id: a.workbenchViewId(), dataset_id: dsId })
    return true
  }, ds.id)

  // ITEM-7: the REAL overlay renders a narration caption pill mid-run (not just the bus log).
  await expect(page.getByTestId('choreography-caption')).toBeVisible({ timeout: 5000 })

  // The dataset is now LINKED to the project (the panel's linked list shows it).
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toBeVisible({ timeout: 8000 })

  // The recorded sequence spotlit the picker AND the attach button, and was narrated.
  const info = await page.evaluate(() => {
    const log = (window as any).__choreography?.log || []
    return {
      spots: log.filter((e: any) => e.type === 'spotlight').map((e: any) => e.name),
      captioned: log.filter((e: any) => e.type === 'spotlight' && e.caption).length,
    }
  })
  expect(info.spots).toContain('datasets:picker')
  expect(info.spots).toContain('datasets:attach-button')
  expect(info.captioned).toBeGreaterThan(0)
})

// TEST-12b — interrupt: a visible step ran, then the abort stopped it before the attach.
test('interrupting dataset.add.byId mid-run stops before attach — TEST-12b', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `Add abort ${ts}`)
  const ds = await createDatasetApi(request, admin, `abort-ds-${ts}`)
  await openWorkspace(page, project.id)

  // Fire the run (don't await), then interrupt it DETERMINISTICALLY: wait until the
  // picker spotlight has actually rendered (mid-run), then abort — no timing race
  // against the pane-mount (a fixed-delay abort could land before the spotlight).
  await page.evaluate(dsId => {
    const a = (window as any).__actions
    void a.run('dataset.add.byId', { view_id: a.workbenchViewId(), dataset_id: dsId })
    return true
  }, ds.id)
  await page.waitForFunction(
    () =>
      ((window as any).__choreography?.log || []).some(
        (e: any) => e.type === 'spotlight' && e.name === 'datasets:picker',
      ),
    undefined,
    { timeout: 6000 },
  )
  await page.evaluate(() => (window as any).__actions.abortActive())
  await page.waitForTimeout(800)

  const log = await stepLog(page)
  // A visible step DID run (proves mid-run, not a no-op abort) …
  expect(log).toContain('spot:datasets:picker')
  // … it stopped before the attach step …
  expect(log).not.toContain('spot:datasets:attach-button')
  // … the overlay cleared …
  expect(log[log.length - 1]).toBe('clear')
  // … and the dataset was NOT linked.
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toHaveCount(0)
})

// TEST-13 — dataset.list returns the attach candidates (the AI's id-resolution read).
test('dataset.list returns the attach candidates the AI resolves an id from — TEST-13', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `List ${ts}`)
  const ds = await createDatasetApi(request, admin, `list-ds-${ts}`)
  await openWorkspace(page, project.id)

  // Open the datasets pane so the `datasets` instance exists for the read.
  await page.getByTestId('workbench-command-input').click()
  await page.getByTestId('workbench-command-dataset.add').click()
  await expect(page.getByTestId('project-attach-select')).toBeVisible({ timeout: 5000 })

  const res = await page.evaluate(() => {
    const a = (window as any).__actions
    return a.run('dataset.list', { view_id: a.workbenchViewId() }) as Promise<{
      candidates?: Array<{ id: string; name: string }>
    }>
  })
  const ids = (res.candidates || []).map(c => c.id)
  expect(ids).toContain(ds.id)
})
