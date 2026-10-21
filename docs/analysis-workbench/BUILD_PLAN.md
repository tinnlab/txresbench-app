# Analysis Workbench Platform — Phased Build Plan

Sequences the whole platform across the four workstreams into one dependency-ordered plan. Companion to
`PLATFORM_ARCHITECTURE.md` (the *what*) + `WORKBENCH_IA.md` (the *layout*). Each phase is independently
valuable and gated by the phase before it.

## End state (one line)
A **fixed Rust microkernel** (study substrate + working store + compute + extension host) exposing a
**versioned `@cyto/workbench-api`**; a **workbench shell** hosting **live3's deck.gl view-kinds**; and
**analysis features as no-Rust extensions** (sandboxed compute + declarative + frontend) that compose through
the **artifact graph**, which is *also* the **provenance graph** — all scoped/governed by the **study**.

## Current state & what this supersedes
| Workstream | Branch | State | Role in the plan |
|---|---|---|---|
| Study substrate | `feat/study-management` (live8) | built/merged | tenancy·access·sharing·lifecycle·sync — **the substrate** (§0.5). Land on main. |
| Provenance | `feat/provenance` (live8) | design done, paused | its **execution model** → woven into Phase 0; its **publish** layer → Phase 4. |
| Visualization | `feat/visualization` (live3) | built, standalone | the **canvas engine** — adopted in Phase 2 (view-kind registry == plotTypes). |
| Analysis workflow | `feat/analysis-workflow` (live5/this) | interface-round V2 mock, gated 8/9 | **superseded** by the workbench IA. The `.lifecycle` design docs are the spec; the mock components are throwaway relative to Phase 2/3. |
| Data processing | `research/data-processing` | research | feeds Phase 0c + Phase 3a (QC/process compute). |

## Deployment scope (near-term = **desktop + single-box server ONLY**)
The architecture is designed open (remote workers · HPC · cloud batch · S3 object storage · multi-backend), but
we **build only the local implementations behind those seams** now. Keep the seam, ship the simple case.

| Concern | BUILD NOW (desktop + 1-box) | SEAM stays open, DEFERRED |
|---|---|---|
| **Compute** (§4.1.2) | **local bwrap sandbox only**, behind the `ComputeBackend` trait | remote worker pool · HPC (SLURM/Apptainer) · cloud batch |
| **Object store** (DATA_MODEL) | **local filesystem**, content-addressed keys + Zarr/Parquet | MinIO/S3 (drop-in — same keys/ranges) |
| **Data plane** (§4.1.2, DATA_MODEL) | host serves **authed byte-ranges from local files**; client decode (zarrita/igv.js/DuckDB-WASM) | remote fetch/upload, per-job scoped tokens, shared-FS staging |
| **Job scheduling** (§4.1.1) | **one pool + interactive-vs-batch priority + simple per-user fair-share** (1-box multi-user) | multi-pool/backend routing (GPU/highmem/cluster), cross-node fairness |
| **Backend/resource classes** | just `cpu-sandbox` | `gpu` · `highmem` · `cluster-batch` |
| Everything else (registries, data model, provenance, viz, workbench, AI/MCP) | **build as designed** — they're topology-independent | — |

The point: **the seams (`ComputeBackend` trait, the object-store abstraction, content-addressed `inputs.json`,
resource classes) exist from day one, but only the LOCAL arm is implemented.** On 1-box, "fetch from object
store" = a local file read and "upload output" = a local write — the *same code paths* a remote backend will use,
just pointed at the filesystem. So adding a worker pool or HPC later is a new backend impl + swapping local-FS
for MinIO — **no rewrite, no extension change** (extensions are already location-agnostic). Don't build the
distributed parts now; don't close the seams either.

## THE CRITICAL PATH (build first — everything is blocked on it)
live8's `DEC-FOUNDATION`: provenance, this platform's catalog, the workbench, and the compute path **all**
depend on the same not-yet-built foundation — the **kind-typed working store + `analysis_results` catalog**
(`DATA_STORAGE_REDESIGN`, a proposal) and the **`JobRunner`→`sandbox::run_analysis`** integration (the runner
is a stub). No workstream lands until this exists. **Phase 0 is the whole unblock.**

