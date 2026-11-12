import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { singleSlotFormBackedAnalysis, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedArtifactOfType } from '../14-declarative-qc/_seed'

// TEST-306 (ITEM-23) + TEST-543 (ITEM-22) — the run pane, split by what each half can
// honestly prove.
//
// THE CORRECTION THIS FILE ENCODES. Round 11 un-gated this spec after measuring that it
// passed on a host with NO rootfs staged, and read that as "it needs no compute". It is the
// opposite signal: it passes without compute because all three of its assertions are
// satisfied by the CLICK's own synchronous state. `submit()` opens with
// `setRunState('running')` (`AnalysisRunPanel.tsx`) BEFORE the POST is awaited and before
// `onProgress` is subscribed; the console mounts on `runState === 'running'`, the log pane
// renders unconditionally with a "No output yet" branch (`RunProgressConsole.tsx`), and Stop
// renders on `canEdit && running`. Zero SSE frames are required for any of it. Meanwhile the
// frame-DEPENDENT testids (`workbench-run-timeline-*`, `-phase-*`, `-metric-*`, `-live-*`) had
// ZERO references anywhere in `src/` or `tests/`, so ITEM-22's live progress was asserted by
// nothing.
//
// The split below states what each half actually proves:
//   • the un-gated case keeps the click-synchronous coverage and is TITLED for it — a run
//     STARTS and an editor gets Stop. It is not evidence that any frame arrived.
//   • the gated case is the real ITEM-22 assertion: it awaits a phase PERCENTAGE, which
//     only a `progress` frame can supply and which therefore cannot exist unless one
//     crossed the real SSE transport. (Its first draft awaited a timeline and a log line
//     instead; both survived a mutant that deleted the `progress` and `log` handling — see
//     the block above that describe for the measurement and why the bar is the one that
//     discriminates. That draft would have been this same finding a second time.) It needs
//     a sandbox-executable host, so it is skipped — REPORTED, with its reason — where
//     compute is unavailable.
//
// ── WHY THE SUBJECT IS DERIVED, AND IS NO LONGER THE ONE THE LAUNCHER OFFERS ─────────────
//
// The run pane is the surface of an analysis that ships NO form of its own. Every
// launcher-visible analysis in the shipped tree DOES ship one, so since the manifest/UI
// separation each is configured and run from its OWN pane and `AnalysisRunPanel` refuses to
// synthesize a rival slot-only form for it (INV-4: that form is built from `appliesTo` alone
// and omits the inputs the view adds, so a Run from it completed with them unset and reported
// zeros). Driving this spec through the launcher would be driving a surface that no longer
// exists.
//
// The subject is therefore DERIVED from the live registry — the first analysis with no
// registered view and exactly one input slot (`singleSlotFormBackedAnalysis`), so the spec
// follows the shipped set rather than pinning today's packages. Such analyses are
// launcher-hidden by design (they are on-ingest converters) but registered and resolvable by
// id — proven by `14-declarative-qc/rehomed-converter.spec.ts` — so the pane is opened through
// the documented `window.__workbenchPanes.open('run', <id>)` seam that `RunPane.tsx`'s own
// header names as one of the pane's real doors.
//
// The seed is ONE artifact of that analysis' own declared input datatype, holding the committed
// upload fixture's bytes VERBATIM. That is the right shape for an on-ingest converter and not a
// "looks runnable, isn't" seeder: such a compute exists to read the raw uploaded container off
// its input slot — unlike a slot that expects a PRODUCED store, where opaque bytes are
// unreadable and the seed has to go through the real importer. It also drops the
// converter-capable-host requirement the previous seed imposed on the UNGATED describe, which
// was a real cost paid for a property that never needed it.

/** Seed one artifact of the derived subject's input datatype, open its run pane and bring it to
 *  the front — `open()` adds a pane without activating it (RegionShell keeps the region's
 *  current active tab) and only the active pane renders a body. Same two-step as
 *  `jobs-panel.spec.ts`. Returns the analysis id under test. */
async function openSeededRunPane(
  page: Page,
  request: APIRequestContext,
  projectId: string,
): Promise<string> {
  const subject = await singleSlotFormBackedAnalysis(page)
  await seedArtifactOfType(request, projectId, subject.inputDatatype, { realFixtureBytes: true })
  // Reload so the artifact catalog the form resolves candidates from sees the seeded artifact.
  await openWorkbench(page, projectId)
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
    subject.id,
  )
  expect(paneId, `opening a run pane for ${subject.id} returned no pane id`).toBeTruthy()
  const tab = page.getByTestId(`region-tab-${paneId}`)
  await tab.waitFor({ state: 'visible', timeout: 20_000 })
  await tab.click()
  await expect(page.getByTestId(`workbench-analysis-panel-${subject.id}`)).toBeVisible({
    timeout: 20_000,
  })
  return subject.id
}

