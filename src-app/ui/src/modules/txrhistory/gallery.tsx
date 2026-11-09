/**
 * txrhistory dev-gallery surfaces (ITEM-6; PROV-HIST-6) — screen K's
 * seeded states, all fed by the mock cassette over the synthetic
 * `fixtures.ts` (INV-6: every value is fixture data — the boards' example
 * facts never enter code or data).
 *
 * Stories mount the REAL `HistoryPage` under the gallery's MemoryRouter
 * (the `txrresults`/`txrmodels` precedent), so the store's real load path
 * runs unchanged: the page calls the generated client against the mock
 * (`ApiClient.History.*` / `ApiClient.Txr.*`), and the story gates are the
 * same store actions the user's clicks drive (one expanded row, the
 * filter option, the confirmation). The fixture family is ONE inventory of
 * six runs (the board's four row shapes + the running row + the
 * copy-cleared row — plus the 25-run family the paging state needs), so
 * every story is a view over the same consistent set.
 *
 * - `txr-history-populated` / `txr-history-detail-expanded`: the family
 *   list with one row pre-expanded — the train block (Your files +
 *   Settings + Methods + Took + Made + the action column) and the reuse
 *   block (the second subtitle shape, no decision-day segment).
 * - `txr-history-search` / `txr-history-filter-stopped-failed`: the
 *   toolbar's interactions over the family — the cassette answers the
 *   provider's own q/kind/status semantics, so the spec's typed query and
 *   the fourth filter option narrow the list server-style.
 * - `txr-history-running`: the running row's "Running" status + "Open the
 *   running run" action (and never a fake Done/Failed, INV-2).
 * - `txr-history-copies-cleared`: the copy-cleared row's honest
 *   retention line + "Use these settings again" (DEC-6 — the spec asserts
 *   the PUT body and NO rerun call); the preference flips to false, the
 *   row's `can_rerun` is false.
 * - `txr-history-clear-all-confirm`: the clear-all confirmation already
 *   open (the spec drives Cancel/choice — the store's gate is the
 *   assertion, `clearRuns` fires only after a choice).
 * - `txr-history-log-dialog`: the terminal-snapshot dialog over the
 *   fixture log capture (the method filter backfills per method — the
 *   store's fresh-cursor backfill).
 * - `txr-history-many`: the 25-run family (a 20-row page + the Load-more
 *   continuation — INV-1).
 * - `txr-history-empty` / `txr-history-error`: the list's no-runs state
 *   and the first-load failure + Retry.
 * - `txr-history-narrow-390`: the board's mobile width.
 *
 * The story host's two seams (the `txr-models` run-result/request-seam
 * convention — the spec reads the seam, never the component): the landed
 * path of every navigation the actions produce, and the request log every
 * cassette resolver records (the call order + the posted bodies the
 * specs pin: the DEC-6 settings body, PUT-then-POST, the clear choice).
 *
 * The cassette's OWNED keys are the seven operations this node consumes
 * that no sibling module owns (`History.listHistory/getHistory/
 * updatePreferences/clearAllCopies/getUsage`, `Txr.rerunRun/clearRuns` —
 * `mergeModuleCassettes` throws on a duplicate, so the sibling-owned
 * `History.getPreferences` (txrrun), `Txr.updateAnalysisConfig` (txrrun)
 * and `Txr.listRunLogs` (txrresults) are answered per-story by id-scoped
 * extensions, the `txrmodels` precedent).
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { useStore } from 'zustand'
import { extendCassette, type MockRequestContext, type ModuleGallery } from '@ziee/gallery'
import { HistoryPage } from './pages/HistoryPage'
import { TxrHistory, useTxrHistory } from './index'
import {
  TXHISTORY_DETAILS,
  TXHISTORY_RERUN_SUMMARY,
  TXHISTORY_RUNS,
  TXHISTORY_RUNS_MANY,
  TXHISTORY_RUN_BOARD_REUSE,
  TXHISTORY_RUN_BOARD_TRAIN,
  TXHISTORY_RUN_COPIES_CLEARED,
  TXHISTORY_RUN_RUNNING,
  TXHISTORY_USAGE,
  fixtureHistoryPage,
  fixtureLogsFor,
  fixtureUsage,
} from './fixtures'

// ── the story-host seams (the gallery-e2e reads these, never the components) ──

/** One recorded request of a story session (the seam's data). */
interface TxrHistoryRequestRecord {
  key: string
  method: string
  query: Record<string, string>
  body: unknown
}

