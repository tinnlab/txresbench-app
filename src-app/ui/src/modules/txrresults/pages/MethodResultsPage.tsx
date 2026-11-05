import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { Button, ErrorState, Skeleton } from '@ziee/kit'
import { isDesktop } from '@/core/platform'
import type { TxrRunDetail } from '@/api-client/types'
import { TxrResults, useTxrResultsStore } from '../stores/Results.store'
import { buildColumns, compareReport, divergentPatients, sortByFirstMethod, viewOf } from '../lib/heatmap'
import { compareResultsPath, methodResultsPath } from '../routes'
import { TxrResultsHeader } from '../components/TxrResultsHeader'
import { TxrCannotRunBanner } from '../components/TxrCannotRunBanner'
import { TxrMethodTabs } from '../components/TxrMethodTabs'
import { TxrOutcomeTabs } from '../components/TxrOutcomeTabs'
import { TxrBarsTable } from '../components/TxrBarsTable'
import { TxrCompareCard } from '../components/TxrCompareCard'
import { TxrMethodAside } from '../components/TxrMethodAside'
import { TxrChanceDialog } from '../components/TxrChanceDialog'
import { TxrLogDialog } from '../components/TxrLogDialog'
import { downloadPredictions } from './ResultsPage'
import type { TxrOutcomeKey } from '../types'

/**
 * Screen H — one run's methods in detail (boards `Results.dc.html` /
 * `SaveOne.dc.html`): the method tablist (Compare methods = the URL's
 * `/results/compare` route, one mono tab per finished method = the
 * `/results/methods/:methodId` route — the URL segment is the active tab,
 * URL-as-view INV-6), the outcome tabs, the patient × method bar table
 * (sorted by the FIRST method, DEC-6), the two-method compare card with the
 * divergent-only toggle (compare tab), the explanatory aside
 * (TxrMethodAside + the chance dialog + the saved-in/open-folder line) and
 * the header actions (the H board's "Download predictions (CSV)", the
 * one-method "Save this model" — SaveOne board — or the run's
 * "Save the models (N)", New analysis).
 *
 * The page owns the same state machine as screen G (DEC-18 — both results
 * URLs share it): 404 → not-found, detail/predictions network failure →
 * error + retry, 409 → the empty state (header + banners + disabled
 * download), otherwise the H content. The derivation is the SAME view model
 * (ITEM-4): one `viewOf` pass gives the active outcome tab's columns and
 * rows; the H-specific order is `sortByFirstMethod` (DEC-6) applied BEFORE
 * the store's patient window, the divergent filter is
 * `divergentPatients`, and the compare card is `compareReport` over the
 * first two columns (ITEM-4 note (p): cols[0]/cols[1] are the compared
 * methods; a one-method tab carries no compare segment).
 *
 * The store's search/sort/method-group controls are G's (the H board has no
 * search or filter bar): H derives with an unfiltered, patient-ordered
 * base view — the H sort is the board's "sorted by the first method", the
 * row window is the shared "Showing N of M" (the Show-all raises the same
 * `patientLimit`).
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

/** The board's two-column content row: the bar-table section + the aside. */
const CONTENT_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 28,
  alignItems: 'flex-start',
}

const TABLE_SECTION: CSSProperties = { flex: '1 1 560px', minWidth: 0 }

