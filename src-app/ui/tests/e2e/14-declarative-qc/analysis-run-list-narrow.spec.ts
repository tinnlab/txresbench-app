// The run band at a PHONE width — the other half of "a launched run is on screen".
//
// Below 768px the workbench is not the tiling dock at all: `WorkbenchShell` hands over to
// `MobileShell`, which hosts the same contributed panes inside bottom-bar Sheets. So the desktop
// spec's measurement says nothing here — it is a different host, with a different box chain
// above the pane, and the two-track pane only works if that chain gives the pane a BOUNDED
// height. Whether it does is exactly the sort of thing that is true by accident until someone
// measures it.
//
// One real run, not two: the claim is about where the feedback LANDS, and one run is enough to
// have some. The click-through, the ordering and the toast collision are the desktop spec's
// business and are not repeated.

import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import { awaitQcSurface, seedRunnableExpression, runQcToCompletion, RUN_ANALYSIS_ID } from './_seed'

/** A phone. Narrower than the 768px `useIsMobile` breakpoint, so this really is `MobileShell`
 *  and not a squeezed desktop dock. */
test.use({ viewport: { width: 390, height: 800 } })

test.describe('the run band at a phone width (real compute)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a launched run is on screen without scrolling on a phone @acceptance', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000)

    await loginAsOwner(page)
    const id = await createProject(request, `RunListNarrow ${Date.now()}`)
    await seedRunnableExpression(request, id, 'RunListNarrow matrix')
    await openWorkbench(page, id)

    // PRECONDITION: this is the mobile shell. Without it the test would silently become a second,
    // slower copy of the desktop one.
    await expect(
      page.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]'),
      'below 768px the workbench must be MobileShell — otherwise this measures the desktop dock',
    ).toBeVisible({ timeout: 30_000 })

    // Find the sheet that hosts the analysis pane. Which AREA a contributed control surface docks
    // into is a placement decision that has moved before, so this asks each sheet rather than
    // hard-coding one — a spec that named the area would go red for a re-placement, which is not
    // what it is about.
    //
    // The per-sheet probe is the SHARED `awaitQcSurface`, not a tab name typed here: the analysis'
    // own vocabulary belongs in `_seed.ts` (the one module measured for it), and a second spelling
    // is a second thing that can come to disagree with the view.
    let opened = false
    for (const area of ['right', 'bottom', 'left']) {
      await page.getByTestId(`workbench-mobile-open-${area}`).click()
      opened = await awaitQcSurface(page).then(
        () => true,
        () => false,
      )
      if (opened) break
      await page.keyboard.press('Escape')
    }
    expect(opened, 'no mobile sheet hosted the analysis pane').toBe(true)

    await runQcToCompletion(page)

    const list = page.getByTestId(`analysis-runs-${RUN_ANALYSIS_ID}`)
    const rows = page.locator('[data-testid^="analysis-run-"]')
    await expect(rows, 'the finished run reached the band').toHaveCount(1, { timeout: 60_000 })

    // PRECONDITION for the measurement, and the one that caught the mobile-shell half of this
    // defect. The form must be taller than its own TRACK — at 390px every control is stacked, so
    // it is. If the track reports no overflow, either the form shrank or the pane has no bounded
    // track at all, and the second is what `MobileShell` used to do: it hosted `PlacedArea` in a
    // BLOCK wrapper, so every `flex-1` under it was inert, the pane sized to its content and the
    // sheet scrolled the lot. A pane with no track cannot pin anything inside it.
    // The box CHAIN travels with the failure, because "the pane has no track" is a statement
    // about an ancestor and the assertion is on a descendant. Diagnosing it from the bare numbers
    // cost three runs; the chain names the offending box in one (it was
    // `workbench-area-tabs-right-panel-*`: bounded, `overflow-hidden`, and `display: block`, so
    // every `flex-1` beneath it was inert and 208px of the pane was clipped away).
    //
    // The track is FOUND, not named: it is the nearest y-scroll container at or above the form
    // column. The two were once the same element (`RegionBody` carried the width cap AND the
    // overflow, which is what drew the form's scrollbar in the middle of a wide pane); they are
    // now separate. Locating the track by its behaviour rather than by a testid keeps this
    // precondition about "the pane has a bounded track" through that change and the next one.
    const track = await page
      .getByTestId(`declarative-region-body-${RUN_ANALYSIS_ID}`)
      .evaluate(col => {
        let el: Element = col
        for (let p: Element | null = col; p; p = p.parentElement) {
          const oy = getComputedStyle(p).overflowY
          if (oy === 'auto' || oy === 'scroll') {
            el = p
            break
          }
        }
        const chain: string[] = []
        for (let p: Element | null = el; p; p = p.parentElement) {
          const cs = getComputedStyle(p)
          chain.push(
            `  ${p.tagName.toLowerCase()}[${p.getAttribute('data-testid') ?? ''}] ` +
              `h=${Math.round(p.getBoundingClientRect().height)} scrollH=${p.scrollHeight} ` +
              `display=${cs.display} flex=${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} ` +
              `minH=${cs.minHeight} overflowY=${cs.overflowY}`,
          )
          if (p.tagName === 'BODY') break
        }
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, chain }
      })
    expect(
      track.scrollHeight,
      `the form track reports no overflow (scrollHeight ${track.scrollHeight} of clientHeight ` +
        `${track.clientHeight}) — either the form fits, or the pane has no bounded track here and ` +
        `the whole pane is scrolling (or being clipped) further up. Box chain:\n${track.chain.join('\n')}`,
    ).toBeGreaterThan(track.clientHeight + 1)

    // THE CLAIM. Nothing is scrolled: the run the user just launched is simply there.
    await expect(
      list,
      'the run band must be on screen at a phone width — the pane pins it rather than letting ' +
        'the form push it off',
    ).toBeInViewport({ ratio: 1 })
    await expect(
      rows.first(),
      'and the run itself is readable, not merely the region that holds it',
    ).toBeInViewport({ ratio: 1 })
  })
})
