// `core/capabilities` — the id-routed capability broker (ITEM-6). See `types.ts`
// for INV-6: nothing here names or types a specific capability.

export type {
  AbsentReason,
  CapabilityBroker,
  CapabilityFactory,
  CapabilityLookup,
  CapabilityProvider,
} from './types.ts'
export { createCapabilityBroker, resolveOrThrow } from './broker.ts'
export {
  registerCapabilityProvider,
  installRegisteredCapabilities,
  registeredCapabilityIds,
  __resetCapabilityProvidersForTests,
} from './providers.ts'
