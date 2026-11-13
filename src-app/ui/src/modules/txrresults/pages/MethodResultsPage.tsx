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
import { TxrResults, useTxrResultsStore } from '../stores/Results.store'
import { buildColumns, compareReport, divergentPatients, sortByFirstMethod, viewOf } from '../lib/heatmap'
import { compareResultsPath, methodResultsPath, downloadPredictionsCsv, revealRunDir } from '../index'
import { formatConstantNote, formatMixedOutcomeNote, formatNoChanceNote, txrRunFailed } from '../lib/format'
import { subtitleFactsOf, TxrResultsBar, TxrResultsHeader } from '../components/TxrResultsHeader'
import { TxrCannotRunBanner } from '../components/TxrCannotRunBanner'
import { TxrRunFailedState } from '../components/TxrRunFailedState'
import { TxrMethodTabs } from '../components/TxrMethodTabs'
import { TxrOutcomeTabs } from '../components/TxrOutcomeTabs'
import { TxrBarsTable } from '../components/TxrBarsTable'
import { TxrCompareCard } from '../components/TxrCompareCard'
import { TxrComparePicker } from '../components/TxrComparePicker'
import { TxrMethodAside } from '../components/TxrMethodAside'
import { TxrChanceDialog } from '../components/TxrChanceDialog'
import { TxrLogDialog } from '../components/TxrLogDialog'
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
 * The one-method tab (qa-fixes RES-11) is the board's one-method view
 * (`SaveOne.dc.html`): the table shows the ACTIVE method's column only
 * (never the compare table again with the method's own column off-screen),
 * the outcome tabs yield to the method's own task (its heading spells the
 * task's words), the aside gains the method's facts (coverage, prob source,
 * the log link) and an unknown method id renders the not-found state
 * (RES-12 — the old compare-tab fallback is gone).
 *
 * The store's search/sort/method-group controls are G's (the H board has no
 * search or filter bar): H derives with an unfiltered, patient-ordered
 * base view — the H sort is the board's "sorted by the first method", the
 * row window is the shared "Showing N of M" (the Show-all raises the same
 * `patientLimit`).
 */
const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (the page chrome — ITEM-3). */
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
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
  fontSize: 14,
}

/** The method-not-found block of the one-method route (qa-fixes RES-12). */
const METHOD_NOT_FOUND_BLOCK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  maxWidth: 460,
}

/** The method heading style (the SaveOne board's h1). */
const METHOD_HEADING: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 22,
  lineHeight: 1.3,
}

const METHOD_HEADING_LABEL: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)', margin: 0 }

/** The page's plain-voice notes under the table (RES-03/04). */
const NOTE_LINE: CSSProperties = { fontSize: 13.5, color: 'var(--txr-text-2)', margin: 0 }

