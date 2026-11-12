import { expect, test, type Request } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { seedArtifactOfType } from '../14-declarative-qc/_seed'
import { singleSlotFormBackedAnalysis } from './_analysis'

// binding-origin — the chain, driven through the REAL app in a REAL browser.
//
// ── why this observes the SUBMITTED LAUNCH rather than a finished run ─────────────────────
//
// The obvious shape for "a run launched on an unreviewed binding is observably different" is
// to launch two runs and read the provenance rows back. That needs a sandbox-executable host
// (bwrap + a rootfs), which this suite gates behind `TXR_E2E_REAL_COMPUTE`, and a gated spec
// that self-skips is a SKIP — not a pass, and not a proof of anything.
//
// So the invariant is proven where it is reachable without one: the request the browser
// actually PUTS ON THE WIRE. That is the last point the frontend owns, it is the whole FE
// chain (control → view store → declared `inputs:` → `run_processor` → `resolveInputs` →
// `RunInput` → `jobsCapability`), and it is not a mock — the payload is observed with
// `page.on('request')` while the real POST goes to the real backend. The SERVER half of the
// same invariant is proven by TEST-23/TEST-24, which run against a real database and a real
// export.
//
// `page.route()` is deliberately NOT used anywhere here: the suite's own rule is to drive the
// real backend, and a mocked response would make the spec pass with the backend removed.

/** Capture the `POST /api/jobs` bodies the page sends, in order. */
function captureJobSubmissions(page: import('@playwright/test').Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', (req: Request) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/jobs')) return
    try {
      const body = req.postDataJSON() as Record<string, unknown> | null
      if (body) bodies.push(body)
    } catch {
      // A non-JSON POST to the jobs route is not this spec's subject; ignoring it here keeps
      // the listener from throwing inside Playwright's event loop.
    }
  })
  return bodies
}

/** The `inputs[]` of a captured submission — the flat `AnalysisSpec` lives under `params`. */
function submittedInputs(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const params = (body.params ?? {}) as Record<string, unknown>
  return (params.inputs ?? []) as Array<Record<string, unknown>>
}

