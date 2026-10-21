//! T2 ObjectStore contract tests against the standardized cloud-sim substrate —
//! **floci** (AWS: real S3 on :4566) + **floci-gcp** (GCP: native GCS on :4588) —
//! under the no-cloud-credentials guard (PROV-T1-5). `saas`-only — the real
//! `S3Store` body links `object_store`.
//!
//! - **TEST-1** [acceptance] [invariant: INV-1, INV-3] [pins: PROV-T2-1] — the full
//!   ObjectStore contract vs `S3Store`@floci-S3 (put/get/get_range/get_stream/put_prefix/
//!   resolve_member/stat/exists/delete/gc), sha256 keys matching a local-fs ingest (INV-5).
//! - **TEST-2** [acceptance] [invariant: INV-2, INV-3] [pins: PROV-T2-1 (native-GCS/G5)] —
//!   the SAME contract vs native-GCS `S3Store`@floci-gcp (`GoogleCloudStorageBuilder`, the
//!   genuine GCS API — NOT an S3-interop shim). The DE-INV-13 native-GCS proof — now
//!   including the WRITE path (`objectstore_write_contract_floci_gcp`): unlike the
//!   RETIRED-SUBSTRATE fake-gcs-server (which implemented no writes object_store could use),
//!   floci-gcp serves the single-blob write path (resumable/JSON media + XML single PUT), so write
//!   contract now RUNS against a local emulator.
//! - **TEST-3** [acceptance] [invariant: INV-1 (write path/G1)] [pins: PROV-T2-1 (multipart)]
//!   — a multipart-threshold-exceeding `put_prefix` uploads via `put_multipart`, reads back
//!   byte-identically via `resolve_member`+`get_stream`, and its merkle `content_hash`
//!   equals `content_hash_of_path` over the same on-disk tree (INV-5). Run on the S3 backend
//!   (floci); the GCS *multipart* leg stays substrate-gated (floci-gcp 0.7.0 does not implement
//!   the GCS XML-multipart API — see `multi_gb_put_prefix_roundtrips_gcs`).
//!
//! ── TEST-7 (#72, ambient-cloud-identity) — the NO-REGRESSION half of the ambient-identity
//! fix. `S3Store::from_conn` now seeds each cloud builder from the pod's ambient identity
//! environment before applying the app's own settings, because `AmazonS3Builder::new()` /
//! `GoogleCloudStorageBuilder::new()` are `Default::default()` and read NO environment — so
//! pod-injected IRSA / EKS-Pod-Identity / ADC variables were discarded and the AWS chain fell
//! through to the EC2 **node role**. The legs below are the control that the STATIC-credential
//! path — the one that works today, and the only one a credential-free emulator can exercise —
//! is unchanged by that: `object_store` evaluates its static key-pair arm BEFORE the federated
//! arms (`0.13.2 src/aws/builder.rs:1097` vs `:1107`), and the floci-gcp arm keeps its explicit
//! anonymous credential. **TEST-7 is these existing legs, re-run; it adds no new assertion.**
//! The ambient-identity behaviour itself is asserted in `object_store/s3.rs`'s unit tests
//! (TEST-1..TEST-6, TEST-8, TEST-9), which must NOT live here: they mutate the process
//! environment, and `cloud-sim-guard.sh` — which this file shells out to — FAILS on a present
//! `AWS_ROLE_ARN` / `AWS_WEB_IDENTITY_TOKEN_FILE`.
//!
//! Env-gated on the substrate contract (`CYTO_WORKSTORE_S3_BUCKET` + `S3_ENDPOINT`/`STORAGE_EMULATOR_HOST`,
//! written by `just cloud-sim-floci-up` / `just cloud-sim-floci-gcp-up`). With the sim down the
//! test loud-skips (it cannot observe the product) rather than passing vacuously — it is not
//! marked ignore-to-skip.
#![cfg(feature = "saas")]

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::StreamExt;
use uuid::Uuid;

use cytoanalyst::modules::workstore::config::{CloudProvider, S3ConnConfig};
use cytoanalyst::modules::workstore::object_store::s3::S3Store;
use cytoanalyst::modules::workstore::object_store::{
    content_hash_of_path, sha256_hex, ByteStream, ContentKey, ObjectStore,
};

