# P5 — contribution-api (`@txresbench/workbench-api`) · FINAL (consolidated r1∪r2∪r3)

## Reconciliation applied
Cross-part audit resolutions baked into this plan: **A3** (SchemaForm / form-from-JSON-schema
renderer — **P6 owns the renderer**; P5 only DEFINES the JSON-schema *type* a contribution declares
and delegates rendering to P6's host panel — see ITEM-16), **A4** (registry→MCP tools/resources
generator — **P9 owns the generator**; P5 owns the contribution REGISTRY + per-contribution MCP
metadata the generator reads, and does NOT generate MCP tools itself — see ITEM-30), **A6**
(conformance battery — **P5 publishes the invariant TYPES / pure invariant predicates + the
`runConformance` host-gate signature** in `@txresbench/workbench-api`; P7 provides the concrete view-kind
test-suite that IMPORTS them, P7→P5 with no package cycle — see ITEM-31).

**P5 is the CONTRACT layer.** It sits *above* the impls (P1 data, P2 datatypes, P3 compute, P8
selection/DSL, P10 study) and is *consumed* by P6 (shell renders from registries), P7 (view-kinds),
P9 (MCP generated from registries), P11 (three modules built against it). P5 owns the *public surface
+ registries + manifest + provisioner contracts + loader + MCP projection*; it **facades** the
data/compute/datatype/selection runtimes rather than owning them. Deployment scope: **desktop +
single-box server only** — seams open, only the local arm implemented.

Grounded in verified code (worktree `/data/pbya/txresbench/tmp/analysis-workflow-wt`): interface-round
`src-app/ui/src/modules/analysis/{registry,types}.ts` (`analysisRegistry`, `AnalysisPlugin`,
`availability`/`byCategory`/`standardRecipe`) + `analyses/shared.tsx` form primitives on `@txresbench/kit`;
FE seam `study/core/extensions/*` + `modules/projects/core/extensions/registry.tsx`
(`ProjectExtensionRegistry`) + `ChatExtensionRegistry` (parallel typed Maps); BE seam
`study/core/extension/registry.rs` (`linkme` `#[distributed_slice] STUDY_EXTENSIONS` + trait +
`on_study_deleted` + shared `delete_study_with_extensions` chokepoint); `MODULE_ENTRIES`/`AppModule`;
`jobs/settings.rs` + `sandbox/settings.rs`/`SandboxSettings.store.ts` (settings vertical slice);
`sync/event.rs` (closed `SyncEntity` enum + `publish`); `import.meta.glob('./*/plugin.tsx')` discovery;
live3 `viz-core` (`switch(cell.kind)` in `grid/CellView.tsx`, `conformance/invariants.ts`);
`modules/control_mcp/{catalog,tools,policy}.rs`; `@txresbench/framework` (`createModule`, store-kit, EventBus);
`bio_mcp` sidecar/proxy. Confirmed NOT-yet-built upstream: no `analysis_results`/catalog/`writeResult`,
no datatype registry, no `@txresbench/workbench-api`, no `extensions/` dir, no manifest loader.

**Baked-in ownership resolutions (agreed across r3):**
1. **Datatype registry lives in P2 core, NOT P5.** P5's `@txresbench/workbench-api` re-exports/consumes the
   P2 `Datatype`/`TypeSelector` types as the `datatypes` contribution point; `Registry.availability`
   calls P2's subtype check. P5 does not implement the lattice.
2. **Cell-set predicate DSL lives in P8 interaction** (its schema + evaluators). P5 owns only the
   `CellSetPredicate` AST types + the DSL-operator-registry *contract* (part of the public package) and
   exposes it via the `selection`/`commands` API surface; P8 imports those types (P8→P5, never reverse)
   and implements the evaluator + brush/pick/selection runtime.

**`@txresbench/*` package namespace layout (explicit):** app #2's workbench is built ON the txresbench SDK, not part
of it. `@txresbench/workbench-api` = the single public import surface an extension touches (this package, P5).
Internal `@txresbench/*` runtimes it re-exports *types only* from: `@txresbench/datatypes` (=P2), `@txresbench/viz` (=P7),
`@txresbench/kit` (=txr design system). The txresbench SDK stays `@txresbench/*` (`@txresbench/framework`, `@txresbench/shell`,
`@txresbench/kit`), which `@txresbench/*` depends on. Package graph is **acyclic**: workbench-api is the leaf public
surface — it re-exports P2/P7 *types*, never their runtimes; P7 registers into `plotTypes`, P8 imports
the DSL AST, P6 renders from the registries.

---

## Items

- **ITEM-1 — Package scaffold + namespace + version gate + wiring.** New workspace member
  `sdk/packages/workbench-api/` (`@txresbench/workbench-api`; auto-covered by the root `workspaces:
  ["sdk/packages/*", …]` glob). `package.json` with `exports` subpaths (`.`, `./registry`, `./data`,
  `./selection`, `./compute`, `./manifest`, `./conformance`, `./mcp`), peerDeps (react, `@txresbench/framework`,
  `@txresbench/kit`), tsconfig, `src/index.ts` barrel. Export `WORKBENCH_API_VERSION = "1.0.0"` +
  `isApiVersionCompatible(range)` (semver gate an extension's declared `apiVersion` against the host —
  refuse on exclusion). Wire consumers: `src-app/ui/tsconfig.json` paths + vite alias (mirror
  `@txresbench/framework`), UI `package.json` dep + `.syncpackrc.json` entry. Enforce an **acyclic** package
  graph (dependency-cruiser/lint guard) per the namespace layout above.
- **ITEM-2 — Generic `Registry<T>` primitive.** Generalize `analysisRegistry` into a reusable
  `class Registry<C extends Contribution>`: `register` (idempotent-by-id, HMR-safe last-wins + `console.warn`,
  per `ProjectExtensionRegistry`), `get`, `all` (stable id-sorted), `byCategory`/`byArea`, `order` sort, and a
  pure `availability(c, availableTypes)` that **delegates type-matching to P2's subtyping lattice**. Gating
  (`when`/`permission`) is a **render-time** concern the host filters, never inside the registry.
