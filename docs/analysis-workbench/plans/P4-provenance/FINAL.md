# P4 — Provenance & Reproducible Export (FINAL — consolidated r1∪r2∪r3)

## Reconciliation applied

Pinned cross-part audit decisions baked into this plan:
- **A1 — canonical `OutputsManifest` (P4 is a CONSUMER, P3 OWNS it).** The `/outputs/manifest.json`
  contract has ONE canonical shape owned by P3: `OutputsManifest { outputs: Vec<OutputEntry> }` with
  `OutputEntry { id: String, datatype: String, path: String, layout: String, role: String }`
  (serde-deserializable). P4's output-edge capture (ITEM-8, ITEM-16, DEC-MULTI-OUTPUT, Risks) now reads
  the manifest via the **P3-owned struct** and uses the field name **`id`** for the output slot; the
  set-valued output signature is `{(entry.id, content_hash)}`. The old P4 field name `output_slot` is
  retired in favor of the canonical `id` (kept only as a descriptive alias for the edge's slot label).
- **A7 — re-grounded vs merged main (tip `63520fb`).** Main ALREADY adopted `ziee-file` as a real server
  dependency with dataset multipart upload (P2/P10/P11 assume it exists). ITEM-5's "upload is a
  checksum-less stub → greenfield" grounding was true only on the stale analysis-workflow tree. P4 now
  treats the ziee-file content-addressed store + dataset upload path as **ALREADY EXISTING on main**;
  ITEM-5 only **adds the provenance fields** (sha256 checksum + uploader + accession/DOI) onto that
  already-wired upload path — it does NOT build the upload/multipart path.

---

Scope: **desktop + single-box server only.** The lineage backbone (run nodes · content-addressed code
blobs · path-agnostic `inputs.json` · used/generated edges) + selection-as-recipe + the reproduce/export/
verify/DOI publish layer. Provenance is captured as a **zero-effort byproduct of the compute contract**
(`inputs.json` in → `/outputs/*` + `produces` manifest out) at two chokepoints (compute + interaction),
never an explicit user checkpoint.

**live8 `feat/provenance` integration reality:** the branch is **DESIGN-ONLY** — verified `git diff` touches
only `.lifecycle/` (`DESIGN_CANDIDATES.md` §B1/§B2/§B3/§B3.1 + Part F DEC-GRAPH…DEC-OVERLAP). There is
**nothing to `git`-adopt.** What P4 **adopts** from live8: its EXECUTION/RECIPE MODEL verbatim as the spec —
run=PROV *Activity*, artifact=PROV *Entity* keyed by content-hash, `used`/`wasGeneratedBy` edges, three root
kinds + closure invariant, append-only re-run branching, ANALYSIS=provenance-unit / JOB=execution-unit,
one-code-path export = stored per-run blob, selection-as-recipe, backward-closure export scoping, Candidate-D
MVP-first phasing. What P4 **builds**: all the code (capture seam, code-blob store, recipe persistence,
export/verify/DOI/settings/panel).

---

## Ownership boundary (BAKED IN — resolves the P1↔P4 dispute; agreed by P1+P4 r3, DEC-OWN)

**The provenance GRAPH lives in P1's catalog derivation edges — P4 does NOT create
`provenance_runs`/`provenance_artifacts`/`provenance_edges`.** DATA_MODEL is explicit ("the catalog's
derivation edges ARE the provenance graph"; nodes = typed artifacts, edges = analyses, datasets = roots).
Availability-gating, recipe-ordering, and lineage/reproduce-export must all read ONE graph; a parallel
`provenance_*` triple is a two-sources-of-truth divergence. live8's original "provenance-owned triple" stance
was **explicitly contingent** on the catalog being not-yet-built — P1 now builds it, so that contingency is
gone. **Adopt live8's node/edge MODEL but REALIZE it in P1's catalog tables.**

- **P1 owns:** the run/artifact/edge schema (single source of truth) + the `WITH RECURSIVE` backward walk
  (read side) + content-hashing artifacts at catalog ingest.
- **P4 owns:** (1) the capture LOGIC — the `ProvenanceCapture` seam that *writes* run nodes + edges into P1's
  catalog at the JobRunner chokepoint (+ the interaction chokepoint); (2) `provenance_code_blobs`
  (content-addressed code store — graph *metadata*, not a data artifact); (3) `provenance_run_repro` sidecar
  (per-run reproducibility enrichment, so P4 evolves without altering P1's core run schema); (4) selection-
  as-recipe persistence; (5) everything downstream of the graph — reproduce-script, methods text, RO-Crate,
  bundle, verify certificate + `provenance_verifications`, DOI, `provenance_settings`, the Reproducibility
  panel.

---

## Items

- **ITEM-1**: **Graph read-facade over P1's catalog** (adopt-not-duplicate; DEC-OWN). Typed views
  (`RunNode`, `ArtifactNode{content_hash}`, `used`/`wasGeneratedBy` edge) + a walk wrapper over P1's rows so
  P4 code (capture/export/verify) is decoupled from P1's column names. **NO new graph tables.**
- **ITEM-2**: **`provenance_code_blobs` table** — content-addressed Postgres code store:
  `sha256 PK, language, source TEXT, byte_len, created_at`. Deduped by hash (a step ≈ 1–10 KB; hundreds of
  runs × few KB deduped < a few MB/study → Postgres, NOT `ziee-file`, NOT the results-store). Referenced by
  `code_sha256` on the run's repro sidecar.
- **ITEM-3**: **`provenance_run_repro` sidecar** (1:1 with a catalog run):
  `run_id PK FK, code_sha256 FK, generator_id, generator_version, env_rootfs_sha256, lockfile_json
  (versions.json receipt), seed, inputs_json_derived (nullable cache), captured_at`. Keeps P1's core run
  schema untouched.
- **ITEM-4**: **Reference-resource root nodes** — versioned, hash-identified system/library inputs (reference
  genome+annotation e.g. GRCh38+GENCODE v45, label-transfer atlas, gene sets) as first-class
  `wasGeneratedBy`-less roots (journals require reporting them). Realized as P1 root artifacts tagged
  `source_kind=reference`, or a thin `provenance_reference_resources(id, kind, name, version,
  accession/doi, content_hash, created_at)` if P1 doesn't model `source_kind`.
- **ITEM-5**: **Root nodes carry provenance at ingest** — add sha256 + uploader + timestamp + original
  filename + optional external accession/DOI to the `dataset`/`ziee-file` upload path. **A7: the
  ziee-file dataset multipart upload path ALREADY EXISTS on merged main (`63520fb`)** — it is NOT a
  greenfield stub (that was true only on the stale analysis-workflow tree). P4 therefore only **adds the
  provenance fields** onto the existing upload path (a checksum + uploader + accession stamp), it does
  NOT build the upload/multipart receiver. Ensures every backward walk terminates at a hashed root.
- **ITEM-6**: **Surface the FULL rootfs sha256** (DEC-ROOTFS-DIGEST). Today only a 12-char prefix is exposed
  at `/sandbox/status`; the run record needs the full `.sqfs-sha`. Additive, non-breaking field on
  `RootfsStatus` + a `full_content_hash()` accessor. Env digest = `rootfs_sha256 + dockerfile_sha +
  optional in-sandbox lockfile hash`.
- **ITEM-7**: **`ProvenanceCapture` seam** — trait + `NoopProvenanceCapture` default + `install_capture(OnceLock)`,
  mirroring `jobs/seams.rs` exactly. Methods: `record_run`, `record_edges(used[], generated[])`,
  `store_code(source,lang)->sha256`, `record_reference(...)`. The generic `jobs` module stays reusable — it
  emits through this seam, it does NOT become a DAG.
- **ITEM-8**: **Compute-chokepoint capture** — a hook/decorator wrapping the P3 `JobRunner`→
  `sandbox::run_analysis` spawn+finish. On start: hash+store the emitted `script.py` → code blob (so even a
  FAILED run has its code). On finish: write the run node (params/seed/command/timing/acting-user/exit into
  P1's catalog) + the repro sidecar (code_sha256, generator id+ver, env fingerprint, lockfile) + `used`/
  `wasGeneratedBy` edges + the **per-artifact content hash and set-valued output signature**
  (`{(entry.id, hash)}` read from the P3-owned canonical `OutputsManifest`/`OutputEntry` struct — A1,
  field name `id` is the output slot; one run node → N `generated` edges, multi-output fan-out,
  produce-atomically). P4 **imports** P3's `OutputsManifest` struct (does not define its own; the old
  `output_slot` field name is retired). Ancillary files (logs/temp) attach as run metadata, NOT graph nodes.
  Ordering: **generate → hash → store blob → run → record node.**
- **ITEM-9**: **Closure enforcement at capture** — the three-branch input resolver
  (`{upload_id}`/`{analysis_output_id}`/`{reference_resource_id}`) records the `used` edge at resolution and
  **rejects/flags a run whose declared input is not a known {upload · prior-analysis-output · pinned
  reference}** — closes the "ambient/from-nowhere input" hole; guarantees every backward walk terminates at
  roots.
- **ITEM-10**: **Path-agnostic `inputs.json` contract + resolver** — a tiny path-binding manifest mapping the
  script's logical input/output *slots* → paths. **Derived, not authoritative** (canonical provenance = the
  graph `used` edge by id+hash). Generated fresh two ways: slots→sandbox mounts (capture/verify) and
  slots→`data/` (export) → **byte-identical script both places, no path rewriting.** Params + seed are baked
  into the **script body** (so `code_sha256` fingerprints "template + exact params"; a param change → new
  script → new run node), NOT in `inputs.json`.
- **ITEM-11**: **Code-blob source = the extension's staged sandbox-entry bytes** (DEC-CODE-SOURCE correction
  to live8's app-emits-scanpy assumption). The captured code is the extension's `compute/*.py`/`.R` entry
  bytes + the generated `inputs.json` + a harness preamble (seed + `OMP/OPENBLAS/MKL_NUM_THREADS=1` +
  `read_input`/`write_output`/selection helpers reading `inputs.json`). Hash the assembled script →
  `code_sha256`; `generator_id/version` = the extension id+version. live8's "one code path / byte-faithful
  export" property still holds.
- **ITEM-12**: **Interaction-chokepoint capture** — a "record selection/action" API
  (`POST /api/provenance/selections` + generic `/actions`) the Explorer/host calls on a state-mutating
  gesture → a `selection.*`/`annotate.*`/`group.*` run node (Activity) + an **emitted** hashed code blob +
  a `used` edge to the exact input artifact by content-hash + an output edge to the derived artifact. Env =
  "app + emitter version" (NOT rootfs — applied in-app, not sandboxed). The second capture source alongside
  compute; both emit into the ONE graph.
- **ITEM-13**: **Open interaction-action registry** (§B2 vocabulary, future-proofing) — keyed by action-type
  → `{versioned spec schema, code emitter, apply fn, fidelity class ∈ declarative|identity|view-only}`, so
  each future manual feature (annotate/group/subset) plugs the SAME seam without a retrofit. **Build only
  `selection.*` this round; reserve the rest's vocabulary.**
- **ITEM-14**: **Selection-as-RECIPE storage** (scale-safe; DEC-RECIPE). A cell-set is stored as a RECIPE,
  NEVER a materialized set (studies reach ~10M cells; a packed mask is ~1.25 MB each). Store `{predicate}`
  (polygon+embedding-hash / `{col,op,val}` / `{clustering_ref,labels}` / set-op `{operand refs}+op`) +
  `{pinned content-hash of the input artifact}` (~1 KB, O(1) in N) — reproduces exactly because the input is
  pinned by hash → deterministic replay, no drift, no stored fallback set. **Freehand only** (hand-picks)
  stores a small explicit id-list (`ad.obs_names.isin([ids])`). The materialized bitmask (§3.9) is
  **runtime-only** (re-derived on demand), never persisted.
- **ITEM-15**: **Wire the human/AI selection surfaces to the capture seam** — `api.selection.setByPredicate`
  and the annotation `assign` (PLATFORM §0.4.1) call ITEM-12 so the human-lasso / AI-emitted / provenance
  representations are ONE shared recipe. (Consumes P8's DSL type; P8 builds the evaluator.)
- **ITEM-16**: **Backward-reachability walk + export scoping** — a Postgres `WITH RECURSIVE` from a target
  artifact/run over `used`/`generated` edges → the minimal sub-DAG (closure to roots). **Export scope = which
  root you walk from**: single analysis/figure (default), a set of analyses, or the whole study (union of leaf
  closures). Sibling outputs of a multi-output run the target didn't `use` are **excluded from carried
  data/code** but still regenerate on re-run (produce-atomically); reachability distinguishes used-vs-dead
  outputs. **Export unit = the ANALYSIS** (a multi-analysis job = N run nodes).
- **ITEM-17**: **Reproduce-script generator** — topological sort of the sub-DAG → a `run.sh` driver
  (Code-Ocean capsule shape) + the exact per-step scripts pulled from `provenance_code_blobs` by
  `code_sha256` (**never regenerated** from current templates — a later template change can't alter a captured
  run) + a bundle-relative `inputs.json` (slots→`data/`) + the harness preamble. Manual/selection steps
  (predicate code / freehand id-list, with `points_in_polygon` etc. as harness helpers) drop inline in topo
  order, indistinguishable from computed steps.
- **ITEM-18**: **Methods-text generator** — deterministic templated params→prose (single-cell: software +
  versions, genome+annotation, QC thresholds, normalization, #HVGs/#PCs, integration+batch key, clustering
  algo+resolution, DE test+thresholds, ALL seeds; selections narrated) via each run node's
  `AnalysisContribution.methodsText(params)` hook in topo order + a Key Resources Table + a DAS /
  Code-Availability statement (Nature + STAR styles). Citations via the existing `citations`/`lit_search` CSL
  path; format emit via embedded **pandoc**. Optional LLM-assisted polish **OFF by default** (artifact stays
  deterministic).
- **ITEM-19**: **Export bundle assembler** — a downloadable **BagIt-RO-shaped .zip** serializing the ITEM-16
  sub-DAG: `data/` (the walk's content-addressed artifacts, read from P1's object store; a `fetch.txt` hole +
  ITEM-25 size caps for large `.h5ad`) + per-step `script.py`/`.R` + `run.sh` + bundle-relative `inputs.json`
  + env spec (rootfs sha256 + lockfile / `requirements.txt` / `renv.lock`) + `methods.md` + `manifest.json`
  (ITEM-20) + `REPRODUCING.md` + `manifest-sha256.txt`. The annotated `.h5ad`/`.rds` object ships via P1's
  AnnData/Zarr export codec (provenance references it, never re-invents). Ingest of `/outputs/*` into the
  file store reuses `mcp/resource_link.rs` `persist_links` + `ziee://` host-path guards + `confine_under_roots`.
- **ITEM-20**: **RO-Crate manifest** — phase-1 = RO-Crate-*shaped* bespoke `manifest.json` (fields chosen to
  map 1:1 onto WRROC `CreateAction`/`FormalParameter`); phase-2 = upgrade **in place** to a valid
  `ro-crate-metadata.json` at the Provenance-Run-Crate profile (schema.org `CreateAction` per step,
  `FormalParameter` params, Bioschemas `ComputationalWorkflow`/`ComputationalTool`, PROV-convertible). PROV
  is the model, not the wire format.
- **ITEM-21**: **Env-pinning + readiness checklist** (phase-1 verification tier) — capture the full rootfs
  sha256 + an in-sandbox lockfile/`versions.json` (sessionInfo receipt) per run; a Reproducibility-panel
  readiness checklist (seeds set? env pinned? inputs checksummed? code captured? all roots have provenance?).
- **ITEM-22**: **In-sandbox re-run VERIFICATION + tolerance-diff certificate** (phase-3, the differentiator;
  NO external dependency — the app owns the isolated headless sandbox). Re-mount the same rootfs, run the
  bundle's `run.sh` headless/no-network against `data/`, recompute the run's **set-valued output signature**
  (all N `(output-slot, hash)`), diff regenerated vs recorded within **tolerance** (ARI≈1 on labels,
  `allclose` on embeddings — honest target = *statistical equivalence under a pinned environment*, NOT
  bit-exact). Emit a **"Reproduced ✓"** certificate (own file-store artifact, `codecheck.yml`-style output
  manifest). Gated behind the ITEM-25 size/time budget.
- **ITEM-23**: **Verification status persistence + surfacing** —
  `provenance_verifications(id, target_run_id, status ∈ pending|reproduced|diverged|error, tolerance,
  diff_report_json, cert_ref, verified_at)` + a `VerificationBadge` in the UI + a
  `SyncEntity::ProvenanceVerification` (Create/Update, owner/study-scoped).
- **ITEM-24**: **DOI deposit** (phase-2, optional, OFF by default) — Zenodo/DataCite client (4-call flow:
  create → bucket upload → PUT metadata → publish; concept-DOI vs version-DOI; `relatedIdentifiers` →
  `IsSupplementTo` paper / `IsDerivedFrom` dataset / `IsVersionOf` re-runs) behind a seam; creds from settings
  via `common::secret`; deposits the bundle, stamps the DOI onto the export record. The **only external-service
  dependency** — SSRF-safe (fixed public host), degrades gracefully, never blocks export.
- **ITEM-25**: **`provenance_settings` singleton** (DEC-SETTINGS — mandatory, not bare constants). Mirror
  `code_sandbox_settings`/`session_settings`: settings table + migration + read-at-use with cache
  invalidation + REST `GET/PUT /api/provenance/settings` gated `provenance::settings::{read,manage}` +
  `SyncEntity::ProvenanceSettings` + admin card + bounds validation. Fields: `verify_on_reproduce` toggle,
  re-run time/size budget caps, tolerance default, bundle + certificate retention days, DOI provider+creds
  (secret), methods-LLM-polish toggle.
- **ITEM-26**: **Provenance study-extension registration** — `#[distributed_slice(STUDY_EXTENSIONS)]`
  (+ `STUDY_SLOTS`) with `on_study_deleted` (cascade code blobs / repro sidecars / verifications / bundles /
  reference resources for the study — via the shared `delete_study_with_extensions` chokepoint) +
  `on_study_duplicated` (deep-copy graph refs; MVP may no-op behind a flag — re-pointing storage refs is
  nontrivial, note as SDK gap). Zero study-core edits.
- **ITEM-27**: **Sync entities** — `ProvenanceRun` (+ `ProvenanceVerification`, `ProvenanceSettings`),
  owner/study-scoped, `Create/Update` emitted from the capture/verify tasks (`origin=None`), so a shared
  workbench's provenance panel refreshes live (notify-and-refetch).
- **ITEM-28**: **FE Reproducibility panel** (`ui/src/modules/provenance/`, workbench right-dock + bottom-dock
  Log/provenance tab + top-toolbar Export per WORKBENCH_IA) — inspectable lineage-DAG view (each run:
  tool+version+params+seed+inputs+outputs, a trust view) + **figure→run stamp** (run id + object hash +
  params + versions + seed, answering "which run made this figure?") + the ITEM-21 readiness checklist +
  one-click **Export** (scope picker → bundle download) + **Verify** button + `VerificationBadge` + DOI
  affordance + a `ProvenanceSettings` admin card. A `defineStore` (Provenance/Export/Verification) subscribing
  `sync:provenance*`. Surfaces live5's phase-3 export/verify affordances (DEC-OVERLAP-LIVE5 — live5 is
  UX-only; P4 owns the layer).
- **ITEM-29**: **Permissions** — `provenance::{read, export, verify, doi, settings::{read,manage}}`; `read`
  granted to the Users group / study viewers (read-only) + editors; admins via `*`. Migration for the grants;
  A9 backend-deny + A10 restricted-user e2e.
- **ITEM-30**: **REST surface** (owner/study-scoped, foreign→404): `GET /api/provenance/graph?target=<run>`
  (walk), `GET /api/provenance/runs/{id}`, `POST /api/provenance/export {target, scope}` (build bundle),
  `GET /api/provenance/export/{id}` (download), `POST /api/provenance/verify`,
  `GET /api/provenance/verifications`, `POST /api/provenance/doi`, `GET/PUT /api/provenance/settings` — all
  gated by the ITEM-29 perms.
- **ITEM-31**: **Per-figure "cite this exact result" capsule** (later delighter). A figure spec stamps back to
  its source run(s); export the minimal backward closure for that one figure as a citeable capsule. Deferred
  past the phase-1 study bundle.

---

## Files/modules

**Create — server `src-app/server/src/modules/provenance/` (first-party compiled Rust module):**
`mod.rs` (MODULE_ENTRIES + StudyExtension registration), `models.rs`, `permissions.rs`, `routes.rs`,
`handlers.rs`, `repository.rs`, `events.rs`, `seams.rs` (ProvenanceCapture trait + Noop + `install_capture`),
`capture.rs` (compute-chokepoint hook + closure enforcement + code-blob store + env digest),
`graph.rs` (read-facade over P1 catalog: typed RunNode/ArtifactNode/edge views + walk wrapper),
`interaction.rs` + `action_registry.rs` (record-selection API + recipe schema + predicate emitter),
`inputs.rs` (inputs.json build + ref resolver + closure guard),
`settings.rs` (`provenance_settings` singleton + cache),
`export/{bundle,reproduce_script,methods,manifest,ro_crate[p2]}.rs`,
`verify/{runner,diff,certificate}.rs`, `doi/zenodo.rs[p2]`,
`study_extension/extension.rs` (mirror `dataset/study_extension`),
`migrations/2026072x_provenance_*.sql` (code_blobs · run_repro sidecar · reference_resources · verifications
· settings · perm grants).

**Modify (thin, additive, non-breaking):**
- `modules/jobs/runner.rs` + `modules/sandbox/service.rs` — install/call the capture hook around
  `run_analysis` (reads its `SandboxRunResult` + `/outputs/manifest.json`; the fn itself is unchanged).
- `modules/rootfs/version.rs` + `modules/sandbox` status — surface full rootfs sha256 (ITEM-6).
- `dataset`/`ziee-file` ingest — checksum roots (ITEM-5).
- P1 catalog — coordinate the artifact content-hash at ingest that P4 reads (ownership: P1 hashes; P4 reads).
- `modules/mod.rs` — register `ProvenanceModule`.

**Create — frontend `src-app/ui/src/modules/provenance/`** (+ `desktop/ui/` mirror): `module.tsx`, `types.ts`,
stores (`Provenance`, `Export`, `Verification` via `defineStore` + `sync:provenance*` refetch), components
(`ReproducibilityPanel`, `LineageGraph`, `ReadinessChecklist`, `FigureRunStamp`, `ExportDrawer`,
`VerificationBadge`, `ProvenanceSettingsCard`).

**OpenAPI:** `Provenance.*` types → `just openapi-regen` (BOTH `ui/` + `desktop/ui/`).

---

## Reuse

- **live8 `feat/provenance` DESIGN** — adopt VERBATIM as the spec (execution/recipe model): DEC-GRAPH, §B1
  closure invariant, §B2 interaction-action catalog, §B3/§B3.1 one-code-path + content-addressed blobs +
  path-agnostic inputs.json + selection-as-recipe, export scoping, Candidate-D phasing. **No code to git-adopt.**
- **P1 catalog** — run/artifact/edge tables + `WITH RECURSIVE` backward walk (the graph; DEC-OWN — do not
  duplicate) + content-hashed artifacts as node backing.
- **`sandbox::service::run_analysis` + `ExtraMount`/`MountMode`** (cyto `modules/sandbox`) — the exec seam for
  both capture AND verify re-run (already `--clearenv`/`--unshare-net`/RO-rootfs; linux + non-linux cfg'd).
  Don't reimplement bwrap.
- **`jobs` module** (`Job`, `job_logs`, `job_metrics`, `seams.rs` sync/notify seam idiom) + `JobRunner` — the
  chokepoint capture wraps; `jobs/seams.rs` is the exact trait+Noop+`install_seams(OnceLock)` pattern to mirror.
- **`study/core/extension/registry.rs`** (`STUDY_EXTENSIONS`, `StudyExtension::on_study_deleted`,
  `delete_study_with_extensions`) — registration + lifecycle cascade (live8 substrate, merged).
- **`rootfs::version` sha256 / `content_version()` / `.sqfs-sha`** — env-pin substrate (ITEM-6 surfaces full).
- **`mcp/resource_link.rs` `persist_links` + `ziee://` host-path guards + `confine_under_roots`** — the
  trusted-emitter/confine model for ingesting `/outputs/*` sandbox artifacts into the file store.
- **`workflow_runs` + `set_workflow_run_id`** run→artifact linking — the run-owns-artifacts cascade pattern
  for `on_study_deleted`.
- **`code_sandbox_settings`/`session_settings` (`resource_limits.rs`)** — the settings-singleton template
  (table + read-at-use + cache invalidation + REST + sync + admin card + bounds) copied verbatim for ITEM-25.
- **`common::secret`** (dual-column + SecretView redaction) — DOI credentials.
- **`sync` (`SyncEntity` + `publish`)** — run/verification/settings events, study-scoped.
- **pandoc** (embedded, vendored for `citations`) + `citations`/`lit_search` CSL — methods/KRT/BibTeX emit.
- **P1's AnnData/Zarr export codec** — the bundle's annotated object export (ITEM-19).
- **P8 predicate DSL + host evaluator** — selection-recipe wire format + code emit.
- **ziee `sigstore`/`sha2` patterns** — content-addressing.

---

## Dependencies

- **P1 data-foundation — HARD BLOCKER (DEC-FOUNDATION critical path).** The catalog run/artifact/edge schema
  + backward walk ARE the graph (DEC-OWN); content-hashed artifacts back the nodes; the `JobRunner`→
  `sandbox::run_analysis` integration + the `produces` manifest are the chokepoint P4 wraps. Nothing in P4
  (except the standalone schema/settings/rootfs slice) lands before P1's compute path exists.
- **P3 compute-scheduling — HARD.** JobRunner→runner dispatch + `ExtraMount` input/output plumbing + the
  `inputs.json`/`/outputs/manifest.json` contract (co-owned interface — see R1) + the scientific rootfs
  (scanpy/anndata/Seurat). Capture hooks it; verify re-runs on it.
- **P8 interaction-dsl — HARD for ITEM-12/13/14/15.** The cell-set predicate DSL is the recipe wire format;
  P4 stores/persists the recipe + emits its code, P8 owns the grammar + apply/materialize.
- **P2 datatype-system — SOFT.** Artifact `datatype` id + multi-file merkle/manifest content hash (Zarr
  prefix, BAM+bai) + the bundle's `data/` format.
- **P6/P7 workbench/viz** — the brushing gesture that triggers ITEM-12; the dock/toolbar hosting ITEM-28.
- **P10 study-substrate (live8, merged) — HARD for ITEM-26.** `STUDY_EXTENSIONS`, lifecycle cascade, sync,
  study-role authz.
- **live5 analysis-workflow UX** — consumes P4's export/verify affordances (DEC-OVERLAP-LIVE5: live5 UX-only,
  P4 owns the layer).
- **rootfs** (exists) — the env-fingerprint sha256.

---

## Sequencing

1. **DEC-OWN + graph facade (ITEM-1)** — pin the boundary first; everything reads P1 through the facade.
2. **Standalone slice (no P1/P3 needed):** ITEM-2 (code_blobs), ITEM-3 (repro sidecar), ITEM-6 (full rootfs
   digest), ITEM-25 (settings), ITEM-26 scaffold. Build + unit-test the code-blob/recipe model against fixtures.
3. **Capture backbone (needs P1+P3):** ITEM-7 (seam) → ITEM-8 (compute chokepoint) → ITEM-9 (closure) →
   ITEM-10 (inputs.json) → ITEM-11 (code source) → ITEM-4/5 (roots). *Phase-0c — the "provenance-for-free"
   wedge; every later item stands on this.*
4. **Interaction capture + recipe (needs P8):** ITEM-12 → ITEM-13 → ITEM-14 → ITEM-15. Parallel with (5) once
   the seam exists.
5. **Export (Phase-1 MVP wedge — needs P1 artifact bytes):** ITEM-16 (walk) → ITEM-17 (reproduce-script) →
   ITEM-18 (methods) → ITEM-20 (RO-Crate-shaped manifest) → ITEM-19 (bundle) → ITEM-21 (env-pin/readiness).
6. **Surfaces (woven alongside 5):** ITEM-27 (sync) · ITEM-29 (perms) · ITEM-30 (REST) · ITEM-28 (panel).
7. **Phase-3 verify:** ITEM-22 (re-run + tolerance diff) → ITEM-23 (verification persistence + badge) — once
   the workflow is genuinely re-runnable headless (P3 mature).
8. **Phase-2:** ITEM-24 (DOI) + ITEM-20 phase-2 (full WRROC upgrade in place).
9. **Last delighter:** ITEM-31 (per-figure capsule).

---

## Decisions

- **DEC-OWN (headline, BAKED IN):** the graph = P1's catalog (single source of truth); P4 owns capture-logic +
  reproducibility layer + `provenance_code_blobs` + `provenance_run_repro` sidecar + settings/verify/DOI.
  **NO `provenance_runs/artifacts/edges` triple.** Overrides live8's original decoupled-triple stance (which
  was contingent on a non-existent catalog). The facade (ITEM-1) is P4's only write path into the graph.
- **DEC-ADOPT-LIVE8:** adopt live8's design MODEL verbatim (run=Activity, artifact=Entity by content-hash,
  used/wasGeneratedBy, 3 roots + closure, append-only branching, one-code-path, selection-as-recipe, backward-
  closure export, Candidate-D phasing) but realize it in P1's tables + build all code (nothing to git-adopt).
