import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { methodResultsPath, resultsPath } from '@/modules/txrresults/routes'
import { Alert, Button, Result, Skeleton } from '@ziee/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import type { TxrRunBucket } from '../types'
import {
  bucketOf,
  estimateQualityWord,
  formatSecs,
  formatTimeLeft,
  LEAVE_AND_CONTINUE_NOTE,
} from '../lib/format'
import { historyPath } from '../routes'
import { TxrRun, useTxrRun } from '../stores/TxrRun.store'
import { TxrCountsStrip } from '../components/TxrCountsStrip'
import { formatRunTitle, TxrRunHeader } from '../components/TxrRunHeader'
import { TxrLogPanel } from '../components/TxrLogPanel'
import { TxrRunTable } from '../components/TxrRunTable'
import type { TxrRunRowAction } from '../components/TxrRunRow'

/**
 * Screen F — Running (board `BusyRunning.dc.html`): one analysis run's live
 * surface. ITEM-9 delivers the page base: the run-id wiring (`useParams` →
 * the run store's `load`, once per id; a changed id resets and re-loads —
 * the single-instance-per-URL rule), the header block (methods count,
 * time left, elapsed, concurrency line, "See the results"), the per-state
 * counter strip, the tab chips (the page's filter state, held in the run
 * store so it survives a leave-and-continue), the per-method table + the
 * stop-all / at-a-time controls (ITEM-10 — the rows are the active tab's
 * bucket, the actions call the run store and navigate with `txrresults`'
 * builders) and the not-found / network states (kit `Result` + the History
 * link). The log panel + leave-and-continue note (ITEM-11) build on this
 * base next to the table.
 *
 * qa-fixes ITEM-3 (RP-1/2/3): the ELAPSED fact is the run's own
 * `elapsed_secs` snapshot at load plus a one-second client tick (the run's
 * `started_at` is on the same machine — no clock skew) while the run is
 * live, and the time-left line uses that LIVE elapsed, so "about N minutes
 * left" counts down instead of freezing (INV-4: the estimate is still the
 * engine's own, minus elapsed; nothing is re-scheduled here). The page is
 * bounded (the E page's definite-height frame — CM-2) so the table and the
 * log panel live inside it and scroll IN THEMSELVES; the per-state counter
 * strip shows every engine state and the tab chips are one bucket per state
 * (RP-3). When the run turns terminal WHILE the page is watching it, the
 * page lands on the results screen (RP-1 — the run is over; its results
 * page carries the finished/failed/stopped state, ITEM-1); a page opened
 * directly at a terminal run loads the terminal snapshot and renders it
 * with the run's own terminal title and disabled run controls, never a
 * claim that the run is still going.
 *
 * The header's facts are composed here and formatted in `lib/format.ts`
 * (INV-4 — the time-left is the run's own create-time estimate minus its
 * elapsed; nothing on this page computes a schedule). The tab chip counts
 * are the module's own partition (`bucketOf`, DEC-2 — a complete partition
 * of the eight engine states; "All" is the row count). The "See the
 * results" link is live when the run's `predictions_ready` or ≥1 method is
 * finished (DEC-12 / INV-1: results readable while the others still run).
 *
 * The 409-resolution notice (ITEM-8, DEC-18) stays: the E create path
 * navigates here with `{ resumed: true }` — the one line says the user is
 * watching the run that was already active.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped'])

/** The page's definite height (the shell header is 56px — CM-2's frame). */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  height: 'calc(100dvh - 56px)',
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'stretch',
}

/** The board's main content column (flex-basis ordering = board: content
 *  first, log panel second — the log panel column joins at ITEM-11). The
 *  column scrolls INSIDE itself (the bounded page; the table and the log
 *  panel are never pushed down a 22,000 px document). */
const CONTENT: CSSProperties = {
  flex: '3 1 600px',
  minWidth: 0,
  minHeight: 0,
  boxSizing: 'border-box',
  padding: '26px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  overflowY: 'auto',
}

/** The resumed notice's full-width row (the page's flex-wrap layout). */
const NOTICE_ROW: CSSProperties = { flexBasis: '100%' }

/** The DEC-18 one-line notice (the 409 resolution's handoff line). */
const RESUMED_NOTICE_LINE = 'A run was already active — you are watching it now.'

/** The tab chips' row (the board's tab row above the method table; the
 *  at-a-time control lives in the table section's footer row — ITEM-10's
 *  placement is recorded in DRIFT-1). */
