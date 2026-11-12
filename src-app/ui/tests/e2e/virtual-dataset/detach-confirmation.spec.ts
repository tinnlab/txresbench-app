import { expect, test } from '@playwright/test'
import { BACKEND, createDatasetApi, createProjectApi, loginOwnerToDatasets, ownerToken } from '../datasets/_helpers'
import { openDatasetsPane } from '../project/_helpers'

/** The narrowest viewport at which the project Datasets surface exists at all. MEASURED,
 *  not chosen — see the boundary spec at the bottom of this file. */
const NARROWEST = 768

// TEST-51 [ITEM-38] — Detach ASKS FIRST, and asks before it acts.
//
// Before this item the Detach button fired the mutation on click: no Popconfirm, no
// Modal, nothing said between the click and the deleted link. The only pre-click text
// was the button's `title`, and the only post-hoc text was a toast — by which point the
// link was gone.
//
// The assertion that carries the weight is the DISMISS one. "A confirmation appears" is
// satisfied by a dialog that fires the mutation anyway, and "accepting detaches" is
// satisfied by today's behaviour with a decorative dialog in front of it. Only
// "dismissing leaves the junction row INTACT" distinguishes a real gate from a
// cosmetic one.
//
// NEGATIVE CONTROL: restore the immediate-fire button —
// `onClick={() => void onDetach(...)}` with no `<Confirm>` wrapper — and the dismiss
// leg goes RED (the row is gone after Cancel), while a `toBeVisible()`-only version of
// this spec would still pass. Verified RED before this spec was recorded green.
//
// Drives the real backend through the UI. Fixtures (dataset, project, link) are seeded
// over REST exactly as the sibling `datasets/attach.spec.ts` seeds them; every assertion
// about the detach itself goes through the rendered panel.
test('detach asks first: dismissing leaves the link intact, accepting removes it — TEST-51', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `Detach Confirm ${ts}`)
  const ds = await createDatasetApi(request, admin, `detach-confirm-ds-${ts}`)

  const link = await request.post(`${BACKEND}/api/projects/${project.id}/datasets/${ds.id}`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(link.ok(), 'seed the project↔dataset link').toBeTruthy()

  await loginOwnerToDatasets(page)
  await openDatasetsPane(page, project.id)

  const row = page.getByTestId(`project-dataset-row-${ds.id}`)
  const detach = page.getByTestId(`project-detach-${ds.id}`)
  const prompt = page.getByTestId(`project-dataset-detach-confirm-${ds.id}`)
  const accept = page.getByTestId(`project-dataset-detach-confirm-${ds.id}-confirm`)
  const cancel = page.getByTestId(`project-dataset-detach-confirm-${ds.id}-cancel`)

  // POSITIVE CONTROL for every absence assertion below: the panel really rendered this
  // dataset. Without it, a page that failed to mount would satisfy "no prompt is open"
  // and "no mutation happened" vacuously.
  await expect(row).toBeVisible()
  await expect(prompt).toHaveCount(0)

  // 1 — the click OPENS a prompt and performs NO mutation.
  await detach.click()
  await expect(prompt).toBeVisible()
  await expect(row).toBeVisible()
  // It names the dataset and states the consequence in the user's terms — the dataset
  // survives. (ITEM-39/40 add the dependent-artifact warning and the refusal here; this
  // item is the step they need to exist first.)
  await expect(prompt).toContainText(ds.name)
  await expect(prompt).toContainText(/not deleted/i)

  // 2 — DISMISSING leaves the junction row intact. This is the leg that fails against
  // an immediate-fire button.
  await cancel.click()
  await expect(prompt).toHaveCount(0)
  await expect(row).toBeVisible()

  // …and the link genuinely survived on the server, not merely in the rendered list.
  const afterCancel = await request.get(`${BACKEND}/api/projects/${project.id}/datasets`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(afterCancel.ok()).toBeTruthy()
  const stillLinked = (await afterCancel.json()) as { datasets?: { id: string }[] }
  expect(
    (stillLinked.datasets ?? []).some(d => d.id === ds.id),
    'cancelling the prompt must not detach',
  ).toBeTruthy()

  // 3 — ACCEPTING detaches.
  await detach.click()
  await expect(prompt).toBeVisible()
  await accept.click()
  await expect(row).toHaveCount(0)
})

