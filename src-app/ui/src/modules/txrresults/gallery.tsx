/**
 * txrresults dev-gallery surfaces (ITEM-11; PROV-UR-8) — the module's eleven
 * stories, one seeded surface per board state, all fed by the mock cassette
 * over the synthetic `fixtures.ts` (INV-5: every value is fixture data; the
 * boards' example facts never enter code or data).
 *
 * Stories mount the REAL pages under the gallery's MemoryRouter (the
 * `datasets`/`txrlist` precedent), so `useParams`/`useNavigate` behave as in
 * the app; the pages' stores load through the mock (`ApiClient.Txr.*`), and
 * the module's two byte surfaces (the run SSE stream, the CSV download) are
 * answered by `txrMockRoutes` — the mock engine's cassette answers JSON
 * endpoints only, so the stream (an event-stream body) and the CSV
 * (`text/csv`) and the two error shapes (404/409, which the cassette cannot
 * express) are app-registered special routes (see `main.tsx`, the dev
 * gallery's `mountGallery({ specialRoutes })`).
 *
 * - `txr-results-g`: the board's populated G state — the 12-method /
 *   38-row heatmap, all methods finished, the board's "Showing N of M" row
 *   window applied by the story host.
 * - `txr-results-g-running`: the board's live state (all but one method
 *   finished, the last one running); the mock stream replays the frame
 *   script — the 12th column appears without a reload and the
 *   counts/banner update (INV-1).
 * - `txr-results-g-cannot`: the cannot-run banner + the per-method log
 *   dialog (the mixed-task run: two outcome tabs).
 * - `txr-results-g-partial`: the "Choose methods…" picker state (the
 *   empty-pick marker).
 * - `txr-results-g-nochance`: the predict-only-reuse shape (qa-fixes2
 *   R2-03/R2-11) — a finished method with `prob_source: none` (the named
 *   no-chance note) and one-method outcome tabs (no Average column).
 * - `txr-results-h` / `txr-results-h-compare`: the Results board's one-method
 *   view and two-method compare view (the bar table, the compare card, the
 *   aside, the saved-in line — the H row window from the board).
 * - `txr-results-h-few`: a one-method run (no compare card, no divergent
 *   toggle).
 * - `txr-results-empty` / `txr-results-not-found` / `txr-results-error`: the
 *   DEC-18 state machine's three states (409 / 404 / network error).
 * - `txr-results-narrow-390`: the H compare content on the board's mobile
 *   width (no horizontal page overflow).
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect, useRef, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { jsonResponse, type ModuleGallery, type SpecialRoute } from '@ziee/gallery'
import { ResultsPage } from './pages/ResultsPage'
import { MethodResultsPage } from './pages/MethodResultsPage'
import { TxrResults, useTxrResultsStore } from './stores/Results.store'
import {
  TXR_PREDICTIONS,
  TXR_PREDICTIONS_GROWN,
  TXR_RUN_EMPTY,
  TXR_RUN_G,
  TXR_RUN_CANNOT,
  TXR_RUN_H,
  TXR_RUN_HFEW,
  TXR_RUN_NOCHANCE,
  TXR_RUN_RUNNING,
  TXR_RUNS,
  TXR_CSV,
  TXR_LOGS,
  TXR_G_SHOWN,
  TXR_H_SHOWN,
  type TxrFixtureFrame,
  txrStreamFrames,
} from './fixtures'

// ── the story-host wrapper: apply a board view state after the page's load ──

/**
 * The story host that renders the real page and applies one store view
 * setting once the page's `load` has delivered (the setup runs BEFORE the
 * page mounts — the page's own `load` resets the store, so a setup-time
 * setter would be wiped; this wrapper waits for the first `run` +
 * `predictions` pair and applies the board's row window / picker state).
 */
function WithAppliedViewState({
  apply,
  children,
}: {
  apply: () => void
  children: ReactNode
}) {
  const ready = useStore(useTxrResultsStore, s => s.run !== null && s.predictions !== null)
  const applied = useRef(false)
  useEffect(() => {
    if (ready && !applied.current) {
      applied.current = true
      apply()
    }
  }, [ready, apply])
  return <>{children}</>
}

/** The G board's row window ("Showing N of M … Show all M"). */
const applyGView = (): void => TxrResults.setPatientLimit(TXR_G_SHOWN)
/** The H board's row window ("Showing N of M. Show all M"). */
const applyHView = (): void => TxrResults.setPatientLimit(TXR_H_SHOWN)
/** The "Choose methods…" picker state (the empty-pick marker, ITEM-6). */
const applyPartialView = (): void => TxrResults.setMethodFilter({ groups: [], methodIds: [] })

