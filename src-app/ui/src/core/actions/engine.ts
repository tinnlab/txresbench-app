import { useSyncExternalStore } from 'react'
import { callAsync, getAuthToken, getBaseUrl } from '@ziee/framework/api-client'
import { isDocumentUnloading } from '@ziee/framework/sync'
import { onAgentConnected, onAgentDisconnected } from './capabilityReport'
import { createActionContext } from './ctx'
import { getActionMeta, runAction } from './defineAction'
import { checkExpectedToken } from './versioned'
import { getInstanceRecord, getInstanceStateToken } from './instanceRegistry'
import { isContextActive } from './activeContext'
import { runSerialized } from './instanceLock'

// The frontend AGENT ENGINE (PLAN.md ITEM-14). Connects the dedicated agent
// SSE (`GET /api/mcp/agent/stream?session_id=<uuid>` — CONTRACT.md), dispatches
// `agent_invoke` frames to `runAction`, streams `ctx.progress` up as
// `POST /api/mcp/agent/progress`, posts the final `POST /api/mcp/agent/result`,
// and answers `ping` frames via `POST /api/mcp/agent/pong` using a per-request
// EXECUTION RECORD (ARCHITECTURE.md Layer 7). Reconnects on drop (mirrors
// `@ziee/framework/sync`'s `SyncClient` backoff/epoch shape — see
// `sdk/packages/framework/src/sync/SyncClient.ts`).
//
// The agent stream is a plain (non-`api_route`) SSE endpoint, so — like
// `sync`'s subscribe stream — it's opened with a hand-rolled authenticated
// `fetch` (EventSource can't set the `Authorization` header) rather than
// `ApiClient`. The three up-POSTs use the generic `callAsync` transport
// (auth/401-refresh/retry already built in) against the LITERAL paths from
// CONTRACT.md — `ApiClient.Mcp.*` doesn't exist yet (the OpenAPI regen for
// the backend's `modules/mcp` routes is a later step owned by another agent).

const SESSION_STORAGE_KEY = 'ziee-actions-session-id'
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
// A connection must stay alive this long before we trust it as "stable" and
// reset the reconnect backoff (mirrors SyncClient's STABLE_AFTER_MS).
const STABLE_AFTER_MS = 3_000

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped'

interface AgentInvokeFrame {
  type: 'agent_invoke'
  request_id: string
  action_id: string
  params: unknown
  /** Present when `action_id` is a `kind: 'instance'` action — the target
   *  `view_id` the backend extracted from `params` (`handlers.rs`'s
   *  `invoke_frontend`, ARCHITECTURE.md Layer 4/6). Absent for a
   *  `kind: 'global'` action. */
  view_id?: string
  /** Present when `action_id` is `mutating && stateful` AND the caller
   *  presented one (`params.expected`) — the read-before-write guard's
   *  claimed state token (ARCHITECTURE.md Layer 6). Absent when the caller
   *  omitted it (the engine then rejects `READ_REQUIRED` below) or the
   *  action isn't mutating+stateful. */
  expected_token?: string
}
/** The stream handshake. `connection_id` is server-minted per CONNECTION and is
 *  what a capability report correlates on — deliberately NOT our own
 *  `session_id`, which a reload legitimately persists, so two unrelated
 *  connections can share one. */
interface ConnectedFrame {
  type: 'connected'
  session_id: string
  connection_id: string
}
interface PingFrame {
  type: 'ping'
  request_id: string
}
interface AgentCancelFrame {
  type: 'agent_cancel'
  request_id: string
}
type AgentFrame =
  | ConnectedFrame
  | AgentInvokeFrame
  | PingFrame
  | AgentCancelFrame
  | { type: string; [key: string]: unknown }

/** Per-request liveness record (ARCHITECTURE.md Layer 7): kept while an
 *  `agent_invoke`'s `run` is in flight so a `ping{request_id}` can be
 *  answered `pong{processing}` (record present) or `pong{unknown}` (absent —
 *  reloaded page / already finished).
 *
 *  NOTE: an earlier draft carried `status: 'running' | 'awaiting'` +
 *  `currentWait`, meant to distinguish "genuinely blocked on an external
 *  wait" from "actively running" and forward that as `pong.waiting_on`.
 *  Nothing in this engine ever set either field — a global action's `run`
 *  has no real wait primitive (only synchronous work + `ctx.progress`
 *  ticks), so `waiting_on` was always `undefined` on the wire. Removed
 *  rather than shipped as dead weight; reintroduce both, plus the
 *  `waitingOn` plumbing through `postPong`, together if/when a genuine
 *  wait primitive (e.g. an `ctx.awaitInput`) lands. */
