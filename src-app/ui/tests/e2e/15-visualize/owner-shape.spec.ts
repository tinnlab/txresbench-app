// THE OWNER'S OWN PROJECT, AS A FIXTURE — the four defects they reported off the running app
// (`docs/design/visualize-pane-feedback.md` #21, #22, #24, #27).
//
// ── Why this file exists rather than four assertions bolted onto the existing specs ─────────
//
// Three successive rounds of work on this pane passed every test in this directory and changed
// NOTHING on the owner's screen. The reason is one property of the fixtures, not of the tests:
// every one of them was WELL DECLARED. They stamped `aligned_to`, they wrote exactly one
// keys-declaring artifact per axis, and they gave each coordinate set a distinct display name —
// so every join in the pane resolved through its strongest rung and no test ever exercised the
// data an ordinary import actually produces.
//
// `seedOwnerImportedShape` is built from the negatives instead (see its own doc), and it is the
// DEFAULT shape this suite runs against now — `mockup-conformance.spec.ts` drives it too. The
// two defects below were RED against it before the fixes and green after, which is the only
// evidence that separates a fix from a re-certification:
//
//   · **#22** — the owner, on picking a coordinate set: *"nothing show"* in either dependent
//     section. The derivation read `structure.key_sequence_digest` as "this artifact IS the
//     axis". An ordinary import writes TWO artifacts declaring one axis's key sequence — the
//     canonical index, and a per-row identifier column over the same keys — so the join found
//     two axes, refused (correctly, for an ambiguity that was not real), and both dependent
//     sections stayed on their "pick a coordinate set above" sentence forever.
//   · **#21** — the owner, on the emit control: *"right now I saw nothing plot"*. The emitted
//     plot's dataset revision was computed from its data slice alone, and a bare frame binds no
//     column, so that slice is empty by design. The declared coordinates arrive asynchronously:
//     the first publish resolved an empty source, the second carried the positions under a
//     byte-identical revision, and viz reused what it had already pinned.
//
// The pane is driven at the mockup's own width (300px), because these captures are the thing a
// person actually reads and a 300px rail is where every layout claim in this pane is settled.

import { expect, test, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { capture } from './_capture'
import {
  canvasPanesFull,
  coordinateEmits,
  openVisualize,
  OWNER_SHAPE,
  seedOwnerImportedShape,
  SECTIONS,
} from './_visualize'

const DATASET_NAME = 'Population 1'
/** The pane's real width — the mockup's own, and the width every section here is designed
 *  against. Set through the shipped persistence key before the app boots. */
const PANE_PX = 300

async function setRegionWidth(page: Page, px: number): Promise<void> {
  await page.addInitScript(
    ([key, width]: [string, number]) => {
      const raw = window.localStorage.getItem(key)
      const blob = raw ? (JSON.parse(raw) as Record<string, unknown>) : { v: 1, byProject: {} }
      blob.prefs = { leftWidth: width, rightWidth: width, bottomHeight: 240 }
      window.localStorage.setItem(key, JSON.stringify(blob))
    },
    ['txr.wb.regions', px] as [string, number],
  )
}

async function openOwnerProject(page: Page, request: import('@playwright/test').APIRequestContext): Promise<string> {
  const projectId = await createProject(request, `owner-shape ${Date.now()}`)
  await seedOwnerImportedShape(request, projectId, DATASET_NAME)
  await loginAsOwner(page)
  await setRegionWidth(page, PANE_PX)
  await openVisualize(page, projectId)
  return projectId
}

const coordinates = (page: Page) => page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
const colourBy = (page: Page) => page.locator(`[data-section-id="${SECTIONS.colourBy}"]`)
const entriesSection = (page: Page) => page.locator(`[data-section-id="${SECTIONS.entries}"]`)

test.describe("the owner's imported project", () => {
  test('#22/#24 — the pane opens framed, and BOTH dependent sections are scoped to that frame', async ({
    page,
    request,
  }) => {
    await openOwnerProject(page, request)

    // ── #24: the first set is selected, with no gesture ─────────────────────────────────
    const options = coordinates(page).getByRole('radio')
    await expect(options).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })
    await expect(options.first()).toBeChecked({ timeout: 30_000 })

    // ── #22: and that selection SCOPES the rest of the pane ─────────────────────────────
    //
    // Both sections, because the reported symptom names both and they resolve through the same
    // derivation — a fix that lit one and not the other would read as fixed from § Colour by.
    // Asserted on what the sections LIST, not on the absence of their empty sentence: a section
    // that dropped its alert and listed nothing would satisfy the weaker check.
    await expect(
      colourBy(page).getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.categorical}`, exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })
    await expect(
      colourBy(page).getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.continuous}`, exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })
    await expect(entriesSection(page).getByTestId(/widget-entries-entry-/).first()).toBeVisible({ timeout: 30_000 })

    // …and NEITHER section is still saying it has nothing to be about. This is the sentence the
    // owner was looking at, so it is asserted verbatim-ish rather than only by absence of rows.
    await expect(colourBy(page)).not.toContainText('Pick a coordinate set above')
    await expect(entriesSection(page)).not.toContainText('Pick a coordinate set above')

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'owner-shape-pane.png')
  })

  test('#21 — a coordinate row’s ▶ puts a plot on the canvas WITH ITS POINTS', async ({ page, request }) => {
    await openOwnerProject(page, request)

    const emits = coordinateEmits(page)
    await expect(emits).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })
    await emits.first().click()

    // ONE pane, and the assertion that matters is `rows`. A pane with zero rows is exactly what
    // the owner saw: it existed, it was titled, it had a close button, and it drew nothing.
    // Counting panes would have passed throughout the defect.
    await expect
      .poll(async () => (await canvasPanesFull(page)).length, { timeout: 30_000 })
      .toBe(1)
    await expect
      .poll(async () => (await canvasPanesFull(page))[0]?.rows ?? null, { timeout: 30_000 })
      .toBe(OWNER_SHAPE.rows)

    // The pane is named for the row that was pressed and for whose data it is — captured at
    // emit, so it keeps the name it was born with.
    const [pane] = await canvasPanesFull(page)
    expect(pane.title ?? '').toContain(DATASET_NAME)
  })

  test('#27 — every row carries a ▶, and pressing one draws THAT row without reframing the pane', async ({
    page,
    request,
  }) => {
    await openOwnerProject(page, request)

    const options = coordinates(page).getByRole('radio')
    const emits = coordinateEmits(page)
    await expect(emits).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })
    await expect(options.first()).toBeChecked({ timeout: 30_000 })

    // Press the ▶ on a row that is NOT the frame. Two properties at once, and the second is the
    // one a naive implementation loses: kit renders an option's content inside the `<label>`
    // that activates the choice, so an unguarded press would silently reframe the pane — and
    // reframing rescopes every other section as a side effect of asking for a picture.
    const second = emits.nth(1)
    const secondName = await second.getAttribute('aria-label')
    await second.click()

    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 30_000 }).toBe(1)
    await expect(options.first(), 'the emit press moved the frame').toBeChecked()
    await expect(options.nth(1)).not.toBeChecked()

    // …and what was drawn is the row that was PRESSED, not the row that is checked. The two are
    // told apart by identity here, because the fixture's declared names are identical by design.
    const [pane] = await canvasPanesFull(page)
    const pressed = (secondName ?? '').replace(/^Plot /, '')
    expect(pane.title ?? '', 'the pane drew the checked row rather than the pressed one').toContain(pressed)

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'owner-shape-row-emit.png')
  })
})