// ── the no-cloud-credentials guard (PROV-T1-5 / CONS-T2-4) ──────────────────────────
//
// Runs FIRST. It makes INV-1/INV-3 non-vacuous: the contract provably ran with NO real
// cloud endpoint/credential present, so a green test is a real portability proof.
fn assert_no_cloud_credentials() {
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/cloud-sim-guard.sh"
    );
    let out = std::process::Command::new("bash")
        .arg(script)
        .output()
        .expect("run cloud-sim-guard.sh");
    assert!(
        out.status.success(),
        "PROV-T1-5 guard FAILED — a real cloud credential/endpoint is present; the contract \
         must run credential-free. stdout: {} stderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn env_nonempty(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

/// The canonical, pre-created bucket (PROV-T1-4 / CONS-T2-5).
fn sim_bucket() -> Option<String> {
    env_nonempty("CYTO_WORKSTORE_S3_BUCKET")
}

/// An `S3ConnConfig` for floci's S3, from the sim env contract (PROV-T1-4). `None` ⇒ sim down.
fn s3_conn(multipart_threshold: usize, part_size: usize) -> Option<S3ConnConfig> {
    Some(S3ConnConfig {
        provider: CloudProvider::S3,
        bucket: sim_bucket()?,
        region: env_nonempty("AWS_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        endpoint: Some(env_nonempty("S3_ENDPOINT")?),
        access_key_id: env_nonempty("AWS_ACCESS_KEY_ID"),
        secret_access_key: env_nonempty("AWS_SECRET_ACCESS_KEY"),
        path_style: true,
        multipart_threshold,
        part_size,
    })
}

/// An `S3ConnConfig` for native GCS against floci-gcp (anonymous). `None` ⇒ sim down.
fn gcs_conn(multipart_threshold: usize, part_size: usize) -> Option<S3ConnConfig> {
    Some(S3ConnConfig {
        provider: CloudProvider::Gcs,
        bucket: sim_bucket()?,
        region: "us-east-1".to_string(),
        endpoint: Some(env_nonempty("STORAGE_EMULATOR_HOST")?),
        access_key_id: None,
        secret_access_key: None,
        path_style: false,
        multipart_threshold,
        part_size,
    })
}

/// Real-GCS opt-in — now needed ONLY for the GCS **multipart** write leg. object_store uploads
/// GCS multipart via the GCS XML API (`?uploads=` / `?partNumber=`), which floci-gcp 0.7.0 does
/// not implement (verified: `POST …?uploads` → HTTP 405; RETIRED-SUBSTRATE fsouza fake-gcs
/// rejected XML writes entirely). So the GCS *multipart* write half stays real-GCS-only
/// (`multi_gb_put_prefix_roundtrips_gcs`, self-skips loudly on the emulator, RUNS when a real
/// GCS bucket + ADC is configured). The **single-blob** GCS write path (resumable/JSON media +
/// XML single PUT) IS served by floci-gcp, so the full write CONTRACT
/// (`objectstore_write_contract_floci_gcp`, small blobs) now runs against the emulator.
fn real_gcs_enabled() -> bool {
    std::env::var("CYTO_TEST_REAL_GCS").as_deref() == Ok("1")
}

/// Seed a blob DIRECTLY into floci-gcp via its NATIVE JSON media-upload API at the
/// content-addressed object path `blobs/<sha256hex>` the native-GCS `S3Store` reads from.
/// Returns the `ContentKey`. This lets the native-GCS READ contract exercise object_store's
/// genuine GCS GET/HEAD/range path against the emulator.
async fn seed_gcs_blob(endpoint: &str, bucket: &str, body: &[u8]) -> ContentKey {
    let hex = sha256_hex(body);
    let name = format!("blobs/{hex}");
    let url = format!(
        "{}/upload/storage/v1/b/{}/o",
        endpoint.trim_end_matches('/'),
        bucket
    );
    let resp = reqwest::Client::new()
        .post(&url)
        // reqwest URL-encodes the `/` in `name` to %2F, which floci-gcp resolves to a
        // slash-bearing object name — the same object the native-GCS S3Store reads.
        .query(&[("uploadType", "media"), ("name", name.as_str())])
        .header("Content-Type", "application/octet-stream")
        .body(body.to_vec())
        .send()
        .await
        .expect("seed floci-gcp via its native JSON media-upload API");
    assert!(
        resp.status().is_success(),
        "floci-gcp JSON media seed failed for {name}: {}",
        resp.status()
    );
    ContentKey::from_hex(&hex)
}

async fn drain(mut st: ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(chunk) = st.next().await {
        out.extend_from_slice(&chunk.expect("stream chunk"));
    }
    out
}

/// The reusable ObjectStore contract fixture (ITEM-6). Exercises the full seam against a
/// real backend; uses a per-run unique payload so a shared, accumulating bucket never makes
/// two runs collide on a content-addressed key.
async fn run_objectstore_contract(store: Arc<dyn ObjectStore>, label: &str) {
    let tag = Uuid::new_v4();
    // ~4 KiB, unique per run.
    let mut body = format!("contract::{label}::{tag}::").into_bytes();
    body.extend((0..4096).map(|i| (i % 251) as u8));
    let n = body.len() as u64;

    // put → content-addressed sha256 key, idempotent, and IDENTICAL to a local-fs ingest of
    // the same bytes (INV-5 — the key is backend-independent).
    let key = store.put(&body).await.unwrap();
    assert!(
        key.as_str().starts_with("sha256:"),
        "content key is sha256:<hex>"
    );
    assert_eq!(
        key.as_str(),
        format!("sha256:{}", sha256_hex(&body)),
        "INV-5 key"
    );
    assert_eq!(store.put(&body).await.unwrap(), key, "put is idempotent");
    assert_eq!(store.get(&key).await.unwrap(), body, "get round-trips");

    // stat + exists.
    assert_eq!(store.stat(&key).await.unwrap().len, n);
    assert!(store.exists(&key).await.unwrap());

    // get_range: exact span, suffix clamp, and past-the-end → empty (S3 byte-range shape).
    assert_eq!(store.get_range(&key, 0, 10).await.unwrap(), body[..10]);
    assert_eq!(
        store.get_range(&key, 100, 32).await.unwrap(),
        body[100..132]
    );
    assert_eq!(
        store.get_range(&key, n - 3, 1000).await.unwrap(),
        body[body.len() - 3..]
    );
    assert!(store.get_range(&key, n + 50, 4).await.unwrap().is_empty());

    // get_stream: whole blob, a mid-blob span (== get_range), and eager 404 on a miss.
    assert_eq!(
        drain(store.get_stream(&key, 0, n).await.unwrap()).await,
        body
    );
    let span = drain(store.get_stream(&key, 200, 256).await.unwrap()).await;
    assert_eq!(span, store.get_range(&key, 200, 256).await.unwrap());
    let missing = ContentKey::from_hex(&"ab".repeat(32));
    assert!(
        store.get_stream(&missing, 0, 1).await.is_err(),
        "a missing blob fails EAGERLY so the handler can still 404"
    );
    assert!(
        !store.exists(&missing).await.unwrap(),
        "absent → false, not an error"
    );

    // put_prefix + resolve_member (a small multi-file artifact).
    let members = vec![
        (
            ".zarray".to_string(),
            format!("{{\"shape\":[3],\"t\":\"{tag}\"}}").into_bytes(),
        ),
        ("c/0".to_string(), vec![1u8, 2, 3, 4, 5]),
    ];
    let put = store.put_prefix(&members).await.unwrap();
    let ck = store.resolve_member(&put.object_key, "c/0").await.unwrap();
    assert_eq!(store.get(&ck).await.unwrap(), vec![1u8, 2, 3, 4, 5]);
    assert!(
        store.resolve_member(&put.object_key, "nope").await.is_err(),
        "missing member 404s"
    );

    // gc: an orphan (not in the keep-set) is reclaimed; every kept key survives.
    let orphan = store
        .put(format!("orphan::{tag}").as_bytes())
        .await
        .unwrap();
    let mut keep = HashSet::new();
    keep.insert(key.as_str().to_string());
    keep.insert(put.object_key.as_str().to_string());
    for m in &put.members {
        keep.insert(m.blob.as_str().to_string());
    }
    let report = store.gc(&keep, 0).await.unwrap();
    assert!(report.scanned >= 1, "gc walked the bucket: {report:?}");
    assert!(store.exists(&key).await.unwrap(), "a kept blob survives gc");
    assert!(
        store.exists(&put.object_key).await.unwrap(),
        "a kept manifest survives gc"
    );
    assert!(
        !store.exists(&orphan).await.unwrap(),
        "the orphan is reclaimed by gc"
    );

    // delete is direct and idempotent on an already-absent key.
    store.delete(&key).await.unwrap();
    assert!(!store.exists(&key).await.unwrap());
    store.delete(&key).await.unwrap();
}

#[tokio::test]
async fn objectstore_contract_floci_s3() {
    assert_no_cloud_credentials();
    let Some(conn) = s3_conn(16 * 1024 * 1024, 8 * 1024 * 1024) else {
        eprintln!(
            "SKIP objectstore_contract_floci_s3: cloud-sim env not set (run `just cloud-sim-floci-up`)"
        );
        return;
    };
    let store: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn).expect("build S3 store"));
    run_objectstore_contract(store, "floci-s3").await;
}

