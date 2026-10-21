//! **The gather serve path AT SCALE — read amplification and per-chunk latency.**
//!
//! Every committed gather fixture is 5 rows in ONE chunk, so the shape of the serve path at a
//! realistic column size was measured by nothing: a single-chunk column cannot exhibit
//! amplification, because there is nothing to repeat.
//!
//! This file builds a synthetic scene at [`SCALE_ROWS`] rows (the production
//! [`CHUNK_ELEMENTS`] is 4096, so that is >100 chunks) and measures the two numbers that
//! decide whether the serve path needs a cache and, if so, WHAT it should cache:
//!
//! * **Read amplification** — total bytes fetched from the object store to serve every chunk
//!   once, over the bytes ONE pass would need. Measured in-process at the store seam with a
//!   counting [`ObjectStore`] decorator, because that seam is exact and deterministic: it is
//!   not an estimate, and it does not vary with box load. `gather_exec::resolve` takes its store
//!   as a parameter precisely so it can be driven this way.
//! * **Per-chunk latency** — measured over the REAL route
//!   (`GET /artifacts/{id}/data/values/c/{n}`) against a real server, because latency is a
//!   property of the path and not of a function.
//!
//! The two are deliberately measured at different seams. A latency number alone cannot say
//! WHERE the time went, and a byte count alone cannot say whether it matters.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::ResolvedGather;
use cytoanalyst::modules::workstore::gathered::{ResolutionCache, CHUNK_ELEMENTS};
use cytoanalyst::modules::workstore::object_store::{
    BlobLink, ByteStream, ContentKey, GcReport, MultiFilePut, ObjectStat, ObjectStore,
};

use crate::common::TestServer;

use super::{create_project, pool_for, server_store, setup_admin};

/// Output rows in the synthetic scene.
///
/// ≥ 500k by the brief, and it is the smallest number that makes the question real: at
/// [`CHUNK_ELEMENTS`] = 4096 this is 123 chunks, so a whole-column scan is 123 requests and
/// any per-request whole-column work is repeated 123 times.
/// The axis this scale scene's SOURCE stores declare — one constant, so the sources and the
/// gathered declaration built over them cannot drift. The creator derives the gathered axis
/// from exactly this (`source_axis`).
const SCENE_SOURCE_AXIS: &str = "rows";

const SCALE_ROWS: usize = 500_000;

// ════════════════════════════════════════════════════════════════════════════
//  A COUNTING STORE — the exact seam amplification is defined at
// ════════════════════════════════════════════════════════════════════════════

/// Wraps a real store and counts what the gather actually pulls through it.
///
/// Deliberately a DECORATOR over the production `LocalFsStore` rather than a fake: a fake
/// would measure the cost of the fake. Only the two methods the gather reaches are counted;
/// the rest delegate.
struct CountingStore<S: ObjectStore> {
    inner: S,
    gets: AtomicU64,
    bytes: AtomicU64,
}

