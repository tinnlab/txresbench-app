import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ownerToken } from '../project/_helpers'
import { BACKEND } from './_dock'
import { RUN_HELPER_HEADROOM_MS, runQcToCompletion } from '../14-declarative-qc/_seed'

// Shared helpers for the W3 analysis-experience artifact-flow e2e specs. They drive the
// REAL launch → run → review path through the workbench UI (no API mocking).
//
// The launcher fact these helpers encode (established behaviour, asserted elsewhere — do
// NOT "fix" it by relaxing a spec): every launcher-visible analysis is availability-gated
// on an input datatype, so a FRESH project has no enabled row. A spec that wants to launch
// one must SEED the project first (`_seed.ts`).
//
// ITEM-39 deleted `openAnalysisById` (launch a launcher-HIDDEN analysis BY ID through the
// real `analysis.launch` action). Its only subject was the `selection.demo` dogfood, which
// ITEM-16 deleted with its FE-code package; every remaining analysis is launcher-visible,
// so the helper had no reachable target left.
//
// ── WHAT A LAUNCH OPENS, since the manifest/UI separation (INV-3 / INV-4) ────────────────
//
// `analysis.launch` opens the analysis' OWN config surface, and WHICH surface that is depends
// on the analysis' DECLARATION:
//
//   • declares `ui:` (ships its own form) → its own contributed pane is REVEALED. No run pane
//     is opened, and `AnalysisRunPanel` refuses to synthesize a rival slot-only form for it
//     (`core/contributions/ownForm.ts` states why: the fallback form is built from `appliesTo`
//     alone, so it omits every input the view adds, and a Run from it dispatches with those
//     inputs UNSET — a job that COMPLETES and reports zeros).
//   • declares no `ui:` → a run pane opens with the slot-derived fallback form. That is the
//     only surface where `workbench-analysis-form-*` / `workbench-analysis-run-*` exist.
//
// EVERY analysis a person can reach from the launcher today ships its own form, so a
// launcher-driven helper never lands on a run pane and must never wait for
// `workbench-analysis-run-<id>`. The run-pane surface still ships and is still correct — its
// only remaining subjects are the launcher-HIDDEN on-ingest converters, reached by id through
// the documented `window.__workbenchPanes.open('run', <id>)` seam that `RunPane.tsx`'s own
// header names as one of the pane's real doors.
//
// ── PICK SUBJECTS FROM THE REGISTRY, NEVER BY NAME ───────────────────────────────────────
//
// `formBackedAnalyses` / `viewBackedAnalyses` below read the LIVE contribution catalog through
// the read-only `window.__workbenchRegistry` seam and split it on whether the analysis
// registered a view. Two reasons, and the second is the load-bearing one:
//
//   1. A spec that names a package id asserts a fact about THAT package; a spec that derives
//      one asserts the CONTRACT, and keeps asserting it when the shipped set changes.
//   2. The app surface must carry none of the contributed vocabulary, and the test tier is
//      held to the same ratchet (`scripts/lint-no-domain-in-builtin.mjs`). Deriving the
//      subject is what lets these specs state the routing rule without spelling out the
//      packages it happens to route today.
//
// The split keys on REGISTRATION, which is the only thing observable from a browser, while the
// production predicate keys on the DECLARATION (`analysisOwnsItsForm`). The two agree for any
// package that loads; they part only for a package that DECLARES a view it cannot load, which
// is a load-error state no spec here stages.