interface ExecutionRecord {
  lastActivity: number
  abort: AbortController
  logs: string[]
}

const executions = new Map<string, ExecutionRecord>()

// A bounded set of `request_id`s whose `agent_cancel` arrived before the
// matching `agent_invoke` — the SSE transport doesn't guarantee frame
// ordering across a reconnect, so this is a benign, expected race, not a
// bug in the backend. `handleInvoke` consults + clears this before running
// so the cancel isn't silently dropped. Capped so a misbehaving server
// couldn't grow this unbounded by sending cancels for invokes that never
// arrive; the oldest pending entry is evicted to make room (a very stale
// early-cancel is unlikely to still matter by the time 64 more arrive).
const EARLY_CANCEL_CAP = 64
const earlyCancels = new Set<string>()

let started = false
// Monotonic loop generation (mirrors SyncClient): a stop()/start() bumps this
// so a loop suspended in `reader.read()` supersedes itself instead of running
// a second concurrent stream.
let epoch = 0
let activeAbort: AbortController | null = null
let backoffMs = INITIAL_BACKOFF_MS
let sessionId: string | null = null

let status: ConnectionStatus = 'idle'
const statusListeners = new Set<(status: ConnectionStatus) => void>()

function setStatus(next: ConnectionStatus): void {
  if (status === next) return
  status = next
  statusListeners.forEach(listener => listener(next))
}

/** Current agent-stream connection status (non-reactive snapshot). */
export function getConnectionStatus(): ConnectionStatus {
  return status
}

/** Subscribe to connection-status changes. Returns an unsubscribe fn. */
export function subscribeConnectionStatus(
  listener: (status: ConnectionStatus) => void,
): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

/** React hook for the live connection status, via `useSyncExternalStore`.
 *  Prefer this over hand-rolling `useState(getConnectionStatus())` +
 *  `useEffect(() => subscribeConnectionStatus(setStatus), [])`: that pair
 *  has a render/commit gap — a status change landing between the initial
 *  render (which read the snapshot) and the effect actually subscribing is
 *  silently missed. `useSyncExternalStore` subscribes before paint and
 *  re-reads the snapshot on every notification, closing that gap. */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
}

/**
 * Resolve this tab's `session_id` (routing-only — ARCHITECTURE.md Layer 7:
 * "which connection is the controlled window", NOT a heartbeat). Persisted in
 * `sessionStorage` (per-tab). Restored only across a genuine reload
 * (`navigation.type === 'reload'`) so a `window.open`'d tab — which inherits
 * a COPY of `sessionStorage` — gets a FRESH id rather than hijacking the
 * original tab's control binding (the split-chat pop-out lesson referenced in
 * ARCHITECTURE.md).
 */
function resolveSessionId(): string {
  let navigationType: string | undefined
  try {
    const [entry] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[]
    navigationType = entry?.type
  } catch {
    // `PerformanceNavigationTiming` unsupported in this environment — treat
    // as a fresh load (safer default: never resurrect a stale binding).
  }

  if (navigationType === 'reload') {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (existing) return existing
  }

  const fresh = crypto.randomUUID()
  sessionStorage.setItem(SESSION_STORAGE_KEY, fresh)
  return fresh
}

/** Start the agent engine (idempotent). Call once a user is authenticated
 *  and holds `mcp::use` — see `src/modules/actions/module.tsx`. */
export function start(): void {
  if (started) return
  started = true
  backoffMs = INITIAL_BACKOFF_MS
  sessionId = resolveSessionId()
  const myEpoch = ++epoch
  setStatus('connecting')
  void connectLoop(myEpoch)
}

/** Stop the agent engine: aborts the stream + every in-flight execution's
 *  signal (so a `run` awaiting `ctx.signal` unwinds). Call on logout /
 *  permission loss. */
export function stop(): void {
  if (!started) return
  started = false
  epoch++
  activeAbort?.abort()
  activeAbort = null
  executions.forEach(record => record.abort.abort())
  executions.clear()
  earlyCancels.clear()
  onAgentDisconnected()
  setStatus('stopped')
}