---

## Phase 0 — Foundation (the shared substrate; critical path)
**0a · Working store + catalog.** Kind-typed HDF5 artifacts (`expression`/`embedding`/`clustering`/`de`/…) +
the `analysis_results` Postgres **catalog** (§B/§5.5) + the **data API** (read a kind → typed binary; write a
result → catalog row) + **typed-binary streaming** to the client (FE-10 thin client).
**0b · Compute path.** Wire **`JobRunner`→`sandbox::run_analysis`** (a streaming spawn variant); provision the
**scientific rootfs** (scanpy/anndata/leiden/harmony) into the rootfs Dockerfile; the `ExtraMount` input/output
plumbing.
**0c · Provenance capture (woven in, not bolted on).** Run each step as a **content-addressed code blob** +
**path-agnostic `inputs.json`** → sandbox → record a **run node + input/output edges** (live8 §B3). The
catalog's derivation edges *are* the provenance graph. Selections stored as **recipes** (predicate + input
hash).
→ **Deliverable:** an analysis runs in the sandbox, writes a typed artifact, lands in the catalog with a
provenance node + reproducible code blob. *Every later phase stands on this.*
Depends: nothing (kernel). Draws: `DATA_STORAGE_REDESIGN`, sandbox/jobs modules, `feat/provenance §B3`,
`research/data-processing`.

## Phase 1 — Contribution API + kernel (dogfood)
**1a.** Extract **`@cyto/workbench-api`**: the contribution registries (analyses · plotTypes · fieldProviders ·
views · commands · selectionActions · resultRenderers) + the data/selection/compute/commands APIs (§1–§2).
**1b.** Rebuild the built-in analyses to use ONLY the public API (the "dogfood the API" rule).
**1c.** The **extension host** with build-time discovery of built-in extensions (glob) — no external loader yet.
→ **Deliverable:** a versioned API; the workbench renders from registries; internal modularity proven.
Depends: Phase 0. Draws: the interface-round `analysisRegistry` (generalizes to `AnalysisContribution`).

## Phase 2 — Workbench shell + visualization
**2a.** The **shell**: the researched IA — center canvas + collapsible left(metadata/genes)/right(selection)/
bottom(results) docks + **collapse-to-stripe** + thin top toolbar (`WORKBENCH_IA.md`).
**2b.** **Adopt `feat/visualization`** as the canvas engine: its **view-kind registry == the `plotTypes`
contribution point**; publish its **conformance battery** in `@cyto/workbench-api` (so third-party view-kinds
pass the same gate); its grid + Coordination store == linked small-multiples.
**2c.** Wire **brushing-and-linking**: lasso → selection inspector (write-back annotation) → bottom results
tables; selection persists as a provenance recipe.
→ **Deliverable:** the **real** workbench (replaces the interface-round mock), hosting the viz framework,
driven by the API, quiet-dark data-forward.
Depends: Phase 1 + `feat/visualization` merge. Draws: `WORKBENCH_IA.md`, live3.

## Phase 3 — The three modules as no-Rust extensions
**3a · data-io** (upload+process+save): host file-store upload + sandboxed `data.process` (QC+normalize) +
`save.sample` → `expression`/`metadata`/`qc-report`; QC-review panel; `qc-defaults` settings.
**3b · embedding**: sandboxed `embedding.umap`/`pca` → `embedding`; `fieldProvider:embeddings`; built-in
scatter view-kind.
**3c · clustering**: sandboxed `clustering.leiden` → `clustering`; `fieldProvider:clusterings`;
`selectionAction:subcluster`.
→ **Deliverable:** end-to-end single-cell workflow on the platform — upload → QC → embed → cluster → explore —
each an extension, composed by the artifact graph, each run captured in provenance. **This is the product.**
Depends: Phase 2. Draws: interface-round analyses (become extensions), `research/data-processing`.

