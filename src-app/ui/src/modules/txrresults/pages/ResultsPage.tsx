import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { Button, ErrorState, Skeleton } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import type { TxrRunDetail } from '@/api-client/types'
import type { TxrOutcomeKey } from '../types'
import { TxrResults, useTxrResultsStore } from '../stores/Results.store'
import { buildColumns, viewOf } from '../lib/heatmap'
import { TxrResultsHeader } from '../components/TxrResultsHeader'
import { TxrCannotRunBanner } from '../components/TxrCannotRunBanner'
import { TxrOutcomeTabs } from '../components/TxrOutcomeTabs'
import { TxrMethodFilterBar } from '../components/TxrMethodFilterBar'
import { TxrHeatmapTable } from '../components/TxrHeatmapTable'
import { TxrLogDialog } from '../components/TxrLogDialog'

/**
 * Screen G — the run's predictions (board `BusyResults.dc.html`): the
 * patient × method heatmap of one analysis run, readable while the run
 * continues (INV-1), composed from the ITEM-6/7 presentational parts and
 * driven entirely by the ITEM-5 results store.
 *
 * The page OWNS the state machine (DEC-18):
 * - `load(runId)` on mount (reset-on-load inside the store: a different
 *   run id never bleeds into this URL's view), detail → predictions →
 *   stream, exactly as the store sequences it;
 * - run `404` → the not-found state (message + "New analysis" CTA, no
 *   crash); any detail-network failure → the error state with a retry that
 *   re-runs `load`;
 * - `409 PREDICTIONS_UNAVAILABLE` → the empty-heatmap state: header (the
 *   counts + the cannot-run banners) + a disabled download, NO spinner
 *   loop — the SSE keeps delivering and a `prediction` frame turns it
 *   into a real column set;
 * - the predictions' network failure → the same error state (retry re-runs
 *   `load`), except when a LAST SNAPSHOT exists: the snapshot stays
 *   rendered (a refresh blip on a live run never blanks the table, INV-1).
 *
 * The composition is the board's: header → cannot-run banners → the
 * controls row (outcome tabs + search/sort/methods bar) → the heatmap.
 * The page derives the view through `lib/heatmap.ts` at render time (the
 * ONE derivation path; the components are presentational). The three
 * header actions wire here: download (ITEM-10 lifts this page-local
 * plumbing into `lib/download.ts`), save-models (the header emits the
 * framework event; the host is `ui-models`), New analysis (`/`).
 */

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '24px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minWidth: 0,
}

const CONTROLS_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
}

const NOT_FOUND_BLOCK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  maxWidth: 460,
}

const NOT_FOUND_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 22,
  lineHeight: 1.3,
}

const DOWNLOAD_ERROR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#f0c9c4',
  borderRadius: 8,
  background: '#fdf3f2',
  fontSize: 14,
}

/**
 * The one run endpoint key the normalize fallback needs (CONS-UR-8/DEC-4).
 * The generated `TxrEndpoint` is exactly `pfs | os`, so this is closed.
 */
function endpointKeyOf(run: TxrRunDetail): TxrOutcomeKey {
  const endpoint = run.outcome?.endpoint ?? run.config?.endpoint
  return endpoint === 'os' ? 'os' : 'pfs'
}

/**
 * Save `text` as the `predictions-<runId>.csv` download — the blob + anchor
 * pattern (`ProvenanceExport` precedent): the anchor is appended to the
 * document (browsers need it in the tree), clicked, removed, and the object
 * URL revoked on the same tick. ITEM-10's `lib/download.ts` takes over this
 * plumbing (PROV-UR-6) and its own test (TEST-UR-8) pins it there.
 */
function saveTextAsFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * The predictor CSV, byte passthrough through the generated client (the
 * transport resolves `text/csv` to the response text — the generated type
 * says `void`, so the one-seam cast with a byte guard keeps a bodiless
 * response loud instead of silently saving nothing). Downloading requires
 * no terminal run state: the engine's CSV is served while the run is
 * active, so the button works exactly when predictions are not
 * `'unavailable'` (the ITEM-6 boundary).
 *
 * Exported so screen H's page shares the plumbing; ITEM-10 lifts it into
 * `lib/download.ts` and both pages switch to the barrel export (PLAN note
 * (ag)).
 */
export function downloadPredictions(runId: string): Promise<void> {
  return ApiClient.Txr.downloadPredictions({ id: runId }).then(body => {
    const text = body as unknown as string
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('the predictions download came back empty')
    }
    saveTextAsFile(`predictions-${runId}.csv`, text)
  })
}

function LoadingResults() {
  return (
    <div data-testid="txr-results-loading" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Skeleton style={{ width: 320, height: 26 }} />
        <Skeleton style={{ width: 480, height: 16 }} />
      </div>
      <Skeleton style={{ width: '100%', height: 340 }} />
    </div>
  )
}

function NotFoundResults({ onNewAnalysis }: { onNewAnalysis: () => void }) {
  return (
    <div data-testid="txr-results-not-found" style={NOT_FOUND_BLOCK}>
      <h2 style={NOT_FOUND_TITLE}>This analysis run could not be found</h2>
      <p style={{ margin: 0, fontSize: 14, color: '#3a3a3a' }}>
        It may have been removed, or the link is outdated.
      </p>
      <Button
        data-testid="txr-results-new-analysis"
        variant="outline"
        onClick={onNewAnalysis}
        className="rounded-lg font-semibold"
        style={{ padding: '9px 16px' }}
      >
        New analysis
      </Button>
    </div>
  )
}