- **DEC-CAPTURE:** passive auto-capture at the two chokepoints (compute + interaction), NEVER an explicit
  checkpoint — "provenance for free" is the entire wedge; an effort tax kills adoption.
- **DEC-CODE-BLOB:** code → content-addressed Postgres text blobs (sha256 PK, deduped); data artifacts → P1
  object store; graph → P1 catalog. Code is graph metadata, not a `ziee-file` upload.
- **DEC-CODE-SOURCE (correction to live8):** captured code = the extension's staged sandbox-entry bytes +
  generated `inputs.json` + harness preamble (live8 predates the extension-platform model), hashed →
  `code_sha256`; `generator_id/version` = extension id+version. The byte-faithful-export property holds.
- **DEC-ONE-CODE-PATH:** the emitted script that RUNS a step IS the exported code; export assembles the stored
  per-run blob (never regenerated → a later template change can't alter a captured run). Path-agnostic scripts
  + derived `inputs.json` make "code that ran == code exported" literal (no path rewriting).
- **DEC-SCOPE:** ANALYSIS = provenance unit, JOB = execution unit (a multi-analysis job = N run nodes; one
  analysis run = one run node fanning out to N `generated` edges). Export = backward closure from the target
  analysis only; batched jobs require per-analysis code fragments.
- **DEC-MULTI-OUTPUT:** one run FANS OUT to N artifact nodes (N `generated` edges, each labelled by the
  canonical `OutputEntry.id` slot — A1, formerly `output_slot`); reproduce unit = run (produce-atomically),
  consume unit = artifact (consume-individually); run output-signature = set of `(entry.id, hash)` read from
  P3's canonical `OutputsManifest`.
- **DEC-RECIPE:** selection = recipe (predicate + pinned input hash), size-independent of cell count; §3.9
  bitmask runtime-only; freehand-only = a small id-list.
- **DEC-CLOSURE:** enforce the 3-source-kind invariant at the chokepoint (reject inputs not a known
  upload/artifact/reference); roots MUST carry a content hash — the ziee-file dataset upload path already
  exists on main (A7), so P4 only ADDS the checksum/provenance stamp, not the upload path.
- **DEC-VERIFY:** env-pinning (phase 1) → in-sandbox re-run + tolerance-diff certificate (phase 3). Target =
  **statistical equivalence under a pinned environment**, NOT bit-exact (honest framing mandatory in
  UI + certificate); check ALL N `(output-slot, hash)` in the set-valued signature.
- **DEC-MANIFEST:** RO-Crate-shaped bespoke JSON (phase 1) → full WRROC Provenance Run Crate (phase 2, upgrade
  in place). PROV as the model, not the wire format.
- **DEC-DELIVERY:** downloadable BagIt-RO bundle (all phases); Zenodo/DataCite DOI optional (phase 2, the only
  external dep); the capsule layout supports the phase-3 re-run.
- **DEC-METHODS:** deterministic templated default + optional LLM polish (OFF by default).
- **DEC-SETTINGS:** an admin `provenance_settings` singleton (verify toggle, budgets, tolerance, retention,
  DOI creds, LLM-polish), NOT bare constants.
- **DEC-ROOTFS-DIGEST:** surface the FULL rootfs sha256 (today only a 12-char prefix), additive/non-breaking.
- **DEC-SCOPE-DEPLOY:** desktop/1-box — verify re-runs on the local bwrap sandbox; bundle writes to local FS;
  DOI is the only outbound call. Remote/HPC verify deferred behind the same seam.

---

## Risks

- **R1 — contract co-ownership (highest interface risk).** The `produces`-manifest shape drives output-edge
  capture; divergence breaks it. **A1: P3 OWNS the canonical `OutputsManifest { outputs:
  Vec<OutputEntry{id,datatype,path,layout,role}> }` struct + JSON-schema; P4 (like P1) is a CONSUMER that
  imports it** — no P4-local redefinition, `id` is the output slot. Mitigate: P3 defines the on-disk sandbox
  I/O contract + the struct; P4 defines run-node/edge capture + code-blob + inputs.json *generation from
  graph edges* and reads the manifest through P3's struct.
- **R2 — foundation not built (highest schedule risk).** P1 catalog + P3 JobRunner→sandbox + scientific rootfs
  are the critical path; the whole capture/export layer blocks on them (DEC-FOUNDATION). Mitigate: build the
  facade + code-blob store + repro sidecar + export generators against a small fixture graph early; wire
  capture last.
- **R3 — two-source-of-truth regression.** If any P4 code writes graph nodes/edges outside P1's tables,
  lineage diverges. Mitigate: DEC-OWN + the facade is the only write path; enforce in review/A-audit.
- **R4 — multi-file artifact content-hashing** (Zarr prefix, BAM+bai) — a merkle/manifest hash defined by P2's
  storage layout. Coordinate with P2.
- **R5 — selection recipe ↔ P8 grammar mismatch.** The persisted recipe must be exactly P8's serialized
  predicate or the emitted `reproduce.py` won't replay. Mitigate: recipe JSONB = P8's DSL, no re-encoding.
- **R6 — verify nondeterminism.** Single-cell tools are seed/version/thread sensitive; bit-exact is
  unachievable → tolerance/statistical-equivalence framing + pinned seed + `*_NUM_THREADS=1` in the preamble;
  surface tolerance in settings; ship the badge last. Risk of false "diverged" if tolerance mis-set.
- **R7 — multi-output atomicity.** A partial re-run regenerating only some outputs must NOT pass verify —
  check ALL N `(output-slot, hash)`.
- **R8 — verify resource budget on 1-box.** Re-running a whole chain is expensive; bound by export scoping
  (backward closure only) + the ITEM-25 time/size caps.
- **R9 — recipe/artifact retention (GC).** A recipe only reproduces if its pinned input is retained;
  coordinate append-only / never-GC-on-a-live-lineage-path with P1/P10 blob-GC.
- **R10 — batched-job code capture.** A non-decomposable monolith breaks per-analysis code scoping; fallback =
  ship the whole job's code, mark unused outputs "also produced, not used by this export" (over-inclusive but
  honest).
