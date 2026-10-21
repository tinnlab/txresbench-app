// runSession — the RUN LIFECYCLE, lifted out of the component that renders it.
//
// ## The defect this exists to fix
//
// `AnalysisRunPanel` held the whole of a run — state (`running`/`done`, the phase
// timeline, the log scrollback, the resource metric, the job id, the resolved run id,
// the error) in ten `useState`s, and the SSE subscription in a ref disposed by
//
//     useEffect(() => () => subRef.current?.dispose(), [])
//
// with nothing that re-subscribed. A region renders only its ACTIVE tab
// (`RegionShell`: `{active ? <PaneBody/> : null}`), so switching to a sibling tab
// UNMOUNTS the panel: the subscription was disposed, the state was destroyed, and the
// pane came back reading `idle` while the run carried on server-side. The user's view
// of their own run was dropped by looking away from it.
//
// ## Why the state moved rather than the subscription being re-established
//
// Re-subscribing on mount is not sufficient, and the case it misses is the ordinary
// one: a run that FINISHES while the pane is away. Its terminal frame is delivered to
// nobody, so a re-subscribe attaches to a stream that will never speak again and the
// pane spins forever — and even for a run still going, every phase and log line emitted
// while away is simply gone from a timeline that is only ever built from frames.
//
// So the session owns the subscription and outlives the render. A terminal frame is
// processed with no component mounted; the pane, when it returns, READS a finished run.
// `paneState.ts` already documents this exact remedy for pane-scoped `useState` ("a
// region renders only its ACTIVE tab, so every `useState` inside a pane is destroyed the
// moment the user looks at a sibling tab") and this is the same move for the one piece
// of pane state that is not a value but a LIVE PROCESS.
//
// A session is keyed by the HOST's stable key — the pane id, for the three pane hosts —
// so it survives a move / pop-out / return exactly as `paneState` does, and it is
// released when the pane CLOSES (`releaseRunSession`, wired to `clearPaneState`).
//
// `reconcileRunSession` is the belt-and-braces the surviving subscription does not
// replace: an SSE stream can drop without a terminal frame, so a mount that finds a
// session still claiming `running` asks the server what actually happened. That path is
// what makes "left spinning" unreachable rather than merely unlikely.
//
// This module is React-free apart from one `useSyncExternalStore` hook and takes every
// backend call as an injected dep, so the lifecycle is directly testable without a DOM
// or an ApiClient — the same discipline `jobsCapability.ts` follows.

import { useSyncExternalStore } from 'react'
import { onPaneClosed, type Disposable } from '@/modules/workbench/core'
import type { FrameLog, FrameMetric, JobFrame, WorkbenchJobFrame } from '../jobs'
import type { RunPhase } from './RunProgressConsole'
import { upsertPhase } from './runPhases'

export type RunState = 'idle' | 'running' | 'done' | 'error' | 'stopped'

/** Everything the run half of the panel renders. Plain data — no handles, no closures. */
export interface RunSessionSnapshot {
  runState: RunState
  phases: RunPhase[]
  logs: FrameLog[]
  metric: FrameMetric | null
  /** the job being streamed (null between the Run click and the id landing). */
  jobId: string | null
  /** the run id the outputs are reviewed by (ITEM-24), resolved on completion. */
  runId: string | null
  /** the no-`run_id` fallback artifact (legacy / fake-host facade). */
  fallbackArtifactId: string | null
  /** the produced artifact, for the completion flow guidance (ITEM-35). */
  producedArtifactId: string | null
  error: string | null
  stopping: boolean
}

export const IDLE_RUN_SESSION: RunSessionSnapshot = {
  runState: 'idle',
  phases: [],
  logs: [],
  metric: null,
  jobId: null,
  runId: null,
  fallbackArtifactId: null,
  producedArtifactId: null,
  error: null,
  stopping: false,
}

/** A minimal artifact row shape — only what the fallback path reads. */
export interface RunSessionArtifactRow {
  id: string
  created_at: string
}

/**
 * The backend + host calls the lifecycle makes. Injected rather than imported so this
 * module stays testable, and re-supplied on every mount so a completion that lands after
 * a remount calls the CURRENT host's callbacks rather than a dead render's.
 */
export interface RunSessionDeps {
  /** `GET /api/jobs/{id}` — the run-id resolution AND the `reconcile` status read. */
  getJob(jobId: string): Promise<{ status?: string; run_id?: string | null; id: string }>
  /** `GET /api/jobs/{id}/logs` — the scrollback backfill on completion. */
  getLogs(jobId: string): Promise<FrameLog[]>
  /** the produced-kind artifact query (the no-`run_id` fallback only). */
  queryArtifacts(kind: string): Promise<RunSessionArtifactRow[]>
  /** the kind this analysis produces, for that fallback (absent ⇒ no fallback). */
  artifactKind?: string
  refreshCatalog(): void
  notify(message: string, tone: 'info' | 'error'): void
  onArtifact?(artifactId: string | null): void
  onRunComplete?(runId: string): void
}

