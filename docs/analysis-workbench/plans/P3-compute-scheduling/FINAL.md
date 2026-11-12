# P3 — Compute & Scheduling (FINAL — deduped union of r1 ∪ r2 ∪ r3)

## Reconciliation applied
- **A1 — canonical `OutputsManifest` (P3 is the OWNER).** The `/outputs/manifest.json` contract was co-owned with
  divergent field sets across P1/P2/P3/P4 (wouldn't serde-deserialize). Resolution: **P3 defines and writes the ONE
  canonical struct** — Rust `OutputsManifest { outputs: Vec<OutputEntry> }`,
  `OutputEntry { id: String, datatype: String, path: String, layout: String, role: String }` (serde-serializable),
  written by the sandbox job at `/outputs/manifest.json`. P1 (catalog ingest), P2 (datatype typing), and P4
  (provenance) **import** this struct — they do NOT redefine it. This replaces the prior divergent
  `produces:[{id,kind,from}]` field set everywhere below (ITEM-13/15, DEC-K, Files/modules).

Scope: **desktop + single-box server ONLY**. Build the LOCAL bwrap arm behind open seams
(`ComputeBackend` topology seam + no-op ingest/provenance sinks). Remote/HPC/GPU/cloud are typed-unavailable
behind the seam, NOT built. This is **integration + policy over an existing base**, not greenfield.

Grounded in actual code on `feat/analysis-workflow` (server tree == main): `modules/jobs` (real FCFS queue +
per-job executor driving a live child — log-drain, 1s CPU/RSS `ProcSampler` by pid, watch-cancel, terminal
persist, SSE, `job_logs`/`job_metrics`, settings singleton, no-op `JobSyncSink`/`JobNotifier` seams; the ONE
stub is `runner::StubJobRunner`, and `job_type` is stored but never dispatched on — the gap P3 closes),
`modules/sandbox` (`build_bwrap_argv` with `ExtraMount`/`MountMode` RO/RW binds + prlimit tail +
`--clearenv --unshare-net` network-BLOCKED; batch `run_in_sandbox`/`service::run_analysis` that waits,
caps stdout/stderr to 1 MiB, and deletes the workspace on return; `CgroupScope` that only WRITES caps and never
reads; `SeccompPipe`; `SandboxContext`; `probes`; `config`), `modules/rootfs` (docker-build-at-build-time →
`include_bytes!` embed → lazy squashfuse-mount; minimal Dockerfile = debian + r-base-core + jsonlite + python3,
`ROOTFS_SCHEMA_VERSION=1`, no scanpy/anndata/leiden/harmony), `modules/dataset`+`txresbench-file` (content-addressed
blobs). `SandboxRunResult` carries NO usage fields today.

Boundary with other parts: P3 owns EXECUTION (spawn/stream), SCHEDULING (classes/pool/fair-share), the ROOTFS
env, and the `inputs.json`/outputs-`manifest.json` CONTRACT + `ExtraMount` plumbing. P3 hands off — via no-op
seams — to (a) P1 foundation working-store/catalog for artifact INGEST and (b) P4 provenance for
run-node/code-blob RECORDING. P3 does not implement the catalog, the datatype readers, or the provenance schema.

---

## Items

### A. Streaming spawn ⇄ JobRunner integration (the crux)
- **ITEM-1**: **Streaming sandbox spawn variant** (`sandbox/sandbox.rs` + `sandbox/streaming.rs` + `service.rs`).
  Today's `run_in_sandbox` is single-shot batch: it owns the bwrap `Child`, drains+caps stdout/stderr internally,
  applies its own timeout, and drops cgroup/seccomp/workspace at fn end. Factor the shared setup (synthetic
  identity, `rootfs::ensure_ready`, caps promotion, `CgroupScope` create, `SeccompPipe` install, `clamp_timeout`,
  `build_bwrap_argv`) into a helper, then add a spawn-only path (`run_in_sandbox_spawn` /
  `run_analysis_streaming`) that spawns bwrap with `stdout/stderr=piped`, `kill_on_drop(true)`, cgroup pid
  attached, and **hands back** the live `tokio::process::Child` **plus the owned guards** so the jobs executor
  drives log-drain/metric/cancel. Refactor batch `run_in_sandbox` to `= setup + spawn + internal drive` so the
  REST `POST /sandbox/execute` path is byte-unchanged. Keep BOTH paths (different consumers).
- **ITEM-2**: **Extend `SpawnedJob` with an opaque guard + workspace** (`jobs/runner.rs`). Add
  `guards: Option<Box<dyn Send + 'static>>` (holds the sandbox `CgroupScope` + `SeccompPipe` + workspace guard so
  their Drop outlives the child) and `workspace: Option<PathBuf>`. The executor holds `guards` for the child's
  whole life and drops them after the terminal persist; `StubJobRunner` passes `None`.
- **ITEM-3**: **`SandboxJobRunner: JobRunner` + job-type dispatch** (`jobs/runner.rs`). A `DispatchRunner` routes
  on `Job.job_type`: `"stub"`→`StubJobRunner` (kept for tests), `"analysis"`→`SandboxJobRunner`.
  `SandboxJobRunner::spawn` decodes the analysis spec (ITEM-11), materializes inputs + stages code (ITEM-12/13),
  builds the `ExtraMount` vec (ITEM-14), and delegates to the selected `ComputeBackend` (ITEM-8). Closes the
  no-job-type-dispatch gap. Linux-only body; non-Linux → 503 (ITEM-27).
- **ITEM-4**: **Wire runner/backend selection in `JobsModule::init`** — replace hardcoded
  `runner: Arc::new(StubJobRunner)` with a `DispatchRunner` over the built `LocalBwrapBackend`
  (`sandbox::config` Ready → real runner; else stub with a boot warning). Install the no-op ingest/record seams
  here (ITEM-25/26). Idempotent scheduler spawn unchanged.
- **ITEM-5**: **Progress-FIFO plumbing** (`sandbox/sandbox.rs::build_bwrap_argv`). Add an optional
  `progress_fifo_src: Option<&str>` param that binds a host FIFO onto an in-sandbox progress path and sets the
  `$…_PROGRESS` env (port of txresbench `code_sandbox`'s proven `progress_fifo` pattern). The streaming runner drains
  the FIFO into structured `notifications/progress`-style frames (phase + pct + message) on the job SSE, so a
  scanpy script can emit real progress ("normalizing 40%"), not just log lines. `None` → byte-identical to the
  no-FIFO argv.
- **ITEM-6**: **Cancellation correctness across bwrap** (dedicated verified item). Confirm the existing cancel
  path (`runtime::register_cancel`/watch channel + executor SIGTERM→grace→SIGKILL on the bwrap **parent** pid)
  tears down the whole pid-namespace (bwrap `--unshare-pid --as-pid-1` + `--die-with-parent` + `PR_SET_PDEATHSIG`
  reap the bash grandchild) AND the cgroup subtree (`CgroupScope` cleans on Drop), and closes the cgroup/seccomp
  fds. Partial `/outputs` on cancel/timeout are discarded (no half-manifest ingest). No new code expected beyond
  a Tier-4 cancel test; note if a bwrap-specific reap is needed.
- **ITEM-7**: **Post-exit `finalize` hook** (`jobs/runner.rs` + `scheduler.rs`). On a terminal `Outcome` the
  executor calls `runner.finalize(&job, outcome, workspace)` → parse outputs manifest (ITEM-15) →
  `ArtifactIngestSink` (ITEM-25) → `RunRecorder` (ITEM-26) → **then** best-effort workspace cleanup. The analysis
  workspace SURVIVES past exit until outputs are ingested (unlike the batch path, which deletes immediately);
  guards drop when the executor frees `SpawnedJob`.

### B. ComputeBackend seam (local impl only; open for remote/HPC/GPU)
- **ITEM-8**: **`ComputeBackend` topology seam** (`sandbox/backend/mod.rs`, NEW). The §4.1.2 "compute is a
  swappable backend behind one seam", distinct from `JobRunner` (the queue's spawn contract):
  `trait ComputeBackend { async fn launch(&self, spec: ComputeSpec, sink: &dyn ProgressSink) ->
  Result<LaunchedCompute{child, guards}, AppError>; fn probe(&self) -> BackendAvailability; }`. `ComputeSpec` is
  **path-agnostic** (command-or-code-blob-ref, materialized inputs, output_dir, params, `ResourceProfile` limits,
  `PriorityClass`, `ResourceClass`) so the script never learns where it runs.
- **ITEM-9**: **`LocalBwrapBackend`** (`sandbox/backend/local_bwrap.rs`, NEW). The only implemented backend:
  delegates to the streaming spawn (ITEM-1), assembling the `ExtraMount` vec + progress FIFO. `probe`/`supports`
  true only for `ResourceClass::CpuSandbox`. `Gpu`/`Highmem`/`ClusterBatch` + `RemoteWorkerBackend`/`HpcBackend`
  are `// SEAM` TODO variants routing to a typed `BACKEND_UNAVAILABLE`/`Unsupported`. A `BackendRegistry`
  (local-only today) selects by `job.resource_class`.
- **ITEM-10**: **`ResourceClass` + `PriorityClass` enums** (serde snake-case, text-stored). `ResourceClass`:
  `cpu-sandbox` (default/only) + deferred `gpu`/`highmem`/`cluster-batch`. `PriorityClass`:
  `interactive|normal|batch`. Present so later pools/GPU are future ROWS, not a schema change.

### C. Scientific rootfs (scanpy/anndata/leiden/harmony)
- **ITEM-11**: **Provision the scientific Python stack** (`rootfs/Dockerfile`). Extend the minimal image with a
  reproducible, **fully-baked** single-cell stack — `scanpy`, `anndata`, `leidenalg`, `python-igraph`,
  `harmonypy` (+ `numpy`/`scipy`/`pandas`/`scikit-learn`/`umap-learn`/`numba`/`llvmlite`). NOTHING may install at
  run time (`--unshare-net` blocks the network). Keep r-base-core for R analyses. Thread env
  (`OMP/OPENBLAS/MKL_NUM_THREADS=1`) already handled by `build_bwrap_argv`. (See DEC-A for the toolchain.)
- **ITEM-12**: **Bump `ROOTFS_SCHEMA_VERSION` + lockstep + import smoke** (`rootfs/version.rs` +
  `build_helper/sandbox_rootfs.rs` + Dockerfile `ARG`). Bump 1→2 so the runtime mount probe refuses a stale
  cached rootfs and `is_fresh` re-runs docker. Verify the chain flows: build_helper const == Dockerfile `ARG` ==
  rootfs schema marker == `format_version(schema, dockerfile_bytes)` sha8 (catches a Dockerfile content edit even
  without a manual bump). Bake a build-time import smoke `RUN python3 -c "import scanpy,anndata,leidenalg,
  harmonypy"` so a broken env fails the IMAGE build, not a runtime job. `mksquashfs` still runs in-container
  (host needs only docker). Document the `rm -rf` cached-rootfs + `cargo clean` step.

### D. Compute contract (content-addressed code + inputs.json → /inputs → /outputs + manifest)
- **ITEM-13**: **`ComputeSpec`/analysis-spec wire contract + params codec + path-injection guard**
  (`sandbox/spec.rs`). The typed shape an `analysis` job carries in `Job.params` (JSONB):
  `{ script|code_ref, language(python|rscript), inputs:[{slot, artifact_ref|host_path, sandbox_subpath}],
  outputs_dir, produces:[{id,datatype,path,layout,role}] (the canonical `OutputEntry` shape, A1/ITEM-15),
  schedule:{class, cpu, mem_bytes}, timeout_secs, seed }`. Parse/validate
  from `serde_json::Value`; **reject absolute/`..`/non-`/inputs|/outputs` sandbox paths** (path-injection guard).
  Pure + unit-testable. Includes `SandboxJobRunner::build_spec(job) -> ComputeSpec` (the missing
  "params → analysis-command translation").
- **ITEM-14**: **Content-addressed input materialization + `inputs.json`** (`sandbox/inputs.rs`). Host resolves
  each declared input's `requires` (artifact ids from P1's catalog) → content-addressed blobs in the working
  store, hard-links/binds each **read-only** at a stable path (`/inputs/expression.h5`), and writes
  `/inputs/inputs.json` referencing inputs **by content HASH + kind** (path-agnostic — the same fetch a remote
  backend does) + `/inputs/params.json`. `materialize_inputs(spec) -> Vec<MaterializedInput>`, reusing
  `ExtraMount{mode: ReadOnly}`. On 1-box the store read is a local content-addressed file.
- **ITEM-15**: **Canonical `OutputsManifest` type + parse + typed-output extraction** (`sandbox/outputs.rs`).
  **P3 is the single source of the manifest type (A1).** Define ONE serde-serializable struct:
  `OutputsManifest { outputs: Vec<OutputEntry> }`, `OutputEntry { id: String, datatype: String, path: String,
  layout: String, role: String }`. The sandbox job writes it to `/outputs/manifest.json`; P1 (catalog ingest),
  P2 (datatype typing), and P4 (provenance) **import this type, never redefine it**. After exit-0, read
  `<workspace>/outputs/manifest.json`, map each entry's `path` to an absolute host path, validate it stays under
  `/outputs` (no escape), cap count/size, and return `Vec<ProducedOutput>` (carrying `id`/`datatype`/`layout`/
  `role`) for the ingest sink. Undeclared `/outputs` files are ignored (not promoted). Missing/invalid manifest on
  exit-0 = a typed contract violation → job `failed`.
- **ITEM-16**: **Content-addressed code blob execution** (`/code/entry.*`). The entry script is a hashed
  content-addressed blob (P4's `provenance_code_blobs`); the runner fetches it into the workspace at
  `/code/entry.<ext>` bound **read-only** and runs it. P3 owns the *execution* of the blob at a stable path + the
  `inputs.json` contract; P4 owns creating/storing the blob + recording the run node. (See DEC-H for the
  code-location resolution: mounted-RO-blob is the target; workspace-staged-script is the transition fallback.)
- **ITEM-17**: **ExtraMount plumbing end-to-end** (`LocalBwrapBackend`). Assemble the full `ExtraMount` vec: N
  read-only input binds (ITEM-14) + one read-write `/outputs` + one progress FIFO (ITEM-5) + the RO `/code` bind
  (ITEM-16). `build_bwrap_argv` already maps `ReadOnly→--ro-bind`, `ReadWrite→--bind` (unit-tested). This item is
  the wiring, not new argv surface.

### E. Scheduling classes (interactive/normal/batch, single pool, per-user fair-share)
- **ITEM-18**: **Schema — class/resource + provenance-linkage columns** (`jobs/migrations/*`, `jobs/models.rs`).
  Add to `jobs`: `priority_class TEXT NOT NULL DEFAULT 'normal'` (`interactive|normal|batch`),
  `resource_class TEXT NOT NULL DEFAULT 'cpu-sandbox'`, `req_cpu INT NULL`, `req_mem_bytes BIGINT NULL`, and
  additive-nullable `study_id UUID NULL` / `run_id UUID NULL` (provenance linkage, coordinated with P4 — P3 only
  adds the columns it schedules on, not the semantics). CHECK constraints on the two vocabularies; backfill
  existing rows to `normal`/`cpu-sandbox`. Extend `Job`/`CreateJobRequest`/typed enums (text-stored like
  `JobStatus`).
- **ITEM-19**: **Class-aware dispatch + reserved interactive slots** (`jobs/scheduler.rs::dispatch_ready` +
  `repository.rs`). Replace pure-FCFS `claim_next_queued` with class-priority claiming over a **single pool**
  (`max_concurrent_jobs` cap): `interactive` jobs may use the whole pool; `normal` fills the shared pool;
  non-interactive (`batch`) is capped at `max_concurrent - reserved_interactive_slots` running, so a burst of
  batch jobs never head-of-line-blocks a just-arrived interactive re-run. **The reservation is a SOFT admission
  gate** (see DEC-B): batch MAY use the reserved slots when no interactive job is queued (avoid idle-capacity
  waste). Dispatch loop counts running per-class to honor the reservation.
- **ITEM-20**: **Per-user fair-share within a class** (`repository.rs::claim_next_by_class` /
  `claim_next_queued_fair`). Replace "oldest queued first" with an ordering keyed on **(owner's current running
  count ASC, class priority DESC, created_at ASC)** — least-recently-served / weighted-fair-queuing approximation
  so one user's (or the AI agent's chained-tool-call) burst can't starve others. In-process WFQ over the queued
  set, tracking per-owner running counts from the `jobs` table (no new table); keeps `FOR UPDATE SKIP LOCKED`.
  True cross-node WFQ deferred.
- **ITEM-21**: **Priority inference from trigger** (job-create handler / analysis-submit path). At create, the
  host stamps `priority_class`: UI interactive controls (slider re-run, DE-on-selection) → `interactive`;
  explicit "run pipeline" / an AI-agent-submitted job → `normal`/`batch` (the AI defaults to `normal` unless a
  human is actively awaiting). Extension MAY override via `schedule.class`; server infers when absent and clamps.
- **ITEM-22**: **`job_settings.reserved_interactive_slots`** (`jobs/settings.rs` + migration + route). Extend the
  singleton with `reserved_interactive_slots INT NOT NULL DEFAULT 1` (CHECK `0 <= reserved < max_concurrent`);
  expose in the existing GET/PUT settings route + admin UI field (partial COALESCE update, mirrors the cap).
  Scheduler reads it at-use with a safe fallback.
- **ITEM-23**: **Analysis job create surface** (`jobs/routes.rs`). Extend `create_job` (`POST /api/jobs`) to
  accept the analysis spec + `priority_class`/`resource_class` (validated + clamped) so an analysis run is a
  first-class job; keep the stub `job_type` path for existing tests.

### F. cgroup v2 live resource metrics + per-job caps (r2/r3 — genuinely new work)
- **ITEM-24**: **cgroup v2 live METRICS read-back** (`sandbox/cgroup.rs::CgroupScope`). Add
  `read_metrics() -> CgroupSample` reading back `<scope>/memory.current`, `memory.peak`, `pids.current`,
  `pids.peak`, and `cpu.stat` (`usage_usec` → CPU% delta between samples). **NEW code**: today `cgroup.rs` only
  *writes* (`create`/`attach_pid`/`write_controller`) and never reads, and `SandboxRunResult` carries no usage
  fields — so live metrics is a real new work item, not a wiring change. Whole-bwrap-subtree accounting, strictly
  more accurate than the single-pid `sysinfo` `ProcSampler` (which misses grandchildren).
- **ITEM-25**: **Wire cgroup metrics into the executor tick** (`jobs/runtime.rs`). The sampler tick (today
  `ProcSampler::sample()` per-pid) reads `CgroupScope::read_metrics()` when a cgroup scope exists, falling back
  to `ProcSampler` when no delegated slice (probe-gated). Persist to `job_metrics` (`cpu_pct`, `mem_bytes`;
  consider adding `mem_peak_bytes`/`pids_current` columns) + SSE metric frames so the UI shows true per-job
  memory/CPU; report `peak_metrics` in `ComputeOutcome` for the run record.
- **ITEM-26**: **Per-job resource profiles → HARD cgroup caps** (`sandbox` caps resolution). Resolve a job's
  `schedule.resources{cpu, mem}` (or a per-class default: interactive=2cpu/4Gi, batch=higher) into cgroup caps
  (`memory.max`, `memory.swap.max`, `pids.max`, `cpu.max`) + prlimit tail, **clamped to the admin ceiling** in
  `sandbox_settings` (a caller can only ask for LESS, mirroring `clamp_timeout`). The write path already exists
  (`write_controller`); this adds the class→profile→caps resolution. These HARD caps are the enforcement backstop
  (see DEC-B): any job exceeding its cap is OOM-killed by the kernel, so one runaway job can never take down the
  box or another user's job.

### G. Hand-off seams (no-op default, wired at merge)
- **ITEM-27**: **`ArtifactIngestSink` seam** (`jobs/seams.rs`, no-op default). `ingest_outputs(job,
  &[ProducedOutput]) -> Vec<ArtifactId>` — the hand-off to the P1 foundation working-store/catalog (content-hash
  + store + catalog row + run→artifact fan-out). No-op logs this round (mirrors `NoopJobSyncSink`); wired to P1's
  workstore ingest at merge.
- **ITEM-28**: **`RunRecorder` seam** (`jobs/seams.rs`, no-op default). `record_run(job, code, inputs, outputs,
  exit, timing, peak_metrics)` — the P4 provenance hand-off (content-addressed code blob + run node +
  used/generated edges). One write site (P3 hands emitted artifacts to P4's ingest, P4 records edges — no
  double-write). No-op this round; wired at the provenance merge.

### H. Hardening + tests
- **ITEM-29**: **Non-Linux degrade.** `run_analysis_streaming` + `LocalBwrapBackend` are
  `#[cfg(target_os = "linux")]`; other targets return `SERVICE_UNAVAILABLE` 503 (matching the existing
  `run_analysis` cfg split); the scheduler marks such analysis jobs `failed` with a clear reason. The mac
  libkrun-VM / win WSL2 backends are a future `ComputeBackend` impl behind the same seam, not built now.
- **ITEM-30**: **Boot-time stale-workspace sweep.** Extend the existing orphaned-running-reset at boot to sweep
  stale per-job workspace dirs (guards against disk growth if `finalize` fails before cleanup).
- **ITEM-31**: **Tests.** Unit (no external deps): `ComputeSpec`/spec parse+validate + path-injection reject;
  `inputs.json` deterministic bytes + hash-reference; manifest parse (accept/reject + escape reject); ExtraMount
  resolution; class-priority dispatch order (batch never preempts a reserved interactive slot); fair-share owner
  rotation; reserved-slot arithmetic; `clamp_timeout` reuse; cgroup metric parse (`memory.current`/`cpu.stat`
  fixtures); profile→caps clamping; reuse existing argv tests. Integration (Linux + rootfs-gated `#[ignore]`): an
  `analysis` job runs a scanpy leiden script end-to-end in the scientific rootfs → `/outputs/result.h5` +
  manifest parsed → ingest/record seams fire; interactive-vs-batch never head-of-line-blocks; fair-share across
  two owners; cancel-mid-run teardown; `job_metrics` rows populated from cgroup; non-Linux 503. Rootfs smoke:
  `python3 -c "import scanpy"` inside the mounted rootfs.

---

## Files / modules

Create:
- `server/src/modules/sandbox/backend/mod.rs` — `ComputeBackend` trait, `ComputeSpec`, `ComputeOutcome`/
  `LaunchedCompute`, `ProgressSink`, `ResourceProfile`, `PriorityClass`, `ResourceClass`, `BackendAvailability`.
- `server/src/modules/sandbox/backend/local_bwrap.rs` — `LocalBwrapBackend` + `BackendRegistry`.
- `server/src/modules/sandbox/streaming.rs` — `run_analysis_streaming`/`run_in_sandbox_spawn` + FIFO drain.
- `server/src/modules/sandbox/spec.rs` — `ComputeSpec`/analysis-spec parse+validate + path-injection guard +
  `build_spec`.
- `server/src/modules/sandbox/inputs.rs` — `materialize_inputs`, `MaterializedInput`, `inputs.json` writer.
- `server/src/modules/sandbox/outputs.rs` — the canonical `OutputsManifest`/`OutputEntry` types (A1 — the single
  source imported by P1/P2/P4), `parse_manifest`, content-hash + ingest bridge.
- `server/src/modules/jobs/migrations/2026072xxxxx_jobs_scheduling_classes.sql` — `priority_class`,
  `resource_class`, `req_cpu`, `req_mem_bytes`, `study_id`, `run_id`, CHECKs, index;
  `job_settings.reserved_interactive_slots`; (optional) `job_metrics.mem_peak_bytes`/`pids_current`.
- Tests under `server/tests/jobs/` + `server/tests/sandbox/` + a rootfs smoke.

Modify:
- `sandbox/sandbox.rs` — factor shared setup; add streaming spawn; `build_bwrap_argv` `progress_fifo_src` param
  (+ progress bind). Reuse existing `ExtraMount`/prlimit/network-block.
- `sandbox/service.rs` — expose the spawn-shaped entry (no auto-workspace-removal on the analysis path); keep
  batch `run_analysis` single-shot.
- `sandbox/cgroup.rs` — add `read_metrics()`.
- `sandbox/types.rs` / `sandbox/mod.rs` — spec-adjacent types; expose new submodules.
- `jobs/runner.rs` — `SandboxJobRunner`, `DispatchRunner`, `SpawnedJob{guards, workspace}`, `finalize`; keep
  `StubJobRunner`.
- `jobs/scheduler.rs` — class-aware + fair-share dispatch, reserved slots, hold+drop guards, post-exit finalize.
- `jobs/repository.rs` — `claim_next_by_class`/`claim_next_queued_fair`, per-owner + per-class running counts.
- `jobs/runtime.rs` — cgroup-metric sampling in the executor tick.
- `jobs/models.rs` — `PriorityClass`/`ResourceClass`, resource fields, analysis-params mirror,
  `reserved_interactive_slots`.
- `jobs/settings.rs` — reserved-interactive-slots getter.
- `jobs/seams.rs` — `ArtifactIngestSink` + `RunRecorder` seams + install.
- `jobs/routes.rs` — analysis create fields + priority inference; reserved-slots settings field.
- `jobs/mod.rs::init` — build backend/`DispatchRunner`, install seams, swap `StubJobRunner`→`SandboxJobRunner`.
- `rootfs/Dockerfile` — scientific stack + import smoke.
- `rootfs/version.rs` + `build_helper/sandbox_rootfs.rs` — `ROOTFS_SCHEMA_VERSION` 1→2 + build-arg/larger-image.
- job-create/analysis-submit handler — priority inference.

Untouched (reused as-is): `build_bwrap_argv` core mapping (ExtraMount RO/RW → --ro-bind/--bind, prlimit,
`--unshare-net`), `sandbox/probes.rs`, `sandbox/settings.rs` limits, `rootfs/embedded.rs`+`mount.rs`, the
docker-build→`include_bytes!`→lazy-mount pipeline, `jobs/sse.rs` (SSE bus), `jobs/seams.rs` sync/notify idiom.

## Reuse
- **`modules/jobs`** — extend the REAL FCFS queue/executor/repository/settings/SSE/cancel-registry/`job_logs`/
  `job_metrics`; do NOT rewrite. §4.1.1 calls the class scheduler "a generalization of the existing FCFS jobs
  module, not a new subsystem." The `seams.rs` OnceLock no-op idiom is the template for `ArtifactIngestSink`/
  `RunRecorder`; `StubJobRunner` kept for `stub` jobs.
- **`modules/sandbox`** — `run_in_sandbox` setup (identity/`CgroupScope`/`SeccompPipe`/`ensure_ready`/caps
  promotion/`clamp_timeout`), `build_bwrap_argv` + `ExtraMount`/`MountMode`, `service::run_analysis`, `probes`,
  `config` are all built; P3 adds only the streaming spawn + cgroup read + drives it from jobs.
- **`modules/rootfs` + build_helper** — docker-build→embed→lazy-squashfuse-mount pipeline + `format_version`/
  `is_fresh` schema gating; P3 only extends the Dockerfile manifest + bumps schema.
- **`modules/dataset` + `txresbench-file`** — content-addressed blob storage the working store (P1's) reads/writes
  through.
- **txresbench `code_sandbox`** (SDK reference, forked into `sandbox/`) — prior art for the streaming child-driving
  shape, the `progress_fifo` notifications pattern (ITEM-5), and cgroup-scope idioms; `ComputeBackend`/
  `SandboxBackend` seam naming mirrors it.
- **txresbench-auth `session_settings.rs`** — singleton partial-update idiom for reserved-slots.
- **DATA_MODEL `produces` manifest + provenance §B3.1** `inputs.json`/code-blob contract — the exact wire
  contract implemented.

## Dependencies
- **P1 data-foundation (KEY / BLOCKING for the contract tail)** — working store + `analysis_results` catalog +
  local-FS content-addressed object store. ITEM-14 resolves `requires` artifact ids → blobs *through P1*;
  ITEM-15/27 ingest `/outputs` *through P1*. Built as no-op seams so P3 lands + tests independently; real ingest
  wired at merge. Without P1, P3 can run a sandbox but has nowhere to source inputs or land typed outputs.
- **P4 provenance** — content-addressed code blobs (ITEM-16 executes P4's blob at `/code/entry.*`) +
  run-node/edge recording (ITEM-28 hands off the manifest/inputs.json/code-ref; P4 owns the graph tables + the
  `study_id`/`run_id` values on the jobs row). Coordinate the `inputs.json` schema (it is also provenance's
  reproduce input) and the single run-record write chokepoint.
- **P2 datatype-system** — the `datatype` vocabulary in `inputs.json`/manifest (`expression`/`embedding`/…) that
  fills the canonical `OutputEntry.datatype`/`layout` fields (A1); P3 references datatypes, doesn't define them
  (P2 validates them against its live registry). Determines how inputs materialize as files.
- **P5 contribution-api** — the `run:{kind:sandbox}` + `schedule:{class,resources}` manifest an extension
  declares (ITEM-13 job payload) is P5's declarative surface; P3 consumes the resolved spec.
- **P11 three-modules** — the first real analysis specs (data.process / embedding.umap / clustering.leiden)
  exercise the contract + validate ITEM-11's package set (leiden/harmony) is sufficient.
- Host deps for the integration tier: bubblewrap + squashfuse + the schema-v2 rootfs built (docker at build
  time). Unit tests need none. No new crate; no dependency on the workbench shell/viz/contribution UI or P5–P10
  for the local compute path.

## Sequencing
1. **cgroup metrics (ITEM-24, ITEM-25)** — self-contained, no P1 dep; ship first to prove read-back.
2. **Scientific rootfs (ITEM-11, ITEM-12)** — parallel, long docker build; start early. `cargo clean` after the
   schema bump.
3. **Spine — streaming + backend seam (ITEM-1..5, ITEM-8, ITEM-9, ITEM-10, ITEM-17)** — needs no P1 (can run a
   fixed command with no inputs/outputs); the streaming-spawn factor + FIFO port is the real work.
4. **Scheduling (ITEM-18..23, ITEM-26)** — layer over the queue; independent of the contract (migration →
   dispatch/claim rewrite → fair-share → settings → profiles→caps).
5. **Contract wiring (ITEM-13, ITEM-14, ITEM-15, ITEM-16)** — **gated on P1** (catalog + working store); the
   hash/materialize/manifest logic itself is contained. Seams (ITEM-27, ITEM-28) no-op so testable before merge.
6. **Runner switch (ITEM-3, ITEM-4, ITEM-7)** — flip `StubJobRunner`→`SandboxJobRunner` after 3+5 are green so
   nothing regresses the proven queue.
7. **Harden (ITEM-6, ITEM-29, ITEM-30)** then **tests (ITEM-31)** — unit throughout; integration/rootfs tiers
   gated on the rootfs build. Ingest/provenance seam wiring to P1/P4 happens at merge.
   Critical-path dependency: **P1 data-foundation** — front-load metrics + spine + scheduling + rootfs before it.

## Decisions
- **DEC-A (rootfs toolchain):** use **micromamba/conda-forge** for the pinned scientific Python stack
  (self-contained, deterministic pins, avoids llvmlite/BLAS pip-from-source build pain) over apt+pip. R stays
  r-base-core. (r1 committed micromamba; r2/r3 left it open — resolved to micromamba, with a pinned
  `--require-hashes` pip venv as the acceptable fallback if a package is conda-forge-absent.)
- **DEC-B (reservation SOFT + per-job caps HARD — resolves the r1↔r2 divergence flagged in DIFF_R1_R2.md):**
  **BOTH layers, on their correct axis.** (1) **HARD enforcement = per-job cgroup v2 caps** — `memory.max`/
  `memory.swap.max`/`pids.max`/`cpu.max` written per job (ITEM-26), already the code_sandbox pattern; any job
  exceeding its cap is OOM-killed by the kernel, so one runaway job can never take down the box or another user's
  job. (2) **SOFT admission control at the scheduler** — slot-based reservation (K reserved interactive slots + a
  concurrency cap, ITEM-19) that does NOT admit a job whose reservation would exceed the free pool, but batch MAY
  use the reserved slots when no interactive is queued (no idle-capacity waste); there is **no aggregate
  host-memory admission gate**, because on a shared 1-box we cannot reliably predict a scanpy job's peak memory
  before it runs (a hard aggregate gate would either idle the box on over-declaration or lie on
  under-declaration). This is the correct 1-box multi-user split: **soft where prediction is impossible
  (admission), hard where the kernel can enforce (per-job caps).** It matches how the code is already shaped —
  but note the actual gap: **`cgroup.rs` writes caps yet never reads metrics, and `SandboxRunResult` carries no
  usage fields**, so the HARD-cap *write* exists while **live metric read-back (ITEM-24) is a genuinely NEW work
  item**, not a wiring change. (r1's DEC-E hard-reserve and r2's soft-reserve are reconciled: reservation is
  soft, caps are hard.)
- **DEC-C (metrics source):** cgroup `memory.current`/`memory.peak`/`cpu.stat` (whole bwrap subtree) is the
  PRIMARY source; single-pid `ProcSampler` (sysinfo) is the probe-gated fallback only when no delegated cgroup-v2
  slice is available. Single-pid sysinfo undercounts grandchildren.
- **DEC-D (`ComputeBackend` distinct from `JobRunner`):** `ComputeBackend` is the §4.1.2 topology seam;
  `SandboxJobRunner` implements the queue's `JobRunner` and *delegates* to a `dyn ComputeBackend`
  (`LocalBwrapBackend`). Keeps the proven queue untouched; "run elsewhere" is a backend swap, no rewrite.
- **DEC-E (job-type dispatch via `DispatchRunner`):** route on `Job.job_type` (`stub`→stub, `analysis`→sandbox),
  not a global registry — minimal, matches the two current types.
- **DEC-F (streaming reconciliation):** keep BOTH paths — batch `run_in_sandbox`/`run_analysis`
  (ad-hoc REST `execute`, capture-and-return) AND streaming `run_analysis_streaming` (jobs, executor-driven).
  The jobs executor (not the sandbox) drives log-drain/metric/cancel — one drive loop, one runner contract.
  `SpawnedJob` carries an opaque `guards: Box<dyn Send>` (cgroup scope + seccomp pipe + workspace) that outlives
  the child for its whole life, dropped when the executor finishes.
- **DEC-G (workspace lifecycle):** the analysis path ingests `/outputs` BEFORE workspace cleanup (`finalize`
  hook); the analysis job's OWN id is the `SandboxContext.job_id` so cgroup + provenance line up. Unlike the
  batch REST path, which deletes the workspace immediately.
- **DEC-H (code location):** the entry script is a **content-addressed blob mounted read-only at `/code/entry.*`**
  (r1's model — P4-owned, hashed) as the target; params+seed are baked in the script body so `code_sha256`
  fingerprints template+params (provenance §B3.1). The workspace-staged-`script.py`/`.R` variant (r2) is the
  acceptable transition fallback until P4's blob store lands; `inputs.json` binds paths only in either case.
- **DEC-I (`inputs.json` = content-HASH reference, path-agnostic):** references inputs by content hash + kind,
  not path, even on 1-box where materialize = local hard-link — the same code path a remote backend fetches
  through; reproducible-anywhere. `inputs.json` is DERIVED (slots→mounts for a run), never authoritative.
- **DEC-J (scheduling model):** single pool, three priority classes `interactive|normal|batch`, one
  `resource_class` `cpu-sandbox` (gpu/highmem/cluster are future rows behind the open seam). Reserved interactive
  slots (soft) + per-user weighted-fair claim ordering (owner running-count, class priority, created_at) — WFQ
  approximation, true cross-node WFQ deferred. Near-FCFS on desktop (1 user, cap 1-2).
- **DEC-K (outputs contract — A1 canonical):** `/outputs/manifest.json` is the **P3-owned** canonical
  `OutputsManifest { outputs: [OutputEntry{id, datatype, path, layout, role}] }` (serde-serializable; P1/P2/P4
  import it, never redefine — see the Reconciliation section + ITEM-15); missing on exit-0 = a contract violation
  that fails the job. Ingest + provenance are no-op seams, NOT implemented in P3.
- **DEC-L (contract ownership split):** P3 owns execution + `inputs.json`/`/outputs`-manifest mechanics + the
  ROOTFS + scheduling; P1 owns catalog ingest; P4 owns the code-blob store + run-node recording. The
  `ArtifactIngestSink`/`RunRecorder` seams are the boundary. `study_id`/`run_id` are additive-nullable columns
  only; P3 does not define provenance semantics.
- **DEC-M (rootfs single embedded flavor):** one embedded scanpy flavor (no multi-flavor now); schema bump gates
  re-embed; a lazy-fetch seam for the heavy scientific layer is a later consideration (see Risks).
- **DEC-N (non-Linux):** analysis jobs 503 (sandbox is Linux-only); the scheduler marks them `failed` with a
  clear reason. mac libkrun-VM / win WSL2 are future backends behind the same seam.

## Risks / unknowns
- **Rootfs embed size (HIGH).** scanpy/anndata/leiden/harmony ≈ 1.5–2 GB → `include_bytes!` bakes it into the
  binary (multi-GB binary + heavy link/memory + slow build; squares with the "worktree needs hub-seed copied"
  pain point). Mitigate: aggressive zstd squashfs (already), micromamba `--strip`/no-tests, `--no-install-
  recommends`, strip caches; may justify a lazy-fetch seam or a "minimal vs full" flavor for the scientific layer
  later (minimal layer stays embedded). Out of scope now.
- **Streaming spawn / guard-lifetime fiddliness (MED).** Carving a spawn variant out of `run_in_sandbox` while
  keeping the REST path byte-identical and preserving cgroup/seccomp/workspace Drop-lifetime past the child is
  fiddly; the `guards: Box<dyn Send>` holder is the mechanism — verify no fd/scope leak.
- **cgroup metrics/caps degrade without delegation (MED).** On an unprivileged desktop with no delegated cgroup-v2
  slice, hard caps + metrics degrade to prlimit-only + single-pid sysinfo (approximate). Probe-gated fallback
  (ITEM-25), documented; hard caps become best-effort exactly where the OS can't enforce.
- **Network-blocked provisioning (MED, mitigated).** `--unshare-net` means the rootfs must be 100% baked at build
  time — any run-time pip/CRAN fetch fails silently; leiden needs `python-igraph`+`leidenalg` C-extensions
  present. Good (already blocked) but constrains ITEM-11 to a complete manifest.
- **bwrap cancel semantics (MED).** Confirm SIGTERM/SIGKILL on the bwrap parent reaps the `--as-pid-1` bash
  grandchild (pid-ns teardown) + closes the cgroup/seccomp fds; Tier-4 cancel test (ITEM-6).
- **Ingest/provenance seams unbuilt (MED).** The END-TO-END artifact→catalog→graph path can't be
  integration-verified until P1/P4 land; end-to-end value gated on merge. Mitigate: no-op capturing seams +
  assert the seam fires with the right outputs in tests.
- **Fair-share SQL / starvation edge cases (LOW-MED).** The per-owner running-count claim under
  `FOR UPDATE SKIP LOCKED` at the poll must stay correct under concurrent dispatch; naive round-robin can starve
  a single-job user behind a many-job user with wrong weights. Mitigate: least-recently-served ordering +
  window-function/skip-locked interplay test.
- **Streaming back-pressure (LOW).** A chatty script flooding stdout could overwhelm the SSE/log insert path.
  Mitigate: reuse the jobs module's existing log cap + SSE subscriber cap; drop-oldest on the FIFO drain.
- **Workspace disk growth (LOW).** If `finalize` fails before cleanup → orphaned per-job dirs. Mitigate:
  boot-time stale-workspace sweep (ITEM-30).
- **Schema-bump / stale-rootfs mismatch (LOW).** Forgetting the `ROOTFS_SCHEMA_VERSION` bump ships a stale
  rootfs. Mitigate: `format_version` includes the Dockerfile sha8 → `is_fresh` catches a content edit even
  without a manual bump; the boot mount-probe refuses a mismatch. Document `rm -rf` + `cargo clean`.
- **`study_id`/`run_id` column ownership (LOW).** Overlaps P4 provenance — additive-nullable columns only; do not
  define provenance semantics here.

## Effort
**Medium-Large (~5–8 focused days)** — the queue/executor/argv/mount/rootfs-pipeline scaffolding all EXISTS; P3
is integration + policy, not greenfield. Front-loadable: metrics + spine + scheduling + rootfs proceed before P1;
contract + runner-swap land after P1.
- Spine — streaming spawn + backend seam + FIFO (ITEM-1..10, 17): ~1.5–2 d (the guard-lifetime refactor + FIFO
  port is the real work).
- Scheduling classes + fair-share + profiles→caps (ITEM-18..23, 26): ~1.5 d (bounded change to one claim query +
  dispatch loop + settings).
- cgroup live metrics (ITEM-24, 25): ~S (read/parse 4 sysfs files + fallback wiring — but genuinely NEW code).
- Scientific rootfs (ITEM-11, 12): ~1–2 d WALL (docker build cycles + size tuning; mostly waiting), ~S code.
- Contract (ITEM-13..16): ~1.5 d, **gated on P1**; hash/materialize/manifest logic itself contained.
- Seams + hardening + tests (ITEM-27..31): ~1 d.
Unit-testable in-tree (spec/argv/class/fair-share/manifest-parse/cgroup-parse/caps-clamp); the bwrap-driving +
rootfs-import tiers need a Linux box with docker + squashfuse (mirrors the existing sandbox Tier-4 gating).

## Saturation
r3 was NOT redundant: beyond r1∪r2 it contributed three substantively new items that r1/r2 lacked — the
**progress-FIFO structured-progress plumbing** (ITEM-5, ported from code_sandbox's proven pattern; neither r1 nor
r2 had streamed structured `notifications/progress` frames, only log lines), **cgroup metrics elevated to a
read-back API + wired into the executor tick with per-job resource profiles** (ITEM-24/25/26 — r2 named the
cgroup-metric idea but r3 pinned it to a concrete `CgroupScope::read_metrics()` surface, `memory.peak`/`pids`
fields, and a class→profile→caps clamp), and most importantly the **explicit soft-admission / hard-cap decision
that RESOLVES the exact r1↔r2 divergence the DIFF flagged** (DEC-B). r3 also grounded the "cgroup.rs writes but
never reads / `SandboxRunResult` has no usage fields" fact that makes live metrics a real new item. Everything
else in r3 (ComputeBackend seam, streaming spawn, inputs.json/manifest contract, ExtraMount, scientific rootfs,
class + fair-share dispatch) re-derived r1∪r2 with no new substance. The three rounds have now converged on one
integration-not-greenfield architecture, the single open behavioral conflict (soft vs hard reserve) is resolved,
and no round introduced a new axis the others missed. A fourth round would re-derive the same plan.
SATURATION: REACHED