/** The session's request log (the cassette responders' one write each). */
const REQUEST_LOG: TxrHistoryRequestRecord[] = []
const REQUEST_LISTENERS = new Set<() => void>()

/** Subscribe to the request log (the seam's re-paint hook). */
function onRequestRecord(callback: () => void): () => void {
  REQUEST_LISTENERS.add(callback)
  return () => {
    REQUEST_LISTENERS.delete(callback)
  }
}

/** Record one request (called inside the cassette resolvers). */
function recordRequest(key: string, ctx: MockRequestContext): void {
  REQUEST_LOG.push({
    key,
    method: ctx.method,
    query: ctx.query,
    body: ctx.body,
  })
  for (const listener of REQUEST_LISTENERS) listener()
}

/** The request seam: every recorded request of the session (the spec reads
 *  the posted bodies + the call order — the `txr-models` seam convention). */
function RequestSeam() {
  const [, paint] = useState(0)
  useEffect(() => onRequestRecord(() => paint(n => n + 1)))
  return (
    <pre data-testid="txr-history-request-seam" style={SEAM_STYLE}>
      {JSON.stringify(REQUEST_LOG)}
    </pre>
  )
}

/** The landed seam: the story's in-frame navigation destination. */
function LandedAt() {
  const location = useLocation()
  return (
    <pre data-testid="txr-history-landed" style={{ margin: 24, fontSize: 12, color: 'var(--txr-muted)' }}>
      navigated to {location.pathname}
    </pre>
  )
}

/** The seam's quiet mono look. */
const SEAM_STYLE: CSSProperties = {
  margin: 8,
  fontSize: 11,
  color: 'var(--txr-muted)',
  whiteSpace: 'pre-wrap',
  // qa-fixes ITEM-7: JSON.stringify emits ONE unbroken token per requested
  // body, and `pre-wrap` only breaks at whitespace — a long body made the
  // seam (and the gallery frame's scrollWidth) wider than 390 px. The
  // break-anywhere rule keeps the seam inside its frame (it is dev chrome;
  // it must not fail the phone sweep's own check).
  overflowWrap: 'anywhere',
}

/** The list-frame look (the gallery's bounded white pane). */
const FRAME: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
}

// ── the story frame (the SeedGate idiom: the cassette extensions + the
//    store reset must be in place before the page's first render) ────────────

/** A seed-then-render gate (the txrmodels SeedGate idiom). */
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

/** Runs one story action once the list's first load has settled (the store
 *  loads through the page's own mount effect — the apply is the second
 *  half of the story's seed, e.g. the pre-expanded row). */
function WhenLoaded({ apply }: { apply?: () => void }) {
  const ready = useStore(
    useTxrHistory,
    s => !s.loading && (s.error !== null || s.items.length > 0 || s.total === 0),
  )
  const applied = useRef(false)
  useEffect(() => {
    if (apply !== undefined && ready && !applied.current) {
      applied.current = true
      apply()
    }
  }, [ready, apply])
  return null
}

/** The seeded K page frame: the real page under `/history` + the in-frame
 *  navigation lands (the story's own descendant `<Routes>` — the harness's
 *  parent splat keeps the story mounted, the `txrmodels` D-story pattern). */
