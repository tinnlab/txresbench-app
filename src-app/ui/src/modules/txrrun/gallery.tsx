/**
 * txrrun dev-gallery surfaces (PROV-UI-RUN-6, ITEM-12) — the module's ten
 * stories, one seeded surface per board state, all fed by the mock cassette
 * over the synthetic `fixtures.ts` (INV-6: every value is fixture data; the
 * boards' example facts never enter code or data).
 *
 * - `txr-run-e` / `txr-run-e-narrow-390` — the E screen with the validated
 *   fixture file pair seeded into the intake store (the provider's OWN
 *   inspect/validate builders — this module never re-validates) and the
 *   shared list fed by the `txrlist` cassette: the slot lines, the four
 *   settings rows, the group chips, the rows' board bytes and the
 *   estimate-driven bottom bar.
 * - `txr-run-e-empty` — no snapshot: the empty state names the missing
 *   input with "Start a new analysis" (DEC-16).
 * - `txr-run-e-error` — the eligibility failure: the list's error surface
 *   with the Retry button (the story extends the eligibility responder to
 *   fail — the page's real hook path).
 * - `txr-run-f` — the live screen: the SSE frame script walks `direct-on`
 *   waiting → downloading → running → finished, appends the log lines and
 *   lights the results affordance — no navigation (EXAMPLE-UI-RUN-2).
 * - `txr-run-f-working` — the mid-run mix: one row per engine state (every
 *   per-state action visible).
 * - `txr-run-f-finished` — the terminal snapshot: all rows finished, the
 *   stream's terminal status latches the replay.
 * - `txr-run-f-failed` — the failure pair's reasons + Show log.
 * - `txr-run-f-narrow-390` / `txr-run-f-not-found` — the 390 px layout and
 *   the not-found state.
 *
 * Since app-shell ITEM-2 the E/F screens are FRAME pages (fixed top, ONE
 * region, pinned bar) whose only real host is the shell, so the story's
 * layout byte lives on the `txr-shell-route-*` surfaces (same page,
 * `AppShell` host — the route spec drives the audit's legs over them);
 * these story surfaces keep the page without the shell so the CONTENT walk
 * (rows, toggles, states) stays measured against the page alone.
 *
 * Mock wiring (the registered keys' ONE-owner rule):
 *
 * - `Txr.getRun` / `Txr.listRunLogs` are owned by `txrresults`' cassette, so
 *   the F stories EXTEND them at mount (the `txrintake` B story's
 *   `extendCassette` precedent), answering the fixture run table first and
 *   DELEGATING every other id to the txrresults fixture tables — a sibling
 *   story's data is never disturbed by this module's extension.
 * - `Txr.streamRun` is a `specialRoute` — the mock engine's first-match
 *   contract: this module's route tests the FIXTURE RUN IDS only, and the
 *   dev gallery's gather orders it before the path-family owner's route
 *   (see `src/dev/gallery/main.tsx`); ids this module does not own fall
 *   through to the path-family route unchanged, so the sibling stories
 *   replay their own frame scripts.
 * - The run-control mutations answer through the module's own cassette and
 *   RECORD the request into the story seam (`txr-run-request-seam`) — the
 *   e2e asserts what was posted without ever probing a component.
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  extendCassette,
  jsonResponse,
  setSseCassette,
  sseReplayResponse,
  type MockRequestContext,
  type ModuleGallery,
  type SpecialRoute,
} from '@txresbench/gallery'
import { TxrIntake } from '@/modules/txrintake'
import { AppShell } from '../txrshell/components/AppShell'
import { TXR_LOGS, TXR_RUNS } from '../txrresults/fixtures'
import { ChooseMethodsPage } from './pages/ChooseMethodsPage'
import { RunningPage } from './pages/RunningPage'
import {
  TXRRUN_APP_CONFIG,
  TXRRUN_KEEP_COPIES,
  TXRRUN_LOGS,
  TXRRUN_RUN_DETAILS,
  TXRRUN_RUN_F,
  TXRRUN_STREAM_RUN_IDS,
  txrrunMethodDetail,
  txrrunSmallEligibility,
  txrrunSmallMethods,
  txrrunOnRequest,
  txrrunRecordRequest,
  txrrunRecheckEligibility,
  txrrunRequestLogLine,
  txrrunRunSummary,
  txrrunSeedValidatedIntake,
  txrrunStreamFrames,
} from './fixtures'

// ── the story hosts (the seeding gate + the observation seams) ──────────────

/**
 * The seeding gate: the story's mock wiring and store seed are applied in
 * the host's mount effect BEFORE the real page mounts (the page's own mount
 * effect fires the requests that must land on the seeded answers). The
 * gallery's `PreloadGate` runs a surface's `setup` AFTER the component's
 * mount effects — child effects fire first — so the real page is rendered
 * only once this host's seeding has committed.
 */
