# P1 data-foundation — R1 vs R2 convergence diff

## Substantively new in r2 (not in r1)
- **Dedicated Object GC subsystem (r2 ITEM-12, `gc.rs`).** A boot-time + periodic sweep that
  reclaims content-addressed blobs referenced by no live table, explicitly sweeping the **union**
  of all referencing tables (`analysis_results` + `ziee-file` + P4 run-artifact links). r1 only
  reference-counts at delete time inside the cascade (ITEM-10) — no standing GC sweep item.
- **Single-`artifacts`-table framing pushed onto P1↔P2.** r2 keeps `datatype`/`storage_layout` as
  plain string columns and frames the catalog as the future unified `artifacts` table; a minor
  stance difference, but it changes the P2 seam.

## Substantively new in r1 (not in r2)
- **Canonical axes subsystem: cell/gene registry + dense view-index (r1 ITEM-3, `axes.rs` +
  `workstore_cell_gene_axis` migration).** A whole alignment-key component — `system_cell_id`
  (study-unique, stable, not the input barcode), durable `(sample_id, cell_local_index)` identity,
  a dense view-index `0..M-1` with prefix-sum `base_S` sample offsets, a sample→`[start,end)` range
  map, bitmask set-ops, and NA-fill-outside-covered-cells alignment. This is the mechanism r1 says
  "makes every job's analyses merge with zero conflict." **r2 has no equivalent** — it carries only
  a `covered_scope`/`covered_axes` JSONB reference, not an ID registry or view-index. Real
  architectural component + its own migration + its own unit tests, absent from r2.

## Shared substance
Both independently derived the same critical-path spine: a new content-addressed **local-FS
ObjectStore trait** (S3/MinIO behind the seam, `get_range` as the primitive, merkle/manifest hash
for multi-file artifacts), a Postgres **`analysis_results` catalog** keyed by surrogate uuid +
study-scoped natural key with `run_id`/layout/`object_key`/`shape`/`params`/status columns, an
**ingest write-path** consuming a P3-co-owned `/outputs` produces-manifest (undeclared files not
promoted, one run → N artifacts), a **JSON control plane** + **raw-typed-array binary data plane**
(ArrayBuffer, not Arrow/JSON-of-numbers), **authed study-scoped HTTP-Range/206 serving** (not a
static file server, not routed through uploads-only `ziee-file`), a **frontend thin binary client**
working around the FE-10 `emit_ts` gap (flag `responseType` to the SDK, deferred), the
**OpenAPI-honest octet-stream `OperationOutput`** keeping `types_ts_parity` green, **study-scoped
sync + `on_study_deleted`/`on_study_duplicated` cascade**, config/boot wiring under `<app_data>`,
and the same decisions (Zarr+Parquet not server-sliced HDF5; sha256/blake3 content-addressing;
generic-layout-not-domain; auth on every byte). The reuse targets (`ziee-file` hardening/download
token, `dataset` sqlx pattern, study `effective_permission`, sync) match.

## Verdict
VERDICT: DIVERGED — needs r3 (r1's canonical-axes/view-index subsystem absent from r2)