const ASIDE_COLUMN: CSSProperties = {
  flex: '1 1 300px',
  maxWidth: 420,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
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

/** The one run endpoint key the normalize fallback needs (the generated `TxrEndpoint` is closed). */
function endpointKeyOf(run: TxrRunDetail): TxrOutcomeKey {
  const endpoint = run.outcome?.endpoint ?? run.config?.endpoint
  return endpoint === 'os' ? 'os' : 'pfs'
}

/**
 * The folder-reveal seam's page wiring (PROV-UR-7, staged here until
 * ITEM-10's `lib/reveal.ts` takes it over — the ITEM-8 download-plumbing
 * precedent): only ever invoked under `isDesktop()`; a failed reveal is
 * swallowed to the path-only rendering (web mode renders no button at all,
 * TEST-UR-16's positive control).
 */
function revealRunDir(dir: string): Promise<void> {
  if (!isDesktop()) return Promise.resolve()
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__
  const invoke = tauri?.core?.invoke
  if (!invoke) return Promise.resolve()
  return invoke('reveal_in_file_manager', { path: dir }).then(
    () => undefined,
    () => undefined,
  )
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

export function MethodResultsPage() {
  const { runId, methodId } = useParams<{ runId: string; methodId?: string }>()
  const navigate = useNavigate()
  const state = useStore(useTxrResultsStore)
  const {
    run,
    runError,
    predictions,
    predictionsError,
    predictionsLoading,
    outcomeTab,
    patientLimit,
    divergentOnly,
    chanceDialogOpen,
  } = state
  const [downloadFailed, setDownloadFailed] = useState(false)

  // Load on mount + on a run-id change (the store resets first; a different
  // run id never bleeds into this URL's view, DEC-3).
  useEffect(() => {
    if (runId) void TxrResults.load(runId)
  }, [runId])

  // The derivation, computed on EVERY render path (the early returns must
  // not change the hook order — the ITEM-8 note (ai) rule).
  const endpointKey = run ? endpointKeyOf(run) : 'pfs'
  const allColumns = useMemo(
    () => (predictions ? buildColumns(predictions, endpointKey) : []),
    [predictions, endpointKey],
  )
  const horizon = run?.outcome?.horizon ?? run?.config?.look_ahead_day ?? 0
  const labelDay = run?.config?.label_day ?? null
  const responseDay = labelDay ?? horizon
  // The H base view: the active outcome tab's columns + rows, UNFILTERED
  // (H has no search/method-group controls — those are G's), patient-ordered
  // (the H sort is the first method's, DEC-6), unwindowed (the H window
  // applies after the first-method sort AND the divergent filter).
  const baseView = useMemo(
    () =>
      predictions
        ? viewOf(allColumns, predictions, {
            outcome: outcomeTab,
            groups: null,
            methodIds: null,
            search: '',
            sort: 'patient',
            limit: 0,
          })
        : null,
    [allColumns, predictions, outcomeTab],
  )
  // The active method tab: the URL's method id when it names a finished
  // method; anything else (the `compare` segment, an unknown id) is the
  // Compare tab — DEC-18's fallback, the URL stays as-is.
  const activeMethodId = methodId && allColumns.some(c => c.methodId === methodId) ? methodId : null
  const firstMethodId = activeMethodId ?? baseView?.columns[0]?.methodId ?? ''
  const orderedRows = useMemo(
    () => (baseView ? sortByFirstMethod(baseView.columns, baseView.rows, firstMethodId) : []),
    [baseView, firstMethodId],
  )
  const divergentIds = useMemo(() => {
    if (!divergentOnly || !baseView || baseView.columns.length < 2) return null
    const a = baseView.columns[0].methodId
    const b = baseView.columns[1].methodId
    return new Set(divergentPatients(baseView.columns, orderedRows, a, b))
  }, [divergentOnly, baseView, orderedRows])
  const tableRows = useMemo(() => {
    const filtered = divergentIds ? orderedRows.filter(r => divergentIds.has(r.patientId)) : orderedRows
    return patientLimit > 0 ? filtered.slice(0, patientLimit) : filtered
  }, [orderedRows, divergentIds, patientLimit])
  const totalCount = divergentIds ? divergentIds.size : orderedRows.length
  // The compare card: compare tab only (a one-method tab is not a
  // two-method comparison — ITEM-4 note (p)), over the full row set.
  const compareReportData = useMemo(
    () => (baseView && baseView.columns.length >= 2 ? compareReport(baseView.columns, baseView.rows) : null),
    [baseView],
  )
  // The compare tab only (a one-method tab is not a two-method comparison —
  // ITEM-4 note (p)); the narrowed variable carries the report to the card.
  const cardReport =
    activeMethodId === null && compareReportData !== null ? compareReportData : null
  // The one-method "Save this model" (SaveOne board): only a finished
  // method with a produced model — TEST-UR-10's gate.
  const saveOneMethodId =
    activeMethodId && run?.methods.some(m => m.method_id === activeMethodId && m.state === 'finished') && run.models.some(m => m.method_id === activeMethodId)
      ? activeMethodId
      : null

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

  if (run === null || (predictions === null && predictionsLoading)) {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <LoadingResults />
      </main>
    )
  }

  const cannotRun = run.methods.filter(m => m.state === 'cannot_run')

  // The 409 empty-heatmap state (DEC-18: banner + counts + disabled
  // download, no spinner loop — the SSE fills it).
  if (predictions === null) {
    return (
      <main data-testid="txr-results" style={PAGE_MAIN}>
        <TxrResultsHeader
          run={run}
          predictions={null}
          predictionsError={predictionsError}
          onDownload={undefined}
          downloadLabel="Download predictions (CSV)"
        />
        <TxrCannotRunBanner
          methods={cannotRun}
          total={run.methods.length}
          onShowLog={method => TxrResults.openLog(method)}
        />
      </main>
    )
  }

  if (baseView === null) return null

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
        downloadLabel="Download predictions (CSV)"
        saveOne={saveOneMethodId}
      />
      <TxrCannotRunBanner
        methods={cannotRun}
        total={run.methods.length}
        onShowLog={method => TxrResults.openLog(method)}
      />
      {downloadFailed ? (
        <div data-testid="txr-results-download-error" role="alert" style={DOWNLOAD_ERROR}>
          The predictions could not be downloaded. Try again.
        </div>
      ) : null}
      <TxrMethodTabs
        columns={allColumns}
        activeMethodId={activeMethodId}
        onSelect={method =>
          navigate(method ? methodResultsPath(runId ?? '', method) : compareResultsPath(runId ?? ''))
        }
      />
      <TxrOutcomeTabs
        columns={allColumns}
        active={outcomeTab}
        horizon={horizon}
        labelDay={labelDay}
        onChange={tab => TxrResults.setOutcomeTab(tab)}
      />
      <div style={CONTENT_ROW}>
        <section style={TABLE_SECTION}>
          <TxrBarsTable
            columns={baseView.columns}
            rows={tableRows}
            totalCount={totalCount}
            outcome={outcomeTab}
            horizon={outcomeTab === 'response' ? responseDay : horizon}
            onShowAll={() => TxrResults.setPatientLimit(-1)}
          />
        </section>
        <aside style={ASIDE_COLUMN}>
          {cardReport ? (
            <TxrCompareCard
              report={cardReport}
              divergentOnly={divergentOnly}
              onToggleDivergent={on => TxrResults.setDivergentOnly(on)}
            />
          ) : null}
          <TxrMethodAside
            dir={run.dir ?? null}
            trainedOn={run.input_summary?.patients ?? null}
            onOpenChance={() => TxrResults.openChanceDialog(true)}
            onOpenFolder={dir => void revealRunDir(dir)}
          />
        </aside>
      </div>
      <TxrLogDialog />
      <TxrChanceDialog
        open={chanceDialogOpen}
        onOpenChange={open => TxrResults.openChanceDialog(open)}
        endpoint={endpointKey}
        horizon={outcomeTab === 'response' ? responseDay : horizon}
        probSources={allColumns.map(c => c.probSource)}
      />
    </main>
  )
}