const TAB_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
}

/** The loading / result blocks (the page between mount and the first fact). */
const STATE_BLOCK: CSSProperties = {
  boxSizing: 'border-box',
  padding: '26px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

/** The leave-and-continue note (the board's footer line under the table:
 *  the run keeps going when this screen is left; the note is the page's
 *  always-rendered wiring, not the panel's). */
const LEAVE_NOTE: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--txr-muted)',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}

/** The tab chips' unselected look (the boards' pill; E's chips use the same). */
const TAB_CHIP = {
  borderRadius: 999,
  padding: '5px 12px',
  fontSize: 13.5,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text-2)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-border)',
} as const

/** The active tab's look (the board's pressed pill). */
const ACTIVE_TAB = {
  ...TAB_CHIP,
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  borderColor: 'var(--txr-brand)',
} as const

/**
 * The tab chips (the board's tab row above the method table): the board's
 * All / Working / Finished / Failed pills, then one chip per terminal
 * state the engine distinguishes (Stopped, Skipped, Cannot run — RP-3: a
 * state is never counted under another state's tab) — the at-a-time
 * control lives in the table section's footer row (ITEM-10's placement is
 * recorded in DRIFT-1). A chip's count is that bucket's own count in the
 * strip, so the strip and the tabs are one accounting.
 */
const TABS: ReadonlyArray<{ id: TxrRunBucket; label: string; definition?: string }> = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working', definition: 'Waiting, downloading or running' },
  { id: 'finished', label: 'Finished' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'cannot_run', label: 'Cannot run' },
]

function LoadingRun() {
  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      <div data-testid="txr-run-loading" style={STATE_BLOCK}>
        <Skeleton style={{ width: 320, height: 26 }} />
        <Skeleton style={{ width: 520, height: 16 }} />
        <Skeleton style={{ height: 180, width: '100%' }} />
      </div>
    </main>
  )
}

function NotFoundRun({ history }: { history: string }) {
  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      <div style={STATE_BLOCK}>
        <Result
          status="404"
          data-testid="txr-run-not-found"
          title="This analysis run could not be found"
          subtitle="It may have been removed, or the link is outdated."
          extra={
            <Link data-testid="txr-run-history" to={history}>
              History
            </Link>
          }
        />
      </div>
    </main>
  )
}

function NetworkErrorRun({ history, onRetry }: { history: string; onRetry: () => void }) {
  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      <div style={STATE_BLOCK}>
        <Result
          status="error"
          data-testid="txr-run-load-error"
          title="The run could not be loaded"
          subtitle="Check that the app is running, then try again."
          extra={
            <>
              <Button
                data-testid="txr-run-retry"
                variant="outline"
                className="rounded-lg font-semibold"
                style={{ padding: '8px 16px' }}
                onClick={onRetry}
              >
                Try again
              </Button>
              <Link data-testid="txr-run-history" to={history}>
                History
              </Link>
            </>
          }
        />
      </div>
    </main>
  )
}

