# TxResBench Analysis Workbench — Extension Platform Architecture

Status: **design spec** (target architecture). Grounds the analysis workbench as an IDE-style **contributable
platform** — internal today, third-party-contributable over time — so "tens of analyses + views plug in,"
and eventually *other people* contribute them, without touching the shell.

Prior art surveyed (see `WORKBENCH_IA.md`): VS Code (extension host + `contributes` + activation), JupyterLab
(plugin/token DI), napari (`npe2` manifest), Galaxy (tool XML wrappers), KNIME (nodes), nf-core (modules).
Data model: `docs/DATA_STORAGE_REDESIGN.md`. Isolation: `modules/sandbox` (bwrap). Discovery/loader:
`STUDY_EXTENSIONS` + `import.meta.glob`. Analysis descriptor seed: the `analysisRegistry` (interface round).

---

## 0. The one principle

**The host is a shell that owns a fixed set of *contribution points* (registries) exposed through a
versioned public API. Every capability — including all of ours — is a module that *contributes* through that
API and never touches shell internals.** If our own built-in analyses can only be built with the public API,
an outsider can build anything we can. (VS Code dogfoods its API exactly this way.)

Three pillars make it real:
1. **A versioned Extension API** (`@txresbench/workbench-api`) — the only surface extensions touch.
2. **Manifest-declared contributions** — everything is declared statically so the host indexes/renders it
   without executing extension code; code loads lazily on activation.
