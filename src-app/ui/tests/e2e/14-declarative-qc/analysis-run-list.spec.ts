// The per-analysis run list, end to end (analysis-run-feedback.md part 2, acceptance 1–3).
//
// The unit tier covers WHICH runs the list selects and in what order. It cannot cover the thing
// this work exists for: that a run you launched appears beside the form without a reload, and
// that clicking it opens the detail for THAT run. Both are wiring — a live poll, a pane route —
// and wiring is exactly what a pure test cannot see.
//
// WHY TWO RUNS. With one run in the project, an implementation that opened "the newest job", or
// "the only job", or simply "the jobs pane" is indistinguishable from one that opens the run that
// was clicked. So this launches twice and clicks the OLDER entry: only a correct implementation
// passes, and the assertion is on the detail's own `data-job-id` rather than its header, which
// renders the analysis title and is therefore identical for both runs.
//
// The second launch also exercises the duplicate guard from the other side: an identical
// resubmission is refused, so the metric set is CHANGED between runs — which is precisely the
// case the guard is required to permit.
//
// IT ALSO OWNS THE STICKY-TOAST INVARIANTS, because this is the surface where they were
// measured. A finished run raises the sticky job ack (DEC-16) bottom-right, over this very list.
// The ack is allowed to be permanent; it is not allowed to be a trap. Two things are proven with
// the ack on screen: a MOUSE click still reaches the row underneath it, and the ack can be
// dismissed without unmounting the pane the user was reading. The unit tier
// (`src/modules/workbench/core/shell/jobToast.test.tsx`) pins the mechanism; only a real browser
// can hit-test, so the outcome is proven here.

import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import {
  addPresetMetric,
  RUN_ANALYSIS_ID,
  RUN_CONTROL,
  awaitQcSurface,
  seedRunnableExpression,
  runQcToCompletion,
} from './_seed'

/** The analysis whose pane carries the list — read from the run helper rather than repeated, so
 *  the spec and the helper cannot come to disagree about which analysis this is. */
const ANALYSIS_ID = RUN_ANALYSIS_ID