/** HOST-CAPABILITY gate for the specs that need a run to genuinely COMPLETE (a
 *  sandbox-executable backend: bwrap + `CYTO_ENV_ROOTFS_DIR`). Run them with
 *  `CYTO_E2E_REAL_COMPUTE=1` on a rootfs-wired host.
 *
 *  USE IT AS `test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)` — as the first statement inside
 *  the spec's `test.describe` body (or at file level for a spec with no describe). NEVER as
 *  a module-level `if (REAL_COMPUTE) { … }` wrapper.
 *
 *  This comment used to say the opposite ("the gated specs simply do not REGISTER … never a
 *  self-disabling `test.skip` masquerading as a pass"), and 14 specs followed it. That rule
 *  is Rust libtest's, where an `eprintln! + return` really does print `ok`; under Playwright
 *  it is exactly backwards, and `playwright.config.ts` (R3-114) had already written down why:
 *  a conditional skip is REPORTED as skipped, with its reason, and is never counted as
 *  passed, whereas removing a test from COLLECTION makes its absence invisible. Measured
 *  here: `npx playwright test --list` gave **220 tests / 154 files** by default vs **237 /
 *  169** with `CYTO_E2E_REAL_COMPUTE=1 CYTO_E2E_MULTIMODAL=1`, and the only invocation that
 *  sets either (`just verify-acceptance`) also passes `--grep @acceptance`, which none of
 *  these specs carry — so 16 of those 17 tests were unreachable by ANY invocation, silently.
 *
 *  A describe-level skip is collected unconditionally (both `--list` totals now match), is
 *  reported as `-` + a `{type:'skip', description}` annotation, and — unlike a skip in the
 *  test BODY — short-circuits before `beforeEach`, so a capability-less host pays nothing. */
export const REAL_COMPUTE = !!process.env.CYTO_E2E_REAL_COMPUTE

/** Reason paired with {@link REAL_COMPUTE}. It names the env var that enables the spec, so a
 *  skipped run tells the reader exactly what to set rather than just vanishing. */
export const REAL_COMPUTE_SKIP =
  'needs a sandbox-executable host (bwrap + CYTO_ENV_ROOTFS_DIR) — set CYTO_E2E_REAL_COMPUTE=1 to run'

/** One analysis, as the live registry describes it. */
export interface AnalysisSubject {
  id: string
  /** the pane/tab title its contributed view carries (the analysis' own title). */
  title: string
  /** the datatype of its ONE input slot, when it has exactly one. */
  inputDatatype?: string
  /** whether its inputs are satisfiable by the project's current catalog. */
  available: boolean
}

/** Read the live contribution catalog + the registered view ids through the read-only seams.
 *  `owns === true` selects analyses that ship their OWN form. Ordered by id, so a spec that
 *  takes `[0]` / `[1]` gets a stable subject. */