3. **A typed data contract** — a shared AnnData-like kind-typed model (the platform's "DOM"), so an
   extension consumes data another extension produced.

And the trust solution we already own: **compute runs in the bwrap sandbox**, so third-party *analysis* code
never runs in the host at all.

---

## 0.4 The AI-assisted surface — the contribution registry GENERATES the MCP tools/resources

This is an **AI-assisted computing system**: every capability (run an analysis, select cells, assign a label,
navigate, export) is exposed to an LLM chat as **MCP** tools/resources. The architecture supports this
*because the contribution registry is the single source of truth, and the MCP surface is GENERATED from it* —
not hand-wired per feature. **The one property that makes an AI-driven workbench tractable: one contribution
declaration → THREE surfaces — the human UI, the MCP tool, and the programmatic API.**

- **Analyses → MCP tools, for free.** An `AnalysisContribution` already declares a **JSON-schema params** +
  typed `accepts`/`produces` (§4.3). An **MCP tool IS name + description + JSON-schema input** — so *the same
  declaration that renders the human form emits the MCP tool*. Declarative-first (which felt like a UI choice)
  is what makes the AI surface **zero-cost**: 200 analyses → 200 tools, generated.
- **Commands + selection-actions → MCP tools ("every button click as a feature").** The command registry
  (§1) is the tool list; "Assign annotation", "Export", "Subcluster" become callable tools. Even an
  *interactive tool* (§4.4) exposes its **effect** as a command — so the AI calls `annotate.assign(label,
  selection)` even though a human drags a lasso. Buttons are commands; commands are tools.
- **Catalog + data + selection → MCP resources (the AI's eyes + state).** The AI reads the **typed-artifact
  graph** (what datasets/analyses exist, their datatypes), the current **selection**, the **data API** — as
  MCP resources. This is its world model.
- **The typed-artifact graph = the AI's PLANNER.** Because compatibility is `accepts`/`produces` + subtyping
  (DATA_MODEL), the AI can *plan a workflow* by chaining compatible tools: "cluster my data" → query the
  catalog for an `embedding`, call `clustering.leiden(embedding=…, resolution=…)`; if no embedding exists,
  chain `embedding.umap` first. The type system tells the AI what's valid to run on what — it plans over the
  graph instead of guessing.
- **Selection-as-recipe = the shared AI / human / provenance representation.** The AI selects by **predicate**
  ("cells where cluster==2 and pct_mito<0.1"), which is *exactly* how provenance stores selections (§0.6) and
  how a human lasso resolves. So `api.selection.setByPredicate(...)` is the AI's hand; it doesn't simulate a
  lasso. One representation for all three actors.
- **Provenance = the AI's auditability + reproducibility.** Every AI action is a **run node** (§0.6) — so you
  can trace + reproduce *exactly* what the AI did. Essential for trust in an AI-driven science tool: the agent
  can't do anything that isn't a content-addressed, replayable step.
- **Human + AI CO-DRIVE the same workbench.** An AI tool call produces the same run node a human click would;
  **sync** (§0.5) streams the change to the human's live view. The AI and the human operate one shared
  workbench state, not parallel ones.

**Grounds in the app's existing MCP infrastructure** (this is the app's *native* model, not new): capabilities
are already exposed as built-in **MCP servers** (memory/files/code_sandbox/web_search/lit_search/citations/
knowledge_base/**bio_mcp**), **`control_mcp`** literally drives the app's REST API from chat, the chat extension
injects tools into the LLM, and there is **tool-call approval + a permission gate + an untrusted-content
guard**. The workbench platform adds one thing: a **built-in MCP server auto-generated from the contribution
registry** (per-study, scoped by the study role §0.5, read-analyses auto-approved / destructive actions
gated). So the AI surface is *derived from the same declarations* the UI and API use — every new extension
becomes an AI capability automatically, permission-gated and provenance-tracked.

**Why this validates the whole design:** the pressures that shaped it — declarative contributions, a typed
artifact/compatibility graph, selection-as-recipe, provenance-as-byproduct, one shared canvas/selection — are
*precisely* the properties an AI needs (typed callable tools, a plannable world model, a machine-expressible
selection, an auditable action log, a single shared state). **The workbench being AI-drivable is not a bolt-on;
it's the same structure viewed through MCP.** A capability that isn't a clean declared contribution is exactly
a capability the AI can't use — so "everything is a typed contribution" and "everything is an AI tool" are the
same requirement.

### 0.4.1 Worked example — "cells with gene ABC > its median → label XYZ" (compound, computed, AI-driven)
This combines a *computed* selection (a statistic + a threshold) with an *action*. It resolves to **two declared
tool calls over a safe predicate language** — and surfaces one primitive to name: the **cell-set predicate DSL**.

**The cell-set predicate DSL (a first-class platform primitive).** Selection-as-recipe (§0.6) needs a concrete
form: a **small, safe, composable expression language over per-cell values** — genes (via the data API), obs
columns, QC metrics — with **reductions** (median/mean/quantile/MAD), **comparisons**, **boolean/set ops**. It
evaluates to a bitmask over the canonical cell axis. Not arbitrary code — a bounded, typed expression (like a
SQL-WHERE over cells). This ONE DSL is shared by: the AI (emits it), the `cell-set-selector` widget (§4.3
builds it), a human lasso (a geometric predicate compiles to it), and **provenance** (stores it as the recipe).
```json
{ "gt": [ {"gene": "ABC", "layer": "lognorm"},
          {"reduce": "median", "of": {"gene": "ABC", "layer": "lognorm"}} ] }
```

**Execution — two tool calls:**
1. `selection.setByPredicate(<the predicate above>)` — the host's **predicate evaluator** (a core, domain-neutral
   capability) reads gene ABC's column via the **data API** (§2 — the sparse column, likely already fetched for
   coloring), computes the **median** (a cheap O(n) reduction in-process), applies `>` → a **bitmask**, sets the
   **shared selection**, and **stores the predicate as the recipe** (not the materialized cell list) + the
   **pinned input hash** (the expression artifact's version). Reproducible: re-evaluating on the same input
   yields the same cells.
2. `annotate.assign(label="XYZ", selection=current)` — the annotation contribution (§4.4) writes an
   **`annotation` artifact** (the labeled cells) with a **run node** referencing the selection recipe.

**The AI's role:** it translates the NL request into the predicate DSL (a structured tool argument, not code),
having read the **data schema** (does gene `ABC` exist in `var`? an MCP resource) and the **DSL operator
vocabulary**. If ABC doesn't exist → a typed error the AI relays. Both steps are **declared MCP tools**
(`selection.setByPredicate`, `annotate.assign`), so the whole thing is two tool calls the agent composes.

**Provenance + reproducibility:** the selection recipe (`ABC > median(ABC)` + input hash) + the assign run node
are both in the graph (§0.6) → the methods/script export reads "selected cells where lognorm(ABC) > median;
assigned label XYZ," and re-running regenerates the identical cells + label.

**Where compute happens (and why it stays fast + safe):** a simple reduction like *median of one gene column*
evaluates **in-process** (host/client — the column is small/sparse and already resident). A **heavy computed
feature** (e.g. a 500-gene signature score, a neighborhood statistic) is *not* jammed into the predicate — it's
a **sandboxed analysis** that produces a per-cell **`metadata-column` artifact**, and the predicate then
references *that* column (`{"gt": [{"col": "ABC_signature"}, …]}`). So the predicate DSL stays a fast, safe
filter over resident per-cell values; anything expensive is reified as an artifact-producing analysis first.
And because the DSL is bounded (no arbitrary code), an AI-emitted **selection can't do harm** — it only selects;
the **assign is a separate, permission-gated action** (§0.5 study role + tool-call approval).

**Net:** the platform supports "get cells where gene ABC > its median, then label XYZ" as
`selection.setByPredicate(gt(gene ABC, median(gene ABC)))` → `annotate.assign(XYZ)` — two declared tools over a
safe cell-set DSL, evaluated in-process, stored as a reproducible recipe + run node. The same DSL a human
builds in the cell-set widget and the AI emits from chat — one representation, three drivers.

### 0.4.2 How an extension exposes its features to the LLM
An extension **does not write MCP code.** It **declares contributions with LLM-facing metadata**, and the host
**generates** the tool/resource surface from the registry (§0.4). Per contribution kind:

| Extension declares… | LLM surface (auto-generated) | Extra the author provides |
|---|---|---|
| **analysis** (params JSON-schema + accepts/produces) | an **MCP tool** (input schema = the params; artifact-refs typed as "artifact id of type X") | good `description`, per-param docs, `when`, examples, safety hint |
| **command / selection-action** | an **MCP tool** | description + args + safety hint |
| **interactive tool** (code panel) | its **effects declared as commands** → tools (e.g. `annotate.assign(label, selection)`) | one command per mutating effect + docs |
| **view-kind / viewer** | addressable via the host **`view.set(cell, kind)`** tool (not a per-viewer tool) | a name + one-line "what it shows" |
| **cell-set DSL operator / per-cell feature** | added to the **DSL vocabulary** the AI reads (a resource); or a produced `metadata-column` the predicate references | operator name + semantics |
| **produced artifacts** | **catalog resources** the AI reads | — (automatic) |
| **field-provider / result-renderer** | **internal** (not a tool — wiring) | — |

**The metadata an author provides is LLM-facing AND human-facing — one set.** The `description`, `when`,
`examples`, and per-param docs that make a tool usable by the LLM are the *same* strings that power the human
form's help/tooltips. So documenting for the AI = documenting for the human; you write it once.
```yaml
analyses:
  - id: clustering.leiden
    title: Leiden clustering
    description: "Group cells into clusters on the neighborhood graph of an embedding."   # → tool description
    when: "the user wants to identify cell populations / clusters"                        # → LLM routing hint
    examples: [ "cluster the cells", "find populations at high resolution" ]              # → few-shot for the LLM
    safety: read-run                                    # read-run | mutating | destructive → MCP approval hint
    accepts: [ { id: embedding, type: embedding, doc: "which embedding to cluster on" } ] # artifact-ref → typed tool param
    params:
      - { id: resolution, type: number, min: 0.1, max: 2, default: 0.6,
          doc: "higher = more, finer clusters" }        # → the param's schema description the LLM reads
```

**Exposure is opt-out-able + safety-gated per contribution.** Default: analyses, commands, and
selection-actions are **AI-exposed**; views/renderers/providers are internal. An author can set `ai: false` to
hide a contribution from the LLM, and declares a **safety hint** (`read-run` / `mutating` / `destructive`) that
maps to the app's **MCP tool annotations + approval flow** (§0.4): read/run auto-approved per policy, mutating/
destructive gated. So the extension controls *what* the AI can call and *how safe* each call is — declaratively.

**Extending the AI's vocabulary, not just its actions.** Because compatibility is typed (accepts/produces) and
selections are a DSL, an extension doesn't only add *tools* — it enriches the AI's **world model**: a new
datatype makes new artifacts describable, a new analysis makes new `produces` types reachable (so the AI can
plan longer chains), a new DSL operator/feature lets the AI express new selections. The AI gets smarter about
the domain purely from extensions declaring typed contributions.

**Net:** to expose a feature to the LLM, an extension **declares it as a contribution with a description +
safety hint** — nothing MCP-specific. The host emits the tool/resource, wires approval + permission gating
(§0.5), and tracks the call in provenance (§0.6). "Contribute a feature" and "expose it to the AI" are **one
act**, because the MCP surface is a projection of the same registry the UI and API project from.

## 0.5 The study substrate — tenancy, access, lifecycle, realtime (foundational; already built)

Before contribution points, the platform needs a **tenancy + access-control + lifecycle + realtime** boundary
that everything is scoped by. This is **not to-be-built** — `feat/study-management` (live8) is exactly it, and
it's why the whole extension model is safe and collaborative for free. The extension platform does not invent
any of this; it **inherits** it.

- **The study is the tenancy unit.** Every extension data layer (artifacts, catalog rows, Layer-C collections
  — §5/§5.5) and every extension backend is **study-scoped**. "This extension's data" always means "within
  this study." The study is the container extensions plug into (`STUDY_EXTENSIONS`/`STUDY_SLOTS`).
- **Access control = `EffectivePermission` (owner / editor / viewer)** + **sharing** (`StudyShare`,
  editor/viewer, accept/decline) + **ownership transfer** (`StudyTransfer`, accept/decline). This is the
  **outer authz boundary** for the whole workbench: an **owner** shares/transfers/deletes, an **editor** runs
  analyses + mutates, a **viewer** gets the workbench + all extension results **read-only**. The workbench's
  `canEdit`, and the extension **data API's** read/write scoping, both **derive from this** — extensions don't
  re-implement access control; they get gated by the study role. (Two-level authz: study role = outer;
  per-capability `gate:` permission = inner.)
- **Collaboration / hand-off is already solved.** Sharing a study as **viewer** *is* the "hand a PI/reviewer
  an interactive read-only result" JTBD (from the research) — no new feature. The read-only workbench maps
  1:1 to a shared viewer. Transfer covers "move ownership to the bioinformatician / core."
- **Lifecycle cascade = the extension teardown/copy seam.** Study **delete / duplicate / transfer** must
  cascade over *all* extension data (artifacts + catalog + collections). The `on_study_deleted` /
  `on_study_duplicated` hooks (the study-extension registry, live5) are where extensions clean up / deep-copy;
  live8's lifecycle drives them through the **shared delete chokepoint** (`delete_study_with_extensions`), so
  a study delete atomically removes every module's data. §5.5's "uninstall/study-delete cascade" *is* this.
- **Realtime = sync (`SyncEntity` + `publish`, notify-and-refetch).** When an extension produces a result
  (a clustering, a DE table), the change propagates to the study's collaborators' devices via a study-scoped
  sync event — so a shared workbench updates live. Extension result-writes emit sync through the host.

**Why "super important":** the study substrate is what makes the extension platform *multi-tenant, access-
controlled, collaborative, lifecycle-safe, and realtime* **without any extension implementing those** — they
inherit tenancy + role-based access + sharing + delete/duplicate cascade + sync from the study. Get the
substrate right (live8 did) and an extension is just "declare contributions scoped to a study"; the hard
cross-cutting concerns are already handled by the kernel.

**Generalization path (SDK G8 — the generic `EntityExtensionRegistry`).** Today the extension seam is
study-specific (`STUDY_EXTENSIONS`). The natural generalization is a **generic entity-extension registry**:
the *same* machinery (contribution slots + lifecycle hooks + access model + sync) parameterized over an entity
type, so the workbench could host extensions on any tenancy entity, not only `study`. Flagged as an SDK gap;
not required for the three-module target, but it's how "one platform, many hostable entities" would land.

## 0.6 Provenance & reproducibility — the lineage backbone (live8, `feat/provenance`)

The single most important realization from live8's provenance design: **provenance is not a feature the
platform adds — it is the SAME graph as the composition DAG, produced as a zero-effort byproduct of the
execution model.** This unifies three things I had described separately (the requires/produces DAG, the
compute contract, and the reproducibility JTBD).

live8's model (from `feat/provenance` DESIGN_CANDIDATES §B1/§B3, DEC-GRAPH):
- **The provenance graph = the analysis DAG, persisted.** Nodes are **run nodes** + artifacts; edges are
  derivation (which run produced which artifact from which inputs). The **analysis is the provenance unit; the
  job is the execution unit** (a multi-analysis job = N run nodes). This is *exactly* the `requires`/`produces`
  graph the modules compose through (§8.5) — so **composition and lineage are one graph**, not two.
- **"One code path" — everything runs as content-addressed code in the sandbox.** The script that runs a step
  IS captured: a **hashed, content-addressed blob** (`provenance_code_blobs`) + a **path-agnostic
  `inputs.json`** (inputs mounted at stable paths, params baked in, derived from the graph edges) → run via
  `sandbox::run_analysis` behind `JobRunner` → outputs + the run node/edges recorded. The path-agnostic inputs
  manifest makes the script **byte-identical across runs → content-addressable → reproducible.**
- **Interactive/manual actions are reified as code too.** A lasso selection, an annotation assign, a figure
  spec — every state-mutating UI action is a **run node with a typed record**, and its effect is **emitted as
  code** on the same seam. So the *whole workbench session* (analyses + manual steps) is a reconstructable
  program. **Selection is stored as a RECIPE** (predicate + pinned input hash), never a materialized cell set —
  reproducible + scale-safe.
- **Reproducible export** = the graph → a runnable **reproduce-script** + templated **methods text** +
  **env-pinning** + an **RO-Crate-shaped manifest** + an optional **in-sandbox re-run verification badge** +
  optional Zenodo/DataCite **DOI**. "Provenance-as-a-zero-effort-byproduct" is the wedge.

**What this means for THIS platform (unifications + a correction):**
1. **The compute contract (§4.1) IS the provenance-capture mechanism.** Because every analysis extension runs
   as content-addressed code in the sandbox with a path-agnostic `inputs.json`, **each `run` automatically
   produces a run node + hashed code blob + input/output edges.** Extensions don't "add provenance"; it's
   inherent in how compute executes. A third-party analysis is reproducible/auditable *by construction*,
   whoever wrote it — the platform's trust story.
2. **The composition DAG (§8.5) and the provenance graph are the same graph.** `requires`/`produces` edges =
   lineage edges. Availability-gating, recipe-ordering, and lineage/reproduce-export all read one graph.
3. **Reproducibility is live8's provenance, NOT a separate platform/analysis-workflow feature** (resolves
   `DEC-OVERLAP-LIVE5`: live5's "phase-3 reproducibility / script+methods export" line defers to this). The
   workbench's Export → script/methods/bundle is a *view onto* the provenance graph.
4. **The selection→annotation/DE loop stores selections as recipes** (predicate + input hash), so the
   workbench's brushing-and-linking is reproducible + persists as provenance, not as frozen cell lists.

**Shared unbuilt FOUNDATION (flagged by live8's DEC-FOUNDATION — the thing to build FIRST):** provenance, this
platform's Layer-B **catalog / results-store**, the workbench, AND the compute path all depend on the same
not-yet-built pieces — the **kind-typed working store + `analysis_results` catalog** (`DATA_STORAGE_REDESIGN`,
a proposal) and the **`JobRunner`→`sandbox::run_analysis`** integration (the runner is still a stub). None of
these three workstreams (analysis-workflow, provenance, visualization) can land until that foundation exists.
It is the **critical path for the whole platform.**

---

## 1. Contribution points (the registries)

The shell defines these registries. A contribution is a typed entry; the shell renders/dispatches whatever is
registered. This is the VS Code `contributes` set, specialized for a data workbench.

```ts
// @txresbench/workbench-api — the contribution surface
interface Contributions {
  analyses:         Registry<AnalysisContribution>        // an analysis (params + run + outputs)
  plotTypes:        Registry<PlotTypeContribution>         // a center-canvas renderer (scatter/violin/…)
  fieldProviders:   Registry<FieldProviderContribution>   // left-rail "color/select by" sources
  resultRenderers:  Registry<ResultRendererContribution>  // how a produced result-kind draws
  views:            Registry<ViewContribution>            // a panel/tab in a dock (left/right/bottom)
  commands:         Registry<CommandContribution>         // palette/toolbar/menu actions
  selectionActions: Registry<SelectionActionContribution> // actions offered on a cell selection
}
```

Cross-cutting on every contribution:
- `id: string` (namespaced, e.g. `trajectory.monocle`), `extensionId`, `apiVersion`.
- `when?: WhenClause` / `requires?: DataKind[]` — activation/visibility gating (`requires:['embedding']`).
- `order?`, `category?`, `title`, `icon?`.

### 1.1 Docks are containers; views are contributions
The three docks (left/right/bottom) + the center canvas are **view containers**. A `ViewContribution` targets
an area; the shell places, tabs, and collapses it. No module hard-codes into a dock.
```ts
interface ViewContribution {
  id: string; area: 'left'|'right'|'bottom'; title: string
  when?: WhenClause                     // e.g. "has:trajectory"
  render: ViewSpec                      // declarative (schema/table/plot) OR { iframe } OR { component } (built-in only)
}
```

### 1.2 Analyses (the headline contribution point)
```ts
interface AnalysisContribution<P=Json> {
  id: string; category: AnalysisCategory
  requires: DataKind[]; produces: ResultKind
  params: JsonSchema                    // → host renders the form (no custom UI needed)
  defaults: P
  run: RunSpec                          // sandboxed compute (below) OR an in-host builtin fn
  methodsText?(p: P): string            // for provenance / methods paragraph
  inStandardRecipe?: boolean; recipeOrder?: number
}
```

---

## 2. The Extension API surface (`@txresbench/workbench-api`)

What the host provides *to* extensions. Semver'd; extensions declare a compatible range.

```ts
export interface WorkbenchAPI {
  version: string                                   // e.g. "1.3.0"; extensions declare "^1.0"

  // --- register contributions (or declare them in the manifest; code path for built-ins/dynamic) ---
  registry: Contributions

  // --- DATA (the typed contract; read the working store, write results) ---
  data: {
    catalog(): Promise<Catalog>                      // samples, analyses, obs/var columns, N/G
    embedding(id: string): Promise<Float32Array>     // N×2/3, zero-copy typed array
    obs(column: string): Promise<Categorical|Float32Array>
    geneColumn(gene: string, layer?: string): Promise<{ row: Uint32Array; value: Float32Array }> // sparse
    clustering(id: string): Promise<{ codes: Uint16Array; categories: string[] }>
    deTable(id: string, page: Page): Promise<DeTablePage>
    writeAnnotation(name: string, codes: Uint16Array, categories: string[]): Promise<void>
    writeResult(kind: ResultKind, artifact: ArtifactRef): Promise<string> // returns analysis_id
  }

  // --- SELECTION (brushing-and-linking; the connective tissue) ---
  selection: {
    current(): CellSet                               // bitmask over the canonical cell axis
    onChange(cb: (s: CellSet) => void): Disposable
    set(s: CellSet): void
  }

  // --- COMMANDS / UI host services ---
  commands: { register(id, handler): Disposable; execute(id, ...args): Promise<unknown> }
  ui: { notify(msg): void; openView(id): void; progress<T>(task): Promise<T> }

  // --- COMPUTE (submit a sandboxed job; the host owns queueing + isolation) ---
  compute: {
    run(spec: RunSpec, inputs: DataKind[], params: Json): Promise<JobHandle> // → sandbox; streams progress
  }

  // --- per-extension scoped storage + events ---
  storage: KeyValue
  events: EventBus
}
```
Key property: an extension can **read an embedding another extension produced** and **write a result the host
renders** — without knowing anything about the shell or the other extension. The data API + selection API are
the whole integration surface.

---

## 3. The manifest (declarative contributions)

Every extension ships a manifest the host indexes **without executing it**. Contributions appear in the UI
(gated by `requires`/`when`) from the manifest alone; code activates lazily.

```yaml
# extension.yaml
id: txr.trajectory-monocle
name: Monocle Trajectory
publisher: some-lab
version: 0.3.1
apiVersion: "^1.0"                      # compatibility range against WorkbenchAPI.version
activation: [ "onAnalysis:trajectory.monocle", "onView:trajectory" ]  # lazy
contributes:
  analyses:
    - id: trajectory.monocle
      category: trajectory
      requires: [embedding, clustering]
      produces: trajectory
      params: ./params.schema.json                  # JSON-schema → host renders the form
      run: { kind: sandbox, runtime: rscript, entry: run.R, timeout: 600 }
  plotTypes:
    - id: trajectory-graph
      consumes: trajectory
      spec: ./trajectory.vl.json                    # Vega-Lite → host renders it
  views:
    - { id: trajectory-panel, area: bottom, title: Trajectory, when: "has:trajectory" }
  selectionActions:
    - { id: run-traj, title: "Compute trajectory", when: "has:embedding", command: trajectory.monocle }
```
Manifest schema (JSON-schema’d, validated at load) is itself part of the published API contract.

---

## 4. The three contribution flavors (trust ⇄ power)

| Flavor | What a contributor ships | Trust needed | Isolation | Covers |
|---|---|---|---|---|
| **Analysis (compute)** | manifest + a sandbox script (Python/R) + a params JSON-schema + declared output kinds | **low** | the **bwrap sandbox** (already built) | new clustering/DE/integration/trajectory/enrichment/annotation methods |
| **View — declarative** | a **Vega-Lite** plot spec / **JSON-schema** form / table column-config | low-med | none (host renders the data-driven spec) | violin · volcano · dot-plot · heatmap · custom params forms · result tables (~90% of views) |
| **View — code** | a sandboxed **iframe** module + a postMessage bridge to the API | high | iframe/webview | bespoke interactive panels (last, biggest step) |

**Design rule: open flavors in order of (value ÷ risk).** Analyses first — highest value, lowest risk,
because they run sandboxed and only need a manifest (the proven Galaxy-tool / nf-core-module / KNIME-node
model). Declarative views next — safe because they're data, not code. Code-views + a runtime marketplace
last.

### 4.1 The compute contract (how a sandboxed analysis runs)
The host, not the extension, owns queueing (jobs), mounting, and isolation. Contract for `run: { kind: sandbox }`:
- **Inputs in:** the host materializes the declared `requires` kinds as read-only files in the sandbox
  workspace at a stable path (`/inputs/embedding.h5`, `/inputs/expression.h5`, `/inputs/params.json`).
- **Compute:** the entry script runs in bwrap (`--clearenv`, no DB/secrets/network-by-default), reads
  `/inputs`, writes kind-typed artifacts to `/outputs/` (per `DATA_STORAGE_REDESIGN` — `result.h5`,
  `de.parquet`, …) + a `manifest.json` naming produced ids/kinds.
- **Outputs out:** the host ingests `/outputs/` into the working store + catalog, stamps provenance
  (params, versions, seed), and makes the new artifact available to `data.*` + renderers.
- **Progress:** stdout/stderr stream to the job log + a progress channel; the host shows it.
This is exactly `modules/jobs` (queue) + `modules/sandbox` (`run_analysis` + `ExtraMount`) + the
`DATA_STORAGE_REDESIGN` output schema — the platform is those three, generalized behind the manifest.

### 4.1.1 Job scheduling — classes, pools, fairness (NOT one FCFS queue)
The current jobs module is FCFS + a concurrency cap. That's wrong for the platform's workload mix: a 40s
reclustering the user is *watching*, a 3-hour fastq pipeline, a GPU scVI training, and an AI agent bursting ten
tool calls can't share one FIFO line — the long batch job head-of-line-blocks the interactive one. The fix is a
small scheduling policy over **three orthogonal dimensions** (not a linear tier ladder):

**1. Latency / priority class** — `interactive | normal | batch`. Interactive jobs (a UI slider re-run, a DE on
the current selection — a human is watching) get **reserved slots / priority** so they never queue behind long
batch jobs. Batch (pipelines, training) runs when interactive slots are free. This kills head-of-line blocking.

**2. Resource + backend class** — `cpu-sandbox | highmem | gpu | cluster-batch`. A job declares what it needs;
the scheduler **routes it to a compatible worker pool AND execution backend.** The light interactive R/Python
runs in the **bwrap sandbox** on the app host; a **fastq alignment / scVI training** does NOT — it runs on a
**batch/GPU/cluster backend** (Nextflow/SLURM/AWS-Batch/a GPU node) via the sidecar/remote-compute seam. So the
compute backend is itself tiered: sandbox for interactive, a heavy backend for pipelines. Each pool has its own
concurrency cap.

**3. Fairness** — per-user / per-study **weighted fair queuing** within a class, so one user's burst — or the
**AI agent's** burst of chained tool calls — can't starve others. (The AI's jobs default to `normal`/`batch`
unless the human is actively waiting on the result.)

**The extension DECLARES the profile; the scheduler decides** (same declarative principle):
```yaml
run: { kind: sandbox, runtime: python, entry: cluster.py }
schedule: { class: interactive, resources: { cpu: 2, mem: 4Gi } }        # a reclustering
# vs
run: { kind: batch, backend: nextflow, entry: main.nf }
schedule: { class: batch, resources: { cpu: 32, mem: 128Gi, gpu: 1 } }   # a fastq pipeline / scVI
```
Or the host **infers priority from the trigger** (a UI interactive control → `interactive`; an explicit "run
pipeline" → `batch`). Extensions declare needs; the scheduler routes + prioritizes + fair-shares.

**Not everything is a job.** Instant ops — a predicate evaluation, a selection reduction (median), a color-by
read (§0.4.1) — run **in-process**, never queued. Tier-0 = "not a job." Only real compute enters the scheduler.

**Degrades gracefully.** Desktop/single-node = one pool + interactive priority (near-FCFS); multi-user server =
full pools + fair-share + a heavy batch/cloud backend for pipelines. **Orthogonal to provenance** — a job is a
run node regardless of which class/pool/backend ran it (§0.6).

So: yes, tiers — but as **(priority class) × (resource+backend pool) × (fair-share)**, declared by the
extension and routed by the scheduler, so a human's 40s reclustering never waits on someone's 3-hour pipeline,
GPU jobs land on GPU nodes, and the AI's bursts stay fair. This is a generalization of the existing FCFS jobs
module, not a new subsystem.

### 4.1.2 Compute topology — the sandbox can run ANYWHERE (desktop · worker pool · HPC)
The software runs single-user desktop AND multi-user server, and compute may need to leave the app box (GPU,
HPC, scale). This works because of the **control-plane / data-plane split**, and it needs no change to
extensions.

**Control plane vs data plane.** The **app host is the control plane** — scheduler, catalog, provenance, auth,
the extension registry. **Object storage (S3-compatible) is the data plane** — all artifacts, content-addressed.
**Compute is a swappable backend** behind one seam (the `JobRunner`/`ComputeBackend` trait, §4.1). Because the
compute contract is **content-addressed code + a path-agnostic `inputs.json`** (§0.6/§4.1), *the same job runs
identically anywhere* — the script never knows where it is. The app already does host-talks-to-remote-agent
(the macOS **libkrun VM + `sandbox-guest-agent`**, the WSL2 **AF_VSOCK agent**); this generalizes it.

**Backends (chosen by the job's resource class, §4.1.1):**
- **Local sandbox** — bwrap on the app host (desktop + small server).
- **Remote worker pool** — N boxes each running a **worker agent**; the host dispatches a job, the agent runs
  bwrap locally, streams back. Horizontal scale.
- **HPC** — a backend that **submits to SLURM/PBS/LSF**; the path-agnostic job runs on a compute node under
  **Apptainer/Singularity** (HPC's container runtime) instead of bwrap.
- **Cloud batch** — AWS Batch / GCP Batch / Kubernetes Jobs, same pattern.

**Mounting inputs when compute is remote — fetch by reference, not mount by path.** Artifacts are
**content-addressed objects** in object storage; `inputs.json` references them by **hash/URI**, not a local
path. The backend, wherever it runs, **fetches the input artifacts from object storage into its local scratch**
and **bind-mounts them at the stable paths** the `inputs.json` declares. So "mount `/inputs/expression.h5`"
becomes "fetch object `sha256:…` → local scratch → bind-mount there." Content-addressing makes this **free to
cache** — an immutable artifact fetched once is reused across jobs/boxes; on HPC the cluster's shared parallel
FS (Lustre/GPFS) is a staging cache over the object-store source of truth.

**Streaming results back — upload + manifest, not a filesystem write to the app host.** Compute writes
`/outputs` locally, **uploads the output artifacts to object storage** (content-addressed), and reports the
**`produces` manifest** (output → artifact id + hash) back to the host over the agent↔host channel; the host
ingests catalog rows + provenance (§4.1). Progress/logs stream over that same channel to the **job SSE**.
Crucially, **viewer streaming is UNCHANGED regardless of where compute ran** — a viewer reads Zarr chunks /
ranges from object storage (DATA_MODEL Tier 1/2), which is the same whether the job ran locally or on HPC.

**Per deployment:**
- **Desktop (1 user):** app + object-store(=local filesystem) + bwrap all on one box; "fetch/upload" = local
  file I/O; no network. Same model, degenerate.
- **Server (1 box):** app + MinIO + bwrap on the server; jobs run local, fetch from MinIO.
- **Server + worker pool (N boxes):** control-plane host + shared object store + worker agents; jobs dispatch
  across the pool; the class/pool/fair-share scheduler (§4.1.1) load-balances.
- **HPC:** control-plane host + object store + a SLURM backend; heavy pipelines/GPU run on cluster nodes under
  Apptainer, data via object-store fetch or the shared FS cache.

**Security across boxes:** a remote job gets a **short-lived, per-job scoped token** (the sidecar model, §6.5) —
it may fetch *this job's* inputs + upload *its* outputs, nothing else; a compromised worker can't read the
store. Sandbox isolation (bwrap/Apptainer) still applies on the worker.

**Extensions are untouched.** The manifest is location-agnostic (`run: {kind, backend?}` + `schedule: {class,
resources}`); the **path-agnostic `inputs.json` makes the script byte-identical everywhere**; content-addressed
code+inputs+outputs make a job **reproducible on any box** (a live8-verification re-run can run on any worker).
So "run the sandbox on HPC / another box" costs the *extension author* nothing.

**Net:** compute is a backend behind one seam; the data plane is **fetch-content-addressed-inputs-from-object-
storage → run in an isolated sandbox anywhere → upload-content-addressed-outputs**; results reach viewers by
reading object storage regardless of where they were produced. Desktop = all-local; server = local or a worker
pool; HPC/cloud = a batch backend + Apptainer — **all the same control/data-plane split, no per-topology
rewrite and no extension change.**

### 4.2 Contributing VISUALIZATIONS — the view-kind model (grounded in `feat/visualization`)
A separate workstream (live3, branch `feat/visualization`) already built a **generic, GPU-first plotting
LIBRARY** this platform's `plotTypes` point will be built *on*. **Honest status (verified in the code):** it is
**library-extensible, not yet platform-extensible** — a grid cell dispatches via a **`switch(cell.kind)`
EXHAUSTIVE over a closed `CellKind` union** (no runtime view-kind registry; the `registry.ts` is a showcase
story catalog). Adding a kind today = editing the union + a `case`, in-tree. **Making it a real contribution
point is a bounded refactor: replace the switch with an open `registerViewKind({id, dataContract, render,
conformance})` registry.** Everything below describes that target; the library it plugs into is: It is **deck.gl-only, no SVG, GPU shaders for all
ops** (its FB-1/FB-2 — a hard constraint), extracted as a **generic viz package** (its FB-3), with:
- a **grid workspace** doing **per-cell "view-kind" dispatch** (heterogeneous, freely resizable, drag-swap,
  pop-out/pop-in) — this IS the small-multiples + linked-brushing canvas (its FB-4/FB-5/FB-9);
- a set of **view-kinds** (scatter · heatmap · box/violin · dot-plot · graph · timeline · spatial · density
  · table), each a set of **deck.gl layers** via a shared `ChartFrame`/`chartLayers` primitive;
- a **`Coordination` store** = shared color-scale / selection / zoom across cells (brushing-and-linking);
- O(1) GPU-pick tooltips, a11y chart-table model, vector (SVG/PDF) **export** as the one allowed SVG surface;
- **a property-based CONFORMANCE BATTERY** (`viz-core/conformance/invariants.ts` + `viewKindBattery.test.ts`):
  pure structural invariants every view-kind must satisfy (finite/ordered ranges, matrix `values.length ==
  rows×cols`, facet partitions never drop/double-count a point, monotone axis ticks, ordered box quartiles,
  color/selection buffer length == N).

**So "contribute a plot" = contribute a VIEW-KIND to that framework.** Concretely, a view-kind contribution:
1. **Declares its data contract** — what it consumes from the platform data kinds (`coordinates` N×2 · a
   `values` column · a `matrix` rows×cols · `groups`), mapped to the §5 data API.
2. **Renders** via deck.gl layers through `ChartFrame`/`chartLayers` (never SVG/Vega — that conflicts with the
   framework's no-SVG law; the built-in view-kinds already cover the common statistical plots as GPU layers).
3. **Conforms to the invariants battery** — this is the **acceptance gate for a contributed plot**: the host
   runs the property-based battery against the contribution's outputs, so a third-party plot that leaks NaN,
   misaligns a buffer, or drops facet points is *rejected automatically*. (A huge asset for an open ecosystem
   — plots are validated structurally without human review of every one.)
4. **Registers** into the view-kind registry; it then gets grid placement, pop-out, linked selection, tooltip,
   and export **for free** from the framework.

**Correction to §4's "declarative view" flavor (from studying the real code):** because the viz framework is
**deck.gl-only (no SVG/Vega)**, the safe third-party tier is NOT a Vega-Lite spec. It is one of:
- **(a) Parameterize an existing GPU view-kind** — a declarative config selecting a built-in view-kind +
  channel bindings (x/y/color/group/facet) + a colormap. Safe (data, not code); covers most needs since the
  built-ins already span scatter/heatmap/violin/box/dot/graph/spatial/density/table.
- **(b) A new deck.gl-layer view-kind** — code, conformance-gated (the battery), reviewed/first-party or
  sandboxed-iframe for untrusted. For genuinely novel marks.
So the two tiers become **parameterize-a-view-kind (declarative, safe)** and **new-view-kind (code,
battery-gated)** — not Vega vs iframe.

**Platform composition:** the analysis platform and the viz framework compose through **one manifest** — an
extension can contribute an `analysis` (sandboxed compute → typed result) AND the `view-kind`(s) that render
its result. Example: a "Monocle Trajectory" extension ships `{ analyses:[trajectory.monocle],
viewKinds:[trajectory-graph] }`; the analysis runs in the sandbox, writes a `trajectory` artifact, and the
`trajectory-graph` view-kind (deck.gl, conformance-passing) draws it in a grid cell — end-to-end, zero shell
code. The workbench **hosts** the viz package as its center canvas; `plotTypes` in this doc == the viz
package's **view-kind registry**; linked small-multiples == its grid + Coordination store.

**Reconciliation TODO (both branches are unmerged):** `feat/visualization` is generic + standalone; this
analysis workbench must adopt it as the center-canvas engine and expose its view-kind registry as the
platform `plotTypes` contribution point. Its **conformance battery** should be published as part of
`@txresbench/workbench-api` so third-party view-kinds are validated by the same gate the built-ins pass.

---

## 4.3 How an extension contributes an analysis's INTERFACE (form) — grounded in the legacy forms

Two SEPARATE things, don't conflate: the **compute** (what runs) is *always* a sandboxed script (Python/R);
the **form** (how you configure it) is **declarative-first with a code escape hatch.** Grounded in the legacy
TxResBench forms (param inventory across all `New*Form.tsx`: **71 Select · 23 InputNumber · 12 Input · 8
Switch · 3 TreeSelect** → ~90% simple typed fields), four tiers cover every situation observed:

**Tier 1 — Declarative params form (JSON-schema; the ~90%).** Scalar params render from a schema (host-rendered,
RJSF-style): number→slider/input (min/max/step), enum→Select, string→Input, boolean→Switch, array. This is
`resolution`, `method`, `n_neighbors`, `name`, etc. — the 71 Selects + 23 InputNumbers. No code.

**Tier 2 — `artifact-ref` inputs → auto-populated pickers (THE key case, still declarative).** This is exactly
your "clustering needs an embedding → a select box of the study's embeddings." The extension **declares** the
input:
```yaml
params:
  - { id: embedding, type: artifact-ref, accepts: embedding, multiple: true, required: true }  # → Select of the study's embeddings
  - { id: resolution, type: number, min: 0.1, max: 2, step: 0.1, default: 0.6 }
  - { id: method, type: enum, options: [louvain, leiden] }
```
The host renders `embedding` as a **Select populated from the study's artifacts of the compatible type**
(catalog query + subtype match). The extension writes **no select-box code and no catalog query** — it declares
`accepts: embedding`, the host binds it to the artifact graph. And this **unifies with the compatibility model
(DATA_MODEL)**: an analysis's `accepts` ARE its artifact-ref inputs, so **one declaration does two jobs** — it
gates availability *and* generates the picker. (This is precisely **Galaxy's** `<param type="data"
format="…">` — a dataset picker auto-filtered to compatible datatypes — the proven third-party model.) In the
legacy this was hand-coded (`useEmbeddings()` → `<Select>`); here it's declarative.

**Tier 3 — Host-provided rich domain widgets (declared, shared, not re-coded).** The genuinely compound inputs
the legacy hand-built — e.g. the DE **`group1`/`group2` cell-set builders** (filter by cluster + sample +
annotation with a **live cell-count preview**) — are provided by the platform as reusable widgets an extension
*references*:
```yaml
  - { id: group1, widget: cell-set-selector }   # host renders the compound builder + live preview, wired to the data API
  - { id: group2, widget: cell-set-selector }
```
Other shared widgets: `gene-selector`, `gene-set-picker`, `colormap-picker`, `threshold-on-histogram`. The
extension declares the widget; the host renders the rich, data-connected control. This handles the DE-group /
selection-builder case **without every extension re-coding it** (and selections resolve to provenance recipes,
§0.6).

**Tier 4 — Code form (the escape hatch, rare).** For a genuinely bespoke UI, the extension ships a **React
`ParamsForm` component** built against `@txresbench/workbench-api` — which exposes `api.artifacts.query({type})`, the
current `api.selection`, the study context. This is the VS Code *webview* escape hatch: declarative by default,
code only when a form truly can't be expressed as schema + widgets. (Untrusted third-party code forms run in a
sandboxed iframe, §6; first-party/reviewed run in-tree.)

**Dependent/dynamic fields** (the legacy `nCluster_{embeddingId}` per-selected-embedding case; method-dependent
fields): the schema covers common cases declaratively — `when`/`if-then` conditional visibility, `repeat-per`
(a sub-form per selected artifact-ref), computed/templated defaults (`name: "Cluster {embedding}"`). Beyond
that → Tier 4.

**So the answer:** the interface is a **declarative schema** (Tier 1) where **artifact-ref fields become
auto-populated, type-filtered pickers** (Tier 2, the "clustering needs an embedding" case — declared via
`accepts`, unified with gating), **rich compound inputs use host-provided shared widgets** (Tier 3), and a
**React code-form is the escape hatch** (Tier 4). The **compute is always a separate sandboxed script.** ~90%
of analyses are pure declarative (schema + refs); only the compound-selection and truly-bespoke forms reach for
widgets/code.

## 4.4 Interactive tools — code, NOT declarative (and what they code AGAINST)

Honest correction: **declarative is for configure-and-run analyses; interactive tools are code.** An analysis
like clustering is "fill a form, run" → declarative (§4.3). But **annotation** ("lasso cells on the embedding →
type a label → Assign → repeat, with history"), **gating**, **manual curation**, **trajectory-by-clicking**
are *interactive tools* — a stateful loop coupled to the visualization. No schema expresses that. So the
question isn't declarative-vs-code; it's: **when a module writes interactive code, what does it write against,
so that N interactive modules don't each reinvent the canvas and fragment the selection?**

**The linchpin: the visualization + its interaction state are SHARED workbench primitives, not per-module.** A
module does NOT own a plot to "get cells from it." The canvas (pan/zoom/lasso/box/brush/click) is
workbench-owned and produces **shared, first-class interaction state**:
- **`api.selection`** — the current **cell-set** the user lassoed (read + write + `onChange`); a first-class
  object stored as a provenance recipe (§0.6), so *any* module (annotation, DE, subcluster) consumes the SAME
  selection.
- **`api.brush`** — a brushed range on an axis/histogram (e.g. a QC threshold, a gate bound).
- **`api.pick`** — the clicked/hovered cell/point (e.g. trajectory start/end).

An interactive module is therefore **thin code over shared primitives + contributions**, three parts:
1. **Reads shared interaction state** — `api.selection.useCurrent()` gives it the cells the user selected on
   the shared canvas. "Get the cell set from visualization" = this. "Range from visualization" = `api.brush`.
2. **Contributes overlays/views to the shared canvas** — a highlight of selected cells, gate polygons, a
   trajectory path, cell labels. These are **view/overlay contributions** (the view-kind registry, §4.2), so
   they render *on the shared embedding* and link with everything else.
3. **Ships a code panel for its stateful loop** — a React panel (`ViewContribution` with a `component`, built
   against `@txresbench/workbench-api`) for the controls + state, and writes results via the data API
   (`api.data.writeAnnotation`, `writeResult`).

**Worked example — the annotation module** (your case):
```yaml
contributes:
  views:            [ { area: bottom, title: Annotation, component: ui/AnnotationPanel } ]   # code panel
  overlays:         [ { id: annotation-highlight, consumes: annotation, render: ui/HighlightOverlay } ]
  selectionActions: [ { id: assign, title: "Assign annotation", when: "has-selection", command: annotate.assign } ]
```
```tsx
// AnnotationPanel.tsx — thin code over the workbench API
function AnnotationPanel() {
  const sel = api.selection.useCurrent()           // the cell-set the user lassoed on the SHARED canvas
  const [label, setLabel] = useState('')
  return <>
    <div>{sel.size} cells selected</div>
    <Input value={label} onChange={setLabel}/>
    <Button onClick={() => api.data.writeAnnotation(label, sel)}>Assign</Button>   {/* → annotation artifact + provenance */}
    <HistoryTable/>
  </>
}
```
It writes ~30 lines of UI, owns **no** canvas, and its selection IS the shared cell-set — so the same selection
also drives DE, subclustering, etc., and the whole loop is provenance-tracked (selection = recipe, assign = run
node). If a module wants its *own* plot (a violin in its panel), it **contributes a view-kind** rendered in its
panel — but any **cell selection** that produces a shared cell-set goes through the shared canvas + `api.selection`,
or you get N incompatible selection models and lose brushing-and-linking + provenance.

**So the two contribution kinds:**
| | Configure-and-run analysis | Interactive tool |
|---|---|---|
| Examples | clustering, DE, normalize, embedding | annotation, gating, curation, trajectory-click |
| Interface | **declarative** form (params + artifact-ref pickers, §4.3) | **code panel** (React) |
| Viz coupling | none (writes a result artifact) | reads `api.selection`/`brush`/`pick`; contributes overlays/view-kinds |
| Compute | sandboxed script | may be pure-client (annotation) OR a sandboxed step (subcluster) |

**Why declarative still matters:** it's not "everything is declarative" — it's that the **~90% configure-and-run
analyses ARE declarative** (schema + typed pickers, no code), which is a huge win for third-party contribution;
the interactive minority write code, but **thin code against shared canvas/selection/overlay primitives**, not
a from-scratch plotting app. The mistake would be forcing interactive tools into declarative (impossible) OR
letting every module own its own canvas (fragments selection, kills linking + provenance). The platform's job
is to make the shared interaction primitives rich enough that an interactive tool is 30 lines, not 3000.

## 4.5 Panels / slots — structured contribution, NOT free-form injection

Yes, the docks are **slots** and a module contributes **views** into them (the `views` contribution point) —
that's the mechanism. But "each analysis injects whatever it wants" is the failure mode that turns an
extensible workbench into a junk drawer of mismatched panels. Three constraints keep it coherent while staying
extensible:

**1. Most panels are host-RENDERED from declarations, not injected.** A configure-and-run analysis doesn't
build a panel — it declares **params** (schema → host renders the form, §4.3) and a **result-kind** (→ the host
renders the standard result panel from the result-renderer registry: a DE-table panel, a stat card, a
provenance view). So a DE analysis and a third-party DE variant render in the **same** DE-table panel; two
clustering methods share the same form styling. **Only interactive tools inject a code panel** (annotation,
gating, §4.4). Net: ~90% of panels are host-standard and consistent; injection is the minority.

**2. The chrome is host-owned; the module fills a content slot — built from the shared kit.** The dock, the
tab, the header/collapse/resize, the IA layout (`WORKBENCH_IA`) are **workbench-owned**. A module contributes
*content* into a host-provided frame, and code panels are built from `@txresbench/kit` (the design system) — so a
contributed panel looks native, not like a foreign widget. The module never draws a dock or a tab; it adds a
tab/section the host places and styles.

**3. Placement is SEMANTIC, not "anywhere."** The regions have meaning (left = navigate/fields · right =
inspect/selection · bottom = results · center = the shared canvas). A contribution targets the *meaningful*
region, and the natural homes are typed: a **field-provider** lands left, a **result-kind** lands bottom, a
**selection-inspector** lands right, a **view-kind/overlay** lands on the canvas. You can't drop a results
table into the left nav. The host composes multiple contributions to one dock (tabs / order / collapse) — the
module owns a tab, **not the whole dock**.

So the model is **structured slots with a rendering contract + semantic placement**, defaulting to
host-rendered declarative panels, with **kit-built code panels as the escape hatch for interactive tools.** It's
the balance between VS Code's flexibility (slots; extensions contribute views) and coherence (host-rendered
defaults + a design system + placement semantics). The dividing line: **declare → the host renders a standard
panel; inject → only for interactive tools, from the kit, into a semantic slot the host composes.** Not "any
panel, anywhere, any style."

---

## 5. The data contract (the platform "DOM")

Extensions never share code or reach into internals; they share **typed data**. The model is the working
store from `DATA_STORAGE_REDESIGN`:
- **Kinds:** `expression | embedding | clustering | annotation | de | enrichment | trajectory |
  metadata-column`. Each has a small fixed versioned layout.
- **Canonical axes:** a study-unique `system_cell_id` axis (dense view-index on the hot path) + `gene_id`
  axis, so any extension's output aligns to any other's by construction (NA outside covered cells).
- **Access:** the `data.*` API (§2) reads kinds as typed arrays (zero-copy to WebGL) and the sparse
  gene-column fast path; writes go through `writeResult(kind, …)` → catalog row + artifact.
- **Provenance:** every produced artifact carries `{params, versions, seed, covered_cells, extensionId}`.

A third-party trajectory tool `requires:[embedding, clustering]` → the host hands it the *existing* embedding
+ clustering artifacts (whoever produced them) → it writes a `trajectory` artifact → a `trajectory-graph`
plot-type (declared by the same or another extension) renders it. No extension-to-extension coupling.

---

## 5.5 The database in the extension model — three layers (most data isn't in it)

"Where does an extension's data live?" has a non-obvious answer for single-cell: **the primary data is not in
Postgres.** Putting a 10⁶-cell × 10⁴-gene matrix in a relational DB is a non-starter. So "database" splits
into three layers with different owners + rules:

### A. Working store — HDF5 artifacts (the actual data; NOT SQL)
Expression matrices, embeddings, clusterings, DE tables — the bulk of every extension's output — are
**kind-typed HDF5 artifacts + Parquet** in the working store (`DATA_STORAGE_REDESIGN`), on the filesystem /
object storage, **not in Postgres**. An extension's sandboxed compute writes `.h5`/`.parquet` to `/outputs`;
the host ingests them. Extensions **never write SQL for this** — they produce typed artifacts. This is where
99% of the data volume lives, and it needs zero DB extensibility.

### B. The catalog — Postgres, host-owned (the index, not the data)
Postgres holds the **catalog**: one small row per analysis/artifact (`{study_id, analysis_id, kind, shape,
params, provenance, job_file, covered_cells, created_at}`) + samples, obs/var column registry, cell registry.
It's the index that answers "what analyses exist, of what kind, pointing at which artifact" without opening a
file. **Extensions don't own catalog tables** — when their compute `produces` a result, the **host writes the
catalog row** (via `writeResult(kind, …)`). So an extension contributes catalog rows *implicitly*, through
the data API, with no schema of its own.

### C. Declarative extension collections — for the rare structured/mutable relational need
Sometimes an extension genuinely needs its own **queryable, mutable, relational** data that isn't a
per-analysis artifact — a **gene-set / pathway library**, an **annotation history/audit**, a **saved-gate
collection**, a **reference-panel registry**. That's the only case that touches "extension owns database
state," and it's **declarative**:
```yaml
contributes:
  collections:
    - id: pathway_sets
      schema: ./pathway_sets.schema.json     # JSON-schema → validates every write
      scope: study                            # rows auto-scoped by study_id (or user/global)
      indexes: [name, source]                 # host builds indexes
      gate: pathways::use                     # permission for the generated endpoints