const GStory = lazy(() =>
  Promise.resolve({ default: () => <WithAppliedViewState apply={applyGView}><ResultsPage /></WithAppliedViewState> }),
)
const PartialStory = lazy(() =>
  Promise.resolve({ default: () => <WithAppliedViewState apply={applyPartialView}><ResultsPage /></WithAppliedViewState> }),
)
const HStory = lazy(() =>
  Promise.resolve({ default: () => <WithAppliedViewState apply={applyHView}><MethodResultsPage /></WithAppliedViewState> }),
)
const ResultsStory = lazy(() => Promise.resolve({ default: ResultsPage }))
const MethodsStory = lazy(() => Promise.resolve({ default: MethodResultsPage }))

// ── the story-seeding cassette (the five Txr operations, all fixture-driven) ──

/** The frame-sent latches — the running story's grown-response gate (below). */
const predictionSent = new Map<string, boolean>()

/**
 * The module's cassette: `Txr.getRun` / `Txr.getPredictions` /
 * `Txr.listRunLogs` resolve per run id from the fixture tables. The running
 * story's predictions answer the 11-column snapshot until the stream's
 * `prediction` frame has been delivered, then the 12-column grown twin —
 * the live-column contract without a reset delay (the mock's
 * `getPredictions` cannot observe the stream, so the stream route's
 * frame-sent latch is the gate; see `txrMockRoutes`).
 */
