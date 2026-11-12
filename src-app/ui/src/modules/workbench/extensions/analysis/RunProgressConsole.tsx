// The live run console (ITEM-23) — the CORE run-pane deliverable. NOT a boolean
// spinner: a real PHASE TIMELINE (driven by the SSE `progress` frames — ITEM-22), a
// live LOG console (streamed `log` frames + the `Jobs.logs` scrollback), the latest
// resource sample, an itemized error, and an editor-only Stop. Presentational — the
// panel owns the state machine + the subscription; this renders it.

import { useEffect, useRef, type ComponentRef } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Alert, Button, Progress, ScrollArea } from '@txresbench/kit'
import type { FrameMetric, FrameLog } from '../jobs/jobFrames'

/** A phase in the run timeline (from the SSE `progress` frames). */
export interface RunPhase {
  name: string
  pct?: number
  state: 'active' | 'done'
}

export type ConsoleStatus = 'running' | 'done' | 'error' | 'stopped'

export interface RunProgressConsoleProps {
  status: ConsoleStatus
  phases: RunPhase[]
  logs: FrameLog[]
  metric?: FrameMetric | null
  error?: string | null
  /**
   * Whether the current STATUS is stoppable (running) — i.e. whether a Stop control exists at
   * all. It is deliberately NOT "and the user may". Who may stop a run (its creator, the owner
   * of the dataset/project it runs on, an admin) is the server's answer, arrives as `can_stop`,
   * and reaches this component as `stopUnavailableReason` — see `modules/jobs/stopAuthority`.
   */
  canStop: boolean
  /**
   * WHY Stop is refused, when it is. Set -> the control is VISIBLE but unavailable, stating the
   * reason through the tooltip and `aria-describedby`; unset -> it fires. Never hidden: a user
   * who cannot end a run needs to see that the control exists and read why it refuses.
   */
  stopUnavailableReason?: string
  stopping?: boolean
  onStop?: () => void
  analysisId: string
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const mb = n / 1048576
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function RunProgressConsole({
  status,
  phases,
  logs,
  metric,
  error,
  canStop,
  stopUnavailableReason,
  stopping,
  onStop,
  analysisId,
}: RunProgressConsoleProps) {
  const logRef = useRef<ComponentRef<typeof ScrollArea>>(null)
  // Auto-scroll the log console to the newest line. The console is the kit `ScrollArea`, so the
  // element that actually scrolls is overlayscrollbars' VIEWPORT, not the component's host — a
  // `scrollTop` on the host is silently a no-op, which is how a log box stops following.
  useEffect(() => {
    const el = logRef.current?.osInstance()?.elements().viewport
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  const active = phases.find(p => p.state === 'active')

  return (
    <div className="flex flex-col gap-3" data-testid={`workbench-run-console-${analysisId}`}>
      {/* Header: live/stopped indicator + Stop. */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {status === 'running' ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              <span data-testid={`workbench-run-live-${analysisId}`}>
                {active ? active.name : 'queued'}
              </span>
            </>
          ) : status === 'done' ? (
            <>
              <CheckCircle2 className="size-4 text-success" aria-hidden />
              <span>Completed</span>
            </>
          ) : (
            <span>{status === 'stopped' ? 'Stopped' : 'Failed'}</span>
          )}
        </span>
        {canStop && (
          <Button
            variant="destructive"
            className="ms-auto"
            loading={stopping}
            disabled={stopping}
            unavailableReason={stopUnavailableReason}
            onClick={onStop}
            data-testid={`workbench-run-stop-${analysisId}`}
          >
            Stop
          </Button>
        )}
      </div>

      {/* Phase timeline — every phase the run announced, with its progress. */}
      {phases.length > 0 && (
        <ol className="flex flex-col gap-1.5" data-testid={`workbench-run-timeline-${analysisId}`}>
          {phases.map(phase => (
            <li key={phase.name} className="flex items-center gap-2" data-testid={`workbench-run-phase-${phase.name}`}>
              <span
                aria-hidden
                className={
                  phase.state === 'done'
                    ? 'size-2 rounded-full bg-success'
                    : 'size-2 rounded-full bg-primary'
                }
              />
              <span className="min-w-24 text-xs font-medium">{phase.name}</span>
              {phase.pct != null && (
                <Progress
                  // The backend `ProgressFrame.pct` is authoritatively 0-100 (the sandbox
                  // progress emitter casts `int(pct)`, e.g. 10/40/100) — clamp to [0,100]
                  // directly. (A fraction-detection heuristic misread a legitimate `pct==1`
                  // — i.e. 1% — as 100%.)
                  value={Math.max(0, Math.min(100, phase.pct))}
                  size="sm"
                  showInfo
                  aria-label={`${phase.name} progress`}
                  className="flex-1"
                  data-testid={`workbench-run-phase-bar-${phase.name}`}
                />
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Latest resource sample (from the `metric` frames — real cpu/mem, ITEM-22). */}
      {metric && (
        <div className="text-xs text-muted-foreground" data-testid={`workbench-run-metric-${analysisId}`}>
          CPU {metric.cpuPct.toFixed(0)}% · Mem {formatBytes(metric.memBytes)}
          {metric.pidsCurrent != null ? ` · ${metric.pidsCurrent} proc` : ''}
        </div>
      )}

      {/* Live log console (+ Jobs.logs scrollback). */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Log</span>
        <ScrollArea
          ref={logRef}
          data-testid={`workbench-run-logs-${analysisId}`}
          className="max-h-64 whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">No output yet</span>
          ) : (
            logs.map(l => (
              <div key={`${l.seq}-${l.content}`} className={l.stream === 'stderr' ? 'text-destructive' : undefined}>
                {l.content}
              </div>
            ))
          )}
        </ScrollArea>
      </div>

      {/* Itemized error (the run's failure detail). */}
      {status === 'error' && error && (
        <Alert
          tone="error"
          title="Run failed"
          description={error}
          data-testid={`workbench-run-error-${analysisId}`}
        />
      )}
    </div>
  )
}