impl<S: ObjectStore> CountingStore<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            gets: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        }
    }
    fn reset(&self) {
        self.gets.store(0, Ordering::SeqCst);
        self.bytes.store(0, Ordering::SeqCst);
    }
    fn gets(&self) -> u64 {
        self.gets.load(Ordering::SeqCst)
    }
    fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl<S: ObjectStore> ObjectStore for CountingStore<S> {
    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, ziee_core::AppError> {
        self.inner.put(bytes).await
    }
    async fn put_prefix(
        &self,
        members: &[(String, Vec<u8>)],
    ) -> Result<MultiFilePut, ziee_core::AppError> {
        self.inner.put_prefix(members).await
    }
    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, ziee_core::AppError> {
        let out = self.inner.get(key).await?;
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.bytes.fetch_add(out.len() as u64, Ordering::SeqCst);
        Ok(out)
    }
    async fn get_range(
        &self,
        key: &ContentKey,
        start: u64,
        len: u64,
    ) -> Result<Vec<u8>, ziee_core::AppError> {
        let out = self.inner.get_range(key, start, len).await?;
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.bytes.fetch_add(out.len() as u64, Ordering::SeqCst);
        Ok(out)
    }
    async fn get_stream(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<ByteStream, ziee_core::AppError> {
        self.inner.get_stream(key, offset, length).await
    }
    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, ziee_core::AppError> {
        self.inner.stat(key).await
    }
    async fn exists(&self, key: &ContentKey) -> Result<bool, ziee_core::AppError> {
        self.inner.exists(key).await
    }
    async fn delete(&self, key: &ContentKey) -> Result<(), ziee_core::AppError> {
        self.inner.delete(key).await
    }
    async fn link_blob(&self, key: &ContentKey, dest: &std::path::Path) -> BlobLink {
        self.inner.link_blob(key, dest).await
    }
    async fn resolve_member(
        &self,
        manifest_key: &ContentKey,
        member_path: &str,
    ) -> Result<ContentKey, ziee_core::AppError> {
        self.inner.resolve_member(manifest_key, member_path).await
    }
    async fn gc(
        &self,
        keep: &std::collections::HashSet<String>,
        min_age_secs: u64,
    ) -> Result<GcReport, ziee_core::AppError> {
        self.inner.gc(keep, min_age_secs).await
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  A SYNTHETIC SCENE AT SCALE
// ════════════════════════════════════════════════════════════════════════════

/// Zarr-v3 members for ONE 1-D array, in the container the gather is permitted to decode:
/// `sharding_indexed` with a `bytes` + `gzip` inner chain, one shard covering the whole array.
///
/// Written here rather than borrowed from a fixture because the committed fixtures are 5
/// rows; the question this file asks does not exist below one chunk.
fn zarr_array(prefix: &str, dtype: &str, item: usize, elems: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let n = elems.len() / item;
    let span = n.max(1);
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&elems).expect("gzip");
    let gz = enc.finish().expect("gzip finish");

    // One inner chunk per shard ⇒ a 20-byte trailer: a 16-byte index entry + a 4-byte
    // checksum the decoder slices off without verifying.
    let mut body = gz.clone();
    body.extend_from_slice(&0u64.to_le_bytes()); // offset
    body.extend_from_slice(&(gz.len() as u64).to_le_bytes()); // nbytes
    body.extend_from_slice(&[0u8; 4]); // crc32c placeholder

    let meta = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [n],
        "data_type": dtype,
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [span] } },
        "chunk_key_encoding": { "name": "default" },
        "fill_value": 0,
        "codecs": [{
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": [span],
                "codecs": [{ "name": "bytes" }, { "name": "gzip" }],
                "index_codecs": [{ "name": "bytes" }, { "name": "crc32c" }],
                "index_location": "end"
            }
        }],
    });
    vec![
        (
            format!("{prefix}/zarr.json"),
            serde_json::to_vec(&meta).expect("array meta"),
        ),
        (format!("{prefix}/c/0"), body),
    ]
}

fn i64s(v: impl Iterator<Item = i64>) -> Vec<u8> {
    v.flat_map(|x| x.to_le_bytes()).collect()
}
fn i32s(v: impl Iterator<Item = i32>) -> Vec<u8> {
    v.flat_map(|x| x.to_le_bytes()).collect()
}

async fn put_multifile(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    members: Vec<(String, Vec<u8>)>,
    structure: serde_json::Value,
    meta: serde_json::Value,
) -> Uuid {
    let put = store.put_prefix(&members).await.expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert multifile")
    .id
}

