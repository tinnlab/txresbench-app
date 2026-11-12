# AUDIT — Deployment scope + reuse reality (blind pass over all 11 FINALs)

Checked against `BUILD_PLAN.md` deployment-scope table (desktop + single-box server ONLY; build the
local arm behind open seams; do NOT build the distributed arm; do NOT close the seams).

Worktrees consulted: analysis-workflow-wt (feat/analysis-workflow), visualization-wt (feat/visualization),
txresbench (main @ 63520fb), txresbench (host SDK).

---

## Scope violations (build-distributed-now)

**NONE.** Every part explicitly scopes to desktop + single-box and builds only the local arm:

- **P1** — `ObjectStore` trait, `get_range(key, byte_range)` S3-byte-range-shaped from day one, but
  `object_store/s3.rs` is a compiled `todo!()` stub (not built); local-FS is the only impl. ✓
- **P3** — `ComputeBackend` seam with `LocalBwrapBackend` the only implemented backend;
  `Gpu`/`Highmem`/`ClusterBatch` + `RemoteWorkerBackend`/`HpcBackend` are `// SEAM` TODO variants
  routing to a typed `BACKEND_UNAVAILABLE`. Scheduling = single pool + interactive/normal/batch +
  per-user fair-share (exactly the 1-box scope); `ResourceClass`/`PriorityClass` present so later
  pools/GPU are future ROWS, not a schema change. Non-Linux → 503; mac/win backends explicitly not built. ✓
- **P2** — local-FS `storage_ref`; MinIO/S3 a later P1 swap behind the same ref (DEC-12). ✓
- **P4** — desktop/1-box; verify re-runs on the local bwrap sandbox; DOI (Zenodo/DataCite) is the ONLY
  outbound call, off by default; remote/HPC verify deferred behind the same seam (DEC-SCOPE-DEPLOY). ✓
- **P5** — external manifest loader + sidecar gateway explicitly DEFERRED (ITEM-33, seam only); data
  API contract = "single-box = local-FS range server, same code path a future MinIO/worker uses." ✓
- **P6/P7/P8/P9/P10/P11** — all local; P10 gates sharing/transfer off on desktop; P9 "no remote/cluster." ✓

## Closed-seam violations (future-proofing regressions)

**NONE.** No part hard-codes a local assumption that closes a seam the design says to keep open. The
recurring discipline is correct: content-addressed keys + `inputs.json` by content-HASH (not path) even
on 1-box where materialize = local hard-link (P3 DEC-I), the `ObjectStore`/`ComputeBackend`/`LayoutSlicer`
traits exist with only the local arm filled, and `s3.rs`/remote-backend variants are compiled stubs. This
is "keep the seam, ship the simple case," exactly as the BUILD_PLAN mandates.

## Reuse claims verified (the load-bearing ones — all REAL)

live3 `feat/visualization` (visualization-wt) — every cited symbol/file exists:
- `adapter/Coordination.store.ts` (Coordination store) ✓
- `viz-core/data/selection.ts` (IndexMask + selectInBox/selectInPolygon) ✓
- `viz-core/grid/CellView.tsx` (closed `switch(cell.kind)`) ✓; `gridModel.ts` (`CellKind` union) ✓;
  `CellChrome.tsx` (`CELL_KIND_OPTIONS`) ✓
- `viz-core/conformance/{invariants.ts, viewKindBattery.test.ts}` ✓
- `viz-core/selection/SelectionController.ts`, `showcase/registry.ts`, `DeckScatterCanvas.tsx`,
  `gridSelection.ts` (selectInPolygon) ✓

live8 / txresbench main — every cited symbol exists:
- `study/models.rs` `EffectivePermission` + `repository.rs` `effective_permission` ✓
- `STUDY_EXTENSIONS` + `delete_study_with_extensions` + `on_study_deleted` (study/lifecycle.rs,
  core/extension/registry.rs) ✓
- `dataset/study_extension/{extension,repository,...}.rs` (the copy template) ✓
- `jobs/runner.rs` `JobRunner`/`StubJobRunner` ✓; `sandbox/{sandbox,service,types}.rs`
  `build_bwrap_argv`/`run_analysis`/`ExtraMount` ✓; `rootfs/version.rs` ✓
- `feat/provenance` recipe model = design-only (`.lifecycle/` only) — P4/P8/P10 describe it correctly. ✓

txresbench host SDK:
- `code_sandbox/{mod,mount_provider,cgroup}.rs` bwrap + cgroup ✓
- `control_mcp/{catalog,tools,policy}.rs` ✓ (in-tree module) AND SDK crate
  `sdk/crates/txresbench-control-mcp/src/{catalog,policy,tools}.rs` ✓
- `openapi/emit_ts.rs` `types_ts_parity` golden test ✓
- `txresbench-framework::mcp` (envelope + `loopback_host`) — `sdk/crates/txresbench-framework/src/mcp.rs` ✓

interface-round `analysisRegistry` (analysis-workflow-wt):
- `modules/analysis/{registry.ts, types.ts}`, `standardRecipe`, seed plugins
  (qc-filter/normalize-lognorm/pca/umap/leiden/harmony/markers-wilcoxon/annotation-reference) ✓

## Reuse claims BROKEN / misdescribed

**1 issue — P1's "txresbench-file / raw upload is greenfield" grounding is stale relative to main.**

P1 FINAL grounding states: *"sdk/crates/txresbench-file … is NOT yet even a server dependency"* and
*"wiring the raw input upload in (dep + migrations + init_file_storage + a multipart receiver, which
exists nowhere server-side)."* P4 ITEM-5 similarly calls upload *"a checksum-less stub today →
greenfield."*

Reality: the analysis-workflow-wt branch (`feat/analysis-workflow`) is **behind txresbench main**. Its
merge-base with main is `587ca916`; main's tip is `63520fb "Merge feat/sdk-adopt-backend: adopt
txresbench-health + txresbench-file (real dataset upload)."` On the branch tree, `txresbench-file` is indeed absent from
`src-app/server/Cargo.toml` and `lib.rs` — so P1's statement is literally true *on its own stale tree*.
But on **main**, `txresbench-file` IS a server dependency (`server/Cargo.toml:47`) with a REAL dataset upload
path, and P10 correctly cites *"txresbench-file CAS blob store (adopted on main, 8045d78)"* while P11 ITEM-7
assumes `api.files.upload` exists and P2 grounds itself on *"main 63520fb."*

So P1 (and P4 ITEM-5) **under-claim existing reuse** and over-scope the upload/multipart work as
greenfield because they were grounded on a worktree behind main. Not a nonexistent reuse claim — the
opposite: a real, already-merged capability described as not-yet-built. This is the known "stale tree
denies merged code" failure mode. **Fix at implementation:** re-ground P1/P4's upload + txresbench-file
sections against main (rebase feat/analysis-workflow onto main / 63520fb) so P1 doesn't re-build the
multipart receiver + `init_file_storage` wiring that main already ships; reconcile the P1↔P10↔P11
upload-ownership split accordingly.

## Verdict

Scope discipline is **clean** across all 11 parts — no distributed/remote/HPC/MinIO/multi-pool
machinery is built now, and no seam is closed. Load-bearing reuse claims all point at code that really
exists. The single defect is a **stale-base grounding inconsistency**: P1/P4 treat txresbench-file + raw
upload as greenfield, contradicted by txresbench main (63520fb) and by P2/P10/P11 which are grounded on
the newer main. Re-ground before implementation.

**1 issue (reuse-grounding, non-fatal).**
