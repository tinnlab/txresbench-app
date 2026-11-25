/**
 * txrmodels dev-gallery surfaces (ITEM-10; PROV-UI-MODELS-6) — the module's
 * seeded stories, one per board state (the plan's nine) plus the ITEM-5 /
 * one-table / part-2 / shell-route state stories, all fed by the mock
 * cassette over the synthetic `fixtures.ts` (INV-4: every value is fixture
 * data; the boards' example facts never enter code or data).
 *
 * Stories mount the REAL pages under the gallery's MemoryRouter (the
 * `txrresults` precedent), so `useParams`/`useNavigate`/`useSearchParams`
 * behave as in the app; the pages' stores load through the mock
 * (`ApiClient.Pretrained.*` / `Models.*` / `ModelSets.*`), and the L / L2
 * dialog seams are driven through the REAL EventBus events
 * (`txrresults`' emitSaveModels / emitSaveOneModel — the same emitters
 * the results screen's buttons use).
 *
 * - `txr-models-d` / `txr-models-d-narrow-390`: the populated Pretrained
 *   board at the container width and at 390 px. The story host seeds the
 *   intake store's validated summary (the module fixture family: 42
 *   patients, four markers, draws day 0/14/28/56, decision day 60), runs
 *   the real page, and records the page's Run into
 *   `txr-models-run-result` (the `txr-list-run-result` seam convention —
 *   the component is never probed). The Run's createRun request is
 *   recorded by the story's `Txr.createRun` extension and the in-frame
 *   navigation is observed by the story's own MemoryRouter (the harness
 *   frame mounts one route; a run-created navigation would unmount the
 *   page otherwise).
 * - `txr-models-i` / `txr-models-j` / `txr-models-j-narrow-390`: the two
 *   model boards — the saved
 *   models grouped per run over the store's real load (the module
 *   cassette answers `Models.listModels` / `ModelSets.listSets` /
 *   `Models.checkEligibility`), and the Your-models table over the
 *   server-filtered inventory read (the J story's extension answers the
 *   J fixture rows; the I story's extension answers the engine's sticky
 *   analysis config — the same-outcome chip's fact source, read raw) at
 *   the container width and at 390 px (ITEM-5, RES-16).
 * - `txr-models-l` / `txr-models-l2` / `txr-models-l3`: the save dialogs
 *   over the results board (L and L2 through the real host + the real
 *   event; L3 the saved confirmation). Their extensions answer the
 *   fixture run's detail/predictions/catalogue/root reads.
 * - `txr-models-empty` / `txr-models-error`: the D page's no-file and
 *   first-load-failure states.
 *
 * The cassette's OWNED keys are this module's non-colliding ones (the
 * gallery holds ONE owner per endpoint — `mergeModuleCassettes` throws on
 * a duplicate); the keys the sibling modules own (`Txr.getRun` /
 * `Txr.getPredictions` / `Txr.listRunLogs` — `txrresults`;
 * `Txr.createRun` / `Txr.getAnalysisConfig` / `MethodCatalogue.*` ids —
 * `txrrun` / `txrlist`) are answered per-story by id-scoped
 * `extendCassette` seeds that delegate to the owner's fixtures for every
 * other id, exactly as `txrrun`'s F stories extend the txrresults table.
 * The one byte surface (`Models.exportModel`) is a `txrMockRoutes`
 * special route — the cassette answers JSON only.
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
// The app mounts the router bridge as a router effect; a story's own router
// needs it too, so the registered actions the pages run (the step Back, the
// entries that start a path) navigate inside the story.
import { RouterBridge } from '@/core/actions/navigateBridge'
import { Button } from '@txresbench/kit'
import {
  extendCassette,
  makeBinaryResponse,
  type MockRequestContext,
  type ModuleGallery,
  type SpecialRoute,
} from '@txresbench/gallery'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { AppShell } from '@/modules/txrshell/components/AppShell'
import { emitSaveModels, emitSaveOneModel } from '@/modules/txrresults/events'
import { TXR_PREDICTIONS, TXR_RUNS } from '@/modules/txrresults/fixtures'
import { TXRLIST_METHODS } from '@/modules/txrlist/fixtures'
import { PretrainedModelsPage } from './pages/PretrainedModelsPage'
import { SavedModelsPage } from './pages/SavedModelsPage'
import { ModelsPage } from './pages/ModelsPage'
import { ChooseModelsPage } from './pages/ChooseModelsPage'
import { TxrModelsDialogHost } from './components/TxrModelsDialogHost'
import { TxrSavedDialog } from './components/TxrSavedDialog'
import { TxrModels, useTxrModelsStore } from './stores/TxrModels.store'
import { isSetExpanded, toggleSetExpanded } from './lib/setExpansion'
import { ResultsPage } from '../txrresults/pages/ResultsPage'
import {
  TXRMODELS_IMPORT_OUTCOME,
  TXRMODELS_J_RESPONSE,
  TXRMODELS_METHODS,
  TXRMODELS_MODEL_DETAILS,
  TXRMODELS_MODEL_SET_LIST,
  TXRMODELS_PRETRAINED,
  TXRMODELS_PRETRAINED_ELIGIBILITY,
  TXRMODELS_PREDICT_FILE,
  TXRMODELS_PREDICTIONS,
  TXRMODELS_RESOLVE_RESPONSE,
  TXRMODELS_RUN,
  TXRMODELS_RUN_SUMMARY,
  TXRMODELS_SAVED,
  TXRMODELS_SAVED_ELIGIBILITY,
  TXRMODELS_SAVE_RESPONSE,
  TXRMODELS_SET_A,
  TXRMODELS_VALIDATION,
  txrmodelsDownloadStatus,
  txrmodelsInstallResponse,
  txrmodelsModelDetail,
  txrmodelsPretrainedCard,
} from './fixtures'

// ── the story host seam (the e2e reads this, never the component) ────────────

/** The recorded Run of the session: the createRun request body + the
 *  navigation it produced. */