/** The one run endpoint key the normalize fallback needs (the generated `TxrEndpoint` is closed). */
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
  // The active method column: the URL's method id when it names a finished
  // method; `undefined` (the `/compare` route's absence of the segment) =
  // the Compare tab; a method id that names no finished method is the
  // method-not-found state (qa-fixes RES-12 — the old compare-tab fallback
  // left the URL claiming a page it did not render).
  const activeColumn = useMemo(
    () => allColumns.find(c => c.methodId === methodId) ?? null,
    [allColumns, methodId],
  )
  const isCompareTab = methodId === undefined || methodId === null
  const methodNotFound = !isCompareTab && activeColumn === null
  // R2-G1: the tab/title byte is the page's own h1 — the Compare-methods tab
  // on `/compare`, the method column's label on a method tab (the same word
  // the page renders under the method tabs), "Method" while it loads.
  useDocumentTitle(
    isCompareTab ? 'Compare methods' : (activeColumn?.label ?? 'Method'),
  )
  // The H base view: the one-method tab's OWN column (its task is the
  // method's — the outcome tabs yield to it, RES-11), else the active
  // outcome tab's columns. UNFILTERED (H has no search/method-group controls
  // — those are G's), patient-ordered (the H sort is the first method's,
  // DEC-6), unwindowed (the H window applies after the first-method sort
  // AND the divergent filter).
  const baseView = useMemo(
    () =>
      predictions
        ? activeColumn
          ? viewOf(allColumns, predictions, {
              outcome: activeColumn.task,
              groups: null,
              methodIds: [activeColumn.methodId],
              search: '',
              sort: 'patient',
              limit: 0,
            })
          : viewOf(allColumns, predictions, {
              outcome: outcomeTab,
              groups: null,
              methodIds: null,
              search: '',
              sort: 'patient',
              limit: 0,
            })
        : null,
    [allColumns, predictions, activeColumn, outcomeTab],
  )
  // R2-07: the compare pair the H compare tab actually compares. The picker
  // state is PRESENTATION state — the pair defaults to the first two columns
  // and re-defaults whenever the picker's column set changes (a different
  // run/tab presents its own first two); an id outside the set (or a
  // duplicated pick) resolves to the default pair, never a broken report.
  const [comparePair, setComparePair] = useState<{ a: string; b: string } | null>(null)
  const pair = useMemo(() => {
    const columns = baseView?.columns ?? []
    if (columns.length < 2) return null
    const isIn = (id: string | null): boolean => id !== null && columns.some(c => c.methodId === id)
    if (
      comparePair !== null &&
      isIn(comparePair.a) &&
      isIn(comparePair.b) &&
      comparePair.a !== comparePair.b
    ) {
      return comparePair
    }
    return { a: columns[0].methodId, b: columns[1].methodId }
  }, [baseView, comparePair])
  const firstMethodId = activeColumn?.methodId ?? pair?.a ?? baseView?.columns[0]?.methodId ?? ''
  const orderedRows = useMemo(
    () => (baseView ? sortByFirstMethod(baseView.columns, baseView.rows, firstMethodId) : []),
    [baseView, firstMethodId],
  )
  const divergentIds = useMemo(() => {
    if (!divergentOnly || !baseView || pair === null) return null
    return new Set(divergentPatients(baseView.columns, orderedRows, pair.a, pair.b))
  }, [divergentOnly, baseView, orderedRows, pair])
  const tableRows = useMemo(() => {
    const filtered = divergentIds ? orderedRows.filter(r => divergentIds.has(r.patientId)) : orderedRows
    return patientLimit > 0 ? filtered.slice(0, patientLimit) : filtered
  }, [orderedRows, divergentIds, patientLimit])
  const totalCount = divergentIds ? divergentIds.size : orderedRows.length
  // The compare card: compare tab only (a one-method tab is not a
  // two-method comparison — ITEM-4 note (p)), over the full row set and the
  // PICKED pair (R2-07 — the old card was always the first two columns).
  const compareReportData = useMemo(
    () =>
      baseView && baseView.columns.length >= 2 && pair !== null
        ? compareReport(baseView.columns, baseView.rows, pair.a, pair.b)
        : null,
    [baseView, pair],
  )
  // The compare tab only (a one-method tab is not a two-method comparison —
  // ITEM-4 note (p)); the narrowed variable carries the report to the card.
  const cardReport =
    isCompareTab && compareReportData !== null ? compareReportData : null
  // The one-method "Save this model" (SaveOne board): only a finished
  // method with a produced model — TEST-UR-10's gate.
  const saveOneMethodId =
    activeColumn &&
    run?.methods.some(m => m.method_id === activeColumn.methodId && m.state === 'finished') &&
    run.models.some(m => m.method_id === activeColumn.methodId)
      ? activeColumn.methodId
      : null
  // The plain-voice notes (RES-03/04): a constant column is named, and a
  // mixed run's hidden tasks are counted.
  const constantNote = useMemo(
    () => (baseView ? formatConstantNote(baseView.columns) : null),
    [baseView],
  )
  // R2-03: a no-chance column (prob_source none — the predict-only reuse
  // case) is a dashed wall with no explanation; the note names it with the
  // page's own prob-source words (the one-method tab's column set is the
  // active method's, the compare tab's is the view's).
  const noChanceNote = useMemo(
    () => formatNoChanceNote(activeColumn ? [activeColumn] : (baseView?.columns ?? [])),
    [activeColumn, baseView],
  )
  const mixedNote = useMemo(
    () =>
      isCompareTab && baseView
        ? formatMixedOutcomeNote(
            baseView.columns.length,
            allColumns.length,
            allColumns
              .filter(c => c.task !== outcomeTab)
              .map(c => ({ key: c.task, day: c.task === 'response' ? responseDay : horizon })),
          )
        : null,
    [isCompareTab, baseView, allColumns, outcomeTab, responseDay, horizon],
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
                  description="The results could not be loaded right now. Check that the app server is running, then try again."
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

  const cannotRun = run.methods.filter(m => m.state === 'cannot_run')
  // qa-fixes2 R2-02: the failure state is the engine's own truth — a
  // TERMINAL run with no finished method (the engine's `finished` status
  // also covers a run where nothing finished, `predictions_ready` false).
  const runFailed = txrRunFailed(run)

  // The 409 empty-heatmap state (DEC-18: banner + counts + disabled
  // download, no spinner loop — the SSE fills it). A terminal failed /
  // stopped run renders the honest failure state instead (RES-02): the
  // engine's per-method reasons, with the header's completed-run segments
  // omitted.
  if (predictions === null) {
    return (
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          top={
            <div style={PAGE_TOP}>
              <TxrResultsHeader
                run={run}
                predictions={null}
                predictionsError={predictionsError}
                subtitleFacts={
                  runFailed ? { ...subtitleFactsOf(run), trainedOn: null, tookSeconds: null } : undefined
                }
              />
              {runFailed ? (
                <TxrRunFailedState run={run} onShowLog={method => TxrResults.openLog(method)} onShowHistory={() => navigate('/history')} />
              ) : null}
              <TxrCannotRunBanner
                methods={cannotRun}
                total={run.methods.length}
                onShowLog={method => TxrResults.openLog(method)}
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
                  label: 'Download predictions (CSV)',
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

  if (baseView === null) return null

  // RES-12: a method id that names no finished method of this run is the
  // method-not-found state, never the Compare page (the URL stays as-is —
  // the state names the problem).
  if (methodNotFound) {
    return (
      <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
        <PageFrame
          body={
            <ScrollRegion label="Results">
              <div style={REGION_CONTENT}>
                <div data-testid="txr-results-method-not-found" style={METHOD_NOT_FOUND_BLOCK}>
                  <h2 style={NOT_FOUND_TITLE}>This method could not be found in this run</h2>
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }}>
                    It may have failed before producing predictions, or the link is outdated.
                  </p>
                  <Button
                    data-testid="txr-results-method-new-analysis"
                    variant="outline"
                    className="rounded-lg font-semibold"
                    style={{ padding: '9px 16px' }}
                    onClick={() => navigate(compareResultsPath(runId ?? ''))}
                  >
                    See all methods
                  </Button>
                </div>
              </div>
            </ScrollRegion>
          }
        />
      </main>
    )
  }

  const handleDownload = () => {
    if (!runId) return
    setDownloadFailed(false)
    void downloadPredictionsCsv(runId).catch(() => setDownloadFailed(true))
  }

  const activeColumnMethod = activeColumn ? { ...activeColumn } : null
  const tableColumns = activeColumnMethod ? [activeColumnMethod] : baseView.columns
  const saveEntry =
    saveOneMethodId !== null
      ? ({ mode: 'one', methodId: saveOneMethodId } as const)
      : run.models.length > 0
        ? ({ mode: 'run', count: run.models.length } as const)
        : null
  return (
    <main data-testid="txr-results" className="txr-results-page" style={PAGE_OUTER}>
      <PageFrame
        testId="txr-results-frame"
        top={
          <div style={PAGE_TOP}>
            <TxrResultsHeader
              run={run}
              predictions={predictions}
              predictionsError={predictionsError}
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
              activeMethodId={activeColumn?.methodId ?? null}
              onSelect={method =>
                navigate(method ? methodResultsPath(runId ?? '', method) : compareResultsPath(runId ?? ''))
              }
            />
            {activeColumn ? (
              <div data-testid="txr-results-method-heading" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <h1 style={METHOD_HEADING}>{activeColumn.label}</h1>
                <p style={METHOD_HEADING_LABEL}>
                  {activeColumn.groupLabel}
                  {activeColumn.probSource === null ? ' \u00b7 no chances shown' : ''}
                </p>
              </div>
            ) : (
              <TxrOutcomeTabs
                columns={allColumns}
                active={outcomeTab}
                horizon={horizon}
                labelDay={labelDay}
                onChange={tab => TxrResults.setOutcomeTab(tab)}
              />
            )}
          </div>
        }
        body={
          <ScrollRegion label="Methods" className="txr-results-methods-region">
            <div style={REGION_CONTENT}>
              <div style={CONTENT_ROW}>
                <section className="txr-h-table-section" style={TABLE_SECTION}>
                  <TxrBarsTable
                    columns={tableColumns}
                    rows={tableRows}
                    totalCount={totalCount}
                    outcome={activeColumn?.task ?? outcomeTab}
                    horizon={(activeColumn?.task ?? outcomeTab) === 'response' ? responseDay : horizon}
                    onShowAll={() => TxrResults.setPatientLimit(-1)}
                  />
                  {constantNote !== null ? (
                    <p data-testid="txr-results-constant-note" style={{ ...NOTE_LINE, marginTop: 8 }}>
                      {constantNote}
                    </p>
                  ) : null}
                  {noChanceNote !== null ? (
                    <p data-testid="txr-results-no-chance-note" style={{ ...NOTE_LINE, marginTop: 8 }}>
                      {noChanceNote}
                    </p>
                  ) : null}
                  {mixedNote !== null ? (
                    <p data-testid="txr-results-mixed-note" style={{ ...NOTE_LINE, marginTop: 8 }}>
                      {mixedNote}
                    </p>
                  ) : null}
                  {divergentOnly && totalCount === 0 ? (
                    <p data-testid="txr-results-divergent-empty" style={{ ...NOTE_LINE, marginTop: 8 }}>
                      No patient differs between the two methods by 10 percentage points or more.
                    </p>
                  ) : null}
                </section>
                <aside className="txr-h-aside" style={ASIDE_COLUMN}>
                  {cardReport && pair !== null ? (
                    <>
                      <TxrComparePicker
                        columns={baseView.columns}
                        pair={pair}
                        onChange={picked => setComparePair(picked)}
                      />
                      <TxrCompareCard
                        report={cardReport}
                        aLabel={baseView.columns.find(c => c.methodId === pair.a)?.label ?? ''}
                        bLabel={baseView.columns.find(c => c.methodId === pair.b)?.label ?? ''}
                        divergentOnly={divergentOnly}
                        onToggleDivergent={on => TxrResults.setDivergentOnly(on)}
                      />
                    </>
                  ) : null}
                  <TxrMethodAside
                    dir={run.dir ?? null}
                    trainedOn={run.input_summary?.patients ?? null}
                    method={activeColumn}
                    onShowLog={activeColumn ? method => TxrResults.openLog(method) : undefined}
                    onOpenChance={() => TxrResults.openChanceDialog(true)}
                    onOpenFolder={dir => void revealRunDir(dir)}
                  />
                </aside>
              </div>
            </div>
          </ScrollRegion>
        }
        bottom={
          <PageFooterBar testId="txr-results-bottom-bar">
            <TxrResultsBar
              shownCount={0}
              totalCount={0}
              onShowAll={null}
              download={{
                label: 'Download predictions (CSV)',
                disabled: predictionsError === 'unavailable',
                onClick: handleDownload,
              }}
              save={saveEntry}
              run={run}
            />
          </PageFooterBar>
        }
      />
      <TxrLogDialog />
      <TxrChanceDialog
        open={chanceDialogOpen}
        onOpenChange={open => TxrResults.openChanceDialog(open)}
        endpoint={activeColumn?.task ?? endpointKey}
        horizon={activeColumn?.task === 'response' ? responseDay : horizon}
        columns={activeColumn ? [activeColumn] : allColumns}
      />
    </main>
  )
}
