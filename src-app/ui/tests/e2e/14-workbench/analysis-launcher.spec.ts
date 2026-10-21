import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { openLauncher, viewBackedAnalyses, type AnalysisSubject } from './_analysis'
import { seedExpressionArtifact } from './_seed'

// TEST-302 (ITEM-20 + ITEM-28) — the analysis Launcher pane: registered analyses are
// grouped by category, searchable, and availability-gated (LISTED-and-explained, never
// hidden — hiding is reserved for converters + `launchable:false` demos, ITEM-16, which
// `14-declarative-qc/launcher-cleanup.spec.ts` owns).
//
// Split in two, because on an EMPTY project EVERY launcher-visible analysis is
// availability-gated (its required input datatype does not exist yet), so there is no
// enabled row to launch until the project has data:
//   • the gated half asserts the disabled `needs-type` row + badge + search on a fresh project;
//   • the launchable half seeds an input artifact so two rows become AVAILABLE and each
//     launches via `runAction('analysis.launch')`, while a row whose input is still missing
//     stays listed-but-gated.
//
// ── WHAT A LAUNCH OPENS (amended for the manifest/UI separation, INV-3/INV-4) ────────────
//
// The second test used to assert `run pane count == 1` after clicking a row. That is no longer
// what a launch does for an analysis that ships its own form, and asserting it was pinning the
// defect the separation removed: the run pane's fallback form — synthesized from `appliesTo`
// alone — omits every input such a view adds, and a Run from that rival form dispatched with
// them UNSET, which the compute reads as an empty match set. A COMPLETED run reporting zeros,
// from the launcher's own button. `analysis.launch` therefore REVEALS the analysis' own pane,
// and the observable is that pane becoming the active tab of its region — plus no run pane.
//
// BOTH ARMS are asserted, because one arm cannot distinguish "routed to the right pane" from
// "routed nowhere and the pane happened to be showing": every contributed view declares the
// same region (`DECLARATIVE_VIEW_AREA`), so the available ones are sibling tabs of ONE region
// and exactly one can be active. The test drives the launcher for each in turn and requires the
// ACTIVE tab to follow the row that was clicked. A third arm covers the case where the pane is
// not merely unfocused but CLOSED: launching must ADD it back, which is the only branch that
// exercises the `requestAddPane` half of the reveal.
//
// The third arm asserts the pane's RETURN and not its focus, deliberately. Adding a pane
// changes the dock's pane map, which re-runs the view reconcile, and that pass re-asserts
// `moveToRegion` for EVERY mounted view pane — and `moveToRegion` also sets its region's active
// pane. Which sibling is active after that is decided by the reconcile's iteration order, not
// by the launch, so asserting focus there would be asserting something the launch does not own.
// The first two arms add no pane at all (the target is already mounted, so the reveal is a
// pure `setActive`), which is why focus IS the right observable there.
//
// The two subjects are DERIVED from the live registry (`viewBackedAnalyses`) rather than named,
// so this asserts the routing CONTRACT over whatever the tree ships — see the note in
// `_analysis.ts` for the mechanism and the second reason it matters.

function runPanes(page: Page) {
  return page.locator('[data-testid^="workbench-run-pane"]')
}

/** A contributed view's pane tab(s), by the title it declares. `RegionShell` gives each tab an
 *  explicit `aria-label` of exactly that title, so this matches the tab and nothing else. */
function paneTab(page: Page, title: string) {
  return page.getByRole('tab', { name: title, exact: true })
}

/** Click a launcher row and assert it REVEALED that analysis' own pane: the pane's tab is the
 *  active one in its region, and NO run pane was opened beside it. */
async function launchAndExpectRevealed(page: Page, subject: AnalysisSubject): Promise<void> {
  await openLauncher(page)
  await page.getByTestId(`workbench-launcher-row-${subject.id}`).click()
  await expect(
    paneTab(page, subject.title).first(),
    `launching ${subject.id} must reveal its OWN pane ("${subject.title}") — it ships a form`,
  ).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(
    runPanes(page),
    'an analysis that ships its own form must not also get a run pane (INV-3 — one analysis, one pane)',
  ).toHaveCount(0)
}

