// Re-emit LOCALLY the realtime frame the server deliberately withheld from this tab.
//
// ── The hole this closes ─────────────────────────────────────────────────────────────
//
// Every mutating request carries `X-Sync-Connection-Id` (stamped at the api-client
// chokepoint), and the server uses it to skip echoing the resulting `sync:` frame back to
// the connection that caused it — self-echo suppression, so the acting tab does not
// redundantly refetch what it just wrote.
//
// That reasoning holds for the STORE that performed the mutation: it already refetches
// inline. It does NOT hold for every OTHER consumer in the same tab. A change made in one
// surface is broadcast to every other device and to every other tab of the same user, and
// is invisible only to the tab that made it — the one place the user is actually looking.
// That is how attaching a dataset from the workbench's own datasets pane left the
// `artifact_ref` pickers beside it stale while a second tab updated correctly.
//
// ── Why this is the SAME channel, not a second one ───────────────────────────────────
//
// The fix re-emits the exact frame the server suppressed, on the exact `sync:<entity>`
// key space the SyncClient re-emits remote frames on. So there is ONE channel and ONE
// subscription per consumer, and a subscriber cannot tell a local echo from a remote
// frame — which is the point: correctness must not depend on where the mutation happened.
// A parallel `*.changed` event space for facts the sync channel already carries is the
// drift this avoids.
//
// ── What it is NOT ───────────────────────────────────────────────────────────────────
//
// It is a LATENCY path, not the correctness path. A mutation that forgets to echo is
// still delivered to every other device/tab, and is recovered in this tab on the next
// `sync:reconnect`; the acting tab is simply a round trip behind until then. Consumers
// therefore derive their state from the sync channel and never from a call site.
//
// Notify-and-refetch is preserved verbatim: the payload is `{action, id}` — never row
// data — and the subscriber refetches through its own permission-checked endpoint.
//
// ── THE ECHO IS THE ACTOR'S OWN REFRESH PATH TOO — deliberately ──────────────────────
//
// A mutating store must NOT keep a private inline `load()` alongside the echo. Two
// reasons, and the second is the one that makes this mechanism scale:
//
//  1. NO DOUBLE-FETCH. The acting store subscribes to `sync:<entity>` like everyone
//     else, so an inline reload plus an echo is two GETs for one mutation, per store.
//     One emit, one refetch per interested store, is the whole contract.
//
//  2. IT IS SELF-POLICING. When the actor's own surface refreshes only via the echo, a
//     FORGOTTEN echo breaks the thing the author is looking at while they write the
//     code — loudly, in the first manual click. Keep the private reload and a forgotten
//     echo is invisible to the author and breaks only some OTHER surface, later, for
//     someone else. That asymmetry is exactly how the sidebar bug shipped: the acting
//     store reloaded itself, so `/projects` looked correct and nothing pointed at the
//     rail beside it. A convention nobody can forget beats a convention everyone must
//     remember, and this is the cheapest available version of that.
//
// NO LOOP is possible: the echo only calls `EventBus.emit`. Nothing in the SyncClient or
// the api-client re-broadcasts an EventBus event back to the server, and the emit is a
// one-shot fan-out to subscribers — it is not re-delivered to itself. The WIRE is
// untouched: the server still stamps `origin`, so every OTHER device keeps its single
// refetch and self-echo suppression keeps the property it was designed for.
//
// WHAT TO ECHO: exactly the frames the handler publishes to the ACTING user's audience
// with `origin` applied — i.e. the ones the fan-out withheld. Frames the server sends
// with `origin: None` (including everything in `project/admin_handlers.rs`) already
// arrive, and echoing those WOULD double-fetch. Read the handler; don't guess.

import { EventBus } from '@ziee/framework/stores'
import type { SyncAction, SyncEntity } from '@/api-client/types'

/** One suppressed realtime frame, in the wire's own `{entity, action, id}` shape. */
export interface LocalSyncFrame {
  entity: SyncEntity
  action: SyncAction
  id: string
}

/**
 * Emit `sync:<entity>` locally with the same `{action, id}` payload a remote frame would
 * carry. Call it right after a successful mutation whose sync echo the server suppressed
 * for this connection, so sibling surfaces in THIS tab react exactly as other devices do.
 */
export function echoLocalSync(entity: SyncEntity, action: SyncAction, id: string): Promise<void> {
  return EventBus.emit({ type: `sync:${entity}`, data: { action, id } })
}

/**
 * Echo SEVERAL suppressed frames — one mutation can publish more than one entity to the
 * acting user (accepting a transfer publishes both `project`/create and
 * `project_transfer`/update to them, both suppressed). Emitted in order, all awaited, so
 * a caller that awaits this has handed every frame to the bus.
 */
export async function echoLocalSyncFrames(frames: readonly LocalSyncFrame[]): Promise<void> {
  for (const f of frames) await echoLocalSync(f.entity, f.action, f.id)
}