function HistoryStory({
  seed,
  apply,
  narrow = false,
}: {
  seed: () => void
  apply?: () => void
  narrow?: boolean
}) {
  return (
    <section
      style={{ width: narrow ? 390 : '100%', maxWidth: '100%', minWidth: 0, position: 'relative' }}
    >
      <SeedGate seed={seed}>
        <Routes>
          <Route
            path="/history"
            element={
              <div style={FRAME}>
                <HistoryPage />
                <WhenLoaded apply={apply} />
              </div>
            }
          />
          <Route path="/analysis/:runId/results" element={<LandedAt />} />
          <Route path="/analysis/:runId/running" element={<LandedAt />} />
          <Route path="/choose-methods" element={<LandedAt />} />
          <Route path="/models" element={<LandedAt />} />
          <Route path="*" element={<LandedAt />} />
        </Routes>
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

// ── the story seeds (one per state) ─────────────────────────────────────────

/** The family view's seed: a fresh store, the module cassette's answers. */
function seedFamily(): void {
  TxrHistory.reset()
}

/** The empty state: an empty list + the zero-run usage figure. */
function seedEmpty(): void {
  TxrHistory.reset()
  extendCassette({
    'History.listHistory': (ctx: MockRequestContext) => fixtureHistoryPage([], ctx.query),
    'History.getUsage': () => fixtureUsage(0, 0),
  })
}

/** The first-load failure: the list read throws (the error + Retry state). */
function seedError(): void {
  TxrHistory.reset()
  extendCassette({
    'History.listHistory': () => {
      throw new Error('fixture history failure')
    },
    'History.getUsage': () => fixtureUsage(0, 0),
  })
}

/** The copy-cleared view: the one honest row, the retention preference off
 *  (the footer's "Keep copies" link), the settings-again seam ready. */
function seedCopiesCleared(): void {
  TxrHistory.reset()
  extendCassette({
    'History.listHistory': (ctx: MockRequestContext) =>
      fixtureHistoryPage([TXHISTORY_RUN_COPIES_CLEARED], ctx.query),
    'History.getUsage': () => fixtureUsage(1, 28 * 1024 * 1024),
    'History.getPreferences': () => ({ keep_file_copies: false }),
    'Txr.updateAnalysisConfig': (ctx: MockRequestContext) => {
      recordRequest('Txr.updateAnalysisConfig', ctx)
      return undefined
    },
  })
}

/** The paging view: the 25-run family (page size 20 → a second page).
 *  The resolver records into the seam like the module cassette's own —
 *  the spec's limit/offset pins read the recorded calls. */
function seedMany(): void {
  TxrHistory.reset()
  extendCassette({
    'History.listHistory': (ctx: MockRequestContext) => {
      recordRequest('History.listHistory', ctx)
      return fixtureHistoryPage(TXHISTORY_RUNS_MANY, ctx.query)
    },
    'History.getUsage': () => fixtureUsage(25, 275 * 1024 * 1024),
  })
}

/** The log-dialog view: the fixture log capture's answers (the key belongs
 *  to txrresults' cassette — this story answers its own run's lines). */
function seedLogDialog(): void {
  TxrHistory.reset()
  extendCassette({
    'Txr.listRunLogs': (ctx: MockRequestContext) => {
      recordRequest('Txr.listRunLogs', ctx)
      return fixtureLogsFor(ctx.params.id, ctx.query.method_id ?? null)
    },
  })
}

// ── the module's gallery seed ───────────────────────────────────────────────

/**
 * The module's cassette: the JSON operations this node consumes that no
 * other module's cassette owns (the sibling-owned keys are the stories'
 * id-scoped extensions — `mergeModuleCassettes` throws on a duplicate).
 * The response values are the `fixtures.ts` payloads (synthetic), and each
 * resolver records its request into the seam (the spec's order + body
 * pins). The list answers the provider's own q/kind/status + paging
 * semantics over the fixture family.
 */
export const gallery: ModuleGallery = {
  cassette: {
    'History.listHistory': (ctx: MockRequestContext) => {
      recordRequest('History.listHistory', ctx)
      const page = fixtureHistoryPage(TXHISTORY_RUNS, ctx.query)
      // The WIRE shape (qa-fixes ITEM-8, RES-01): the engine serializes its
      // `Option<reason>` as JSON `null` for every run without one, while the
      // generated client types the field optional-ONLY — so the wire carries
      // `reason: null` exactly where the type says "no property". The
      // cassette answers the page the way the real API does, so the K render
      // path is exercised in a browser against the shape that crashed ITEM-1
      // (the `fixtures.ts` domain model stays typed; the wire fidelity lives
      // in the cassette, the mock of the API).
      return {
        ...page,
        items: page.items.map(row => ({ ...row, reason: row.reason ?? null })),
      }
    },
    'History.getHistory': (ctx: MockRequestContext) => {
      recordRequest('History.getHistory', ctx)
      const detail = TXHISTORY_DETAILS[ctx.params.id]!
      return { ...detail, reason: detail.reason ?? null }
    },
    'History.updatePreferences': (ctx: MockRequestContext) => {
      recordRequest('History.updatePreferences', ctx)
      return undefined
    },
    'History.clearAllCopies': (ctx: MockRequestContext) => {
      recordRequest('History.clearAllCopies', ctx)
      return undefined
    },
    'History.getUsage': (ctx: MockRequestContext) => {
      recordRequest('History.getUsage', ctx)
      return TXHISTORY_USAGE
    },
    'Txr.rerunRun': (ctx: MockRequestContext) => {
      recordRequest('Txr.rerunRun', ctx)
      return TXHISTORY_RERUN_SUMMARY
    },
    'Txr.clearRuns': (ctx: MockRequestContext) => {
      recordRequest('Txr.clearRuns', ctx)
      return undefined
    },
  },

  seeded: [
    {
      slug: 'txr-history-populated',
      title: 'History — the populated list (screen K)',
      note: 'The fixture family newest-first with the first row pre-expanded: the board rows\' shapes with synthetic facts (the train block\'s Your files + copies note, Settings, Methods with per-method duration, Took with the estimate, Made with the named set link, and the four actions — plus the running row and the copy-cleared row in the same inventory).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedFamily}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_BOARD_TRAIN.id)}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-detail-expanded',
      title: 'History — a saved-model run\'s expanded block',
      note: 'The reuse row expanded (the board\'s second row shape): the capital-P "Predicted 9 patients" subtitle + the endpoint line without a methods segment, the saved-model chip, the Done status, the copies note, and the expanded block\'s actions over the reuse facts.',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedFamily}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_BOARD_REUSE.id)}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-running',
      title: 'History — a running run',
      note: 'The running row: "Running" status (never a fake Done/Failed), the running subtitle, and the expanded block\'s "Open the running run" primary — the action the capability resolution exposes for a non-terminal row.',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedFamily}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_RUNNING.id)}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-copies-cleared',
      title: 'History — a copy-cleared run',
      note: 'The honest retention state: the copies note reads the negation, the row\'s primary slot renders "Use these settings again" (DEC-6 — the spec asserts the PUT body and no rerun call), and the footer\'s link flips to "Keep copies of my files" (the persisted preference).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedCopiesCleared}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_COPIES_CLEARED.id)}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-clear-all-confirm',
      title: 'History — the clear-all confirmation',
      note: 'The two-choice clear-all dialog open over the populated list: the question body, the "Clear history and remove files" / "Clear history, keep files" choices, Cancel — the spec asserts `clearRuns` fires only after a choice (INV-2).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory seed={seedFamily} apply={() => void TxrHistory.openConfirm('clear-all')} />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-log-dialog',
      title: 'History — the terminal log dialog',
      note: 'The expanded board row-1 run with its "Show the log" action: the dialog lists the fixture log capture (the mono lines, the N of M count, "Copy the log"), and the method select backfills the per-method lines (the store\'s fresh-cursor backfill).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedLogDialog}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_BOARD_TRAIN.id)}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-search',
      title: 'History — the search state',
      note: 'The toolbar\'s search over the fixture family: the spec types into the kit search field, the store\'s debounced ONE call carries the `q`, and the cassette answers the provider\'s own substring semantics (file names, method ids, set names).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() => Promise.resolve({ default: () => <HistoryStory seed={seedFamily} /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-history-filter-stopped-failed',
      title: 'History — the "Stopped or failed" filter',
      note: 'The fourth filter option selected over the family: ONE list call with the multi-value status (GAP-HIST-3 grown — the option is never a client-side sieve), showing only the failed row with the reason line in the failure red.',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedFamily}
              apply={() => TxrHistory.setFilter('stopped-failed')}
            />
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-history-many',
      title: 'History — the paged list (25 runs)',
      note: 'The 25-run fixture family: the first 20-row server page, the Load-more continuation (exactly while items.length < total — INV-1), and the second click\'s offset continuation; the request seam records every call\'s limit/offset.',
      path: '/*',
      initialPath: '/history',
      component: lazy(() => Promise.resolve({ default: () => <HistoryStory seed={seedMany} /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-history-empty',
      title: 'History — nothing here yet',
      note: 'The no-runs state: the empty line + "Runs you start appear here, newest first." and the footer\'s zero-run usage line (never a half-built list).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() => Promise.resolve({ default: () => <HistoryStory seed={seedEmpty} /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-history-error',
      title: 'History — first-load failure',
      note: 'The list read fails: the Alert + Retry over the populated chrome — never a blank page (the Retry refires the same seeded failure).',
      path: '/*',
      initialPath: '/history',
      component: lazy(() => Promise.resolve({ default: () => <HistoryStory seed={seedError} /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-history-narrow-390',
      title: 'History — the 390 px width',
      note: 'The board\'s mobile width: the toolbar stacks (search above the filter), the card header wraps, the expanded block stacks below the actions, the footer wraps — no horizontal page overflow.',
      path: '/*',
      initialPath: '/history',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <HistoryStory
              seed={seedFamily}
              apply={() => void TxrHistory.expand(TXHISTORY_RUN_BOARD_TRAIN.id)}
              narrow
            />
          ),
        }),
      ),
      fullHeight: true,
    },
  ],
}