- **R11 — `on_study_duplicated` graph deep-copy** (re-point storage refs) is nontrivial; MVP may no-op behind
  a flag; note as SDK gap.
- **R12 — large `.h5ad` bundles** exceed a reasonable zip / re-run budget. Mitigate: `fetch.txt` hole + size
  caps; default to the target-figure backward closure, offer whole-study explicitly.
- **R13 — methods.md quality** depends on each analysis providing `methodsText`; omitting extensions get a
  generic sentence — acceptable for MVP.
- **R14 — DOI external dependency** (Zenodo/DataCite creds + availability); keep off by default, degrade
  gracefully, never block export on DOI.
- **R15 — rootfs digest API change** must not break existing sandbox-status consumers → additive field only.

---

## Effort

- **Capture backbone (ITEM-1–11)** — **M** (facade + 3 migrations + seam + compute chokepoint + closure
  resolver + inputs.json + code source). Gated on P1/P3.
- **Interaction capture + recipe (ITEM-12–15)** — **M** (chokepoint + action registry + emitters + wiring).
  Gated on P8.
- **Export layer (ITEM-16–21)** — **L** (walk + reproduce-script + methods + RO-Crate-shaped manifest +
  bundle + env-pin; the phase-1 wedge, widest surface). Reuses pandoc + AnnData codec.