/// The native-GCS READ contract (ITEM-6) — exercises the read seam T3's worker binds
/// (`materialize_inputs`) against a real backend. Blobs are seeded via the emulator's supported
/// JSON API; the native-GCS `S3Store` (`GoogleCloudStorageBuilder`, the genuine GCS XML API)
/// then serves them. Every assertion here is object_store's real GCS read path.
async fn run_gcs_read_contract(store: Arc<dyn ObjectStore>, endpoint: &str, bucket: &str) {
    let tag = Uuid::new_v4();
    // ~4 KiB, unique per run (a shared, accumulating bucket never collides on a content key).
    let mut body = format!("gcs-read::{tag}::").into_bytes();
    body.extend((0..4096).map(|i| (i % 251) as u8));
    let n = body.len() as u64;

    // Seed via the emulator's native JSON write; the returned key is the SAME sha256:<hex>
    // content key a local-fs / S3 ingest of these bytes produces (INV-5 — backend-independent).
    let key = seed_gcs_blob(endpoint, bucket, &body).await;
    assert_eq!(
        key.as_str(),
        format!("sha256:{}", sha256_hex(&body)),
        "INV-5 key is backend-independent"
    );

    // get round-trips; stat + exists via head.
    assert_eq!(
        store.get(&key).await.unwrap(),
        body,
        "native-GCS get round-trips"
    );
    assert_eq!(store.stat(&key).await.unwrap().len, n);
    assert!(store.exists(&key).await.unwrap());

    // get_range: exact span, suffix clamp, and past-the-end → empty (S3/GCS byte-range shape).
    assert_eq!(store.get_range(&key, 0, 10).await.unwrap(), body[..10]);
    assert_eq!(
        store.get_range(&key, 100, 32).await.unwrap(),
        body[100..132]
    );
    assert_eq!(
        store.get_range(&key, n - 3, 1000).await.unwrap(),
        body[body.len() - 3..],
        "over-long span clamps to end-of-object"
    );
    assert!(
        store.get_range(&key, n + 50, 4).await.unwrap().is_empty(),
        "offset past the end → empty"
    );

    // get_stream: whole blob, a mid-blob span (== get_range), and eager 404 on a miss.
    assert_eq!(
        drain(store.get_stream(&key, 0, n).await.unwrap()).await,
        body
    );
    let span = drain(store.get_stream(&key, 200, 256).await.unwrap()).await;
    assert_eq!(span, store.get_range(&key, 200, 256).await.unwrap());
    let missing = ContentKey::from_hex(&"ab".repeat(32));
    assert!(
        store.get_stream(&missing, 0, 1).await.is_err(),
        "a missing blob fails EAGERLY so the handler can still 404"
    );
    assert!(
        !store.exists(&missing).await.unwrap(),
        "absent → false, not an error"
    );
    // NOTE: `resolve_member` adds no NEW native-GCS transport coverage — it is a `get` of the
    // manifest blob (proven above) followed by the backend-independent pure `decode_manifest`
    // (proven on floci-S3 in TEST-1). The manifest ENCODER is a crate-internal helper, so seeding
    // a manifest here would either reimplement it (drift) or widen the crate API for a test; kept
    // out deliberately.
}