interface TxrModelsRunRecord {
  body: unknown
  path: string
}

/** One recorded request of the session (the story seam's data). */
interface TxrModelsRequestRecord {
  op: 'createRun' | 'saveModels'
  body: unknown
}

/** The seam's one run record (a fresh session, one story per load). */
let txrmodelsRunRecord: TxrModelsRunRecord | null = null
const RUN_LISTENERS = new Set<() => void>()

/** The request log (every posted body the stories' cassette entries see). */
const REQUEST_LOG: TxrModelsRequestRecord[] = []
const REQUEST_LISTENERS = new Set<() => void>()

/** Subscribe to the run record (the seam's re-paint hook). */
function onRunRecord(callback: () => void): () => void {
  RUN_LISTENERS.add(callback)
  return () => {
    RUN_LISTENERS.delete(callback)
  }
}

/** Subscribe to the request log (the seam's re-paint hook). */
function onRequestRecord(callback: () => void): () => void {
  REQUEST_LISTENERS.add(callback)
  return () => {
    REQUEST_LISTENERS.delete(callback)
  }
}

/** Record one posted request (the cassette responders' one write). */
function recordRequest(op: TxrModelsRequestRecord['op'], body: unknown): void {
  REQUEST_LOG.push({ op, body })
  for (const listener of REQUEST_LISTENERS) listener()
}

/** Set the recorded run (the `Txr.createRun` extension's one write). */
function recordRun(body: unknown): void {
  recordRequest('createRun', body)
  txrmodelsRunRecord = { body, path: '' }
  for (const listener of RUN_LISTENERS) listener()
}