async function connectLoop(myEpoch: number): Promise<void> {
  while (started && myEpoch === epoch) {
    try {
      await connectOnce(myEpoch)
    } catch (error) {
      if (!started || myEpoch !== epoch) break
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        // R2-G5 (help-r2.md): the agent stream is cut when the page
        // navigates or closes; that teardown is not a failure, so an
        // unloading document logs at debug while a genuine drop on a live
        // page stays a warn. The signal is the SDK sync module's own
        // (pagehide/pageshow) — one truth for both long-lived streams.
        if (isDocumentUnloading()) {
          console.debug('[actions] agent stream ended as the page unloads; reconnecting', error)
        } else {
          console.warn('[actions] agent stream ended; reconnecting', error)
        }
      }
    }
    if (!started || myEpoch !== epoch) break
    setStatus('reconnecting')
    await delay(backoffMs)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  }
}

async function connectOnce(myEpoch: number): Promise<void> {
  const token = getAuthToken()
  if (!token || !sessionId) {
    // No token while "started" = the session lapsed without a logout (token
    // expiry mid-refresh); quietly retry rather than warning every cycle.
    return
  }

  const baseUrl = await getBaseUrl()
  if (!started || myEpoch !== epoch) return

  const abort = new AbortController()
  activeAbort = abort

  const response = await fetch(
    `${baseUrl}/api/mcp/agent/stream?session_id=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      signal: abort.signal,
    },
  )

  // Superseded while the fetch was in flight.
  if (!started || myEpoch !== epoch) {
    abort.abort()
    return
  }

  if (!response.ok || !response.body) {
    throw new Error(`[actions] agent stream failed: ${response.status}`)
  }

  const stabilityTimer = globalThis.setTimeout(() => {
    backoffMs = INITIAL_BACKOFF_MS
  }, STABLE_AFTER_MS)
  setStatus('connected')

  const reader = response.body.getReader()
  const decoder = new globalThis.TextDecoder()
  let buffer = ''

  try {
    while (started && myEpoch === epoch) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r\n|\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) continue
        handleFrame(parsed as AgentFrame)
      }
    }
  } finally {
    globalThis.clearTimeout(stabilityTimer)
    // The stream ended for ANY reason (drop, abort, stop) — this connection is
    // gone, so stop reporting against its `connection_id`. The server has
    // already dropped its copy of the capability set with the connection; the
    // next `connected` frame re-reports the whole snapshot.
    onAgentDisconnected()
  }
}

function handleFrame(frame: AgentFrame): void {
  switch (frame.type) {
    case 'connected':
      // The server binds a FRESH connection with an empty capability set, so
      // every connect — including a reconnect after a drop, where this page's
      // action registry survived and the server's copy did not — re-reports
      // the full snapshot. See `./capabilityReport.ts`.
      onAgentConnected((frame as ConnectedFrame).connection_id)
      return
    case 'agent_invoke':
      void handleInvoke(frame as AgentInvokeFrame)
      return
    case 'ping':
      void handlePing(frame as PingFrame)
      return
    case 'agent_cancel':
      handleCancel(frame as AgentCancelFrame)
      return
    default:
      // Forward-compatible: an unknown frame type is ignored, not fatal.
      console.warn('[actions] unknown agent frame', frame)
  }
}

/**
 * The read-before-write / stale-state guard (PLAN.md ITEM-7; ARCHITECTURE.md
 * Layer 6) — checked SYNCHRONOUSLY (single JS tick, no `await` in between)
 * BEFORE `runAction` is ever called for a `kind: 'instance'` action. Returns
 * the rejection error message to post as the result, or `null` when the
 * invoke may proceed.
 *
 * A single synchronous call to this function IS atomic against anything else
 * — but `handleInvoke` calls it TWICE for a mutating+stateful instance
 * action: once here, immediately on frame receipt (a fast fail for an
 * obviously-dead/stale invoke, before any execution bookkeeping is set up),
 * and again inside the per-instance serialized queue (`./instanceLock.ts`'s
 * `runSerialized`) as the very first statement once this invoke's turn
 * starts. That second call is what actually closes the race: `runAction`'s
 * `run` is `async` and may itself `await` before applying its mutation, so
 * two concurrent same-instance invokes could otherwise both pass THIS check
 * before either one's mutation lands. Serializing per-instance + re-checking
 * at dispatch time makes the whole check-then-apply sequence atomic across
 * the `await`, without this function itself needing to change.
 *
 * Only applies to `kind: 'instance'` actions:
 *   - the target instance must currently be registered (`NOT_FOUND` — the
 *     "gone / replaced instance" case, ARCHITECTURE.md Layer 6);
 *   - a `mutating && stateful` action additionally requires a PRESENT
 *     (`READ_REQUIRED`) and MATCHING (`STALE_STATE`) `expected_token`.
 * A `kind: 'global'` action (or an instance action missing `meta`, which
 * never happens for a real registration but is handled defensively) is
 * never guarded here — `runAction` itself reports an unknown action id.
 */
/**
 * The CONTEXT guard (PLAN.md ITEM-4) — the sibling of `checkInstanceGuard`,
 * checked SYNCHRONOUSLY BEFORE `runAction` is ever called. An action declaring
 * a non-`'global'` `context` (`defineAction`'s `context`, ARCHITECTURE.md
 * Layer 1) is only invokable while that context is ACTIVE (a surface mirrored
 * it into `./activeContext.ts` via `useActiveContext`). When the declared
 * context is inactive, this returns a structured `CONTEXT_INACTIVE:<context>`
 * rejection naming the context so the AI agent navigates there first, then
 * re-invokes — the same reject-before-`run` shape `checkInstanceGuard` uses
 * for `STALE_STATE` (reused per INFRA_INTEGRATION.md's engine walk).
 *
 * `'global'` (the default) always passes; an unknown action id passes here
 * (`runAction` itself reports the unknown id) so this guard never masks the
 * clearer `ActionNotFoundError`.
 *
 * Exported for unit testing (TEST-107) — it is otherwise called only from
 * `handleInvoke` below.
 */
export function checkContextGuard(frame: AgentInvokeFrame): string | null {
  const meta = getActionMeta(frame.action_id)
  if (!meta) return null
  if (meta.context === 'global') return null
  if (!isContextActive(meta.context)) {
    return `CONTEXT_INACTIVE: ${meta.context}`
  }
  return null
}

function checkInstanceGuard(frame: AgentInvokeFrame): string | null {
  const meta = getActionMeta(frame.action_id)
  if (!meta || meta.kind !== 'instance') return null

  const viewId = frame.view_id
  if (!viewId) {
    return 'INVALID_PARAMS: view_id is required for an instance action'
  }
  if (!getInstanceRecord(viewId)) {
    return `NOT_FOUND: no live instance "${viewId}"; call views.list to see live instances`
  }
  if (meta.mutating && meta.stateful) {
    const current = getInstanceStateToken(viewId)
    // `current` is always defined here (the instance is registered, and a
    // registered instance's `getSnapshot()` is expected to stamp a token via
    // `./versioned.ts`) — fall back to the empty string only so a
    // misbehaving instance that omits `_state_token` still fails the
    // compare below rather than throwing.
    const check = checkExpectedToken(current ?? '', frame.expected_token)
    if (check === 'missing') {
      return `READ_REQUIRED: call view.describe('${viewId}') for its current state token before writing`
    }
    if (check === 'stale') {
      return (
        `STALE_STATE: view "${viewId}" changed (expected ${frame.expected_token}, ` +
        `now ${current}); re-read view.describe('${viewId}') and retry`
      )
    }
  }
  return null
}

async function handleInvoke(frame: AgentInvokeFrame): Promise<void> {
  const { request_id: requestId, action_id: actionId, params } = frame
  if (executions.has(requestId)) {
    // Duplicate invoke (e.g. a redelivered frame after a brief reconnect) —
    // never double-run the same request.
    return
  }

  // CONTEXT guard runs FIRST (PLAN.md ITEM-4): an action whose declared page
  // context isn't active is rejected before any instance/token checks, so the
  // agent is told to navigate there rather than getting a confusing
  // NOT_FOUND/READ_REQUIRED about an instance it can't reach yet.
  const contextError = checkContextGuard(frame)
  if (contextError !== null) {
    await postResult(requestId, { ok: false, result: null, error: contextError, logs: [] })
    return
  }

  const guardError = checkInstanceGuard(frame)
  if (guardError !== null) {
    // Rejected before ever calling `runAction` — no execution record, no
    // liveness tracking needed (nothing asynchronous ever started).
    await postResult(requestId, { ok: false, result: null, error: guardError, logs: [] })
    return
  }

  const abort = new AbortController()
  if (earlyCancels.delete(requestId)) {
    // A cancel for this request already arrived before this invoke (see
    // `earlyCancels`) — honor it immediately instead of starting a run that
    // was already told to stop.
    abort.abort()
  }
  const record: ExecutionRecord = {
    lastActivity: Date.now(),
    abort,
    logs: [],
  }
  executions.set(requestId, record)

  const ctx = createActionContext({
    signal: abort.signal,
    onProgress: (message, data) => {
      record.lastActivity = Date.now()
      void postProgress(requestId, message, data)
    },
    onLog: line => {
      record.lastActivity = Date.now()
      record.logs.push(line)
    },
  })

  // Mutating INSTANCE invokes are serialized per `view_id` (`./instanceLock.
  // ts`) — global actions and non-mutating/read instance actions (`views.
  // list`, `view.describe`, …) are never serialized; nothing about them can
  // race a same-target write the way a stale-token guard can.
  const meta = getActionMeta(actionId)
  const viewId = frame.view_id
  const needsInstanceSerialization =
    meta?.kind === 'instance' && meta.mutating && viewId !== undefined

  const dispatch = async (): Promise<unknown> => {
    if (needsInstanceSerialization) {
      // Re-check the guard as the FIRST statement of this queued task — by
      // now every earlier same-instance mutating invoke has fully settled,
      // so this sees the LIVE token rather than the one current when the
      // frame first arrived (see the long comment on `checkInstanceGuard`).
      const recheck = checkInstanceGuard(frame)
      if (recheck !== null) {
        throw new Error(recheck)
      }
    }
    return runAction(actionId, params, ctx)
  }

  try {
    const result = needsInstanceSerialization
      ? await runSerialized(viewId, dispatch)
      : await dispatch()
    await postResult(requestId, {
      ok: true,
      result: result ?? null,
      error: null,
      logs: record.logs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await postResult(requestId, {
      ok: false,
      result: null,
      error: message,
      logs: record.logs,
    })
  } finally {
    executions.delete(requestId)
  }
}

async function handlePing(frame: PingFrame): Promise<void> {
  const record = executions.get(frame.request_id)
  if (!record) {
    await postPong(frame.request_id, 'unknown')
    return
  }
  await postPong(frame.request_id, 'processing', Date.now() - record.lastActivity)
}

function handleCancel(frame: AgentCancelFrame): void {
  const record = executions.get(frame.request_id)
  if (record) {
    record.abort.abort()
    return
  }
  // No matching execution yet — the cancel raced ahead of its invoke over
  // the SSE stream. Remember it (bounded) so `handleInvoke` can honor it
  // the moment the invoke actually arrives, instead of silently dropping it.
  if (earlyCancels.size >= EARLY_CANCEL_CAP) {
    const oldest = earlyCancels.values().next().value
    if (oldest !== undefined) earlyCancels.delete(oldest)
  }
  earlyCancels.add(frame.request_id)
}

async function postProgress(
  requestId: string,
  message: string,
  data?: unknown,
): Promise<void> {
  try {
    await callAsync('POST /api/mcp/agent/progress', {
      request_id: requestId,
      message,
      data,
    })
  } catch (error) {
    console.warn('[actions] failed to post progress', error)
  }
}

async function postResult(
  requestId: string,
  body: { ok: boolean; result: unknown; error: string | null; logs: string[] },
): Promise<void> {
  try {
    await callAsync('POST /api/mcp/agent/result', {
      request_id: requestId,
      ok: body.ok,
      result: body.result,
      error: body.error,
      logs: body.logs,
    })
  } catch (error) {
    console.warn('[actions] failed to post result', error)
  }
}

async function postPong(
  requestId: string,
  pongStatus: 'processing' | 'unknown',
  sinceMs?: number,
): Promise<void> {
  try {
    await callAsync('POST /api/mcp/agent/pong', {
      request_id: requestId,
      status: pongStatus,
      since_ms: sinceMs,
    })
  } catch (error) {
    console.warn('[actions] failed to post pong', error)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms))
}
