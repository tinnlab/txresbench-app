/**
 * Screen K — History (board `History.dc.html`; ITEM-5, PROV-HIST-1):
 * the newest-first run list with the board's search + filter, the
 * collapsible per-run cards, the footer (run count + disk usage + the two
 * retention controls) and the two dialogs (confirmations, the terminal
 * log snapshot). The page is the module's ONE composition point: the
 * ITEM-4 components are presentational (props + reports) and this page
 * owns every store call and every navigation.
 *
 * The page's state machine (ITEM-2's store, the single data owner):
 *
 * - mount + every `window` focus: the fresh trio — `reload()` (first page
 *   + usage) and `refreshPreferences()` (the footer's two links' state —
 *   its own fetch per ITEM-2, owned by the page since the ITEM-4
 *   components are presentational). The focus listener is removed on
 *   unmount (DEC-11, no leak). After each completing action the store
 *   itself reloads (rerun, settings-save, copies-off/on, clear-all).
 * - the list area's boundary states are the ITEM-4 components': the
 *   first-page skeleton, the failure `Alert` + Retry (never a blank
 *   page), the empty state, and the Load-more continuation (exactly
 *   while `items.length < total`, INV-1).
 * - the row actions bind the providers' frozen seams ONLY, never a URL
 *   literal (INV-3): "Open the results" → `resultsPath(runId)` (the
 *   ui-results builder, CONS-HIST-12), a running row's "Open the running
 *   run" → `runningPath(runId)` (ui-run, CONS-HIST-15), "Run again with
 *   the same settings" → `TxrHistory.rerun` then `runningPath(newId)`,
 *   the copy-cleared row's "Use these settings again" → the DEC-6 body
 *   then `chooseMethodsPath()`, "Download predictions" → the reused
 *   `downloadPredictionsCsv` (PROV-UR-6), "Open the folder" → the reused
 *   `revealRunDir` (PROV-UR-7; desktop-gated inside — `isDesktop` is
 *   the platform's own pure predicate, never re-derived), the model-set
 *   links → `modelsPath(setId)` (PROV-UI-MODELS-1).
 * - the two dialogs: the confirmations are the INV-2 gate (the store's
 *   `confirm` state; no destructive call without them) and the log
 *   dialog is the terminal snapshot (the store's backfill; the method
 *   filter re-opens it, so the backfill restarts at the first page).
 *
 * An action that fails surfaces the page-level inline `Alert` (the
 * "no silent no-op" rule for the row actions — the store's retention
 * transitions consume their confirmation on failure, INV-2's already
 * recorded surface). The board's rows, counts and sizes are design
 * examples, never data (INV-6).
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { Alert } from '@ziee/kit'
import { isDesktop } from '@/core/platform'
import { modelsPath } from '@/modules/txrmodels'
import { downloadPredictionsCsv, resultsPath, revealRunDir } from '@/modules/txrresults'
import { chooseMethodsPath, runningPath } from '@/modules/txrrun'
import { TxrHistory, useTxrHistory } from '../index'
import { TxrConfirmDialog } from '../components/TxrConfirmDialog'
import { TxrHistoryFooter } from '../components/TxrHistoryFooter'
import { TxrHistoryList } from '../components/TxrHistoryList'
import { TxrHistoryLogDialog } from '../components/TxrHistoryLogDialog'
import { TxrHistoryToolbar } from '../components/TxrHistoryToolbar'

/** The board's page chrome (the main column the ITEM-1 shell carried). */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '28px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  minWidth: 0,
}

/** The inline action-failure alert (the row actions' honest surface). */
const ALERT_ROW: CSSProperties = { flexGrow: 0 }

/** The failure words of the row actions (never blank, never a no-op). */
const DOWNLOAD_FAILED = 'The predictions could not be downloaded. Try again.'
const RERUN_FAILED = 'The run could not be started again. Try again.'
const SETTINGS_AGAIN_FAILED = 'The settings could not be saved. Try again.'

/**
 * The fresh trio the mount + focus refresh runs (DEC-11): the store's
 * `reload` is the list + usage pair by design (ITEM-2 — the page test
 * pins the pair), and the keep-copies preference is the footer's own
 * state fetch, owned here because the ITEM-4 components are
 * presentational.
 */
function fresh(): void {
  void TxrHistory.reload()
  void TxrHistory.refreshPreferences()
}

