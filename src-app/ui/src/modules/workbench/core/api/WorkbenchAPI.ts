// The `WorkbenchAPI` runtime interface (ITEM-8) — the ONLY object an extension
// touches (§2). Constructed PER-EXTENSION, capability-scoped by the project role
// (P10) + the inner `gate:` permission.
//
// ITEM-7 shrank this to its final shape. `commands`/`selection` went with their
// features; `data`/`compute` were core-owned FACADES over capabilities core has no
// business owning, and are now published by `extensions/data` / `extensions/jobs`
// and reached through `capabilities`. What is left is exactly:
//
//   · `version` / `extensionId` — identity + the compatibility gate
//   · `registry`     — the shared contribution registry (register or read)
//   · `capabilities` — the id-routed broker: every DOMAIN surface arrives here
//   · `ui` / `storage` / `events` — HOST services, not domain capabilities. They are
//     provided by the shell itself for every extension (toasts, a namespaced KV, the
//     bus), so they stay ON the handle rather than being brokered.

import type { Contributions } from '../contributions/workbenchRegistry.ts'
import type { CapabilityBroker } from '../capabilities/types.ts'
import type { EventsApi, KeyValue } from './host-facades.ts'
import type { UiHost } from './host.ts'

export interface WorkbenchAPI {
  /** the host API version (extensions declare a compatible range). */
  version: string
  /** the extension this API instance is scoped to. */
  extensionId: string
  /** the shared contribution registry (register or read). */
  registry: Contributions
  /** the capability broker — resolve a published surface BY ID. */
  capabilities: CapabilityBroker
  ui: UiHost
  storage: KeyValue
  events: EventsApi
}