- **ITEM-3 — The eight contribution registries + `Contributions` object.** Parallel typed singletons on the
  public surface (the `ChatExtensionRegistry` parallel-Maps model, package-export friendly, over the
  app-internal `Slots` declaration-merge seam): `analyses · plotTypes · fieldProviders · resultRenderers ·
  views · commands · selectionActions · collections`. Assemble the `Contributions` interface + a process-wide
  `workbenchRegistry` singleton; keep `standardRecipe()` on the analyses registry.
- **ITEM-4 — Cross-cutting `Contribution` base type.** `id` (namespaced), `extensionId`, `apiVersion`,
  `when?`, `requires?`/`accepts?` (typed subtyping-aware artifact-ref selectors), `order?`, `category?`,
  `title`, `icon?`, plus **LLM-facing declaration fields** (`description`, NL `when` hint, `examples`,
  `safety: read-run|mutating|destructive`, `ai?: boolean`) — the *same* strings power the human form help
  AND the MCP tool (§0.4.2); P9 consumes them, P5 only declares them.
- **ITEM-5 — `AnalysisContribution<P>`.** Generalize `AnalysisPlugin`: `category`, `accepts: TypeSelector[]` /
  `produces: ResultKind[]` (typed P2 datatype-id refs, replacing the closed `Kind` enum), `params: JsonSchema`,
  `defaults`, `run: RunSpec` (sandbox script | in-host builtin fn), `schedule?: {class, resources}` (class only,
  single pool now), `methodsText(p)`, `inStandardRecipe?`/`recipeOrder?`, `ai`/`safety`. The hand-coded
  `SimpleForm/AdvancedForm/ResultView/buildResult` React fields are **dropped** (host renders from `params`;
  ResultView → the `resultRenderers` registry).