export const gallery: ModuleGallery = {
  cassette: {
    'Txr.getRun': (ctx: { params: Record<string, string> }) => TXR_RUNS[ctx.params.id],
    'Txr.getPredictions': (ctx: { params: Record<string, string> }) => {
      const id = ctx.params.id
      if (id === TXR_RUN_RUNNING.id && predictionSent.get(id) === true) return TXR_PREDICTIONS_GROWN
      return TXR_PREDICTIONS[id]
    },
    'Txr.listRunLogs': (ctx: { params: Record<string, string> }) =>
      TXR_LOGS[ctx.params.id] ?? { lines: [], next_seq: 0, total: 0 },
  },

  seeded: [
    {
      slug: 'txr-results-g',
      title: 'Results — populated heatmap (screen G)',
      note: 'The board\'s G layout with fixture data: the finish-everything heatmap (all columns present), the outcome tabs, the search/sort/methods bar with the 0–100% legend, the pinned first column + sticky header (scroll the box), the board\'s "Showing N of M … Show all M" row window, and the Download / Save the models / New analysis actions.',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/${TXR_RUN_G.id}/results`,
      component: GStory,
    },
    {
      slug: 'txr-results-g-running',
      title: 'Results — live while the run continues',
      note: 'The board\'s live state: most methods finished, the last one still running. The mock stream replays the frame script — the last method\'s transition + progress + log lines arrive, then its `prediction` frame adds the final column (INV-1) and the terminal status closes the live tail.',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/${TXR_RUN_RUNNING.id}/results`,
      component: ResultsStory,
    },
    {
      slug: 'txr-results-g-cannot',
      title: 'Results — a method that could not run',
      note: 'The cannot-run banner (mono method id + the engine reason + "The other N methods are shown.") with "Show the log" opening the module log dialog (backfill + live tail), on a mixed-task run (two outcome tabs).',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/${TXR_RUN_CANNOT.id}/results`,
      component: ResultsStory,
    },
    {
      slug: 'txr-results-g-partial',
      title: 'Results — "Choose methods…" picker state',
      note: 'The methods picker in Choose mode (the empty-pick marker): the hand-picked MultiSelect is shown while the heatmap keeps every column (an empty restriction is the All state).',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/run-partial/results`,
      component: PartialStory,
    },
    {
      slug: 'txr-results-g-nochance',
      title: 'Results — a finished method with no chances (R2-03/R2-11)',
      note: 'qa-fixes2 ITEM-7\'s re-verification shape: a predict-only reuse run whose pfs method finished with no chances (prob_source none) — the wall of blanks with the note naming the column — and one-method outcome tabs (the Average column is redundant when the column IS the average and is gone). Two tabs, one column each.',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/${TXR_RUN_NOCHANCE.id}/results`,
      component: ResultsStory,
    },
    {
      slug: 'txr-results-h',
      title: 'Results — one method (screen H)',
      note: 'The results board\'s one-method view: the method tablist (Compare + the finished methods), the outcome tabs, the patient × method bar table sorted by the first method with the board\'s row window, the explanatory aside, and the header\'s "Save this model" (the produced model exists).',
      path: '/analysis/:runId/results/methods/:methodId',
      initialPath: `/analysis/${TXR_RUN_H.id}/results/methods/${TXR_RUN_H.methods[0].method_id}`,
      component: HStory,
    },
    {
      slug: 'txr-results-h-compare',
      title: 'Results — compare two methods (screen H)',
      note: 'The H board\'s compare view: the "How the two methods compare" card (both methods\' top-5 overlap + the "They differ most for …" sentence), the divergent-only toggle, the bar table heading, and the saved-in / open-folder line.',
      path: '/analysis/:runId/results/compare',
      initialPath: `/analysis/${TXR_RUN_H.id}/results/compare`,
      component: HStory,
    },
    {
      slug: 'txr-results-h-few',
      title: 'Results — a single-method run',
      note: 'One finished method: no compare card, no divergent toggle (the card needs a second column), the one-method save button, the explanatory aside.',
      path: '/analysis/:runId/results/compare',
      initialPath: `/analysis/${TXR_RUN_HFEW.id}/results/compare`,
      component: MethodsStory,
    },
    {
      slug: 'txr-results-empty',
      title: 'Results — no method finished yet',
      note: 'The 409 PREDICTIONS_UNAVAILABLE state: header + banner + counts + disabled download, no spinner loop — the mock stream stays open and a `prediction` frame would fill the columns.',
      path: '/analysis/:runId/results',
      initialPath: `/analysis/${TXR_RUN_EMPTY.id}/results`,
      component: ResultsStory,
    },
    {
      slug: 'txr-results-not-found',
      title: 'Results — unknown run',
      note: 'The 404 RUN_NOT_FOUND state: the not-found message + New analysis CTA (the mock route answers this run id with the engine\'s 404).',
      path: '/analysis/:runId/results',
      initialPath: '/analysis/run-missing/results',
      component: ResultsStory,
    },
    {
      slug: 'txr-results-error',
      title: 'Results — server failure',
      note: 'The network-error state with the retry (the mock route answers this run id with a 500; the retry re-runs the load and fails the same way).',
      path: '/analysis/:runId/results',
      initialPath: '/analysis/run-error/results',
      component: ResultsStory,
    },
    {
      slug: 'txr-results-narrow-390',
      title: 'Results — the 390 px width',
      note: 'The H compare content at the board\'s mobile width: the bar table and the aside stack, the header actions wrap, no horizontal page overflow.',
      path: '/analysis/:runId/results/compare',
      initialPath: `/analysis/${TXR_RUN_H.id}/results/compare`,
      component: HStory,
    },
  ],
}

// ── the byte/error routes (the cassette answers JSON only) ──

/** The run id of a stream or prediction path (`/api/txr/runs/<id>/…`). */
function runIdOf(path: string): string {
  const match = /^\/api\/txr\/runs\/([^/]+)\//.exec(path)
  return match?.[1] ?? ''
}

/**
 * The stream response with a frame-sent latch: the gallery mock's generic
 * `sseResponse` has no per-frame hook, and the running story's grown
 * response must be served only AFTER its `prediction` frame has been
 * delivered (the store refetches on that frame; a call-count gate would be
 * tripped by the StrictMode double-mount's second initial fetch). The body
 * construction is the mock engine's (events + data lines, 350 ms gaps, the
 * `connected` handshake first, the stream left open).
 */
function fxStreamResponse(frames: TxrFixtureFrame[], runId: string): Response {
  const encoder = new globalThis.TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ connectionId: 'gallery-sse' })}\n\n`),
      )
      for (const frame of frames) {
        await new Promise(r => setTimeout(r, 350))
        if (frame.event === 'prediction') predictionSent.set(runId, true)
        controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`))
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/** One mock route of the module (the op label keeps the surface auditable). */
export interface TxrMockRouteEntry {
  op: 'streamRun' | 'downloadPredictions' | 'getPredictions' | 'getRun'
  route: SpecialRoute
}

/**
 * The module's special mock routes (registered by the dev gallery's
 * `mountGallery` — see `main.tsx`): the run's SSE stream (the frame script
 * of `fixtures.ts`), the predictions CSV as `text/csv` (the transport's
 * `text/*` → string path), and the two engine error shapes the cassette
 * cannot express (a 404 RUN_NOT_FOUND, a 409 PREDICTIONS_UNAVAILABLE, a 500
 * for the error story).
 */
export const txrMockRoutes: TxrMockRouteEntry[] = [
  {
    op: 'streamRun',
    route: {
      test: (path: string) => /^\/api\/txr\/runs\/[^/]+\/stream$/.test(path),
      respond: ({ path }: { path: string }) => {
        const runId = runIdOf(path)
        return fxStreamResponse(txrStreamFrames(runId), runId)
      },
    },
  },
  {
    op: 'downloadPredictions',
    route: {
      test: (path: string) => /^\/api\/txr\/runs\/[^/]+\/predictions\.csv$/.test(path),
      respond: () =>
        new Response(TXR_CSV, {
          status: 200,
          headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        }),
    },
  },
  {
    op: 'getPredictions',
    route: {
      test: (path: string) => path === `/api/txr/runs/${TXR_RUN_EMPTY.id}/predictions`,
      respond: () => jsonResponse({ error: 'PREDICTIONS_UNAVAILABLE' }, 409),
    },
  },
  {
    op: 'getRun',
    route: {
      test: (path: string) => path === '/api/txr/runs/run-missing',
      respond: () => jsonResponse({ error: 'RUN_NOT_FOUND' }, 404),
    },
  },
  {
    op: 'getRun',
    route: {
      test: (path: string) => path === '/api/txr/runs/run-error',
      respond: () => jsonResponse({ error: 'Internal server error' }, 500),
    },
  },
]