interface Session {
  snapshot: RunSessionSnapshot
  sub: Disposable | null
  deps: RunSessionDeps | null
  /** guards `reconcile` against a concurrent re-entry from a second mount. */
  reconciling: boolean
}

const sessions = new Map<string, Session>()
const listeners = new Set<() => void>()

function publish(): void {
  for (const l of listeners) l()
}

function session(key: string): Session {
  let s = sessions.get(key)
  if (!s) {
    s = { snapshot: IDLE_RUN_SESSION, sub: null, deps: null, reconciling: false }
    sessions.set(key, s)
  }
  return s
}

/** Read a session's snapshot (the idle one when there is none). */
export function getRunSession(key: string): RunSessionSnapshot {
  return sessions.get(key)?.snapshot ?? IDLE_RUN_SESSION
}

/** Merge a patch into a session's snapshot. */
export function patchRunSession(key: string, patch: Partial<RunSessionSnapshot>): void {
  const s = session(key)
  s.snapshot = { ...s.snapshot, ...patch }
  publish()
}

/** Re-point a session at the CURRENT host's callbacks (called on every render). */
export function setRunSessionDeps(key: string, deps: RunSessionDeps): void {
  session(key).deps = deps
}

/** Reactive read. Re-renders on any session change; the snapshot identity is stable
 *  between mutations, so an unrelated session's write does not re-render this one. */
export function useRunSession(key: string): RunSessionSnapshot {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => getRunSession(key),
    () => getRunSession(key),
  )
}

/**
 * Dispose a session's stream and forget it. Called when the PANE CLOSES — never on
 * unmount, which is the whole point of this module.
 */
export function releaseRunSession(key: string): void {
  const s = sessions.get(key)
  if (!s) return
  s.sub?.dispose()
  sessions.delete(key)
  publish()
}

// A pane-hosted session is keyed by the PANE ID, and CLOSING the pane is the one event
// that genuinely ends the run's stream (unmount does not — that is the defect). Wired
// once, at module scope, so no host has to remember it: forgetting it at one of the three
// pane hosts would leak an SSE connection per closed run pane.
onPaneClosed(paneId => releaseRunSession(paneId))

/** Test-only reset. */
export function __resetRunSessions(): void {
  for (const s of sessions.values()) s.sub?.dispose()
  sessions.clear()
  publish()
}

/**
 * Begin a run: reset the snapshot to a fresh `running` and drop any prior stream.
 *
 * The job id is cleared here deliberately — `stop()` reads it, and leaving the PREVIOUS
 * run's id in place across the `jobs.run` await would aim Stop at the wrong run.
 */
export function beginRunSession(key: string, deps: RunSessionDeps): void {
  const s = session(key)
  s.sub?.dispose()
  s.sub = null
  s.deps = deps
  s.snapshot = { ...IDLE_RUN_SESSION, runState: 'running' }
  publish()
}

/** Attach the launched job's stream. The session owns it from here until release. */
export function attachRunSession(key: string, jobId: string, handle: { onProgress(cb: (f: JobFrame) => void): Disposable }): void {
  const s = session(key)
  s.snapshot = { ...s.snapshot, jobId }
  s.sub?.dispose()
  s.sub = handle.onProgress(f => onFrame(key, f))
  publish()
}

/** Record a launch that never produced a job (the `jobs.run` throw path). */
export function failRunSession(key: string, message: string): void {
  patchRunSession(key, { runState: 'error', error: message })
}

// ── frame handling (runs whether or not anything is mounted) ────────────────────────

function onFrame(key: string, f: JobFrame): void {
  const wf = f as WorkbenchJobFrame
  if (wf.kind === 'log' && wf.log) {
    const log = wf.log
    const s = session(key)
    patchRunSession(key, { logs: [...s.snapshot.logs, log] })
    return
  }
  if (wf.kind === 'metric' && wf.metric) {
    patchRunSession(key, { metric: wf.metric })
    return
  }
  if (wf.kind === 'progress') {
    patchRunSession(key, { phases: upsertPhase(getRunSession(key).phases, f.phase, f.pct) })
    return
  }
  // A `status` frame (or a kind-less fake-host frame): drive the lifecycle by phase.
  const phase = f.phase.toLowerCase()
  if (phase === 'completed' || phase === 'failed' || phase === 'stopped') {
    void finishTerminal(key, getRunSession(key).jobId ?? '', phase, f.message ?? undefined)
  } else if (phase) {
    patchRunSession(key, { phases: upsertPhase(getRunSession(key).phases, f.phase, f.pct) })
  }
}

/** Merge log lines by `seq`, dropping duplicates (streamed frames + the scrollback
 *  read converge without doubling lines). */
export function mergeLogs(a: FrameLog[], b: FrameLog[]): FrameLog[] {
  const seen = new Set(a.map(l => l.seq))
  const merged = [...a]
  for (const l of b) if (!seen.has(l.seq)) merged.push(l)
  return merged.sort((x, y) => x.seq - y.seq)
}