/// TEST-2 [acceptance] [invariant: INV-2, INV-3] [pins: PROV-T2-1 (native-GCS READ seam)] —
/// the native-GCS READ contract vs floci-gcp, NO cloud creds. The native-GCS `S3Store`
/// (`GoogleCloudStorageBuilder`, the genuine GCS API — NOT an S3-interop shim) serves
/// get/get_range/get_stream/stat/exists/resolve_member byte-identically over blobs the emulator
/// holds, with sha256 content keys (INV-5). This is the read seam T3's worker binds
/// (`materialize_inputs`). The native-GCS WRITE contract now RUNS against floci-gcp too — see
/// `objectstore_write_contract_floci_gcp` (only the GCS *multipart* write stays real-GCS-only).
/// (floci-gcp-substrate TEST-4: this read leg; TEST-5: guard-first, the
/// `assert_no_cloud_credentials()` on the first line below — the contract provably ran
/// credential-free, INV-2. The write leg carries the same guard-first TEST-5 assertion.)
#[tokio::test]
async fn objectstore_read_contract_floci_gcp() {
    assert_no_cloud_credentials();
    let (Some(ep), Some(bucket)) = (env_nonempty("STORAGE_EMULATOR_HOST"), sim_bucket()) else {
        eprintln!(
            "SKIP objectstore_read_contract_floci_gcp: cloud-sim env not set (run `just cloud-sim-floci-gcp-up`)"
        );
        return;
    };
    let conn = gcs_conn(16 * 1024 * 1024, 8 * 1024 * 1024).expect("gcs conn");
    let store: Arc<dyn ObjectStore> =
        Arc::new(S3Store::from_conn(&conn).expect("build native-GCS store"));
    run_gcs_read_contract(store, &ep, &bucket).await;
}