async function analysisSubjects(page: Page, owns: boolean): Promise<AnalysisSubject[]> {
  await page.waitForFunction(
    () => !!(window as { __workbenchRegistry?: unknown }).__workbenchRegistry,
    undefined,
    { timeout: 20_000 },
  )
  return page.evaluate(wantsOwnForm => {
    const reg = (
      window as unknown as {
        __workbenchRegistry: {
          views: () => string[]
          catalog: () => {
            entries: {
              id: string
              title: string
              appliesTo: { type_id?: string; subtypes_of?: string }[]
              available: boolean
            }[]
          }
        }
      }
    ).__workbenchRegistry
    const withOwnForm = new Set(reg.views())
    return reg
      .catalog()
      .entries.filter(e => withOwnForm.has(e.id) === wantsOwnForm)
      .map(e => {
        const slots = e.appliesTo ?? []
        const only = slots.length === 1 ? slots[0] : undefined
        return {
          id: e.id,
          title: e.title,
          inputDatatype: only?.type_id ?? only?.subtypes_of,
          available: e.available,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }, owns)
}

/** Analyses that ship their OWN form (`ui:` declared and registered) — a launch REVEALS the
 *  analysis' own pane for each of these. Fails loudly if the tree ships none. */
export async function viewBackedAnalyses(page: Page): Promise<AnalysisSubject[]> {
  const subjects = await analysisSubjects(page, true)
  expect(
    subjects.length,
    'the tree must ship at least one analysis with its own form for the reveal contract to have a subject',
  ).toBeGreaterThan(0)
  return subjects
}

/** Analyses that ship NO form of their own — the run pane's slot-derived fallback form is the
 *  intended surface for each of these. Fails loudly if the tree ships none, because a spec
 *  about that surface would then be asserting nothing. */
export async function formBackedAnalyses(page: Page): Promise<AnalysisSubject[]> {
  const subjects = await analysisSubjects(page, false)
  expect(
    subjects.length,
    'the tree must ship at least one analysis WITHOUT its own form — the run pane fallback form ' +
      'is the surface under test and it would otherwise have no subject',
  ).toBeGreaterThan(0)
  return subjects
}

/** The first form-backed analysis with exactly ONE input slot — the simplest runnable subject
 *  (one slot ⇒ one seeded artifact ⇒ the fallback form auto-picks it and Run enables). */
export async function singleSlotFormBackedAnalysis(page: Page): Promise<Required<AnalysisSubject>> {
  const subject = (await formBackedAnalyses(page)).find(a => a.inputDatatype)
  expect(
    subject,
    'no form-backed analysis declares exactly one input slot — a multi-slot subject needs one ' +
      'seeded artifact per slot, which this helper deliberately does not guess at',
  ).toBeTruthy()
  return subject as Required<AnalysisSubject>
}

// ── WHAT "a launch OPENED the analysis' surface" IS OBSERVED AS ─────────────────────────────
//
// It is the analysis' own pane being the ACTIVE tab of its region — never a pane COUNT.
//
// `analysis.launch` performs the same IDEMPOTENT open every other affordance performs
// (`WorkbenchSection.tsx`: "focus the pane where it actually LIVES … and add one only if the user
// had dismissed it"), and a declarative analysis' view pane is auto-mounted by the view reconcile
// (`paneReconcile.ts`), so the pane is almost always ALREADY OPEN when a launch arrives. Counting
// panes therefore asserted "a pane was ADDED", which the product deliberately does not do — two
// specs asserted exactly that and had never passed. What a user gets is the surface in front of
// them, and that is what these two helpers assert.
//
// Non-vacuity is the caller's job and {@link focusAwayFrom} is how it is met: "the target is the
// active tab" must be a state the launch CHANGED, not one it inherited.

/** The region tab for a pane titled `title` (a contributed view pane carries its analysis' own
 *  clean title — `paneModel.paneTitle`). */
export function paneTabByTitle(page: Page, title: string) {
  return page.getByRole('tab', { name: title, exact: true }).first()
}

/**
 * The open RUN panes, counted by their TABS — `Run · <analysisId>` (`paneModel.paneTitle`).
 *
 * NEVER by `[data-testid^="workbench-run-pane"]`, which sits on the pane's BODY: a region renders
 * only its ACTIVE tab, so a run pane that exists but is not in front counts as ZERO. That makes
 * "…and no run pane was opened" pass for the wrong reason (it holds the instant anything else is
 * active) and "…and the run pane is still there" FAIL for the wrong reason — both observed. A tab
 * is rendered for every pane in the region.
 *
 * `analysisId` omitted ⇒ every run pane; supplied ⇒ that analysis' one run pane (INV-3).
 */
export function runPaneTabs(page: Page, analysisId?: string) {
  return analysisId
    ? page.getByRole('tab', { name: `Run · ${analysisId}`, exact: true })
    : page.getByRole('tab', { name: /^Run · / })
}

/**
 * Guarantee `target`'s own pane is NOT the active tab, so a subsequent reveal of it is observable
 * as a change. If it already is active, activate one of `siblings` instead (every contributed view
 * declares the same region, so the available ones are tabs of ONE region and exactly one can be
 * active — which is what makes this a real reset). Fails loudly if there is no sibling to move to,
 * because then nothing downstream can distinguish a reveal from the status quo.
 *
 * The sibling must be AVAILABLE. A view pane auto-mounts only for an analysis whose declared
 * inputs the project has produced (`viewAutomountGate.ts`), so an unavailable sibling has no tab
 * to click and this would hang on it for 20 s and then fail somewhere else. Filtering here keeps
 * the failure at the honest place: "there is no sibling pane open to move to".
 */
export async function focusAwayFrom(
  page: Page,
  target: AnalysisSubject,
  siblings: readonly AnalysisSubject[],
): Promise<void> {
  const targetTab = paneTabByTitle(page, target.title)
  await targetTab.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await targetTab.getAttribute('aria-selected')) !== 'true') return
  const other = siblings.find(s => s.id !== target.id && s.available)
  expect(
    other,
    `"${target.title}" is already the active tab and no sibling view pane is open to move to — ` +
      'a reveal of it could not be told apart from the state it was already in',
  ).toBeTruthy()
  const otherTab = paneTabByTitle(page, (other as AnalysisSubject).title)
  await otherTab.click()
  await expect(otherTab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(targetTab).toHaveAttribute('aria-selected', 'false')
}

/** The reveal every `analysis.launch` entry point shares: the analysis' OWN pane is now the ACTIVE
 *  tab of its region. Pair with {@link focusAwayFrom} so it is a change, not the status quo.
 *
 *  The "…and no run pane exists" half is asserted at the call sites that can make that claim — a
 *  spec that deliberately opened a run pane itself (run-config) cannot. */
export async function expectAnalysisPaneRevealed(page: Page, target: AnalysisSubject): Promise<void> {
  await expect(
    paneTabByTitle(page, target.title),
    `the launch must reveal "${target.title}" — its own pane becomes its region's active tab`,
  ).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
}

/** Make the launcher pane's rows visible (a seeded project auto-mounts every available
 *  contributed view as a sibling pane, so activate the launcher tab if present), then wait
 *  for its rows to render. */
export async function openLauncher(page: Page): Promise<void> {
  const tab = page.getByTestId('region-tab-p-launcher').first()
  // WAIT for the tab rather than probing once. The launcher pane is a default pane and is there
  // immediately, but the sibling analysis panes that steal the region's active slot arrive LATE
  // now (the auto-mount gate keys on the project's produced type ids, which come from the catalog
  // fetch), so a one-shot click can land BEFORE they mount and be undone by them. Waiting for the
  // tab is not enough on its own — the row wait below is what actually re-drives it, so the click
  // is repeated until the rows are up.
  await tab.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await tab.count()) await tab.click().catch(() => {})
    const row = page.locator('[data-testid^="workbench-launcher-row-"]').first()
    if (await row.isVisible().catch(() => false)) return
    await page.waitForTimeout(500)
  }
  await page
    .locator('[data-testid^="workbench-launcher-row-"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
}

// `launchAvailable` (open the launcher, click the first AVAILABLE row, return its id) was
// DELETED with the launch-routing port, for the same reason `openAnalysisById` was: it had no
// reachable target left for what its one caller wanted. It existed so a spec could reach the
// run pane's fallback form without naming an analysis — and since the manifest/UI separation
// the first available row NEVER opens that form, because every launcher-visible analysis ships
// one of its own. A spec that wants the fallback form now derives a form-backed subject
// (`formBackedAnalyses`), and one that wants the reveal drives a NAMED row so it can assert
// WHICH pane the launch landed on. Neither is served by "whichever row is first".

/** Every artifact the project holds. Shape-tolerant: some list endpoints answer a bare array,
 *  some an `{items}` envelope, and the two have both been seen in this suite. */
async function projectArtifacts(
  request: APIRequestContext,
  projectId: string,
): Promise<{ id: string; datatype: string; run_id?: string | null }[]> {
  const token = await ownerToken(request)
  const r = await request.get(`${BACKEND}/api/projects/${projectId}/artifacts`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(r.ok(), `list artifacts -> ${r.status()}: ${await r.text()}`).toBeTruthy()
  const body = (await r.json()) as
    | { id: string; datatype: string; run_id?: string | null }[]
    | { items?: { id: string; datatype: string; run_id?: string | null }[] }
  return Array.isArray(body) ? body : (body.items ?? [])
}

/** The distinct `run_id`s already present in the project — the BASELINE a fresh run is
 *  detected against. A project seeded through the real importer already carries one (the
 *  on-ingest converter's own run), so "the newest artifact" is not a safe way to name the run
 *  under test; the DIFF is. */
async function runIdsInProject(
  request: APIRequestContext,
  projectId: string,
): Promise<Set<string>> {
  const rows = await projectArtifacts(request, projectId)
  return new Set(rows.map(a => a.run_id).filter((r): r is string => !!r))
}

/**
 * Open the multi-output ARTIFACT REVIEW for `runId` and wait for it to paint.
 *
 * The review has three hosts (`ArtifactReview`'s own callers): the run pane, the `run::<runId>`
 * ARTIFACT pane, and the `/artifacts/:kind/:runId` route. The run-pane host is unreachable for a
 * `ui:`-declaring analysis (see the routing note at the top of this file), so these helpers use
 * the artifact-pane host — the same one the Provenance pane's run node opens
 * (`ProvenancePane.onOpenNode` → `revealPane('artifact', runArtifactRef(runId))`). It renders the
 * FULL review: the per-kind cards, the chaining chips, the lineage, and the re-run + delete
 * actions. The only prop the run pane supplies that this host does not is `producedByAnalysisId`,
 * which excludes the PRODUCING analysis from the chaining candidates — so a caller asserting on
 * chaining must name the chip it expects rather than taking the first one.
 *
 * `open()` ADDS the pane without activating it (RegionShell keeps the region's current active
 * tab) and only the active pane's body renders, so its tab is clicked — the same two-step
 * `jobs-panel.spec.ts` performs.
 */
async function openRunArtifactReview(page: Page, runId: string): Promise<string> {
  const paneId = await openArtifactPane(page, `run::${runId}`)
  await expect(page.locator('[data-testid^="workbench-artifact-review"]').first()).toBeVisible({
    timeout: 30_000,
  })
  return paneId
}

/** Open an `artifact` pane on `ref` and bring it to the front; returns its pane id.
 *  `ref` is either `run::<runId>` (the multi-output review) or `<datatype>::<artifactId>`
 *  (a single artifact, which the pane BINDS itself to so it self-closes if that artifact is
 *  deleted). `open()` adds without activating, and only the active pane renders a body. */
export async function openArtifactPane(page: Page, ref: string): Promise<string> {
  await page.waitForFunction(
    () => !!(window as { __workbenchPanes?: unknown }).__workbenchPanes,
    undefined,
    { timeout: 20_000 },
  )
  const paneId = await page.evaluate(
    r =>
      (
        window as unknown as { __workbenchPanes: { open: (k: string, r?: string) => string } }
      ).__workbenchPanes.open('artifact', r),
    ref,
  )
  expect(paneId, `opening the "${ref}" artifact pane returned no pane id`).toBeTruthy()
  const tab = page.getByTestId(`region-tab-${paneId}`)
  await tab.waitFor({ state: 'visible', timeout: 20_000 })
  await tab.click()
  return paneId
}

/** The artifact a run's REVIEW treats as primary — i.e. the one its Delete affordance targets.
 *  `ArtifactReview` lists `{project_id, run_id}` and sorts by `output_id` then `id`
 *  (`sortRunArtifacts`); this reproduces that ordering off the same endpoint, so a spec can
 *  bind a pane to exactly the artifact the button will delete instead of guessing. */
export async function primaryRunArtifact(
  request: APIRequestContext,
  projectId: string,
  runId: string,
): Promise<{ id: string; datatype: string }> {
  const token = await ownerToken(request)
  const r = await request.get(
    `${BACKEND}/api/projects/${projectId}/artifacts?run_id=${encodeURIComponent(runId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  expect(r.ok(), `list run artifacts -> ${r.status()}: ${await r.text()}`).toBeTruthy()
  const body = (await r.json()) as
    | { id: string; datatype: string; output_id: string }[]
    | { items?: { id: string; datatype: string; output_id: string }[] }
  const rows = Array.isArray(body) ? body : (body.items ?? [])
  expect(rows.length, `run ${runId} produced no artifacts`).toBeGreaterThan(0)
  const sorted = [...rows].sort(
    (a, b) => a.output_id.localeCompare(b.output_id) || a.id.localeCompare(b.id),
  )
  return { id: sorted[0].id, datatype: sorted[0].datatype }
}

/**
 * Run the seeded analysis to completion and leave its multi-output ARTIFACT REVIEW on screen.
 *
 * REQUIRES a project seeded with a REAL runnable input (`_seed.ts::seedRunnableMatrix`) AND a
 * sandbox-executable host — every caller is therefore behind {@link REAL_COMPUTE}. Fails LOUDLY
 * on a run error (a skip is not a pass). Returns the analysis id, the run it produced, and the
 * review pane's id (a caller that opens a second pane needs the review's own tab to come back).
 *
 * ── WHAT CHANGED, and why it is not a selector swap ──────────────────────────────────────
 *
 * This used to click the launcher row and then `workbench-analysis-run-<id>` — the run pane's
 * Run button — and read the review out of that same pane. Neither exists for the analysis it
 * drives any more: it ships its own form, so the launcher click reveals that form's pane and
 * `AnalysisRunPanel` refuses to build a rival one (INV-4). The helper therefore drives the
 * analysis' OWN form (the same declared `run_processor` → `wait_for` bridge
 * `14-declarative-qc/declarative-processor-ui.spec.ts` drives) and opens the review through its
 * OTHER host, keyed on the run the job actually produced.
 *
 * The run is named by DIFFING the project's artifact `run_id`s against a baseline taken before
 * the run, rather than by mapping a job id to a run id — the artifacts state their own run, and
 * a project seeded through the real importer already contains a different one.
 */
export interface RunToReviewResult {
  /** the analysis that ran. */
  analysisId: string
  /** the run its job produced — the key `ArtifactReview` and the artifact route both take. */
  runId: string
  /** the pane the review is mounted in. */
  reviewPaneId: string
}

export async function runToReview(
  page: Page,
  request: APIRequestContext,
  projectId: string,
  timeout = 120_000,
): Promise<RunToReviewResult> {
  // The config's per-test budget is 120 s and this helper WAITS `timeout` for the run on top
  // of ~75 s of preceding element waits, so before this line each of its nine callers died of
  // TEST timeout before the loud run-failure throw below could print. Granted additively
  // (`test.info().timeout + …`) so a caller that already raised its own budget keeps it, and
  // so the number lives with the wait it pays for rather than being copied nine times.
  test.setTimeout(test.info().timeout + timeout + RUN_HELPER_HEADROOM_MS)
  const before = await runIdsInProject(request, projectId)

  // The run itself, through the analysis' own declared form. Fails loudly on a run error, and
  // reports WHICH analysis it drove so this helper never has to name it.
  const analysisId = await runQcToCompletion(page, timeout)

  // The run the job produced — the one `run_id` the project did not have before.
  let runId = ''
  await expect
    .poll(
      async () => {
        const rows = await projectArtifacts(request, projectId)
        const fresh = rows.find(a => a.run_id && !before.has(a.run_id))
        if (fresh?.run_id) runId = fresh.run_id
        return runId
      },
      {
        timeout: 60_000,
        message:
          'the completed run produced no artifact carrying a NEW run_id — the declared bridge ' +
          'reported success, so either the run emitted nothing or its outputs were not ' +
          'catalogued against a run',
      },
    )
    .not.toBe('')

  const reviewPaneId = await openRunArtifactReview(page, runId)
  return { analysisId, runId, reviewPaneId }
}