function SeedGate({ seed, children }: { seed: () => void; children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const seedRef = useRef(seed)
  seedRef.current = seed
  useEffect(() => {
    seedRef.current()
    setReady(true)
  }, [])
  return ready ? <>{children}</> : null
}

/** The E screen's story view: the seeded intake + the real page. */
function EStoryView() {
  return (
    <SeedGate seed={txrrunSeedValidatedIntake}>
        <ChooseMethodsPage />
      </SeedGate>
  )
}

/** The E screen at the board's mobile width. */
function ENarrowStoryView() {
  return (
    <section style={{ width: 390, maxWidth: '100%', minWidth: 0 }}>
      <SeedGate seed={txrrunSeedValidatedIntake}>
        <ChooseMethodsPage />
      </SeedGate>
    </section>
  )
}

/** The E empty story: the store at its birth state (no snapshot). */
function EEmptyStoryView() {
  return (
    <SeedGate seed={() => TxrIntake.reset()}>
        <ChooseMethodsPage />
      </SeedGate>
  )
}

/**
 * The E failure story: the eligibility responder fails (the page's real row
 * hooks' error path — the shared list's error line + Retry). The extension
 * is session-scoped, like the provider's own preview-story extension; the
 * failing branch never touches the sibling stories' eligibility answers.
 */
function seedEligibilityFailure(): void {
  TxrIntake.reset()
  txrrunSeedValidatedIntake()
  extendCassette({
    'MethodCatalogue.eligibility': () => {
      throw new Error('fixture eligibility failure')
    },
  })
}

/** The E error story: the list's failure state + Retry. */
function EErrorStoryView() {
  return (
    <SeedGate seed={seedEligibilityFailure}>
        <ChooseMethodsPage />
      </SeedGate>
  )
}

/**
 * The request-log seam: the cassette responders' one line — the e2e reads
 * what was posted (never probes a component), the `txr-list-run-result`
 * precedent. Subscribes to the log so a recorded request re-paints.
 */
function RequestSeam() {
  const [, paint] = useState(0)
  useEffect(() => txrrunOnRequest(() => paint(n => n + 1)), [])
  return (
    <pre
      data-testid="txr-run-request-seam"
      style={{ margin: 8, fontSize: 11, color: 'var(--txr-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >
      {txrrunRequestLogLine()}
    </pre>
  )
}

/**
 * The F story's seeding: the extended run-detail / logs tables (with the
 * txrresults delegation) + the frame script for this story's run id. The
 * page mounts only after the extension committed (SeedGate below).
 */
function seedRunStory(runId: string): void {
  extendCassette({
    'Txr.getRun': (ctx: MockRequestContext) =>
      TXRRUN_RUN_DETAILS[ctx.params.id] ?? TXR_RUNS[ctx.params.id],
    'Txr.listRunLogs': (ctx: MockRequestContext) =>
      TXRRUN_LOGS[ctx.params.id] ?? TXR_LOGS[ctx.params.id] ?? { lines: [], next_seq: 0, total: 0 },
  })
  setSseCassette(txrrunStreamFrames(runId))
}

/** The F story's frame: the real page + the request seam, at a width. */
function FStoryView({ runId, narrow = false }: { runId: string; narrow?: boolean }) {
  return (
    <section style={narrow ? { width: 390, maxWidth: '100%', minWidth: 0 } : undefined}>
      <SeedGate seed={() => seedRunStory(runId)}>
        <RunningPage />
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

/** The app-shell ITEM-2 route story host: the real page INSIDE the real
 *  shell (the ITEM-2 layout byte — the same frame a clinician sees; the
 *  spec drives the audit section-4 legs over these surfaces). */
function ShellRouteView({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}

/**
 * The small-method E story's seed: the validated intake + a session-scoped
 * cassette extension that answers the catalogue, the eligibility and the
 * estimate with the SIX-method fixture set (ITEM-1's measured height test:
 * every method runs, so the page is short and the Run button is visible
 * without scrolling).
 */
function seedSmallMethods(): void {
  txrrunSeedValidatedIntake()
  extendCassette({
    'MethodCatalogue.list': { methods: txrrunSmallMethods(), total: 6 },
    'MethodCatalogue.eligibility': txrrunSmallEligibility,
    'MethodCatalogue.estimate': (ctx: { body?: unknown }) => {
      const ids = ((ctx.body ?? {}) as { method_ids?: string[] }).method_ids ?? []
      return {
        at_a_time: 3,
        cpus: 4,
        methods: ids.map(id => ({ id, estimated_seconds: 45, estimate_quality: 'measured' })),
        total_seconds: ids.length * 45,
        schedule_seconds: ids.length * 45,
      }
    },
  })
}

/** The small-method E story view (the page mounted only after the seed). */
function ESmallStoryView() {
  return (
    <SeedGate seed={seedSmallMethods}>
        <ChooseMethodsPage />
      </SeedGate>
  )
}

/**
 * The ITEM-2 re-check story's seed: the small set plus a DECISION-DAY-AWARE
 * eligibility — the set is fully runnable at the fixture's decision day
 * (56), and one method becomes cannot-run when the user picks day 28, so
 * the browser test can drive the recompute + the untick toast (a settings
 * change that changes the eligibility) over the real page.
 */
function seedRecheckMethods(): void {
  txrrunSeedValidatedIntake()
  extendCassette({
    'MethodCatalogue.list': { methods: txrrunSmallMethods(), total: 6 },
    'MethodCatalogue.eligibility': txrrunRecheckEligibility,
    'MethodCatalogue.estimate': (ctx: { body?: unknown }) => {
      const ids = ((ctx.body ?? {}) as { method_ids?: string[] }).method_ids ?? []
      return {
        at_a_time: 3,
        cpus: 4,
        methods: ids.map(id => ({ id, estimated_seconds: 45, estimate_quality: 'measured' })),
        total_seconds: ids.length * 45,
        schedule_seconds: ids.length * 45,
      }
    },
  })
}

/** The ITEM-2 re-check story view. */
function ERecheckStoryView() {
  return (
    <SeedGate seed={seedRecheckMethods}>
        <ChooseMethodsPage />
      </SeedGate>
  )
}

// ── the module's gallery seed ──────────────────────────────────────────────

/**
 * The module's cassette: the E screen's own reads (the sticky config, the
 * keep-copies preference, the About card) and the F screen's run controls —
 * the run-control responders RECORD the request into the seam before
 * answering, so the gallery-e2e can assert the posted bytes. `Txr.getRun` /
 * `Txr.listRunLogs` are deliberately NOT here (their one owner is
 * `txrresults`; the F stories extend them at mount per the header note), and
 * the `MethodCatalogue.*` catalogue/eligibility/estimate keys belong to
 * `txrlist` — the E story receives them through the shared cassette.
 */
export const gallery: ModuleGallery = {
  cassette: {
    'MethodCatalogue.detail': () => txrrunMethodDetail(),
    'Txr.getAnalysisConfig': TXRRUN_APP_CONFIG,
    'Txr.updateAnalysisConfig': undefined,
    'Txr.createRun': (ctx: MockRequestContext) =>
      txrrunRunSummary({ id: TXRRUN_RUN_F.id, at_a_time: TXRRUN_RUN_F.config.at_a_time ?? 3 }),
    'Txr.listRuns': { runs: [], total: 0, limit: 50, offset: 0 },
    'History.getPreferences': TXRRUN_KEEP_COPIES,
    'Txr.skipMethod': (ctx: MockRequestContext) => {
      txrrunRecordRequest({ op: 'Txr.skipMethod', params: ctx.params, body: ctx.body })
      return { ok: true }
    },
    'Txr.stopMethod': (ctx: MockRequestContext) => {
      txrrunRecordRequest({ op: 'Txr.stopMethod', params: ctx.params, body: ctx.body })
      return { ok: true }
    },
    'Txr.stopRun': (ctx: MockRequestContext) => {
      txrrunRecordRequest({ op: 'Txr.stopRun', params: ctx.params, body: ctx.body })
      return { ok: true }
    },
    'Txr.setAtATime': (ctx: MockRequestContext) => {
      txrrunRecordRequest({ op: 'Txr.setAtATime', params: ctx.params, body: ctx.body })
      const body = (ctx.body ?? {}) as { at_a_time?: number }
      return txrrunRunSummary({ id: ctx.params.id, at_a_time: body.at_a_time ?? 3 })
    },
  },

  seeded: [
    {
      slug: 'txr-run-e',
      title: 'Choose the methods and settings (screen E)',
      note: 'The board\'s Step 4 with the validated fixture file pair: the Patients/Measurements slot lines with Change files, the four settings rows (Predict, Decision day, Look ahead to, Extra inputs + More settings), the ITEM-1 method picker over the catalogue cassette (the 38-entry fixture set; the board\'s first rows verbatim; the ready-to-run default with the recommended selection ticked; the family sections with the sticky headers and Show-more; the collapsed can\'t-run section with the per-reason chips and expansion), and the bottom bar (selected count, the estimate total, run at a time, save models, the research notice, Run).',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: EStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-e-small',
      title: 'Screen E — six runnable methods',
      note: 'The small-method story: six runnable methods across the four families (the bar counts the six, the estimate packs to the fixture total), the recommended selection ticked on arrival — the measurable set the ITEM-1 height byte was built on (that byte now lives on the shell-route surface).',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: ESmallStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-e-recheck',
      title: 'Screen E — a settings change re-checks the methods',
      note: 'The ITEM-2 story: the small set is fully runnable at the fixture\'s decision day; picking day 28 makes one method no longer fit — the list re-checks with the re-check line, the method is unticked and the toast names it, and the run bar reads the new selection.',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: ERecheckStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-e-narrow-390',
      title: 'Screen E at 390 px',
      note: 'The board\'s mobile width: the slot lines, the settings rows and the list stack inside the card, no horizontal page overflow.',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: ENarrowStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-e-empty',
      title: 'Screen E — no analysis yet',
      note: 'The empty-snapshot state (direct URL): the missing input is named and "Start a new analysis" leads home (DEC-16) — never a half-broken list, never a crash.',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: EEmptyStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-e-error',
      title: 'Screen E — the eligibility failure state',
      note: 'The list\'s first-load failure: the error line + the Retry button, with the slots and the settings still rendered (the failing responder is the story\'s own session-scoped extension, per the header note).',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() => Promise.resolve({ default: EErrorStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-run-f',
      title: 'Running (screen F) — live frames',
      note: 'The live run: the header (6 methods, the estimate line, the live elapsed), the per-state counter strip, the tab chips, the per-method table and the log panel (the board\'s method select). The stream\'s frame script walks direct-on waiting → downloading (the env bytes, with the progress text) → running → finished, appends the log lines, and the prediction frame lights "See the results" — no navigation (EXAMPLE-UI-RUN-2).',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f" /> })),
    },
    {
      slug: 'txr-run-f-working',
      title: 'Running (screen F) — mid-run mix',
      note: 'The steady mid-run board: one row per engine state (waiting, downloading, running, finished, failed, cannot run) — every per-state action visible (Skip, Stop, View result, Show log) — with a finished row and the results affordance already live.',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f-working'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-working" /> })),
    },
    {
      slug: 'txr-run-f-finished',
      title: 'Running (screen F) — terminal snapshot',
      note: 'The finished run: every row finished, the per-state counts, the tab chips, the run\'s own terminal title ("Finished 6 methods"), the terminal status latched by the stream\'s replay, "See the results" live and the live-run controls gone (RP-1) — the snapshot renders, never a blank.',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f-finished'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-finished" /> })),
    },
    {
      slug: 'txr-run-f-failed',
      title: 'Running (screen F) — the failures kept with their reasons',
      note: 'The run with a failure pair: the failed rows carry their reason lines in the Failed tab and the cannot-run row in its own tab (RP-3), Show log opens the panel at the method, the healthy rows keep working (INV-2).',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f-failed'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-failed" /> })),
    },
    {
      slug: 'txr-run-f-leak',
      title: 'Running (screen F) — terminal failed snapshot with leaked-style reasons (ITEM-1 guard)',
      note: 'qa-fixes4 ITEM-1 (results-r3 R3-results-2): a direct URL at a TERMINAL failed run renders the snapshot — the failed row\'s reason is the report\'s leaked wording (tool name + absolute path); the detail line passes the `safeText` guard, and the browser spec `txr-internal-text.spec.ts` asserts no text node leaks the tool name or the path.',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f-leak'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-leak" /> })),
    },
    {
      slug: 'txr-run-f-narrow-390',
      title: 'Running (screen F) at 390 px',
      note: 'The board\'s mobile width: the header, the strip and the table stack, the header actions stay inside the viewport, no horizontal page overflow.',
      path: '/analysis/:runId/running',
      initialPath: `/analysis/${'run-f-finished'}/running`,
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-finished" narrow /> })),
    },
    {
      slug: 'txr-run-f-not-found',
      title: 'Running (screen F) — unknown run',
      note: 'The 404 RUN_NOT_FOUND state: the not-found line + the History link (the mock route answers this run id with the engine\'s 404).',
      path: '/analysis/:runId/running',
      initialPath: '/analysis/run-not-found/running',
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-not-found" /> })),
    },
    {
      slug: 'txr-run-f-logrepeat',
      title: 'Running (screen F) — the real clock and the repeated-log collapse (qa-fixes4 ITEM-3)',
      note: 'The LIVE run whose `started_at` is the fixture load moment minus 30 s: the header\'s elapsed reads the wall clock (ITEM-3 a, methods-r3 R3-methods-3) and the time-left counts its real seconds ("about N s left" — R2-2\'s leftover, never the constant "under a minute left"); the log carries the identical R `colClasses` warning block three times (R3-methods-5) — the panel shows the block ONCE with the ×9 badge and the honest "9 repeated lines collapsed" count. The Working tab\'s definition sits beside the chip (RP-10). The browser spec `txr-run.spec.ts` (qa-fixes4 ITEM-7) pins all of it.',
      path: '/analysis/:runId/running',
      initialPath: '/analysis/run-f-logrepeat/running',
      component: lazy(() => Promise.resolve({ default: () => <FStoryView runId="run-f-logrepeat" /> })),
    },
    // app-shell ITEM-2 — the route byte: each page inside the REAL shell
    // (the audit section-4 legs over these surfaces: `txr-shell-routes.spec.ts`).
    {
      slug: 'txr-shell-route-choose-methods',
      title: 'Choose the methods (screen E) inside the shell',
      note: 'The ITEM-2 route byte: the step/title/summary/settings + the picker toolbar fixed, the method list ONE region (the sections\' sticky headers stick to its top), the run bar pinned in the bottom slot — the page itself never scrolls.',
      path: '/choose-methods',
      initialPath: '/choose-methods',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <SeedGate seed={txrrunSeedValidatedIntake}>
                <ChooseMethodsPage />
              </SeedGate>
            </ShellRouteView>
          ),
        }),
      ),
    },
    {
      slug: 'txr-shell-route-running',
      title: 'Running (screen F) inside the shell',
      note: 'The ITEM-2 route byte: the run summary + tabs fixed, the per-method table region (sticky header) and the log\'s own region side by side at 1024+, Stop all + See the results pinned in the bottom bar. The mid-run fixture keeps the run live (no terminal redirect).',
      path: '/analysis/:runId/running',
      initialPath: '/analysis/run-f-working/running',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <SeedGate seed={() => seedRunStory('run-f-working')}>
                <RunningPage />
              </SeedGate>
            </ShellRouteView>
          ),
        }),
      ),
    },
  ],
}