// The narrow-viewport leg, and it is here rather than in a gallery state on purpose.
//
// PLAN-STAGE-3-ui.md says a missing narrow state "fails `check:state-matrix`". MEASURED:
// this repo has no `check:state-matrix`, no `check:gallery-coverage`, and neither is
// invoked by `npm run check` or by `gate:ui` — those names come from the shared agent-kit
// validator's txresbench vocabulary, not from TxResBench's `src-app/ui/package.json`. So
// nothing mechanical enforces a narrow-viewport requirement, and a responsive claim
// resting on a gate that does not exist is not a claim. This spec is the enforcement.
//
// ── WHY 768 AND NOT THE PLAN'S 390 ──────────────────────────────────────────────────
// The plan asked for 390px. That requirement was WRONG, not unmet: the owner has since
// confirmed (2026-08-17, via the stage coordinator) that the project workbench — and
// therefore this surface — is DESKTOP-ONLY BY DESIGN. The measurement below is the
// evidence that established it, and it is recorded as intended behaviour, not as a gap.
// MEASURED by driving the real app across widths:
//
//   width  mobileShell  region-tab-p-datasets  datasets card via any mobile sheet
//     390       yes              0                           NONE
//     640       yes              0                           NONE
//     767       yes              0                           NONE
//     768        no              1                            n/a
//     900        no              1                            n/a
//    1280        no              1                            n/a
//
// Below 768px the workbench renders `MobileShell`, which mounts only the center
// `PlacedArea` plus three sheets (left = Visualize SectionStack, bottom = analyses rail,
// right = PlacedArea('right')). The Datasets panel is a LEAF IN THE MAIN DOCK SPLIT-TREE
// (`dock/defaultLayout.ts` — `[visualize | (canvas over (launcher | datasets))]`), and
// that tree is not rendered on mobile at all. Opening each of the three sheets in turn
// finds the panel in NONE of them.
//
// THAT IS INTENDED. The project workbench is a desktop analysis surface; the mobile shell
// deliberately carries the canvas and the three sheet areas and NOT the dock split-tree.
// So 768px is not a limitation to route around — it is the surface's declared floor, and
// testing this prompt at 390px would be testing a state the product does not claim.
//
// So this spec pins that floor: 768px is the narrowest width at which the surface exists,
// and it asserts BOTH that the prompt is usable there AND that 767px is still the mobile
// shell. The second assertion is what makes this a boundary rather than a number — if the
// breakpoint moves, the floor moved with it, and that should be a deliberate change
// someone sees go red rather than a silent one.
test('the detach prompt is usable at the narrowest width the surface exists at (768px) — TEST-51', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `Detach Narrow ${ts}`)
  const ds = await createDatasetApi(request, admin, `detach-narrow-ds-${ts}`)
  const link = await request.post(`${BACKEND}/api/projects/${project.id}/datasets/${ds.id}`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(link.ok(), 'seed the project↔dataset link').toBeTruthy()

  await page.setViewportSize({ width: NARROWEST, height: 900 })
  await loginOwnerToDatasets(page)
  await openDatasetsPane(page, project.id)

  await page.getByTestId(`project-detach-${ds.id}`).click()
  const prompt = page.getByTestId(`project-dataset-detach-confirm-${ds.id}`)
  await expect(prompt).toBeVisible()

  // Both controls are reachable — an off-screen confirm is the narrow-viewport failure
  // this leg exists to catch, and it renders "visible" to a bare toBeVisible().
  const accept = page.getByTestId(`project-dataset-detach-confirm-${ds.id}-confirm`)
  const cancel = page.getByTestId(`project-dataset-detach-confirm-${ds.id}-cancel`)
  for (const control of [accept, cancel]) {
    const box = await control.boundingBox()
    expect(box, 'control has a layout box').not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROWEST)
  }

  // The page itself must not scroll horizontally while the prompt is open.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(overflows, `no horizontal page scroll at ${NARROWEST}px`).toBe(false)

  await cancel.click()
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toBeVisible()
})

// The declared floor itself. Without this, the spec above is a test at an arbitrary width
// and a breakpoint moved to 1024 would leave it green while the floor silently rose.
//
// READ THIS BEFORE "FIXING" ANYTHING HERE: the absence below 768 is INTENDED — the owner
// confirmed the project workbench is desktop-only by design (2026-08-17). This spec
// documents that decision so it stays deliberate; it is NOT a pending mobile-support bug,
// and making the Datasets panel reachable on the mobile shell would turn it red.
test('768px is the declared desktop floor: one pixel narrower is the mobile shell, which intentionally does not carry this surface — TEST-51', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const project = await createProjectApi(request, admin, `Detach Boundary ${ts}`)
  const ds = await createDatasetApi(request, admin, `detach-boundary-ds-${ts}`)
  const link = await request.post(`${BACKEND}/api/projects/${project.id}/datasets/${ds.id}`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(link.ok(), 'seed the project↔dataset link').toBeTruthy()

  await loginOwnerToDatasets(page)

  // At NARROWEST the desktop region shell renders and the pane tab exists — the POSITIVE
  // control, so the absence below is a real absence and not a page that failed to load.
  await page.setViewportSize({ width: NARROWEST, height: 900 })
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.locator('[data-workbench-mobile="true"]')).toHaveCount(0)
  await expect(page.getByTestId('region-tab-p-datasets')).toHaveCount(1)

  // One pixel narrower: the mobile shell, and no pane tab. This is the INTENDED behaviour
  // (DRIFT-stage3-1.4) — recorded so a change to it is a deliberate one.
  await page.setViewportSize({ width: NARROWEST - 1, height: 900 })
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.locator('[data-workbench-mobile="true"]')).toHaveCount(1)
  await expect(page.getByTestId('region-tab-p-datasets')).toHaveCount(0)
})
