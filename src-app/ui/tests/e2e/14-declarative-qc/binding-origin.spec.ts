import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { ARTIFACT_REF_ORIGIN_MARK, awaitQcSurface, seedProjectDataset } from './_seed'

// TEST-26 [acceptance] [invariant: INV-2] (binding-origin / ITEM-7, ITEM-15) — the mark is on
// SCREEN, in the real app, without a gesture.
//
// The invariant is *"An auto-bound value is never rendered as a chosen one. Every control that
// displays a binding displays its origin, WITHOUT HOVER."* A jsdom render test can assert the
// DOM carries the attribute; only a real browser can show that a person reading the form sees
// it, and that reading it needs no hover, focus, or click.
//
// The two arms are the whole point, and they are deliberately the SAME control on the SAME
// analysis:
//
//   ONE compatible artifact  → the declared `auto_bind_sole_candidate` fires, the control is a
//                              read-only summary, and it must say so.
//   TWO compatible artifacts → the auto-bind cannot fire (sole candidacy is the whole of its
//                              condition), the control is a picker, and after the user chooses
//                              one nothing on screen may claim the choice was made for them.
//
// A spec that only asserted the first arm would pass against a control that marked EVERY
// binding, which is worse than marking none — R8's own corollary is that markers stay rare or
// they stop being read.

test.describe('binding origin — the auto-bound mark is visible (TEST-26)', () => {
  test('ONE candidate: the control is auto-bound and SAYS SO, with no gesture', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Origin One ${Date.now()}`)
    await seedProjectDataset(request, id, `Only ${Date.now()}`)

    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // The sole-candidate arm renders the read-only summary rather than a picker.
    const summary = page.getByTestId('widget-matrixPicker-summary')
    await summary.waitFor({ state: 'visible', timeout: 30_000 })

    // The RECORDED fact, on the element that holds the value…
    await expect(summary).toHaveAttribute('data-binding-origin', 'auto', { timeout: 30_000 })

    // …and the same fact legible to a person. `toBeVisible` is what makes this a "without
    // hover" assertion: a `title` attribute or a tooltip-on-hover would not be visible here,
    // and that is the distinction between a marker and R8's disclaimer nobody sees again.
    const mark = page.getByTestId('widget-matrixPicker-origin')
    await expect(mark).toBeVisible({ timeout: 30_000 })
    // The SHIPPED string, imported — never a regex re-typed here. A hand-written twin passes
    // while the product says something else, which is the whole failure mode a copy table
    // exists to prevent. (This assertion was `/auto/i` and went red against the real app for
    // exactly that reason: the mark reads "Chosen for you".)
    await expect(mark).toHaveText(ARTIFACT_REF_ORIGIN_MARK)
  })

  test('TWO candidates: the user chooses, and NOTHING claims it was chosen for them', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Origin Two ${Date.now()}`)
    const dsA = await seedProjectDataset(request, id, `Aye ${Date.now()}`)
    await seedProjectDataset(request, id, `Bee ${Date.now()}`)

    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // With two candidates the auto-bind is refused, so this is a real picker.
    const picker = page.getByTestId('widget-matrixPicker-select')
    await picker.waitFor({ state: 'visible', timeout: 30_000 })
    await expect(page.getByTestId('widget-matrixPicker-summary')).toHaveCount(0)

    await picker.click()
    await page
      .getByTestId(`widget-matrixPicker-select-opt-${dsA.expression_artifact_id}`)
      .click({ timeout: 30_000 })

    // The SAME artifact that would have been auto-bound had it been alone — chosen this time.
    // Nothing on the surface marks it, because nothing about it was guessed.
    await expect(page.getByTestId('widget-matrixPicker-origin')).toHaveCount(0)
  })
})
