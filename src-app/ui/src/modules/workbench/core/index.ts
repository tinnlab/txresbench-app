// @/modules/workbench/core — the single public extension surface (P5). The only
// package an extension imports. Built ON the txresbench SDK (`@txresbench/*`); re-exports P2
// datatype TYPES (never their runtimes) so the package graph is an acyclic leaf.
// See PLATFORM_ARCHITECTURE.md §2 + the P5 FINAL plan.
//
// DEC-L (ITEM-34) removed the `core/conformance/` subtree from this barrel with the
// subtree itself: it was declared as "the `plotTypes` contribution point's backing
// store", and `plotTypes` is gone. The REAL plot-type registry is `@txresbench/viz`'s
// `registerChartType`/`installBuiltins()`, which lives with the canvas that owns it.

// --- version / compatibility gate (ITEM-2) ---
export { WORKBENCH_API_VERSION, isApiVersionCompatible } from './version.ts'

// --- contribution registries + descriptors (ITEM-3/4/5/6/8) ---
export * from './contributions/index.ts'

// --- the runtime API surface + host injection (ITEM-8..13) ---
export type { WorkbenchAPI } from './api/WorkbenchAPI.ts'
export { createWorkbenchApi, capabilitiesFor } from './api/createWorkbenchApi.ts'
export type {
  WorkbenchHost,
  EventBusLike,
  KeyValueBackend,
  UiHost,
  Disposable,
} from './api/host.ts'
export type { KeyValue, EventsApi } from './api/host-facades.ts'

// --- the capability BROKER (ITEM-6) — id-routed publish/resolve. INV-6: core names
//     no capability; each CONTRACT is exported by the extension that PUBLISHES it
//     (`extensions/data`, `extensions/jobs`, …), the `extension.exports` pattern.
export * from './capabilities/index.ts'

// --- the artifact-CATALOG row + the narrow catalog PORT (ITEM-7/ITEM-8) ---
// Core's own engine names both — `core/runtime/axisSource.ts` resolves an `artifact_ref`
// widget's candidates out of the rows, `core/render/DeclarativeRegion` publishes them on
// the render scope, and `core/render/useArtifactCatalog` reads them through the port — so
// core DECLARES them (`core/artifacts/catalog.ts`) and the publishing extension re-exports
// the row. The arrow between the layers runs core ← extensions, never back.
//
// Only these two are public: the render-scope CHANNEL beside them (`CATALOG_SCOPE_KEY` /
// `CatalogScope` / `readCatalogScope`) has no consumer outside core, and exporting it here
// would add public surface nothing asks for.
export type { ArtifactRow, ArtifactCatalogSource } from './artifacts/catalog.ts'

// --- the narrow value-PREVIEW port (a short excerpt of a chosen column's values) ---
// The same shape as the catalog port above, for the same reason: core resolves the `data`
// capability by ID and calls exactly this one method through it, so the slice it uses is
// what it declares (INV-6). A SECOND port rather than a widening of the first, because the
// two are separately absent — a host may publish a catalog and no data plane, and the
// control must then render exactly as it did before rather than fail to resolve.
//
// As above, only the types are public. The render-scope channel beside them
// (`VALUE_PREVIEW_SCOPE_KEY` / `readValuePreviewScope`) and the two pure row readers
// (`declaredValuePreview` / `declaredDistinctCount`) have no consumer outside core.
export type {
  ArtifactValuePreviewSource,
  ValuePreview,
  ValuePreviewRequest,
} from './artifacts/valuePreview.ts'

// --- the datatypes contribution point + WhenClause engine (ITEM-7) ---
export * from './datatypes/index.ts'

// --- the CRITERIA vocabulary (ITEM-4) — the coercion + spelling rules of the app's
//     ONE filter encoding (`{column,control,min,max,keep}[]`), which the compute
//     kernel and the live keep-mask both read. NOT a query language; no AST.
export * from './criteria/index.ts'

// --- the per-position value-reference vocabulary + the column-reading substrate ---
// ITEM-4 deleted the criteria→predicate LIFT (`criteriaPredicate.ts`) and the
// methods-text renderer: they were a SECOND encoding of a filter whose real encoding
// is `criteria`, and the two could describe different index sets.
// ITEM-9 deleted the workbench SELECTION feature (the runtime, its facade, the
// inspector, the lasso bridge) but KEPT the predicate DSL, because it was still the
// evaluation substrate of the four general dimension primitives.
// ITEM-39 deleted those primitives (no shipping spec instantiated any of their widget
// kinds), which removed the last consumer of the LANGUAGE — the AST, the evaluator, the
// validator, the reductions, the geometry hit-tests, the operator registry, the index-set
// bitmask, the predicate classifier and the multi-group `summarize` are all gone.
// What survives is NOT a query language: naming a per-position column (`ValueRef` /
// `refKey`) and reading it densely (`DataCtx` / `resolveColumn`), which the data-driven
// param defaults (`form/defaults.ts`) and the resident client ctx (`host/createHost.ts`)
// use. It therefore lives in `core/columns/`, not in a directory named for the deleted
// language — and the domain-guard exemption those trees needed is GONE with them.
export * from './columns/index.ts'

// --- column CLASSIFICATION shared across the layer boundary ---
// `isIdentifierColumn` decides that an all-distinct column names its rows rather than
// grouping them. Both sides of the boundary need the SAME answer — the criteria builder
// (core) must not offer it as a keep-set, and the canvas source (an extension) must not
// advertise it as categorical for a chart's `group` channel to bind. Exported here rather
// than deep-imported, so the two cannot drift into two rules.
export { isIdentifierColumn } from './runtime/primitives.ts'

