import { useEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { resultsPath } from '@/modules/txrresults/routes'
import { Alert, Button, Result, Skeleton } from '@ziee/kit'
import type { TxrRunBucket } from '../types'
import { bucketOf, formatSecs, formatTimeLeft } from '../lib/format'
import { historyPath } from '../routes'
import { TxrRun, useTxrRun } from '../stores/TxrRun.store'
import { TxrCountsStrip } from '../components/TxrCountsStrip'
import { formatRunTitle, TxrRunHeader } from '../components/TxrRunHeader'

/**
 * Screen F — Running (board `BusyRunning.dc.html`): one analysis run's live
 * surface. ITEM-9 delivers the page base: the run-id wiring (`useParams` →
 * the run store's `load`, once per id; a changed id resets and re-loads —
 * the single-instance-per-URL rule), the header block (methods count,
 * time left, elapsed, concurrency line, "See the results"), the five-count
 * strip, the All/Working/Finished/Failed tab chips (the page's filter
 * state, held in the run store so it survives a leave-and-continue) and
 * the not-found / network states (kit `Result` + the History link). The
 * method table + per-row actions (ITEM-10) and the log panel +
 * leave-and-continue note (ITEM-11) build on this base below the tab row.
 *
 * The header's facts are composed here and formatted in `lib/format.ts`
 * (INV-4 — the time-left is the run's own create-time estimate minus its
 * elapsed; nothing on this page computes a schedule). The tab chip counts
 * are the module's own partition (`bucketOf`, DEC-2 — a complete partition
 * of the eight engine states; "All" is the row count), so the four counts
 * always add up to the run's rows. The "See the results" link is live when
 * the run's `predictions_ready` or ≥1 method is finished (DEC-12 / INV-1:
 * results readable while the others still run).
 *
 * The 409-resolution notice (ITEM-8, DEC-18) stays: the E create path
 * navigates here with `{ resumed: true }` — the one line says the user is
 * watching the run that was already active.
 */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexWrap: 'wrap',
}

/** The board's main content column (flex-basis ordering = board: content
 *  first, log panel second — the log panel column joins at ITEM-11). */
const CONTENT: CSSProperties = {
  flex: '3 1 600px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '26px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

/** The resumed notice's full-width row (the page's flex-wrap layout). */
const NOTICE_ROW: CSSProperties = { flexBasis: '100%' }

/** The DEC-18 one-line notice (the 409 resolution's handoff line). */
const RESUMED_NOTICE_LINE = 'A run was already active — you are watching it now.'

/** The tab chips' row (the board's tab row above the method table; ITEM-10
 *  adds the run-N-at-a-time control to this same row). */
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

/** The tab chips' unselected look (the boards' pill; E's chips use the same). */
const TAB_CHIP = {
  borderRadius: 999,
  padding: '5px 12px',
  fontSize: 13.5,
  background: '#ffffff',
  color: '#3a3a3a',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#cfcdc7',
} as const

/** The active tab's look (the board's pressed pill). */
const ACTIVE_TAB = {
  ...TAB_CHIP,
  background: '#e8eef6',
  color: '#143a68',
  borderColor: '#1d4e89',
} as const

/** The tab row's board order (All → Working → Finished → Failed). */
const TABS: ReadonlyArray<{ id: TxrRunBucket; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working' },
  { id: 'finished', label: 'Finished' },
  { id: 'failed', label: 'Failed' },
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
  const title = formatRunTitle(run?.methods.length ?? 0)
  const elapsedSecs = run?.elapsed_secs ?? null
  const timeLeft = formatTimeLeft(run?.estimate ?? null, elapsedSecs)
  const elapsed = elapsedSecs === null ? null : formatSecs(elapsedSecs)
  const finishedCount = useMemo(
    () => (run?.methods ?? []).filter(m => m.state === 'finished').length,
    [run],
  )
  const predictionsReady = (run?.predictions_ready ?? false) || finishedCount > 0
  const bucketCounts = useMemo(() => {
    const methods = run?.methods ?? []
    const counts: Record<TxrRunBucket, number> = {
      all: methods.length,
      working: 0,
      finished: 0,
      failed: 0,
    }
    for (const method of methods) counts[bucketOf(method.state)] += 1
    return counts
  }, [run])

  const resumed =
    (location.state as { resumed?: boolean } | null)?.resumed === true

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
          atATime={run.config.at_a_time ?? null}
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
              onClick={() => TxrRun.setTab(entry.id)}
            >
              {entry.label} {bucketCounts[entry.id]}
            </Button>
          ))}
          <span style={{ flexGrow: 1 }} />
        </div>
      </section>
    </main>
  )
}
