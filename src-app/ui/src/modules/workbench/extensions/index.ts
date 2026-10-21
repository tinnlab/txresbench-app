// `@/modules/workbench/extensions` — the BUILTIN-EXTENSION registration barrel.
//
// `core/` is the transport; every capability is an extension. A builtin registers
// through the SAME public seams a third-party package would — mirroring
// `core/shell/builtinViews.ts`, which registers the canvas shell surface as an ordinary
// `ViewContribution` carrying an `extensionId`.
//
// Two kinds of registration land here:
//   1. WIDGET KINDS — `extensions/widgets` (the core FORM-CONTROL renderers) and
//      `extensions/canvas` (the plot kinds it owns, ITEM-36 / DEC-A).
//   2. CAPABILITIES — a `{id, version, create}` declaration per builtin, registered at
//      module evaluation into `core/capabilities`' provider registry. `createWorkbenchApi`
//      instantiates whatever is registered against the host bundle, so core stocks a
//      broker WITHOUT importing — or naming — any capability (INV-6).
//
// The builtin extensions today:
//   · `extensions/data`       publishes `data` (catalog, artifact query, column/Arrow/opaque reads)
//   · `extensions/jobs`       publishes `jobs` (run-with-params + the run's progress stream),
//                             and owns the run/artifact panes that answer "what did this RUN produce"
//   · `extensions/provenance` — a READ-ONLY view over the server's provenance API (no write path)
//   · `extensions/analysis`   — the launch/rerun/param surfaces, registered through `contributions`
//   · `extensions/canvas`     — the plot kinds + the canvas view + the declarative-canvas HOST
//   · `extensions/widgets`    — the form-control renderers
//   · `extensions/visualize`  — the Visualize pane's own vocabulary (`entry_list`, ITEM-23)
//
// This file deliberately imports only each extension's LIGHT provider module, never its
// pane/view barrel: `core/render` + `core/runtime` import this barrel for
// `installBuiltinWidgets`, and must not drag React panes in behind it.

import { registerCapabilityProvider, registerDeclarativeCanvasHost } from '@/modules/workbench/core'
import { canvasHost } from './canvas/canvasHostProvider'
import { DATA_CAPABILITY_ID, DATA_CAPABILITY_VERSION } from './data/contract'
import { createDataCapability } from './data/provider'
import { JOBS_CAPABILITY_ID, JOBS_CAPABILITY_VERSION } from './jobs/contract'
import { createJobsCapability } from './jobs/provider'
import { installWidgets, __resetInstallWidgetsForTests } from './widgets/installWidgets'
import { installCanvasWidgets, __resetCanvasWidgetsForTests } from './canvas/installCanvasWidgets'
import { installVisualizeWidgets, __resetVisualizeWidgetsForTests } from './visualize/installVisualizeWidgets'

export { installWidgets, widgetsInstalledComplete, __resetInstallWidgetsForTests } from './widgets/installWidgets'
export {
  installCanvasWidgets,
  CANVAS_WIDGET_KINDS,
  __resetCanvasWidgetsForTests,
} from './canvas/installCanvasWidgets'
export {
  installVisualizeWidgets,
  VISUALIZE_WIDGET_KINDS,
  __resetVisualizeWidgetsForTests,
} from './visualize/installVisualizeWidgets'

// --- the published capability CONTRACTS (types + ids + pure binds; no React) ---
export * from './data/contract'
export * from './jobs/contract'
export { createDataHost, makeFakeDataHost } from './data/dataHost'
export { createJobsHost, makeFakeJobsHost } from './jobs/jobsHost'

// --- capability registration (module-evaluation side effect, idempotent per id) ---
registerCapabilityProvider(DATA_CAPABILITY_ID, DATA_CAPABILITY_VERSION, createDataCapability)
registerCapabilityProvider(JOBS_CAPABILITY_ID, JOBS_CAPABILITY_VERSION, createJobsCapability)

// --- canvas HOST registration (DOMAIN_AUDIT §4 "Structural") ---
// `core/render/DeclarativeRegion` used to import `resolveDeclarativeCanvas` /
// `declarativeCanvas` / `buildCanvasDataSource` as VALUES straight out of `extensions/canvas`
// — the one live runtime core→extensions edge, and the channel canvas assumptions travelled
// into core through (the `keptMask` name, the `obs` positions key, the `layouts` channel).
// Core now declares an interface and this barrel supplies the implementation, exactly like a
// capability provider.
registerDeclarativeCanvasHost(canvasHost)

/** Install every builtin extension's widget renderers (idempotent). This is the ONE
 *  call a mount path makes; it is the behavioural equivalent of the pre-ITEM-36
 *  `installWidgets()`, which registered the form controls AND the plot kinds together. */
export function installBuiltinWidgets(): void {
  installWidgets()
  installCanvasWidgets()
  installVisualizeWidgets()
}

/** Test-only reset of every builtin extension's install latch (and, via
 *  `installWidgets`', the shared widget registry). */
export function __resetBuiltinWidgetsForTests(): void {
  __resetInstallWidgetsForTests()
  __resetCanvasWidgetsForTests()
  __resetVisualizeWidgetsForTests()
}