// The ONE column coercer (ITEM-25). Published here for the same reason `isIdentifierColumn` is:
// it is a seam BOTH core and the canvas extension read a columnar value through, and three copies
// of it had already drifted apart semantically before it was consolidated. A barrel export is what
// stops the next consumer deep-importing it and a fourth copy appearing.
export {
  asNumsNaNMissing,
  asNumsZeroMissing,
  asStrs,
  isColumn,
  type ColumnLike,
} from './columns/columnCoerce'

// --- per-analysis RUN selection, shared across the layer boundary ---
// Both the run list (core) and a run's next-step guidance (an extension) must resolve "which
// analysis produced this job" the same way; two readings would let them disagree about one row.
export {
  resolveJobAnalysisId,
  runsOfAnalysis,
  isRunning,
  ANALYSIS_RUNS_LIMIT,
} from './runtime/analysisRuns.ts'

// --- how a binding was CHOSEN, shared across the layer boundary ---
// The four sites that bind (the declared `artifact_ref` widget and the pane anchor, both in
// core; the launch-time resolver and the run panel's mount-effect auto-pick, one in core and
// one in an extension) plus the wire that carries the answer must all spell it the same way.
// Exported here rather than deep-imported so a vocabulary observable only through one
// module's behaviour cannot be re-derived slightly differently by the next caller.
// See `docs/design/binding-origin.md`.
export {
  BINDING_ORIGIN_COPY,
  ORIGIN_AUTO,
  ORIGIN_USER,
  strongerOrigin,
  type BindingOrigin,
} from './runtime/bindingOrigin.ts'

// --- the params/artifact-ref/widget schema TYPES (ITEM-16/17) ---
export * from './form/index.ts'

// --- the declarative `view_spec` VOCABULARY (ITEM-3) — co-located with its
//     validator in `core/spec/`, no longer inside `core/manifest/`.
export { WIDGET_KINDS, EFFECT_OPS } from './spec/vocabulary.ts'
export type { WidgetKind, EffectOp } from './spec/vocabulary.ts'
export { namespaceActionId, describeActionId, ID_SEP } from './spec/ids.ts'

// --- the declarative-CANVAS host SEAM (DOMAIN_AUDIT §4 "Structural") ---
// Core declares the interface + registry; the canvas EXTENSION registers the
// implementation, so `core/render/DeclarativeRegion` no longer imports canvas code.
export {
  registerDeclarativeCanvasHost,
  getDeclarativeCanvasHost,
  __resetDeclarativeCanvasHostForTests,
} from './render/canvasHost.ts'
export type { DeclarativeCanvasHost, DeclarativeCanvasPublish } from './render/canvasHost.ts'


// --- one PANE's content state (ITEM-19), for the pane renderers extensions contribute ---
// A region renders only its ACTIVE tab, so every `useState` inside a pane body is destroyed the
// moment the user looks at a sibling tab. `usePaneStateValue` is `useState`'s shape keyed by PANE
// ID instead of by React lifetime — the id is stable across a move / pop-out / return, and the
// entry ends when the pane is CLOSED.
//
// It is on the barrel because the panes that need it are CONTRIBUTED (launcher / re-run /
// provenance), so this is part of the contract between the shell that hosts a pane and the
// extension that fills it — not a shell internal. Reaching past the barrel to `shell/dock` for it
// is what `lint-layer-boundary`'s shrink-only ratchet exists to stop; the three edges already in
// that baseline are the debt this export means no one has to add to.
export { usePaneStateValue } from './shell/dock/paneState.ts'
// The other half of that contract: a pane's CLOSE. `usePaneStateValue` covers the state
// that ends with the pane; `onPaneClosed` covers a live RESOURCE that does — the run
// lifecycle's progress stream (`extensions/analysis/runSession.ts`) deliberately outlives
// an unmount, because unmount means "the user looked at a sibling tab", and close is the
// event that genuinely ends it. Same reason as above for it being on the barrel: the
// panes that own such a resource are contributed.
export { onPaneClosed } from './shell/dock/paneState.ts'

// --- the manifest schema + FE validator (ITEM-14/15) ---
export * from './manifest/index.ts'

// --- the per-contribution MCP metadata projection (A4 / ITEM-18) ---
export * from './mcp/metadata.ts'

// --- built-in discovery ordering (the pure half of ITEM-21) ---
export * from './loader/index.ts'

// --- the per-plot SURFACE-HOST seam (the shell half of the canvas's dock contract) ---
// The shell owns pane hosting, so the shell mints the containers the centre canvas's grid
// portals its per-plot "Edit plot" / "View table" surfaces into, one per open surface; the
// canvas EXTENSION hands those resolvers to `<GridWorkspace>`. Exported here rather than
// deep-imported for the same reason `isIdentifierColumn` is — it is the one seam both
// layers must read the same way.
export { workbenchPlotSurfaceContainers } from './shell/regions/paneSurfaceHost.ts'
// …and the CLOSE half of the same seam: viz hands the shell a closer for the surfaces it portals,
// so the pane's own close can close the SURFACE instead of stranding it (`paneSurfaceHost.ts`).
export {
  installHostedSurfaceCloser,
  closeHostedSurface,
  type HostedSurfaceCloser,
  type HostedSurfaceCloseResult,
} from './shell/regions/paneSurfaceHost.ts'