/// TEST-3 (acceptance) [invariant: INV-3, INV-4] — the native-GCS WRITE contract: the SAME full
/// contract fixture as floci-S3, but through the native-GCS `S3Store` against **floci-gcp**. This
/// is the GCS write proof the RETIRED-SUBSTRATE fake-gcs-server structurally blocked (it served no
/// writes object_store could use). floci-gcp implements the single-blob GCS write path
/// (resumable/JSON media + XML single PUT), so `put`/`put_prefix`/`gc`/`delete` all run for real.
/// Runs against the emulator when `STORAGE_EMULATOR_HOST` is set — no `CYTO_TEST_REAL_GCS` needed
/// — under the no-cloud-credentials guard (INV-2). Contract bodies are ~4 KiB (below the multipart
/// threshold), so this leg never takes the GCS XML-multipart path floci-gcp lacks; that path is
/// covered separately by `multi_gb_put_prefix_roundtrips_gcs` (real-GCS-only).
#[tokio::test]
async fn objectstore_write_contract_floci_gcp() {
    assert_no_cloud_credentials();
    let (Some(_ep), Some(_bucket)) = (env_nonempty("STORAGE_EMULATOR_HOST"), sim_bucket()) else {
        eprintln!(
            "SKIP objectstore_write_contract_floci_gcp: cloud-sim env not set (run `just cloud-sim-floci-gcp-up`)"
        );
        return;
    };
    let conn = gcs_conn(16 * 1024 * 1024, 8 * 1024 * 1024).expect("gcs conn");
    let store: Arc<dyn ObjectStore> =
        Arc::new(S3Store::from_conn(&conn).expect("build native-GCS store"));
    run_objectstore_contract(store, "floci-gcp").await;
}