## Phase 4 — Reproducible export (provenance publish layer)
Turn the provenance graph into a runnable **reproduce-script** + templated **methods text** + **RO-Crate**
manifest + **env-pinning** + an optional **in-sandbox re-run verification badge** + optional Zenodo/DataCite
**DOI**.
→ **Deliverable:** "publish a reproducible manuscript" — the field-differentiating wedge.
Depends: Phase 0c graph + Phase 3. Draws: `feat/provenance` Candidate D (full scope).

## Phase 5 — Declarative + external extensibility (platform-ization)
**5a.** Declarative **provisioners**: storage **collections** (schema→table+CRUD+**query DSL**, §5.5-C),
**settings**, **jobs**, **result-kinds** — from manifest, no Rust.
**5b.** External **manifest loader** for **analyses** (sandboxed script + params JSON-schema + output kinds) →
**"other people contribute analyses."**
**5c.** **Declarative views** (parameterize an existing view-kind; safe, no code).
→ **Deliverable:** extensions authored outside the tree; third-party analyses + plots.
Depends: Phases 1–3.

## Phase 6 — Backend extensibility + marketplace (far future)
Sidecar **gateway** (`/api/ext/<id>/*` proxy + scoped data-API callback — the `bio_mcp` model, §6.5-B);
optional **WASM** in-process plugins; a **hub-backed marketplace** (discover/version/install/enable); the
generic **`EntityExtensionRegistry`** (SDK G8) — the same machinery over any tenancy entity.

---

## Branch convergence
- **`feat/study-management` → main** now (substrate under everything).
- **`feat/visualization`**: adopt as the viz package in Phase 2 (extract generic, wire as canvas).
- **`feat/provenance`**: its execution model → Phase 0c; its publish layer → Phase 4. (Pick its Candidate D.)
- **`feat/analysis-workflow`**: the `.lifecycle` docs (`PLATFORM_ARCHITECTURE`/`WORKBENCH_IA`/`BUILD_PLAN`) are
  the spec; the interface-round components are superseded by Phase 2/3. Don't ship the V2 mock as product.
- **`research/data-processing`**: feeds Phase 0c + 3a.
- **One owner for Phase 0** (the foundation is the shared dependency of all four — it can't be built four
  times). Recommend a dedicated foundation branch that provenance/viz/workbench all rebase onto.

## ⚠️ Re-sequencing (the plan above is a NORTH STAR, not a waterfall)
The phased plan front-loads the framework before there are features to generalize from — backwards. Verified
finding: **live3's viz is library-extensible, not platform-extensible** (a closed `switch(cell.kind)`, no
runtime view-kind registry). So the pragmatic near-term is bottom-up:
1. **Land the DONE branches** — `feat/visualization` (live3) + `feat/study-management` (live8) → main. Capture
   value; stop branch drift.
2. **Thin vertical slice, not the framework** — a minimal working store + ONE real analysis end-to-end
   (upload→embedding) on live3's canvas with real data. Prove the data path.
3. **Extract `@cyto/workbench-api` FROM 2–3 real modules** — including the bounded refactor of live3's
   `switch(cell.kind)` → a `registerViewKind` registry — rather than designing the API top-down. Defer
   platform-ization (external extensions, provisioners, marketplace) until there are internal extensions to
   generalize. *Extract the framework from features; don't design it upfront.*

## Do-this-first (the single unblock)
**Build Phase 0** (working store + catalog + data API + JobRunner→sandbox + scientific rootfs + provenance
capture) as one foundation effort. Until it exists, provenance, the workbench, and the modules are all blocked;
once it does, Phases 1–3 can proceed and Phase 4 (repro export) + Phase 5 (external extensions) unlock in turn.

## Honest risks
- **This is a re-architecture** (current Rust-per-feature modules → microkernel + no-Rust extensions). Real
  scope; sequence it, don't big-bang.
- **The interface-round V2 build is throwaway** relative to this direction — reset expectations.
- **Four workstreams share one foundation** — coordinate ownership of Phase 0 or they diverge.
- **sqlx compile-time vs runtime extension-store** boundary (Phase 5a) is the trickiest DB detail.
- **`DATA_STORAGE_REDESIGN` is a proposal, not built** — Phase 0 is also its first real implementation; expect
  discovery.
