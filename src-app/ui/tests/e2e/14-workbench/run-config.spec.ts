import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import {
  formBackedAnalyses,
  viewBackedAnalyses,
  expectAnalysisPaneRevealed,
  runPaneTabs,
} from './_analysis'

// TEST-304 (ITEM-21) — the run CONFIG surface. Opening a FORM-BACKED analysis renders the
// `SchemaForm`, the inputs→produces summary, and a Run button (editor). (Auto-pick of a sole
// artifact is covered by the unit test `inputEconomy.test.ts`; here we assert the config
// surface is composed.)
//
// ── WHY THE SUBJECT CHANGED, and why it is not a selector swap ───────────────────────────
//
// This used to click the first AVAILABLE launcher row (a shared helper, now deleted) on a seeded
// project. Every launcher-visible analysis in the shipped tree ships its OWN form, so that row
// is always a view-backed one, and the surface it opened was the run pane's fallback form
// standing BESIDE the analysis' own. That form is synthesized from `appliesTo` ALONE, which is
// an applicability fact and not an input list: it omits every input the view adds, so a Run
// from it dispatched with those inputs UNSET — the compute reads a missing optional input as
// an empty match set, so the job COMPLETES and reports zeros. Asserting that the form was
// composed was therefore asserting that the rival existed.
//
// The PROPERTY survives untouched — it is about the run pane's generic form, which is still the
// intended and correct surface for an analysis that ships NO view (the design keeps "no `ui:`"
// as an explicit declared state). What had to change is the SUBJECT: it must now be an analysis
// with no view of its own. Both subjects are DERIVED from the live registry rather than named,
// so this spec follows the shipped set instead of pinning today's packages — see the note in
// `_analysis.ts` for the mechanism and the second reason it matters.
//
// The form-backed ones are launcher-HIDDEN by design (they are on-ingest converters), but
// registered and resolvable by id — proven by `14-declarative-qc/rehomed-converter.spec.ts`.
// They are reached through the documented `window.__workbenchPanes.open('run', <id>)` seam that
// `RunPane.tsx`'s own header names as one of the pane's real doors, and that
// `jobs-panel.spec.ts` / `preview-compare.spec.ts` / `provenance-negative-perm.spec.ts` already
// use for the same reason.
//
// BOTH ARMS are asserted. A test that only shows the form for a form-backed analysis cannot
// tell "the panel renders the right form for the right analysis" from "the panel renders that
// form for everything", which is exactly the state this branch removed. The second test drives
// the SAME pane kind, through the SAME seam, for an analysis that ships its own form and
// requires the opposite: no form, no summary, no Run, and a signpost to where it is really
// configured.
//
// NEITHER arm seeds an artifact, deliberately: the form, the summary and the Run button are all
// composed from the analysis' DECLARATION, so a candidate-less project is enough to assert the
// surface exists — and the assertion is `toBeVisible`, never `toBeEnabled` (Run disables while
// an input is unset, which is a different property, covered where a run is actually started).

/** Open a RUN pane for `analysisId` through the programmatic pane seam and bring it to the
 *  front (`open()` adds without activating, and only the active pane renders a body). */
async function openRunPane(page: Page, analysisId: string): Promise<void> {
  await page.waitForFunction(
    () => !!(window as { __workbenchPanes?: unknown }).__workbenchPanes,
    undefined,
    { timeout: 20_000 },
  )
  const paneId = await page.evaluate(
    id =>
      (
        window as unknown as { __workbenchPanes: { open: (k: string, r?: string) => string } }
      ).__workbenchPanes.open('run', id),
    analysisId,
  )
  expect(paneId, `opening a run pane for ${analysisId} returned no pane id`).toBeTruthy()
  const tab = page.getByTestId(`region-tab-${paneId}`)
  await tab.waitFor({ state: 'visible', timeout: 20_000 })
  await tab.click()
}

