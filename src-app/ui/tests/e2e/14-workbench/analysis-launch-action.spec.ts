import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import {
  openLauncher,
  viewBackedAnalyses,
  focusAwayFrom,
  expectAnalysisPaneRevealed,
  runPaneTabs,
  type AnalysisSubject,
} from './_analysis'
import { seedExpressionArtifact } from './_seed'

// TEST-111 (PLAN.md ITEM-6 + ITEM-3) — one action, two surfaces. The Launcher row and
// the ⌘K entry each drive the SAME `runAction('analysis.launch')` against the active
// workbench instance, mutating the real `WorkbenchDock`/`WorkbenchRegions` stores.
// Proves the action vocabulary is the single execution path for every human affordance.
//
// The project is SEEDED with an input artifact: every launcher-visible analysis is
// availability-gated on its input datatype, so a fresh project has no enabled row (ITEM-16
// deleted the one input-free dogfood, `selection.demo`, with its package).
// (The former Surface 2 — a top-toolbar "+" — was removed with the TopToolbar in the
// RegionShell redesign; the region "+" adds a PANE KIND, not an analysis launch.)
//
// ── THE OBSERVABLE, amended for the manifest/UI separation (INV-3/INV-4) ─────────────────
//
// Both surfaces used to be checked by `run pane count == 1`. The analysis they launch ships its
// own form, so a launch of it opens no run pane at all: it REVEALS that analysis' own pane (and
// `AnalysisRunPanel` refuses to synthesize the rival slot-only form that made a run pane the
// old observable in the first place — that form omitted an input the view supplies, so a Run
// from it completed with the input unset). The shared observable is therefore the analysis' OWN
// pane becoming the active tab of its region, plus the continued absence of a run pane.
//
// Each surface is driven from a DEFINED starting point — a SIBLING available view made active
// first — so "the target is now the active tab" is a state the surface CHANGED, not one it
// inherited. Every contributed view declares the same region, so the available ones are tabs of
// one region and exactly one can be active; that is what makes the pre-step a real reset.
//
// Both the target and the sibling are DERIVED from the live registry rather than named, so this
// asserts the contract over whatever the tree ships (see the note in `_analysis.ts`), and the
// reveal observable + its reset step are the SHARED ones every launch-surface spec uses.

/** The reveal every `analysis.launch` entry point shares: the analysis' OWN pane is the active
 *  tab (the shared observable — see `_analysis.ts`), and no run pane was opened beside it. */
async function expectRevealed(page: Page, target: AnalysisSubject) {
  await expectAnalysisPaneRevealed(page, target)
  await expect(
    runPaneTabs(page),
    'an analysis that ships its own form gets no run pane from any entry point (INV-3)',
  ).toHaveCount(0)
}

/** The AVAILABLE view-backed analyses, POLLED.
 *
 *  Availability is derived from the project's produced datatypes, which the workbench FETCHES —
 *  so a read taken the instant the shell mounts legitimately sees an empty catalog and reports
 *  every analysis unavailable. Read once, this spec failed its own seed precondition ("Received:
 *  0") about one run in three, before touching its subject. Polling waits for the answer to
 *  arrive; it does not weaken it — the assertion below is still `>= 2`. */
async function availableViewBacked(page: Page): Promise<AnalysisSubject[]> {
  let available: AnalysisSubject[] = []
  await expect
    .poll(
      async () => {
        available = (await viewBackedAnalyses(page)).filter(a => a.available)
        return available.length
      },
      {
        timeout: 30_000,
        message:
          'the seed must make at least TWO analyses available — the second is the sibling this ' +
          'test focuses first, and without it "the target is active" could be true before the ' +
          'launch. (A zero here after 30 s is a seed that did not take, not a slow catalog.)',
      },
    )
    .toBeGreaterThanOrEqual(2)
  return available
}

test.describe('analysis.launch — one action, two surfaces (ITEM-6)', () => {
  test('the Launcher row and the ⌘K entry each reveal the analysis own pane via runAction("analysis.launch")', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Launch3 ${Date.now()}`)
    await seedExpressionArtifact(request, id)

    // ── Surface 1 — the Launcher pane row (available now that the input datatype exists).
    await openWorkbench(page, id)
    const available = await availableViewBacked(page)
    const [target] = available

    await focusAwayFrom(page, target, available)
    await openLauncher(page)
    const row = page.getByTestId(`workbench-launcher-row-${target.id}`)
    await expect(row, 'the target must be AVAILABLE — seed its input datatype first').toBeEnabled({
      timeout: 20_000,
    })
    await row.click()
    await expectRevealed(page, target)

    // ── Surface 2 — the ⌘K command-palette entry (`analysis.launch`, offered
    //    against the active workbench instance — ITEM-3). The palette auto-supplies
    //    `view_id`, so the inline form only asks for the analysis id.
    //    A fresh navigation resets the dock, so the sibling is re-focused to restore the
    //    same defined starting point Surface 1 had.
    await openWorkbench(page, id)
    await focusAwayFrom(page, target, available)
    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeVisible()
    const paletteItem = page.getByTestId('command-palette-item-analysis.launch')
    await expect(paletteItem).toBeVisible()
    await paletteItem.click()
    const runBtn = page.getByTestId('command-palette-run')
    if (await runBtn.isVisible().catch(() => false)) {
      const analysisField = page.getByTestId('command-palette-param-analysis_id')
      if (await analysisField.isVisible().catch(() => false)) await analysisField.fill(target.id)
      await runBtn.click()
    }
    await expectRevealed(page, target)
  })
})
