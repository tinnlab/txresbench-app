// `createWorkbenchApi` (ITEM-9) — construct a per-extension, capability-scoped
// `WorkbenchAPI` from the injected host bundle. The CytoAnalyst shell calls this
// once per activated extension (bound to the current project). Kept host-injected
// so the package stays acyclic + the built-ins compile + run against a desktop
// stub before P6/P8 land.
//
// ITEM-6 — the broker is created ONCE PER HOST BUNDLE (a `WeakMap` keyed on the
// host object) and stocked from `core/capabilities`' provider registry. Two
// extensions activated against the SAME host therefore see the SAME published
// surfaces, while a different project (a different host) gets its own bound set —
// so a project switch can never resolve the previous project's implementation.
// Core names no capability at any point: it publishes whatever is registered.

import type { WorkbenchHost } from './host.ts'
import type { WorkbenchAPI } from './WorkbenchAPI.ts'
import type { CapabilityBroker } from '../capabilities/types.ts'
import { createCapabilityBroker } from '../capabilities/broker.ts'
import { installRegisteredCapabilities } from '../capabilities/providers.ts'
import { WORKBENCH_API_VERSION } from '../version.ts'
import { workbenchRegistry } from '../contributions/workbenchRegistry.ts'
import { createStorageApi, createEventsApi } from './host-facades.ts'

const BROKERS = new WeakMap<WorkbenchHost, CapabilityBroker>()

/** The broker bound to `host`, created + stocked on first use. */
export function capabilitiesFor(host: WorkbenchHost): CapabilityBroker {
  const existing = BROKERS.get(host)
  if (existing) return existing
  const broker = createCapabilityBroker()
  BROKERS.set(host, broker)
  installRegisteredCapabilities(broker, host)
  return broker
}

export function createWorkbenchApi(host: WorkbenchHost, extensionId: string): WorkbenchAPI {
  return {
    version: WORKBENCH_API_VERSION,
    extensionId,
    registry: workbenchRegistry,
    capabilities: capabilitiesFor(host),
    ui: host.ui, // passed through directly — no per-extension scoping to add
    storage: createStorageApi(host.storage, extensionId),
    events: createEventsApi(host.events),
  }
}