/** The RunResultLine: the recorded createRun body + the in-frame location. */
function RunResultLine() {
  const location = useLocation()
  const [, paint] = useState(0)
  useEffect(() => onRunRecord(() => paint(n => n + 1)))
  useEffect(() => {
    if (txrmodelsRunRecord !== null) {
      txrmodelsRunRecord = { ...txrmodelsRunRecord, path: location.pathname }
      paint(n => n + 1)
    }
  }, [location.pathname])
  const record = txrmodelsRunRecord
  return (
    <pre
      data-testid="txr-models-run-result"
      style={{ margin: 8, fontSize: 11, color: 'var(--txr-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >
      {record === null
        ? 'run not fired yet'
        : JSON.stringify({ path: record.path, body: record.body })}
    </pre>
  )
}

/** The request seam: every posted body of the session (the e2e reads what
 *  was posted, never a component — the `txr-list-run-result` precedent). */
function RequestSeam() {
  const [, paint] = useState(0)
  useEffect(() => onRequestRecord(() => paint(n => n + 1)))
  return (
    <pre
      data-testid="txr-models-request-seam"
      style={{ margin: 8, fontSize: 11, color: 'var(--txr-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >
      {JSON.stringify(REQUEST_LOG)}
    </pre>
  )
}

/** The landed seam of a dialog action (the L3 buttons' navigation). */
function LandedAt() {
  const location = useLocation()
  return (
    <pre
      data-testid="txr-models-landed"
      style={{ margin: 24, fontSize: 12, color: 'var(--txr-muted)' }}
    >
      navigated to {location.pathname}
    </pre>
  )
}

/** The story host's button that opens the L dialog (the results screen's
 *  "Save the models" entry, driven through the real event). */
function OpenLDialog({ runId, methodIds }: { runId: string; methodIds: string[] }) {
  return (
    <Button
      data-testid="txr-models-open-l"
      onClick={() => void emitSaveModels(runId, methodIds)}
      style={HOST_BUTTON}
    >
      Save the models (fixture run)
    </Button>
  )
}

/** The story host's button that opens the L2 dialog (the H header's entry). */
function OpenL2Dialog({ runId, methodId }: { runId: string; methodId: string }) {
  return (
    <Button
      data-testid="txr-models-open-l2"
      onClick={() => void emitSaveOneModel(runId, methodId)}
      style={HOST_BUTTON}
    >
      Save this model (fixture run)
    </Button>
  )
}

const HOST_BUTTON: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 10,
  fontSize: 12,
  padding: '4px 10px',
  border: '1px solid var(--txr-border)',
  borderRadius: 8,
  background: 'var(--txr-surface)',
  color: 'var(--txr-brand)',
}

/** The list-frame look (the gallery's bounded white pane). */
const FRAME: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
}

/** The gallery's note under a story (host chrome, muted). */
function BoardNote({ children }: { children: string }) {
  return <p style={{ margin: '10px 2px 0', fontSize: 12.5, color: 'var(--txr-muted)' }}>{children}</p>
}

/** A seed-then-render gate (the txrrun SeedGate idiom: the store must be
 *  seeded before the page's first render). */
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

// ── the story seeds ──────────────────────────────────────────────────────────

/**
 * The D/I stories' intake state: the validated summary of the module
 * fixture family (42 patients, four markers, draws day 0/14/28/56,
 * decision day 60) + the predict slice the reuse Run's input builder
 * reads. The store's lazy birth is replaced wholesale (the same state the
 * page unit suites seed — one shape).
 */
function seedIntake(): void {
  useTxrIntakeStore.setState({
    intent: 'predict',
    predictSource: 'lab',
    mode: 'predict',
    patients: null,
    measurements: null,
    predictMeasurements: TXRMODELS_PREDICT_FILE,
    joins: [],
    mapping: [],
    parameters: { decision_day: 60, baseline_max_day: 0 },
    validation: TXRMODELS_VALIDATION,
  })
}

/** The D story's seed: a fresh module store + intake, and the story's
 *  `Txr.createRun` answer (the key belongs to `txrrun`'s cassette; this
 *  story replays its own answer and records the request into the seam). */
function seedDStory(): void {
  TxrModels.reset()
  seedIntake()
  extendCassette({
    'Txr.createRun': (ctx: MockRequestContext) => {
      recordRun(ctx.body)
      return TXRMODELS_RUN_SUMMARY
    },
  })
}

/** The I story's seed: the fresh stores + the engine's sticky analysis
 *  config (the same-outcome chip's raw fact source — pfs, day 240). The
 *  key belongs to `txrrun`'s cassette (its empty default would make the
 *  chip honest-but-empty; this story seeds the configured state). */
function seedIStory(): void {
  TxrModels.reset()
  seedIntake()
  extendCassette({
    'Txr.getAnalysisConfig': () => ({
      config: {
        endpoint: 'pfs',
        decision_day: 60,
        look_ahead_day: 240,
        covariates: false,
        at_a_time: 3,
        save_models: false,
      },
    }),
  })
}

/** The J story's seed: the inventory answer (the J fixture rows with the
 *  board's imported row; the shared `Models.listModels` cassette is the I
 *  story's family, so this story re-answers it). Part 2: the page loads the
 *  FULL list (the search is client-side — no `q` on the wire), so the seed
 *  is the unfiltered J payload; the `?set=` focus filter stays (the URL
 *  view still sends `set_id`). */
function seedJStory(): void {
  extendCassette({
    'Models.listModels': (ctx: MockRequestContext) => {
      const setId = ctx.query.set_id ?? null
      const models =
        setId === null
          ? TXRMODELS_J_RESPONSE.models
          : TXRMODELS_J_RESPONSE.models.filter(model => model.set_id === setId)
      return { models, total: models.length, models_dir: TXRMODELS_J_RESPONSE.models_dir }
    },
  })
}

/** The expanded-set story's seed: the J story's answer + ONE set already
 *  open — the one-table round's expanded state (the module-level store the
 *  chevron writes, toggled by the same helper, so the story and the page
 *  share one truth). */
function seedJStoryExpanded(): void {
  seedJStory()
  if (!isSetExpanded(TXRMODELS_SET_A.id)) toggleSetExpanded(TXRMODELS_SET_A.id)
}

/** The L / L3 stories' seed: the fixture run's detail + predictions (the
 *  keys belong to `txrresults`' cassette — id-scoped delegation), the
 *  catalogue union (the L dialog's training-data fact source; `txrlist`
 *  owns the key), and the inventory answer that carries the models root
 *  (the L3 "in …" segment reads it). */
function seedLDialogStory(): void {
  extendCassette({
    'Txr.getRun': (ctx: MockRequestContext) =>
      ctx.params.id === 'run-c' ? TXRMODELS_RUN : TXR_RUNS[ctx.params.id],
    'Txr.getPredictions': (ctx: MockRequestContext) =>
      ctx.params.id === 'run-c'
        ? TXRMODELS_PREDICTIONS
        : TXR_PREDICTIONS[ctx.params.id],
    'MethodCatalogue.list': () => ({
      methods: [...TXRMODELS_METHODS.methods, ...TXRLIST_METHODS],
      total: TXRMODELS_METHODS.methods.length + TXRLIST_METHODS.length,
    }),
    'Models.listModels': () => TXRMODELS_J_RESPONSE,
  })
}

/** The empty story's seed: the truly fresh stores (the no-file state). */
function seedEmptyStory(): void {
  TxrModels.reset()
  useTxrIntakeStore.setState({
    intent: 'predict',
    predictSource: 'lab',
    mode: 'predict',
    patients: null,
    measurements: null,
    predictMeasurements: null,
    joins: [],
    mapping: [],
    parameters: undefined,
    validation: null,
  })
}

/** The error story's seed: the catalogue read fails (the list's error + Retry). */
function seedErrorStory(): void {
  seedDStory()
  extendCassette({
    'Pretrained.listModels': () => {
      throw new Error('fixture catalogue failure')
    },
  })
}

// ── the story views ──────────────────────────────────────────────────────────

/**
 * The D story's frame: the real page under the harness frame's parent
 * splat route, with the story's own DESCENDANT `<Routes>` (react-router's
 * "pathless layout with a trailing `*`" pattern — a nested `<Router>` is
 * rejected by the router: "you cannot render a Router inside another
 * Router"). The descendant routes match the page's own in-frame
 * navigation: the run-created `runningPath` swap shows the LandingLine
 * (the route's params bind) instead of blanking the frame, and the
 * RunResultLine/RequestSeam live outside the Routes so the recorded run
 * stays readable.
 */
function DStoryView({ narrow = false }: { narrow?: boolean }) {
  return (
    <section style={{ width: narrow ? 390 : '100%', maxWidth: '100%', minWidth: 0 }}>
      <SeedGate seed={seedDStory}>
        <RouterBridge />
        <Routes>
          <Route path="/pretrained-models" element={<PretrainedModelsPage />} />
          <Route
            path="/analysis/:runId/running"
            element={<LandingLine path="running" />}
          />
        </Routes>
        <RunResultLine />
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

/** The run-landing seam (the D Run's in-frame navigation's destination). */
function LandingLine({ path }: { path: string }) {
  return (
    <p data-testid="txr-models-d-run-landed" style={{ margin: 12, fontSize: 12, color: 'var(--txr-muted)' }}>
      {path}
    </p>
  )
}

/** The I story's frame: the real saved-models page over the seeded slice. */
function IStoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0 }}>
      <SeedGate seed={seedIStory}>
        <SavedModelsPage />
      </SeedGate>
    </section>
  )
}

