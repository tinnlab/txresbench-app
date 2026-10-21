// TEST-15 (e2e) [covers: ITEM-9, ITEM-7, ITEM-8] + TEST-A7 (e2e) [acceptance]
// [invariant: INV-7] [covers: ITEM-64] — a user rearranges the Visualize pane, and it stays
// rearranged.
//
// DEFERRED FROM PARTITION B AND LANDED HERE (DRIFT-1.17): both halves drive a pane that
// RENDERS SECTIONS, and there were none until ITEM-65's package shipped. The mechanism
// halves stayed unit-pinned meanwhile — `resolveSectionOrder.test.ts` for the ordering rule,
// `pointerDrag.test.ts` for the drop rule, `WorkbenchRegions.store.test.ts` for the
// persistence — and this is the leg none of them can cover: that a real pointer drag on a
// real handle moves a real section, and that the arrangement survives a reload and belongs
// to ONE project.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import {
  SECTIONS,
  dragSectionOver,
  frame,
  handle,
  openVisualize,
  renderedOrder,
  seedTwoSectionProject,
} from './_visualize'

/** The PACKAGE's own declared arrangement (`order:` 10, 20, 30) — what places a section the
 *  user has never touched. Named rather than inlined because a package adding a section is an
 *  ordinary event, and the drag assertions below are about the DIFFERENCE from this order. */
const DECLARED_ORDER = [SECTIONS.coordinates, SECTIONS.colourBy, SECTIONS.entries]
/** …and the same list after the second section is dragged above the first. The untouched
 *  sections keep their declared rank, which is `resolveSectionOrder`'s whole rule. */
const DRAGGED_ORDER = [SECTIONS.colourBy, SECTIONS.coordinates, SECTIONS.entries]