/// The whole scene: an alignment over two datasets of [`PER_SOURCE`] rows each, their two
/// `float32` source columns, and the gathered column over them. Returns the gathered id.
///
/// It fuses NO vocabulary (`alignment_column: null`), which is the key/identifier gather's
/// declared shape — chosen so the scene needs no level lookups and the measurement is of the
/// gather itself rather than of a remap.
async fn scale_scene(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    n_rows: usize,
) -> Uuid {
    let per = n_rows / 2;
    let digest_a = format!("{:0>64}", "a");
    let digest_b = format!("{:0>64}", "b");

    // ── the alignment ────────────────────────────────────────────────────────────────
    // Rows 0..per come from ds-a (segment 0), rows per..n from ds-b (segment 1); within a
    // segment the source row is the offset from the segment's start.
    // D18 (ITEM-11): no per-row `row_source`/`row_segment` — positions reconstruct from the
    // segment table. Rows 0..per come from ds-a (segment 0, [0,per)); rows per..n from ds-b
    // (segment 1, [per,n)).
    let mut align_members = Vec::new();
    align_members.extend(zarr_array(
        "segment_dataset",
        "int32",
        4,
        i32s([0i32, 1].into_iter()),
    ));
    align_members.extend(zarr_array(
        "segment_start",
        "int64",
        8,
        i64s([0i64, per as i64].into_iter()),
    ));
    align_members.extend(zarr_array(
        "segment_end",
        "int64",
        8,
        i64s([per as i64, n_rows as i64].into_iter()),
    ));
    align_members.extend(zarr_array(
        "segment_order",
        "int32",
        4,
        i32s([0i32, 1].into_iter()),
    ));
    align_members.extend(zarr_array(
        "entity_index",
        "int64",
        8,
        i64s((0..(2 * per)).map(|i| i as i64)),
    ));

    let aux = |path: &str, dtype: &str, role: &str, shape: serde_json::Value, extent: &str| {
        json!({ "path": path, "name": path, "kind": "numeric", "dtype": dtype,
                "shape": shape, "role": role, "extent": [extent] })
    };
    let align_structure = json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": "unified_entities",
        "n": per,
        "key": "unified_key",
        "columns": [],
        "arrays": [],
        "aux": [
            aux("segment_dataset", "int32", "alignment_segment_dataset", json!([2]), "segments"),
            aux("segment_start", "int64", "alignment_segment_start", json!([2]), "segments"),
            aux("segment_end", "int64", "alignment_segment_end", json!([2]), "segments"),
            aux("segment_order", "int32", "alignment_segment_order", json!([2]), "segments"),
            json!({ "path": "entity_index", "name": "entity_index", "kind": "numeric",
                    "dtype": "int64", "shape": [per, 2],
                    "role": "alignment_entity_index",
                    "extent": ["unified_entities", "sources"] }),
        ],
        "extents": {
            "alignment_rows": n_rows,
            "segments": 2,
            "unified_entities": per,
            "sources": 2,
        },
    });
    let align_meta = json!({
        "mode": "strict",
        "n_rows": n_rows,
        "sources": [
            { "dataset_id": "ds-a", "key_sequence_digest": digest_a, "n_rows": per },
            { "dataset_id": "ds-b", "key_sequence_digest": digest_b, "n_rows": per },
        ],
    });
    let align = put_multifile(
        repo,
        store,
        project,
        "alignment",
        align_members,
        align_structure,
        align_meta,
    )
    .await;

    // ── the two sources ──────────────────────────────────────────────────────────────
    let mut source_ids = Vec::new();
    for (label, digest, base) in [("src-a", &digest_a, 0f32), ("src-b", &digest_b, 1e6f32)] {
        let vals: Vec<u8> = (0..per)
            .flat_map(|i| (base + i as f32).to_le_bytes())
            .collect();
        let members = zarr_array("values", "float32", 4, vals);
        source_ids.push(
            put_multifile(
                repo,
                store,
                project,
                label,
                members,
                json!({
                    "encoding": "zarr_v3", "kind": "table", "axis": SCENE_SOURCE_AXIS, "n": per,
                    "key_sequence_digest": digest,
                    "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                                  "dtype": "float32", "shape": [per], "axis": SCENE_SOURCE_AXIS, "n": per }],
                    "arrays": [],
                }),
                json!({}),
            )
            .await,
        );
    }

    // ── the gathered column ──────────────────────────────────────────────────────────
    let structure = cytoanalyst::modules::workstore::virtual_dataset::gathered_structure(
        "float32",
        None,
        SCENE_SOURCE_AXIS,
        n_rows,
        // A scale fixture: it pins the STORE shape, not an axis identity, and its
        // alignment pins no unified digest. `Unpinned` is the honest value — the enum's
        // own doc says inventing one would be a FABRICATED identity, worse than none,
        // because `verify_leaf_digest`'s contract is that unknown never matches. Stated
        // explicitly rather than defaulted, matching its three sibling call sites.
        //
        // Provenance: commit `21585970` made this parameter required and updated the three
        // siblings but not this one. The fix was made during the #149/#150 merge, verified
        // locally, and then LEFT UNSTAGED — so `cargo check -p cytoanalyst --tests` failed
        // at `c6688a32` while every local run was green. Committed properly in `f6c98ce6`
        // after the #154 agent, unable to build the suite at all, reported it instead of
        // working around it.
        cytoanalyst::modules::workstore::virtual_dataset::KeyIdentity::Unpinned,
        json!({
            "alignment_artifact_id": align,
            "column_selector": "values",
            "alignment_column": null,
            "sources": [
                { "dataset_id": "ds-a", "artifact_id": source_ids[0] },
                { "dataset_id": "ds-b", "artifact_id": source_ids[1] },
            ],
        }),
    );
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "fused-values".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "f".repeat(64)),
        structure,
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: cytoanalyst::modules::workstore::virtual_dataset::gathered_logical_bytes(
            "float32", n_rows,
        ),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert gathered")
    .id
}