```
The host provisions storage, a generated **typed CRUD + a constrained query API** (filter/sort/paginate — a
DSL, **not raw SQL**), JSON-schema validation on write, rows namespaced by `(extension_id, <scope-key>)`, and
teardown on uninstall. The extension calls `api.store.collection('pathway_sets').query({…})` — never SQL.

**The hard boundary (compiled Rust + sqlx):** the kernel's own tables use **sqlx compile-time-checked
queries** (schema known at build → fast, verified). Extension collections are **provisioned at runtime**, so
they **cannot** use sqlx macros. They live behind a **generic runtime store**: either a table-per-collection
created by host DDL from the schema, or a shared `ext_records(extension_id, collection, scope_key, doc JSONB,
…)` table with GIN indexes on declared JSON paths. Either way the host reaches them through a generic
parameterized query layer (validated by the JSON-schema + the scope filter), never `query!`. So the DB has
two disciplines: **compile-time-checked SQL for the kernel, a generic validated runtime collection store for
extensions.** That split is the price of runtime-provisioned, no-Rust extension tables — and it's safe (no
raw SQL from extensions → no injection surface; the query API is a bounded DSL).

### Where the 3 example modules' data actually lands
| Module | Layer A (artifacts) | Layer B (catalog, host-written) | Layer C (own collection) |
|---|---|---|---|
| data-io | `expression.h5`, obs columns, `qc-report` | sample + expression + qc rows | — (just a `settings` row) |
| embedding | `embedding.h5` (obsm) | embedding row | — |
| clustering | `clustering.h5` (obs categorical) | clustering row | — |
**None of the three need Layer C at all** — their data is artifacts (A) + host-written catalog rows (B). A
*gene-set / pathway* module would be the first to declare a collection (C). So for the common analysis module,
"database extensibility" reduces to **produce typed artifacts; the host catalogs them** — no tables, no SQL,
no migrations authored by the extension.

### Migrations, versioning, teardown
- **Kernel schema** (catalog, samples, settings, sync): normal per-module sqlx migrations, host-owned.
- **Extension collection schema** (Layer C): versioned in the manifest; the host applies **additive**
  migrations (new column/index) automatically; a destructive change needs a declared migration step or a
  compute job. Additive-only by default (safe, reversible).
- **Uninstall / study-delete cascade:** dropping an extension (or deleting a study) drops its **collections +
  its catalog rows + its artifacts** — the `on_study_deleted` hook generalized over all three layers.

---

## 6. Isolation & trust model

| Risk surface | Mitigation |
|---|---|
| Third-party **compute** code | runs in **bwrap** (`--clearenv`, no DB/JWT/API keys, per-conversation workspace, wall-clock + memory + pid caps). Already built + hardened. |
| Third-party **declarative views** | data-driven specs (Vega-Lite / JSON-schema); the host renders them — no arbitrary host JS. Spec validated against a schema; expression sandboxing per Vega's config. |
| Third-party **code views** | sandboxed **iframe** (CSP, no host DOM/token access); talks to the API only via a `postMessage` bridge with a capability-scoped surface. (Later phase.) |
| **Data access scope** | the API is study/selection-scoped + permission-gated; an extension can't read outside the current study/user. |
| **Manifest indexing** | parsed, never executed; activation is explicit + lazy. |
| **API compatibility** | semver; the host refuses an extension whose `apiVersion` range excludes the host version. |

Net: the contribution people most want to make (a new **analysis**) is also the safest, because the sandbox
already isolates it — we are not inventing a trust boundary, we're reusing the one that ships.

---

## 6.5 Backend extensibility — can an extension add server code?

**The honest gap:** §1–§4 give an extension a *frontend* (view-kinds/panels/commands) and *sandboxed compute*
(a script that runs server-side and writes typed result artifacts). That covers most **analysis** extensions.
It does **not** let an extension add arbitrary **backend**: a new REST endpoint, persistent tables, a
long-running service, webhooks, custom auth-gated server logic.

**The hard constraint that shapes every option:** the server is **compiled Rust**. There is no safe way to
load third-party Rust into the running server process (no stable plugin ABI; adding a route means
recompiling). So "third-party backend" is fundamentally **out-of-process, declarative, or WASM** — never
"drop a .rs and it registers a route." This is different from Jupyter (loads Python server-extensions
in-process, full trust) or Postgres (loads C, full trust). We trade that for memory-safety + isolation.

Four tiers, by trust ⇄ power (the first two are the realistic third-party paths):

| Tier | What the extension ships | Trust | Isolation | Grounded in |
|---|---|---|---|---|
| **A. Declarative backend (no code)** | a manifest declaring **storage schema / scheduled job / settings / result-kind** | low | none needed | per-module migrations · jobs · settings pattern |
| **B. Out-of-process backend service (sidecar)** | a containerized service (any language); the host **reverse-proxies** to it | med | separate process, `env_clear`, resource caps, no DB, scoped callback token | **`bio_mcp`** (exactly this) · sandbox |
| **C. Built-in MCP server / tool** | an MCP server exposing tools the app/model calls | med | process boundary + JWT | the app's native extension protocol (memory/files/web_search/… are all this) |
| **D. First-party compiled module (Rust)** | an in-tree module (routes + colocated migrations + perms) | full (reviewed) | in-process | how `study`/`dataset`/`jobs`/`sandbox` are built today |
| *(future)* **E. WASM in-process plugin** | capability-scoped WASM + host-function API | low | WASM sandbox | not built (big lift; wasmtime/component-model) |

### A — Declarative backend (the highest-value, safest tier)
Most "backend" an analysis extension actually needs is *persist some data + serve it*, which is declarative:
```yaml
contributes:
  storage:                                   # → host provisions a table + CRUD REST + sync + a permission gate
    - { id: pathway_sets, schema: ./pathway_sets.schema.json, scope: study, gate: "pathways::use" }
  jobs:                                       # → host schedules it (runs in the sandbox), no server code
    - { id: refresh-pathways, cron: "0 3 * * *", run: { kind: sandbox, entry: refresh.py } }
  settings:                                   # → host renders an admin card + GET/PUT gated endpoint
    - { id: pathway_source, schema: ./settings.schema.json }
  resultKinds:                                # → host catalogs + typed-binary-streams a new artifact kind
    - { id: pathway-activity, layout: ./layout.json }