export function RunningPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const state = useStore(useTxrRun)
  const { run, runError, tab } = state

  // Load on mount + on a run-id change: the store resets first and drops
  // the previous run's in-flight work (no cross-run bleed — the store's
  // own epoch guard; the F screen is single-instance per URL, DEC-1).
  useEffect(() => {
    if (runId) void TxrRun.load(runId)
  }, [runId])

  // The derived header/tab facts, computed on EVERY render path (the early
  // returns below must not change the hook order): the run-less branches
  // render nothing from these, and the branch guards run afterwards.
  const runStatus = run?.status ?? null
  const terminal = runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus)
  const finishedCount = useMemo(
    () => (run?.methods ?? []).filter(m => m.state === 'finished').length,
    [run],
  )
  // R2-1: a terminal run's title counts what happened, not what was queued
  // ("Finished 4 of 6 methods" next to 4 done rows — never "Finished 6
  // methods" while stopped/skipped rows sit in the table; old-run shape
  // "6 finished of 209 selected").
  const title = formatRunTitle(
    run?.methods.length ?? 0,
    runStatus,
    terminal ? finishedCount : null,
  )
  // R2-G1: the tab/title byte is the page's own h1 once the run is known
  // ("Running N methods", "Finished N methods"…); before that the status
  // word alone ("Running …"). A run record carries no name field, so the
  // title is derived exactly like the page heading — never invented.
  useDocumentTitle(run === null ? 'Running' : title)

  // The LIVE elapsed (RP-2): the run's own snapshot at load (the detail's
  // `elapsed_secs`; the `started_at` anchor for a run whose snapshot had no
  // elapsed — the server and the page are the same machine) plus a
  // one-second client tick while the run is live, so the elapsed reads and
  // the time-left counts down. The anchor is fixed per run id (a status or
  // method frame re-patches `run` — the anchor must not be re-read, the
  // tick must not be reset); a terminal run reads the engine's final
  // `elapsed_secs` and stops ticking.
  const [elapsedTick, setElapsedTick] = useState(0)
  useEffect(() => {
    setElapsedTick(0)
  }, [run?.id])
  // The anchor is fixed per run id: a status or method frame re-patches the
  // run object, and re-reading the anchor there would reset the tick every
  // frame — the snapshot's elapsed (or the started_at anchor) is taken ONCE
  // per run, at the load that delivered it.
  const elapsedAnchor = useMemo(() => {
    if (run === null) return null
    return (
      run.elapsed_secs ??
      (run.started_at !== undefined
        ? Math.max(0, (Date.now() - Date.parse(run.started_at)) / 1000)
        : null)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the RUN
    // ID only (the run object is re-patched by every frame).
  }, [run?.id])
  useEffect(() => {
    if (run === null || terminal) return
    const id = window.setInterval(() => setElapsedTick(t => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [run?.id, terminal, run])
  const liveElapsedSecs = useMemo(() => {
    if (run === null) return null
    if (terminal) return run.elapsed_secs ?? null
    return elapsedAnchor === null ? null : elapsedAnchor + elapsedTick
  }, [run, terminal, elapsedAnchor, elapsedTick])
  // R2-1/R2-2: the time-left segment belongs to a LIVE run only — a terminal
  // run's header reads "took 17 s" (the elapsed segment's terminal word),
  // never the stale "about 2 minutes left" of the estimate the run started
  // with. The live elapsed now reads real seconds ("12 s"), so the line
  // moves on a sub-minute run instead of freezing at "under a minute".
  const timeLeft = terminal ? null : formatTimeLeft(run?.estimate ?? null, liveElapsedSecs)
  const elapsed =
    liveElapsedSecs === null
      ? null
      : terminal
        ? `took ${formatSecs(liveElapsedSecs)}`
        : `${formatSecs(liveElapsedSecs)} elapsed`
  const estimateWord = estimateQualityWord(run?.estimate?.estimate_quality ?? null)

  const predictionsReady = (run?.predictions_ready ?? false) || finishedCount > 0
  const bucketCounts = useMemo(() => {
    const methods = run?.methods ?? []
    const counts: Record<TxrRunBucket, number> = {
      all: methods.length,
      working: 0,
      finished: 0,
      failed: 0,
      stopped: 0,
      skipped: 0,
      cannot_run: 0,
    }
    for (const method of methods) counts[bucketOf(method.state)] += 1
    return counts
  }, [run])

  const resumed =
    (location.state as { resumed?: boolean } | null)?.resumed === true

  // Land on results when the run turns terminal WHILE this page is watching
  // it (RP-1 — the running screen's purpose is done; the results screen owns
  // the finished/failed/stopped state). A page opened directly at a terminal
  // run (a reload, a direct URL, the gallery's terminal snapshot story) is
  // NOT redirected — it renders the terminal snapshot with the run's own
  // terminal title. `sawLiveRef` records whether this page instance ever
  // rendered a live status.
  const sawLiveRef = useRef(false)
  useEffect(() => {
    if (run !== null && !terminal) sawLiveRef.current = true
  }, [run, terminal])
  useEffect(() => {
    if (run === null || !terminal || !sawLiveRef.current) return
    navigate(resultsPath(run.id))
  }, [run, terminal, navigate])

  // The table's row set is the active tab's bucket over the run's rows
  // (DEC-2's partition — "All" is the row count; ITEM-9 note (a): the
  // table receives the rows already filtered; it never filters).
  const visibleRows = useMemo(() => {
    const methods = run?.methods ?? []
    return tab === 'all' ? methods : methods.filter(m => bucketOf(m.state) === tab)
  }, [run, tab])

  // The per-state action's one home: the store's stop/skip calls, the
  // log-panel handoff (the panel renders at ITEM-11; the store's frozen
  // logOpen/logFilter state is what it reads) and the txrresults builder
  // for a finished method's own screen (PROV-UR-1, never a URL literal).
  const handleAction = (action: TxrRunRowAction): void => {
    switch (action.kind) {
      case 'stop':
        void TxrRun.stopMethod(action.methodId)
        break
      case 'skip':
        void TxrRun.skipMethod(action.methodId)
        break
      case 'log':
        TxrRun.setLogOpen(true)
        TxrRun.setLogFilter(action.methodId)
        break
      case 'view':
        navigate(methodResultsPath(run!.id, action.methodId))
        break
    }
  }

  // The log panel's history backfill (CONS-UI-RUN-10): on open and on a
  // method switch the store fetches the pre-SSE lines and merges them by
  // seq (the provider's own paged endpoint — the consumer never re-reads
  // or re-orders a log line). The panel reports the transition; the page
  // owns the store call, exactly the frozen props' reporting contract.
  const backfillLogs = (methodId: string | null): void => {
    const tail = state.liveLogs
    const afterSeq = tail.length > 0 ? tail[tail.length - 1].seq : undefined
    void TxrRun.loadLogs(methodId, afterSeq)
  }

  if (runError === 'not-found') {
    return <NotFoundRun history={historyPath()} />
  }
  if (runError === 'network') {
    return <NetworkErrorRun history={historyPath()} onRetry={TxrRun.retryLoad} />
  }
  if (run === null) {
    return <LoadingRun />
  }

  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      {resumed ? (
        <div style={NOTICE_ROW}>
          <Alert
            data-testid="txr-run-resumed-notice"
            tone="info"
            title={RESUMED_NOTICE_LINE}
          />
        </div>
      ) : null}
      <section style={CONTENT}>
        <TxrRunHeader
          title={title}
          timeLeft={timeLeft}
          elapsed={elapsed}
          estimateWord={estimateWord}
          atATime={state.atATime ?? run.config.at_a_time ?? null}
          cpus={run.cpus ?? null}
          predictionsReady={predictionsReady}
          runId={run.id}
          onSeeResults={() => navigate(resultsPath(run.id))}
        />
        <TxrCountsStrip counts={run.counts} />
        <div data-testid="txr-run-tabs" style={TAB_ROW}>
          {TABS.map(entry => (
            <Button
              key={entry.id}
              data-testid={`txr-run-tab-${entry.id}`}
              variant="outline"
              className="rounded-full font-normal"
              style={tab === entry.id ? ACTIVE_TAB : TAB_CHIP}
              aria-pressed={tab === entry.id}
              title={entry.definition}
              onClick={() => TxrRun.setTab(entry.id)}
            >
              {entry.label} {bucketCounts[entry.id]}
            </Button>
          ))}
          <span style={{ flexGrow: 1 }} />
          {tab === 'working' ? (
            <span
              data-testid="txr-run-tab-working-definition"
              style={{ fontSize: 12.5, color: 'var(--txr-muted)' }}
            >
              {TABS.find(t => t.id === 'working')?.definition}
            </span>
          ) : null}
          {!state.logOpen ? (
            <Button
              data-testid="txr-run-log-open"
              variant="link"
              style={{ fontSize: 14, fontWeight: 500 }}
              onClick={() => {
                TxrRun.setLogOpen(true)
                TxrRun.setLogFilter(null)
              }}
            >
              Show the log
            </Button>
          ) : null}
        </div>
        <TxrRunTable
          rows={visibleRows}
          perMethod={state.perMethod}
          rowErrors={state.rowErrors}
          onAction={handleAction}
          atATime={state.atATime}
          onAtATime={n => void TxrRun.setAtATime(n)}
          atATimeError={state.atATimeError}
          onStopAll={() => void TxrRun.stopAll()}
          stopping={state.stopping}
          terminal={terminal}
          actionError={state.actionError}
          nowMs={liveElapsedSecs === null ? null : Date.now()}
        />
        {!terminal ? (
          <div data-testid="txr-run-leave-note" style={LEAVE_NOTE}>
            {LEAVE_AND_CONTINUE_NOTE}
          </div>
        ) : null}
      </section>
      {state.logOpen ? (
        <TxrLogPanel
          lines={state.liveLogs}
          total={state.logTotal}
          methods={run.methods}
          filter={state.logFilter}
          onFilter={id => TxrRun.setLogFilter(id)}
          follow={state.logFollow}
          onFollow={v => TxrRun.setLogFollow(v)}
          open={state.logOpen}
          onOpenChange={v => TxrRun.setLogOpen(v)}
          onBackfill={backfillLogs}
        />
      ) : null}
    </main>
  )
}