test.describe('per-analysis run list (analysis-run-feedback part 2 · real compute)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a launched run appears beside its form, and opens ITS OWN detail @acceptance', async ({
    page,
    request,
  }) => {
    // Two real sandbox runs plus their waits; the per-test default cannot cover it.
    test.setTimeout(480_000)

    await loginAsOwner(page)
    const id = await createProject(request, `RunList ${Date.now()}`)
    await seedRunnableExpression(request, id, 'RunList matrix')
    await openWorkbench(page, id)

    // ── before anything has run, the list says so rather than rendering blank ──────────
    await awaitQcSurface(page)
    const list = page.getByTestId(`analysis-runs-${ANALYSIS_ID}`)
    await expect(list, 'the analysis pane carries a run list').toBeVisible({ timeout: 20_000 })
    await expect(
      page.getByTestId(`analysis-runs-${ANALYSIS_ID}-empty`),
      'an analysis that has never run says so — an empty region with no sentence is the ' +
        'illegible state this list exists to remove',
    ).toBeVisible()

    // ── first run ─────────────────────────────────────────────────────────────────────
    await runQcToCompletion(page)
    await awaitQcSurface(page)

    const rows = page.locator('[data-testid^="analysis-run-"]')
    // NO RELOAD anywhere in this spec: the list is fed by the job poll the shell already runs,
    // so a run appearing here is the live path working.
    await expect(rows, 'the finished run appears in its analysis pane').toHaveCount(1, {
      timeout: 60_000,
    })
    const firstId = (await rows.first().getAttribute('data-testid'))?.replace('analysis-run-', '')
    expect(firstId, 'the row identifies its job').toBeTruthy()

    // ── second run, with a CHANGED metric set ─────────────────────────────────────────
    // Identical resubmission is refused by the duplicate guard (part 3) — correctly. Adding a
    // metric makes this a different run, which the guard must allow, and gives the list a second
    // entry so the click-through below can be about a specific one.
    //
    // Completion is observed through THE RUN LIST, not through the success toast.
    //
    // Two runs of ONE analysis produce the SAME toast text, and the shared run helper dismisses
    // toasts between runs — so waiting on that text a second time asks a question about toast
    // identity, not about this list. Measured: a single run, and two runs of DIFFERENT
    // analyses, both complete and toast normally; only the second run of the SAME analysis fails
    // to be observed that way, while its outputs are ingested server-side every time. The list
    // gaining a row is the signal this spec is actually about, and it is the one the user reads.
    await addPresetMetric(page, 'pct_hb')
    const runBtn = page.getByTestId(RUN_CONTROL)
    await expect(runBtn, 'a CHANGED metric set is a different run — the guard must allow it').toBeEnabled({
      timeout: 20_000,
    })
    await runBtn.click()
    await expect(rows, 'both runs are listed once the second finishes').toHaveCount(2, {
      timeout: 180_000,
    })

    const ids = await rows.evaluateAll(els =>
      els.map(e => (e.getAttribute('data-testid') ?? '').replace('analysis-run-', '')),
    )
    const secondId = ids.find(i => i && i !== firstId)
    expect(secondId, 'the second run is listed under its own id').toBeTruthy()
    const older = page.locator(`[data-testid="analysis-run-${firstId}"]`)
    const newer = page.locator(`[data-testid="analysis-run-${secondId}"]`)
    const detail = page.getByTestId('workbench-jobs-detail')

    // ── the sticky job toast parks over this list — it must not eat the clicks ─────────
    //
    // Each terminal run raises the STICKY job toast (`statusBarJobsStore.fireJobToast`,
    // `duration: Infinity` — DEC-16), bottom-right, which is exactly where this run list is.
    // A sticky ack is the decision; a sticky *click-blocker* was not, and that is what shipped:
    // the toast intercepted every pointer event over its footprint for as long as it lived,
    // which is forever, and its only exit was its own "View job" — an exit that navigates.
    //
    // Settle first: the run's own transient success toast shares the anchor, so wait until the
    // only toasts left are the job acks. Then "what is under the pointer" is unambiguous.
    const jobToasts = page.locator('[data-sonner-toast]').filter({ hasText: /finished/i })
    await expect(jobToasts.first(), 'the finished run raised its ack').toBeVisible({
      timeout: 60_000,
    })
    // Park the pointer away from the toast anchor before doing either of those things. The Run
    // control sits bottom-right, so after clicking it the pointer is left exactly where the acks
    // appear — and a hovered toaster both PAUSES every finite timer (so the transient toast never
    // expires; measured, it sat there for the full 60 s) and EXPANDS the stack, which moves the
    // toasts. Both would make the geometry below a coin flip.
    await page.mouse.move(8, 8)
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasNotText: /finished/i }),
      'the transient run toasts have expired, leaving only the sticky acks',
    ).toHaveCount(0, { timeout: 60_000 })
    const front = page.locator('[data-sonner-toast][data-front="true"]')
    await expect(front, 'exactly one toast is frontmost').toHaveCount(1)

    // ── the run you launched is ON SCREEN, with nothing scrolled ──────────────────────────
    //
    // This line used to be `await older.scrollIntoViewIfNeeded()`, and that scroll was a
    // WORKAROUND for a layout defect, not a gesture: the run list was the last child of the
    // form's own scroll container, so it sat wherever the form happened to end — and this form
    // grows, because metrics are rows a user adds. Measured then: the list started at y≈808 in
    // a 720-tall viewport once a second metric was added, i.e. the feedback for pressing Run was
    // off screen at the moment it was produced, with nothing saying to scroll.
    //
    // The pane is now two tracks — a scrolling form and a PINNED run band
    // (`DeclarativeRegion::DeclarativeStack`) — so the band is on screen at any form size. This
    // asserts that OUTCOME rather than performing the scroll that hid the defect. It is the
    // reason `page.mouse.click` below (raw coordinates, no auto-scroll) can address the row at
    // all.
    await expect(
      older,
      'the run this analysis launched must be readable WITHOUT scrolling — the pane pins its run ' +
        'band rather than letting the form push it off (this assertion replaced an explicit ' +
        '`scrollIntoViewIfNeeded`, which was a workaround for exactly that defect)',
    ).toBeInViewport({ ratio: 1 })

    // The PREMISE, asserted rather than assumed: the toast really does cover this row. If it
    // ever stops doing so the click below proves nothing, and this says so instead of passing.
    const toastBox = await front.boundingBox()
    const rowBox = await older.boundingBox()
    expect(toastBox, 'the sticky toast has a box').not.toBeNull()
    expect(rowBox, 'the older run row has a box').not.toBeNull()
    const x0 = Math.max(toastBox!.x, rowBox!.x)
    const x1 = Math.min(toastBox!.x + toastBox!.width, rowBox!.x + rowBox!.width)
    const y0 = Math.max(toastBox!.y, rowBox!.y)
    const y1 = Math.min(toastBox!.y + toastBox!.height, rowBox!.y + rowBox!.height)
    expect(
      Math.min(x1 - x0, y1 - y0),
      `the sticky toast (${JSON.stringify(toastBox)}) must overlap the run row ` +
        `(${JSON.stringify(rowBox)}) for the click-through below to mean anything`,
    ).toBeGreaterThan(4)

    // A point inside the overlap that is NOT on one of the toast's own controls — those are
    // meant to take the click. Scanned rather than guessed so the point stays valid if the
    // toast's internal layout changes.
    const controlBoxes = (
      await Promise.all((await front.locator('button').all()).map(b => b.boundingBox()))
    ).filter((b): b is NonNullable<typeof b> => b !== null)
    const onAControl = (x: number, y: number) =>
      controlBoxes.some(b => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)
    const py = (y0 + y1) / 2
    const px = [0.5, 0.35, 0.65, 0.2, 0.8]
      .map(f => x0 + (x1 - x0) * f)
      .find(x => !onAControl(x, py))
    expect(px, 'the overlap offers a point that is not one of the toast\'s own controls').toBeDefined()

    // What the browser says is under that point. Stated separately from the click so a failure
    // names the cause ("the toast") instead of only its symptom ("the detail never opened").
    const under = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y)
        if (!el) return 'nothing'
        if (el.closest('[data-sonner-toast]')) return 'the job toast'
        const owner = el.closest('[data-testid]')
        return owner ? `[data-testid="${owner.getAttribute('data-testid')}"]` : el.tagName
      },
      [px!, py] as [number, number],
    )
    expect(
      under,
      'a sticky ack must not own the pointer for its whole footprint — the content it happens ' +
        'to sit over stays clickable',
    ).not.toBe('the job toast')

    // ── the mouse path: click the OLDER entry THROUGH the toast, land on THAT run ──────
    await page.mouse.click(px!, py)
    await expect(detail, 'the click opened the existing job detail surface').toBeVisible({
      timeout: 30_000,
    })
    await expect(
      detail,
      'the detail shows the run that was CLICKED. Asserted on the job id, not the header: the ' +
        'header renders the analysis title, which is identical for every run of this analysis, ' +
        'so an implementation that always opened the newest run would pass a header assertion.',
    ).toHaveAttribute('data-job-id', String(firstId), { timeout: 30_000 })

    // ── getting rid of the ack must not cost the user their place ─────────────────────
    //
    // Back on the analysis pane. The ack is still there — clicking THROUGH it is not
    // dismissing it, and DEC-16 says nothing dismisses it on its own.
    await awaitQcSurface(page)
    await expect(list, 'the analysis pane is what the user is reading again').toBeVisible()
    const sticky = await jobToasts.count()
    expect(sticky, 'the ack survived being ignored and clicked through (DEC-16)').toBeGreaterThan(0)

    // The second exit. It must be a dismissal, not a navigation: after taking it the pane the
    // user was reading is still the pane they are reading. Before this fix the ONLY exit was
    // "View job", which reveals the Jobs pane and unmounts this one — measured: the rows then
    // did not exist at all.
    // Bounded deliberately. A control that is visible but not HITTABLE (the pass-through rule
    // applied and its control exception did not) makes `click` retry actionability until the
    // whole test budget is gone — measured at 15.5 minutes, reported as a timeout rather than as
    // "the close button cannot be clicked". Thirty seconds says the same thing in the same words.
    await front.getByRole('button', { name: /close/i }).click({ timeout: 30_000 })
    await expect(jobToasts, 'closing the ack removes it').toHaveCount(sticky - 1)
    await expect(
      list,
      'dismissing the ack must not navigate — the run list the user was reading is still mounted',
    ).toBeVisible()
    await expect(rows, '…with both of its rows').toHaveCount(2)

    // ── the keyboard path is a real affordance, and stays proven ──────────────────────
    //
    // The row is a semantic `<button>`, so focus + Enter is the gesture a keyboard user makes.
    // It is asserted on the OTHER run so this cannot pass by the detail simply still showing
    // what the mouse click above opened.
    await newer.press('Enter')
    await expect(detail, 'keyboard activation opens the job detail too').toBeVisible({
      timeout: 30_000,
    })
    await expect(
      detail,
      'the detail shows the run that was ACTIVATED — not the one the previous gesture opened',
    ).toHaveAttribute('data-job-id', String(secondId), { timeout: 30_000 })
  })
})