test.describe('binding origin travels the whole chain (TEST-28)', () => {
  /** Seed ONE artifact of the subject's input datatype and open its run pane, front. Mirrors
   *  `run-pane.spec.ts::openSeededRunPane` — one slot, one seeded artifact, so the fallback
   *  form auto-picks it and Run enables without a sandbox. */
  async function openSeededRunPane(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    projectId: string,
  ): Promise<string> {
    const subject = await singleSlotFormBackedAnalysis(page)
    await seedArtifactOfType(request, projectId, subject.inputDatatype, { realFixtureBytes: true })
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
    const tab = page.getByTestId(`region-tab-${paneId}`)
    await tab.waitFor({ state: 'visible', timeout: 20_000 })
    await tab.click()
    await expect(page.getByTestId(`workbench-analysis-panel-${subject.id}`)).toBeVisible({
      timeout: 20_000,
    })
    return subject.id
  }

  test('TEST-28 [acceptance] [invariant: INV-1] the mark on screen and the mark on the wire are the same fact', async ({
    page,
    request,
  }) => {
    // INV-1: *"it travels wherever the value travels."*
    //
    // The subject is the FALLBACK-FORM path (site 3), which is the better one anyway: it is
    // the mount-effect auto-pick that had no UI at all before this change, and after which
    // `runGate` reported the form READY — so a run launched on a binding nobody looked at.
    // One input slot, one seeded artifact of its datatype: the auto-pick fires and Run enables
    // with no sandbox, which is what makes this an OBSERVED end-to-end pass rather than a
    // `TXR_E2E_REAL_COMPUTE` self-skip dressed up as one.
    await loginAsOwner(page)
    const projectId = await createProject(request, `Origin Chain ${Date.now()}`)
    await openWorkbench(page, projectId)

    const submissions = captureJobSubmissions(page)
    const analysisId = await openSeededRunPane(page, request, projectId)

    // Leg 1 — the CONTROL says the system bound it. This is the site whose auto-bind was
    // previously invisible, so the mark existing here at all is the fix.
    // The fallback form's mark is `<field-testid>-origin-mark`; the wrapper beside it carries
    // `data-binding-origin`. Addressed by the ATTRIBUTE rather than by guessing the field id,
    // because the subject analysis is derived from the live registry — a spec that spelled the
    // id would assert a fact about one package instead of the contract.
    const mark = page.locator('[data-binding-origin="auto"]').first()
    await expect(mark).toBeVisible({ timeout: 30_000 })

    // Leg 2 — the LAUNCH carries the same fact, on the wire.
    const run = page.getByTestId(`workbench-analysis-run-${analysisId}`)
    await expect(run).toBeEnabled({ timeout: 30_000 })
    await run.click()

    await expect
      .poll(() => submissions.length, { timeout: 30_000, message: 'the launch reached the wire' })
      .toBeGreaterThan(0)

    const inputs = submittedInputs(submissions[0])
    expect(inputs.length).toBeGreaterThan(0)
    // If ANY layer dropped it — the auto-pick's report, the panel's origin map, `buildInputs`,
    // or the serializer — this key is simply absent, and no per-layer unit test would notice.
    expect(inputs.some(i => i.bound_by === 'auto')).toBe(true)
    // …and it rides BESIDE the binding: the artifact the run consumes is unchanged, which is
    // what makes the origin additive rather than a behaviour change.
    for (const i of inputs) expect(i.artifact_ref).toBeTruthy()
  })

  test('TEST-27 a REVIEWED binding launches differently from an unreviewed one', async ({
    page,
    request,
  }) => {
    // The reviewed half. Same analysis, same artifact — the user re-picks the value the mount
    // effect chose, which is the review (INV-5) — and the launch must stop claiming it was
    // guessed. Re-picking the SAME value is the case no bag diff can see, which is exactly why
    // it is the one driven here.
    await loginAsOwner(page)
    const projectId = await createProject(request, `Origin Reviewed ${Date.now()}`)
    await openWorkbench(page, projectId)

    const submissions = captureJobSubmissions(page)
    const analysisId = await openSeededRunPane(page, request, projectId)

    // The auto-picked state, asserted first — the positive control that makes the flip below
    // mean something.
    await expect(page.locator('[data-binding-origin="auto"]').first()).toBeVisible({ timeout: 30_000 })

    // The control INSIDE the marked wrapper — reached through the mark rather than by
    // spelling a field id, because the subject analysis is derived from the live registry.
    const picker = page
      .locator('[data-binding-origin="auto"]')
      .locator('[data-testid^="schemaform-field-"]')
      .first()
    await picker.click()
    // The SAME option that was auto-picked. Re-picking the value already in the slot is the
    // review (INV-5), and it is the case no bag diff can see — which is why it is the gesture
    // driven here rather than a change to some other value.
    await page.getByRole('option').first().click()

    // The mark is GONE — the same value, now chosen.
    await expect(page.locator('[data-binding-origin="auto"]')).toHaveCount(0, { timeout: 30_000 })

    const run = page.getByTestId(`workbench-analysis-run-${analysisId}`)
    await expect(run).toBeEnabled({ timeout: 30_000 })
    await run.click()

    await expect
      .poll(() => submissions.length, { timeout: 30_000, message: 'the launch reached the wire' })
      .toBeGreaterThan(0)

    const inputs = submittedInputs(submissions[0])
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.some(i => i.bound_by === 'auto')).toBe(false)
    expect(inputs.some(i => i.bound_by === 'user')).toBe(true)
  })
})

// TEST-29 (the pane anchor, site 4) lives in `15-visualize/binding-origin-anchor.spec.ts`.
//
// Not a preference: THIS suite's fixture publishes no row space at all — the anchor renders
// `data-anchor-control="none"` against it — so an anchor assertion here would be testing the
// seed rather than the control. The visualize suite is the one whose fixture anchors a pane,
// and a test belongs with the fixture that can actually reach its subject.