/** The J story's frame: the real inventory page (web mode — the
 *  open-folder button is desktop-gated and absent here). The narrow frame
 *  is the 390 px page: the table stacks as labelled cards and the header
 *  controls wrap (ITEM-5, RES-16 — the measured 1002 px page scrollWidth
 *  is the defect this story guards). The `expanded` frame is the ONE-table
 *  state where a set is already open (the module-level store, toggled by
 *  the same helper the chevron calls); the `search` / `sortSet` frames are
 *  part 2's states — the search text and the sort are the PAGE's own
 *  component state, so the story drives the real input/button once after
 *  mount (`JStateDriver`, dev-only chrome; the page never changes for it). */
function JStoryView({
  narrow = false,
  expanded = false,
  search,
  sortName = false,
}: {
  narrow?: boolean
  expanded?: boolean
  search?: string
  sortName?: boolean
}) {
  return (
    <section style={{ width: narrow ? 390 : '100%', maxWidth: '100%', minWidth: 0 }}>
      <SeedGate seed={expanded ? seedJStoryExpanded : seedJStory}>
        <ModelsPage />
        <JStateDriver search={search} sortName={sortName} />
      </SeedGate>
    </section>
  )
}

/** The part-2 J story state drivers: after the page mounts, SEARCHES the
 *  real box (the native-setter pattern — React's controlled input ignores
 *  a plain `value` assignment; the bubbles `input` event carries it) or
 *  clicks the real Name sort header. The search input exists at mount (the
 *  page header), the sort button only after the table lands — the sort
 *  driver polls until it appears (dev-only chrome; the page never changes
 *  for it). */
function JStateDriver({ search, sortName }: { search?: string; sortName?: boolean }) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    if (search !== undefined) {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="txr-models-j-search"]',
      )
      if (input !== null) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, search)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }, [search])
  useEffect(() => {
    if (!sortName) return
    const timer = setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="txr-models-sort-name"]',
      )
      if (button === null) return
      clearInterval(timer)
      button.click()
    }, 50)
    return () => clearInterval(timer)
  }, [sortName])
  return null
}

/**
 * The L story's frame: the results board (the fixture run's G state) with
 * the REAL dialog host + the story's "Save the models" button — the same
 * event the G screen's header button emits. The dialog's own navigation
 * ("See my models" → `/models`, "Predict new patients" →
 * `/predict-files`) is observed in-frame: the parent splat route keeps the
 * story mounted and the descendant Routes swap (the host sits OUTSIDE the
 * Routes, like the real router-aware host — an L3 dialog survives the
 * navigation, as in the app).
 */
function LStoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <SeedGate seed={seedLDialogStory}>
        <RouterBridge />
        <Routes>
          <Route
            path="/analysis/:runId/results"
            element={
              <div style={FRAME}>
                <ResultsPage />
                <OpenLDialog runId={TXRMODELS_RUN.id} methodIds={TXRMODELS_RUN.method_ids} />
              </div>
            }
          />
          <Route path="*" element={<LandedAt />} />
        </Routes>
        <TxrModelsDialogHost />
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