- **Surfaces (ITEM-27–30)** — **M** (settings copies an existing pattern; REST + panel + export drawer +
  badge are the bulk).
- **Verify badge (ITEM-22,23)** — **L** (re-run harness + tolerance diff + certificate + persistence;
  phase 3, needs mature P3).
- **DOI + WRROC upgrade (ITEM-24, ITEM-20-p2)** — **M** (bounded external client + additive manifest upgrade).
- **Per-figure capsule (ITEM-31)** — **S** (later slice).

Overall **L**, phaseable: phase-1 (capture + one-click package) ships standalone value; verify/DOI/WRROC land
as independent later slices (the Candidate-D de-risking rationale). Only the standalone schema/settings/rootfs
slice (**S**) proceeds before P1/P3 exist. **31 items.**

---

## Saturation

r3 did NOT open a substantively new work AREA beyond r1∪r2 — its distinct contributions are all *resolutions
and refinements* of the r1↔r2 divergence the DIFF flagged. Concretely: r3 (a) **resolved the one genuine
conflict** — the graph-ownership boundary — decisively in favor of "graph lives in P1's catalog, P4 owns
capture-logic + the reproducibility layer" (DEC-OWN), which r1 and r2 left as opposing open stances; (b)
factored r2's per-run enrichment into an explicit `provenance_run_repro` **sidecar** so P4 evolves without
touching P1's run schema; (c) split r2's monolithic verification item into a re-run engine (ITEM-22) + a
`provenance_verifications` **persistence table + badge + sync** (ITEM-23); (d) added finer permissions
(`verify`/`doi`) and a per-figure "cite this result" capsule (ITEM-31). Everything else (settings singleton,
verify-on-reproduce, tolerance framing, DOI, full-rootfs-digest, RO-Crate/WRROC, methods richness) was already
present in r1 or r2. The three rounds converge on one identical spine; r3 closed the only real fork rather than
enlarging scope. No new capture surface, storage model, export format, or external integration remains
un-enumerated. SATURATION: REACHED