// ── the byte/error routes (the cassette answers JSON only) ─────────────────

/** One mock route of the module (the op label keeps the surface auditable). */
export interface TxrRunMockRouteEntry {
  op: 'streamRun' | 'getRun'
  route: SpecialRoute
}

/**
 * The module's special mock routes (registered by the dev gallery's
 * `mountGallery` — see `main.tsx`): the run SSE stream for the fixture run
 * ids (the `sseReplayResponse` built from the story's `setSseCassette`
 * frames; the id-scoped test leaves the path-family owner to serve every
 * other id) and the not-found run's engine error shape (a 404 RUN_NOT_FOUND
 * the cassette cannot express).
 */
export const txrMockRoutes: TxrRunMockRouteEntry[] = [
  {
    op: 'streamRun',
    route: {
      test: (path: string) => {
        const match = /^\/api\/txr\/runs\/([^/]+)\/stream$/.exec(path)
        return match !== null && TXRRUN_STREAM_RUN_IDS.has(match[1])
      },
      respond: () => sseReplayResponse(),
    },
  },
  {
    op: 'getRun',
    route: {
      test: (path: string) => path === '/api/txr/runs/run-not-found',
      respond: () => jsonResponse({ error: 'RUN_NOT_FOUND' }, 404),
    },
  },
]