/** The L2 story's frame: the one-model save dialog over the results board
 *  (the H one-method header's entry, the same event). */
function L2StoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <SeedGate seed={seedLDialogStory}>
        <RouterBridge />
        <Routes>
          <Route
            path="/analysis/:runId/results"
            element={
              <div style={FRAME}>
                <ResultsPage />
                <OpenL2Dialog runId={TXRMODELS_RUN.id} methodId="rm-2" />
              </div>
            }
          />
          <Route path="*" element={<LandedAt />} />
        </Routes>
        <TxrModelsDialogHost />
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

/** The L3 story's frame: the saved confirmation with its three actions. */
function L3StoryView() {
  const [closed, setClosed] = useState(false)
  return (
    <section style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <SeedGate seed={seedLDialogStory}>
        <RouterBridge />
        <Routes>
          <Route
            path="/analysis/:runId/results"
            element={
              <div style={FRAME}>
                <ResultsPage />
              </div>
            }
          />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="*" element={<LandedAt />} />
        </Routes>
        {closed ? null : (
          <TxrSavedDialog
            response={TXRMODELS_SAVE_RESPONSE}
            onClose={() => setClosed(true)}
          />
        )}
      </SeedGate>
    </section>
  )
}

/** The D empty story: the no-validated-file state. */
function EmptyStoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0 }}>
      <SeedGate seed={seedEmptyStory}>
        <PretrainedModelsPage />
      </SeedGate>
    </section>
  )
}

/** The D error story: the catalogue first-load failure. */
function ErrorStoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0 }}>
      <SeedGate seed={seedErrorStory}>
        <PretrainedModelsPage />
      </SeedGate>
    </section>
  )
}

// ── the app-shell ITEM-3 route surfaces (the real page INSIDE the real
//    shell — the audit section-4 legs of `txr-shell-routes.spec.ts`) ────────

/** The D route: the shared list's layout split inside the shell frame. */
function ShellDStoryView() {
  return (
    <SeedGate seed={seedDStory}>
      <AppShell>
        <RouterBridge />
        <Routes>
          <Route path="/pretrained-models" element={<PretrainedModelsPage />} />
          <Route path="/analysis/:runId/running" element={<LandingLine path="running" />} />
        </Routes>
      </AppShell>
      <RunResultLine />
      <RequestSeam />
    </SeedGate>
  )
}

/** The I route: the saved-models groups inside the shell frame. */
function ShellIStoryView() {
  return (
    <SeedGate seed={seedIStory}>
      <AppShell>
        <SavedModelsPage />
      </AppShell>
    </SeedGate>
  )
}

/** The J route: the inventory table inside the shell frame. */
function ShellJStoryView() {
  return (
    <SeedGate seed={seedJStory}>
      <AppShell>
        <ModelsPage />
      </AppShell>
    </SeedGate>
  )
}

// ── the merged model step (predict-card merge round 2) ───────────────────────

/** The choose story's seed: the D fixture seed + the engine's sticky
 *  analysis config (the same-outcome chip's fact source) — the merged list
 *  reads both sources (the lab catalogue AND the saved rows) in one frame. */
function seedChooseStory(): void {
  TxrModels.reset()
  seedIntake()
  extendCassette({
    'Txr.createRun': (ctx: MockRequestContext) => {
      recordRun(ctx.body)
      return TXRMODELS_RUN_SUMMARY
    },
    'Txr.getAnalysisConfig': () => ({
      config: {
        endpoint: 'pfs',
        decision_day: 60,
        look_ahead_day: 240,
        covariates: false,
        at_a_time: 3,
        save_models: false,
      },
    }),
  })
}

/** The choose-none story's seed: no catalogue rows AND no owned rows (the
 *  panel's exact state — every count known and 0). */
function seedChooseNoneStory(): void {
  seedChooseStory()
  extendCassette({
    'Pretrained.listModels': () => ({ models: [], total: 0, origin: 'disk' }),
    'Models.listModels': () => ({ models: [], total: 0 }),
  })
}

/** The merged list's run-landing seam (the D seam's row — the story records
 *  the posted bytes and observes the in-frame navigation). */
function LandingLineChoose({ path }: { path: string }) {
  return (
    <p data-testid="txr-models-choose-run-landed" style={{ margin: 12, fontSize: 12, color: 'var(--txr-muted)' }}>
      {path}
    </p>
  )
}

/** The choose story's frame: the merged page under the harness frame's
 *  splat route with its own descendant Routes (the run's in-frame
 *  navigation shows the landing line instead of blanking the frame). */
function ChooseStoryView({ narrow = false }: { narrow?: boolean }) {
  return (
    <section style={{ width: narrow ? 390 : '100%', maxWidth: '100%', minWidth: 0 }}>
      <SeedGate seed={seedChooseStory}>
        <RouterBridge />
        <Routes>
          <Route path="/choose-models" element={<ChooseModelsPage />} />
          <Route path="/analysis/:runId/running" element={<LandingLineChoose path="running" />} />
        </Routes>
        <RunResultLine />
        <RequestSeam />
      </SeedGate>
    </section>
  )
}