```
The host generates the tables (a migration), the typed CRUD endpoints, the sync entity, the admin settings
card, and the retention/prune loop — **from the schema, no arbitrary server code**. This is the
Directus/Supabase/Hasura "declare a schema → get an API" model, using the app's existing migration + jobs +
settings + sync machinery. It covers a large fraction of backend needs safely.

### B — Out-of-process sidecar (the model the app ALREADY uses)
For genuine custom server logic, the extension ships a **service** and the host proxies to it — which is
**exactly how `bio_mcp` works today**: a built-in `mcp_servers` row whose `url` is a host-owned route
(`/api/bio/mcp`); the host holds the **JWT/permission boundary**, `env_clear`s + injects configured keys, and
**reverse-proxies** the body to a lazily-spawned, idle-reaped, `PR_SET_PDEATHSIG` sidecar. Generalize that to
extensions:
- host registers `POST/GET /api/ext/<extId>/*` → reverse-proxies to the extension's sidecar (spawned like
  biomcp, or a declared container), gated by the extension's declared permission;
- the sidecar gets **no DB, no secrets** (`env_clear`), only a **short-lived scoped token** to call back into
  the host's **data API** (§5, exposed as an authenticated HTTP/MCP surface: read embeddings/genes/obs, write
  results) — so it can do real work on study data without direct access;
- isolation posture == biomcp + sandbox (separate process, resource-capped, torn down with the server).

So the extension can implement any server logic in any language, but it runs **beside** the server, not
inside it, and reaches data only through the scoped API — third-party backend with the trust boundary intact.

### C — MCP server (the native protocol)
The app's actual extension mechanism for *capabilities* is **MCP**: built-in servers (memory, files,
code_sandbox, web_search, lit_search, citations, knowledge_base…) and user-configured external ones. A
third-party backend capability delivered as an MCP server is first-class today — the model/app calls its
tools, gated by a permission, proxied through the JWT boundary. For "add a backend capability the analysis
agent can use," this is the shipping path.

### D — First-party compiled module
Full-power backend (new routes + tables + services) stays a **compiled Rust module** — reviewed, in-tree,
the way every current backend feature is built. Not third-party, but the escape hatch for anything the
declarative/sidecar tiers can't express.

**Net:** an extension **can** do backend — but through **declarative schema/jobs/settings** (host provisions
it, no code) or an **out-of-process sidecar / MCP server** the host proxies to with a scoped data-API
callback (the bio_mcp model, isolation intact) — not by injecting code into the Rust server. In-process
third-party backend is deliberately **not** offered (memory-safety + isolation over convenience); WASM is the
only future path to in-process third-party backend, and it's a large, separate effort.

**Composition:** one manifest can now contribute an `analysis` (sandboxed compute) + `viewKinds` (deck.gl) +
`storage`/`jobs`/`settings` (declarative backend) + a `sidecar` (custom server) — a complete vertical
feature, all through the versioned API, with the server never loading untrusted code.

---

## 7. Discovery, packaging, versioning, activation

- **Built-in (now):** modules auto-discovered at build via the existing `import.meta.glob` seam; each is an
  extension using the public API. No loader work.
- **External declarative (next):** an extension = a directory/package (`extension.yaml` + schema/spec/script
  assets). Discovered from a per-deployment extensions dir (or the hub). Manifest validated; contributions
  indexed; compute assets staged for the sandbox.
- **External code + marketplace (later):** a signed, versioned package resolved from a registry (the
  `tinnlab/hub` pattern already used for models/rootfs is the natural home) with install / enable-disable /
  update / compatibility-range resolution + activation events.

---

## 8. Grounding in the existing codebase (this is a promotion, not a rewrite)

| Platform piece | Already exists as |
|---|---|
| Isolation for third-party compute | `modules/sandbox` (`run_analysis` + `ExtraMount`, bwrap hardening) |
| Job queue / progress | `modules/jobs` (FCFS + `JobRunner` + SSE) |
| Data contract | `docs/DATA_STORAGE_REDESIGN.md` (kind-typed artifacts + Postgres catalog + typed-binary streaming) |
| Contribution/discovery seam | `STUDY_EXTENSIONS` + FE `STUDY_SLOTS` + `import.meta.glob` |
| Analysis descriptor | the `analysisRegistry` (interface round) — generalizes to `AnalysisContribution` |
| Package registry (future marketplace) | `tinnlab/hub` (models/rootfs already flow through it) |
| Binary/typed streaming to views | SDK gap **FE-10** (design-only) — the viz data plane |

The work is: **extract `@txresbench/workbench-api` as a published, versioned package; make the docks/canvas/left-rail
render from its registries; rebuild our own analyses on it; then add the manifest loader (compute → views).**

---

## 8.5 Worked example — 3 modules as no-backend-code extensions + the app structure

Target: **(1) data upload+process+save · (2) embedding+visualize · (3) clustering**, each an extension with
**zero Rust**, generalizing to N modules. This forces a **microkernel** shape: a small **fixed Rust host**
(the kernel) that changes for *no* module, and a bus of contribution points every feature plugs into
(VS Code's model). "No backend code" is only possible if the kernel already provides the generic substrate,
so first — what MUST live in the host:

### The kernel (compiled Rust — fixed; identical whether there are 3 modules or 30)
- **Identity + study + permissions + sync** (exists: auth/study/user modules).
- **File store** — raw upload/blob (`txresbench-file`).
- **Jobs queue** + **sandbox** — the compute executor (exists: jobs/sandbox modules).
- **Working store** — the kind-typed HDF5 artifacts + Postgres catalog (`DATA_STORAGE_REDESIGN`) + the
  **typed-binary data API** (read a kind → typed array; write a result). *This is the data contract impl.*
- **Extension host** — one generic module that: scans manifests, validates `apiVersion`, and runs the
  **declarative provisioners** (schema→table+CRUD+sync+gate · job→scheduler · settings→admin card ·
  result-kind→catalog+stream) + the **sidecar gateway** (`/api/ext/<id>/*`, §6.5-B).
- **Workbench shell (frontend)** — docks, the **viz framework as the canvas host** (`feat/visualization`
  view-kind registry), the contribution registries, and the `@txresbench/workbench-api` runtime.

Everything else — data-process, embedding, clustering, DE, trajectory… — is an **extension**. None add Rust.

### Directory structure
```
src-app/
  server/  (RUST HOST — fixed kernel, no per-analysis module)
    src/modules/{auth,study,user,file,jobs,sandbox,sync}/   ← existing kernel
    src/modules/workstore/    ← kind-typed artifacts + catalog + data-API + streaming
    src/modules/extensions/   ← manifest loader + declarative provisioners + sidecar gateway
  ui/      (FRONTEND HOST — the shell)
    src/core/workbench/       ← docks · canvas(viz view-kind host) · registries · workbench-api runtime
  packages/
    workbench-api/            ← @txresbench/workbench-api (versioned; extensions build against this ONLY)

extensions/                   ← THE MODULES — no Rust, self-contained, drop-in
  data-io/
    extension.yaml
    compute/  process.py  save.py            # run in the sandbox
    schema/   process.params.json  qc.settings.json
    ui/       UploadPanel.tsx  QcReviewPanel.tsx   # built against @txresbench/workbench-api
  embedding/
    extension.yaml
    compute/  umap.py  pca.py
    schema/   umap.params.json
    ui/       EmbeddingFields.tsx            # field-provider registration
  clustering/
    extension.yaml
    compute/  leiden.py
    schema/   leiden.params.json
    ui/       ClusterFields.tsx
```
Built-ins are discovered at build (glob for `ui/`, staged compute for the sandbox); external ones from an
extensions dir / the hub — **same manifest model**. The kernel code is byte-identical regardless of which/how
many extensions exist.

### The 3 modules → contributions (all declarative + compute + frontend; zero Rust)
| Module | analyses (sandbox compute) | requires → produces | view/UI | declarative backend |
|---|---|---|---|---|
| **1 · data-io** | `data.process` (QC+normalize), `save.sample` | uploaded-file → `expression`, `metadata-column`, `qc-report` | Upload panel, QC-review panel | `settings: qc-defaults` (host renders admin card); upload uses the host **file store** |
| **2 · embedding** | `embedding.umap`, `embedding.pca` | `expression` → `embedding` | `fieldProvider: embeddings` (selectable in left rail); uses the built-in **scatter** view-kind | — |
| **3 · clustering** | `clustering.leiden`, `clustering.louvain` | `embedding` → `clustering` | `fieldProvider: clusterings` (color-by); `selectionAction: subcluster` | — |

`save` is not code — the compute writes typed artifacts to `/outputs`; the **host ingests them** into the
working store + catalog. "Persist/serve" is the kernel's job, so the modules need no storage code (module 1
adds only a settings row, declaratively).

### One manifest, concretely (module 1)
```yaml
id: txr.data-io
apiVersion: "^1.0"
activation: [ onView:samples, onAnalysis:data.process ]
contributes:
  analyses:
    - id: data.process
      category: qc
      requires: [uploaded-matrix]           # a host file-store handle
      produces: [expression, metadata-column, qc-report]
      params: ./schema/process.params.json  # host renders the form
      run: { kind: sandbox, runtime: python, entry: compute/process.py }
    - id: save.sample
      requires: [expression]; produces: [sample]
      run: { kind: sandbox, runtime: python, entry: compute/save.py }
  views:
    - { id: samples, area: left, title: Samples, component: ui/UploadPanel }
    - { id: qc-review, area: bottom, title: QC, when: "has:qc-report", component: ui/QcReviewPanel }
  settings:
    - { id: qc-defaults, schema: ./schema/qc.settings.json }   # → host admin card + GET/PUT, no code
```
`compute/process.py` reads `/inputs/matrix.*` + `/inputs/params.json`, writes `/outputs/expression.h5` + obs
columns + `/outputs/qc-report.*` + a `manifest.json`. The host sandboxes it, ingests outputs, catalogs them.

### How they compose without referencing each other (the whole point)
Modules never import each other; they compose purely through the **data contract**:
```
data-io: data.process  ─produces→ expression ─┐
embedding: embedding.umap  requires expression ─produces→ embedding ─┐
clustering: clustering.leiden  requires embedding ─produces→ clustering ─┐
canvas: built-in scatter view-kind  renders embedding, colored by clustering | metadata | gene
```
The kernel builds the **DAG from `requires`/`produces`**, computes availability (clustering's UI is gated
until an `embedding` exists), and orders the "standard analysis" recipe — all without any module knowing
another exists. Add **module 4 (DE)** = drop `extensions/de/` with `requires:[clustering] → produces:[de]` +
a `de-table` view-kind; it lights up, gated, in the same shell. **The kernel does not change.** That is the
generalization: features are data-typed extensions on a fixed microkernel, wired by the artifact graph, not
by code coupling.

---

## 9. Phased rollout (each phase usable on its own)

1. **API extraction + dogfood.** Publish `@txresbench/workbench-api` (contribution registries + `data`/`selection`/
   `compute`/`commands`/`ui`). Rebuild the workbench shell to render from registries and the built-in
   analyses/views to consume the API. *Deliverable: the workbench, now registry-driven — internal
   modularity.* (This is the real work; everything else depends on it.)
2. **Sandboxed analysis manifests.** The manifest loader for `analyses` (params JSON-schema + sandbox
   command + output kinds), first-party at build, then external dir. *Deliverable: "other people contribute
   analyses."*
3. **Declarative views.** Vega-Lite plot-types + JSON-schema forms + table configs contributable by manifest.
   *Deliverable: third-party plots/panels without host code.*
4. **Code views + marketplace.** Sandboxed-iframe views + a hub-backed registry (discover/version/install/
   enable). *Deliverable: a true extension ecosystem.* Design the API toward this now; build it last.

---

## 10. Decisions to make (surface to the human before building phase 1)
- **API package boundary:** ship `@txresbench/workbench-api` as an app package now, or design it as a *future SDK*
  package (`@txresbench/…`) so other txresbench apps can host workbenches? (Affects namespacing + who owns it.)
- **Declarative view engine:** commit to **Vega-Lite** as the plot-spec language (mature, safe, huge
  vocabulary) vs a bespoke spec. Recommendation: Vega-Lite for declarative, deck.gl for the built-in
  high-perf embedding canvas.
- **Params form engine:** **JSON-schema → form** (RJSF-style) as the params contract. Recommendation: yes —
  it's the manifest-declarable, safe path and matches the "typed field per input" rule.
- **Manifest format:** YAML vs JSON (VS Code uses JSON `package.json#contributes`; napari uses YAML). Minor.
- **Marketplace host:** `tinnlab/hub` vs a dedicated registry. Recommendation: reuse the hub pattern.

**One-line target:** *a versioned `@txresbench/workbench-api`; docks/canvas/rail render from its registries; analyses
= sandboxed manifest wrappers (Galaxy model, isolation already built); views = Vega-Lite/JSON-schema specs
(safe, declarative); data flows through the kind-typed store; marketplace via the hub — built in that order.*