/** The newest artifact of the produced kind — the NO-`run_id` fallback only (a fake /
 *  host facade that cannot scope by run; the production path lists by `run_id`). */
export function pickNewest(rows: RunSessionArtifactRow[]): RunSessionArtifactRow | undefined {
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/**
 * The terminal transition. Unchanged in substance from the version that lived in the
 * component — it is here so it can run with nothing mounted, which is exactly the case
 * a tab switch creates.
 */
async function finishTerminal(key: string, jid: string, phase: string, message?: string): Promise<void> {
  const s = session(key)
  const deps = s.deps
  s.sub?.dispose()
  s.sub = null
  if (!deps) {
    // No host has ever supplied deps (only reachable from a synthetic frame). Record the
    // lifecycle anyway rather than leaving the session claiming `running`.
    patchRunSession(key, phase === 'completed' ? { runState: 'done' } : { runState: phase === 'stopped' ? 'stopped' : 'error', error: message ?? `Run ${phase}` })
    return
  }

  // Fill the complete log from the scrollback endpoint (a late-mounted pane / a dropped
  // SSE frame could have gaps — the streamed frames + this converge).
  if (jid) {
    try {
      const lines = await deps.getLogs(jid)
      patchRunSession(key, { logs: mergeLogs(getRunSession(key).logs, lines) })
    } catch {
      /* fake host / no backend — keep the streamed logs */
    }
  }

  if (phase !== 'completed') {
    patchRunSession(key, {
      error: message ?? `Run ${phase}`,
      runState: phase === 'stopped' ? 'stopped' : 'error',
      stopping: false,
    })
    deps.onArtifact?.(null)
    return
  }

  patchRunSession(key, { phases: getRunSession(key).phases.map(p => ({ ...p, state: 'done' as const })) })

  // ITEM-24 — resolve the run + review its outputs DETERMINISTICALLY by run_id. A THROWN
  // `getJob` (a REAL job that HAS a run_id, hit by a transient error) must NOT fall
  // through to the racy project-wide `pickNewest` ITEM-24 eliminated: retry briefly
  // first, and reserve the `pickNewest` fallback STRICTLY for a job that RESOLVES with
  // `run_id == null` (the legacy / fake-host facade that cannot scope by run).
  let resolved: { runId: string | null } | undefined
  for (let attempt = 0; attempt < 3 && !resolved; attempt++) {
    try {
      const detail = await deps.getJob(jid)
      // The backend keys a run's artifacts by `run_id = job.run_id.unwrap_or(job.id)`, so
      // a completed analysis whose `run_id` column is null is still reviewable by its JOB
      // id. Mirror that convention here.
      resolved = { runId: detail.run_id ?? detail.id }
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)))
    }
  }
  if (resolved?.runId) {
    patchRunSession(key, { runId: resolved.runId })
    deps.onRunComplete?.(resolved.runId)
  } else if (resolved && deps.artifactKind) {
    try {
      const rows = await deps.queryArtifacts(deps.artifactKind)
      const artifactId = pickNewest(rows)?.id ?? null
      patchRunSession(key, { fallbackArtifactId: artifactId })
      deps.onArtifact?.(artifactId)
    } catch {
      /* result lookup is best-effort — the run still completed */
    }
  } else if (!resolved) {
    // `getJob` never answered: do NOT pickNewest (racy — ITEM-24). Leave the result
    // unresolved and surface a non-alarming note; the run itself still completed.
    deps.notify('Run completed — artifacts could not be loaded (open it from the run history)', 'info')
  }
  deps.refreshCatalog()
  patchRunSession(key, { runState: 'done', stopping: false })
}

/**
 * The mount-time reconcile.
 *
 * The session's stream survives an unmount, so the ordinary "it finished while you were
 * on another tab" case is already handled by the time this runs. What this covers is the
 * stream that DIED without saying so — an aborted SSE, a network drop, a server restart —
 * which would otherwise leave the pane rendering a spinner over a job that ended minutes
 * ago. A session still claiming `running` asks the server what the job's status actually
 * is and, if it is terminal, runs the same terminal transition a frame would have.
 *
 * It is a single read on mount, never a poll: a live stream is the mechanism, and this is
 * only its failure handler.
 */
export async function reconcileRunSession(key: string, deps: RunSessionDeps): Promise<void> {
  const s = session(key)
  s.deps = deps
  const { runState, jobId } = s.snapshot
  if (runState !== 'running' || !jobId || s.reconciling) return
  s.reconciling = true
  try {
    const detail = await deps.getJob(jobId)
    const status = (detail.status ?? '').toLowerCase()
    // Re-read: a terminal frame may have landed on the live stream while this was in
    // flight, and re-running the transition would double the completion side effects.
    if (getRunSession(key).runState !== 'running') return
    if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'cancelled') {
      await finishTerminal(key, jobId, status === 'cancelled' ? 'stopped' : status)
    }
    // Still running ⇒ nothing to do: the session's own subscription is the live channel.
  } catch {
    /* unknown: leave the run as it is rather than declaring it failed on a read error */
  } finally {
    s.reconciling = false
  }
}