/** The choose-none story's frame: the no-models panel (the same frame, the
 *  none seed). */
function ChooseNoneStoryView() {
  return (
    <section style={{ width: '100%', minWidth: 0 }}>
      <SeedGate seed={seedChooseNoneStory}>
        <RouterBridge />
        <Routes>
          <Route path="/choose-models" element={<ChooseModelsPage />} />
        </Routes>
      </SeedGate>
    </section>
  )
}

/** The choose route inside the real shell (the ITEM-3 route byte). */
function ShellChooseStoryView() {
  return (
    <SeedGate seed={seedChooseStory}>
      <AppShell>
        <RouterBridge />
        <Routes>
          <Route path="/choose-models" element={<ChooseModelsPage />} />
          <Route path="/analysis/:runId/running" element={<LandingLineChoose path="running" />} />
        </Routes>
      </AppShell>
      <RunResultLine />
      <RequestSeam />
    </SeedGate>
  )
}

// ── the module's gallery seed ────────────────────────────────────────────────

/** The module's cassette: the JSON operations this node consumes and no
 *  other module's cassette owns (the sibling-owned keys are the stories'
 *  id-scoped extensions, `txrrun`'s precedent). The response values are
 *  the `fixtures.ts` payloads (synthetic, never a board example). */
export const gallery: ModuleGallery = {
  cassette: {
    // the pretrained catalogue + verdicts + download manager (D)
    'Pretrained.listModels': () => ({
      models: TXRMODELS_PRETRAINED,
      total: TXRMODELS_PRETRAINED.length,
      origin: 'disk',
    }),
    'Pretrained.checkEligibility': () => TXRMODELS_PRETRAINED_ELIGIBILITY,
    'Pretrained.downloadModel': (ctx: MockRequestContext) =>
      txrmodelsDownloadStatus(ctx.params.id),
    'Pretrained.listDownloads': () => ({
      downloads: TXRMODELS_PRETRAINED.map(card => txrmodelsDownloadStatus(card.id)),
    }),
    'Pretrained.installModel': (ctx: MockRequestContext) =>
      txrmodelsInstallResponse(ctx.params.id),
    'Pretrained.getModel': (ctx: MockRequestContext) =>
      txrmodelsPretrainedCard(ctx.params.id),
    // the saved-model inventory + sets + verdicts (I/J)
    'Models.listModels': () => ({
      models: TXRMODELS_SAVED,
      total: TXRMODELS_SAVED.length,
    }),
    'Models.getModel': (ctx: MockRequestContext) =>
      TXRMODELS_MODEL_DETAILS.get(ctx.params.id) ??
      txrmodelsModelDetail(TXRMODELS_SAVED[0]!),
    'Models.checkEligibility': () => TXRMODELS_SAVED_ELIGIBILITY,
    'ModelSets.listSets': () => TXRMODELS_MODEL_SET_LIST,
    'ModelSets.renameSet': (ctx: MockRequestContext) => ({
      ...TXRMODELS_SET_A,
      name: (ctx.body as { name?: string } | undefined)?.name ?? TXRMODELS_SET_A.name,
    }),
    'ModelSets.deleteSet': () => undefined,
    // The set export is a byte surface (like the model export — the cassette
    // answers JSON only); the J story's buttons render and the rename /
    // delete flows work, an export click answers undefined (the story does
    // not assert the download bytes).
    'ModelSets.exportSet': () => undefined,
    // the row actions (J) + the save dialogs
    'Models.renameModel': (ctx: MockRequestContext) => ({
      ...TXRMODELS_SAVED[0]!,
      name: (ctx.body as { name?: string } | undefined)?.name ?? TXRMODELS_SAVED[0]!.name,
    }),
    'Models.deleteModel': () => undefined,
    'Models.importModel': () => TXRMODELS_IMPORT_OUTCOME,
    'Models.saveModels': (ctx: MockRequestContext) => {
      recordRequest('saveModels', ctx.body)
      return TXRMODELS_SAVE_RESPONSE
    },
    'Models.resolveModels': () => TXRMODELS_RESOLVE_RESPONSE,
  },

  seeded: [
    {
      slug: 'txr-models-d',
      title: 'Choose the models to run (screen D)',
      note: 'The board\'s Step 4 with the module fixture catalogue over the seeded intake summary: the seven cards (6 runnable — 4 fit + 2 some — 1 cannot), the four chips, the Sort by select, the selection-driven total, the research notice, and the downloads strip when a not-yet-installed card is checked; the Model card dialog from the row action; Run installs → resolves → creates and the story records the posted bytes.',
      path: '/*',
      initialPath: '/pretrained-models',
      component: lazy(() => Promise.resolve({ default: DStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-d-narrow-390',
      title: 'Choose the models to run at 390 px',
      note: 'The board\'s mobile width: the header, the list rows and the bottom bar stack inside the frame, no horizontal page overflow.',
      path: '/*',
      initialPath: '/pretrained-models',
      component: lazy(() =>
        Promise.resolve({ default: () => <DStoryView narrow /> }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-models-i',
      title: 'Choose the saved models (screen I)',
      note: 'The two saved sets (the fixture run groups) with their run-facts lines, the section select-alls and the Rename/Delete actions, the Same-outcome chip over the engine\'s sticky config, the find-a-model-or-run search, the board\'s sorts, the research notice.',
      path: '/saved-models',
      initialPath: '/saved-models',
      component: lazy(() => Promise.resolve({ default: IStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-j',
      title: 'Your models (screen J)',
      note: 'The ONE-table inventory over the full read (sort/search are the page\'s now, not the server\'s): a set row ("folder") per set — Made newest first by default with folders on top (the set rows first, the no-set imported row as a plain top-level row after them, never mixed in); chevron disclosure, the folder glyph, the name with the "(N)" count beside it (the screen-reader-only "N models" text), the run-source facts line under the name, the Made date, the Rename/Export/Delete set actions — CLOSED by default; the board columns (Name | Method | Predicts | Decision day | Trained on | Made), the run-trained / imported / unrecorded rows, the any-marker + set sublines (ITEM-5), the sortable Name and Made headers (buttons inside the aria-sort th), the ONE Search sets and models box (client-side), the Open-a-model-file button, the footnotes (web mode — no open-folder button).',
      path: '/models',
      initialPath: '/models',
      component: lazy(() => Promise.resolve({ default: JStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-j-expanded',
      title: 'Your models — one set expanded (screen J)',
      note: 'The one-table round\'s expanded state: set-a is already OPEN (the module-level store the chevron writes), so its two model rows sit indented below the folder row, the other set stays closed, and the no-set imported row remains a plain top-level row after every set — the table\'s rows scroll inside the window-filling box.',
      path: '/models',
      initialPath: '/models',
      component: lazy(() => Promise.resolve({ default: () => <JStoryView expanded /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-j-narrow-390',
      title: 'Your models at 390 px (screen J)',
      note: 'The board\'s mobile width: the seven-column one-table stacks as labelled cards inside the same window-filling box (a folder row is a card: name + count + facts on top, actions wrapped below; empty entries carry no card — the merged Name column labels a model row "Name"), the search box takes the row and the Open-a-model-file button stays inside the viewport — no horizontal page overflow (ITEM-5, RES-16).',
      path: '/models',
      initialPath: '/models',
      component: lazy(() =>
        Promise.resolve({ default: () => <JStoryView narrow /> }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-models-j-search',
      title: 'Your models — client-side search (screen J)',
      note: 'Part 2\'s search state: the ONE box holds "cox" — a MODEL match on both sets (fm-11, fm-12, fm-15) — so the folder rows are FORCED expanded with only the matches (the store was never written: the chevrons flip back to closed when the search clears) and the Name cell reads the "(1 of 7 models match)" / "(2 of 3 models match)" counts.',
      path: '/models',
      initialPath: '/models',
      component: lazy(() => Promise.resolve({ default: () => <JStoryView search="cox" /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-j-sort-name',
      title: 'Your models — sorted by Name A→Z (screen J)',
      note: 'Part 2\'s sort state: the Name header is the active sort (aria-sort=ascending, the direction arrow beside the word), the sets are A→Z (CRC cohort before Lung pilot), and the no-set imported row stays AFTER every set — sorted on its own block by its own name in both directions.',
      path: '/models',
      initialPath: '/models',
      component: lazy(() => Promise.resolve({ default: () => <JStoryView sortName /> })),
      fullHeight: true,
    },
    {
      slug: 'txr-shell-route-models',
      title: 'Your models (screen J) inside the shell',
      note: 'The app-shell ITEM-3 route byte: the title + search + import + the set-focus banner fixed, the ONE table in the window-filling box (the page\'s ScrollRegion — its sticky thead pins to the box top, the rows scroll inside the box, the page does not scroll), the stored-in + deletion footnotes pinned in the fixed bottom bar. The audit section-4 legs (test: `txr-shell-routes.spec.ts`).',
      path: '/models',
      initialPath: '/models',
      component: lazy(() => Promise.resolve({ default: ShellJStoryView })),
    },
    {
      slug: 'txr-shell-route-saved-models',
      title: 'Choose the saved models (screen I) inside the shell',
      note: 'The app-shell ITEM-3 route byte: the step + title + checked line + use-example + the shared list\'s toolbar fixed, the grouped rows in the ONE region (the shared list\'s layout split — the region is the row stream\'s scrollport), the counters + Run pinned in the fixed bottom bar.',
      path: '/saved-models',
      initialPath: '/saved-models',
      component: lazy(() => Promise.resolve({ default: ShellIStoryView })),
    },
    {
      slug: 'txr-shell-route-pretrained-models',
      title: 'Choose the models to run (screen D) inside the shell',
      note: 'The app-shell ITEM-3 route byte: the step + title + checked line + totals + the shared list\'s toolbar (and the downloads strip) fixed, the catalogue rows in the ONE region (the shared list\'s layout split), the counters + research notice + Run pinned in the fixed bottom bar.',
      path: '/*',
      initialPath: '/pretrained-models',
      component: lazy(() => Promise.resolve({ default: ShellDStoryView })),
    },
    {
      slug: 'txr-models-choose',
      title: 'Choose the models to run (the merged list)',
      note: 'The predict-card merge round 2 board: the three sources in ONE flat list — the lab catalogue rows (with their small-caps "From the lab" label, the Published/Learned chip, the transfer fact) and the saved + imported rows ("Saved"/"Imported", the run name in the subtitle, the Trained-by-you/Imported chip) — no double row for a downloaded lab model; the source chips (From the lab / Saved / Imported, a 0-count chip stays visible, disabled), the lab-only chips shown because the catalogue has rows, the Same-outcome chip over all rows, the search over the run name, the sorts with the merged default rule, the downloads strip, the mixed-day reason, and one reuse Run recorded by the story.',
      path: '/*',
      initialPath: '/choose-models',
      component: lazy(() => Promise.resolve({ default: ChooseStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-choose-narrow-390',
      title: 'Choose the models to run at 390 px (the merged list)',
      note: 'The merged board\'s mobile width: the header, the list rows and the bottom bar stack inside the frame, no horizontal page overflow.',
      path: '/*',
      initialPath: '/choose-models',
      component: lazy(() =>
        Promise.resolve({ default: () => <ChooseStoryView narrow /> }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-models-choose-none',
      title: 'No models to choose from yet (the merged list)',
      note: 'The round-2 panel: every source count known and 0 — the title, the pick-one-of-these line, the three options with their buttons (Use example / Learn from my data / Open a model file), and the bottom bar with Run disabled beside "There is no model to run yet."',
      path: '/*',
      initialPath: '/choose-models',
      component: lazy(() => Promise.resolve({ default: ChooseNoneStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-shell-route-choose-models',
      title: 'Choose the models to run (the merged list) inside the shell',
      note: 'The app-shell ITEM-3 route byte for the round-2 board: the step + title + checked line + totals + the shared list\'s toolbar fixed, the merged rows in the ONE region, the counters + research notice + Run pinned in the fixed bottom bar.',
      path: '/*',
      initialPath: '/choose-models',
      component: lazy(() => Promise.resolve({ default: ShellChooseStoryView })),
    },
    {
      slug: 'txr-models-l',
      title: 'Save the models (screen L)',
      note: 'The save-set dialog over the results board: the produced-model checklist with sizes + group labels, the count line, Select none / Only the small ones, the cannot-run note, the training-data warning, the keep-training-files + also-export options; Save posts the PROV-MS-3 body and the L3 confirmation replaces the dialog.',
      path: '/*',
      initialPath: `/analysis/${TXRMODELS_RUN.id}/results`,
      component: lazy(() => Promise.resolve({ default: LStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-l2',
      title: 'Save this model (screen L2)',
      note: 'The one-model save dialog: the summary line, the "Save it in" select (a new set first + the two existing sets with their counts), the new-set name field, the target arms of the posted body.',
      path: '/*',
      initialPath: `/analysis/${TXRMODELS_RUN.id}/results`,
      component: lazy(() => Promise.resolve({ default: L2StoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-l3',
      title: 'Models saved (screen L3)',
      note: 'The saved confirmation: the count + the set name + the Σ size with the real models root, and the three actions (predict with them, see my models, done).',
      path: '/*',
      initialPath: `/analysis/${TXRMODELS_RUN.id}/results`,
      component: lazy(() => Promise.resolve({ default: L3StoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-empty',
      title: 'Choose the models to run — no file',
      note: 'The not-ready state: no validated predict file — the honest line + the measurements-step CTA (ITEM-5, RES-20), never a half-built list.',
      path: '/pretrained-models',
      initialPath: '/pretrained-models',
      component: lazy(() => Promise.resolve({ default: EmptyStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-models-error',
      title: 'Choose the models to run — catalogue failure',
      note: 'The first-load failure of the catalogue read: the list\'s error line + Retry.',
      path: '/pretrained-models',
      initialPath: '/pretrained-models',
      component: lazy(() => Promise.resolve({ default: ErrorStoryView })),
      fullHeight: true,
    },
  ],
}

// ── the byte route (the cassette answers JSON only) ─────────────────────────

/** One mock route of the module (the op label keeps the surface auditable). */
export interface TxrModelsMockRouteEntry {
  op: 'exportModel'
  route: SpecialRoute
}

/**
 * The module's one special mock route (registered by the dev gallery's
 * `mountGallery`): the model export as raw bytes — a fixture byte string,
 * never a model file (INV-7: the module never reads, parses or mounts one;
 * the J story never opens it — the route exists so a spec that does is
 * answered honestly).
 */
export const txrMockRoutes: TxrModelsMockRouteEntry[] = [
  {
    op: 'exportModel',
    route: {
      test: (path: string) => /^\/api\/txr\/models\/[^/]+\/export$/.test(path),
      respond: () =>
        makeBinaryResponse(
          new TextEncoder().encode('txr fixture bytes'),
          'application/octet-stream',
        ),
    },
  },
]
