// `extensions/data` — the builtin extension that PUBLISHES the `data` capability
// (catalog, artifact query, column / Arrow / opaque reads).
//
// It owns its own contract (`./contract.ts`); core routes to it by id alone (INV-6).
// The backing plane is the shell-injected `WorkbenchHost.planes['data']` when present
// (the gallery/e2e fake), otherwise the real ApiClient plane.

export * from './contract.ts'
export { createDataApi } from './dataCapability.ts'
export { createDataHost, makeFakeDataHost } from './dataHost.ts'
export { createDataCapability } from './provider.ts'
export { WorkbenchDataSource, type DataPlaneArtifact } from './workbenchDataSource.ts'
// ITEM-42: the ONE `(pull, streaming)` pair per project data plane. It lives here — not in the
// canvas extension, where it used to — because the `data` capability's columnar read is now a
// second consumer of the same source, and a memo owned by one consumer would have handed the
// other its own instance (two multicasts, two decodes).
export {
  buildProjectDataSource,
  buildProjectSources,
  __resetProjectSourcesForTests,
  type CapabilityHandle,
  type ProjectSources,
} from './projectSources.ts'
// The STREAMING view of the same plane (ITEM-8). Published here for the same reason the pull
// source is: the canvas extension consumes it, and INV-3/INV-8 say one public entry per layer —
// an extension may not reach into another extension's internals.
export {
  WorkbenchStreamingSource,
  type WorkbenchStreamingDeps,
  // ITEM-19: the coverage indicator (in the CANVAS extension) observes byte arrival on this
  // source, so its progress shape is published here for the same INV-3/INV-8 reason.
  type StreamProgress,
} from './workbenchStreamingSource.ts'
