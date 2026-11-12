// The AI CAPABILITY REPORT — this browser session tells the backend which
// view-scoped actions it has registered, so the backend can put them in the MCP
// capability catalog without deriving them itself.
//
// ## Why the frontend is the reporter
//
// The backend used to WALK the processor packages and re-parse every
// `view_spec` with a partial mirror of a schema this runtime owns, purely to
// project the declared `actions:` into capability entries. Two parsers of one
// document, with nothing forcing them to agree. The projection belongs on the
// side that owns the document, and the moment the real set is known is exactly
// when `registerViewSpecActions` registers it (`workbench/core/runtime/
// interpreter.ts`, called from `declarativeMount.ts` / `runtime/register.ts`).
//
// ## Why the lifetime is the agent connection's
//
// A `kind:"frontend"` capability is only invokable through the bound agent
// channel: the backend's `invoke_capability` dispatches down the SSE stream to
// THIS session and fails `FRONTEND_NOT_CONNECTED` when there is none. So the
// report is correlated to the connection (`connection_id`, handed to us in the
// stream's `connected` handshake) and the server drops it when the connection
// unbinds. That is also why we RE-report the full snapshot on every reconnect:
// this module's registry survives an SSE drop, the server's copy does not, and
// silently losing a capability that IS invokable is as wrong as advertising one
// that is not.
//
// Every report is a FULL SNAPSHOT, never a delta — an add-only protocol could
// not express a removal.

import { callAsync } from '@txresbench/framework/api-client'

/** One reported capability. Field-for-field the backend's
 *  `FrontendActionEntry` (`server/src/modules/mcp/frontend_catalog.rs`), which
 *  is also the shape of an entry in the committed app-owned
 *  `frontend-actions.json` — ONE catalog shape, whether an entry was baked in
 *  or reported. */
export interface AiCapability {
  id: string
  title: string
  /** `'instance'` addresses a live `view_id`; `'global'` is invoked by id. */
  kind: 'global' | 'instance'
  mutating: boolean
  stateful: boolean
  /** the page context that must be active — `'global'` = always. */
  context: string
  /** MANDATORY. The backend is authoritative for the permission check and
   *  drops a permission-less entry fail-closed, so an entry that reaches here
   *  without one is simply never advertised. */
  permission: string
  /** JSON Schema for the invoke body. */
  params_schema: Record<string, unknown>
  description?: string
}

/** The reported set, keyed by id. ADD-ONLY within a page lifetime, mirroring
 *  `registerViewSpecActions` + the `defineAction` registry it feeds: an action
 *  stays dispatchable once registered (whether a matching live instance exists
 *  is the engine's `NOT_FOUND` verdict at invoke, not an availability
 *  question). A page reload resets both together. */
const reported = new Map<string, AiCapability>()

/** The connection the current snapshot belongs to. `null` while no agent
 *  stream is connected — a report then has nothing to correlate to, and the
 *  capabilities are not invokable anyway. */
let connectionId: string | null = null

/** Coalesces the burst of `publishCapabilities` calls a multi-view mount
 *  produces into ONE POST. */
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DEBOUNCE_MS = 50

/** Merge `capabilities` into the reported set and schedule a snapshot POST.
 *  A no-op when nothing actually changed, so a component re-mount costs
 *  nothing. */
export function publishCapabilities(capabilities: readonly AiCapability[]): void {
  let changed = false
  for (const capability of capabilities) {
    if (reported.has(capability.id)) continue
    reported.set(capability.id, capability)
    changed = true
  }
  if (changed) scheduleFlush()
}

/** The full current snapshot, in stable id order (so a report is comparable
 *  and a test can assert it). */
export function capabilitySnapshot(): AiCapability[] {
  return [...reported.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The agent stream connected (or RE-connected) under `id`. Adopts the new
 * connection and re-reports the full snapshot immediately: the server binds a
 * fresh connection with an EMPTY capability set, so without this a reconnect
 * would silently drop every view-scoped capability this page can still invoke.
 */
export function onAgentConnected(id: string): void {
  connectionId = id
  // Nothing registered yet (the ordinary first page load, before any
  // declarative view mounts) needs no report: the server binds a fresh
  // connection with an empty set, so an empty snapshot says nothing. The
  // registry is add-only within a page lifetime, so it can never have SHRUNK
  // to empty and be owed a clearing report.
  if (reported.size > 0) void flush()
}

/** The agent stream went away. Stops reporting until the next `connected`
 *  frame; the server has already dropped the previous connection's set with
 *  the connection itself. */
export function onAgentDisconnected(): void {
  connectionId = null
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function scheduleFlush(): void {
  if (connectionId === null) return // nothing to correlate to yet.
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  const id = connectionId
  if (id === null) return
  try {
    await callAsync('POST /api/mcp/agent/capabilities', {
      connection_id: id,
      capabilities: capabilitySnapshot(),
    })
  } catch (error) {
    // A failed report costs the agent visibility of these capabilities until
    // the next mount or reconnect re-reports them; it must never break the
    // view that triggered it.
    console.warn('[actions] failed to report AI capabilities', error)
  }
}

/** Test-only reset of the module-level registry + connection. */
export function __resetCapabilityReportForTests(): void {
  reported.clear()
  connectionId = null
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
