# P5 — contribution-api · convergence diff (r1 vs r2)

## Substantively new in r2 (not in r1)
- **Selection API + cell-set predicate DSL + in-process evaluator OWNED in P5 (ITEM-6).** r2 builds the bounded
  typed DSL + evaluator→bitmask inside `@cyto/workbench-api`. r1 explicitly assigns the selection/cell-set DSL to
  **P8** (ITEM-5 is a re-export *seam*; ITEM-10 `cell-set-selector` "depends on P8"). Direct ownership conflict.
- **Open datatype registry + subtype lattice OWNED in P5 (ITEM-4).** r2 builds `Datatype{extends,…}` +
  `isSubtypeOf` + the availability/type-match engine in the package. r1 assigns `DataKind`/`ResultKind` + the
  lattice to **P2** and only imports `isSubtype` with a local string-union fallback. Ownership conflict.
- **Registry → MCP projection (ITEM-14)** — a pure generator walking the registry to emit MCP tools/resources +
  `safety`→approval mapping + `isAiExposed`/denylist gate, mirroring `control_mcp/{catalog,policy}.rs`. r1 has no
  MCP-projection item (it lists P9 ai-mcp only as a downstream *consumer*).
- **Conformance battery ownership + live3 view-kind refactor (ITEM-15)** — moves live3's
  `viz-core/conformance` into the package as the `plotTypes` acceptance gate AND refactors live3's closed
  `switch(cell.kind)`+`CellKind`+`CELL_KIND_OPTIONS`+`KIND` drift-triple into an open `registerViewKind` registry
  the center-canvas dispatches through. r1 keeps plotTypes as "P5 = interface, P7 = impl" with no battery move
  and no live3 refactor.
- **Namespace decision `@cyto/workbench-api`** (app-specific, promotion path to `@ziee/*` later). r1 decides the
  opposite: `@ziee/workbench-api`. A conflicting up-front decision.
- **`data` API as a dumb Range/byte server + client-side decode (zarrita/DuckDB-WASM) contract (ITEM-5).** r2
  pins the host-is-a-range-server / decode-in-extension split. r1's `data.*` is a typed accessor surface without
  the range-server-vs-client-decode boundary.

## Substantively new in r1 (not in r2)
- **Jobs-provisioner grounding correction as a first-class risk (ITEM-17 + risk).** r1 documents that the `jobs`
  module is FCFS-enqueue-once with free-text `job_type`, no cron/`schedule_at`/`next_run`, no job-type registry,
  single injected `JobRunner` → the `jobs:` provisioner is **net-new periodic-scheduling infra**, not a wrapper.
  r2's ITEM-11 treats jobs as "cron → the kernel scheduler … reuse existing machinery" — under-scoping the exact
  gap r1 flags.
- **Compile-time-vs-runtime permission-gating decision (ITEM-15 decision + risk).** r1 works out that manifest
  `gate:` strings can't mint typed FE `Permissions.X` via the OpenAPI→TS emitter (which relies on
  `with_permission::<(P,)>`), so generic ext routes need a runtime permission resolver + registered descriptors,
  and flags the emitter interaction. r2 mentions a permission `gate` on collections but not this consequential
  compile-time/runtime surface split.
- **`Slots` declaration-merge vs registry unification decision.** r1 explicitly reconciles the two coexisting FE
  contribution mechanisms (framework `Slots` map vs bespoke name-keyed registries) and draws the boundary. r2
  picks parallel-Maps but doesn't address the framework-`Slots` coexistence.
- **`WhenClause` owned + evaluator in P5 as an explicit seam (ITEM-5).** r1 isolates `WhenClause`/`evaluate` as
  P5-owned while deferring the kind lattice to P2; r2 folds when-gating into render-time host filtering.

## Shared substance
Both extract a versioned `sdk/packages/workbench-api` package exporting `WORKBENCH_API_VERSION` + a semver
apiVersion gate, generalize the interface-round `analysisRegistry`/`AnalysisPlugin` into a reusable id-keyed,
HMR-idempotent registry substrate holding the same eight contribution points
(analyses/plotTypes/fieldProviders/resultRenderers/views/commands/selectionActions/collections), promote
`AnalysisContribution` to a `params: JsonSchema` + `defaults` + typed `accepts`/`produces` + `run: RunSpec` +
`methodsText` + `ai`/`safety` shape, publish an `extension.yaml` manifest as a JSON-schema with a load-time
validator that indexes contributions WITHOUT executing code, render params via an RJSF-style JSON-schema→
`@ziee/kit` form reusing `shared.tsx`, with Tier-2 auto-populated type-filtered artifact-ref pickers, Tier-3
host widgets, and a Tier-4 code-form escape, discover built-ins via build-time `import.meta.glob` (+ staged
compute assets), and add a backend `server/src/modules/extensions/` host module running declarative
settings/result-kind/collections/jobs provisioners with ZERO per-extension Rust — via a generic JSONB runtime
store (`ext_settings`/`ext_records`) reached through **runtime `sqlx::query` (never `query!` macros)** because the
table is runtime-provisioned, plus the closed-`SyncEntity`-enum constraint forcing ONE generic ext sync variant,
a bounded no-raw-SQL query DSL, migration-glob table shipping, study-lifecycle cascade teardown, and a final
dogfood proof rebuilding the built-in analyses on the public API. Both gate impls on P1/P2/P3 while landing the
pure type/registry surface first.

## Verdict
VERDICT: DIVERGED — needs r3