export function HistoryPage() {
  const navigate = useNavigate()
  const state = useStore(useTxrHistory)
  const [actionError, setActionError] = useState<string | null>(null)

  // Mount + every `window` focus: the fresh trio. The listener is removed
  // on unmount (no leak — TEST-HIST-8); a run finishing while K is open
  // appears at the next focus (the provider's DEC-16 freshness: no poll,
  // no SSE).
  useEffect(() => {
    fresh()
    const onFocus = (): void => fresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // ── The list area's reports (the store's own actions) ───────────────────

  const handleToggle = (runId: string): void => {
    void TxrHistory.expand(runId)
  }

  const handleLoadMore = (): void => {
    void TxrHistory.loadMore()
  }

  const handleRetry = (): void => {
    void TxrHistory.retryLoad()
  }

  // ── The row actions: bindings, never literals (INV-3) ───────────────────

  const handleSearch = (value: string): void => TxrHistory.setSearch(value)

  const handleFilter = (filter: (typeof state)['filter']): void => TxrHistory.setFilter(filter)

  const handleOpenResults = (runId: string): void => {
    navigate(resultsPath(runId))
  }

  const handleOpenRunning = (runId: string): void => {
    navigate(runningPath(runId))
  }

  const handleRerun = (runId: string): void => {
    setActionError(null)
    void TxrHistory.rerun(runId)
      .then(summary => navigate(runningPath(summary.id)))
      .catch(() => setActionError(RERUN_FAILED))
  }

  const handleSettingsAgain = (runId: string): void => {
    const detail = useTxrHistory.getState().detail
    if (detail === null || detail.id !== runId) return
    setActionError(null)
    void TxrHistory.useSettingsAgain(detail)
      .then(() => navigate(chooseMethodsPath()))
      .catch(() => setActionError(SETTINGS_AGAIN_FAILED))
  }

  const handleDownload = (runId: string): void => {
    setActionError(null)
    void downloadPredictionsCsv(runId).catch(() => setActionError(DOWNLOAD_FAILED))
  }

  const handleReveal = (runId: string): void => {
    const detail = useTxrHistory.getState().detail
    if (detail === null || detail.id !== runId) return
    void revealRunDir(detail.dir)
  }

  const handleOpenSet = (setId: string): void => {
    navigate(modelsPath(setId))
  }

  // ── The two dialogs ─────────────────────────────────────────────────────

  const handleCancelConfirm = (): void => TxrHistory.closeConfirm()

  const handleCopiesOff = (): void => TxrHistory.openConfirm('copies-off')

  const handleCopiesOn = (): void => TxrHistory.openConfirm('copies-on')

  const handleClearAll = (): void => TxrHistory.openConfirm('clear-all')

  const handleLog = (runId: string): void => {
    void TxrHistory.openLog(runId, null)
  }

  const handleLogMethod = (methodId: string | null): void => {
    const dialog = state.logDialog
    if (dialog === null) return
    void TxrHistory.openLog(dialog.runId, methodId)
  }

  // The log dialog's method filter options: the RUN's own rows (the
  // expanded row's detail — the dialog opens from the expanded block). A
  // row whose detail is no longer loaded renders the whole-run view with
  // "All methods" only — never a fabricated method list.
  const logMethods =
    state.detail !== null && state.detail.id === state.logDialog?.runId
      ? state.detail.methods.map(row => ({ id: row.method_id, version: row.version }))
      : []

  return (
    <main data-testid="txr-history" style={PAGE_MAIN}>
      <TxrHistoryToolbar
        search={state.searchInput}
        filter={state.filter}
        onSearch={handleSearch}
        onFilter={handleFilter}
      />
      {actionError !== null ? (
        <div style={ALERT_ROW}>
          <Alert data-testid="txr-history-action-error" tone="error" title={actionError} />
        </div>
      ) : null}
      <TxrHistoryList
        items={state.items}
        total={state.total}
        loading={state.loading}
        loadingMore={state.loadingMore}
        error={state.error}
        expandedId={state.expandedId}
        detail={state.detail}
        detailLoading={state.detailLoading}
        isDesktop={isDesktop()}
        onToggle={handleToggle}
        onLoadMore={handleLoadMore}
        onRetry={handleRetry}
        onOpenResults={handleOpenResults}
        onOpenRunning={handleOpenRunning}
        onRerun={handleRerun}
        onSettingsAgain={handleSettingsAgain}
        onDownload={handleDownload}
        onReveal={handleReveal}
        onLog={handleLog}
        onOpenSet={handleOpenSet}
      />
      <TxrHistoryFooter
        usage={state.usage}
        total={state.total}
        preferences={state.preferences}
        working={state.working !== null}
        onCopiesOff={handleCopiesOff}
        onCopiesOn={handleCopiesOn}
        onClearAll={handleClearAll}
      />
      <TxrConfirmDialog
        confirm={state.confirm}
        working={state.working !== null}
        onCancel={handleCancelConfirm}
        onCopiesOff={() => {
          void TxrHistory.setKeepCopies(false)
        }}
        onCopiesOn={() => {
          void TxrHistory.setKeepCopies(true)
        }}
        onClearAll={deleteFiles => {
          void TxrHistory.clearAllHistory(deleteFiles)
        }}
      />
      <TxrHistoryLogDialog
        open={state.logDialog !== null}
        runId={state.logDialog?.runId ?? ''}
        methodId={state.logDialog?.methodId ?? null}
        methods={logMethods}
        lines={state.logLines}
        total={state.logTotal}
        loading={state.logLoading}
        onClose={() => TxrHistory.closeLog()}
        onMethodChange={handleLogMethod}
      />
    </main>
  )
}
