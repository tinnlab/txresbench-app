# P3 compute-scheduling — R1 vs R2 convergence diff

## Substantively new in r2 (not in r1)
- **cgroup-sourced job metrics (r2 ITEM-15).** When a cgroup scope exists, sample `memory.current` +
  `cpu.stat` from the scope instead of the bwrap-pid `ProcSampler` tree (which undercounts
  grandchildren), falling back to `ProcSampler` when no cgroup. r1 keeps pid-based `ProcSampler` and
  never flags the undercount — a genuinely new work item + correctness fix absent from r1.
- **Soft interactive reservation (r2 decision + ITEM-10 / Risks).** r2 makes the reserved
  interactive slots a **soft** cap — batch may use reserved slots when no interactive job is queued,
  to avoid idle-capacity waste. r1's DEC-E is a **hard** reserve (batch capped at `cap - reserve`
  unconditionally). A real behavioral either/or that conflicts between the plans.
- **`study_id`/`run_id` nullable columns added to `jobs` (r2 ITEM-9)** for provenance linkage
  (coordinated with live8). r1 adds only `job_class`/`resource_class`; it does not put study/run
  columns on the jobs row.
- **Explicit path-injection guard in the spec parser (r2 ITEM-1):** reject absolute/`..`/
  non-`/inputs|/outputs` sandbox subpaths at `AnalysisSpec` parse. r1 validates the outputs manifest
  but does not call out an input-slot path-injection guard.

## Substantively new in r1 (not in r2)
- **Firm micromamba/conda-forge rootfs decision (r1 DEC-A / ITEM-9).** r1 commits to micromamba to
  avoid llvmlite/BLAS source builds; r2 leaves it open ("pinned pip venv (or micromamba)"). A
  resolved toolchain decision on one side only.
- **Content-addressed code blob mounted read-only at `/code/entry.*` (r1 ITEM-13).** r1 makes the
  entry script a hashed P4-owned blob fetched to a stable RO `/code` bind; r2 stages `script.py`/`.R`
  into the workspace root with params/seed baked in the body. A genuine difference in where code
  lives and how it's addressed.
- **Dedicated cancellation-correctness item + Tier-4 cancel test (r1 ITEM-5).** r1 elevates
  "confirm SIGTERM/SIGKILL on the bwrap parent reaps the `--as-pid-1` grandchild + closes cgroup/
  seccomp fds" to its own verified item; r2 folds cancel into reuse/tests only.

## Shared substance
Both independently derived the same integration-not-greenfield plan: a **streaming spawn variant**
(`run_in_sandbox_spawn`/`spawn_analysis`) factored out of the batch `run_in_sandbox` so the jobs
executor drives a live piped `Child` while the batch REST `run_analysis` path stays intact; a
**`SpawnedJob` extended with an opaque `keepalive`/`guards: Box<dyn Send>`** holding cgroup scope +
seccomp pipe + workspace so they outlive the child; a **`SandboxJobRunner: JobRunner` dispatched on
`job_type`** (stub kept, analysis→sandbox), closing the no-job-type-dispatch gap; the
**`ComputeBackend` trait above `JobRunner` with `LocalBwrapBackend` as the only arm** (GPU/HPC/remote
typed-unavailable behind the open seam); the **`inputs.json` path-agnostic contract** (slots→mounts,
params/seed baked in the script) + **`ExtraMount` RO `/inputs` / RW `/outputs`** + **`/outputs/
manifest.json` `{id,type,from}` parse** (missing on exit-0 = contract violation); **workspace
survives past exit until outputs are ingested, then best-effort cleanup** (unlike the batch path);
**two no-op hand-off seams** to the foundation catalog-ingest and to provenance run-node/code-blob
recording, wired at merge; **class-aware + per-user fair-share dispatch** replacing FCFS
(`interactive` priority + `reserved_interactive_slots`, claim ordered by owner-running-count then
FCFS, `FOR UPDATE SKIP LOCKED`); **`job_settings.reserved_interactive_slots`** with partial-update
route; and the **scientific rootfs** (scanpy/anndata/leidenalg/harmonypy + numpy/scipy/igraph, fully
baked because `--unshare-net`, build-time import smoke, `ROOTFS_SCHEMA_VERSION` bump + cargo-clean).
Risks match: multi-GB rootfs embed size (HIGH), spawn/guard lifetime fiddliness, network-blocked
provisioning, ingest/provenance gated on merge, non-Linux 503.

## Verdict
VERDICT: DIVERGED — needs r3 (cgroup metrics + soft-vs-hard reserve conflict)