test.describe('run pane — the run STARTS: live console + editor-only Stop (ITEM-23)', () => {
  test('clicking Run mounts the live console + log pane; Stop is present for an editor', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RunPane ${Date.now()}`)
    await openWorkbench(page, id)
    const analysisId = await openSeededRunPane(page, request, id)

    const runBtn = page.getByTestId(`workbench-analysis-run-${analysisId}`)
    await expect(
      runBtn,
      'Run must be ENABLED — the sole seeded artifact of the input datatype is auto-picked, so a ' +
        'disabled button means the input never resolved',
    ).toBeEnabled({ timeout: 20_000 })
    await runBtn.click()

    // These three are CLICK-SYNCHRONOUS (see the header) — they prove the run was
    // submitted without throwing, and nothing about the progress stream.
    const consoleEl = page.getByTestId(`workbench-run-console-${analysisId}`)
    await expect(consoleEl).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`workbench-run-logs-${analysisId}`)).toBeVisible()
    // Stop is editor-only (a viewer never sees it — see viewer-readonly.spec.ts).
    await expect(page.getByTestId(`workbench-run-stop-${analysisId}`)).toBeVisible()
  })
})

// WHY THE ASSERTION BELOW IS A PROGRESS BAR AND NOT "a timeline appeared" OR "a log line
// appeared" — both of those were WRITTEN FIRST, both passed, and both were then MEASURED
// against a mutant that dropped `progress` and `log` frames in `AnalysisRunPanel.onFrame`.
// The mutant run stayed 2/2 green. The reasons, which are the reason this comment exists:
//
//   • the TIMELINE is not progress-specific. `onFrame`'s fall-through turns any
//     non-terminal `status` frame into a timeline phase, and the jobs SSE emits
//     `status{status:"running"}` on every job. So a row appears with the whole `progress`
//     family deleted.
//   • the LOG PANE is not stream-specific. `finishTerminal` back-fills it from the
//     `ApiClient.Jobs.logs` SCROLLBACK on completion, which converges to the same visible
//     text whether or not a single `log` frame was ever delivered.
//
// What ONLY a `progress` frame can produce is a `pct`: `mapSseFrame`'s `status` arm carries
// no pct field at all (`jobFrames.ts`), and `workbench-run-phase-bar-*` renders only for a
// phase whose `pct != null` (`RunProgressConsole.tsx`). So the BAR is the discriminator,
// and it is durable — a later phase marks this one done but never clears its pct.
test.describe('run pane — LIVE SSE progress reaches the surface (ITEM-22)', () => {
  // HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (bwrap + a staged analysis rootfs):
  // a real job must run for real `progress` frames to exist at all. Reported as skipped
  // with its reason on a host without it.
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a running job streams real `progress` frames — a phase carries a percentage', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RunPaneLive ${Date.now()}`)
    await openWorkbench(page, id)
    const analysisId = await openSeededRunPane(page, request, id)

    const runBtn = page.getByTestId(`workbench-analysis-run-${analysisId}`)
    await expect(runBtn).toBeEnabled({ timeout: 20_000 })
    await runBtn.click()

    // THE DISCRIMINATOR: a phase row rendering a PERCENTAGE. Only a `progress` frame
    // carries `pct`, so this bar cannot exist unless one crossed the real SSE transport.
    const bar = page.locator('[data-testid^="workbench-run-phase-bar-"]').first()
    const runError = page.getByTestId(`workbench-run-error-${analysisId}`)

    // Race it against a run failure so an unavailable sandbox fails LOUDLY with its cause
    // instead of timing out on a locator (a skip is not a pass, and neither is an
    // unexplained timeout). The wait is 75s, comfortably UNDER the config's 120s test
    // timeout: at 120s the whole test would die of timeout before either the loud
    // sandbox-unavailable error or the assertion message below could be printed, so the
    // one run that most needs a diagnosis would produce none. A real run reaches the
    // first `progress` frame in seconds.
    await Promise.race([
      bar.waitFor({ state: 'visible', timeout: 75_000 }).catch(() => {}),
      runError.waitFor({ state: 'visible', timeout: 75_000 }).catch(() => {}),
    ])
    if (await runError.isVisible().catch(() => false)) {
      throw new Error(
        `analysis run FAILED before any progress frame: "${await runError.innerText()}" — the ` +
          'compute sandbox is unavailable on this host (no PID namespace / CAP_SYS_ADMIN / no ' +
          'rootfs). Run this spec on a sandbox-executable host with TXR_E2E_REAL_COMPUTE=1.',
      )
    }

    await expect(
      bar,
      'no phase carries a percentage — the run produced no `progress` frame, or the frame ' +
        'never reached the panel. A timeline ALONE does not prove this: a `status` frame ' +
        'makes one too (see the block above this describe).',
    ).toBeVisible({ timeout: 5_000 })
    // …and it renders a real percentage, not an empty shell.
    await expect(bar).toHaveText(/\d+%/)

    // The timeline row that owns the bar is named by the PRODUCER's phase, and the console
    // is out of its pre-frame placeholder state.
    await expect(page.getByTestId(`workbench-run-timeline-${analysisId}`)).toBeVisible()
    const live = page.getByTestId(`workbench-run-live-${analysisId}`)
    await expect(live).toBeVisible()
    await expect(live).not.toHaveText('queued')

    // NOT A DISCRIMINATOR, asserted anyway because the surface must fill by SOME path:
    // `finishTerminal` back-fills the log pane from the `Jobs.logs` scrollback, so this
    // holds with every streamed `log` frame dropped. The streamed path is discriminated
    // in `AnalysisRunPanel.liveProgress.test.tsx`, which drives log frames with no
    // scrollback available.
    const logs = page.getByTestId(`workbench-run-logs-${analysisId}`)
    await expect(logs).not.toContainText('No output yet', { timeout: 30_000 })
  })
})
