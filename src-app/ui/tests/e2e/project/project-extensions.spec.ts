import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { parse as parseYaml } from 'yaml'
import { DT } from '../14-declarative-qc/_fixtures'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import { BACKEND, loginAsOwner, openDatasetsPane, ownerToken } from './_helpers'

async function createProject(request: APIRequestContext, admin: string, name: string) {
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name, description: '' },
  })
  expect(r.ok()).toBeTruthy()
  return r.json()
}

// TEST-8: the recent-projects sidebar — selecting a project navigates to it and marks it
// as the focused row; selecting another moves the focus (URL-driven).
//
// ── Rewritten: the expandable per-project sub-nav no longer exists ──────────────────────
//
// This asserted `recent-project-nav-<id>` and `recent-project-nav-<id>-datasets`, i.e. the
// sidebar expanding a project in place to reveal its `project_nav` sub-entries. `a7c75ef1`
// (the same commit that made the full-bleed workbench the only project section) also
// flattened this widget: `RecentProjectsWidget` renders one `Link` per project, and
// NEITHER testid exists anywhere in `src/` any more — with `workspace` the only registered
// `project_nav` entry there is no sub-nav left to expand into. So both the positive
// assertions AND the "B is collapsed" negative were dead: the negative passed only because
// nothing renders a sub-nav for ANY project.
//
// What survives is the real behaviour: the row navigates, and `aria-current="page"` tracks
// the focused project. The focus negatives below are kept non-vacuous by asserting the
// focused row POSITIVELY in the same breath — if the widget stopped rendering rows, or
// stopped tracking focus, the positive half fails first.
test('recent-projects sidebar navigates to the selected project + tracks focus', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const a = await createProject(request, admin, `Expand A ${Date.now()}`)
  const b = await createProject(request, admin, `Expand B ${Date.now()}`)

  await loginAsOwner(page)
  const widget = page.getByTestId('recent-projects-widget')
  await expect(widget).toBeVisible()
  await expect(page.getByTestId(`recent-project-row-${a.id}`)).toBeVisible()

  // Select A → navigates to A (the shell then redirects to its default `workspace`
  // section) and marks A's row as the current page.
  await page.getByTestId(`recent-project-row-${a.id}`).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${a.id}(/workspace)?$`))
  await expect(page.getByTestId(`recent-project-row-${a.id}`)).toHaveAttribute(
    'aria-current',
    'page',
  )
  // …and B is NOT the current page. Non-vacuous: A's row is asserted current directly
  // above, so both rows are known to be rendered.
  await expect(page.getByTestId(`recent-project-row-${b.id}`)).not.toHaveAttribute(
    'aria-current',
    'page',
  )

  // Select B → focus moves to B and leaves A (URL-driven).
  await page.getByTestId(`recent-project-row-${b.id}`).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${b.id}(/workspace)?$`))
  await expect(page.getByTestId(`recent-project-row-${b.id}`)).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByTestId(`recent-project-row-${a.id}`)).not.toHaveAttribute(
    'aria-current',
    'page',
  )
})

// TEST-9: the sidebar bounds its first page (Load-More feed idiom) and shows
// "Showing N of M"; Load-More appends the next page.
test('recent-projects sidebar bounds the first page + Load-More', async ({ page, request }) => {
  const admin = await ownerToken(request)
  // Seed enough projects that the total exceeds one page (20), independent of any
  // projects prior specs created.
  for (let i = 0; i < 25; i++) {
    await createProject(request, admin, `Bulk ${Date.now()}-${i}`)
  }

  await loginAsOwner(page)
  await expect(page.getByTestId('recent-projects-widget')).toBeVisible()
  // Bounded first page: exactly 20 rows loaded initially.
  await expect(page.locator('[data-testid^="recent-project-row-"]')).toHaveCount(20)
  await expect(page.getByTestId('recent-projects-count')).toContainText(/Showing 20 of \d+/)

  // Load more → more than 20 rows now.
  await page.getByTestId('recent-projects-load-more').click()
  await expect
    .poll(async () => page.locator('[data-testid^="recent-project-row-"]').count())
    .toBeGreaterThan(20)
})

// TEST-10: the DatasetsPanel header shows the summary fetched through the
// regenerated `ApiClient.Project.datasetSummary` (the extension-owned route), AND
// what the project holds, in the contributing package's own words.
//
// ── Why this seeds real artifacts, when it used to seed bare rows ─────────────────
//
// This spec asserted the two axis names against two `POST /api/datasets` rows
// carrying nothing but a name. It could pass ONLY while the summary read them off
// denormalized per-axis totals on the app's own dataset row. `b98e4745` dropped those
// columns (a deliberate domain strip: this app is not allowed to know what the
// producer's vocabulary means) and left the assertion standing, so it has been red on
// `main` since 2026-07-17.
//
// Both halves of that were wrong and only one was noticed. The FIXTURE was asserting
// that the app names a matrix's dimensions for a dataset that holds no matrix — true
// of no correct implementation, so relaxing the assertion would have been the second
// mistake. And the PRODUCT never re-pointed the project rollup at the declared
// per-type previews that replaced those columns: it kept a hardcoded `N datasets
// linked` while the per-dataset row beside it went through the seam.
//
// ── The words come from the DATA, and this file does not contain them ─────────────
//
// The expected axis names are READ from the package's own `manifest.yaml` — the same
// declaration the app resolves through, globbed the way `project-extension/gallery.tsx`
// globs it. Hardcoding them would (a) trip `lint-no-domain-in-builtin`, which is right:
// the app tree, tests included, must carry zero of the domain lattice, and (b) assert
// something weaker — "the summary contains this word" instead of "the summary names
// what the producer DECLARED", which is the property that actually regressed.
//
// Seeded through the debug seed engine — one HTTP POST, no sandbox, no import — because
// what is under test is the summary, not the importer.