/// TEST-3 — the multipart write path (G1), on BOTH backends. A member larger than the
/// multipart threshold uploads via `put_multipart`, reads back byte-identically, and the
/// merkle `content_hash` matches `content_hash_of_path` over the same on-disk tree (INV-5).
async fn multipart_roundtrip(conn: S3ConnConfig, label: &str) {
    let store = S3Store::from_conn(&conn).expect("build store");
    let tag = Uuid::new_v4();

    // One large member (12 MiB > the 8 MiB threshold ⇒ multipart, ≥2 parts of 5 MiB) plus a
    // small member. Deterministic bytes so the on-disk oracle matches.
    let big: Vec<u8> = (0..(12 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
    let small = format!("small::{tag}").into_bytes();
    let members = vec![
        ("data/0".to_string(), big.clone()),
        (".meta".to_string(), small.clone()),
    ];

    let put = store
        .put_prefix(&members)
        .await
        .expect("multipart put_prefix");

    // Read the big member back byte-identically via resolve_member + get_stream.
    let big_key = store
        .resolve_member(&put.object_key, "data/0")
        .await
        .unwrap();
    let n = store.stat(&big_key).await.unwrap().len;
    assert_eq!(n, big.len() as u64, "{label}: stat size matches");
    let got = drain(store.get_stream(&big_key, 0, n).await.unwrap()).await;
    assert_eq!(
        got, big,
        "{label}: a multipart-uploaded member round-trips byte-identically"
    );

    // The merkle content_hash equals content_hash_of_path over the SAME tree on disk (INV-5).
    let dir = std::env::temp_dir().join(format!("cyto-mp-{tag}"));
    tokio::fs::create_dir_all(dir.join("data")).await.unwrap();
    tokio::fs::write(dir.join("data/0"), &big).await.unwrap();
    tokio::fs::write(dir.join(".meta"), &small).await.unwrap();
    let disk_hash = content_hash_of_path(&dir).await.unwrap();
    assert_eq!(
        format!("sha256:{}", put.content_hash),
        disk_hash,
        "{label}: merkle content_hash is backend-independent (INV-5)"
    );
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// TEST-3 (S3 half) — the multipart write path (G1) against floci's REAL S3 server
/// (INV-3), so it is a genuine portability proof. Threshold 8 MiB, part 5 MiB ⇒ a 12 MiB
/// member takes the `put_multipart` path.
#[tokio::test]
async fn multi_gb_put_prefix_roundtrips_s3() {
    assert_no_cloud_credentials();
    let Some(conn) = s3_conn(8 * 1024 * 1024, 5 * 1024 * 1024) else {
        eprintln!("SKIP multi_gb_put_prefix_roundtrips_s3: cloud-sim env not set");
        return;
    };
    multipart_roundtrip(conn, "floci-s3").await;
}

/// TEST-3G — the native-GCS multipart write leg. **SUBSTRATE-GATED, not an acceptance proof**:
/// object_store's GCS backend uploads multipart via the GCS XML API (`?uploads=` /
/// `?partNumber=`), which floci-gcp 0.7.0 does not implement — verified: `POST …?uploads` →
/// HTTP 405 (the RETIRED-SUBSTRATE fsouza fake-gcs rejected XML writes entirely, and Google's
/// `storage-testbench` omits the `ETag` header object_store requires). object_store's OWN suite
/// documents this (`gcp/mod.rs`: "Fake GCS server does not yet implement XML Multipart uploads",
/// fsouza #852 [RETIRED-SUBSTRATE]) and runs GCS writes only against REAL GCS. The multipart-write invariant
/// (INV-1/G1) is proven on a REAL S3 server by `multi_gb_put_prefix_roundtrips_s3` via the SHARED
/// `write_blob` body; the single-blob GCS write path IS proven on the emulator by
/// `objectstore_write_contract_floci_gcp`. THIS leg self-skips loudly on the emulator (a substrate
/// gate, not an ignore-attribute dodge) and RUNS against real GCS. Retained, not dropped.
#[tokio::test]
async fn multi_gb_put_prefix_roundtrips_gcs() {
    if !real_gcs_enabled() {
        eprintln!(
            "SKIP multi_gb_put_prefix_roundtrips_gcs: native-GCS multipart is the GCS XML \
             multipart API, which floci-gcp 0.7.0 does not implement (POST ?uploads → 405; \
             object_store's own suite documents this, fsouza #852 [RETIRED-SUBSTRATE]). The multipart WRITE path (G1) \
             is proven on a REAL S3 server by multi_gb_put_prefix_roundtrips_s3 (the SAME \
             write_blob body); the single-blob GCS write path is proven on floci-gcp by \
             objectstore_write_contract_floci_gcp. Set CYTO_TEST_REAL_GCS=1 with real ADC + \
             bucket to run this leg against real GCS."
        );
        return;
    }
    let conn = gcs_conn(8 * 1024 * 1024, 5 * 1024 * 1024).expect("gcs conn (real)");
    multipart_roundtrip(conn, "real-gcs").await;
}