export function ResultsPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const state = useStore(useTxrResultsStore)
  const {
    run,
    runError,
    predictions,
    predictionsError,
    predictionsLoading,
    outcomeTab,
    methodFilter,
    search,
    sort,
    patientLimit,
  } = state
  const [downloadFailed, setDownloadFailed] = useState(false)

  // Load on mount + on a run-id change; the store resets first and drops
  // the previous run's in-flight work (no cross-run bleed, DEC-3).
  useEffect(() => {
    if (runId) void TxrResults.load(runId)
  }, [runId])

  // The derived projection, computed on EVERY render path (hooks rule — the
  // early returns below must not change the hook order): the memos are
  // no-ops while the run or its predictions are absent, and the state
  // machine renders them only after the null guards.
  const endpointKey = run ? endpointKeyOf(run) : 'pfs'
  const allColumns = useMemo(
    () => (predictions ? buildColumns(predictions, endpointKey) : []),
    [predictions, endpointKey],
  )
  const horizon = run?.outcome?.horizon ?? run?.config?.look_ahead_day ?? 0
  const labelDay = run?.config?.label_day ?? null
  // The bar operates on the active outcome tab's columns at the unfiltered
  // picker state (the ITEM-6 contract); the view below applies the user's
  // filters (DEC-5/6).
  const pickerColumns = useMemo(
    () =>
      predictions
        ? viewOf(allColumns, predictions, {
            outcome: outcomeTab,
            groups: null,
            methodIds: null,
            search: '',
            sort,
            limit: 0,
          }).columns
        : [],
    [allColumns, predictions, outcomeTab, sort],
  )
  const view = useMemo(
    () =>
      predictions
        ? viewOf(allColumns, predictions, {
            outcome: outcomeTab,
            groups: methodFilter?.groups ?? null,
            methodIds: methodFilter?.methodIds ?? null,
            search,
            sort,
            limit: patientLimit,
          })
        : null,
    [allColumns, predictions, outcomeTab, methodFilter, search, sort, patientLimit],
  )

  if (runError === 'not-found') {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <NotFoundResults onNewAnalysis={() => navigate('/')} />
      </main>
    )
  }

  const errorRetry = () => {
    if (runId) void TxrResults.load(runId)
  }

  // The page's error state covers BOTH the run-detail failure and the
  // predictions failure without a snapshot (one retry: re-running `load`,
  // DEC-18). With a snapshot the content branch below keeps rendering it.
  if (runError === 'network' || (run !== null && predictions === null && predictionsError === 'network')) {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <ErrorState
          variant="page"
          resource="the run"
          description="The results could not be loaded right now. Check that the app server is running, then try again."
          onRetry={errorRetry}
          data-testid="txr-results-error"
        />
      </main>
    )
  }

  // Loading: the detail is still in flight, or the first predictions fetch
  // is — the skeleton never reappears over a loaded snapshot.
  if (run === null || (predictions === null && predictionsLoading)) {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <LoadingResults />
      </main>
    )
  }

  const cannotRun = run.methods.filter(m => m.state === 'cannot_run')

  // The 409 empty-heatmap state: header (counts + banners) + a disabled
  // download, NO table, NO spinner loop — the SSE's `prediction` frame
  // fills the columns without a reload (INV-1, EXAMPLE-UR-4).
  if (predictions === null) {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <TxrResultsHeader
          run={run}
          predictions={null}
          predictionsError={predictionsError}
          onDownload={undefined}
        />
        <TxrCannotRunBanner
          methods={cannotRun}
          total={run.methods.length}
          onShowLog={methodId => TxrResults.openLog(methodId)}
        />
        <TxrLogDialog />
      </main>
    )
  }

  // Every guard above passed: the run + the snapshot are present (the view
  // memo is non-null; the check is the type narrow, unreachable in practice).
  if (view === null) return null

  const handleDownload = () => {
    if (!runId) return
    setDownloadFailed(false)
    void downloadPredictions(runId).catch(() => setDownloadFailed(true))
  }

  return (
    <main data-testid="txr-results" style={PAGE_MAIN}>
      <TxrResultsHeader
        run={run}
        predictions={predictions}
        predictionsError={predictionsError}
        onDownload={handleDownload}
      />
      <TxrCannotRunBanner
        methods={cannotRun}
        total={run.methods.length}
        onShowLog={methodId => TxrResults.openLog(methodId)}
      />
      {downloadFailed ? (
        <div data-testid="txr-results-download-error" role="alert" style={DOWNLOAD_ERROR}>
          The predictions could not be downloaded. Try again.
        </div>
      ) : null}
      <div style={CONTROLS_ROW}>
        <TxrOutcomeTabs
          columns={allColumns}
          active={outcomeTab}
          horizon={horizon}
          labelDay={labelDay}
          onChange={tab => TxrResults.setOutcomeTab(tab)}
        />
        <TxrMethodFilterBar
          columns={pickerColumns}
          filter={methodFilter}
          search={search}
          sort={sort}
          onFilterChange={filter => TxrResults.setMethodFilter(filter)}
          onSearchChange={value => TxrResults.setSearch(value)}
          onSortChange={value => TxrResults.setSort(value)}
        />
      </div>
      <TxrHeatmapTable view={view} onShowAll={() => TxrResults.setPatientLimit(-1)} />
      <TxrLogDialog />
    </main>
  )
}