test.describe('analysis launcher — grouped, searchable, availability-gated (ITEM-20/28)', () => {
  test('an empty project lists disabled needs-<type> rows and filters by search', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Launcher ${Date.now()}`)
    await openWorkbench(page, id)
    await openLauncher(page)

    // Every row on an empty project is availability-gated on an input datatype it lacks →
    // DISABLED, still listed (needs-<type>), with a badge.
    const row = page.locator('[data-testid^="workbench-launcher-row-"]').first()
    await expect(row).toBeVisible()
    await expect(row).toBeDisabled()
    await expect(row).toHaveAttribute('data-availability', 'needs-type')
    const rowId = ((await row.getAttribute('data-testid')) ?? '').replace(
      'workbench-launcher-row-',
      '',
    )
    await expect(page.getByTestId(`workbench-launcher-badge-${rowId}`)).toBeVisible()

    // Search filters the list; a non-matching query yields the no-matches state.
    const search = page.getByTestId('workbench-launcher-search')
    await search.fill('zzzznotarealanalysis')
    await expect(page.getByTestId('workbench-launcher-no-matches')).toBeVisible()
    await search.fill('') // clear → rows return
    await expect(row).toBeVisible()

    // …and the same box survives being TYPED IN, which the two `fill()`s above cannot tell you.
    // `fill` sets the value in one shot on an element it focuses itself, so it is blind to a
    // field that is destroyed and rebuilt BETWEEN keystrokes — which is exactly what the kit
    // `Input` used to do at this boundary (`value === ''` ⇄ `value !== ''` swapped its root
    // element from <input> to a wrapping <div>, so React remounted it). The user-visible cost
    // was: type one letter, lose the caret, re-click to continue. It was reported from the app
    // while this spec was green.
    //
    // `page.keyboard.type` (not `locator.pressSequentially`, which re-focuses first) delivers
    // the keys to WHATEVER is focused, so "typing continues" is a real assertion here.
    await search.click()
    await page.keyboard.type('z') // exactly ONE character — the transition that used to break
    await expect(search, 'the first keystroke must not cost the field its focus').toBeFocused()
    await page.keyboard.type('zznotarealanalysis') // continues, with no second click
    await expect(search).toHaveValue('zzznotarealanalysis')
    await expect(page.getByTestId('workbench-launcher-no-matches')).toBeVisible()

    // The mirror transition: emptying the box by keyboard must leave the caret in it.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await expect(search).toHaveValue('')
    await expect(search, 'clearing the query must not cost the field its focus either').toBeFocused()
    await expect(row).toBeVisible()
  })

  test('once its input datatype exists the row becomes available and reveals the analysis own pane', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `LauncherSeeded ${Date.now()}`)
    await seedExpressionArtifact(request, id)
    await openWorkbench(page, id)
    await openLauncher(page)

    // The subjects the seed made available, and one it did not (the list-and-explain contract's
    // non-vacuous negative control). Both sets come from the live registry.
    const subjects = await viewBackedAnalyses(page)
    const available = subjects.filter(a => a.available)
    const gated = subjects.filter(a => !a.available)
    expect(
      available.length,
      'the seed must make at least TWO analyses available — one arm cannot tell a correct route ' +
        'from a route that always lands on the same pane',
    ).toBeGreaterThanOrEqual(2)
    expect(
      gated.length,
      'at least one analysis must stay availability-gated, or the list-and-explain assertion below is vacuous',
    ).toBeGreaterThan(0)

    for (const subject of available) {
      const row = page.getByTestId(`workbench-launcher-row-${subject.id}`)
      await expect(row).toHaveAttribute('data-availability', 'available')
      await expect(row).toBeEnabled()
    }
    // …while an analysis whose input is still missing stays LISTED but gated.
    const gatedRow = page.getByTestId(`workbench-launcher-row-${gated[0].id}`)
    await expect(gatedRow).toBeVisible()
    await expect(gatedRow).toHaveAttribute('data-availability', 'needs-type')

    // ── ARMS 1 + 2: each available row reveals ITS OWN analysis' pane, and opens no run pane.
    //    Driving both is what makes this "the reveal follows the row" rather than "some pane is
    //    showing": they are sibling tabs of one region, so only one can be active at a time.
    for (const subject of available.slice(0, 2)) {
      await launchAndExpectRevealed(page, subject)
    }

    // ── ARM 3: with the pane CLOSED, a launch ADDS it back. This is the only arm that
    //    exercises the reveal's `requestAddPane` branch; the two above only re-focus a pane
    //    the view reconcile had already mounted, so on their own they cannot tell a real
    //    reveal from a no-op. Closing a contributed-view pane records a DISMISSAL
    //    (`RegionShell` → `dismissView`), which suppresses the reconcile's auto re-mount — so
    //    the pane's return can only be the launch's doing.
    const reopened = available[0]
    const tab = paneTab(page, reopened.title).first()
    const paneId = ((await tab.getAttribute('data-testid')) ?? '').replace('region-tab-', '')
    expect(paneId, 'the pane tab carries its pane id').toBeTruthy()
    await tab.hover() // the close X is opacity-0 until the tab is hovered
    await page.getByTestId(`region-tab-close-${paneId}`).click()
    await expect(paneTab(page, reopened.title)).toHaveCount(0, { timeout: 20_000 })

    await openLauncher(page)
    await page.getByTestId(`workbench-launcher-row-${reopened.id}`).click()
    await expect(
      paneTab(page, reopened.title),
      'launching a DISMISSED analysis must add its own pane back — the reveal falls through to ' +
        '`requestAddPane` when the user had closed it',
    ).toHaveCount(1, { timeout: 20_000 })
    await expect(
      runPanes(page),
      'and it must still be the analysis OWN pane, never a run pane (INV-3)',
    ).toHaveCount(0)
  })
})