// ════════════════════════════════════════════════════════════════════════════
//  THE MEASUREMENTS
// ════════════════════════════════════════════════════════════════════════════

/// **Read amplification over a whole-column scan.**
///
/// Reported, not merely asserted: the number is the input to the design decision, so it is
/// printed with the arithmetic that produced it.
#[tokio::test]
async fn a_whole_column_scan_reports_its_read_amplification() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gather scale").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let counting = Arc::new(CountingStore::new(server_store(&server)));

    let g = scale_scene(&repo, counting.as_ref(), project, SCALE_ROWS).await;
    let structure = repo
        .get_any_status(g)
        .await
        .expect("read")
        .expect("row")
        .structure;

    let chunks = SCALE_ROWS.div_ceil(CHUNK_ELEMENTS);
    assert!(
        chunks > 100,
        "the scene must span many chunks or amplification is unobservable: {chunks}"
    );

    // ONE chunk, cold — the floor a single request cannot go below.
    counting.reset();
    let t0 = std::time::Instant::now();
    let resolved = cytoanalyst::modules::workstore::gather_exec::resolve(
        &pool,
        counting.as_ref(),
        g,
        &structure,
    )
    .await
    .expect("resolve");
    let one = resolved
        .member("values/c/0")
        .expect("member")
        .expect("chunk");
    let one_chunk_bytes = counting.bytes();
    let one_chunk_gets = counting.gets();
    let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(one.len(), CHUNK_ELEMENTS * 4, "a full float32 chunk");

    // The WHOLE column, the way the serve path does it today: one `resolve` per chunk.
    counting.reset();
    let t1 = std::time::Instant::now();
    for c in 0..chunks {
        let r = cytoanalyst::modules::workstore::gather_exec::resolve(
            &pool,
            counting.as_ref(),
            g,
            &structure,
        )
        .await
        .expect("resolve");
        r.member(&format!("values/c/{c}"))
            .expect("member")
            .expect("chunk");
    }
    let scan_bytes = counting.bytes();
    let scan_gets = counting.gets();
    let scan_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let amplification = scan_bytes as f64 / one_chunk_bytes as f64;
    eprintln!(
        "\n── gather read amplification ───────────────────────────────────\n\
         rows                 {SCALE_ROWS}\n\
         chunks               {chunks}\n\
         one cold chunk       {one_chunk_bytes} store bytes over {one_chunk_gets} get(s), {cold_ms:.1} ms\n\
         whole-column scan    {scan_bytes} store bytes over {scan_gets} get(s), {scan_ms:.1} ms\n\
         AMPLIFICATION        {amplification:.1}x  (ideal 1.0x — one pass serves every chunk)\n\
         per-chunk mean       {:.1} ms\n\
         ────────────────────────────────────────────────────────────────",
        scan_ms / chunks as f64
    );

    // The measurement's own control: `resolve` is the UNCACHED entry point and must still
    // exhibit the repetition, or the comparison below has no baseline.
    assert!(
        amplification > 1.5,
        "measured amplification {amplification:.1}x on the UNCACHED `resolve` — if this is ~1 \
         then `resolve` itself started caching and this baseline is measuring the fix, not the \
         thing the fix is compared against"
    );

    // ── THE SAME SCAN through `resolve_shared`, which is what the route calls ────────
    let cache = ResolutionCache::<ResolvedGather>::new(256 * 1024 * 1024);
    counting.reset();
    let t2 = std::time::Instant::now();
    for c in 0..chunks {
        let r = cytoanalyst::modules::workstore::gather_exec::resolve_shared(
            &pool,
            counting.as_ref(),
            g,
            &structure,
            &cache,
        )
        .await
        .expect("resolve_shared");
        let bytes = r
            .member(&format!("values/c/{c}"))
            .expect("member")
            .expect("chunk");
        assert_eq!(bytes.len(), CHUNK_ELEMENTS * 4, "chunk {c}");
    }
    let cached_bytes = counting.bytes();
    let cached_gets = counting.gets();
    let cached_ms = t2.elapsed().as_secs_f64() * 1000.0;
    let cached_amp = cached_bytes as f64 / one_chunk_bytes as f64;

    eprintln!(
        "── the same scan, through `resolve_shared` ─────────────────────\n\
         whole-column scan    {cached_bytes} store bytes over {cached_gets} get(s), {cached_ms:.1} ms\n\
         AMPLIFICATION        {cached_amp:.2}x\n\
         speedup              {:.0}x wall clock, {:.0}x bytes\n\
         cache after scan     {} entr(y/ies), {} bytes\n\
         ────────────────────────────────────────────────────────────────",
        scan_ms / cached_ms.max(0.001),
        scan_bytes as f64 / cached_bytes.max(1) as f64,
        cache.len(),
        cache.bytes(),
    );

    // **The gate.** One cold resolution serves the whole column; every later chunk fetches
    // nothing. Stated as a ratio rather than an absolute so it does not become a wall-clock
    // flake on a shared box, and floored well above 1.0 so a regression that reintroduces even
    // a fraction of the re-reads fails.
    assert!(
        cached_amp < 1.05,
        "a whole-column scan through the cached path read {cached_amp:.2}x one chunk's bytes — \
         the resolution is being repeated. Was the cache key made input-dependent in a way that \
         misses, or did the lookup move?"
    );
    assert_eq!(
        cache.len(),
        1,
        "one column resolved once ⇒ exactly one entry; more means the key varies across \
         requests that read identical inputs, which is a cache that never hits"
    );
}