const PROCESSORS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages')

/**
 * The axis identities the datatype's OWN package declares, in its declared order.
 *
 * Found by SEARCHING every processor manifest for the datatype, never by naming the
 * package that happens to declare it today — the same reason the app resolves through
 * a registry populated from all of them, and the reason this file can carry none of
 * the domain lattice (`lint-no-domain-in-builtin`).
 */
function declaredAxisNames(): string[] {
  let names: string[] = []
  for (const dir of readdirSync(PROCESSORS, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const file = join(PROCESSORS, dir.name, 'manifest.yaml')
    if (!existsSync(file)) continue
    const doc = parseYaml(readFileSync(file, 'utf8')) as {
      contributes?: { datatypes?: { id: string; axes?: { name: string }[] }[] }
    }
    const dt = doc.contributes?.datatypes?.find(d => d.id === DT.expression)
    if (dt?.axes?.length) names = dt.axes.map(a => a.name)
  }
  // POSITIVE COUNT: an empty read would make every assertion below vacuous.
  expect(names.length, `no processor manifest declares axes for ${DT.expression}`).toBe(2)
  return names
}
/** Two different extents, so an assertion cannot pass by finding the same number twice. */
const EXTENTS: [number, number] = [3_460, 32_738]

test('datasets panel shows the dataset-summary from the extension route', async ({
  page,
  request,
}) => {
  const axes = declaredAxisNames()
  const admin = await ownerToken(request)
  const project = await createProject(request, admin, `Summary Project ${Date.now()}`)
  // TWO datasets so the summary reads an unambiguous "2 datasets" (not a singular
  // that would hide a pluralization bug) — and so the ROLLUP is a real merge across
  // datasets rather than a pass-through of one.
  for (let i = 0; i < 2; i++) {
    await postSeedPlan(request, project.id, {
      dataset: { name: `sum-ds-${Date.now()}-${i}`, datatype: DT.expression },
      artifacts: [
        {
          output_id: 'expression',
          datatype: DT.expression,
          scope: 'dataset',
          // The producer-declared decode contract the preview template reads: `axes`
          // index-aligned with `shape`, exactly as a real producer writes the pair.
          // The second dataset is deliberately SMALLER and its bytes fewer, so the
          // merged group's representative is decidable and is the first one.
          structure: { shape: [EXTENTS[0] - i * 1_000, EXTENTS[1] - i * 1_000], axes },
          content: { encoding: 'json', value: { seed: 'expression', pad: 'x'.repeat(200 - i * 100) } },
        },
      ],
    })
  }

  await loginAsOwner(page)
  // Datasets is a workbench PANE behind a tab, not a `/datasets` section: the old
  // `page.goto('/projects/:id/datasets')` redirected to `/workspace` and left the panel
  // unmounted, so this test had been failing on `project-datasets-card` since a7c75ef1.
  await openDatasetsPane(page, project.id)
  const summary = page.getByTestId('project-datasets-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText(/2 datasets/)
  // The DECLARED size, in the package's words — not a phrase this app owns. Both axis
  // names AND both extents, so a summary that named one and dropped the other fails.
  for (const axis of axes) await expect(summary).toContainText(axis)
  for (const n of EXTENTS) await expect(summary).toContainText(n.toLocaleString('en-US'))
})

// NEGATIVE CONTROL for the test above. Without it, "the summary names the declared
// axes" is satisfied by any hardcoded phrase containing those words — which is the
// exact defect being fixed, so the assertion has to be able to tell the difference.
// A project whose datasets hold NOTHING must print the count and stop.
test('the project summary states only what it counted, for datasets that hold nothing', async ({
  page,
  request,
}) => {
  const axes = declaredAxisNames()
  const admin = await ownerToken(request)
  const project = await createProject(request, admin, `Empty Summary ${Date.now()}`)
  const ds = await request
    .post(`${BACKEND}/api/datasets`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `empty-ds-${Date.now()}` },
    })
    .then(r => r.json())
  await request.post(`${BACKEND}/api/projects/${project.id}/datasets/${ds.id}`, {
    headers: { authorization: `Bearer ${admin}` },
  })

  await loginAsOwner(page)
  await openDatasetsPane(page, project.id)
  const summary = page.getByTestId('project-datasets-summary')
  await expect(summary).toContainText(/1 dataset\b/)
  for (const axis of axes) await expect(summary).not.toContainText(axis)
})