test.describe('the user arranges the Visualize pane (TEST-15, TEST-A7)', () => {
  test('a drag reorders the stack, survives a reload, and is scoped to that project', async ({ page, request }) => {
    await loginAsOwner(page)
    const a = await createProject(request, `Visualize arrange A ${Date.now()}`)
    const b = await createProject(request, `Visualize arrange B ${Date.now()}`)
    await seedTwoSectionProject(request, a)
    await seedTwoSectionProject(request, b)

    await openVisualize(page, a)
    // The DECLARED arrangement first — the package's own `order:` (10, then 20), which is
    // what places a section the user has never touched. Asserting it before the drag is
    // what makes the drag's effect attributable.
    await expect(page.getByTestId(frame(SECTIONS.coordinates))).toBeVisible()
    await expect(page.getByTestId(frame(SECTIONS.colourBy))).toBeVisible()
    await expect(page.getByTestId(frame(SECTIONS.entries))).toBeVisible()
    expect(await renderedOrder(page)).toEqual(DECLARED_ORDER)

    // Drag the SECOND section above the first. Immediately — no reload, no refetch: the
    // stack subscribes to the saved order, so the drop re-renders it in place.
    await dragSectionOver(page, SECTIONS.colourBy, SECTIONS.coordinates)
    await expect
      .poll(() => renderedOrder(page), { timeout: 10_000, message: 'the drop must reorder the stack immediately' })
      .toEqual(DRAGGED_ORDER)

    // It SURVIVES a reload. `sectionOrder` is per-project `localStorage` (ITEM-7) — an
    // ARRANGEMENT, deliberately not per-window session state, because a user who rearranges
    // in one tab wants it in the next.
    await page.reload()
    await openVisualize(page, a)
    expect(await renderedOrder(page)).toEqual(DRAGGED_ORDER)

    // …and it is THAT project's arrangement. The second project is the control: without it
    // a global bucket would pass every assertion above.
    await openVisualize(page, b)
    expect(await renderedOrder(page)).toEqual(DECLARED_ORDER)
  })

  // ── the same arrangement, without a pointer ──────────────────────────────────────────────
  //
  // The drag above is the ONLY way the pane's arrangement could be changed: the grip carried a
  // pointer listener and nothing else, so a keyboard user could reach the handle, be told by
  // its `role="button"` that it was a control, press Enter, and get nothing. A per-user setting
  // the whole pane is read against was mouse-and-touch-only.
  //
  // Driven here rather than only in the unit test because the unit test dispatches key events
  // at the handle directly; what a real user does is TAB to it, which only works if the wired
  // handle is genuinely in the tab order and the keys are not swallowed by the accordion header
  // it lives in.
  test('a keyboard user can rearrange the pane, and it persists the same way', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Visualize keyboard arrange ${Date.now()}`)
    await seedTwoSectionProject(request, id)
    await openVisualize(page, id)
    expect(await renderedOrder(page)).toEqual(DECLARED_ORDER)

    const grip = page.getByTestId(handle(SECTIONS.colourBy))
    await grip.focus()
    await expect(grip).toBeFocused()

    // PICK UP — and the control says so, to assistive tech as well as to the eye.
    await page.keyboard.press('Enter')
    await expect(grip).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('section-reorder-status-visualize')).toContainText(/picked up, position 2 of 3/i)

    // MOVE — the same one-position move the drag above performs, so the two paths are
    // demonstrably the same operation and not two arrangements.
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => renderedOrder(page), { timeout: 10_000 }).toEqual(DRAGGED_ORDER)

    // ESCAPE PUTS IT BACK. A move with no way out is a trap for the one user who cannot see
    // where the thing went.
    await page.keyboard.press('Escape')
    await expect.poll(() => renderedOrder(page), { timeout: 10_000 }).toEqual(DECLARED_ORDER)
    await expect(grip).toHaveAttribute('aria-pressed', 'false')

    // …and a move that is DROPPED survives a reload, exactly as the dragged one does — the
    // arrangement is one setting, whichever hand wrote it.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect.poll(() => renderedOrder(page), { timeout: 10_000 }).toEqual(DRAGGED_ORDER)
    await page.reload()
    await openVisualize(page, id)
    expect(await renderedOrder(page)).toEqual(DRAGGED_ORDER)
  })

  test('collapse is DISPLAY, not reset — a collapsed section still holds what it held (TEST-A7, INV-7)', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Visualize collapse ${Date.now()}`)
    await seedTwoSectionProject(request, id)
    await openVisualize(page, id)

    // Collapse via the section's own header trigger, then re-expand. The claim is R6's: the
    // section's contents come back as they were, so collapsing is not a way to lose state.
    // Addressed by the section's own trigger, not by `{ name: 'Coordinates', exact: true }`.
    // Since ledger #25 the plot-count badge renders INSIDE the accordion trigger (it has to, to
    // sit left of the chevron), so a section that is HOLDING something announces as
    // `Coordinates 1` and the exact match stops finding it. This fixture emits nothing, so the
    // exact match still worked — which is precisely why it is worth changing: the test would
    // have kept passing until the day somebody added an emit above it.
    const header = page
      .locator(`[data-section-id="${SECTIONS.coordinates}"] [data-slot="accordion-trigger"]`)
      .first()
    await expect(page.getByTestId(frame(SECTIONS.coordinates))).toBeVisible()
    const picker = page.locator('[data-testid^="widget-coordinatePicker"]')
    const before = await picker.count()
    expect(before, 'the open section must actually hold a body — else the poll below is vacuous')
      .toBeGreaterThan(0)
    await header.click()

    // HIDDEN, NOT GONE — and this assertion is the whole of TEST-A7's claim.
    //
    // It used to poll `picker.count()` down to ZERO, i.e. it asserted the body was REMOVED
    // FROM THE DOM under a name that says collapse is DISPLAY, not reset. It passed because
    // that is exactly what was happening: kit's Accordion is base-ui and `keepMounted`
    // defaulted to false, so a collapsed section's `DeclarativeRegion` unmounted, its
    // badge-cleanup effect fired, and its canvas order froze. The test certified the defect.
    //
    // So: still ATTACHED (the count is unchanged), and not VISIBLE.
    await expect
      .poll(() => picker.count(), { timeout: 10_000, message: 'a collapsed section stays MOUNTED' })
      .toBe(before)
    await expect(picker.first()).toBeHidden({ timeout: 10_000 })

    await header.click()
    await expect
      .poll(() => picker.count(), { timeout: 10_000, message: 're-expanding must restore the SAME body' })
      .toBe(before)
    await expect(picker.first()).toBeVisible({ timeout: 10_000 })
  })
})