/// **Per-chunk latency over the REAL route**, at scale.
///
/// Reported rather than gated on an absolute threshold: a wall-clock bound on a shared box is
/// a flake generator, and the number that decides the design is the SHAPE (does per-chunk
/// cost stay flat across a scan?) rather than any single millisecond figure.
#[tokio::test]
async fn a_whole_column_scan_reports_its_per_chunk_latency() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gather scale http").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let g = scale_scene(&repo, &store, project, SCALE_ROWS).await;
    let chunks = SCALE_ROWS.div_ceil(CHUNK_ELEMENTS);

    let client = reqwest::Client::new();
    let mut ms: Vec<f64> = Vec::with_capacity(chunks);
    for c in 0..chunks {
        let t = std::time::Instant::now();
        let r = client
            .get(server.api_url(&format!("/artifacts/{g}/data/values/c/{c}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("request");
        assert_eq!(r.status().as_u16(), 200, "chunk {c}");
        let body = r.bytes().await.expect("body");
        assert_eq!(body.len(), CHUNK_ELEMENTS * 4, "chunk {c} is a full chunk");
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }

    let total: f64 = ms.iter().sum();
    let mut sorted = ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("no NaN"));
    let p = |q: f64| sorted[((sorted.len() as f64 - 1.0) * q).round() as usize];
    eprintln!(
        "\n── gather per-chunk latency (real route) ───────────────────────\n\
         rows                 {SCALE_ROWS}\n\
         chunks               {chunks}\n\
         whole scan           {total:.0} ms\n\
         p50 / p90 / p99      {:.1} / {:.1} / {:.1} ms\n\
         min / max            {:.1} / {:.1} ms\n\
         ────────────────────────────────────────────────────────────────",
        p(0.50),
        p(0.90),
        p(0.99),
        sorted[0],
        sorted[sorted.len() - 1],
    );

    // The control: every chunk paid the same, which is what a per-request whole-column
    // resolution looks like. A path that resolved once would show chunk 0 dominating.
    assert!(
        p(0.50) > 0.0,
        "the scan produced no measurable time, so it measured nothing"
    );
}

/// **Resident set under CONCURRENT resolution — the second kill criterion.**
///
/// If peak RSS already scales with `column bytes × concurrency`, a cache makes memory worse
/// and the answer is a streaming executor, not a cache. That is a property of the RESOLUTION,
/// so it is measured around concurrent `resolve` calls in this process rather than around the
/// server's — the server's RSS is confounded by its pools, its own caches and the allocator's
/// retention, and would be a number that could not be attributed.
#[tokio::test]
async fn concurrent_resolution_reports_its_resident_set_growth() {
    const CONCURRENCY: usize = 8;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gather scale rss").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = Arc::new(server_store(&server));

    let g = scale_scene(&repo, store.as_ref(), project, SCALE_ROWS).await;
    let structure = repo
        .get_any_status(g)
        .await
        .expect("read")
        .expect("row")
        .structure;

    let before = self_rss_kb();
    // Held ALIVE simultaneously — a fan-out that dropped each result as it finished would
    // measure the allocator, not the concurrent footprint.
    let mut tasks = Vec::new();
    for _ in 0..CONCURRENCY {
        let (p, s, st) = (pool.clone(), Arc::clone(&store), structure.clone());
        tasks.push(tokio::spawn(async move {
            cytoanalyst::modules::workstore::gather_exec::resolve(&p, s.as_ref(), g, &st)
                .await
                .expect("resolve")
        }));
    }
    let mut live = Vec::new();
    for t in tasks {
        live.push(t.await.expect("join"));
    }
    let peak = self_rss_kb();
    assert_eq!(
        live.len(),
        CONCURRENCY,
        "every resolution is still resident"
    );

    let column_kb = (SCALE_ROWS * 4) / 1024;
    let growth = peak.saturating_sub(before);
    eprintln!(
        "\n── concurrent resolution RSS ───────────────────────────────────\n\
         column                {column_kb} KiB\n\
         concurrency           {CONCURRENCY}\n\
         RSS before / peak     {before} / {peak} KiB\n\
         growth                {growth} KiB\n\
         growth / column       {:.2}x   (per resolution: {:.2}x)\n\
         ────────────────────────────────────────────────────────────────",
        growth as f64 / column_kb as f64,
        growth as f64 / (column_kb * CONCURRENCY) as f64,
    );
    drop(live);
    assert!(
        peak > 0,
        "the resident set must be readable for this to be a measurement"
    );
}

/// This process's resident set, in KiB. `/proc` is Linux-only; elsewhere it reports 0 and the
/// assertion at the call site is what says the measurement did not happen.
fn self_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| {
            s.split_whitespace()
                .nth(1)
                .and_then(|r| r.parse::<u64>().ok())
        })
        .map(|pages| pages * 4)
        .unwrap_or(0)
}
