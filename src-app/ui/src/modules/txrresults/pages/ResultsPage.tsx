import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { Button, ErrorState, Skeleton } from '@txresbench/kit'
import type { TxrRunDetail } from '@/api-client/types'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import type { TxrOutcomeKey } from '../types'
import { TxrResults, useTxrResultsStore } from '../stores/Results.store'
import { buildColumns, viewOf } from '../lib/heatmap'
import { downloadPredictionsCsv } from '../index'
import {
  formatPredictionsTitle,
  subtitleFactsOf,
  TxrResultsBar,
  TxrResultsHeader,
} from '../components/TxrResultsHeader'
import { TxrOutcomeTabs } from '../components/TxrOutcomeTabs'
import { TxrMethodFilterBar } from '../components/TxrMethodFilterBar'
import { TxrHeatmapTable } from '../components/TxrHeatmapTable'
import { TxrLogDialog } from '../components/TxrLogDialog'
import { TxrRunTrouble } from '../components/TxrRunTrouble'
import { TxrRunFailedState } from '../components/TxrRunFailedState'
import { troubleRowsOf } from '../lib/trouble'
import { formatChanceMissingNote, formatConstantNote, formatEmptyColumnsNote, formatGroupedChanceNote, formatMixedOutcomeNote, txrRunFailed } from '../lib/format'

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
 * header actions wire here: download (ITEM-10's `lib/download.ts` through
 * the barrel), save-models (the header emits the framework event; the
 * host is `ui-models`), New analysis (`/`).
 */

const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (the page chrome — ITEM-3: summary, tabs, search). */
const PAGE_TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 24px 12px',
  minWidth: 0,
}