test.describe('run config — SchemaForm + io summary + Run (ITEM-21)', () => {
  test('a FORM-backed analysis renders the params form, the produces summary, and Run (editor)', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RunConfig ${Date.now()}`)
    await openWorkbench(page, id)
    const subject = (await formBackedAnalyses(page))[0]
    await openRunPane(page, subject.id)

    // The run pane mounted with the analysis panel (form + Run).
    const panel = page.getByTestId(`workbench-analysis-panel-${subject.id}`)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByTestId(`workbench-analysis-form-${subject.id}`)).toBeVisible()
    // The inputs→produces summary is present.
    await expect(panel.getByTestId(`workbench-analysis-io-${subject.id}`)).toBeVisible()
    // The editor sees Run (a viewer would not — see viewer-readonly.spec.ts).
    await expect(panel.getByTestId(`workbench-analysis-run-${subject.id}`)).toBeVisible()
  })

  test('an analysis that ships its own form gets NO rival one in the run pane — only a signpost', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RunConfigOwn ${Date.now()}`)
    await openWorkbench(page, id)
    const viewBacked = await viewBackedAnalyses(page)
    const subject = viewBacked[0]
    // The same pane kind, through the same seam. A run pane can still be REACHED for such an
    // analysis (a layout persisted before the routing existed, or this seam) — it just may not
    // offer to run it, which is what the panel gates at its construction site.
    await openRunPane(page, subject.id)

    const panel = page.getByTestId(`workbench-analysis-panel-${subject.id}`)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    // No rival form, no summary, no Run: the three things the arm above asserts are each ABSENT.
    await expect(panel.getByTestId(`workbench-analysis-form-${subject.id}`)).toHaveCount(0)
    await expect(panel.getByTestId(`workbench-analysis-io-${subject.id}`)).toHaveCount(0)
    await expect(panel.getByTestId(`workbench-analysis-run-${subject.id}`)).toHaveCount(0)
    // …and the pane says WHERE the analysis is configured rather than rendering nothing.
    await expect(panel.getByTestId(`workbench-analysis-own-form-${subject.id}`)).toBeVisible()

    // The signpost's affordance goes through the one `analysis.launch` action every other
    // affordance uses, so it REVEALS the analysis' own pane: that pane becomes its region's
    // active tab. (The routing's landing surface is asserted in full by
    // `analysis-launcher.spec.ts`, which can read the revealed pane's own body; here the project
    // has no data, so that pane's declared widgets are not a stable subject.)
    //
    // The precondition this asserts has changed TWICE, and both readings were true when written.
    // Originally it polled for the pane COUNT to grow by one and could not pass: the view reconcile
    // auto-mounted EVERY declarative analysis' pane on every project, so the target was already
    // open before the signpost was clicked, and `analysis.launch` is idempotent
    // (`WorkbenchSection.tsx`) — it FOCUSED that pane rather than adding a second. It was then
    // rewritten to "the target's tab exists but is not active", the run pane above supplying the
    // reset.
    //
    // The auto-mount gate (`viewAutomountGate.ts`) is what changed it again: this project seeds
    // NOTHING (see the header — deliberately), so the target analysis' inputs are not satisfiable
    // and its pane is NOT auto-mounted. There is no tab at all, which is a STRONGER precondition
    // than an unselected one — the reveal below is now the `requestAddPane` branch, i.e. a launch
    // that genuinely ADDS the pane rather than only focusing it.
    await expect(
      page.getByRole('tab', { name: subject.title, exact: true }),
      `"${subject.title}"'s own pane must not be open yet — this project seeds no artifact, so ` +
        'the auto-mount gate withholds it, and the reveal below is what has to open it',
    ).toHaveCount(0)
    await panel.getByTestId(`workbench-analysis-reveal-own-form-${subject.id}`).click()
    await expectAnalysisPaneRevealed(page, subject)
    // …and it is not a second run pane (INV-3 — one analysis, one pane). Counted by TAB: the run
    // pane's own body is unmounted the moment the reveal above takes the region, so a body count
    // reads 0 here and would report the correct outcome as a regression.
    await expect(
      runPaneTabs(page, subject.id),
      'the reveal must not have added a SECOND run pane for the same analysis (INV-3)',
    ).toHaveCount(1)
  })
})