- **ITEM-6 — The other seven contribution descriptor types.** `PlotType/ViewKindContribution` (thin delegate to
  P7's `registerViewKind`: `dataContract` + deck.gl `render` + `conformance`), `FieldProviderContribution`
  (left-rail color/select-by sources), `ResultRendererContribution` (result-kind → bottom panel),
  `ViewContribution` (`area: left|right|bottom|center`, `render: ViewSpec | {component} | {iframe}`, `when`),
  `CommandContribution` (`handler` + args + `safety`), `SelectionActionContribution` (`command` ref +
  `when:"has-selection"`), `CollectionContribution` (§5.5-C: `schema`/`scope`/`indexes`/`gate`).
- **ITEM-7 — `datatypes` contribution point (P2 re-export) + `WhenClause` evaluator.** Re-export P2's
  `Datatype`/`TypeSelector`/`isSubtype` *types* from the public surface so extensions declare `accepts`/`produces`
  against them (**P2 owns the registry impl + lattice + storage layouts + viewers**). P5 owns `WhenClause`
  (`has:<kind>` / `has-selection` / boolean combos) + its pure `evaluate(when, {producedKinds, hasSelection})`
  — the availability/type-match engine (generalized `analysisRegistry.availability` from `Set<Kind>` to a
  lattice match over the study's artifact catalog) that lights up analyses + drives artifact-ref pickers +
  fieldProviders + viewer dispatch. Local string-union fallback until P2 lands.
- **ITEM-8 — `WorkbenchAPI` runtime interface object (§2).** `version` + `registry: Contributions` + the API
  facades (ITEM-9..13), constructed **per-extension, capability-scoped** by study role (P10) + the inner
  `gate:` permission. The only object an extension touches. Types + a thin host-injected impl; P5 ships a
  desktop stub (`createWorkbenchApi.ts`) wired to whatever P1/P3/P8 register so built-ins compile + run.
- **ITEM-9 — `data` API facade.** `catalog()`, typed-array reads (`embedding`/`obs`/`geneColumn` sparse
  fast-path/`clustering`/`deTable(page)`), `artifacts.query({type})` for pickers, `writeAnnotation`,
  `writeResult(kind, artifact) → analysis_id`. **Delegates to P1/P2.** Contract: the host is a **dumb authed
  study-scoped byte-Range server** (+ Tier-2 chunked slicing); client-side decode (zarrita/DuckDB-WASM) is the
  extension's. Single-box = local-FS range server (same code path a future MinIO/worker uses).
- **ITEM-10 — `selection` API facade + `CellSetPredicate` AST/operator-registry contract.** `current()`,
  `onChange(cb)`, `useCurrent()` (React), `set(s)`, `setByPredicate(pred)`, `brush`/`pick`. `CellSet` bitmask
  over the canonical cell axis. **Ownership split:** P5 owns the **`CellSetPredicate` AST types + the
  DSL-operator-registry contract** (public — a declared contribution point extensions add operators to;
  `setByPredicate` takes this type; the AI reads the operator vocabulary as a resource). **P8 owns the
  evaluator + the selection/brush/pick runtime** behind this facade. Selection-as-recipe (store predicate +
  pinned input hash, never a materialized cell list) is P8's execution concern; P5 declares the AST it consumes.
- **ITEM-11 — `compute` API facade (§4.1).** `run(spec: RunSpec, inputs, params): Promise<JobHandle>` with
  streamed progress (SSE). **Delegates to P3** (`ComputeBackend`/`JobRunner`→bwrap; single pool + interactive/
  batch priority inferred from trigger). P5 defines `RunSpec`/`JobHandle`; P3 implements. Content-addressed-code
  + path-agnostic `inputs.json` contract kept (a run is a provenance node by construction) even with one backend.
- **ITEM-12 — `commands` + `ui` facades.** `commands.register(id,handler)`/`execute(id,…args)` (the registry
  doubles as the palette AND the MCP tool list, ITEM-30); `ui.notify`/`openView`/`progress<T>` (delegates to
  P6 shell services).
- **ITEM-13 — `storage` + `events` facades.** Per-extension `storage: KeyValue` namespaced by
  `extension_id`+scope-key (one extension can't read another's KV); `events: EventBus` bridged to the framework
  EventBus (`on`/`watch` auto-cleanup) + `sync:<entity>` refetch — thin wrappers over `@txresbench/framework`
  store-kit/events.
- **ITEM-14 — Manifest schema (§3).** The `extension.yaml` JSON-schema: `id`, `name`, `publisher`, `version`,
  `apiVersion` (semver range), `activation[]` (lazy events), `contributes: {analyses, plotTypes, views,
  selectionActions, fieldProviders, resultRenderers, commands, collections, settings, jobs, resultKinds,
  sidecar}`. **The schema is itself a versioned published contract.** TS `ExtensionManifest` type shared with
  the loader.
- **ITEM-15 — Manifest parser/validator (FE + BE).** FE `manifest/validate.ts`: parse YAML/JSON → JSON-schema
  validate (ajv) → **semver `apiVersion` gate vs `WORKBENCH_API_VERSION` (refuse incompatible, §6)** → **index
  contributions WITHOUT executing extension code** (contributions appear gated-by-`when`/`requires` from the
  manifest alone; bind lazy code refs — `component`/`ParamsForm`/`run` — as thunks activated on `activation`
  events). BE Rust mirror `server/src/modules/extensions/manifest.rs` (serde structs + `apiVersion` gate) for
  the provisioners.
- **ITEM-16 — Tier-1 JSON-schema *type* + params-schema contract (renderer is P6's — A3).**
  **Reconciliation A3: P6 OWNS the `SchemaForm` / form-from-JSON-schema renderer** (it's a shell/host panel).
  P5 does NOT build the renderer; P5 only DEFINES the JSON-schema *type* a contribution declares (the `params` /
  settings schema on `AnalysisContribution` etc., ITEM-5), the artifact-ref field *type* (§Tier-2, ITEM-17) and
  the host-widget slot *type* (§Tier-3, ITEM-18) as part of the versioned public surface, and delegates
  rendering to P6's host panel (P6 ITEM-8). The schema vocabulary P5 fixes (number w/ min/max/step, enum,
  boolean, string, array; conditional `when`/`if-then`; templated defaults `name:"Cluster {embedding}"`;
  `repeat-per`) must cover the observed ~90% (71 Select · 23 InputNumber · 12 Input · 8 Switch) so P6's renderer
  can map it onto `@txresbench/kit` controls (reusing `analyses/shared.tsx`). **One `params` declaration serves the
  human form AND the MCP tool input schema.** (P5 may ship a thin desktop-stub renderer only if needed to compile
  built-ins before P6 lands; the real renderer is P6's — do not double-build it.)
- **ITEM-17 — Tier-2 artifact-ref pickers.** `form/fields/ArtifactRefField.tsx`: a `type:artifact-ref,
  accepts:<kind>, multiple?, required?` field → a `SelectField` **populated from `api.data.catalog()` filtered
  by compatible datatype** (subtype match via P2). One `accepts` declaration does both jobs — gates availability
  AND generates the picker. Depends on P1 catalog + P2 subtyping.
- **ITEM-18 — Tier-3 host rich-widget registry.** `form/widgets/registry.ts` + a `widget:<id>` field resolving to
  a host-provided component. Ship `gene-selector`, `gene-set-picker`, `colormap-picker`,
  `threshold-on-histogram` (data-API-wired). **`cell-set-selector`** (DE group1/group2 builder + live count
  preview) is registered here but depends on P8's evaluator — stub + wire when P8 lands.
- **ITEM-19 — Tier-4 code-form escape hatch.** Type + loader for an extension-shipped `ParamsForm` React
  component built against `@txresbench/workbench-api` (`api.data.query`, `api.selection`, study context). First-party
  in-tree now; untrusted-iframe path DEFERRED (§6).
- **ITEM-20 — FE built-in extension discovery (build-time glob).** `ui/src/core/workbench/discover.ts`:
  `import.meta.glob('/extensions/*/extension.{yaml,ts}')` (+ `ui/*`) — the exact `analyses/index.ts` +
  `study/extensions/index.ts` pattern, topo-sorted by declared `dependencies` (the loader's cycle-detecting
  DFS). Side-effect-imports each built-in's registration; feeds ITEM-15. New top-level `extensions/` dir (§8.5;
  built-ins `data-io/embedding/clustering` land in P11). Note: glob needs a **relative literal**, not `@/`.
- **ITEM-21 — BE built-in compute-asset staging (build-time, Rust).** `server/build_helper/extensions.rs`
  (+ `build.rs` hook): scan `extensions/*/extension.yaml`, stage `compute/*` + schema assets + an aggregated
  manifest index for `include_dir!`/extract-on-first-use, mirroring hub-seed/pgvector. **Fail-soft** to
  zero-extension (like pgvector) so a fresh worktree missing staged assets can't panic.
- **ITEM-22 — `extensions` compiled BE host kernel module.** `server/src/modules/extensions/{mod,manifest,
  registry,provisioners,store,routes,permissions}.rs` — one generic `AppModule` in `MODULE_ENTRIES` (§8.5 "one
  generic module, byte-identical regardless of extension count"), mirroring the `STUDY_EXTENSIONS` linkme-slice +
  trait pattern. At `init`: load indexed manifests, validate `apiVersion`, dispatch the declarative provisioners
  (ITEM-23..26). Respects the desktop-embeds-server gating (config flag + `CORE_MODULE_BLOCKLIST`, both sides).
- **ITEM-23 — Settings provisioner (declarative, §6.5-A).** From `settings:[{id,schema,scope,gate}]` →
  provision **without per-extension Rust/migration/central edit**: a generic host-owned `ext_settings(extension_id,
  setting_id, scope_key, doc JSONB, updated_at)` table shipped by dropping `migrations/*.sql` (build.rs's
  `compose_merged_migrations_from` globs it; no central list edit), reached via **runtime `sqlx::query` (NOT
  `query!`)**, JSON-schema-validated on write. Generic `GET/PUT /api/ext/{extId}/settings/{id}` gated by the
  manifest `gate:`. FE: a generic admin/user card **auto-rendered from the settings JSON-schema via `SchemaForm`**
  (ITEM-16), registered into `settingsAdminPages`/`settingsUserPages` (mirror `sandbox/module.tsx` +
  `SandboxSettings.store.ts`, gated on `hasPermissionNow(gate)` + `on('sync:ext_settings', reload)`).
- **ITEM-24 — Result-kind provisioner.** From `resultKinds:[{id,layout}]` → register the kind into the **P2
  datatype registry** (kind + storage layout) + a default `ResultRendererContribution` (host renders a standard
  result panel) + wire catalog `writeResult(kind,…)` typing + typed-binary stream. Thin here (a call into P2 +
  a renderer default); **blocked on P1 catalog + P2 registry** landing.
- **ITEM-25 — Collections provisioner (Layer-C, §5.5-C) — generic runtime store.** From `collections:[{id,schema,
  scope,indexes,gate}]` → a generic `ext_records(extension_id, collection, scope_key, doc JSONB, created_at, …)`
  table (+ GIN indexes on declared JSON paths, OR table-per-collection host DDL) + generated typed CRUD REST +
  a **bounded query DSL** (filter/sort/paginate, **never raw SQL** → no injection) + JSON-schema write-validation
  + a sync entity + a `gate:` permission. **No sqlx compile-time macros** (runtime-provisioned — the hard
  boundary); reach via a generic parameterized layer. Client: `api.store.collection(id).query({…})`. Additive-only
  schema bumps auto-migrate; destructive needs a declared step. (Per the task none of the 3 target modules need
  Layer C — build after settings/result-kinds; keep it in scope but lower priority.)
- **ITEM-26 — Jobs provisioner (LATER — net-new periodic-scheduling infra).** From `jobs:[{id,cron|trigger,run}]`
  → a scheduled sandbox job. **Grounding correction:** the `jobs` module is a **FCFS enqueue-run-once work
  queue** — NO cron/`schedule_at`/`next_run`/periodic infra, `job_type` is free-text with **no job-type
  registry**, and there's a **single injected `JobRunner`** (no per-type dispatch). So the provisioner needs
  net-new: (a) a cron table + tick loop that enqueues, (b) a `job_type → RunSpec` dispatch registry, on top of
  P3's `runner::JobRunner`→`sandbox::run_analysis`. Firmly **deferred within P5** (after P3); larger than the
  other provisioners — don't under-scope it as a thin wrapper.
- **ITEM-27 — Generic `SyncEntity` ext variant (closed-enum edit).** `SyncEntity` is a **closed Rust enum**, so
  extension settings/collections can't mint a variant each. Add **ONE generic `SyncEntity::ExtSettings` (+ later
  `ExtRecord`)** variant + its snake_case string-map entry + the string test — keyed by id in the payload,
  serving all extensions — emitted via `publish(ExtSettings, Update, id, Audience::…, origin)`. The single
  closed-enum edit; FE stores subscribe `sync:ext_settings`.
- **ITEM-28 — Lifecycle cascade + teardown.** Register a generalized `StudyExtension` (`#[distributed_slice(
  STUDY_EXTENSIONS)]`) so provisioned collections + host-written catalog rows + artifacts are cascade-cleaned via
  `on_study_deleted`/`on_study_duplicated` through the shared `delete_study_with_extensions` chokepoint (P10) — a
  study delete atomically removes every provisioned layer; duplicate deep-copies them. Extension uninstall drops
  its collections/settings/jobs.
- **ITEM-29 — Runtime permission gating for manifest `gate:` strings.** The kernel permission system is
  compile-time-typed (a unit struct impl'ing `PermissionCheck` whose `with_permission::<(P,)>` is load-bearing
  for the OpenAPI→TS `Permissions.X` emitter). A manifest `gate:` is a **runtime string**, so the generic ext
  endpoints check it via a **runtime permission resolver** against the user's grants, and the host module
  registers extension permission descriptors so admins can grant them. **Flag the emitter interaction:** generic
  ext routes won't auto-produce typed FE `Permissions.X`; the FE consumes the runtime `gate:` string. (Built-ins
  may also declare a compile-time permission the ordinary way.)
- **ITEM-30 — Registry + per-contribution MCP metadata (generator is P9's — A4).**
  **Reconciliation A4: P9 OWNS the registry→MCP tools/resources GENERATOR** (registry entry → MCP tool/resource
  projection). P5 does NOT generate MCP tools itself. P5's job here is to be the **contribution REGISTRY the
  generator reads** + to **expose the per-contribution MCP metadata** it projects from: the LLM-facing
  declaration fields on `Contribution`/`AnalysisContribution` (ITEM-4: `description`, NL `when`, `examples`,
  `safety: read-run|mutating|destructive`, `ai?`), the `params` JsonSchema, the `accepts`/`produces` typed
  artifact-refs, and `category`/`gate`. P5 also exposes the backend-readable projection seam P9 consumes (the
  `ContributionCatalog` / `init_from_registry` surface — P9 ITEM-4), so the generator ingests the registry, not
  OpenAPI. **Seam boundary:** the registry is the SoT (P5); the pure generator that walks it to emit tools
  (`analyses → tools`, `commands`/`selectionActions → tools`, `catalog`/`data`/`selection → resources`), the
  `ai:false`/denylist/`safety`→annotation mapping, and the per-study MCP *server* wiring + JWT/approval boundary
  are all **P9** (P9 ITEM-5..13). P5 must keep the metadata fields stable behind the semver'd `apiVersion` so the
  generator has a firm contract.
- **ITEM-31 — Conformance invariant types + host-gate contract publish + view-kind registry refactor (A6).**
  **Reconciliation A6:** P5 **publishes the conformance invariant TYPES / pure invariant predicates + the
  `runConformance` host-gate signature** in `@txresbench/workbench-api/conformance` — the versioned contract a
  `plotTypes` contribution is validated against. The **concrete view-kind test-suite / battery IMPORTS these from
  `@txresbench/workbench-api`** and is provided by **P7** (P7 ITEM-8/9/10); the import direction is **P7 → P5** (P7
  depends on P5, never the reverse — **no package cycle**). So P5 owns the invariant-predicate + host-gate
  *surface* (the acceptance gate for a `plotTypes` contribution); P7 owns the concrete per-view-kind conformance
  closures + the battery runner that drive it. In practice this means publishing (re-export, not re-implement)
  P7/live3's pure structural predicates (`assertFiniteRange`/`assertMatrixShape`/… from
  `viz-core/conformance/invariants.ts`) + the `runConformance`/`runViewKindConformance` signature through the P5
  surface, with P7 as the single source of the predicate bodies. Do the bounded refactor the BUILD_PLAN
  flags: replace live3's closed `switch(cell.kind)` + `CellKind` union + `CELL_KIND_OPTIONS` + `KIND`
  drift-triple → an open `registerViewKind({id,dense,dataContract,render,conformance})` registry the
  center-canvas (`grid/CellView.tsx`) dispatches through; registration runs the battery so a non-conforming
  third-party kind is auto-rejected. (P7 owns the kind impl; P5 owns the contribution point + battery gate.)
- **ITEM-32 — Dogfood: rebuild the built-ins on the public API ONLY.** Replace
  `analysisRegistry.register(AnalysisPlugin)` in the interface-round analyses (≥2 as the P5 acceptance proof,
  e.g. `clustering.leiden` + `embedding.umap`; the full 8 coordinated with P11) with
  `workbenchRegistry.analyses.register(AnalysisContribution)` (manifest + `params.schema.json` + `accepts:embedding`
  ref rendered by `SchemaForm`); move mock `buildResult` behind the real `compute.run` seam; consume
  `data`/`selection` for color-by + type-match gating; register built-in plots as view-kinds (ITEM-31). Delete
  the ad-hoc `modules/analysis/{registry.ts, types.ts Kind-union}` (superseded by ITEM-2/3/5/7); keep a
  transitional adapter until P6/P11 flip the shell over. **Any built-in that needs a shell internal = an API gap
  to close before Phase-1 sign-off.**
- **ITEM-33 — External loader / sidecar gateway (DEFERRED — seam only).** External manifest loader (per-deployment
  extensions dir / `tinnlab/hub`) + the sidecar gateway (`/api/ext/<id>/*`, the `bio_mcp` reverse-proxy +
  `env_clear` + scoped-token model). **Not built now** (BUILD_PLAN Phase 5b/6); the manifest contract (ITEM-14) is
  authored forward-compatible + tested with a fixture so this drops in without changing it.

---

## Files/modules

**New package `sdk/packages/workbench-api/` (`@txresbench/workbench-api`):**
- `package.json`, `tsconfig.json`, `src/index.ts` (single public surface: re-exports registries + APIs +
  manifest + P2 datatype *types* + P7 conformance battery), `src/version.ts`
- `src/contributions/{registry.ts, types.ts, workbenchRegistry.ts}` — `Registry<T>` + `Contribution` base +
  the 8 descriptor types + the singleton registries
- `src/api/{WorkbenchAPI.ts, createWorkbenchApi.ts, data.ts, selection.ts, compute.ts, commands.ts, ui.ts,
  storage.ts, events.ts}` — the runtime surface + desktop stub host impl
- `src/datatypes/{reexport.ts, when.ts}` — P2 type re-export + `WhenClause` evaluator/availability
- `src/dsl/predicate.ts` — `CellSetPredicate` AST + operator-registry contract (co-owned; P8 imports)
- `src/manifest/{schema.json, types.ts, validate.ts}` — published manifest JSON-schema + type + FE validator
- `src/form/schema-types.ts` — the params/artifact-ref/host-widget-slot JSON-schema *types* only (**A3: the
  `SchemaForm` renderer + `fields/`/`widgets/` live in P6, not here**; P5 may ship a thin desktop stub only if
  needed to compile built-ins pre-P6)
- `src/mcp/metadata.ts` — the per-contribution LLM/MCP metadata *type* surface + the backend-readable
  `ContributionCatalog` projection seam P9's generator consumes (**A4: the generator + safety/denylist mapping
  live in P9, not here**)
- `src/conformance/*` — the invariant-predicate + `runConformance` host-gate *contract* re-exported from P7's
  predicate bodies (**A6: P7 provides the concrete battery importing this**)

**Frontend host wiring (`src-app/ui/`):**
- `src/core/workbench/{discover.ts, host.ts}` — `import.meta.glob` built-in discovery, registry instances,
  per-extension `WorkbenchAPI` construction + capability scoping
- `src/modules/extensions-host/module.tsx` — FE module (runs discovery, exposes `contributions`, registers the
  generic settings card into `settingsAdminPages`)
- `extensions/` (repo top-level) — built-in extension dirs (populated by P11)
- Center-canvas host adopted from live3: `viz-core/grid/CellView.tsx` (switch → `viewKindRegistry` dispatch),
  `gridModel.ts`/`CellChrome.tsx` (drop the closed union/options), new `viewKindRegistry.ts`
- Dogfood targets: `modules/analysis/analyses/*/plugin.tsx`, `registry.ts` + `types.ts` (deleted),
  `stores/AnalysisWorkspace.store.ts` (retargeted)

**Backend (`src-app/server/`):**
- `src/modules/extensions/{mod,manifest,registry,routes,permissions,store}.rs` +
  `provisioners/{collections,settings,jobs,result_kinds}.rs` + `store/{ext_records.rs, query_dsl.rs}` +
  `lifecycle.rs`
- `src/modules/extensions/migrations/*.sql` — `ext_settings` (+ later `ext_records`) — build.rs migration-glob
- `build_helper/extensions.rs` (+ `build.rs` hook) — compute-asset staging

**Modify:**
- root `package.json` — glob already matches `sdk/packages/*` (verify hoisting, no edit)
- `server/src/modules/sync/event.rs` — add `SyncEntity::ExtSettings` (the one closed-enum edit) + string map + test
- `server/src/openapi/*` — generic ext endpoints in the spec (`just openapi-regen`, both binaries)
- study lifecycle: hook `study/core/extension/registry.rs` + `delete_study_with_extensions`
- `src-app/ui/tsconfig.json` (paths) + `vite.config.ts` (alias) + `.syncpackrc.json`
- `src-app/ui/src/modules/analysis/*` — transitional adapter proxying `analysisRegistry` → `contributions`

## Reuse

- **`analysisRegistry` + `AnalysisPlugin` + `availability`/`byCategory`/`standardRecipe`** → the generic
  `Registry<T>` + `AnalysisContribution` (near-verbatim; selectors already pure — the literal template).
- **`ProjectExtensionRegistry`** (cleanest Map-keyed-by-id, HMR-idempotent, order-sorted, render-time-gated) +
  **`ChatExtensionRegistry`** (parallel-Maps-per-surface shape) → the registry substrate.
- **`analyses/shared.tsx`** `Field/RangeField/SelectField/NumberField/SwitchField` (already `@txresbench/kit`,
  shadcn-token clean) → the `SchemaForm` primitive set.
- **`study/core/extensions` (FE) + `study/core/extension/registry.rs` (BE)** (`linkme` slice + trait +
  `on_study_deleted`/`on_study_duplicated` + `OnceCell` + shared delete chokepoint) → the extension-host +
  generalized `StudyExtension` teardown.
- **`modules/loader.ts`** `import.meta.glob('./**/module.tsx')` + topo-sort by `dependencies` (relative literal,
  not `@/`) → built-in discovery.
- **`jobs/settings.rs` + `sandbox/settings.rs`/`sandbox/module.tsx`/`SandboxSettings.store.ts`** (+
  `settingsAdminPages`) → the settings vertical-slice the provisioner emits generically.
- **`sync/event.rs publish()`** → the settings/collections sync path (one generic entity).
- **hub-seed / pgvector `build_helper/*` + `include_dir!`/extract-on-first-use** → compute-asset staging.
- **`build.rs compose_merged_migrations_from`** → module ships `ext_settings`/`ext_records` by dropping `.sql`;
  no central list edit.
- **`@txresbench/framework createModule` + store-kit `defineStore`/`defineExtensionStore` + EventBus `sync:<entity>`**
  → module registration + reactive registry-driven state.
- **`@txresbench/shell` slot registry** → view/panel semantic placement (P6 consumes).
- **`modules/control_mcp/{catalog,tools,policy}.rs`** (`Operation`: operation_id / required_permission /
  mutating / has_secret_field + `is_denied`/`is_mutating`) → the contribution→tool projection + safety hints.
- **`bio_mcp` supervisor/proxy + `env_clear` + scoped-token** → the sidecar gateway (deferred ITEM-33).
- **Phase-0 kernel `jobs`+`sandbox`** (`run_analysis` + `ExtraMount`) + working-store/catalog endpoints → the
  data/compute impl behind the facades.
- **P7 `viz-core/conformance/invariants.ts`** → re-published (ITEM-31).
- **sqlx gotchas** any generated Rust repo must emit: `timestamptz` → `col as "col: DateTime<Utc>"`, `jsonb` →
  `col as "col: serde_json::Value"`, app-side `Uuid::new_v4()`. (The generic runtime store side-steps macros via
  runtime `query`.)

## Dependencies

**Hard upstream (blocking the API *implementations*, not the type surface):**
- **P1 data-foundation** (catalog + data API + `writeResult`) → ITEM-9, ITEM-17 (picker catalog), ITEM-24.
- **P2 datatype-system** (`Datatype`/`ResultKind` registry + `isSubtype` lattice) → ITEM-5/6 (`accepts`/`produces`
  typing), ITEM-7, ITEM-17, ITEM-24. **P2 owns the registry; P5 re-exports types.**
- **P3 compute-scheduling** (`RunSpec`/`JobRunner`/scheduler) → ITEM-11, ITEM-26 (net-new cron).
- **P8 interaction-dsl** (selection + cell-set evaluator + brush/pick runtime) → ITEM-10, ITEM-18
  (`cell-set-selector`). **P8 imports P5's AST (P8→P5, never reverse).**
- **P10 study-substrate** (merged: study-extension registry, sharing/roles, lifecycle cascade, sync) → ITEM-22
  tenancy + ITEM-28 teardown. **Present — generalize, don't rebuild.**
- **P7 visualization** (merged live3: view-kinds + conformance battery) → ITEM-31 refactor + battery source.
- **P4 provenance** — loose: the API carries `methodsText`/run metadata; capture is P4.

The **pure items (1–8, 10-AST, 12–16, 20, 27, 30)** are foundation-independent — land first against interface
stubs + a local `Kind`-union fallback. **Downstream of P5** (consume the seam): P6 workbench-shell (renders from
`contributions` + `SchemaForm` + result-renderers), P7 (its view-kind registry backs `plotTypes`), P9 ai-mcp
(consumes ITEM-30's projection + ITEM-4 metadata), P11 three-modules (authored as manifests against
`@txresbench/workbench-api`), Phase-4 repro export (reads the compute-contract provenance), Phase-5 external
extensions (ITEM-33 seam).

## Sequencing

1. **ITEM-1 → ITEM-2 → ITEM-3 → ITEM-4 → ITEM-5 → ITEM-6 → ITEM-7** — package + registry + contribution types +
   `WhenClause` (pure; unblocks everyone; immediately dogfoodable).
2. **ITEM-8 → ITEM-9/10/11/12/13** — `WorkbenchAPI` interface + facades (against P1/P2/P3/P8 *interfaces* + local
   stubs; ITEM-10 AST-first, evaluator wired when P8 lands).
3. **ITEM-14 → ITEM-15** — manifest schema + validator (FE + BE serde).
4. **ITEM-16 → ITEM-17 → ITEM-18 → ITEM-19** — SchemaForm (reuses `shared.tsx`; no dep), then pickers/widgets/
   code-form (17/18 gated on P1/P2/P8; land stubs first).
5. **ITEM-20 → ITEM-21** — built-in discovery + compute staging.
6. **ITEM-22 → ITEM-23 → ITEM-27 → ITEM-28** — extension-host module + settings provisioner + the closed-enum
   sync variant + lifecycle cascade (independent of P1/P2/P3; lands early — validates the generic-runtime-store +
   closed-enum + runtime-permission approach end-to-end).
7. **ITEM-24** — result-kind provisioner (after P2). **ITEM-25** — collections provisioner (sequential after the
   store lands; lower priority — no target module needs Layer C). **ITEM-29** — runtime permission gating (with
   ITEM-22/23).
8. **ITEM-30** — MCP projection (after 1–2; registry must be stable). **ITEM-31** — conformance publish +
   view-kind refactor (parallel; depends on P7 merge).
9. **ITEM-32** — dogfood **LAST** (validates everything; surfaces API gaps to close before Phase-1 sign-off).
10. **ITEM-26** (jobs, after P3) + **ITEM-33** (external loader/sidecar) — deferred.

Critical intra-P5 path: **1 → 2 → 3** (the type surface every downstream part imports).

## Decisions

- **Namespace: `@txresbench/workbench-api` at `sdk/packages/workbench-api`** — app #2's workbench built ON the txresbench SDK
  (`@txresbench/*`), not part of it. Single public extension import; internal `@txresbench/*` runtimes (`@txresbench/datatypes`=P2,
  `@txresbench/viz`=P7, `@txresbench/kit`) re-exported as **types only** → acyclic leaf. (Documented promotion path to
  `@txresbench/*` if other txresbench apps ever host workbenches.)
- **Datatype registry lives in P2, re-exported by P5** (baked resolution 1). `Registry.availability` calls P2's
  subtype check; P5 never implements the lattice.
- **Cell-set DSL: ownership SPLIT** (baked resolution 2). P5 owns the `CellSetPredicate` AST + operator-registry
  *contract* (versioned public — many drivers: AI, cell-set widget, lasso, provenance); P8 owns the evaluator +
  selection/brush/pick runtime. AST lives in `libs/workbench-api/dsl/predicate.ts`; import direction P8→P5.
- **Registry shape = standalone `workbenchRegistry` singleton with parallel typed Maps** (package-export
  friendly) over the app-internal `Slots` declaration-merge seam. **Unify onto ONE FE contribution mechanism:**
  the richer registry flavor (`when`/`requires`/`availability`) generalizes the bespoke name-keyed registries;
  host settings/nav slots keep the framework `Slots` map. Document the boundary so the two don't fork further.
- **Params contract = JSON-schema → host-rendered form (RJSF-style) on `@txresbench/kit`**, reusing `shared.tsx`;
  artifact-ref fields are a first-class schema `type` unified with `accepts` gating; Tier-3 host widgets;
  React `ParamsForm` is the Tier-4 escape hatch only. **One `params` serves the human form AND the MCP tool
  input schema.** **(A3: P5 owns the schema *type*; the `SchemaForm` renderer is P6's host panel — P5 does not
  build it.)**
- **`accepts`/`produces` typed with subtyping**, replacing the closed `Kind`/`DataKind` enums; availability =
  subtype match over the artifact catalog.
- **Manifest = YAML (napari precedent), JSON also accepted, JSON-schema validated, indexed-not-executed, lazy
  activation.** `apiVersion` = semver range; host refuses out-of-range. The schema is a published contract.
- **`data` API contract = host is a dumb authed byte-Range server; client-side decode (zarrita/DuckDB-WASM) in
  the extension.** Single-box = local-FS range server (same path a future MinIO/worker uses).
- **Compute = `ComputeBackend` seam, only local bwrap implemented;** content-addressed + path-agnostic
  `inputs.json` kept (provenance-by-construction) regardless.
- **Collections/settings runtime store = generic JSONB (`ext_records`/`ext_settings` + declared GIN) via runtime
  `sqlx::query`, NEVER `query!` macros** (runtime-provisioned; §5.5.C sanctioned exception); bounded query DSL,
  never raw SQL; additive-only migrations by default.
- **`SyncEntity` closed-enum ⇒ ONE generic `ExtSettings` (+ later `ExtRecord`) variant**, keyed by id — the
  single closed-enum edit serving all extensions.
- **Manifest `gate:` = a runtime permission resolver + registered descriptors, NOT a compile-time unit struct.**
  Generic ext routes won't mint typed FE `Permissions.X` via the OpenAPI→TS emitter; FE consumes the runtime
  string. (Built-ins may also declare a compile-time permission the ordinary way.)
- **MCP boundary (A4):** P5 owns the contribution **registry** (SoT) + the **per-contribution MCP metadata** +
  the backend-readable projection seam; **P9 owns the registry→tool/resource generator, the safety mapping, and
  the MCP server + JWT/approval wiring.** Coordinate the interface (P9 ITEM-4/5).
- **Declarative view flavor = parameterize a P7 view-kind, NOT Vega-Lite** (viz is deck.gl-only). New view-kinds
  = code, conformance-gated.
- **Built-ins only this round** (build-time `import.meta.glob` FE + build-helper staging BE); external dir/hub
  loader + sidecar gateway DEFERRED (ITEM-33), seam kept forward-compatible.
- **Provisioners are data-driven kernel code, not per-extension Rust** — one `modules/extensions/` module;
  extensions add zero Rust; respects desktop-embedded-server gating (config flag + `CORE_MODULE_BLOCKLIST`).
- **Collections + jobs deferred within P5** (settings + result-kind first; no target module needs Layer C /
  periodic jobs).

## Risks

- **P1/P2/P3/P8 not built yet** — the `data.*`/`compute.*`/`selection.*` impls, catalog, datatype/subtyping don't
  exist. Mitigation: P5 ships **types + a desktop stub** + a local `Kind`-union fallback; the type surface must
  not block on them; dogfood (ITEM-32) is the early forcing function that surfaces gaps.
- **Type-surface churn** — extracting the API before impls stabilize risks rework; interfaces + local stubs +
  early dogfooding contain it; hold descriptor types stable behind the semver'd `apiVersion`.
- **sqlx compile-time vs runtime store** (BUILD_PLAN's flagged trickiest DB detail) — the generic parameterized
  layer must stay injection-safe under the bounded DSL, with careful scope/permission enforcement + additive-only
  migration discipline.
- **DSL ownership split** requires the AST to live in one place (workbench-api) or it duplicates + drifts —
  enforce the import direction (P8→P5, never reverse).
- **Package-graph cycles** — workbench-api must re-export *types* from P2/P7, never their runtimes; guard with a
  dependency-cruiser/lint check.
- **live3 view-kind refactor** — the closed `switch`+`union`+`CELL_KIND_OPTIONS`+`KIND` drift-triple is
  battery-enforced in lockstep; opening it to a registry must preserve/replace that drift guard or third-party
  kinds silently mis-dispatch.
- **No periodic/cron infra exists** — the jobs module is FCFS-enqueue-once, free-text `job_type`, no registry,
  single `JobRunner`; ITEM-26 is net-new scheduling, not a wrapper. Kept deferred; don't under-scope.
- **Compile-time vs runtime permission surface** — generic ext routes can't auto-produce typed FE `Permissions.X`;
  FE consumes the runtime `gate:` string. Small, isolated friction — document so no one expects generated consts.
- **Closed `SyncEntity` + compile-time sqlx** force the generic-JSONB design; a future per-extension typed sync
  entity would re-touch the enum. Accept for built-ins; document the seam.
- **`@txresbench/workbench-api` vs `@txresbench/framework` boundary** — workbench-api **depends on** framework (reuses
  EventBus/Slots), adds only the contribution registries + data/selection/compute API. Keep the split clean.
- **RJSF renderer scope creep** — declarative covers `when`/`if-then`/`repeat-per`/templated defaults; beyond
  that is Tier-4 code-form (explicit boundary).
- **Dogfood exposes API gaps late** (ITEM-32) — expected + desired (it's the proof); budget a convergence tail
  as a built-in needing a shell internal ripples an API change back through the surface.
- **Desktop parity** — provisioners must work with the desktop-embedded server (config flag + blocklist, both
  sides).
- **build.rs staging** — a fresh worktree missing staged extension assets could panic (cf. hub-seed gotcha);
  fail-soft to zero-extension like pgvector.
- **Over-building the framework before features exist** (BUILD_PLAN re-sequencing ⚠️) — keep P5 to what the three
  real modules (P11) actually need; defer external extensibility.

## Effort

- Package + types + registries (ITEM-1..7): **M** (~2–3 d; mostly generalizing existing pure code — the
  `analysisRegistry` is a head start).
- API facades (ITEM-8..13): **M**, mostly thin over P1/P2/P3/P8 once endpoints exist (stub the wire until then).
- Manifest + validator (ITEM-14..15): **S–M** (~1.5 d).
- Form renderer + pickers + widgets + code-form (ITEM-16..19): **M–L** (~3–4 d; SchemaForm + artifact-ref are the
  meat).
- Discovery/loader (ITEM-20..21): **S–M** (~1.5 d).
- BE host module + settings/result-kind provisioners + closed-enum sync + lifecycle + runtime-perm
  (ITEM-22..24, 27..29): **M–L** (new generic-store + sync + card + runtime permission resolver).
- Collections provisioner (ITEM-25): **M** (runtime store + query DSL + cascade — the heaviest, most novel
  backend; lower priority).
- MCP projection (ITEM-30): **M** (bounded pure generator).
- Conformance publish + view-kind refactor (ITEM-31): **M** (bounded but battery-lockstep-sensitive).
- Dogfood (ITEM-32): **M** + a variable convergence tail as gaps surface.
- Deferred: jobs (ITEM-26) **M each, net-new scheduling, after P3**; external loader/sidecar (ITEM-33) later.

**Total (this round's scope, excl. deferred jobs/external): ~L / ~14–18 dev-days**, gated by P1/P2 landing for
the picker + result-kind items; the pure type surface + settings provisioner + form renderer proceed
immediately. It's the platform's central abstraction — sequence pure-core → provisioners → dogfood; never
big-bang.

## Saturation

r3 did NOT add substantively new *work items* beyond r1∪r2 — every r3 item maps to an r1 or r2 item (DSL,
datatypes, MCP projection, conformance, facades, provisioners, dogfood all pre-exist across the earlier two).
What r3 uniquely contributed is **conflict RESOLUTION**, which is exactly the convergence the DIFF_R1_R2 verdict
("DIVERGED — needs r3") demanded: it settled the three open ownership disputes the diff surfaced — datatype
registry → P2 (was r1-P2 vs r2-P5-owned), cell-set DSL → types-P5/evaluator-P8 (was r1-P8 vs r2-P5-owned),
namespace → `@txresbench/*` on the `@txresbench/*` SDK with an explicit acyclic-graph rule (was r1-`@txresbench` vs r2-`@txresbench`) —
and made the package-graph acyclicity + capability-scoped per-extension `WorkbenchAPI` construction explicit.
Those are decisions, not net-new scope. With the ownership questions now resolved and no new work surface
appearing, the union is complete. SATURATION: REACHED