/** The ONE scroll region's content padding (the region scrolls, the padding rides). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '12px 24px 20px',
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
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
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
      <p style={{ margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }}>
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
  // R2-G1: the tab/title byte is the page's own h1 (the header's
  // "Predictions for N patients"; "Predictions" while the run loads). A run
  // that cannot be found (404 — or a malformed id's 400, ITEM-6 R3-results-8)
  // reads the running page's own "Run not found" title (ITEM-2e's byte).
  useDocumentTitle(
    runError === 'not-found'
      ? 'Run not found'
      : predictions === null
        ? 'Predictions'
        : formatPredictionsTitle(predictions.patients.length),
  )

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
  // The plain-voice notes (RES-03/04): a constant column is named, and a
  // mixed run's hidden tasks are counted — the "6 of 6 methods" header next
  // to an "All 5" picker never goes unexplained.
  const constantNote = useMemo(
    () => (view ? formatConstantNote(view.columns) : null),
    [view],
  )
  // R3-results-13: a column with only 2–3 distinct chances (cfmedip's
  // three-group call) reads like a constant beside a graded scale; the note
  // names the groups ("this method gives three groups").
  const groupedNote = useMemo(
    () => (view ? formatGroupedChanceNote(view.columns) : null),
    [view],
  )
  // R2-10 (qa-fixes2): when a finished method has no prediction column (the
  // engine found no recorded chance column for it), the header's true
  // "N of M methods finished" counts more than the table shows — the note
  // names the gap plainly ("Showing the 5 of 6 finished methods that give
  // chances; …"), never a silently dropped column next to an "All 5" filter.
  const chanceNote = useMemo(
    () =>
      run !== null && predictions !== null
        ? formatChanceMissingNote(
            run.methods
              .filter(m => m.state === 'finished')
              .map(m => ({ methodId: m.method_id, label: m.label })),
            allColumns,
          )
        : null,
    [run, predictions, allColumns],
  )
  const mixedNote = useMemo(
    () =>
      view
        ? formatMixedOutcomeNote(
            view.columns.length,
            allColumns.length,
            allColumns
              .filter(c => c.task !== outcomeTab)
              .map(c => ({ key: c.task, day: c.task === 'response' ? (labelDay ?? horizon) : horizon })),
          )
        : null,
    [view, allColumns, outcomeTab, horizon, labelDay],
  )
  // ITEM-6 (R2-03): the finished columns the view DROPPED (every value null
  // — a predict-only reuse's no-chance column, or a method that abstained
  // for every patient) are never a dash wall: the one line names them with
  // each column's own reason (the method page's own words).
  const noChanceNote = useMemo(
    () => (view ? formatEmptyColumnsNote(view.emptyColumns) : null),
    [view],
  )

  if (runError === 'not-found') {
    return (
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          body={
            <ScrollRegion label="Results">
              <div style={REGION_CONTENT}>
                <NotFoundResults onNewAnalysis={() => navigate('/')} />
              </div>
            </ScrollRegion>
          }
        />
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
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          body={
            <ScrollRegion label="Results">
              <div style={REGION_CONTENT}>
                <ErrorState
                  variant="page"
                  resource="the run"
                  description="The results could not be loaded right now. Try again in a moment."
                  onRetry={errorRetry}
                  data-testid="txr-results-error"
                />
              </div>
            </ScrollRegion>
          }
        />
      </main>
    )
  }

  // Loading: the detail is still in flight, or the first predictions fetch
  // is — the skeleton never reappears over a loaded snapshot.
  if (run === null || (predictions === null && predictionsLoading)) {
    return (
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          body={
            <ScrollRegion label="Results">
              <div style={REGION_CONTENT}>
                <LoadingResults />
              </div>
            </ScrollRegion>
          }
        />
      </main>
    )
  }

  const troubleRows = troubleRowsOf(run.methods)
  const finishedCount = run.counts?.finished ?? 0
  // A terminal failed/stopped run with no predictions is the honest
  // failure state (RES-02 + qa-fixes2 R2-02): the engine's `finished`
  // status also covers a run where NOTHING finished (`predictions_ready`
  // is false exactly then) — `txrRunFailed` is that truth. The reasons
  // render below the header, and the header omits the segments that read
  // like a completed run (nothing was learned — the counts + decision day
  // stay, they are recorded facts).
  const runFailed = txrRunFailed(run)

  // The 409 empty-heatmap state: header (counts + banners) + a disabled
  // download, NO table, NO spinner loop — the SSE's `prediction` frame
  // fills the columns without a reload (INV-1, EXAMPLE-UR-4).
  if (predictions === null) {
    return (
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          top={
            <div className="txr-results-top" style={PAGE_TOP}>
              <TxrResultsHeader
                run={run}
                predictions={null}
                predictionsError={predictionsError}
                subtitleFacts={
                  runFailed ? { ...subtitleFactsOf(run), trainedOn: null, tookSeconds: null } : undefined
                }
              />
              {runFailed ? (
                <TxrRunFailedState run={run} onShowLog={methodId => TxrResults.openLog(methodId)} onShowHistory={() => navigate('/history')} />
              ) : null}
              <TxrRunTrouble
                rows={troubleRows}
                finishedCount={finishedCount}
                onShowLog={methodId => TxrResults.openLog(methodId)}
              />
            </div>
          }
          body={
            <ScrollRegion label="Results">
              <div style={REGION_CONTENT} />
            </ScrollRegion>
          }
          bottom={
            <PageFooterBar testId="txr-results-bottom-bar">
              <TxrResultsBar
                shownCount={0}
                totalCount={0}
                onShowAll={null}
                download={{
                  label: 'Download all predictions (CSV)',
                  disabled: true,
                  onClick: () => {},
                }}
                save={run.models.length > 0 ? { mode: 'run', count: run.models.length } : null}
                run={run}
              />
            </PageFooterBar>
          }
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
    void downloadPredictionsCsv(runId).catch(() => setDownloadFailed(true))
  }

  return (
    <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
      <PageFrame
        testId="txr-results-frame"
        top={
          <div className="txr-results-top" style={PAGE_TOP}>
            <TxrResultsHeader
              run={run}
              predictions={predictions}
              predictionsError={predictionsError}
            />
            <TxrRunTrouble
              rows={troubleRows}
              finishedCount={finishedCount}
              onShowLog={methodId => TxrResults.openLog(methodId)}
            />
            {downloadFailed ? (
              <div data-testid="txr-results-download-error" role="alert" style={DOWNLOAD_ERROR}>
                The predictions could not be downloaded. Try again.
              </div>
            ) : null}
            <div className="txr-results-controls" style={CONTROLS_ROW}>
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
                outcome={outcomeTab}
                onFilterChange={filter => TxrResults.setMethodFilter(filter)}
                onSearchChange={value => TxrResults.setSearch(value)}
                onSortChange={value => TxrResults.setSort(value)}
              />
            </div>
          </div>
        }
        body={
          <ScrollRegion label="Patient predictions" className="txr-results-region">
            <div style={REGION_CONTENT}>
              <TxrHeatmapTable view={view} />
              {chanceNote !== null ? (
                <p data-testid="txr-results-chance-note" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {chanceNote}
                </p>
              ) : null}
              {noChanceNote !== null ? (
                <p data-testid="txr-results-no-chance-note" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {noChanceNote}
                </p>
              ) : null}
              {mixedNote !== null ? (
                <p data-testid="txr-results-mixed-note" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {mixedNote}
                </p>
              ) : null}
              {constantNote !== null ? (
                <p data-testid="txr-results-constant-note" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {constantNote}
                </p>
              ) : null}
              {groupedNote !== null ? (
                <p data-testid="txr-results-grouped-note" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {groupedNote}
                </p>
              ) : null}
            </div>
          </ScrollRegion>
        }
        bottom={
          <PageFooterBar testId="txr-results-bottom-bar">
            <TxrResultsBar
              shownCount={view.shownCount}
              totalCount={view.totalCount}
              onShowAll={view.shownCount < view.totalCount ? () => TxrResults.setPatientLimit(-1) : null}
              download={{
                label: 'Download all predictions (CSV)',
                disabled: predictionsError === 'unavailable',
                onClick: handleDownload,
              }}
              save={run.models.length > 0 ? { mode: 'run', count: run.models.length } : null}
              run={run}
            />
          </PageFooterBar>
        }
      />
      <TxrLogDialog />
    </main>
  )
}
