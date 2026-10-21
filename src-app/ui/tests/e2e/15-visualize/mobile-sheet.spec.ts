// TEST-11 (e2e) [covers: ITEM-5, ITEM-3] — the Visualize pane in the MOBILE sheet.
//
// DEFERRED FROM PARTITION B AND LANDED HERE, which is the whole reason it is written now:
// DRIFT-1.17 recorded that this spec drives a Visualize pane that RENDERS SECTIONS, and
// with an empty `registry.sections` the pane renders its stated empty state — so a spec
// written then would have asserted the empty state (proving nothing about a section) or
// been skipped, which the repo forbids. ITEM-65's package is what makes it writable.
//
// What it pins: below 768px `WorkbenchShell` renders `MobileShell`, whose LEFT sheet is
// `SectionStack pane="visualize"` while its RIGHT sheet is still a `PlacedArea` — the
// branch inside the ONE shared `sheetBody`, per the phase-2 correction to ITEM-5. At 390px
// the stack is the sheet's full width on ONE scroll track, sections open at their DECLARED
// `collapsed` default, the drag handle is thumb-sized, and the page does not scroll
// sideways.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { SECTIONS, frame, handle, seedTwoSectionProject, stack } from './_visualize'

test.describe('the Visualize sections in the mobile sheet (TEST-11)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('at 390px the left sheet renders the section stack on one track, and it fits', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Visualize mobile ${Date.now()}`)
    await seedTwoSectionProject(request, id)

    await page.goto(`/projects/${id}/workspace`)
    const shell = page.getByTestId('workbench-shell')
    await shell.waitFor({ state: 'visible', timeout: 30_000 })
    // The MOBILE branch, asserted rather than assumed: every claim below is about
    // `MobileShell`, and on the desktop branch they would be about a different component
    // that happens to render similar testids.
    await expect(shell).toHaveAttribute('data-workbench-mobile', 'true')

    // The left sheet IS the section stack. Opening it is the sheet's own affordance; the
    // stack's testid is what proves which component answered.
    const sheetTrigger = page.getByRole('button', { name: 'Visualize', exact: true }).first()
    if (await sheetTrigger.count()) await sheetTrigger.click()
    await expect(page.getByTestId(stack)).toBeVisible({ timeout: 30_000 })

    // ONE scroll track for the PANE, not one per section (ITEM-3). Asserted by COUNT: a
    // per-section scroller would give the sheet a stack of small independent viewports,
    // each with its own bar and its own position, which is the layout that comment forbids.
    await expect(page.getByTestId('section-track-visualize')).toHaveCount(1)

    // Both sections present, at their DECLARED collapse defaults. `collapsed: false` on both
    // today — the claim is that the sheet honours the DECLARATION rather than imposing a
    // mobile-only default.
    //
    // It used to be asserted as `toBeVisible()` on `section-frame-<id>`, which is the testid
    // of the Accordion ROOT — an element that renders identically whether the section is open
    // or closed. So the assertion could not observe the property its own comment named: a
    // mobile-only "start collapsed" default would have passed it. The state lives on the
    // TRIGGER (`aria-expanded`), so that is what is read.
    const trigger = (id: string) => page.getByTestId(frame(id)).getByRole('button').first()
    await expect(page.getByTestId(frame(SECTIONS.coordinates))).toBeVisible()
    await expect(page.getByTestId(frame(SECTIONS.colourBy))).toBeVisible()
    await expect(trigger(SECTIONS.coordinates)).toHaveAttribute('aria-expanded', 'true')
    await expect(trigger(SECTIONS.colourBy)).toHaveAttribute('aria-expanded', 'true')

    // NEGATIVE CONTROL. Both declared values are `false` today, so an assertion that only ever
    // sees `true` is satisfied by a read that is stuck on `true` — the exact failure mode the
    // old form had. Collapsing one section here proves the read TRACKS the state, and the
    // re-expansion restores the pane for everything below.
    await trigger(SECTIONS.colourBy).click()
    await expect(trigger(SECTIONS.colourBy)).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger(SECTIONS.coordinates)).toHaveAttribute('aria-expanded', 'true')
    await trigger(SECTIONS.colourBy).click()
    await expect(trigger(SECTIONS.colourBy)).toHaveAttribute('aria-expanded', 'true')

    // The drag handle is a THUMB target. 44px is the minimum a touch surface can claim, and
    // the grip glyph is 16px — so this is a real property of the frame, not of the icon.
    const grip = page.getByTestId(handle(SECTIONS.coordinates))
    const box = await grip.boundingBox()
    expect(box, 'the section drag handle must be present in the sheet').toBeTruthy()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(box!.width).toBeGreaterThanOrEqual(44)

    // …and the sheet does not scroll SIDEWAYS. A pane that overflows horizontally on a
    // phone is unusable in a way that no vertical assertion catches.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'the page must not scroll horizontally at 390px').toBeLessThanOrEqual(1)
  })
})
